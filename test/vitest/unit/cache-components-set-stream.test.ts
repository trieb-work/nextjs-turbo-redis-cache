import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const store = new Map<string, string>();
  return { store };
});

vi.mock('redis', () => {
  const createClient = () => ({
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
    sendCommand: vi.fn(async (args: string[]) => {
      const [command] = args;
      if (command === 'HSCAN' || command === 'SCAN') {
        return ['0', []];
      }
      throw new Error(`Unexpected sendCommand: ${command}`);
    }),
    hSet: vi.fn(async () => 1),
    hDel: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    unlink: vi.fn(async () => 1),
    set: vi.fn(async (key: string, value: string) => {
      hoisted.store.set(key, value);
      return 'OK';
    }),
  });

  return {
    createClient,
    commandOptions: vi.fn((opts) => opts),
  };
});

const KEY_PREFIX = 'stream:';

function entry(value: ReadableStream<Uint8Array>) {
  return {
    value,
    tags: ['tag-a'],
    stale: 1,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('RedisCacheComponentsHandler.set() stream handling', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hoisted.store.clear();
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createHandler() {
    const { getRedisCacheComponentsHandler } = await import(
      '../../../src/CacheComponentsHandler'
    );
    return getRedisCacheComponentsHandler({
      keyPrefix: KEY_PREFIX,
      redisGetDeduplication: false,
    });
  }

  it('stores every chunk of a multi-chunk stream and get() returns the same bytes', async () => {
    const chunks = ['<div>', 'cached ', 'payload', '</div>'];
    const handler = await createHandler();

    await handler.set(
      'multi',
      Promise.resolve(
        entry(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(new TextEncoder().encode(chunk));
              }
              controller.close();
            },
          }),
        ),
      ),
    );

    const stored = JSON.parse(hoisted.store.get(KEY_PREFIX + 'multi')!);
    expect(Buffer.from(stored.value, 'base64').toString()).toBe(
      chunks.join(''),
    );

    const cached = await handler.get('multi', []);
    expect(cached).toBeDefined();
    expect(await readAll(cached!.value)).toBe(chunks.join(''));
  });

  it('stores nothing and rejects with the stream error when the stream fails during reading', async () => {
    const handler = await createHandler();

    await expect(
      handler.set(
        'broken',
        Promise.resolve(
          entry(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('partial'));
                controller.error(new Error('render failed'));
              },
            }),
          ),
        ),
      ),
    ).rejects.toThrow('render failed');

    expect(hoisted.store.has(KEY_PREFIX + 'broken')).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
