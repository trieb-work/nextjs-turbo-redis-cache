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
    revalidate: 1,
  };
}

describe('RedisCacheComponentsHandler.updateTags durations', () => {
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

  it('marks tags stale immediately for SWR expire without unlinking', async () => {
    const handler = await createHandler('durations-test:');
    const now = Date.now();

    await handler.set(
      'page',
      Promise.resolve(cachedEntry(['cache-lab:swr'], now)),
    );
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await handler.updateTags(['cache-lab:swr'], { expire: 2 });

    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 2000)).toBe(
      false,
    );
    timeoutSpy.mockRestore();

    expect(await handler.getExpiration(['cache-lab:swr'])).toBe(now);
    expect(hoisted.unlinkedKeys).toEqual([]);
    expect(await handler.get('page', [])).toBeDefined();
  });

  it('marks tags stale immediately for cacheLife max-style expire (~1y)', async () => {
    const handler = await createHandler('max-profile:');
    const now = Date.now();
    const oneYear = 60 * 60 * 24 * 365;

    await handler.set('page', Promise.resolve(cachedEntry(['posts'], now)));
    await handler.updateTags(['posts'], { expire: oneYear });

    expect(await handler.getExpiration(['posts'])).toBe(now);
    expect(hoisted.unlinkedKeys).toEqual([]);
    expect(await handler.get('page', [])).toBeDefined();
  });

  it('survives a simulated restart because the timestamp is already in the map', async () => {
    const handler = await createHandler('restart:');
    const startedAt = Date.now();

    await handler.updateTags(['cache-lab:swr'], { expire: 2 });
    const stored = (handler as any).revalidatedTagsMap.get('cache-lab:swr');

    const { effectiveRevalidationTimestamp, normalizeTagRevalidation } =
      await import('../../../src/utils/tagRevalidation');

    expect(
      effectiveRevalidationTimestamp(
        normalizeTagRevalidation(stored, startedAt),
        startedAt,
      ),
    ).toBe(startedAt);
    expect(
      effectiveRevalidationTimestamp(
        normalizeTagRevalidation(stored, startedAt + 2_000),
        startedAt + 2_000,
      ),
    ).toBe(startedAt);
  });

  it('hard-expires when durations is omitted', async () => {
    const handler = await createHandler('immediate-test:');
    const now = Date.now();

    await handler.set(
      'page',
      Promise.resolve(cachedEntry(['cache-lab:tag'], now)),
    );
    await handler.updateTags(['cache-lab:tag']);

    expect(await handler.getExpiration(['cache-lab:tag'])).toBe(now);
    expect(hoisted.unlinkedKeys).toContain('immediate-test:page');
    expect(await handler.get('page', [])).toBeUndefined();
  });

  it('hard-expires when expire is 0', async () => {
    const handler = await createHandler('expire-zero:');
    const now = Date.now();

    await handler.set(
      'page',
      Promise.resolve(cachedEntry(['cache-lab:tag'], now)),
    );
    await handler.updateTags(['cache-lab:tag'], { expire: 0 });

    expect(await handler.getExpiration(['cache-lab:tag'])).toBe(now);
    expect(hoisted.unlinkedKeys).toContain('expire-zero:page');
    expect(await handler.get('page', [])).toBeUndefined();
  });
});
