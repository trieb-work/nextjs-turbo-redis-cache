import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncedMap } from '../../../src/SyncedMap';

// Module-level knobs for the subscribe() mock so that behaviour persists
// across the duplicate() clients created inside SyncedMap.
let globalSubscribeCalls = 0;
let globalSubscribeFailUntil = 0;

class MockClient {
  static nextId = 1;
  id = MockClient.nextId++;
  private errorHandlers: Set<(err: Error) => void | Promise<void>> = new Set();
  quitShouldThrow = true;

  isOpen = true;
  isReady = true;

  on(event: string, handler: (err: Error) => void | Promise<void>) {
    if (event === 'error') this.errorHandlers.add(handler);
    return this as any;
  }

  emit(event: string, err: Error) {
    if (event === 'error') {
      for (const h of this.errorHandlers) {
        void h(err);
      }
    }
    return true;
  }

  removeAllListeners(event?: string) {
    if (!event || event === 'error') this.errorHandlers.clear();
    return this as any;
  }

  async connect() {
    this.isOpen = true;
    this.isReady = true;
  }

  async configGet() {
    return { 'notify-keyspace-events': 'Exe' };
  }

  async subscribe() {
    const attempt = globalSubscribeCalls++;
    if (attempt < globalSubscribeFailUntil) {
      throw new Error(`Mock subscribe failure ${attempt}`);
    }
  }

  async quit() {
    if (this.quitShouldThrow)
      throw new Error('Mock quit failure (disconnected)');
  }

  async disconnect() {
    this.isOpen = false;
    this.isReady = false;
    this.errorHandlers.clear();
  }

  duplicate() {
    return new MockClient();
  }

  hScan() {
    return { cursor: 0, tuples: [] };
  }

  scan() {
    return { cursor: 0, keys: [] };
  }
}

function createMap(rootClient = new MockClient()) {
  return new SyncedMap<string>({
    client: rootClient as any,
    keyPrefix: 'repro:',
    redisKey: '__sharedTags__',
    database: 0,
    querySize: 250,
    filterKeys: () => true,
    customizedSync: {
      withoutRedisHashmap: true,
      withoutSetSync: true,
    },
  });
}

describe('SyncedMap.reconnectSubscriber() repro tests', () => {
  let originalSetTimeout: typeof global.setTimeout;

  beforeEach(() => {
    globalSubscribeCalls = 0;
    globalSubscribeFailUntil = 0;
    originalSetTimeout = global.setTimeout;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
  });

  it('Issue 2: first backoff delay should be 500ms, not 1000ms', async () => {
    const root = new MockClient();
    const map = createMap(root);
    // wait for initial setup to succeed (attempt 0)
    await (map as any).waitUntilReady().catch(() => undefined);

    const capturedDelays: number[] = [];
    global.setTimeout = ((callback: () => void, delay?: number) => {
      capturedDelays.push(Number(delay ?? 0));
      return originalSetTimeout(callback, 0) as any;
    }) as any;

    // initial subscribe consumed attempt 0; force the next 3 reconnection
    // attempts to fail, then succeed on the 4th
    globalSubscribeFailUntil = 4;

    await (map as any).reconnectSubscriber();

    expect(capturedDelays.length).toBeGreaterThanOrEqual(1);
    // Bug: delay is computed with attempt already incremented, so the first
    // retry waits 500 * 2^1 = 1000 ms. After the fix it should be 500 ms.
    expect(capturedDelays[0]).toBe(500);
  });

  it('Issue 1: stale error on old subscriber must not kill the healthy new subscriber', async () => {
    const root = new MockClient();
    const map = createMap(root);
    await (map as any).waitUntilReady().catch(() => undefined);

    const oldSubscriber = (map as any).subscriberClient as MockClient;
    expect(oldSubscriber).toBeDefined();

    await (map as any).reconnectSubscriber();

    const newSubscriber = (map as any).subscriberClient as MockClient;
    expect(newSubscriber.id).not.toBe(oldSubscriber.id);

    // Simulate a delayed error from the old (now replaced) subscriber.
    // With the current code the old 'error' listener is still attached,
    // so it triggers reconnectSubscriber() and tears down the healthy client.
    oldSubscriber.emit('error', new Error('delayed zombie error'));

    // Give the async error handler a chance to run.
    await new Promise((r) => originalSetTimeout(r, 50));

    const afterStaleError = (map as any).subscriberClient as MockClient;

    expect(afterStaleError.id).toBe(newSubscriber.id);
  });
});
