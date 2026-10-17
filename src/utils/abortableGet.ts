// A namespace import, not `import { commandOptions }`: node-redis v5 and v6
// do not export commandOptions, and a named import of it fails at load time.
import * as redis from 'redis';

/**
 * Reads one string key. Rejects with RedisGetTimeoutError no later than the
 * moment `signal` aborts, whatever the client does with the signal.
 */
export type AbortableGet = (
  key: string,
  signal: AbortSignal,
) => Promise<string | null>;

/** The GET did not get a reply before its signal aborted. */
export class RedisGetTimeoutError extends Error {
  constructor() {
    super('Redis GET aborted before a reply arrived');
    this.name = 'RedisGetTimeoutError';
  }
}

type WithAbortSignalClient = {
  withAbortSignal(signal: AbortSignal): {
    get(key: string): Promise<string | null>;
  };
};

type CommandOptionsClient = {
  get(options: unknown, key: string): Promise<string | null>;
};

type CommandOptionsFn = (options: { signal: AbortSignal }) => unknown;

function hasWithAbortSignal(client: object): client is WithAbortSignalClient {
  return (
    typeof (client as Partial<WithAbortSignalClient>).withAbortSignal ===
    'function'
  );
}

function createClientGet(client: object): AbortableGet {
  if (hasWithAbortSignal(client)) {
    return (key, signal) => client.withAbortSignal(signal).get(key);
  }

  const { commandOptions } = redis as { commandOptions?: CommandOptionsFn };
  if (typeof commandOptions !== 'function') {
    throw new Error(
      'Unsupported redis client: the client has no withAbortSignal() and the redis package exports no commandOptions(). Install redis 4.7.0, ^5 or ^6.',
    );
  }
  const commandOptionsClient = client as CommandOptionsClient;
  return (key, signal) =>
    commandOptionsClient.get(commandOptions({ signal }), key);
}

export function createAbortableGet(client: object): AbortableGet {
  const clientGet = createClientGet(client);

  // The signal still goes to the client so that node-redis can drop a
  // command it has not written yet. But node-redis 5 and 6 stop listening
  // once the command is on the socket, and node-redis 4 rejects with an
  // error that has no stable name or code. So this wrapper applies the
  // deadline itself and gives the timeout one error type for all client
  // versions.
  return async (key, signal) => {
    if (signal.aborted) {
      throw new RedisGetTimeoutError();
    }
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new RedisGetTimeoutError());
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([clientGet(key, signal), aborted]);
    } catch (error) {
      if (signal.aborted) {
        throw new RedisGetTimeoutError();
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}
