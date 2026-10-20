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

  it('clears the local read cache with one batched delete per slot group', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'cluster-safe:',
      database: 0,
      redisGetDeduplication: true,
      inMemoryCachingTime: 1_000,
    });

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    unlink.mockResolvedValue(2);
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        yield ['{tenant}:a', ['tag-1']];
        yield ['{tenant}:b', ['tag-1']];
      },
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };
    const deleteLocal = vi.fn(async () => undefined);
    (handler as any).inMemoryDeduplicationCache = { delete: deleteLocal };

    await handler.revalidateTag('tag-1');

    expect(deleteLocal).toHaveBeenCalledTimes(2);
    expect(deleteLocal).toHaveBeenNthCalledWith(1, [
      '{tenant}:a',
      '{tenant}:b',
    ]);
    expect(deleteLocal).toHaveBeenNthCalledWith(2, [
      '{tenant}:a',
      '{tenant}:b',
    ]);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('splits a high-cardinality local cache clear into bounded batches', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'cluster-safe:',
      database: 0,
      redisGetDeduplication: true,
      inMemoryCachingTime: 1_000,
    });

    const keys = Array.from({ length: 501 }, (_, index) => `item:${index}`);
    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    let unlinked = false;
    unlink.mockImplementation(async () => {
      unlinked = true;
      return 1;
    });
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        for (const key of keys) {
          yield [key, ['tag-1']];
        }
      },
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };
    const batchesBeforeUnlink: number[] = [];
    (handler as any).inMemoryDeduplicationCache = {
      delete: vi.fn(async (batch: string[]) => {
        if (!unlinked) {
          batchesBeforeUnlink.push(batch.length);
        }
      }),
    };

    await handler.revalidateTag('tag-1');

    expect(batchesBeforeUnlink).toEqual([500, 1]);
  });

  it('clears remaining local cache batches after the first batch fails', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'cluster-safe:',
      database: 0,
      redisGetDeduplication: true,
      inMemoryCachingTime: 1_000,
    });

    const keys = Array.from({ length: 501 }, (_, index) => `{tenant}:${index}`);
    const events: string[] = [];
    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    unlink.mockImplementation(async () => {
      events.push('unlink');
      return keys.length;
    });
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        for (const key of keys) {
          yield [key, ['tag-1']];
        }
      },
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };
    (handler as any).inMemoryDeduplicationCache = {
      delete: vi.fn(async (batch: string[]) => {
        events.push(`delete:${batch.length}`);
        if (events.length === 1) {
          throw new Error('first batch failed');
        }
      }),
    };

    await expect(handler.revalidateTag('tag-1')).resolves.toBeUndefined();

    expect(events).toEqual([
      'delete:500',
      'delete:1',
      'unlink',
      'delete:500',
      'delete:1',
    ]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'failed to clear local read-through cache before deletion',
      ),
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });

  it('invalidates tags stored in the previous object-shaped association', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'legacy-association:',
      database: 0,
      redisGetDeduplication: false,
    });

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    unlink.mockResolvedValue(1);
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        yield ['item:a', { tags: ['tag-1'], writeId: 'legacy-write' }];
      },
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };

    await handler.revalidateTag('tag-1');

    expect(unlink).toHaveBeenCalledWith('legacy-association:item:a');
  });

  it('propagates local read-cache deletion failures after unlink succeeds', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'cluster-safe:',
      database: 0,
      redisGetDeduplication: true,
      inMemoryCachingTime: 1_000,
    });

    (handler as any).client.unlink.mockResolvedValue(1);
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
      delete: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('dedup delete failed')),
    };

    await expect(handler.revalidateTag('tag-1')).rejects.toMatchObject({
      name: 'ClusterSafeUnlinkError',
    });
    consoleErrorSpy.mockRestore();
  });

  it('still unlinks Redis keys when the pre-delete local cache clear fails', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'cluster-safe:',
      database: 0,
      redisGetDeduplication: true,
      inMemoryCachingTime: 1_000,
    });

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    unlink.mockResolvedValue(1);
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
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('publish failed before unlink'))
        .mockResolvedValueOnce(undefined),
    };

    await expect(handler.revalidateTag('tag-1')).resolves.toBeUndefined();

    expect(unlink).toHaveBeenCalledWith('cluster-safe:item:a');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'failed to clear local read-through cache before deletion',
      ),
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });

  it('invalidates tags stored in the previous object-shaped association', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'legacy-association:',
      database: 0,
      redisGetDeduplication: false,
    });

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    unlink.mockResolvedValue(1);
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      entries: function* () {
        yield ['item:a', { tags: ['tag-1'], writeId: 'legacy-write' }];
      },
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
    };

    await handler.revalidateTag('tag-1');

    expect(unlink).toHaveBeenCalledWith('legacy-association:item:a');
  });

  it('treats revalidated page tags as stale for non-fetch cache entries', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'test:',
      database: 0,
      redisGetDeduplication: false,
    });

    const cacheEntry = {
      value: { kind: 'APP_PAGE' },
      lastModified: 100,
      tags: ['_N_T_/pages/stale-page'],
    };
    (handler as any).client.get.mockResolvedValue(JSON.stringify(cacheEntry));
    (handler as any).sharedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      get: vi.fn(() => 101),
      delete: vi.fn(async () => undefined),
    };

    const res = await handler.get('/pages/stale-page', {
      kind: 'APP_PAGE',
      isRoutePPREnabled: false,
      isFallback: false,
    });

    expect(res).toBeNull();
    expect((handler as any).client.unlink).toHaveBeenCalledWith(
      'test:/pages/stale-page',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((handler as any).sharedTagsMap.delete).not.toHaveBeenCalled();
    // A page/route read must not retire the shared revalidation marker: a
    // nested FETCH entry tagged with the same implicit tag may not have been
    // read yet and still depends on it to detect its own staleness.
    expect((handler as any).revalidatedTagsMap.delete).not.toHaveBeenCalled();
  });

  it('clears the revalidation marker only after a FETCH entry observes it', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'test:',
      database: 0,
      redisGetDeduplication: false,
    });

    const cacheEntry = {
      value: { kind: 'FETCH', data: {} },
      lastModified: 100,
      tags: ['_N_T_/pages/stale-page'],
    };
    (handler as any).client.get.mockResolvedValue(JSON.stringify(cacheEntry));
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      get: vi.fn(() => 101),
      delete: vi.fn(async () => undefined),
    };

    const res = await handler.get('fetch-key', {
      kind: 'FETCH',
    } as any);

    expect(res).toBeNull();
    expect((handler as any).client.unlink).toHaveBeenCalledWith(
      'test:fetch-key',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((handler as any).revalidatedTagsMap.delete).toHaveBeenCalledWith(
      '_N_T_/pages/stale-page',
    );
  });

  it('returns non-fetch cache entries when tag revalidation is older than the entry', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'test:',
      database: 0,
      redisGetDeduplication: false,
    });

    const cacheEntry = {
      value: { kind: 'APP_PAGE' },
      lastModified: 101,
      tags: ['_N_T_/pages/fresh-page'],
    };
    (handler as any).client.get.mockResolvedValue(JSON.stringify(cacheEntry));
    (handler as any).revalidatedTagsMap = {
      waitUntilReady: vi.fn(async () => undefined),
      get: vi.fn(() => 100),
      delete: vi.fn(async () => undefined),
    };

    const res = await handler.get('/pages/fresh-page', {
      kind: 'APP_PAGE',
      isRoutePPREnabled: false,
      isFallback: false,
    });

    expect(res).toEqual(cacheEntry);
    expect((handler as any).client.unlink).not.toHaveBeenCalled();
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

  /**
   * Both races below use tiny fakes that mirror the one property of the real
   * `SyncedMap` that matters here: `set()`/`delete()` mutate the local map
   * synchronously, before any `await`, exactly like `SyncedMap.set()` /
   * `delete()` do (`this.map.set(...)` runs before the Redis hSet/publish
   * call). That is what makes the race windows below reachable: a concurrent
   * `handler.set()` call's tag write takes effect immediately, not after some
   * network round trip. Tags stay a string array; the write id is a sibling
   * map, matching the on-wire split.
   */
  function createFakeSharedTagsMap(initial: Iterable<[string, string[]]>) {
    const store = new Map(initial);
    return {
      waitUntilReady: vi.fn(async () => undefined),
      get: (key: string) => store.get(key),
      set: vi.fn((key: string, value: string[]) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
      entries: () => store.entries(),
      store,
    };
  }

  function createFakeWriteIdMap(initial: Iterable<[string, string]>) {
    const store = new Map(initial);
    return {
      waitUntilReady: vi.fn(async () => undefined),
      get: (key: string) => store.get(key),
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
      store,
    };
  }

  const concurrentCacheValue = (body: string) => ({
    kind: 'FETCH' as const,
    data: {
      headers: {},
      body,
      status: 200,
      url: 'https://example.test/cache',
    },
    revalidate: 60,
  });
  const concurrentCtx = {
    isRoutePPREnabled: false,
    isFallback: false,
    cacheControl: { revalidate: 60, expire: 120 },
  };

  it('keeps a concurrent tagged replacement discoverable by its new tag', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'concurrent:',
      database: 0,
      redisGetDeduplication: false,
    });
    const fakeSharedTagsMap = createFakeSharedTagsMap([
      ['item:a', ['old-tag']],
    ]);
    const fakeWriteIds = createFakeWriteIdMap([['item:a', 'initial']]);
    (handler as any).sharedTagsMap = fakeSharedTagsMap;
    (handler as any).sharedTagsWriteIdMap = fakeWriteIds;

    // Hold the untagged write's own Redis SET pending so the tag-association
    // snapshot it took before the SET is stale by the time it re-checks the
    // association afterwards.
    let resolveUntaggedSet!: (value: string) => void;
    const set = (handler as any).client.set as ReturnType<typeof vi.fn>;
    set.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveUntaggedSet = resolve;
        }),
    );

    const untaggedWrite = handler.set(
      'item:a',
      concurrentCacheValue('untagged-value'),
      { ...concurrentCtx, tags: [] },
    );
    for (
      let attempt = 0;
      attempt < 50 && set.mock.calls.length < 1;
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(set.mock.calls).toHaveLength(1);

    // A concurrent write replaces the value with a different tag while the
    // untagged write's own SET is still pending.
    await handler.set('item:a', concurrentCacheValue('tagged-value'), {
      ...concurrentCtx,
      tags: ['new-tag'],
    });
    expect(fakeSharedTagsMap.store.get('item:a')).toEqual(['new-tag']);

    resolveUntaggedSet('OK');
    await untaggedWrite;

    // The concurrent write's association must survive the untagged write's
    // cleanup, and the shared hash must stay a plain tag array.
    expect(fakeSharedTagsMap.store.get('item:a')).toEqual(['new-tag']);
    expect(fakeSharedTagsMap.delete).not.toHaveBeenCalled();
    expect(fakeWriteIds.delete).not.toHaveBeenCalled();

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    await handler.revalidateTag('new-tag');

    expect(unlink).toHaveBeenCalledWith('concurrent:item:a');
  });

  it('keeps a same-tag replacement discoverable when a concurrent write reconfirms the same tag', async () => {
    const handler = new RedisStringsHandler({
      redisUrl: 'redis://localhost:6379',
      keyPrefix: 'same-tag:',
      database: 0,
      redisGetDeduplication: false,
    });
    const fakeSharedTagsMap = createFakeSharedTagsMap([
      ['item:a', ['old-tag']],
    ]);
    const fakeWriteIds = createFakeWriteIdMap([['item:a', 'initial']]);
    (handler as any).sharedTagsMap = fakeSharedTagsMap;
    (handler as any).sharedTagsWriteIdMap = fakeWriteIds;

    // Hold the untagged write's own Redis SET pending so the tag-association
    // snapshot it took before the SET is stale by the time it re-checks the
    // association afterwards.
    let resolveUntaggedSet!: (value: string) => void;
    const set = (handler as any).client.set as ReturnType<typeof vi.fn>;
    set.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveUntaggedSet = resolve;
        }),
    );

    const untaggedWrite = handler.set(
      'item:a',
      concurrentCacheValue('untagged-value'),
      { ...concurrentCtx, tags: [] },
    );
    for (
      let attempt = 0;
      attempt < 50 && set.mock.calls.length < 1;
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(set.mock.calls).toHaveLength(1);

    // A concurrent write replaces the value but re-confirms the *exact same*
    // tag text while the untagged write's own SET is still pending. This is
    // the case a plain tags-array comparison cannot distinguish from "nobody
    // touched this since I read it".
    await handler.set('item:a', concurrentCacheValue('tagged-value'), {
      ...concurrentCtx,
      tags: ['old-tag'],
    });
    const writeIdAfterConcurrentWrite = fakeWriteIds.store.get('item:a');
    expect(writeIdAfterConcurrentWrite).not.toBe('initial');
    expect(fakeSharedTagsMap.store.get('item:a')).toEqual(['old-tag']);

    resolveUntaggedSet('OK');
    await untaggedWrite;

    // The concurrent write's association must survive the untagged write's
    // cleanup, even though both writes used the exact same tag text.
    expect(fakeSharedTagsMap.store.get('item:a')).toEqual(['old-tag']);
    expect(fakeWriteIds.store.get('item:a')).toBe(writeIdAfterConcurrentWrite);
    expect(fakeSharedTagsMap.delete).not.toHaveBeenCalled();
    expect(fakeWriteIds.delete).not.toHaveBeenCalled();

    const unlink = (handler as any).client.unlink as ReturnType<typeof vi.fn>;
    await handler.revalidateTag('old-tag');

    expect(unlink).toHaveBeenCalledWith('same-tag:item:a');
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
