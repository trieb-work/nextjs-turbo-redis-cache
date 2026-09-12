import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const store = new Map<string, string>();
  const unlinkedKeys: string[] = [];
  return { store, unlinkedKeys };
});

vi.mock('redis', () => {
  const createClient = () => {
    const client = {
      isReady: true,
      isOpen: true,
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
        isOpen: true,
        isReady: true,
      })),
      get: vi.fn(
        async (_opts: unknown, key: string) => hoisted.store.get(key) ?? null,
      ),
      hScan: vi.fn(async () => ({ cursor: 0, tuples: [] })),
      scan: vi.fn(async () => ({ cursor: 0, keys: [] })),
      hSet: vi.fn(async () => 1),
      hDel: vi.fn(async () => 1),
      publish: vi.fn(async () => 1),
      unlink: vi.fn(async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) {
          hoisted.unlinkedKeys.push(key);
          hoisted.store.delete(key);
        }
        return list.length;
      }),
      set: vi.fn(async (key: string, value: string) => {
        hoisted.store.set(key, value);
        return 'OK';
      }),
    };
    return client;
  };

  return {
    createClient,
    commandOptions: vi.fn((opts) => opts),
  };
});

function cachedEntry(tags: string[], timestamp: number) {
  return {
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('cached'));
        controller.close();
      },
    }),
    tags,
    stale: 1,
    timestamp,
    expire: 3600,
    revalidate: 60,
  };
}

describe('RedisCacheComponentsHandler.updateTags vs Next.js default handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.store.clear();
    hoisted.unlinkedKeys.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createHandler(keyPrefix: string) {
    const { getRedisCacheComponentsHandler } = await import(
      '../../../src/CacheComponentsHandler'
    );

    return getRedisCacheComponentsHandler({
      keyPrefix,
      redisGetDeduplication: false,
    });
  }

  it('SWR expire keeps the entry and sets revalidate=-1 until the window elapses', async () => {
    const handler = await createHandler('swr:');
    const createdAt = Date.now();

    await handler.set(
      'page',
      Promise.resolve(cachedEntry(['posts'], createdAt)),
    );
    // Next.js areTagsStale/areTagsExpired require stale/expired > entry.timestamp.
    await vi.advanceTimersByTimeAsync(1);
    const revalidatedAt = Date.now();
    await handler.updateTags(['posts'], { expire: 2 });

    expect(await handler.getExpiration(['posts'])).toBe(revalidatedAt + 2_000);

    const served = await handler.get('page', []);
    expect(served).toBeDefined();
    expect(served?.revalidate).toBe(-1);
    expect(hoisted.unlinkedKeys).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await handler.get('page', [])).toBeUndefined();
  });

  it('cacheLife max expire (~1y) is SWR, not a delay before staleness', async () => {
    const handler = await createHandler('max:');
    const createdAt = Date.now();
    const oneYear = 60 * 60 * 24 * 365;

    await handler.set(
      'page',
      Promise.resolve(cachedEntry(['posts'], createdAt)),
    );
    await vi.advanceTimersByTimeAsync(1);
    const revalidatedAt = Date.now();
    await handler.updateTags(['posts'], { expire: oneYear });

    expect(await handler.getExpiration(['posts'])).toBe(
      revalidatedAt + oneYear * 1000,
    );
    const served = await handler.get('page', []);
    expect(served?.revalidate).toBe(-1);
    expect(await handler.get('page', [])).toBeDefined();
  });

  it('omitted durations is a blocking miss (updateTag / deprecated revalidateTag)', async () => {
    const handler = await createHandler('hard:');
    const createdAt = Date.now();

    await handler.set(
      'page',
      Promise.resolve(cachedEntry(['posts'], createdAt)),
    );
    await vi.advanceTimersByTimeAsync(1);
    const revalidatedAt = Date.now();
    await handler.updateTags(['posts']);

    expect(await handler.getExpiration(['posts'])).toBe(revalidatedAt);
    expect(await handler.get('page', [])).toBeUndefined();
  });

  it('{ expire: 0 } is a blocking miss', async () => {
    const handler = await createHandler('zero:');
    const createdAt = Date.now();

    await handler.set(
      'page',
      Promise.resolve(cachedEntry(['posts'], createdAt)),
    );
    await vi.advanceTimersByTimeAsync(1);
    const revalidatedAt = Date.now();
    await handler.updateTags(['posts'], { expire: 0 });

    expect(await handler.getExpiration(['posts'])).toBe(revalidatedAt);
    expect(await handler.get('page', [])).toBeUndefined();
  });

  it('persists stale+expired so a later getExpiration still sees the window', async () => {
    const handler = await createHandler('persist:');
    const startedAt = Date.now();

    await handler.updateTags(['posts'], { expire: 2 });
    const stored = (handler as any).revalidatedTagsMap.get('posts');

    expect(stored).toEqual({
      stale: startedAt,
      expired: startedAt + 2_000,
    });
  });

  it.each([
    ['seconds', 60],
    ['minutes', 60 * 60],
    ['hours', 60 * 60 * 24],
    ['days', 60 * 60 * 24 * 7],
    ['weeks', 60 * 60 * 24 * 30],
    ['max', 60 * 60 * 24 * 365],
    ['default', 0xfffffffe],
  ] as const)(
    'cacheLife %s expire writes getExpiration=now+expire*1000 and SWR',
    async (_profile, expireSeconds) => {
      const handler = await createHandler(`preset-${_profile}:`);
      const createdAt = Date.now();

      await handler.set(
        'page',
        Promise.resolve(cachedEntry(['posts'], createdAt)),
      );
      await vi.advanceTimersByTimeAsync(1);
      const revalidatedAt = Date.now();
      await handler.updateTags(['posts'], { expire: expireSeconds });

      expect(await handler.getExpiration(['posts'])).toBe(
        revalidatedAt + expireSeconds * 1000,
      );
      const served = await handler.get('page', []);
      expect(served?.revalidate).toBe(-1);
      expect(await handler.get('page', [])).toBeDefined();
    },
  );
});
