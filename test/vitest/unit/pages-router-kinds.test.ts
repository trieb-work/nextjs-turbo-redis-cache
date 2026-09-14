import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import RedisStringsHandler, {
  CacheEntry,
} from '../../../src/RedisStringsHandler';

// In-memory Redis string store shared between the mocked client and the tests
const hoisted = vi.hoisted(() => {
  const store = new Map<string, { value: string; ex?: number }>();
  return { store };
});

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
      get: vi.fn(
        async (_opts: unknown, key: string) =>
          hoisted.store.get(key)?.value ?? null,
      ),
      hScan: vi.fn(async () => ({ cursor: 0, tuples: [] })),
      scan: vi.fn(async () => ({ cursor: 0, keys: [] })),
      hSet: vi.fn(async () => 1),
      hDel: vi.fn(async () => 1),
      publish: vi.fn(async () => 1),
      unlink: vi.fn(async () => 1),
      set: vi.fn(async (key: string, value: string, opts?: { EX?: number }) => {
        hoisted.store.set(key, { value, ex: opts?.EX });
        return 'OK';
      }),
    };
  };
  return {
    createClient,
    commandOptions: vi.fn((opts) => opts),
  };
});

const KEY_PREFIX = 'test:';
const DEFAULT_STALE_AGE = 60 * 60 * 24 * 14;
// Default estimateExpireAge outside production is staleAge * 1.2
const expireAge = (staleAge: number) => staleAge * 1.2;

function createHandler() {
  return new RedisStringsHandler({
    redisUrl: 'redis://localhost:6379',
    keyPrefix: KEY_PREFIX,
    database: 0,
    getTimeoutMs: 100,
    redisGetDeduplication: false,
    inMemoryCachingTime: 0,
  });
}

function storedEntry(key: string): { entry: CacheEntry; ex?: number } {
  const raw = hoisted.store.get(KEY_PREFIX + key);
  expect(raw).toBeDefined();
  return { entry: JSON.parse(raw!.value), ex: raw!.ex };
}

const baseCtx = { isRoutePPREnabled: false, isFallback: false };

describe('RedisStringsHandler Pages Router kinds', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hoisted.store.clear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PAGES entries', () => {
    const pagesData = {
      kind: 'PAGES' as const,
      html: '<html><body>hello</body></html>',
      pageData: { pageProps: { title: 'hello' }, __N_SSG: true },
      headers: undefined,
      status: 200,
    };

    it('set() stores a PAGES entry without warnings and with the implicit path tag', async () => {
      const handler = createHandler();
      await handler.set('/blog/post-1', pagesData, {
        ...baseCtx,
        cacheControl: { revalidate: 60, expire: undefined },
      });

      const { entry, ex } = storedEntry('/blog/post-1');
      expect(entry).toEqual({
        value: pagesData,
        lastModified: expect.any(Number),
        tags: ['_N_T_/blog/post-1'],
      });
      // TTL is derived from cacheControl.revalidate (getStaticProps revalidate)
      expect(ex).toBe(expireAge(60));
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('get() returns a PAGES entry without warnings', async () => {
      const handler = createHandler();
      await handler.set('/blog/post-1', pagesData, {
        ...baseCtx,
        cacheControl: { revalidate: 60, expire: undefined },
      });

      const result = await handler.get('/blog/post-1', {
        kind: 'PAGES',
        isFallback: false,
      });

      expect(result).toEqual({
        value: pagesData,
        lastModified: expect.any(Number),
        tags: ['_N_T_/blog/post-1'],
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('set() with revalidate: false falls back to defaultStaleAge for the TTL', async () => {
      const handler = createHandler();
      await handler.set('/static-forever', pagesData, {
        ...baseCtx,
        cacheControl: { revalidate: false, expire: undefined },
      });

      const { ex } = storedEntry('/static-forever');
      expect(ex).toBe(expireAge(DEFAULT_STALE_AGE));
    });

    it('set() prefers cacheControl.expire over revalidate for the Redis TTL', async () => {
      const handler = createHandler();
      await handler.set('/blog/post-swr', pagesData, {
        ...baseCtx,
        cacheControl: { revalidate: 60, expire: 3600 },
      });

      const { ex } = storedEntry('/blog/post-swr');
      expect(ex).toBe(3600);
    });

    it('set() derives the TTL from the legacy ctx.revalidate argument (Next.js 15.0.3)', async () => {
      const handler = createHandler();
      await handler.set('/blog/post-legacy', pagesData, {
        ...baseCtx,
        revalidate: 60,
      });

      const { ex } = storedEntry('/blog/post-legacy');
      expect(ex).toBe(expireAge(60));
    });
  });

  describe('REDIRECT entries (getStaticProps redirect)', () => {
    const redirectData = {
      kind: 'REDIRECT' as const,
      // Next.js nests the redirect directives under `pageProps`, matching the
      // real getStaticProps redirect payload asserted in the integration test.
      props: {
        pageProps: { __N_REDIRECT: '/target', __N_REDIRECT_STATUS: 307 },
      },
    };

    it('set() and get() round-trip a REDIRECT entry without warnings', async () => {
      const handler = createHandler();
      await handler.set('/old-location', redirectData, {
        ...baseCtx,
        cacheControl: { revalidate: 30, expire: undefined },
      });

      const { entry, ex } = storedEntry('/old-location');
      expect(entry).toEqual({
        value: redirectData,
        lastModified: expect.any(Number),
        tags: ['_N_T_/old-location'],
      });
      expect(ex).toBe(expireAge(30));

      const result = await handler.get('/old-location', {
        kind: 'PAGES',
        isFallback: false,
      });
      expect(result?.value).toEqual(redirectData);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('notFound entries (data === null)', () => {
    it('set() stores a null-value entry without throwing or warning', async () => {
      const handler = createHandler();
      await handler.set('/missing-page', null, {
        ...baseCtx,
        cacheControl: { revalidate: 15, expire: undefined },
      });

      const { entry, ex } = storedEntry('/missing-page');
      expect(entry).toEqual({
        value: null,
        lastModified: expect.any(Number),
        tags: ['_N_T_/missing-page'],
      });
      expect(ex).toBe(expireAge(15));
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('get() returns the null-value entry without malformed warnings or errors', async () => {
      const handler = createHandler();
      await handler.set('/missing-page', null, {
        ...baseCtx,
        cacheControl: { revalidate: 15, expire: undefined },
      });

      const result = await handler.get('/missing-page', {
        kind: 'PAGES',
        isFallback: false,
      });

      expect(result).toEqual({
        value: null,
        lastModified: expect.any(Number),
        tags: ['_N_T_/missing-page'],
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('get() still warns for a malformed entry with a missing (undefined) value', async () => {
      const handler = createHandler();
      hoisted.store.set(KEY_PREFIX + '/malformed', {
        value: JSON.stringify({ lastModified: Date.now(), tags: [] }),
      });

      await handler.get('/malformed', {
        kind: 'PAGES',
        isFallback: false,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'RedisStringsHandler.get() called with',
        '/malformed',
        expect.anything(),
        'cacheEntry is mall formed (missing value)',
      );
    });
  });

  describe('App Router entries are unaffected', () => {
    it('set() still extracts tags from the x-next-cache-tags header and adds no implicit tag', async () => {
      const handler = createHandler();
      await handler.set(
        '/app-page',
        {
          kind: 'APP_PAGE',
          html: '<html></html>',
          rscData: Buffer.from('rsc'),
          headers: {
            'x-nextjs-stale-time': '1000',
            'x-next-cache-tags': '_N_T_/layout,_N_T_/app-page',
          },
          segmentData: undefined,
          postboned: undefined,
        },
        { ...baseCtx, cacheControl: { revalidate: 60, expire: undefined } },
      );

      const { entry } = storedEntry('/app-page');
      expect(entry.tags).toEqual(['_N_T_/layout', '_N_T_/app-page']);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('set() still warns for unsupported kinds (e.g. IMAGE)', async () => {
      const handler = createHandler();
      await handler.set(
        '/some-image',
        { kind: 'IMAGE' } as unknown as Parameters<
          RedisStringsHandler['set']
        >[1],
        baseCtx,
      );

      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
