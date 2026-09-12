import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const store = new Map<string, string>();
  const sharedTags = new Map<string, string[]>();
  const revalidatedTags = new Map<string, number>();
  return { store, sharedTags, revalidatedTags };
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
      unlink: vi.fn(async () => 1),
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

describe('RedisCacheComponentsHandler.updateTags durations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.store.clear();
    hoisted.sharedTags.clear();
    hoisted.revalidatedTags.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers tag revalidation when durations.expire is provided', async () => {
    const { getRedisCacheComponentsHandler } = await import(
      '../../../src/CacheComponentsHandler'
    );

    const handler = getRedisCacheComponentsHandler({
      keyPrefix: 'durations-test:',
      redisGetDeduplication: false,
    });

    const revalidatedTagsMap = (handler as any).revalidatedTagsMap;
    const originalSet = revalidatedTagsMap.set.bind(revalidatedTagsMap);
    revalidatedTagsMap.set = vi.fn(async (tag: string, value: number) => {
      hoisted.revalidatedTags.set(tag, value);
      return originalSet(tag, value);
    });

    await handler.updateTags(['cache-lab:swr'], { expire: 2 });

    expect(revalidatedTagsMap.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(revalidatedTagsMap.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(revalidatedTagsMap.set).toHaveBeenCalledWith(
      'cache-lab:swr',
      expect.any(Number),
    );
  });

  it('immediately revalidates tags when durations is omitted', async () => {
    const { getRedisCacheComponentsHandler } = await import(
      '../../../src/CacheComponentsHandler'
    );

    const handler = getRedisCacheComponentsHandler({
      keyPrefix: 'immediate-test:',
      redisGetDeduplication: false,
    });

    const revalidatedTagsMap = (handler as any).revalidatedTagsMap;
    const setSpy = vi.spyOn(revalidatedTagsMap, 'set');

    await handler.updateTags(['cache-lab:tag']);

    expect(setSpy).toHaveBeenCalledWith('cache-lab:tag', expect.any(Number));
  });
});
