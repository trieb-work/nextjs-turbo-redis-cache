// A namespace import, not `import { commandOptions }`: node-redis v5 and v6
// do not export commandOptions, and a named import of it fails at load time.
import * as redis from 'redis';
import { RedisTimeoutError, untilDeadline } from './deadline';

/**
 * Reads one string key. Rejects with RedisTimeoutError no later than the
 * moment `signal` aborts, whatever the client does with the signal.
 */
export type AbortableGet = (
  key: string,
  signal: AbortSignal,
) => Promise<string | null>;

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

  // The signal also goes to the client, so that node-redis can drop a
  // command it has not written yet.
  return async (key, signal) => {
    if (signal.aborted) {
      throw new RedisTimeoutError();
    }
    return untilDeadline(clientGet(key, signal), signal);
  };
}
