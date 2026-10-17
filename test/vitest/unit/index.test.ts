import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { CreateRedisStringsHandlerOptions } from '../../../src/index';
import RedisStringsHandler from '../../../src/RedisStringsHandler';

vi.mock('redis', () => {
  const createClient = vi.fn(() => {
    return {
      isReady: true,
      on: vi.fn(),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      quit: vi.fn(),
      duplicate: vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        subscribe: vi.fn(async () => undefined),
        on: vi.fn(),
        quit: vi.fn(async () => undefined),
        configGet: vi.fn(async () => ({ 'notify-keyspace-events': 'Exe' })),
      })),
      // Behaves like node-redis 4: a GET waits until its signal aborts and
      // then rejects with a plain Error. The real AbortError in
      // @redis/client 1.x has name 'Error' and no code.
      get: vi.fn(
        (options: { signal: AbortSignal }) =>
          new Promise<string | null>((_, reject) => {
            const abort = () => reject(new Error('The command was aborted'));
            if (options.signal.aborted) {
              abort();
              return;
            }
            options.signal.addEventListener('abort', abort, { once: true });
          }),
      ),
      sendCommand: vi.fn(async (args: string[]) => {
        const [command] = args;
        if (command === 'HSCAN' || command === 'SCAN') {
          return ['0', []];
        }
        throw new Error(`Unexpected sendCommand: ${command}`);
      }),
      hSet: vi.fn(async () => 1),
      hDel: vi.fn(async () => 1),
      publish: vi.fn(async () => 1),
      unlink: vi.fn(async () => 1),
      set: vi.fn(async () => 'OK'),
    };
  });
  return {
    createClient,
    commandOptions: vi.fn((opts) => opts),
  };
});

vi.mock('../../src/SyncedMap', () => {
  class SyncedMap {
    waitUntilReady = vi.fn(async () => undefined);
    get = vi.fn(() => undefined);
    set = vi.fn(async () => undefined);
    delete = vi.fn(async () => undefined);
    entries = vi.fn(function* () {
      return;
    });

    constructor() {}
  }

  return { SyncedMap };
});

describe('RedisStringsHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // getTimeoutMs for the timeout tests. Small enough to keep the tests fast,
  // large enough that the elapsed-time check can tell a timeout from an
  // immediate rejection.
  const getTimeoutMs = 50;

  async function getMissingKey(handler: RedisStringsHandler) {
    const started = performance.now();
    const res = await handler.get('missing-key', {
      kind: 'APP_PAGE',
      isRoutePPREnabled: false,
      isFallback: false,
    });
    return { res, elapsedMs: performance.now() - started };
  }

  // @redis/client 5.x and 6.x remove the abort listener once the command
  // is written to the socket, so a GET that waits for a stalled server
  // ignores its signal. The stub never settles to model that.
  async function useStalledRedis6Client() {
    const stalledGet = vi.fn(() => new Promise<string | null>(() => undefined));
    const { createClient } = await import('redis');
    const createBaseClient = vi.mocked(createClient).getMockImplementation()!;
    vi.mocked(createClient).mockImplementationOnce(
      () =>
        ({
          ...createBaseClient(),
          withAbortSignal: () => ({ get: stalledGet }),
        }) as never,
    );
    return stalledGet;
  }

  it('treats a GET the client aborts on timeout (redis 4 shape) as a cache miss without console.error', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'test:',
      database: 0,
      getTimeoutMs,
      redisGetDeduplication: false,
    });

    const { res, elapsedMs } = await getMissingKey(handler);

    expect(res).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeGreaterThanOrEqual(getTimeoutMs - 5);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('treats a GET the client never settles after timeout (redis 5 and 6 shape) as a cache miss without console.error', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await useStalledRedis6Client();

    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'test:',
      database: 0,
      getTimeoutMs,
      redisGetDeduplication: false,
    });

    const { res, elapsedMs } = await getMissingKey(handler);

    expect(res).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeGreaterThanOrEqual(getTimeoutMs - 5);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('treats a shared deduplicated GET as a cache miss for a caller whose own signal is still live', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const stalledGet = await useStalledRedis6Client();

    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'test:',
      database: 0,
      getTimeoutMs,
      redisGetDeduplication: true,
      inMemoryCachingTime: 1000,
    });

    const first = getMissingKey(handler);
    // The second caller joins the first caller's pending GET. The first
    // signal aborts while the second caller's signal has 20ms left.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = getMissingKey(handler);

    const results = await Promise.all([first, second]);

    expect(results.map(({ res }) => res)).toEqual([null, null]);
    expect(results[1].elapsedMs).toBeLessThan(getTimeoutMs - 5);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(stalledGet).toHaveBeenCalledTimes(1);
  });

  it('does not leave the readiness timeout timer pending after an operation', async () => {
    vi.useFakeTimers();
    try {
      const handler = new RedisStringsHandler({
        redisUrl: 'redis://localhost:6379',
        keyPrefix: 'test:',
        database: 0,
        getTimeoutMs: 1,
        redisGetDeduplication: false,
      });

      const timersBefore = vi.getTimerCount();
      await handler.get('missing-key', {
        kind: 'APP_PAGE',
        isRoutePPREnabled: false,
        isFallback: false,
      });

      // assertClientIsReady() races waitUntilReady() against a 30s timeout;
      // the timer must not stay pending once the race is settled, because
      // pending timers retain the ambient async context (and with it, in a
      // Next.js server, the whole per-request object graph).
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips Redis work in revalidateTag during next build', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    const { default: Handler } = await import(
      '../../../src/RedisStringsHandler'
    );
    const handler = new Handler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'build:',
      database: 0,
      redisGetDeduplication: false,
    });
    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;

    await expect(handler.revalidateTag('posts')).resolves.toBeUndefined();
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe('Public exports', () => {
  it('exports CreateRedisStringsHandlerOptions type', () => {
    const _typeCheck: CreateRedisStringsHandlerOptions = {
      keyPrefix: 'test',
    };

    expect(_typeCheck.keyPrefix).toBe('test');
  });
});

describe('redisCacheHandler lazy proxy', () => {
  it('does not construct a Redis connection on import', async () => {
    vi.resetModules();
    const { createClient } = await import('redis');
    vi.mocked(createClient).mockClear();

    // Importing the module should NOT trigger a Redis connection
    await import('../../../src');

    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });

  it('has trap returns true for known methods without constructing the handler', async () => {
    vi.resetModules();
    const { createClient } = await import('redis');
    vi.mocked(createClient).mockClear();

    const { redisCacheHandler } = await import('../../../src');

    expect('getExpiration' in redisCacheHandler).toBe(true);
    expect('get' in redisCacheHandler).toBe(true);
    expect('set' in redisCacheHandler).toBe(true);
    expect('refreshTags' in redisCacheHandler).toBe(true);
    expect('updateTags' in redisCacheHandler).toBe(true);

    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });

  it('method call delegates to the singleton and binds correctly', async () => {
    vi.resetModules();
    const { createClient } = await import('redis');
    vi.mocked(createClient).mockClear();

    const { redisCacheHandler } = await import('../../../src');

    // Accessing a method triggers construction and delegates to the real handler
    const getFn = redisCacheHandler.get;
    expect(typeof getFn).toBe('function');
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(1);

    // Subsequent accesses reuse the same singleton (no extra construction)
    const getFn2 = redisCacheHandler.get;
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(1);
    expect(typeof getFn2).toBe('function');
  });
});
