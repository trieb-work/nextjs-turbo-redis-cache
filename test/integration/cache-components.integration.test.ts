import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { createClient, RedisClientType } from 'redis';
import path from 'path';

const PORT = 3055;
const BASE_URL = `http://localhost:${PORT}`;

describe('Next.js 16 Cache Components Integration', () => {
  let nextProcess: ChildProcess;
  let redisClient: RedisClientType;
  let keyPrefix: string;

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

    // Build and start Next.js app
    const appDir = path.join(__dirname, 'next-app-16-0-3-cache-components');

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
      await fetch(`${BASE_URL}/api/cached-static-fetch`);

      // Check Redis for cache keys
      const keys = await redisClient.keys(`${keyPrefix}*`);
      expect(keys.length).toBeGreaterThan(0);
    });
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

    it('should invalidate cache when tag is revalidated (Stale while revalidate)', async () => {
      // Get initial cached data
      const res1 = await fetch(`${BASE_URL}/api/cached-with-tag`);
      const data1 = await res1.json();

      // Revalidate the tag
      await fetch(`${BASE_URL}/api/revalidate-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'test-tag' }),
      });

      // The cache should be invalidated - verify by making multiple requests
      // until we get fresh data (with retries for async revalidation)
      let freshDataReceived = false;
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const res = await fetch(`${BASE_URL}/api/cached-with-tag`);
        const data = await res.json();

        if (data.counter > data1.counter && data.timestamp > data1.timestamp) {
          freshDataReceived = true;
          break;
        }
      }

      expect(freshDataReceived).toBe(true);
    });
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
