/**
 * Regression contract for #102: RedisStringsHandler.get() must match Next.js
 * FileSystemCache read semantics for postponed / fallback APP_PAGE entries.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RedisStringsHandler from '../../../src/RedisStringsHandler';

const nextPkgRoot = path.join(
  __dirname,
  '../../nextjs-test-projects/next-app-16-3-0/node_modules/next',
);
const requireNext = createRequire(path.join(nextPkgRoot, 'package.json'));
const FileSystemCache = requireNext(
  'next/dist/server/lib/incremental-cache/file-system-cache',
).default as new (ctx: {
  fs: typeof fs;
  serverDistDir: string;
  maxMemoryCacheSize: number;
  flushToDisk: boolean;
  revalidatedTags: string[];
}) => {
  get(
    key: string,
    ctx: {
      kind: 'APP_PAGE';
      isFallback: boolean;
      isRoutePPREnabled: boolean;
    },
  ): Promise<{
    value: Record<string, unknown>;
  } | null>;
};
const { RSC_SEGMENTS_DIR_SUFFIX, RSC_SEGMENT_SUFFIX, NEXT_META_SUFFIX } =
  requireNext('next/dist/lib/constants') as {
    RSC_SEGMENTS_DIR_SUFFIX: string;
    RSC_SEGMENT_SUFFIX: string;
    NEXT_META_SUFFIX: string;
  };

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

describe('APP_PAGE get() matches Next FileSystemCache (#102)', () => {
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
});

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
