import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { createClient } from 'redis';
import { join } from 'path';
import { CacheEntry } from '../../src/RedisStringsHandler';

const NEXT_APP_DIR = join(__dirname, 'next-app');
console.log('NEXT_APP_DIR', NEXT_APP_DIR);
const NEXT_START_PORT = 3055;
const NEXT_START_URL = `http://localhost:${NEXT_START_PORT}`;

let nextProcess;
let redisClient;

async function runCommand(cmd, args, cwd) {
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

async function waitForServer(url, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url + '/api/cached-static-fetch');
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Next.js server did not start in time');
}

describe('Next.js Turbo Redis Cache Integration', () => {
  beforeAll(async () => {
    if (process.env.SKIP_BUILD === 'true') {
      console.log('skipping build');
    } else {
      // Build Next.js app first
      await runCommand('pnpm', ['i'], NEXT_APP_DIR);
      console.log('pnpm i done');
      await runCommand('pnpm', ['build'], NEXT_APP_DIR);
      console.log('pnpm build done');
    }
    // Set up environment variables
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_URL =
      'integration-test-' + Math.random().toString(36).substring(2, 15);
    console.log('redis key prefix is:', process.env.VERCEL_URL);

    // Only override if redis env vars if not set. This can be set in the CI env.
    process.env.REDISHOST = process.env.REDISHOST || 'localhost';
    process.env.REDISPORT = process.env.REDISPORT || '6379';

    // Start Next.js app
    nextProcess = spawn(
      'npx',
      ['next', 'start', '-p', String(NEXT_START_PORT)],
      {
        cwd: NEXT_APP_DIR,
        env: {
          ...process.env,
        },
        stdio: 'pipe',
      },
    );
    if (process.env.DEBUG_INTEGRATION) {
      nextProcess.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
      });

      nextProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });
    }
    await waitForServer(NEXT_START_URL);
    console.log('next start successful');

    // Connect to Redis
    redisClient = createClient({
      url: `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`,
    });
    await redisClient.connect();
  }, 60_000);

  afterAll(async () => {
    if (nextProcess) nextProcess.kill();
    if (redisClient) await redisClient.quit();
  });

  it('should cache static API routes in Redis', async () => {
    // First request (should increment counter)
    const res1 = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
    const data1: any = await res1.json();
    expect(data1.counter).toBe(1);

    // Second request (should hit cache, counter should not increment if cache works)
    const res2 = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
    const data2: any = await res2.json();

    // If cache is working, counter should stay 1; if not, it will increment
    expect(data2.counter).toBe(1);

    // check Redis keys
    const keys = await redisClient.keys(process.env.VERCEL_URL + '*');
    expect(keys.length).toBeGreaterThan(0);

    // check the content of redis key
    const value = await redisClient.get(
      process.env.VERCEL_URL + '/api/cached-static-fetch',
    );
    expect(value).toBeDefined();
    const cacheEntry: CacheEntry = JSON.parse(value);
    expect((cacheEntry.value as any).kind).toBe('APP_ROUTE');
    const bodyBuffer = Buffer.from(
      (cacheEntry.value as any)?.body?.$binary,
      'base64',
    );
    const bodyJson = JSON.parse(bodyBuffer.toString('utf-8'));
    expect(bodyJson.counter).toBe(data2.counter);
  });

  it('should not cache uncached API routes in Redis', async () => {
    // First request (should increment counter)
    const res1 = await fetch(NEXT_START_URL + '/api/uncached-fetch');
    const data1: any = await res1.json();
    expect(data1.counter).toBe(1);

    // Second request (should hit cache, counter should not increment if cache works)
    const res2 = await fetch(NEXT_START_URL + '/api/uncached-fetch');
    const data2: any = await res2.json();

    // If not caching it is working request 2 should be higher as request one
    expect(data2.counter).toBeGreaterThan(data1.counter);

    // check the content of redis key
    const value = await redisClient.get(
      process.env.VERCEL_URL + '/api/uncached-fetch',
    );
    expect(value).toBeNull();
  });

  describe('should have the correct caching behavior for pages', () => {
    describe('Without any fetch requests', () => {
      describe('With default page configuration for revalidate and dynamic values', () => {
        it('should be cached in redis', async () => {
          /**
           * 0. Store timestamp of the first call in a variable so we can later check if TTL in redis is correct
           * 1. Call the page twice
           * 2. Extract the Timestamp from both results
           * 3. Compare the two timestamps
           * 4. The timestamps should be the same, meaning that the page was deduplicated
           * 5. Connect to redis and check if the page was cached in redis and if TTL is set correctly
           */

          // First request (should increment counter)
          const res1 = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
          const data1: any = await res1.json();
          expect(data1.counter).toBe(1);

          // Second request (should hit cache, counter should not increment if cache works)
          const res2 = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
          const data2: any = await res2.json();

          // If cache is working, counter should stay 1; if not, it will increment
          expect(data2.counter).toBe(1);

          // check Redis keys
          const keys = await redisClient.keys(process.env.VERCEL_URL + '*');
          expect(keys.length).toBeGreaterThan(0);

          // check the content of redis key
          const value = await redisClient.get(
            process.env.VERCEL_URL + '/api/cached-static-fetch',
          );
          expect(value).toBeDefined();
          const cacheEntry: CacheEntry = JSON.parse(value);
          expect((cacheEntry.value as any).kind).toBe('APP_ROUTE');
          const bodyBuffer = Buffer.from(
            (cacheEntry.value as any)?.body?.$binary,
            'base64',
          );
          const bodyJson = JSON.parse(bodyBuffer.toString('utf-8'));
          expect(bodyJson.counter).toBe(data2.counter);
        });
      });
    });
  });
});

/**
 * TODO
 * Test cases:
 * 0. Store timestamp of the first call in a variable so we can later check if TTL in redis is correct
 * 1. Call the page twice
 * 2. Extract the Timestamp from both results
 * 3. Compare the two timestamps
 * 4. The timestamps should be the same, meaning that the page was deduplicated
 * 5. Connect to redis and check if the page was cached in redis and if TTL is set correctly
 *
 * 6. Call the page again, but wait 3 seconds before calling it
 * 7. Extract the Timestamp
 * 8. Compare the timestamp to previous timestamp
 * 9. The timestamp should be the same, meaning that the page was cached (By in-memory cache which is set to 10 seconds by default)
 *
 * 10. Call the page again, but wait 11 seconds before calling it
 * 11. Extract the Timestamp
 * 12. Compare the timestamp to previous timestamp
 * 13. The timestamp should be the same, meaning that the page was cached (By redis cache which becomes active after in-memory cache expires)
 *
 * 14. Connect to redis and check if the page was cached in redis and if TTL is set correctly
 *
 * 15. Check expiration time of the page in redis
 *
 * 16. Call the page again after TTL expiration time
 * 17. Extract the Timestamp
 * 18. Compare the timestamp to previous timestamp
 * 19. The timestamp should be different, meaning that the page was recreated
 *
 * 20. call API which will invalidate the page via a revalidatePage action
 * 21. Call the page again
 * 18. Compare the timestamp to previous timestamp
 * 19. The timestamp should be different, meaning that the page was recreated
 *
 * 20. Connect to redis and delete the page from redis
 * 21. Call the page again, but wait 11 seconds before calling it
 * 22. Compare the timestamp to previous timestamp
 * 23. The timestamp should be different, meaning that the page was recreated
 */
