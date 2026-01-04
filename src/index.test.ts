import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('redis', () => {
  const createClient = () => {
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
  };
  return {
    createClient,
    commandOptions: vi.fn((opts) => opts),
  };
});

vi.mock('./SyncedMap', () => {
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

import RedisStringsHandler from './RedisStringsHandler';

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
});
