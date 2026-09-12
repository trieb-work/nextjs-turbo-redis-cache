import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fetch from 'node-fetch';
import { createClient, RedisClientType } from 'redis';
import { join } from 'path';
import { readFileSync } from 'fs';
import { CacheEntry } from '../../../src/RedisStringsHandler';

// Select which Pages Router test app to use. Can be overridden via NEXT_PAGES_TEST_APP env var
const NEXT_PAGES_TEST_APP =
  process.env.NEXT_PAGES_TEST_APP || 'next-pages-16-2-6';
const NEXT_APP_DIR = join(
  __dirname,
  '..',
  '..',
  'nextjs-test-projects',
  NEXT_PAGES_TEST_APP,
);
console.log('NEXT_APP_DIR', NEXT_APP_DIR);

// Two instances of the same build sharing one Redis. This mirrors a
// load-balanced multi-instance deployment and is used to prove that
// on-demand revalidation (res.revalidate) on one instance is picked up
// by the other instance.
const INSTANCE_A_PORT = 3061;
const INSTANCE_B_PORT = 3062;
const INSTANCE_A_URL = `http://localhost:${INSTANCE_A_PORT}`;
const INSTANCE_B_URL = `http://localhost:${INSTANCE_B_PORT}`;

const REDIS_BACKGROUND_SYNC_DELAY = 250; //ms delay to prevent flaky tests in slow CI environments

// Default inMemoryCachingTime of the handler is 10s. After a get(), an
// instance may serve the entry from its in-memory deduplication cache for up
// to this long, so cross-instance freshness tests wait it out first.
const IN_MEMORY_CACHE_EXPIRY_DELAY = 11_000;

// revalidate value of /isr/[slug] in the test app
const ISR_REVALIDATE_SECONDS = 300;
// default stale age of the cache handler (14 days)
const DEFAULT_STALE_AGE = 60 * 60 * 24 * 14;

let instanceA: ChildProcessWithoutNullStreams;
let instanceB: ChildProcessWithoutNullStreams;
let redisClient: RedisClientType;
let buildId: string;

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectIsrRedisTtl(ttl: number) {
  // Next.js 16.3+ passes cacheControl.expire (~1 year) for ISR pages.
  // Redis TTL is keyed on expire, not 2 × revalidate.
  if (NEXT_PAGES_TEST_APP.includes('16-3')) {
    expect(ttl).toBeGreaterThan(2 * ISR_REVALIDATE_SECONDS);
    return;
  }
  // VERCEL_ENV=production -> expire age is 2 * revalidate
  expect(ttl).toBeGreaterThan(2 * ISR_REVALIDATE_SECONDS - 30);
  expect(ttl).toBeLessThanOrEqual(2 * ISR_REVALIDATE_SECONDS);
}

async function runCommand(cmd: string, args: string[], cwd: string) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    const proc = spawn(cmd, args, { cwd, stdio: 'pipe' });

    proc.stdout.on('data', (data) => {
      if (process.env.DEBUG_INTEGRATION) {
        console.log(data.toString());
      }
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      if (process.env.DEBUG_INTEGRATION) {
        console.error(data.toString());
      }
      stderr += data.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) resolve(undefined);
      else {
        reject(
          new Error(
            `${cmd} ${args.join(' ')} failed with code ${code}\n` +
              `stdout: ${stdout}\n` +
              `stderr: ${stderr}`,
          ),
        );
      }
    });
  });
}

function startInstance(port: number): ChildProcessWithoutNullStreams {
  const proc = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: NEXT_APP_DIR,
    env: {
      ...process.env,
    },
    stdio: 'pipe',
  });
  if (process.env.DEBUG_INTEGRATION) {
    proc.stdout.on('data', (data) => {
      console.log(`stdout(:${port}): ${data}`);
    });
  }
  proc.stderr.on('data', (data) => {
    console.error(`stderr(:${port}): ${data}`);
  });
  return proc;
}

async function waitForServer(url: string, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Next.js server at ${url} did not start in time`);
}

function extractTimestamp(html: string): number {
  const match = html.match(/Timestamp: (?:<!-- -->)?(\d+)/)?.[1];
  expect(match).toBeDefined();
  return Number(match);
}

function extractCounter(html: string): number {
  const match = html.match(/Counter: (?:<!-- -->)?(\d+)/)?.[1];
  expect(match).toBeDefined();
  return Number(match);
}

describe('Pages Router Redis cache integration (two instances)', () => {
  beforeAll(async () => {
    // If old servers from a previous run are still around, kill them
    for (const port of [INSTANCE_A_PORT, INSTANCE_B_PORT]) {
      try {
        const res = await fetch(`http://localhost:${port}`);
        if (res.ok) {
          await runCommand('pkill', ['-f', `next start -p ${port}`], '.');
        }
      } catch {}
    }

    // Set up environment variables
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_URL =
      'pages-integration-test-' + Math.random().toString(36).substring(2, 15);
    console.log('redis key prefix is:', process.env.VERCEL_URL);

    // Only override redis env vars if not set. This can be set in the CI env.
    process.env.REDISHOST = process.env.REDISHOST || 'localhost';
    process.env.REDISPORT = process.env.REDISPORT || '6379';

    if (process.env.SKIP_BUILD === 'true') {
      console.log('skipping build');
    } else {
      await runCommand('pnpm', ['i'], NEXT_APP_DIR);
      console.log('pnpm i done');
      await runCommand('pnpm', ['build'], NEXT_APP_DIR);
      console.log('pnpm build done');
    }

    buildId = readFileSync(join(NEXT_APP_DIR, '.next', 'BUILD_ID'), 'utf-8')
      .toString()
      .trim();

    // Start two Next.js instances of the same build sharing one Redis
    instanceA = startInstance(INSTANCE_A_PORT);
    instanceB = startInstance(INSTANCE_B_PORT);
    await Promise.all([
      waitForServer(INSTANCE_A_URL),
      waitForServer(INSTANCE_B_URL),
    ]);
    console.log('both next instances started');

    // Connect to Redis
    redisClient = createClient({
      url: `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`,
    });
    await redisClient.connect();
  }, 240_000);

  afterAll(async () => {
    if (process.env.KEEP_SERVER_RUNNING === 'true') {
      console.log('keeping servers running');
    } else {
      if (instanceA) instanceA.kill();
      if (instanceB) instanceB.kill();
    }
    if (redisClient) await redisClient.quit();
  });

  describe('PAGES entries (getStaticProps + revalidate)', () => {
    let firstTimestamp: number;
    let firstCounter: number;

    it('first request on instance A renders the page and stores a PAGES entry in Redis', async () => {
      const res = await fetch(INSTANCE_A_URL + '/isr/prebuilt');
      expect(res.status).toBe(200);
      const html = await res.text();
      firstTimestamp = extractTimestamp(html);
      firstCounter = extractCounter(html);

      await delay(REDIS_BACKGROUND_SYNC_DELAY);

      const value = (await redisClient.get(
        process.env.VERCEL_URL + '/isr/prebuilt',
      )) as string;
      expect(value).toBeDefined();
      const cacheEntry: CacheEntry = JSON.parse(value);
      expect(cacheEntry).toMatchObject({
        value: {
          kind: 'PAGES',
          html: expect.any(String),
          pageData: {
            pageProps: expect.objectContaining({
              slug: 'prebuilt',
              timestamp: firstTimestamp,
            }),
          },
        },
        lastModified: expect.any(Number),
        tags: ['_N_T_/isr/prebuilt'],
      });

      // The implicit path tag is registered in the shared tags hashmap so
      // that revalidatePath()/revalidateTag() can invalidate the page
      const hashmap = (await redisClient.hGet(
        process.env.VERCEL_URL + '__sharedTags__',
        '/isr/prebuilt',
      )) as string;
      expect(JSON.parse(hashmap)).toEqual(['_N_T_/isr/prebuilt']);
    });

    it('the TTL is derived from the getStaticProps revalidate value', async () => {
      const ttl = await redisClient.ttl(
        process.env.VERCEL_URL + '/isr/prebuilt',
      );
      expectIsrRedisTtl(ttl);
    });

    it('instance B serves the identical cached HTML from the shared Redis', async () => {
      const res = await fetch(INSTANCE_B_URL + '/isr/prebuilt');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(extractTimestamp(html)).toBe(firstTimestamp);
      expect(extractCounter(html)).toBe(firstCounter);
    });

    it('the pageData JSON (client navigation) is served from the same entry', async () => {
      const res = await fetch(
        `${INSTANCE_B_URL}/_next/data/${buildId}/isr/prebuilt.json`,
      );
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.pageProps.slug).toBe('prebuilt');
      expect(data.pageProps.timestamp).toBe(firstTimestamp);
    });

    describe('two-instance on-demand revalidation (res.revalidate)', () => {
      it('res.revalidate on instance A updates Redis and instance B serves the fresh HTML and pageData', async () => {
        // Wait until instance B's in-memory deduplication cache entry for
        // the page has expired, so its next get() hits Redis again
        await delay(IN_MEMORY_CACHE_EXPIRY_DELAY);

        const revalidateRes = await fetch(
          INSTANCE_A_URL + '/api/revalidate?path=/isr/prebuilt',
        );
        const revalidateJson: any = await revalidateRes.json();
        expect(revalidateJson).toEqual({
          revalidated: true,
          path: '/isr/prebuilt',
        });

        await delay(REDIS_BACKGROUND_SYNC_DELAY);

        // Instance B must serve the fresh HTML rendered by instance A
        const resB = await fetch(INSTANCE_B_URL + '/isr/prebuilt');
        expect(resB.status).toBe(200);
        const htmlB = await resB.text();
        const timestampB = extractTimestamp(htmlB);
        const counterB = extractCounter(htmlB);
        expect(timestampB).toBeGreaterThan(firstTimestamp);

        // Instance A serves the same regenerated page - both instances
        // return the exact same render, proving it came through Redis and
        // not from an independent re-render per instance
        const resA = await fetch(INSTANCE_A_URL + '/isr/prebuilt');
        const htmlA = await resA.text();
        expect(extractTimestamp(htmlA)).toBe(timestampB);
        expect(extractCounter(htmlA)).toBe(counterB);

        // The updated pageData JSON for client-side navigation is also
        // served fresh on instance B
        const dataRes = await fetch(
          `${INSTANCE_B_URL}/_next/data/${buildId}/isr/prebuilt.json`,
        );
        expect(dataRes.status).toBe(200);
        const data: any = await dataRes.json();
        expect(data.pageProps.timestamp).toBe(timestampB);
      }, 30_000);
    });
  });

  describe('fallback: "blocking" (page not prerendered at build time)', () => {
    it('first hit renders the page (blocking) and stores it in Redis', async () => {
      const res = await fetch(INSTANCE_A_URL + '/isr/fallback-test');
      expect(res.status).toBe(200);
      const html = await res.text();
      const timestamp = extractTimestamp(html);

      await delay(REDIS_BACKGROUND_SYNC_DELAY);

      const value = (await redisClient.get(
        process.env.VERCEL_URL + '/isr/fallback-test',
      )) as string;
      expect(value).toBeDefined();
      const cacheEntry: CacheEntry = JSON.parse(value);
      expect((cacheEntry.value as { kind: string }).kind).toBe('PAGES');

      // The other instance serves the same render from Redis
      const resB = await fetch(INSTANCE_B_URL + '/isr/fallback-test');
      expect(resB.status).toBe(200);
      expect(extractTimestamp(await resB.text())).toBe(timestamp);
    });
  });

  describe('notFound: true (null cache entry)', () => {
    it('renders a 404 and stores a null-value entry in Redis', async () => {
      const res = await fetch(INSTANCE_A_URL + '/isr/not-found');
      expect(res.status).toBe(404);

      await delay(REDIS_BACKGROUND_SYNC_DELAY);

      const value = (await redisClient.get(
        process.env.VERCEL_URL + '/isr/not-found',
      )) as string;
      expect(value).toBeDefined();
      const cacheEntry: CacheEntry = JSON.parse(value);
      expect(cacheEntry).toEqual({
        value: null,
        lastModified: expect.any(Number),
        tags: ['_N_T_/isr/not-found'],
      });

      // TTL: Next.js 16.3+ keys on cacheControl.expire (SWR-safe); older
      // versions use estimateExpireAge(revalidate).
      const ttl = await redisClient.ttl(
        process.env.VERCEL_URL + '/isr/not-found',
      );
      expectIsrRedisTtl(ttl);
    });

    it('instance B serves the 404 from the shared cache', async () => {
      const res = await fetch(INSTANCE_B_URL + '/isr/not-found');
      expect(res.status).toBe(404);
    });
  });

  describe('redirect (getStaticProps redirect return)', () => {
    it('responds with a redirect and stores a REDIRECT entry in Redis', async () => {
      const res = await fetch(INSTANCE_A_URL + '/isr/redirect', {
        redirect: 'manual',
      });
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/static-forever');

      await delay(REDIS_BACKGROUND_SYNC_DELAY);

      const value = (await redisClient.get(
        process.env.VERCEL_URL + '/isr/redirect',
      )) as string;
      expect(value).toBeDefined();
      const cacheEntry: CacheEntry = JSON.parse(value);
      expect(cacheEntry).toMatchObject({
        value: {
          kind: 'REDIRECT',
          props: expect.objectContaining({
            pageProps: expect.objectContaining({
              __N_REDIRECT: '/static-forever',
              __N_REDIRECT_STATUS: 307,
            }),
          }),
        },
        lastModified: expect.any(Number),
        tags: ['_N_T_/isr/redirect'],
      });
    });

    it('instance B serves the redirect from the shared cache', async () => {
      const res = await fetch(INSTANCE_B_URL + '/isr/redirect', {
        redirect: 'manual',
      });
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/static-forever');
    });
  });

  describe('revalidate: false (fully static page)', () => {
    it('falls back to the defaultStaleAge based TTL', async () => {
      const res = await fetch(INSTANCE_A_URL + '/static-forever');
      expect(res.status).toBe(200);

      await delay(REDIS_BACKGROUND_SYNC_DELAY);

      const value = (await redisClient.get(
        process.env.VERCEL_URL + '/static-forever',
      )) as string;
      expect(value).toBeDefined();
      const cacheEntry: CacheEntry = JSON.parse(value);
      expect((cacheEntry.value as { kind: string }).kind).toBe('PAGES');

      const ttl = await redisClient.ttl(
        process.env.VERCEL_URL + '/static-forever',
      );
      // VERCEL_ENV=production -> expire age is 2 * defaultStaleAge (14 days)
      expect(ttl).toBeGreaterThan(2 * DEFAULT_STALE_AGE - 30);
      expect(ttl).toBeLessThanOrEqual(2 * DEFAULT_STALE_AGE);
    });
  });
});
