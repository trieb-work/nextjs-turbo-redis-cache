/**
 * Demonstrates the difference between quit() and disconnect() on a
 * node-redis subscriber client while Redis is down.
 *
 * Scenario:
 * 1. Start Redis.
 * 2. Connect two subscriber clients and subscribe them.
 * 3. Kill Redis and wait for the reconnect loop to start.
 * 4. Subscriber A: call quit(). It should NOT resolve quickly while Redis is down.
 * 5. Subscriber B: call disconnect(). It must close the socket immediately.
 * 6. Restart Redis and verify that the disconnected subscriber stays dead.
 *
 * This shows why disconnect() is the correct teardown method during an outage.
 */

import { createClient } from 'redis';
import {
  detectContainerRuntime,
  getFreePort,
  record,
  sh,
  sleep,
  startRedis,
} from './redis-test-helpers';

async function createSubscriber(url: string) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 2_000,
      reconnectStrategy: (retries: number) => Math.min(50 + retries * 50, 500),
    },
  });
  client.on('error', () => {});
  await client.connect();
  await client.subscribe('test-channel', () => {});
  return client;
}

async function main() {
  const runtime = detectContainerRuntime();
  const name = `redis-quit-disc-${Math.random().toString(36).slice(2, 8)}`;
  const port = await getFreePort();

  sh(runtime, ['rm', '-f', name]);
  startRedis(runtime, name, port);

  const url = `redis://127.0.0.1:${port}`;

  const quitSubscriber = await createSubscriber(url);
  const disconnectSubscriber = await createSubscriber(url);

  record(
    'subscribers-ready',
    quitSubscriber.isReady && disconnectSubscriber.isReady,
    `quitSub isReady=${quitSubscriber.isReady}, disconnectSub isReady=${disconnectSubscriber.isReady}`,
  );

  // Kill Redis and let both clients enter their reconnect loops
  sh(runtime, ['stop', '-t', '0', name], { timeoutMs: 30_000 });
  await sleep(1_500);

  // Test quit(): it should not resolve while Redis is unreachable.
  const quitResult = await Promise.race([
    quitSubscriber
      .quit()
      .then(() => 'resolved')
      .catch((e) => `error:${e.message ?? e}`),
    sleep(3_000).then(() => 'timeout'),
  ]);

  record(
    'quit-does-not-immediately-close',
    quitResult !== 'resolved',
    `quit() result during outage: ${quitResult}`,
  );

  // Test disconnect(): it must close the client immediately, even during outage.
  const disconnectStart = Date.now();
  try {
    await disconnectSubscriber.disconnect();
  } catch (e: any) {
    // If the client is already closed, that's still a successful teardown.
  }
  const disconnectDuration = Date.now() - disconnectStart;

  record(
    'disconnect-closes-immediately',
    !disconnectSubscriber.isOpen && !disconnectSubscriber.isReady,
    `disconnect() took ${disconnectDuration}ms, isOpen=${disconnectSubscriber.isOpen}, isReady=${disconnectSubscriber.isReady}`,
  );

  // Restart Redis and make sure the disconnected client does not come back.
  startRedis(runtime, name, port);
  await sleep(1_500);

  record(
    'disconnected-client-stays-dead',
    !disconnectSubscriber.isOpen && !disconnectSubscriber.isReady,
    `after restart: isOpen=${disconnectSubscriber.isOpen}, isReady=${disconnectSubscriber.isReady}`,
  );

  // Also clean up the quit subscriber so we don't leak the process.
  try {
    await quitSubscriber.disconnect();
  } catch {}
  sh(runtime, ['rm', '-f', name]);
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
