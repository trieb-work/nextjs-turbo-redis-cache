import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('redis', () => ({
  createClient: vi.fn(() => {
    const listeners = new Map<string, Function[]>();
    const client = {
      isOpen: false,
      isReady: false,
      on: vi.fn((event: string, cb: Function) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(cb);
      }),
      emit: vi.fn((event: string, ...args: unknown[]) => {
        (listeners.get(event) ?? []).forEach((cb) => cb(...args));
      }),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      quit: vi.fn(async () => undefined),
      duplicate: vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        subscribe: vi.fn(async () => undefined),
        on: vi.fn(),
        quit: vi.fn(async () => undefined),
        configGet: vi.fn(async () => ({ 'notify-keyspace-events': 'Exe' })),
      })),
      get: vi.fn(async () => null),
      hScan: vi.fn(async () => ({ cursor: 0, tuples: [] })),
      scan: vi.fn(async () => ({ cursor: 0, keys: [] })),
      hSet: vi.fn(async () => 1),
      hDel: vi.fn(async () => 1),
      publish: vi.fn(async () => 1),
      unlink: vi.fn(async () => 1),
      set: vi.fn(async () => 'OK'),
    };
    return client;
  }),
  commandOptions: vi.fn((opts) => opts),
}));

vi.mock('../../../src/SyncedMap', () => {
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

/**
 * Deterministic regression test for:
 *   "Failed to reconnect RedisCacheComponentsHandler client after connection loss: Error: Socket already opened"
 *
 * We simulate the node-redis client emitting an error while its socket is still considered open,
 * and we stub connect() to reject with "Socket already opened".
 */

describe('RedisCacheComponentsHandler reconnect logic', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not call connect() when an error occurs but the socket is already open (prevents "Socket already opened")', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const { getRedisCacheComponentsHandler } = await import('../../../src');

    const handler = getRedisCacheComponentsHandler({
      redisUrl: 'redis://127.0.0.1:6399',
      clientOptions: {
        // Avoid queueing commands in tests.
        disableOfflineQueue: true,
      } as any,
    });

    const client = (handler as any).client;

    // Clear the initial connect() call from the constructor.
    vi.mocked(client.connect).mockClear();

    // Simulate a connection-loss situation where the socket is still open.
    Object.defineProperty(client, 'isOpen', { value: true });
    Object.defineProperty(client, 'isReady', { value: false });

    // Stub connect() so we can assert it is NOT called.
    const connectSpy = vi.spyOn(client, 'connect');

    // Trigger the handler's on('error') callback.
    client.emit('error', new Error('ECONNREFUSED 127.0.0.1:6379'));

    // Reconnect is scheduled after 1000ms.
    await vi.advanceTimersByTimeAsync(1100);

    expect(connectSpy).not.toHaveBeenCalled();

    const msgs = consoleError.mock.calls
      .map((c) => c.map(String).join(' '))
      .join('\n');

    expect(msgs).not.toContain(
      'Failed to reconnect RedisCacheComponentsHandler client after connection loss:',
    );
    expect(msgs).not.toContain('Socket already opened');
  });
});
