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
      get: vi.fn(async () => {
        const err = new Error('timeout') as Error & { name: string };
        err.name = 'AbortError';
        throw err;
      }),
      hScan: vi.fn(async () => ({ cursor: 0, tuples: [] })),
      scan: vi.fn(async () => ({ cursor: 0, keys: [] })),
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

  it('treats aborted GET (timeout) as cache miss without console.error', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'test:',
      database: 0,
      getTimeoutMs: 1,
      redisGetDeduplication: false,
    });

    const res = await handler.get('missing-key', {
      kind: 'APP_PAGE',
      isRoutePPREnabled: false,
      isFallback: false,
    });

    expect(res).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
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

  it('does not send different hash slots in one UNLINK during tag invalidation', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'cluster-safe:',
      database: 0,
      redisGetDeduplication: false,
    });

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        yield ['item:a', ['tag-1']];
        yield ['item:b', ['tag-1']];
      },
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };

    await handler.revalidateTag('tag-1');

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink.mock.calls).toEqual([
      ['cluster-safe:item:a'],
      ['cluster-safe:item:b'],
    ]);
    expect((handler as any).sharedTagsMap.delete).not.toHaveBeenCalled();
  });

  it('clears local read cache before unlinking tagged Redis keys', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'cluster-safe:',
      database: 0,
      redisGetDeduplication: true,
      inMemoryCachingTime: 1_000,
    });

    const events: string[] = [];
    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    unlink.mockImplementation(async () => {
      events.push('unlink');
      return 1;
    });
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        yield ['item:a', ['tag-1']];
      },
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };
    (handler as any).inMemoryDeduplicationCache = {
      delete: vi.fn(() => {
        events.push('dedup-delete');
      }),
    };

    await handler.revalidateTag('tag-1');

    expect(events).toEqual(['dedup-delete', 'unlink', 'dedup-delete']);
  });

  it('removes stale tag metadata when setting an untagged replacement', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'untagged:',
      database: 0,
      redisGetDeduplication: false,
    });
    const deleteTags = vi.fn(async () => undefined);
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      get: vi.fn(() => ['old-tag']),
      delete: deleteTags,
    };

    await handler.set(
      'item:a',
      {
        kind: 'FETCH',
        data: {
          headers: {},
          body: '',
          status: 200,
          url: 'https://example.test/cache',
        },
        revalidate: 60,
      },
      {
        isRoutePPREnabled: false,
        isFallback: false,
        tags: [],
        cacheControl: { revalidate: 60, expire: 120 },
      },
    );

    expect(deleteTags).toHaveBeenCalledWith('item:a');
  });

  it('keeps stale tag metadata when an untagged replacement write fails', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'untagged:',
      database: 0,
      redisGetDeduplication: false,
    });
    const set = (handler as any).client.set as ReturnType<typeof vi.fn>;
    set.mockRejectedValueOnce(new Error('write failed'));
    const deleteTags = vi.fn(async () => undefined);
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      get: vi.fn(() => ['old-tag']),
      delete: deleteTags,
    };

    await expect(
      handler.set(
        'item:a',
        {
          kind: 'FETCH',
          data: {
            headers: {},
            body: '',
            status: 200,
            url: 'https://example.test/cache',
          },
          revalidate: 60,
        },
        {
          isRoutePPREnabled: false,
          isFallback: false,
          tags: [],
          cacheControl: { revalidate: 60, expire: 120 },
        },
      ),
    ).rejects.toThrow('write failed');

    expect(deleteTags).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('keeps tag metadata for keys whose Redis delete failed', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'partial:',
      database: 0,
      redisGetDeduplication: false,
    });

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    unlink.mockImplementation(async (key: string | string[]) => {
      if (key === 'partial:item:b') {
        throw new Error('delete failed');
      }
      return 1;
    });
    const deleteFromSharedTags = vi.fn(async () => undefined);
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        yield ['item:a', ['tag-1']];
        yield ['item:b', ['tag-1']];
      },
      delete: deleteFromSharedTags,
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };

    await expect(handler.revalidateTag('tag-1')).rejects.toMatchObject({
      name: 'ClusterSafeUnlinkError',
    });

    expect(deleteFromSharedTags).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
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
