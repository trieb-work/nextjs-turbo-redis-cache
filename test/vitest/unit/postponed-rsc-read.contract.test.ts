/**
 * Regression contract for #102: RedisStringsHandler.get() must match Next.js
 * FileSystemCache read semantics for postponed / fallback APP_PAGE entries.
 *
 * Covered Next.js versions: Next 16.1, 16.2 and 16.3 contain an identical
 * `rscData` read condition — FileSystemCache omits rscData on read for fallback
 * and postponed PPR reads:
 *
 *   !ctx.isFallback && (!ctx.isRoutePPREnabled || meta?.postponed == null)
 *
 * Older releases (15.0.3 - 16.0.x) use a different code path: they never read
 * the full `.rsc` file for PPR reads, resolving rscData from a separate
 * `.rsc.prefetch` file instead and omitting it only for fallback reads. No
 * version in the supported range serves a postponed PPR entry's full `.rsc`
 * payload through rscData, so the normalized read is aligned with every
 * supported release; the contract is pinned against the newest 16.x line
 * (16.3.0 fixture), which is representative of the 16.1-16.3 behavior.
 *
 * A second suite pins the `cacheControl` that get() returns against the
 * Next.js 16.4 FileSystemCache (16.4.2 fixture).
 *
 * The FileSystemCache-backed suites need the separately managed fixture apps
 * (not installed by the root `pnpm install`):
 *
 *   cd test/nextjs-test-projects/next-app-16-3-0 && pnpm install
 *   cd test/nextjs-test-projects/next-app-16-4-2 && pnpm install
 *
 * When a fixture is absent its suite is skipped — the rest of the unit suite
 * must keep running on a fresh checkout. CI installs the fixtures before
 * `pnpm test:unit:coverage`, so the contracts always run there.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RedisStringsHandler from '../../../src/RedisStringsHandler';

type FileSystemCacheInstance = {
  get(
    key: string,
    ctx: {
      kind: 'APP_PAGE' | 'APP_ROUTE';
      isFallback: boolean;
      isRoutePPREnabled: boolean;
    },
  ): Promise<{
    value: Record<string, unknown>;
    cacheControl?: unknown;
  } | null>;
  set(key: string, data: unknown, ctx: Record<string, unknown>): Promise<void>;
};

function fixtureInstallHint(app: string) {
  return (
    `Next.js contract fixture is not installed (${app}). ` +
    `Run: cd test/nextjs-test-projects/${app} && pnpm install`
  );
}

// Returns null instead of throwing so a missing fixture only skips the
// FileSystemCache-backed suite that needs it and never aborts the unit suite.
function resolveNextFixture(app: string, versionPrefix: string) {
  const nextPkgJson = path.join(
    __dirname,
    '../../nextjs-test-projects',
    app,
    'node_modules/next/package.json',
  );
  if (!fsSync.existsSync(nextPkgJson)) {
    return null;
  }
  const { version } = JSON.parse(fsSync.readFileSync(nextPkgJson, 'utf8')) as {
    version: string;
  };
  if (!version.startsWith(versionPrefix)) {
    console.warn(
      `Next.js contract fixture must provide ${versionPrefix}x (got ${version} at ` +
        `${nextPkgJson}); skipping the FileSystemCache contract suite.`,
    );
    return null;
  }
  const requireNext = createRequire(nextPkgJson);
  const FileSystemCache = requireNext(
    'next/dist/server/lib/incremental-cache/file-system-cache',
  ).default as new (ctx: {
    fs: typeof fs;
    serverDistDir: string;
    maxMemoryCacheSize: number;
    flushToDisk: boolean;
    revalidatedTags: string[];
  }) => FileSystemCacheInstance;
  const { RSC_SEGMENTS_DIR_SUFFIX, RSC_SEGMENT_SUFFIX, NEXT_META_SUFFIX } =
    requireNext('next/dist/lib/constants') as {
      RSC_SEGMENTS_DIR_SUFFIX: string;
      RSC_SEGMENT_SUFFIX: string;
      NEXT_META_SUFFIX: string;
    };
  // FileSystemCache.set() needs Next's fs wrapper (recursive mkdir).
  const { nodeFs } = requireNext('next/dist/server/lib/node-fs-methods') as {
    nodeFs: typeof fs;
  };
  return {
    FileSystemCache,
    nodeFs,
    RSC_SEGMENTS_DIR_SUFFIX,
    RSC_SEGMENT_SUFFIX,
    NEXT_META_SUFFIX,
  };
}

const nextFixture = resolveNextFixture('next-app-16-3-0', '16.3.');
const next164Fixture = resolveNextFixture('next-app-16-4-2', '16.4.');

const hoisted = vi.hoisted(() => {
  const store = new Map<string, { value: string; ex?: number }>();
  return { store };
});

vi.mock('redis', () => {
  const createClient = () => ({
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
  });
  return {
    createClient,
    commandOptions: vi.fn((opts) => opts),
  };
});

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

const KEY_PREFIX = 'rsc-contract:';

type Case = {
  name: string;
  ppr: boolean;
  fallback: boolean;
  postponed?: string | null;
};

const cases: Case[] = [
  {
    name: 'postponed PPR',
    ppr: true,
    fallback: false,
    postponed: 'resume-state',
  },
  {
    name: 'empty postponed state',
    ppr: true,
    fallback: false,
    postponed: '',
  },
  {
    name: 'PPR fallback',
    ppr: true,
    fallback: true,
    postponed: 'resume-state',
  },
  { name: 'fallback without postponed state', ppr: true, fallback: true },
  { name: 'legacy fallback', ppr: false, fallback: true },
  { name: 'complete PPR', ppr: true, fallback: false },
  {
    name: 'complete PPR with null state',
    ppr: true,
    fallback: false,
    postponed: null,
  },
  { name: 'complete non-PPR', ppr: false, fallback: false },
  {
    name: 'postponed meta but PPR off on read',
    ppr: false,
    fallback: false,
    postponed: 'resume-state',
  },
];

describe.runIf(!nextFixture)('Next.js 16.3 contract fixture absent', () => {
  it.skip(fixtureInstallHint('next-app-16-3-0'), () => undefined);
});

describe.runIf(!!nextFixture)(
  'APP_PAGE get() matches Next FileSystemCache (#102)',
  () => {
    let fixtureRoot: string;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      hoisted.store.clear();
      fixtureRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'nextjs-turbo-rsc-contract-'),
      );
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(async () => {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it.each(cases)('$name', async (testCase) => {
      const {
        FileSystemCache,
        RSC_SEGMENTS_DIR_SUFFIX,
        RSC_SEGMENT_SUFFIX,
        NEXT_META_SUFFIX,
      } = nextFixture!;
      const key = `/page-${testCase.name.replace(/\s+/g, '-')}`;
      const rscData = Buffer.from('0:{"event":"updated"}\n');
      const segmentBuf = Buffer.from('prefetch tree');
      const value = {
        kind: 'APP_PAGE' as const,
        html: '<h1>Cached event</h1>',
        rscData,
        postponed: testCase.postponed,
        segmentData: new Map([['/_tree', segmentBuf]]),
        headers: {
          'x-next-cache-tags': 'rsc-regression',
          'x-nextjs-stale-time': '300',
        },
        status: 200,
      };

      const base = path.join(fixtureRoot, 'server/app', key.slice(1));
      await fs.mkdir(base + RSC_SEGMENTS_DIR_SUFFIX, { recursive: true });
      await fs.writeFile(base + '.html', value.html);
      await fs.writeFile(base + '.rsc', rscData);
      await fs.writeFile(
        base + NEXT_META_SUFFIX,
        JSON.stringify({
          headers: value.headers,
          status: value.status,
          postponed: value.postponed,
          segmentPaths: ['/_tree'],
        }),
      );
      await fs.writeFile(
        base + RSC_SEGMENTS_DIR_SUFFIX + '/_tree' + RSC_SEGMENT_SUFFIX,
        segmentBuf,
      );

      const context = {
        kind: 'APP_PAGE' as const,
        isFallback: testCase.fallback,
        isRoutePPREnabled: testCase.ppr,
      };

      const disk = new FileSystemCache({
        fs,
        serverDistDir: path.join(fixtureRoot, 'server'),
        maxMemoryCacheSize: 0,
        flushToDisk: true,
        revalidatedTags: [],
      });

      const redis = new RedisStringsHandler({
        redisUrl: 'redis://127.0.0.1:6379',
        keyPrefix: KEY_PREFIX,
        database: 0,
        getTimeoutMs: 500,
        redisGetDeduplication: false,
        inMemoryCachingTime: 0,
      });

      await redis.set(key, value, {
        ...context,
        cacheControl: { revalidate: 3600 },
      });

      const expected = await disk.get(key, context);
      const actual = await redis.get(key, context);

      expect(expected).toBeTruthy();
      expect(actual).toBeTruthy();

      for (const field of [
        'rscData',
        'html',
        'postponed',
        'segmentData',
        'headers',
        'status',
      ] as const) {
        expect(actual!.value[field], `${testCase.name}: ${field}`).toEqual(
          expected!.value[field],
        );
      }

      const complete = await redis.get(key, {
        kind: 'APP_PAGE',
        isFallback: false,
        isRoutePPREnabled: false,
      });
      expect(
        complete?.value.rscData,
        `${testCase.name}: preserve stored Flight data`,
      ).toEqual(rscData);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  },
);

describe('APP_PAGE get() edge cases (#102)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hoisted.store.clear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createHandler(inMemoryCachingTime = 0) {
    return new RedisStringsHandler({
      redisUrl: 'redis://127.0.0.1:6379',
      keyPrefix: KEY_PREFIX,
      database: 0,
      getTimeoutMs: 500,
      redisGetDeduplication: inMemoryCachingTime > 0,
      inMemoryCachingTime,
    });
  }

  it('strips rscData when only legacy postboned is set on a PPR read', async () => {
    const key = '/legacy-postboned';
    const rscData = Buffer.from('partial-flight');
    const handler = createHandler();

    await handler.set(
      key,
      {
        kind: 'APP_PAGE',
        html: '<p>x</p>',
        rscData,
        postboned: 'resume-state',
        segmentData: undefined,
        headers: {
          'x-next-cache-tags': 't',
          'x-nextjs-stale-time': '1',
        },
      } as Parameters<RedisStringsHandler['set']>[1],
      {
        kind: 'APP_PAGE',
        isRoutePPREnabled: true,
        isFallback: false,
        cacheControl: { revalidate: 60 },
      },
    );

    const entry = await handler.get(key, {
      kind: 'APP_PAGE',
      isRoutePPREnabled: true,
      isFallback: false,
    });

    expect(entry?.value.rscData).toBeUndefined();
    expect((entry?.value as { postboned?: unknown }).postboned).toBe(
      'resume-state',
    );

    const complete = await handler.get(key, {
      kind: 'APP_PAGE',
      isRoutePPREnabled: false,
      isFallback: false,
    });
    expect(complete?.value.rscData).toEqual(rscData);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('applies rscData stripping on every get including deduplicated reads', async () => {
    const key = '/dedup-postponed';
    const rscData = Buffer.from('partial-flight');
    const handler = createHandler(5000);

    await handler.set(
      key,
      {
        kind: 'APP_PAGE',
        html: '<p>x</p>',
        rscData,
        postponed: 'resume',
        segmentData: undefined,
        headers: {
          'x-next-cache-tags': 't',
          'x-nextjs-stale-time': '1',
        },
      },
      {
        kind: 'APP_PAGE',
        isRoutePPREnabled: true,
        isFallback: false,
        cacheControl: { revalidate: 60 },
      },
    );

    const ctx = {
      kind: 'APP_PAGE' as const,
      isRoutePPREnabled: true,
      isFallback: false,
    };

    const first = await handler.get(key, ctx);
    const second = await handler.get(key, ctx);

    expect(first?.value.rscData).toBeUndefined();
    expect(second?.value.rscData).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not strip rscData for non-APP_PAGE kinds', async () => {
    const handler = createHandler();
    const body = Buffer.from('route-body');

    await handler.set(
      '/api',
      {
        kind: 'APP_ROUTE',
        status: 200,
        body,
        headers: {
          'x-next-cache-tags': 'api',
          'x-nextjs-stale-time': '1',
        },
      },
      {
        kind: 'APP_ROUTE',
        isRoutePPREnabled: true,
        isFallback: true,
        cacheControl: { revalidate: 60 },
      },
    );

    const entry = await handler.get('/api', {
      kind: 'APP_ROUTE',
      isRoutePPREnabled: true,
      isFallback: true,
    });

    expect(entry?.value.body).toEqual(body);
  });
});

// Next.js 16.4 FileSystemCache stores ctx.cacheControl on set() and returns it
// from get() for APP_PAGE and APP_ROUTE entries, so IncrementalCache applies
// the stored lifetime on every instance. Its disk store does not keep it for
// PAGES and FETCH entries (the Pages Router integration test covers PAGES).
const cacheControlCases = [
  {
    name: 'APP_PAGE with revalidate and expire',
    kind: 'APP_PAGE' as const,
    cacheControl: { revalidate: 300, expire: 31536000 },
  },
  {
    name: 'APP_PAGE with revalidate false',
    kind: 'APP_PAGE' as const,
    cacheControl: { revalidate: false as const, expire: undefined },
  },
  {
    name: 'APP_ROUTE with revalidate and expire',
    kind: 'APP_ROUTE' as const,
    cacheControl: { revalidate: 60, expire: 3600 },
  },
  {
    name: 'APP_ROUTE without cacheControl',
    kind: 'APP_ROUTE' as const,
    cacheControl: undefined,
  },
];

describe.runIf(!next164Fixture)('Next.js 16.4 contract fixture absent', () => {
  it.skip(fixtureInstallHint('next-app-16-4-2'), () => undefined);
});

describe.runIf(!!next164Fixture)(
  'get() returns the cacheControl like Next 16.4 FileSystemCache',
  () => {
    let fixtureRoot: string;

    beforeEach(async () => {
      hoisted.store.clear();
      fixtureRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'nextjs-turbo-cache-control-contract-'),
      );
    });

    afterEach(async () => {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    });

    it.each(cacheControlCases)('$name', async (testCase) => {
      const key = `/cache-control-${testCase.name.replace(/\s+/g, '-')}`;
      const headers = {
        'x-next-cache-tags': 'cache-control-contract',
        'x-nextjs-stale-time': '300',
      };
      const value =
        testCase.kind === 'APP_PAGE'
          ? {
              kind: 'APP_PAGE' as const,
              html: '<h1>Cached</h1>',
              rscData: Buffer.from('0:{}\n'),
              postponed: undefined,
              segmentData: undefined,
              headers,
              status: 200,
            }
          : {
              kind: 'APP_ROUTE' as const,
              body: Buffer.from('{}'),
              headers,
              status: 200,
            };
      const context = {
        kind: testCase.kind,
        isFallback: false,
        isRoutePPREnabled: false,
      };

      const disk = new next164Fixture!.FileSystemCache({
        fs: next164Fixture!.nodeFs,
        serverDistDir: path.join(fixtureRoot, 'server'),
        maxMemoryCacheSize: 0,
        flushToDisk: true,
        revalidatedTags: [],
      });
      const redis = new RedisStringsHandler({
        redisUrl: 'redis://127.0.0.1:6379',
        keyPrefix: KEY_PREFIX,
        database: 0,
        getTimeoutMs: 500,
        redisGetDeduplication: false,
        inMemoryCachingTime: 0,
      });

      const setContext = { ...context, cacheControl: testCase.cacheControl };
      await disk.set(key, value, setContext);
      await redis.set(key, value, setContext);

      const expected = await disk.get(key, context);
      const actual = await redis.get(key, context);

      expect(expected).toBeTruthy();
      expect(actual?.cacheControl).toEqual(expected!.cacheControl);
    });
  },
);
