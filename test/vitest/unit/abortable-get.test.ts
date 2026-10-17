import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from 'redis';
import redisPackage from 'redis/package.json';
import {
  createAbortableGet,
  RedisGetTimeoutError,
} from '../../../src/utils/abortableGet';

// Uses the installed redis package without a mock. CI runs this file with
// redis 4.7.0 and with redis 6.x, so each client major gets its own run.
// Nothing listens on port 1, so the client stays open but not ready, and
// a GET stays in the offline queue until its signal aborts it.
describe(`createAbortableGet with redis ${redisPackage.version}`, () => {
  let client: ReturnType<typeof createClient> | undefined;

  afterEach(async () => {
    await client?.disconnect().catch(() => undefined);
    client = undefined;
  });

  function createOfflineClient() {
    client = createClient({
      socket: { host: '127.0.0.1', port: 1, reconnectStrategy: () => 50 },
    });
    client.on('error', () => undefined);
    client.connect().catch(() => undefined);
    return client;
  }

  it('rejects a pending GET with the timeout error when its signal aborts', async () => {
    const get = createAbortableGet(createOfflineClient());
    const controller = new AbortController();

    const pending = get('some-key', controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(RedisGetTimeoutError);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const get = createAbortableGet(createOfflineClient());

    await expect(get('some-key', AbortSignal.abort())).rejects.toBeInstanceOf(
      RedisGetTimeoutError,
    );
  });
});

describe('createAbortableGet with a client that ignores the signal', () => {
  // @redis/client 2.x and 3.x remove the abort listener once a command is
  // written to the socket. A GET that waits for a stalled server then never
  // settles on its own, so the signal must bound it from outside.
  const neverSettles = {
    withAbortSignal: () => ({
      get: () => new Promise<string | null>(() => undefined),
    }),
  };

  it('rejects with the timeout error at the signal deadline', async () => {
    const get = createAbortableGet(neverSettles);
    const timeoutMs = 50;
    const started = performance.now();

    await expect(
      get('some-key', AbortSignal.timeout(timeoutMs)),
    ).rejects.toBeInstanceOf(RedisGetTimeoutError);

    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('passes a client error through unchanged while the signal is live', async () => {
    const clientError = new Error('ECONNREFUSED');
    const get = createAbortableGet({
      withAbortSignal: () => ({
        get: () => Promise.reject<string | null>(clientError),
      }),
    });

    await expect(get('some-key', new AbortController().signal)).rejects.toBe(
      clientError,
    );
  });
});
