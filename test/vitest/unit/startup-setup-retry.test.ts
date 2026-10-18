import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A pod can start while Redis is down, or lose the socket while the startup
// HSCAN is in flight. The tag maps must keep retrying their setup, and cache
// calls must not hang while they do.

const redisState = {
  hscanFailuresLeft: 0,
  configGetFailuresLeft: 0,
  hscanCalls: 0,
  getCalls: 0,
};

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
    removeAllListeners(event?: string) {
      if (event) listeners.delete(event);
      else listeners.clear();
      return client;
    },
    async connect() {},
    async disconnect() {},
    async quit() {},
    duplicate: () => createMockClient(),
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
        if (redisState.hscanFailuresLeft > 0) {
          redisState.hscanFailuresLeft--;
          throw socketClosed();
        }
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SyncedMap becomes ready after the initial HSCAN fails once', async () => {
    redisState.hscanFailuresLeft = 1;
    const map = await createSyncedMap();

    expect(await outcomeWithin(map.waitUntilReady(), 3_000)).toBe('resolved');
    expect(redisState.hscanCalls).toBe(2);
  });

  it('SyncedMap becomes ready after the subscriber setup fails once', async () => {
    redisState.configGetFailuresLeft = 1;
    const map = await createSyncedMap();

    expect(await outcomeWithin(map.waitUntilReady(), 3_000)).toBe('resolved');
  });

  it('SyncedMap rejects waiters at once while setup retries', async () => {
    redisState.hscanFailuresLeft = Number.POSITIVE_INFINITY;
    const map = await createSyncedMap();
    await new Promise((r) => setTimeout(r, 50));

    expect(await outcomeWithin(map.waitUntilReady(), 200)).toBe('rejected');
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
