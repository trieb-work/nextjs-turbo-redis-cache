/** A Redis command did not get a reply before its signal aborted. */
export class RedisTimeoutError extends Error {
  constructor() {
    super('Redis command got no reply before its deadline');
    this.name = 'RedisTimeoutError';
  }
}

/**
 * Settles like `operation`, but rejects with RedisTimeoutError no later than
 * the moment `signal` aborts.
 *
 * No node-redis version times out a command that is already written to the
 * socket, and node-redis 5 and 6 also stop listening to the signal at that
 * point. So a server that keeps the connection open but does not reply holds
 * the command until the connection drops. node-redis 4 rejects an aborted
 * command with an error that has no stable name or code, so that case also
 * becomes RedisTimeoutError here.
 */
export async function untilDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new RedisTimeoutError());
  });
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await Promise.race([operation, aborted]);
  } catch (error) {
    if (signal.aborted) {
      throw new RedisTimeoutError();
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
