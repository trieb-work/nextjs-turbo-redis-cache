import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from 'redis';
import redisPackage from 'redis/package.json';
import { createAbortableGet } from '../../../src/utils/abortableGet';

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

  it('rejects a pending GET when its signal aborts', async () => {
    const get = createAbortableGet(createOfflineClient());
    const controller = new AbortController();

    const pending = get('some-key', controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow('The command was aborted');
  });

  it('rejects at once when the signal is already aborted', async () => {
    const get = createAbortableGet(createOfflineClient());

    await expect(get('some-key', AbortSignal.abort())).rejects.toThrow(
      'The command was aborted',
    );
  });
});
