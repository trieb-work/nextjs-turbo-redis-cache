import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { createClient, RedisClientType } from 'redis';
import path from 'path';

const PORT = Number(process.env.CACHE_COMPONENTS_PORT || '3065');
const BASE_URL = `http://localhost:${PORT}`;

describe('Next.js 16 Cache Components Integration', () => {
  let nextProcess: ChildProcess;
  let redisClient: RedisClientType;
  let keyPrefix: string;

  async function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForRedisKeys(
    pattern: string,
    minCount = 1,
    timeoutMs = 10_000,
  ) {
    for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
      const keys = await redisClient.keys(pattern);
      if (keys.length >= minCount) {
        return keys;
      }
      await delay(100);
    }
    return redisClient.keys(pattern);
  }

  beforeAll(async () => {
    // Connect to Redis
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      database: 1,
    });
    await redisClient.connect();

    // Generate unique key prefix for this test run
    keyPrefix = `cache-components-test-${Math.random().toString(36).substring(7)}`;
    process.env.VERCEL_URL = keyPrefix;

    const cacheComponentsApp =
      process.env.CACHE_COMPONENTS_APP || 'next-app-16-2-6-cache-components';

    const appDir = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'nextjs-test-projects',
      cacheComponentsApp,
    );

    console.log('Installing Next.js app dependencies...');
    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn('pnpm', ['install'], {
        cwd: appDir,
        stdio: 'inherit',
      });

      installProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Install failed with code ${code}`));
      });
    });

    console.log('Building Next.js app...');
    await new Promise<void>((resolve, reject) => {
      const buildProcess = spawn('pnpm', ['build'], {
        cwd: appDir,
        stdio: 'inherit',
      });

      buildProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Build failed with code ${code}`));
      });
    });

    console.log('Starting Next.js app...');
    nextProcess = spawn('pnpm', ['start', '-p', PORT.toString()], {
      cwd: appDir,
      env: { ...process.env, VERCEL_URL: keyPrefix },
    });

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }, 120000);

  afterAll(async () => {
    // Clean up Redis keys
    const keys = await redisClient.keys(`${keyPrefix}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    await redisClient.quit();

    // Kill Next.js process
    if (nextProcess) {
      nextProcess.kill();
    }
  });

  describe('Basic use cache functionality', () => {
    it('should cache data and return same counter value on subsequent requests', async () => {
      // First request
      const res1 = await fetch(`${BASE_URL}/api/cached-static-fetch`);
      const data1 = await res1.json();

      expect(data1.counter).toBe(1);

      // Second request should return cached data
      const res2 = await fetch(`${BASE_URL}/api/cached-static-fetch`);
      const data2 = await res2.json();

      expect(data2.counter).toBe(1); // Same counter value
      expect(data2.timestamp).toBe(data1.timestamp); // Same timestamp
    });

    it('should store cache entry in Redis', async () => {
      // expire-matrix is dynamic (`ƒ`); static prerendered `use cache` routes may
      // not write through to Redis at runtime on some Next.js versions.
      await fetch(`${BASE_URL}/api/expire-matrix?id=redis-smoke`);

      const keys = await waitForRedisKeys(`${keyPrefix}*`);
      expect(keys.length).toBeGreaterThan(0);
    }, 15_000);
  });

  describe('cacheTag functionality', () => {
    it('should cache data with tags', async () => {
      const res1 = await fetch(`${BASE_URL}/api/cached-with-tag`);
      const data1 = await res1.json();

      expect(data1.counter).toBeDefined();

      // Second request should return cached data
      const res2 = await fetch(`${BASE_URL}/api/cached-with-tag`);
      const data2 = await res2.json();

      expect(data2.counter).toBe(data1.counter);
    });

    it('should invalidate cache when tag is revalidated', async () => {
      const id = `tag-invalidation-${Date.now()}`;
      const matrixUrl = `${BASE_URL}/api/expire-matrix?id=${encodeURIComponent(id)}`;

      const data1 = await (await fetch(matrixUrl)).json();
      const data2 = await (await fetch(matrixUrl)).json();
      expect(data2.counter).toBe(data1.counter);

      const revalidateRes = await fetch(
        `${BASE_URL}/api/expire-matrix/revalidate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tag: `expire-matrix-${id}`,
            profile: { expire: 0 },
          }),
        },
      );
      expect(revalidateRes.status).toBe(200);

      const after = await (await fetch(matrixUrl)).json();
      expect(after.counter).toBeGreaterThan(data1.counter);
    });
  });

  describe('cacheLife functionality', () => {
    it('should respect expire window and eventually return refreshed data', async () => {
      const res1 = await fetch(`${BASE_URL}/api/cached-with-cachelife`);
      const data1 = await res1.json();

      const res2 = await fetch(`${BASE_URL}/api/cached-with-cachelife`);
      const data2 = await res2.json();
      expect(data2.counter).toBe(data1.counter);
      expect(data2.timestamp).toBe(data1.timestamp);

      await delay(6500);

      let refreshedData: any;
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${BASE_URL}/api/cached-with-cachelife`);
        const data = await res.json();

        if (
          data.counter !== data1.counter ||
          data.timestamp !== data1.timestamp
        ) {
          refreshedData = data;
          break;
        }

        await delay(500);
      }

      expect(refreshedData).toBeDefined();
      expect(refreshedData.counter).toBeGreaterThan(data1.counter);
      expect(refreshedData.timestamp).not.toBe(data1.timestamp);
    }, 20_000);
  });

  describe('revalidateTag expire settings (next start)', () => {
    // Expire seconds from next/dist/server/config-shared.js cacheLife presets
    // (identical in Next.js 16.0.11, 16.2.6, 16.3.0). `default.expire` is
    // INFINITE_CACHE = 0xfffffffe.
    const CACHE_LIFE_EXPIRE_SECONDS = {
      default: 0xfffffffe,
      seconds: 60,
      minutes: 60 * 60,
      hours: 60 * 60 * 24,
      days: 60 * 60 * 24 * 7,
      weeks: 60 * 60 * 24 * 30,
      max: 60 * 60 * 24 * 365,
    } as const;

    async function getMatrix(id: string) {
      const res = await fetch(
        `${BASE_URL}/api/expire-matrix?id=${encodeURIComponent(id)}`,
      );
      expect(res.status).toBe(200);
      return res.json() as Promise<{
        counter: number;
        timestamp: number;
        id: string;
      }>;
    }

    async function revalidateMatrix(
      id: string,
      profile: string | { expire: number } | null,
    ) {
      const tag = `expire-matrix-${id}`;
      const body = profile === null ? { tag, profile: null } : { tag, profile };
      const res = await fetch(`${BASE_URL}/api/expire-matrix/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return res.json() as Promise<{ timestamp: number }>;
    }

    async function readTagManifest(tag: string) {
      const hashKey = `${keyPrefix}__cacheComponents_revalidated_tags__`;
      for (let elapsed = 0; elapsed < 5_000; elapsed += 50) {
        const raw = await redisClient.hGet(hashKey, tag);
        if (raw) {
          return JSON.parse(raw) as { stale?: number; expired?: number };
        }
        await delay(50);
      }
      throw new Error(`tag manifest missing for ${tag} in ${hashKey}`);
    }

    function expectApproxMs(actual: number | undefined, expected: number) {
      expect(actual, `expected ~${expected}, got ${actual}`).toBeDefined();
      expect(Math.abs(actual! - expected)).toBeLessThan(5_000);
    }

    it.each(Object.entries(CACHE_LIFE_EXPIRE_SECONDS) as [string, number][])(
      'revalidateTag(tag, %s) marks stale now and expired=now+expire*1000, then SWR',
      async (profile, expireSeconds) => {
        const id = `profile-${profile}`;
        await getMatrix(id);
        const before = await getMatrix(id);

        const startedAt = Date.now();
        await revalidateMatrix(id, profile);
        const manifest = await readTagManifest(`expire-matrix-${id}`);

        expectApproxMs(manifest.stale, startedAt);
        expectApproxMs(manifest.expired, startedAt + expireSeconds * 1000);

        const after = await getMatrix(id);
        expect(after.counter).toBe(before.counter);
        expect(after.timestamp).toBe(before.timestamp);
      },
    );

    it('{ expire: 5 } uses the object expire, not a named profile', async () => {
      const id = 'object-expire-5';
      await getMatrix(id);
      const before = await getMatrix(id);

      const startedAt = Date.now();
      await revalidateMatrix(id, { expire: 5 });
      const manifest = await readTagManifest(`expire-matrix-${id}`);

      expectApproxMs(manifest.stale, startedAt);
      expectApproxMs(manifest.expired, startedAt + 5_000);

      const after = await getMatrix(id);
      expect(after.counter).toBe(before.counter);
    });

    it('{ expire: 0 } writes expired=now and the next GET is a blocking miss', async () => {
      const id = 'expire-zero';
      await getMatrix(id);
      const before = await getMatrix(id);

      const startedAt = Date.now();
      await revalidateMatrix(id, { expire: 0 });
      const manifest = await readTagManifest(`expire-matrix-${id}`);

      expectApproxMs(manifest.stale, startedAt);
      expectApproxMs(manifest.expired, startedAt);

      const after = await getMatrix(id);
      expect(after.counter).toBeGreaterThan(before.counter);
    });

    it('omitted profile writes expired=now without stale and the next GET misses', async () => {
      const id = 'omit-profile';
      await getMatrix(id);
      const before = await getMatrix(id);

      const startedAt = Date.now();
      await revalidateMatrix(id, null);
      const manifest = await readTagManifest(`expire-matrix-${id}`);

      expect(manifest.stale).toBeUndefined();
      expectApproxMs(manifest.expired, startedAt);

      const after = await getMatrix(id);
      expect(after.counter).toBeGreaterThan(before.counter);
    });

    it('{ expire: 2 } serves stale, then hard-expires after the window', async () => {
      const id = 'expire-two';
      await getMatrix(id);
      const before = await getMatrix(id);

      const startedAt = Date.now();
      await revalidateMatrix(id, { expire: 2 });
      const manifest = await readTagManifest(`expire-matrix-${id}`);

      expectApproxMs(manifest.stale, startedAt);
      expectApproxMs(manifest.expired, startedAt + 2_000);

      const stale = await getMatrix(id);
      expect(stale.counter).toBe(before.counter);

      await delay(3_000);

      const afterWindow = await getMatrix(id);
      expect(afterWindow.counter).toBeGreaterThan(before.counter);
    }, 15_000);
  });

  describe('Redis cache handler integration', () => {
    it('should call cache handler get and set methods', async () => {
      // Make request to trigger cache (don't clear first)
      await fetch(`${BASE_URL}/api/cached-static-fetch`);

      // Verify Redis has the cached data
      const redisKeys = await redisClient.keys(`${keyPrefix}*`);
      expect(redisKeys.length).toBeGreaterThan(0);

      // Filter out hash keys (sharedTagsMap) and only check string keys (cache entries)
      // Try to get each key and verify at least one is a string value
      let foundStringKey = false;
      for (const key of redisKeys) {
        try {
          const type = await redisClient.type(key);
          if (type === 'string') {
            const cachedValue = await redisClient.get(key);
            if (cachedValue) {
              foundStringKey = true;
              expect(cachedValue).toBeTruthy();
              break;
            }
          }
        } catch (e) {
          // Skip non-string keys
        }
      }
      expect(foundStringKey).toBe(true);
    });
  });
});
