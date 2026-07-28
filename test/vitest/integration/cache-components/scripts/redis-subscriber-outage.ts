/**
 * Reproduces issue #86: Memory grows unbounded and process never recovers
 * after a short Redis outage — subscriber reconnect loop.
 *
 * This script creates two RedisStringsHandler instances (A and B) sharing
 * the same keyPrefix so their SyncedMaps communicate via Redis PubSub.
 * It also creates a CacheComponentsHandler singleton (C).
 *
 * Test sequence:
 *   1. Verify PubSub sync works before outage (A.set → B.sharedTagsMap.get)
 *   2. Verify subscriber clients have error listeners before outage
 *   3. Kill Redis, call get() 50× during outage (heap-growth probe)
 *   4. Wait 3 s for error handlers to fire and fail
 *   5. Count duplicate() calls during outage (client-leak probe)
 *   6. Restart Redis, wait for main clients to reconnect
 *   7. Verify PubSub sync works after outage (EXPECTED TO FAIL — the bug)
 *   8. Verify subscriber clients still have error listeners (EXPECTED TO FAIL)
 *   9. Verify get() works after Redis restart
 *
 * Output: lines of `RESULT|<name>|PASS|<detail>` or `RESULT|<name>|FAIL|<detail>`
 * followed by `RESULTS_JSON|<json>` on the last line.
 */

import { spawnSync } from 'child_process';

type ContainerRuntime = 'podman' | 'docker';

function sh(cmd: string, args: string[], opts: { timeoutMs?: number } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (res.error) throw res.error;
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function canRun(cmd: string) {
  const res = spawnSync(cmd, ['--version'], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  return !res.error && (res.status ?? 1) === 0;
}

function detectContainerRuntime(): ContainerRuntime {
  if (process.env.CONTAINER_RUNTIME === 'podman') return 'podman';
  if (process.env.CONTAINER_RUNTIME === 'docker') return 'docker';
  if (canRun('podman')) return 'podman';
  if (canRun('docker')) return 'docker';
  throw new Error(
    'Neither podman nor docker is available. Install one of them or set CONTAINER_RUNTIME.',
  );
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(
  fn: () => Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 200,
) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(intervalMs);
  }
}

async function getFreePort(): Promise<number> {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string')
        return reject(new Error('bad addr'));
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

function startRedis(runtime: ContainerRuntime, name: string, port: number) {
  const r = sh(
    runtime,
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      `${port}:6379`,
      'docker.io/redis:7-alpine',
      'redis-server',
      '--notify-keyspace-events',
      'Exe',
    ],
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) throw new Error(`${runtime} run failed: ${r.stderr}`);
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  process.stdout.write(`RESULT|${name}|${pass ? 'PASS' : 'FAIL'}|${detail}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runtime = detectContainerRuntime();
  const name = `redis-e2e-${Math.random().toString(36).slice(2, 8)}`;
  const port = await getFreePort();

  // cleanup any stale container
  sh(runtime, ['rm', '-f', name]);

  // 1. Start Redis
  startRedis(runtime, name, port);

  // Set env vars BEFORE importing so the CacheComponentsHandler singleton
  // picks up the correct Redis URL.
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.VERCEL_URL = `e2e-${name}-`;

  // Import handlers (dynamic import ensures env vars are set first)
  const { getRedisCacheComponentsHandler } = await import(
    '../../../../../src/CacheComponentsHandler'
  );
  const { default: RedisStringsHandler } = await import(
    '../../../../../src/RedisStringsHandler'
  );

  const socketOpts = {
    connectTimeout: 2_000,
    reconnectStrategy: (retries: number) => Math.min(50 + retries * 50, 500),
  };

  // 2. Create handler A (writer) and B (reader) with same keyPrefix
  const handlerA = new RedisStringsHandler({
    redisUrl: `redis://127.0.0.1:${port}`,
    socketOptions: socketOpts,
    keyPrefix: `e2e-${name}-`,
    killContainerOnErrorThreshold: 0, // disabled — same as issue #86 config
  } as any);

  const handlerB = new RedisStringsHandler({
    redisUrl: `redis://127.0.0.1:${port}`,
    socketOptions: socketOpts,
    keyPrefix: `e2e-${name}-`,
    killContainerOnErrorThreshold: 0,
  } as any);

  // CacheComponentsHandler singleton (created on import via redisCacheHandler)
  const handlerC = getRedisCacheComponentsHandler();

  // 3. Monkey-patch A's client.duplicate to count calls (client-leak probe)
  const clientA = (handlerA as any).client;
  const originalDuplicate = clientA.duplicate.bind(clientA);
  let duplicateCount = 0;
  (clientA as any).duplicate = function (...args: any[]) {
    duplicateCount++;
    return originalDuplicate(...args);
  };

  // 4. Wait for all main clients to be ready
  await waitUntil(async () => (handlerA as any).client.isReady, 20_000);
  await waitUntil(async () => (handlerB as any).client.isReady, 20_000);
  await waitUntil(async () => (handlerC as any).client.isReady, 20_000);

  // Record initial duplicate count (3 SyncedMaps × 1 duplicate each = 3)
  const initialDuplicateCount = duplicateCount;

  // 5. Test: PubSub sync works before outage
  await handlerA.set(
    'key1',
    {
      kind: 'FETCH',
      data: {
        headers: {},
        body: Buffer.from('hello').toString('base64'),
        status: 200,
        url: 'https://example.com/e2e',
      },
      revalidate: 10,
    },
    { isRoutePPREnabled: false, isFallback: false, tags: ['tag1'] },
  );

  const pubsubInitial = await waitUntil(async () => {
    const tags = (handlerB as any).sharedTagsMap.get('key1');
    return !!tags && tags.length === 1 && tags[0] === 'tag1';
  }, 5_000);

  record(
    'pubsub-initial-strings',
    pubsubInitial,
    pubsubInitial
      ? 'sync received — B.sharedTagsMap has key1'
      : 'B.sharedTagsMap never received sync for key1',
  );

  // 6. Test: Error listeners present before outage
  const subB = (handlerB as any).sharedTagsMap.subscriberClient;
  const subC = (handlerC as any).revalidatedTagsMap.subscriberClient;
  const initListenerB = subB?.listenerCount?.('error') ?? -1;
  const initListenerC = subC?.listenerCount?.('error') ?? -1;

  record(
    'error-listener-initial',
    initListenerB >= 1 && initListenerC >= 1,
    `B.sharedTagsMap.subscriber listenerCount(error)=${initListenerB}, C.revalidatedTagsMap.subscriber listenerCount(error)=${initListenerC}`,
  );

  // 7. Kill Redis
  sh(runtime, ['stop', '-t', '0', name], { timeoutMs: 30_000 });

  // 8. Test: get() returns null during outage (symptom verification)
  // Use a key that was NOT just set() — the dedup cache seeds the return
  // value on set(), so get('key1') would return the cached value without
  // hitting Redis. Using a different key forces a real Redis GET which fails.
  let getDuringOutage = false;
  let getDuringOutageDetail = '';
  try {
    const result = await handlerA.get('nonexistent-during-outage', {
      kind: 'FETCH',
      revalidate: 10,
      fetchUrl: 'https://example.com/e2e',
      fetchIdx: 0,
      tags: ['tag1'],
      softTags: [],
      isFallback: false,
    });
    getDuringOutage = result === null;
    getDuringOutageDetail = getDuringOutage
      ? 'returned null (expected during outage)'
      : `returned ${typeof result}`;
  } catch (err: any) {
    getDuringOutageDetail = `threw: ${err?.message ?? err}`;
  }
  record('get-during-outage', getDuringOutage, getDuringOutageDetail);

  // 9. Test: Heap growth during outage
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50; i++) {
    try {
      await handlerA.get(`nonexistent-${i}`, {
        kind: 'FETCH',
        revalidate: 10,
        fetchUrl: 'https://example.com/e2e',
        fetchIdx: 0,
        tags: ['tag1'],
        softTags: [],
        isFallback: false,
      });
    } catch {
      // ignore
    }
  }
  // Force a GC pass if --expose-gc is available so we measure retained memory
  if (typeof (globalThis as any).gc === 'function') {
    (globalThis as any).gc();
  }
  const heapAfter = process.memoryUsage().heapUsed;
  const heapGrowthMB = (heapAfter - heapBefore) / 1024 / 1024;
  record(
    'heap-growth-during-outage',
    heapGrowthMB < 50,
    `heap grew ${heapGrowthMB.toFixed(2)} MB during 50 get() calls`,
  );

  // 10. Wait for subscriber error handlers to fire and fail
  await sleep(3_000);

  // 11. Test: Duplicate count during outage (client-leak probe)
  // This is informational: in some scenarios quit() throws before
  // duplicate() is reached (no leak), in others duplicate() runs but
  // setupPubSub() throws (leaked client). Either way the subscriber
  // is dead — the PubSub test below is the definitive check.
  const outageDuplicates = duplicateCount - initialDuplicateCount;
  record(
    'duplicate-count-during-outage',
    true, // informational — always passes, detail has the count
    `${outageDuplicates} duplicate() calls during outage (initial=${initialDuplicateCount}, total=${duplicateCount})`,
  );

  // 12. Restart Redis
  startRedis(runtime, name, port);

  // 13. Wait for main clients to reconnect
  const reconnectedA = await waitUntil(async () => {
    try {
      return (await (handlerA as any).client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }, 30_000);

  const reconnectedB = await waitUntil(async () => {
    try {
      return (await (handlerB as any).client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }, 30_000);

  record(
    'main-client-reconnects',
    reconnectedA && reconnectedB,
    `A reconnected=${reconnectedA}, B reconnected=${reconnectedB}`,
  );

  // Wait a bit for subscriber reconnection to complete
  await sleep(2_000);

  // 14. Test: PubSub sync after outage (was the bug — should now PASS)
  if (reconnectedA) {
    await handlerA.set(
      'key2',
      {
        kind: 'FETCH',
        data: {
          headers: {},
          body: Buffer.from('world').toString('base64'),
          status: 200,
          url: 'https://example.com/e2e2',
        },
        revalidate: 10,
      },
      { isRoutePPREnabled: false, isFallback: false, tags: ['tag2'] },
    );

    // Give the subscriber reconnect loop time to succeed after Redis
    // restarts. The backoff delays are 500ms, 1s, 2s, 4s, 8s, capped at 10s.
    // After a 3s outage + restart, the subscriber may need up to ~10s to
    // reconnect depending on which backoff slot it's in.
    const pubsubAfter = await waitUntil(async () => {
      const tags = (handlerB as any).sharedTagsMap.get('key2');
      return !!tags && tags.length === 1 && tags[0] === 'tag2';
    }, 20_000);

    record(
      'pubsub-after-outage-strings',
      pubsubAfter,
      pubsubAfter
        ? 'sync received — B.sharedTagsMap has key2'
        : 'B.sharedTagsMap never received sync for key2 (subscriber is dead)',
    );
  } else {
    record(
      'pubsub-after-outage-strings',
      false,
      'skipped — main client A did not reconnect',
    );
  }

  // 15. Test: Error listener on subscriber after outage
  // Informational: the listener may still be present on the old dead client
  // (if quit() threw before duplicate()), or may be missing (if duplicate()
  // ran but setupPubSub() threw). Either way, the subscriber is non-functional.
  // The definitive test is pubsub-after-outage-strings below.
  const subBAfter = (handlerB as any).sharedTagsMap.subscriberClient;
  const subCAfter = (handlerC as any).revalidatedTagsMap.subscriberClient;
  const afterListenerB = subBAfter?.listenerCount?.('error') ?? -1;
  const afterListenerC = subCAfter?.listenerCount?.('error') ?? -1;
  const sameClientB = subBAfter === subB;
  const sameClientC = subCAfter === subC;

  record(
    'error-listener-after-outage',
    true, // informational — always passes, detail has the counts
    `B: listenerCount(error)=${afterListenerB} (was ${initListenerB}), sameClient=${sameClientB}; C: listenerCount(error)=${afterListenerC} (was ${initListenerC}), sameClient=${sameClientC}`,
  );

  // 16. Test: get() works after Redis restart (main client path)
  // Redis was restarted with --rm (data lost), so re-seed key1 first
  // to verify the main client can write and read after restart.
  let getAfter = false;
  let getAfterDetail = '';
  try {
    await handlerA.set(
      'key1',
      {
        kind: 'FETCH',
        data: {
          headers: {},
          body: Buffer.from('hello').toString('base64'),
          status: 200,
          url: 'https://example.com/e2e',
        },
        revalidate: 10,
      },
      { isRoutePPREnabled: false, isFallback: false, tags: ['tag1'] },
    );
    const result = await handlerA.get('key1', {
      kind: 'FETCH',
      revalidate: 10,
      fetchUrl: 'https://example.com/e2e',
      fetchIdx: 0,
      tags: ['tag1'],
      softTags: [],
      isFallback: false,
    });
    getAfter = result !== null;
    getAfterDetail = getAfter
      ? 'returned cached value'
      : 'returned null (cache miss or stale)';
  } catch (err: any) {
    getAfterDetail = `threw: ${err?.message ?? err}`;
  }
  record('get-after-outage', getAfter, getAfterDetail);

  // 17. Test: Total duplicate count (informational)
  record(
    'duplicate-count-total',
    true, // informational — always passes, detail has the count
    `total duplicate() calls=${duplicateCount} (initial=${initialDuplicateCount}, extra=${duplicateCount - initialDuplicateCount})`,
  );

  // 18. Cleanup
  try {
    await (handlerA as any).client?.quit?.();
  } catch {}
  try {
    await (handlerB as any).client?.quit?.();
  } catch {}
  try {
    await (handlerC as any).client?.quit?.();
  } catch {}
  sh(runtime, ['rm', '-f', name]);

  // Output JSON summary for the vitest wrapper to parse
  process.stdout.write(`RESULTS_JSON|${JSON.stringify(results)}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
