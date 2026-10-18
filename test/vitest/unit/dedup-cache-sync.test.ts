import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import RedisStringsHandler from '../../../src/RedisStringsHandler';

// One in-memory Redis shared by all handler instances: a string store and a
// pub/sub bus that delivers each message to every subscriber.
const hoisted = vi.hoisted(() => {
  const store = new Map<string, string>();
  const subscribers = new Map<string, Set<(message: string) => void>>();
  const published: { channel: string; message: string }[] = [];
  const control = {
    failSet: false,
    // When set, GET reads the store at call time but resolves only after
    // this promise, like a slow Redis reply.
    holdGet: undefined as Promise<void> | undefined,
  };
  return { store, subscribers, published, control };
});

vi.mock('redis', () => {
  const createClient = () => ({
    isReady: true,
    isOpen: true,
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    duplicate: vi.fn(() => createClient()),
    configGet: vi.fn(async () => ({ 'notify-keyspace-events': 'Exe' })),
    subscribe: vi.fn(
      async (channel: string, listener: (message: string) => void) => {
        if (!hoisted.subscribers.has(channel)) {
          hoisted.subscribers.set(channel, new Set());
        }
        hoisted.subscribers.get(channel)!.add(listener);
      },
    ),
    publish: vi.fn(async (channel: string, message: string) => {
      hoisted.published.push({ channel, message });
      const listeners = hoisted.subscribers.get(channel) ?? new Set();
      for (const listener of listeners) listener(message);
      return listeners.size;
    }),
    get: vi.fn(async (_opts: unknown, key: string) => {
      const value = hoisted.store.get(key) ?? null;
      await hoisted.control.holdGet;
      return value;
    }),
    set: vi.fn(async (key: string, value: string) => {
      if (hoisted.control.failSet) throw new Error('SET failed');
      hoisted.store.set(key, value);
      return 'OK';
    }),
    unlink: vi.fn(async (keys: string[]) => {
      for (const key of keys) hoisted.store.delete(key);
      return keys.length;
    }),
    sendCommand: vi.fn(async (args: string[]) => {
      const [command] = args;
      if (command === 'HSCAN' || command === 'SCAN') {
        return ['0', []];
      }
      throw new Error(`Unexpected sendCommand: ${command}`);
    }),
    hSet: vi.fn(async () => 1),
    hDel: vi.fn(async () => 1),
  });
  return {
    createClient,
    commandOptions: vi.fn((opts) => opts),
  };
});

const KEY = '/page';
const setCtx = {
  isRoutePPREnabled: false,
  isFallback: false,
  cacheControl: { revalidate: 60, expire: 600 },
};
const getCtx = {
  kind: 'PAGES' as const,
  isRoutePPREnabled: false,
  isFallback: false,
};

function page(html: string) {
  return {
    kind: 'PAGES' as const,
    html,
    pageData: {},
    headers: {},
    status: 200,
  };
}

// One handler per pod/worker. They share Redis, but each has its own
// in-memory read cache.
function createInstance(inMemoryCachingTime: number) {
  return new RedisStringsHandler({
    redisUrl: 'redis://localhost:6379',
    keyPrefix: 'test:',
    database: 0,
    redisGetDeduplication: true,
    inMemoryCachingTime,
  });
}

async function readHtml(handler: RedisStringsHandler) {
  const entry = await handler.get(KEY, getCtx);
  return (entry?.value as { html?: string } | undefined)?.html ?? null;
}

function readCacheMessages() {
  return hoisted.published.filter(({ channel }) =>
    channel.endsWith('inMemoryDeduplicationCache'),
  );
}

describe('in-memory read cache across instances', () => {
  beforeEach(() => {
    hoisted.store.clear();
    hoisted.subscribers.clear();
    hoisted.published.length = 0;
    hoisted.control.failSet = false;
    hoisted.control.holdGet = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not publish a sync message when a cached read expires', async () => {
    const writer = createInstance(20);
    const reader = createInstance(20);
    for (const key of ['/a', '/b', '/c']) {
      await writer.set(key, page(key), setCtx);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    hoisted.published.length = 0;

    for (const key of ['/a', '/b', '/c']) {
      await reader.get(key, getCtx);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(readCacheMessages()).toEqual([]);
  });

  it('serves the new value on another instance right after set()', async () => {
    const writer = createInstance(10_000);
    const reader = createInstance(10_000);

    await writer.set(KEY, page('v1'), setCtx);
    expect(await readHtml(reader)).toBe('v1');

    await writer.set(KEY, page('v2'), setCtx);

    expect(await readHtml(reader)).toBe('v2');
    expect(await readHtml(writer)).toBe('v2');
  });

  it('keeps the cached copy on other instances when the Redis SET fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const writer = createInstance(10_000);
    const reader = createInstance(10_000);

    await writer.set(KEY, page('v1'), setCtx);
    expect(await readHtml(reader)).toBe('v1');
    hoisted.published.length = 0;

    hoisted.control.failSet = true;
    await expect(writer.set(KEY, page('v2'), setCtx)).rejects.toThrow(
      'SET failed',
    );

    expect(readCacheMessages()).toEqual([]);
    expect(await readHtml(reader)).toBe('v1');
  });

  it('does not keep an old value read while set() runs on another instance', async () => {
    const writer = createInstance(10_000);
    const reader = createInstance(10_000);
    await writer.set(KEY, page('v1'), setCtx);

    let releaseGet!: () => void;
    hoisted.control.holdGet = new Promise((resolve) => {
      releaseGet = resolve;
    });
    const slowRead = readHtml(reader);
    // Let the reader send its GET before the writer changes the value.
    await new Promise((resolve) => setTimeout(resolve, 0));
    hoisted.control.holdGet = undefined;

    await writer.set(KEY, page('v2'), setCtx);
    releaseGet();

    expect(await slowRead).toBe('v1');
    expect(await readHtml(reader)).toBe('v2');
  });

  it('drops the cached copy on another instance after revalidateTag()', async () => {
    const writer = createInstance(10_000);
    const reader = createInstance(10_000);

    await writer.set(KEY, page('v1'), setCtx);
    expect(await readHtml(reader)).toBe('v1');

    await writer.revalidateTag(`_N_T_${KEY}`);

    expect(await readHtml(reader)).toBeNull();
  });
});
