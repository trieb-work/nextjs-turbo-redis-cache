import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { createClient, RedisClientType } from 'redis';
import { join } from 'path';
import { CacheEntry } from '../../src/RedisStringsHandler';
import { revalidate as next1503_revalidatedFetch_route } from './next-app-15-0-3/src/app/api/revalidated-fetch/route';

// Select which Next.js test app to use. Can be overridden via NEXT_TEST_APP env var
// Examples: next-app-15-0-3, next-app-15-3-2, next-app-15-4-7
const NEXT_TEST_APP = process.env.NEXT_TEST_APP || 'next-app-15-4-7';
const NEXT_APP_DIR = join(__dirname, NEXT_TEST_APP);
console.log('NEXT_APP_DIR', NEXT_APP_DIR);
const NEXT_START_PORT = 3055;
const NEXT_START_URL = `http://localhost:${NEXT_START_PORT}`;

const REDIS_BACKGROUND_SYNC_DELAY = 250; //ms delay to prevent flaky tests in slow CI environments

let nextProcess;
let redisClient: RedisClientType;

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // If there was detected to run a server before (any old server which was not stopped correctly), kill it
    try {
      const res = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
      if (res.ok) {
        await runCommand('pkill', ['next'], NEXT_APP_DIR);
      }
    } catch {}

    // Set up environment variables
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_URL =
      'integration-test-' + Math.random().toString(36).substring(2, 15);
    console.log('redis key prefix is:', process.env.VERCEL_URL);

    // Only override if redis env vars if not set. This can be set in the CI env.
    process.env.REDISHOST = process.env.REDISHOST || 'localhost';
    process.env.REDISPORT = process.env.REDISPORT || '6379';
    process.env.NEXT_START_PORT = String(NEXT_START_PORT);

    if (process.env.SKIP_BUILD === 'true') {
      console.log('skipping build');
    } else {
      // Build Next.js app first
      await runCommand('pnpm', ['i'], NEXT_APP_DIR);
      console.log('pnpm i done');
      await runCommand('pnpm', ['build'], NEXT_APP_DIR);
      console.log('pnpm build done');
    }

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
    }

    nextProcess.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });
    await waitForServer(NEXT_START_URL);
    console.log('next start successful');

    // Connect to Redis
    redisClient = createClient({
      url: `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`,
    });
    await redisClient.connect();

    console.log('redis key prefix is:', process.env.VERCEL_URL);
  }, 60_000);

  afterAll(async () => {
    if (process.env.KEEP_SERVER_RUNNING === 'true') {
      console.log('keeping server running');
    } else {
      if (nextProcess) nextProcess.kill();
    }
    if (redisClient) await redisClient.quit();
  });

  describe('should have the correct caching behavior for API routes', () => {
    describe('should cache static API routes in Redis', () => {
      let counter1: number;

      it('First request (should increment counter)', async () => {
        const res = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
        const data: any = await res.json();
        expect(data.counter).toBe(1);
        counter1 = data.counter;
      });

      it('Second request (should hit cache, counter should not increment if cache works)', async () => {
        const res = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
        const data: any = await res.json();
        // If cache is working, counter should stay 1; if not, it will increment
        expect(data.counter).toBe(counter1);
      });

      it('The data in the redis key should match the expected format', async () => {
        await delay(REDIS_BACKGROUND_SYNC_DELAY);
        const keys = await redisClient.keys(process.env.VERCEL_URL + '*');
        expect(keys.length).toBeGreaterThan(0);

        // check the content of redis key
        const value = await redisClient.get(
          process.env.VERCEL_URL + '/api/cached-static-fetch',
        );
        expect(value).toBeDefined();
        const cacheEntry: CacheEntry = JSON.parse(value);

        // The format should be as expected
        expect(cacheEntry).toEqual({
          value: {
            kind: 'APP_ROUTE',
            status: 200,
            body: { $binary: 'eyJjb3VudGVyIjoxfQ==' },
            headers: {
              'cache-control': 'public, max-age=1',
              'content-type': 'application/json',
              'x-next-cache-tags':
                '_N_T_/layout,_N_T_/api/layout,_N_T_/api/cached-static-fetch/layout,_N_T_/api/cached-static-fetch/route,_N_T_/api/cached-static-fetch',
            },
          },
          lastModified: expect.any(Number),
          tags: [
            '_N_T_/layout',
            '_N_T_/api/layout',
            '_N_T_/api/cached-static-fetch/layout',
            '_N_T_/api/cached-static-fetch/route',
            '_N_T_/api/cached-static-fetch',
          ],
        });

        expect((cacheEntry.value as any).kind).toBe('APP_ROUTE');
        const bodyBuffer = Buffer.from(
          (cacheEntry.value as any)?.body?.$binary,
          'base64',
        );
        const bodyJson = JSON.parse(bodyBuffer.toString('utf-8'));
        expect(bodyJson.counter).toBe(counter1);
      });

      it('A request to revalidatePath API should remove the route from redis (string and hashmap)', async () => {
        const revalidateRes = await fetch(
          NEXT_START_URL + '/api/revalidatePath?path=/api/cached-static-fetch',
        );
        const revalidateResJson: any = await revalidateRes.json();
        expect(revalidateResJson.success).toBe(true);
        await delay(REDIS_BACKGROUND_SYNC_DELAY);

        // check Redis keys
        const keys = await redisClient.keys(
          process.env.VERCEL_URL + '/api/cached-static-fetch',
        );
        expect(keys.length).toBe(0);

        const hashmap = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          '/api/cached-static-fetch',
        );
        expect(hashmap).toBeNull();
      });

      it('A new request after the revalidation should increment the counter (because the route was re-evaluated)', async () => {
        const res = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
        const data: any = await res.json();
        expect(data.counter).toBe(counter1 + 1);
      });

      it('After the new request was made the redis key and hashmap should be set again', async () => {
        await delay(REDIS_BACKGROUND_SYNC_DELAY);
        // check Redis keys
        const keys = await redisClient.keys(
          process.env.VERCEL_URL + '/api/cached-static-fetch',
        );
        expect(keys.length).toBe(1);

        const hashmap = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          '/api/cached-static-fetch',
        );
        expect(JSON.parse(hashmap)).toEqual([
          '_N_T_/layout',
          '_N_T_/api/layout',
          '_N_T_/api/cached-static-fetch/layout',
          '_N_T_/api/cached-static-fetch/route',
          '_N_T_/api/cached-static-fetch',
        ]);
      });
    });

    describe('should cache revalidation API routes in Redis', () => {
      let counter1: number;

      it('First request (should increment counter)', async () => {
        const res = await fetch(NEXT_START_URL + '/api/revalidated-fetch');
        const data: any = await res.json();
        expect(data.counter).toBe(1);
        counter1 = data.counter;
      });

      it('Second request which is send in revalidation time should hit cache (counter should not increment)', async () => {
        const res = await fetch(NEXT_START_URL + '/api/revalidated-fetch');
        const data: any = await res.json();
        expect(data.counter).toBe(counter1);
      });

      if (process.env.SKIP_OPTIONAL_LONG_RUNNER_TESTS !== 'true') {
        const FIRST_DELAY = 6000;
        const SECOND_DELAY = 1000;
        it('Third request which is send directly after revalidation time will still serve cache but trigger re-evaluation (stale-while-revalidate)', async () => {
          await delay(FIRST_DELAY);
          const res = await fetch(NEXT_START_URL + '/api/revalidated-fetch');
          const data: any = await res.json();
          expect(data.counter).toBe(counter1);
        }, 10_000);

        it('Third request which is send directly after revalidation time will serve re-evaluated data (stale-while-revalidate)', async () => {
          await delay(SECOND_DELAY);
          const res = await fetch(NEXT_START_URL + '/api/revalidated-fetch');
          const data: any = await res.json();
          expect(data.counter).toBe(counter1 + 1);
        });

        it('After expiration, the redis key should be removed from redis and the hashmap', async () => {
          const ttl = await redisClient.ttl(
            process.env.VERCEL_URL + '/api/revalidated-fetch',
          );
          expect(ttl).toBeLessThan(2 * next1503_revalidatedFetch_route);
          expect(ttl).toBeGreaterThan(
            2 * next1503_revalidatedFetch_route -
              FIRST_DELAY -
              SECOND_DELAY -
              REDIS_BACKGROUND_SYNC_DELAY,
          );

          await delay(ttl * 1000 + 500);

          // check Redis keys
          const keys = await redisClient.keys(
            process.env.VERCEL_URL + '/api/revalidated-fetch',
          );
          expect(keys.length).toBe(0);

          await delay(1000);

          // The key should also be removed from the hashmap
          const hashmap = await redisClient.hGet(
            process.env.VERCEL_URL + '__sharedTags__',
            '/api/revalidated-fetch',
          );
          expect(hashmap).toBeNull();
        }, 15_000);
      }
    });

    // Next 16-only caching API tests. These routes exist only in the Next 16 test app
    // and exercise the new revalidateTag profiles and updateTag semantics.
    if (NEXT_TEST_APP.includes('16.')) {
      describe('Next 16 caching APIs', () => {
        const cachedStaticPath = '/api/cached-static-fetch';

        async function assertCachedStaticFetchCleared() {
          await delay(REDIS_BACKGROUND_SYNC_DELAY);
          const keys = await redisClient.keys(
            process.env.VERCEL_URL + cachedStaticPath,
          );
          expect(keys.length).toBe(0);

          const hashmap = await redisClient.hGet(
            process.env.VERCEL_URL + '__sharedTags__',
            cachedStaticPath,
          );
          expect(hashmap).toBeNull();
        }

        it('revalidateTag(tag, "max") should invalidate cached-static-fetch by tag', async () => {
          // Warm up cache and sharedTagsMap for cached-static-fetch
          await fetch(NEXT_START_URL + cachedStaticPath);
          await delay(REDIS_BACKGROUND_SYNC_DELAY);

          // Use explicit tag for this route as set by Next.js
          const tag = '_N_T_/api/cached-static-fetch';
          const res = await fetch(
            `${NEXT_START_URL}/api/revalidateTag?tag=${encodeURIComponent(
              tag,
            )}&profile=max`,
          );
          const json: any = await res.json();
          expect(json.success).toBe(true);

          await assertCachedStaticFetchCleared();
        });

        it('revalidateTag(tag, { expire: 60 }) should also invalidate cached-static-fetch', async () => {
          // Warm up cache again
          await fetch(NEXT_START_URL + cachedStaticPath);
          await delay(REDIS_BACKGROUND_SYNC_DELAY);

          const tag = '_N_T_/api/cached-static-fetch';
          const res = await fetch(
            `${NEXT_START_URL}/api/revalidateTag?tag=${encodeURIComponent(
              tag,
            )}&profile=expire`,
          );
          const json: any = await res.json();
          expect(json.success).toBe(true);

          await assertCachedStaticFetchCleared();
        });
      });
    }

    describe('should not cache uncached API routes in Redis', () => {
      let counter1: number;

      it('First request should increment counter', async () => {
        const res1 = await fetch(NEXT_START_URL + '/api/uncached-fetch');
        const data1: any = await res1.json();
        expect(data1.counter).toBe(1);
        counter1 = data1.counter;
      });

      it('Second request should hit cache (counter should not increment if cache works)', async () => {
        const res2 = await fetch(NEXT_START_URL + '/api/uncached-fetch');
        const data2: any = await res2.json();

        // If not caching it is working request 2 should be higher as request one
        expect(data2.counter).toBe(counter1 + 1);
      });

      it('The redis key should not be set', async () => {
        // check the content of redis key
        const value = await redisClient.get(
          process.env.VERCEL_URL + '/api/uncached-fetch',
        );
        expect(value).toBeNull();
      });
    });

    describe('should cache a nested fetch request inside a uncached API route', () => {
      describe('should cache the nested fetch request (but not the API route itself)', () => {
        let counter: number;
        let subCounter: number;

        it('should deduplicate requests to the sub-fetch-request, but not to the API route itself', async () => {
          // make two requests, both should return the same subFetchData but different counter
          const res1 = await fetch(
            NEXT_START_URL + '/api/nested-fetch-in-api-route/revalidated-fetch',
          );
          const res2 = await fetch(
            NEXT_START_URL + '/api/nested-fetch-in-api-route/revalidated-fetch',
          );
          const [data1, data2]: any[] = await Promise.all([
            res1.json(),
            res2.json(),
          ]);

          // API route counter itself increments for each request
          // But we do not know which request is first and which is second
          if (data1.counter < data2.counter) {
            expect(data2.counter).toBeGreaterThan(data1.counter);
            counter = data2.counter;
          } else {
            expect(data1.counter).toBeGreaterThan(data2.counter);
            counter = data1.counter;
          }

          // API route counter of revalidated sub-fetch-request should be the same (request deduplication of fetch requests)
          expect(data1.subFetchData.counter).toBe(data1.subFetchData.counter);
          subCounter = data1.subFetchData.counter;
        });

        if (process.env.SKIP_OPTIONAL_LONG_RUNNER_TESTS !== 'true') {
          it('should return the same subFetchData after 2 seconds (regular caching within revalidation interval (=3s) works)', async () => {
            // make another request after 2 seconds, it should return the same subFetchData
            await delay(2000); // 2s < 3s (revalidate interval)
            const res = await fetch(
              NEXT_START_URL +
                '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            const data: any = await res.json();

            expect(data.counter).toBe(counter + 1);
            expect(data.subFetchData.counter).toBe(subCounter);
          });

          it('should return the same subFetchData after 2 seconds and new data after another 2 seconds (caching while revalidation works)', async () => {
            // make another request after another 2 seconds, it should return the same subFetchData (caching while revalidation works)
            await delay(2000); // 2s+2s < 3s*2 (=TTL = revalidate=3s*2)
            const res1 = await fetch(
              NEXT_START_URL +
                '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            const data1: any = await res1.json();
            expect(data1.counter).toBe(counter + 2);
            expect(data1.subFetchData.counter).toBe(subCounter);

            // make another request directly after first request which was still in TTL, it should return new data (caching while revalidation works)
            await delay(REDIS_BACKGROUND_SYNC_DELAY);
            const res2 = await fetch(
              NEXT_START_URL +
                '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            const data2: any = await res2.json();
            expect(data2.counter).toBe(counter + 3);
            expect(data2.subFetchData.counter).toBe(subCounter + 1);
          });

          it('A request to revalidatePage API should remove the route from redis (string and hashmap)', async () => {
            const revalidateRes = await fetch(
              NEXT_START_URL +
                '/api/revalidatePath?path=/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            const revalidateResJson: any = await revalidateRes.json();
            expect(revalidateResJson.success).toBe(true);
            await delay(REDIS_BACKGROUND_SYNC_DELAY);

            // check Redis keys
            const keys = await redisClient.keys(
              process.env.VERCEL_URL +
                '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            expect(keys.length).toBe(0);

            const hashmap = await redisClient.hGet(
              process.env.VERCEL_URL + '__sharedTags__',
              '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            expect(hashmap).toBeNull();
          });

          it('A new request after the revalidation should increment the counter (because the route was re-evaluated)', async () => {
            const res = await fetch(
              NEXT_START_URL +
                '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            const data: any = await res.json();
            expect(data.counter).toBe(counter + 4);
            expect(data.subFetchData.counter).toBe(subCounter + 2);
          });

          it('After the new request was made the redis key and hashmap should be set again', async () => {
            await delay(REDIS_BACKGROUND_SYNC_DELAY);

            // This cache entry key is the key of the sub-fetch-request, it will be generated by nextjs based on the headers/payload etc.
            // So it should stay the same unless nextjs will change something in there implementation
            const cacheEntryKey =
              '094a786b7ad391852168d3a7bcf75736777697d24a856a0089837f4b7de921df';

            // check Redis keys
            const keys = await redisClient.keys(
              process.env.VERCEL_URL + cacheEntryKey,
            );
            expect(keys.length).toBe(1);

            const hashmap = await redisClient.hGet(
              process.env.VERCEL_URL + '__sharedTags__',
              cacheEntryKey,
            );
            expect(JSON.parse(hashmap)).toEqual([
              'revalidated-fetch-revalidate3-nested-fetch-in-api-route',
            ]);
          });

          it('A request to revalidateTag API should remove the route from redis (string and hashmap)', async () => {
            const revalidateRes = await fetch(
              NEXT_START_URL +
                '/api/revalidateTag?tag=revalidated-fetch-revalidate3-nested-fetch-in-api-route',
            );
            const revalidateResJson: any = await revalidateRes.json();
            expect(revalidateResJson.success).toBe(true);
            await delay(REDIS_BACKGROUND_SYNC_DELAY);

            // check Redis keys
            const keys = await redisClient.keys(
              process.env.VERCEL_URL +
                '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            expect(keys.length).toBe(0);

            const hashmap = await redisClient.hGet(
              process.env.VERCEL_URL + '__sharedTags__',
              '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            expect(hashmap).toBeNull();
          });

          it('Another new request after the revalidation should increment the counter (because the route was re-evaluated)', async () => {
            const res = await fetch(
              NEXT_START_URL +
                '/api/nested-fetch-in-api-route/revalidated-fetch',
            );
            const data: any = await res.json();
            expect(data.counter).toBe(counter + 5);
            expect(data.subFetchData.counter).toBe(subCounter + 3);
          });

          it('After the new request was made the redis key and hashmap should be set again', async () => {
            await delay(REDIS_BACKGROUND_SYNC_DELAY);
            // This cache entry key is the key of the sub-fetch-request, it will be generated by nextjs based on the headers/payload etc.
            // So it should stay the same unless nextjs will change something in there implementation
            const cacheEntryKey =
              '094a786b7ad391852168d3a7bcf75736777697d24a856a0089837f4b7de921df';

            // check Redis keys
            const keys = await redisClient.keys(
              process.env.VERCEL_URL + cacheEntryKey,
            );
            expect(keys.length).toBe(1);

            const hashmap = await redisClient.hGet(
              process.env.VERCEL_URL + '__sharedTags__',
              cacheEntryKey,
            );
            expect(JSON.parse(hashmap)).toEqual([
              'revalidated-fetch-revalidate3-nested-fetch-in-api-route',
            ]);
          });
        }
      });
    });

    // describe('With a API route that has a unstable_cacheTag', () => {
    //   // TODO: implement API route for this test as well as the test itself
    // });

    // describe('With a API route that has a unstable_cacheLife', () => {
    //   // TODO: implement API route for this test as well as the test itself
    // });
  });

  describe('should have the correct caching behavior for pages', () => {
    describe('Without any fetch requests inside the page', () => {
      describe('With default page configuration for revalidate and dynamic values', () => {
        let timestamp1: string | undefined;

        it('Two parallel requests should return the same timestamp (because requests are deduplicated)', async () => {
          // First request (should increment counter)
          const [pageRes1, pageRes2] = await Promise.all([
            fetch(NEXT_START_URL + '/pages/no-fetch/default-page'),
            fetch(NEXT_START_URL + '/pages/no-fetch/default-page'),
          ]);

          const pageText1 = await pageRes1.text();
          timestamp1 = pageText1.match(/Timestamp: <!-- -->(\d+)/)?.[1];
          expect(timestamp1).toBeDefined();

          const pageText2 = await pageRes2.text();
          const timestamp2 = pageText2.match(/Timestamp: <!-- -->(\d+)/)?.[1];
          expect(timestamp2).toBeDefined();
          expect(timestamp1).toBe(timestamp2);
        });

        it('Redis should have a key for the page which should have a TTL set to 28 days (2 * 14 days default revalidate time)', async () => {
          // check Redis keys
          const ttl = await redisClient.ttl(
            process.env.VERCEL_URL + '/pages/no-fetch/default-page',
          );
          // 14 days is default revalidate for pages -> expiration time is 2 * revalidate time -> -10 seconds for testing offset stability
          expect(ttl).toBeGreaterThan(2 * 14 * 24 * 60 * 60 - 30);
        });

        it('The data in the redis key should match the expected format', async () => {
          const data = await redisClient.get(
            process.env.VERCEL_URL + '/pages/no-fetch/default-page',
          );
          expect(data).toBeDefined();
          const cacheEntry: CacheEntry = JSON.parse(data);

          // The format should be as expected. We intentionally do not assert on an optional status field here
          // so that different Next.js versions (which may include or omit it) are both supported.
          expect(cacheEntry).toMatchObject({
            value: {
              kind: 'APP_PAGE',
              html: expect.any(String),
              rscData: {
                $binary: expect.any(String),
              },
              headers: {
                'x-nextjs-stale-time': expect.any(String),
                'x-next-cache-tags':
                  '_N_T_/layout,_N_T_/pages/layout,_N_T_/pages/no-fetch/layout,_N_T_/pages/no-fetch/default-page/layout,_N_T_/pages/no-fetch/default-page/page,_N_T_/pages/no-fetch/default-page',
              },
            },
            lastModified: expect.any(Number),
            tags: [
              '_N_T_/layout',
              '_N_T_/pages/layout',
              '_N_T_/pages/no-fetch/layout',
              '_N_T_/pages/no-fetch/default-page/layout',
              '_N_T_/pages/no-fetch/default-page/page',
              '_N_T_/pages/no-fetch/default-page',
            ],
          });
        });

        if (process.env.SKIP_OPTIONAL_LONG_RUNNER_TESTS !== 'true') {
          it('A new request after 3 seconds should return the same timestamp (because the page was cached in in-memory cache)', async () => {
            await delay(3_000);
            const pageRes3 = await fetch(
              NEXT_START_URL + '/pages/no-fetch/default-page',
            );
            const pageText3 = await pageRes3.text();
            const timestamp3 = pageText3.match(/Timestamp: <!-- -->(\d+)/)?.[1];
            expect(timestamp3).toBeDefined();
            expect(timestamp1).toBe(timestamp3);
          });

          it('A new request after 11 seconds should return the same timestamp (because the page was cached in redis cache)', async () => {
            await delay(11_000);
            const pageRes4 = await fetch(
              NEXT_START_URL + '/pages/no-fetch/default-page',
            );
            const pageText4 = await pageRes4.text();
            const timestamp4 = pageText4.match(/Timestamp: <!-- -->(\d+)/)?.[1];
            expect(timestamp4).toBeDefined();
            expect(timestamp1).toBe(timestamp4);
          }, 15_000);
        }

        it('A request to revalidatePage API should remove the page from redis (string and hashmap)', async () => {
          const revalidateRes = await fetch(
            NEXT_START_URL +
              '/api/revalidatePath?path=/pages/no-fetch/default-page',
          );
          const revalidateResJson: any = await revalidateRes.json();
          expect(revalidateResJson.success).toBe(true);
          await delay(REDIS_BACKGROUND_SYNC_DELAY);

          // check Redis keys
          const keys = await redisClient.keys(
            process.env.VERCEL_URL + '/pages/no-fetch/default-page',
          );
          expect(keys.length).toBe(0);

          const hashmap = await redisClient.hGet(
            process.env.VERCEL_URL + '__sharedTags__',
            '/pages/no-fetch/default-page',
          );
          expect(hashmap).toBeNull();
        });

        it('A new request after the revalidation should return a new timestamp (because the page was recreated)', async () => {
          const pageRes4 = await fetch(
            NEXT_START_URL + '/pages/no-fetch/default-page',
          );
          const pageText4 = await pageRes4.text();
          const timestamp4 = pageText4.match(/Timestamp: <!-- -->(\d+)/)?.[1];
          expect(timestamp4).toBeDefined();
          expect(Number(timestamp4)).toBeGreaterThan(Number(timestamp1));
        });

        it('After the new request was made the redis key and hashmap should be set again', async () => {
          // check Redis keys
          await delay(REDIS_BACKGROUND_SYNC_DELAY);
          const keys = await redisClient.keys(
            process.env.VERCEL_URL + '/pages/no-fetch/default-page',
          );
          expect(keys.length).toBe(1);

          const hashmap = await redisClient.hGet(
            process.env.VERCEL_URL + '__sharedTags__',
            '/pages/no-fetch/default-page',
          );
          expect(JSON.parse(hashmap)).toEqual([
            '_N_T_/layout',
            '_N_T_/pages/layout',
            '_N_T_/pages/no-fetch/layout',
            '_N_T_/pages/no-fetch/default-page/layout',
            '_N_T_/pages/no-fetch/default-page/page',
            '_N_T_/pages/no-fetch/default-page',
          ]);
        });
      });
    });

    // describe('With a cached static fetch request inside a page', () => {
    //   // TODO: implement test for `test/integration/next-app/src/app/pages/cached-static-fetch`
    // });

    describe('With a cached revalidation fetch request inside a page', () => {
      let firstTimestamp: string;
      let firstCounter: string;

      it('should set all cache entries for this page after request is finished', async () => {
        const pageRes = await fetch(
          NEXT_START_URL +
            '/pages/revalidated-fetch/revalidate15--default-page',
        );
        const pageText = await pageRes.text();
        const timestamp = pageText.match(/Timestamp: <!-- -->(\d+)/)?.[1];
        const counter = pageText.match(/Counter: <!-- -->(\d+)/)?.[1];
        expect(timestamp).toBeDefined();
        expect(counter).toBeDefined();
        firstTimestamp = timestamp!;
        firstCounter = counter!;

        await delay(REDIS_BACKGROUND_SYNC_DELAY);

        // test cache entry for 3 keys are set
        const keys1 = await redisClient.keys(
          process.env.VERCEL_URL +
            '/pages/revalidated-fetch/revalidate15--default-page',
        );
        expect(keys1.length).toBe(1);
        const keys2 = await redisClient.keys(
          process.env.VERCEL_URL +
            'e978cf5ddb8bf799209e828635cfe9ae6862f6735cea97f01ab752ff6fa489b4',
        );
        expect(keys2.length).toBe(1);
        const keys3 = await redisClient.keys(
          process.env.VERCEL_URL + '/api/revalidated-fetch',
        );
        expect(keys3.length).toBe(1);

        // test shared tag hashmap to be set for all keys
        const hashmap1 = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          '/pages/revalidated-fetch/revalidate15--default-page',
        );
        expect(JSON.parse(hashmap1)).toEqual([
          '_N_T_/layout',
          '_N_T_/pages/layout',
          '_N_T_/pages/revalidated-fetch/layout',
          '_N_T_/pages/revalidated-fetch/revalidate15--default-page/layout',
          '_N_T_/pages/revalidated-fetch/revalidate15--default-page/page',
          '_N_T_/pages/revalidated-fetch/revalidate15--default-page',
          'revalidated-fetch-revalidate15-default-page',
        ]);
        const hashmap2 = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          'e978cf5ddb8bf799209e828635cfe9ae6862f6735cea97f01ab752ff6fa489b4',
        );
        expect(JSON.parse(hashmap2)).toEqual([
          'revalidated-fetch-revalidate15-default-page',
        ]);
        const hashmap3 = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          '/api/revalidated-fetch',
        );
        expect(JSON.parse(hashmap3)).toEqual([
          '_N_T_/layout',
          '_N_T_/api/layout',
          '_N_T_/api/revalidated-fetch/layout',
          '_N_T_/api/revalidated-fetch/route',
          '_N_T_/api/revalidated-fetch',
        ]);
      });

      it('a new request should return the same timestamp as the first request', async () => {
        const pageRes = await fetch(
          NEXT_START_URL +
            '/pages/revalidated-fetch/revalidate15--default-page',
        );
        const pageText = await pageRes.text();
        const timestamp = pageText.match(/Timestamp: <!-- -->(\d+)/)?.[1];
        expect(timestamp).toBeDefined();
        expect(timestamp).toBe(firstTimestamp);
      });

      it('A request to revalidatePath API should remove the page from redis (string and hashmap) but not the api route', async () => {
        const revalidateRes = await fetch(
          NEXT_START_URL +
            '/api/revalidatePath?path=/pages/revalidated-fetch/revalidate15--default-page',
        );
        const revalidateResJson: any = await revalidateRes.json();
        expect(revalidateResJson.success).toBe(true);
        await delay(REDIS_BACKGROUND_SYNC_DELAY);

        // test no cache entry for 2 keys
        const keys1 = await redisClient.keys(
          process.env.VERCEL_URL +
            '/pages/revalidated-fetch/revalidate15--default-page',
        );
        expect(keys1.length).toBe(0);

        const hashmap1 = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          '/pages/revalidated-fetch/revalidate15--default-page',
        );
        expect(hashmap1).toBeNull();

        // sub-fetch-request is not removed directly but will be removed on next get request
        const keys2 = await redisClient.keys(
          process.env.VERCEL_URL +
            'e978cf5ddb8bf799209e828635cfe9ae6862f6735cea97f01ab752ff6fa489b4',
        );
        expect(keys2.length).toBe(1);
        const hashmap2 = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          'e978cf5ddb8bf799209e828635cfe9ae6862f6735cea97f01ab752ff6fa489b4',
        );
        expect(hashmap2).toBeDefined();

        // the page should also be in revalidatedTagsMap so that the nested fetch requests knows that the page was invalidated
        const revalidationTimestamp = await redisClient.hGet(
          process.env.VERCEL_URL + '__revalidated_tags__',
          '_N_T_/pages/revalidated-fetch/revalidate15--default-page',
        );
        const ts = Number(revalidationTimestamp);
        expect(ts).toBeGreaterThan(1);
        expect(ts).toBeLessThan(Number(Date.now()));

        // API route should still be cached
        const keys3 = await redisClient.keys(
          process.env.VERCEL_URL + '/api/revalidated-fetch',
        );
        expect(keys3.length).toBe(1);
        const hashmap3 = await redisClient.hGet(
          process.env.VERCEL_URL + '__sharedTags__',
          '/api/revalidated-fetch',
        );
        expect(JSON.parse(hashmap3)).toEqual([
          '_N_T_/layout',
          '_N_T_/api/layout',
          '_N_T_/api/revalidated-fetch/layout',
          '_N_T_/api/revalidated-fetch/route',
          '_N_T_/api/revalidated-fetch',
        ]);
      });

      it('a new request should return a newer timestamp as the first request (which was invalidated by revalidatePath)', async () => {
        const pageRes = await fetch(
          NEXT_START_URL +
            '/pages/revalidated-fetch/revalidate15--default-page',
        );
        const pageText = await pageRes.text();
        const timestamp = pageText.match(/Timestamp: <!-- -->(\d+)/)?.[1];
        const secondCounter = pageText.match(/Counter: <!-- -->(\d+)/)?.[1];
        expect(timestamp).toBeDefined();
        expect(Number(timestamp)).toBeGreaterThan(Number(firstTimestamp));

        //but the new request should not have a higher counter than the first request (because the cache of the API route should not be invalidated)
        expect(secondCounter).toBeDefined();
        expect(secondCounter).toBe(firstCounter);
      });
    });

    // describe('With a uncached fetch request inside a page', () => {
    //   // TODO: implement test for `test/integration/next-app/src/app/pages/uncached-fetch`
    //
    // });

    // describe('With a page that has a unstable_cacheTag', () => {
    //   // TODO: implement page for this test as well as the test itself
    // });

    // describe('With a page that has a unstable_cacheLife', () => {
    //   // TODO: implement page for this test as well as the test itself
    // });
  });
});
