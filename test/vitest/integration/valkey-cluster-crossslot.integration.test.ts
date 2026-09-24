import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { createClient, type RedisClientType } from 'redis';
import RedisStringsHandler from '../../../src/RedisStringsHandler';
import { redisClusterKeySlot } from '../../../src/utils/clusterSafeUnlink';

const RUN_CLUSTER_TESTS = process.env.RUN_VALKEY_CLUSTER_TESTS === 'true';
const CONTAINER_NAME = `valkey-crossslot-${process.pid}`;
const REDIS_PORT = Number(process.env.VALKEY_CLUSTER_TEST_PORT || 6397);
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;

function run(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ stdout, stderr, code });
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed with code ${code}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

async function waitForValkey(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const result = await run(
      'docker',
      ['exec', CONTAINER_NAME, 'valkey-cli', 'ping'],
      { allowFailure: true },
    );
    if (result.stdout.includes('PONG')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Valkey test container did not become ready');
}

async function waitForClusterOk(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const result = await run(
      'docker',
      ['exec', CONTAINER_NAME, 'valkey-cli', 'CLUSTER', 'INFO'],
      { allowFailure: true },
    );
    if (result.stdout.includes('cluster_state:ok')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Valkey test cluster did not reach cluster_state:ok');
}

async function createDisposableValkeyCluster(): Promise<void> {
  await run('docker', ['rm', '-f', CONTAINER_NAME], { allowFailure: true });
  await run('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `127.0.0.1:${REDIS_PORT}:6379`,
    'valkey/valkey:9.0',
    'valkey-server',
    '--cluster-enabled',
    'yes',
    '--cluster-config-file',
    '/tmp/nodes.conf',
    '--notify-keyspace-events',
    'Exe',
    '--save',
    '',
    '--appendonly',
    'no',
    '--protected-mode',
    'no',
    '--bind',
    '0.0.0.0',
  ]);
  await waitForValkey();
  await run('docker', [
    'exec',
    CONTAINER_NAME,
    'valkey-cli',
    'CLUSTER',
    'ADDSLOTSRANGE',
    '0',
    '16383',
  ]);
  await waitForClusterOk();
}

async function closeHandler(handler: RedisStringsHandler): Promise<void> {
  const h = handler as any;
  await Promise.allSettled([
    h.sharedTagsMap?.subscriberClient?.quit?.(),
    h.revalidatedTagsMap?.subscriberClient?.quit?.(),
    h.inMemoryDeduplicationCache?.subscriberClient?.quit?.(),
  ]);
  await h.client?.quit?.();
}

describe.skipIf(!RUN_CLUSTER_TESTS)(
  'RedisStringsHandler Valkey cluster tag invalidation',
  () => {
    let redis: RedisClientType;
    let handler: RedisStringsHandler;

    beforeAll(async () => {
      await createDisposableValkeyCluster();
      redis = createClient({ url: REDIS_URL });
      await redis.connect();
      await redis.flushAll();
      handler = new RedisStringsHandler({
        redisUrl: REDIS_URL,
        database: 0,
        keyPrefix: 'issue-101:',
        redisGetDeduplication: false,
        inMemoryCachingTime: 0,
      });
    }, 60_000);

    afterAll(async () => {
      if (handler) {
        await closeHandler(handler);
      }
      if (redis) {
        await redis.quit();
      }
      await run('docker', ['stop', CONTAINER_NAME], { allowFailure: true });
    });

    it('reproduces Valkey CROSSSLOT for the reported multi-key UNLINK shape', async () => {
      await redis.set('cache:item:a', 'A');
      await redis.set('cache:item:b', 'B');

      await expect(
        redis.unlink(['cache:item:a', 'cache:item:b']),
      ).rejects.toThrow(/CROSSSLOT/);
      await expect(redis.exists('cache:item:a')).resolves.toBe(1);
      await expect(redis.exists('cache:item:b')).resolves.toBe(1);
    });

    it('invalidates two same-tag entries from different hash slots', async () => {
      const firstKey = 'cache:item:a';
      const secondKey = 'cache:item:b';
      const firstRedisKey = `issue-101:${firstKey}`;
      const secondRedisKey = `issue-101:${secondKey}`;

      expect(redisClusterKeySlot(firstRedisKey)).not.toBe(
        redisClusterKeySlot(secondRedisKey),
      );

      const cacheValue = {
        kind: 'FETCH' as const,
        data: {
          headers: {},
          body: '',
          status: 200,
          url: 'https://example.test/cache',
        },
        revalidate: 60,
      };
      const ctx = {
        isRoutePPREnabled: false,
        isFallback: false,
        tags: ['issue-101-tag'],
        cacheControl: { revalidate: 60, expire: 120 },
      };

      await handler.set(firstKey, cacheValue, ctx);
      await handler.set(secondKey, cacheValue, ctx);
      await expect(redis.exists(firstRedisKey)).resolves.toBe(1);
      await expect(redis.exists(secondRedisKey)).resolves.toBe(1);

      await handler.revalidateTag('issue-101-tag');

      await expect(redis.exists(firstRedisKey)).resolves.toBe(0);
      await expect(redis.exists(secondRedisKey)).resolves.toBe(0);
    }, 30_000);
  },
);
