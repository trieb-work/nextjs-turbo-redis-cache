import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A pod can start while Redis is down, or lose the socket while the startup
// HSCAN is in flight. The tag maps must keep retrying their setup, and cache
// calls must not hang while they do.

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const redisState = {
  hscanFailuresLeft: 0,
  configGetFailuresLeft: 0,
  hscanCalls: 0,
  getCalls: 0,
  hscanHold: undefined as Deferred | undefined,
  subscriberConnectHold: undefined as Deferred | undefined,
  duplicates: [] as MockClient[],
  // Fields of the shared Redis hash, and the matching Redis string keys.
  hash: new Map<string, string>(),
};

type MockClient = ReturnType<typeof createMockClient>;

function socketClosed() {
  return new Error('Socket closed unexpectedly');
}

function createMockClient() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const client = {
    isOpen: true,
    isReady: true,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return client;
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    removeAllListeners(event?: string) {
      if (event) listeners.delete(event);
      else listeners.clear();
      return client;
    },
    async connect() {
      await redisState.subscriberConnectHold?.promise;
    },
    async disconnect() {},
    async quit() {},
    duplicate: () => {
      const duplicate = createMockClient();
      redisState.duplicates.push(duplicate);
      return duplicate;
    },
    async configGet() {
      if (redisState.configGetFailuresLeft > 0) {
        redisState.configGetFailuresLeft--;
        throw socketClosed();
      }
      return { 'notify-keyspace-events': 'Exe' };
    },
    async subscribe() {},
    async sendCommand(args: string[]) {
      if (args[0] === 'HSCAN') {
        redisState.hscanCalls++;
        const hold = redisState.hscanHold;
        redisState.hscanHold = undefined;
        await hold?.promise;
        if (redisState.hscanFailuresLeft > 0) {
          redisState.hscanFailuresLeft--;
          throw socketClosed();
        }
        return ['0', [...redisState.hash].flat()];
      }
      if (args[0] === 'SCAN') {
        return ['0', [...redisState.hash.keys()].map((key) => 'retry:' + key)];
      }
      return ['0', []];
    },
    async get() {
      redisState.getCalls++;
      return null;
    },
    async hSet() {
      return 1;
    },
    async hDel() {
      return 1;
    },
    async publish() {
      return 1;
    },
  };
  return client;
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => createMockClient()),
  commandOptions: vi.fn((opts) => opts),
}));

type Outcome = 'resolved' | 'rejected' | 'pending';

async function outcomeWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<Outcome> {
  return Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<Outcome>((r) => setTimeout(() => r('pending'), ms)),
  ]);
}

async function createSyncedMap() {
  const { SyncedMap } = await import('../../../src/SyncedMap');
  return new SyncedMap<string[]>({
    client: createMockClient() as never,
    keyPrefix: 'retry:',
    redisKey: '__sharedTags__',
    database: 0,
    querySize: 250,
    filterKeys: () => true,
  });
}

describe('tag map setup after a failed start', () => {
  beforeEach(() => {
    redisState.hscanFailuresLeft = 0;
    redisState.configGetFailuresLeft = 0;
    redisState.hscanCalls = 0;
    redisState.getCalls = 0;
    redisState.hscanHold = undefined;
    redisState.subscriberConnectHold = undefined;
    redisState.duplicates = [];
    redisState.hash = new Map();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SyncedMap becomes ready after the initial HSCAN fails once', async () => {
    redisState.hscanFailuresLeft = 1;
    const map = await createSyncedMap();

    await vi.waitFor(() => map.waitUntilReady(), { timeout: 3_000 });
    expect(redisState.hscanCalls).toBe(2);
  });

  it('SyncedMap becomes ready after the subscriber setup fails once', async () => {
    redisState.configGetFailuresLeft = 1;
    const map = await createSyncedMap();

    await vi.waitFor(() => map.waitUntilReady(), { timeout: 3_000 });
  });

  it('SyncedMap rejects waiters at once while setup retries', async () => {
    redisState.hscanFailuresLeft = Number.POSITIVE_INFINITY;
    const map = await createSyncedMap();
    await new Promise((r) => setTimeout(r, 50));

    expect(await outcomeWithin(map.waitUntilReady(), 200)).toBe('rejected');
  });

  it('SyncedMap wakes a waiter that started before the first attempt failed', async () => {
    const hscan = deferred();
    redisState.hscanHold = hscan;
    const map = await createSyncedMap();

    const waiting = map.waitUntilReady();
    await new Promise((r) => setTimeout(r, 20));
    hscan.reject(socketClosed());

    expect(await outcomeWithin(waiting, 200)).toBe('rejected');
  });

  it('subscriber errors during a pending setup attempt join it and keep its client', async () => {
    const connect = deferred();
    redisState.subscriberConnectHold = connect;
    const map = await createSyncedMap();
    await new Promise((r) => setTimeout(r, 20));
    expect(redisState.duplicates).toHaveLength(1);

    const [subscriber] = redisState.duplicates;
    subscriber.emit('error', socketClosed());
    subscriber.emit('error', socketClosed());
    await new Promise((r) => setTimeout(r, 20));
    connect.resolve();

    await vi.waitFor(() => map.waitUntilReady(), { timeout: 3_000 });
    expect(redisState.duplicates).toHaveLength(1);
  });

  it('reloads entries that another pod stored while the subscriber reconnected', async () => {
    const map = await createSyncedMap();
    await vi.waitFor(() => map.waitUntilReady(), { timeout: 3_000 });

    const connect = deferred();
    redisState.subscriberConnectHold = connect;
    redisState.duplicates[0].emit('error', socketClosed());
    await new Promise((r) => setTimeout(r, 20));

    // Pod B stores a tagged entry. Its sync message reaches nobody.
    redisState.hash.set('tagged-entry', JSON.stringify(['article:42']));
    expect(await outcomeWithin(map.waitUntilReady(), 200)).toBe('rejected');

    connect.resolve();
    await vi.waitFor(() => map.waitUntilReady(), { timeout: 3_000 });
    expect(map.get('tagged-entry')).toEqual(['article:42']);
  });

  it('loads entries stored while the subscriber was still connecting at startup', async () => {
    const connect = deferred();
    redisState.subscriberConnectHold = connect;
    const map = await createSyncedMap();
    await new Promise((r) => setTimeout(r, 20));

    redisState.hash.set('tagged-entry', JSON.stringify(['article:42']));
    connect.resolve();

    await vi.waitFor(() => map.waitUntilReady(), { timeout: 3_000 });
    expect(map.get('tagged-entry')).toEqual(['article:42']);
  });

  it('RedisStringsHandler.get() misses fast while setup retries, then reads Redis', async () => {
    redisState.hscanFailuresLeft = Number.POSITIVE_INFINITY;
    const { default: RedisStringsHandler } = await import(
      '../../../src/RedisStringsHandler'
    );
    const handler = new RedisStringsHandler({ keyPrefix: 'retry:' });
    await new Promise((r) => setTimeout(r, 50));

    const get = () => handler.get('key', { kind: 'FETCH' } as never);
    const missing = get();
    expect(await outcomeWithin(missing, 1_000)).toBe('resolved');
    expect(await missing).toBeNull();
    expect(redisState.getCalls).toBe(0);

    redisState.hscanFailuresLeft = 0;
    await vi.waitFor(
      async () => {
        await get();
        expect(redisState.getCalls).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 200 },
    );
  });

  it('CacheComponentsHandler.get() misses fast while setup retries, then reads Redis', async () => {
    redisState.hscanFailuresLeft = Number.POSITIVE_INFINITY;
    vi.resetModules();
    const { getRedisCacheComponentsHandler } = await import('../../../src');
    const handler = getRedisCacheComponentsHandler({ keyPrefix: 'retry:' });
    await new Promise((r) => setTimeout(r, 50));

    const missing = handler.get('key', []);
    expect(await outcomeWithin(missing, 1_000)).toBe('resolved');
    expect(await missing).toBeUndefined();
    expect(redisState.getCalls).toBe(0);

    redisState.hscanFailuresLeft = 0;
    await vi.waitFor(
      async () => {
        await handler.get('key', []);
        expect(redisState.getCalls).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 200 },
    );
  });
});
