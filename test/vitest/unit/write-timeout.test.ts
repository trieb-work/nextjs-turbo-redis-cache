import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import redisPackage from 'redis/package.json';
import RedisStringsHandler from '../../../src/RedisStringsHandler';
import { getRedisCacheComponentsHandler } from '../../../src/CacheComponentsHandler';
import type { CacheComponentsEntry } from '../../../src/CacheComponentsHandler';
import { startPausableRedisServer } from './utils/pausableRedisServer';

// Uses the installed redis package without a mock. CI runs this file with
// redis 4.7.0 and with redis 6.x. A paused server keeps the socket open and
// sends no replies, so a command that is already written never settles on
// any client version.

const timeoutMs = 50;

async function settleWithin(operation: Promise<unknown>, limitMs = 2_000) {
  const started = performance.now();
  const outcome = await Promise.race([
    operation.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) =>
      setTimeout(() => resolve('pending'), limitMs),
    ),
  ]);
  return { outcome, elapsedMs: performance.now() - started };
}

const pagesValue = {
  kind: 'PAGES' as const,
  html: '<p>page</p>',
  pageData: {},
  headers: {},
  status: 200,
};
const pagesCtx = { isRoutePPREnabled: false, isFallback: false };

function componentsEntry(tags: string[]): Promise<CacheComponentsEntry> {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('value'));
        controller.close();
      },
    }),
    tags,
    stale: 300,
    timestamp: Date.now(),
    expire: 3_600,
    revalidate: 300,
  });
}

describe(`Redis writes with redis ${redisPackage.version} when Redis stops answering`, () => {
  let server: Awaited<ReturnType<typeof startPausableRedisServer>>;
  let strings: RedisStringsHandler;
  let components: ReturnType<typeof getRedisCacheComponentsHandler>;

  beforeAll(async () => {
    vi.stubEnv('SKIP_KEYSPACE_CONFIG_CHECK', 'TRUE');
    server = await startPausableRedisServer();
    const options = {
      redisUrl: server.url,
      database: 0,
      getTimeoutMs: timeoutMs,
      writeTimeoutMs: timeoutMs,
      redisGetDeduplication: false,
    };
    strings = new RedisStringsHandler({ ...options, keyPrefix: 'strings:' });
    components = getRedisCacheComponentsHandler({
      ...options,
      keyPrefix: 'components:',
    });
    await strings.set('/warm-up', pagesValue, { ...pagesCtx });
    await components.set('warm-up', componentsEntry([]));
  });

  afterEach(() => {
    server.resume();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  function spyOnConsole() {
    return {
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    };
  }

  it('RedisStringsHandler.set() returns after writeTimeoutMs and logs a warning', async () => {
    const consoleSpy = spyOnConsole();
    server.pause();

    const { outcome, elapsedMs } = await settleWithin(
      strings.set('/page-a', pagesValue, { ...pagesCtx }),
    );

    expect(outcome).toBe('resolved');
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });

  it('RedisStringsHandler.revalidateTag() rejects after writeTimeoutMs, so the caller sees the failed invalidation', async () => {
    await strings.set('/page-b', pagesValue, { ...pagesCtx });
    const consoleSpy = spyOnConsole();
    server.pause();

    const { outcome, elapsedMs } = await settleWithin(
      strings.revalidateTag('_N_T_/page-b'),
    );

    expect(outcome).toBe('rejected');
    expect(elapsedMs).toBeLessThan(1_000);
    expect(consoleSpy.error).toHaveBeenCalledOnce();
  });

  it('Cache Components set() returns after writeTimeoutMs and logs a warning', async () => {
    const consoleSpy = spyOnConsole();
    server.pause();

    const { outcome, elapsedMs } = await settleWithin(
      components.set('entry-a', componentsEntry(['tag-a'])),
    );

    expect(outcome).toBe('resolved');
    expect(elapsedMs).toBeLessThan(1_000);
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });

  it('Cache Components updateTags() returns after writeTimeoutMs and logs a warning', async () => {
    const consoleSpy = spyOnConsole();
    server.pause();

    const { outcome, elapsedMs } = await settleWithin(
      components.updateTags(['tag-b']),
    );

    expect(outcome).toBe('resolved');
    expect(elapsedMs).toBeLessThan(1_000);
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });

  it('Cache Components get() of a stale entry is a miss after getTimeoutMs when the unlink script hangs', async () => {
    await components.set('entry-c', componentsEntry(['tag-c']));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await components.updateTags(['tag-c']);
    const consoleSpy = spyOnConsole();
    server.pause(['EVAL']);

    const pendingGet = components.get('entry-c', []);
    const { outcome, elapsedMs } = await settleWithin(pendingGet);

    expect(outcome).toBe('resolved');
    expect(await pendingGet).toBeUndefined();
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });

  it('Cache Components get() still removes the tag record when the unlink script answers after getTimeoutMs', async () => {
    await components.set('entry-e', componentsEntry(['tag-e']));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await components.updateTags(['tag-e']);
    spyOnConsole();
    server.pause(['EVAL']);

    expect(await components.get('entry-e', [])).toBeUndefined();
    server.resume();

    await vi.waitFor(() =>
      expect(server.received).toContainEqual([
        'HDEL',
        'components:__cacheComponents_sharedTags__',
        'entry-e',
      ]),
    );
  });

  it('Cache Components get() of a stale entry is a miss after getTimeoutMs when Redis stalls after the unlink script', async () => {
    await components.set('entry-d', componentsEntry(['tag-d']));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await components.updateTags(['tag-d']);
    const consoleSpy = spyOnConsole();
    server.pause(['HDEL']);

    const pendingGet = components.get('entry-d', []);
    const { outcome, elapsedMs } = await settleWithin(pendingGet);

    expect(outcome).toBe('resolved');
    expect(await pendingGet).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1_000);
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });
});
