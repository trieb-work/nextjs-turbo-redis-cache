import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createClient, RedisClientType } from 'redis';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';

const NEXT_APP = 'next-app-15-4-7';
const PORT = 3075;
const BASE_URL = `http://localhost:${PORT}`;

async function waitForServer(url: string, timeout = 20000) {
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

describe('BUILD_ID-based key prefix (Next handlers)', () => {
  let nextProcess: ChildProcessWithoutNullStreams | undefined;
  let redis: RedisClientType;
  let appDir: string;
  let buildId: string;

  beforeAll(async () => {
    appDir = path.join(__dirname, NEXT_APP);

    // Ensure clean env so BUILD_ID precedence kicks in
    delete (process.env as Record<string, string | undefined>).KEY_PREFIX;
    delete (process.env as Record<string, string | undefined>).VERCEL_URL;
    process.env.VERCEL_ENV = 'production';
    process.env.REDISHOST = process.env.REDISHOST || 'localhost';
    process.env.REDISPORT = process.env.REDISPORT || '6379';

    // Install + build
    await new Promise<void>((resolve, reject) => {
      const p = spawn('pnpm', ['install'], { cwd: appDir, stdio: 'inherit' });
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error('pnpm i failed')),
      );
    });
    await new Promise<void>((resolve, reject) => {
      const p = spawn('pnpm', ['build'], { cwd: appDir, stdio: 'inherit' });
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error('pnpm build failed')),
      );
    });

    // Read BUILD_ID from the built app
    buildId = fs
      .readFileSync(path.join(appDir, '.next', 'BUILD_ID'), 'utf8')
      .trim();

    // Start server without KEY_PREFIX/VERCEL_URL
    nextProcess = spawn('npx', ['next', 'start', '-p', String(PORT)], {
      cwd: appDir,
      env: { ...process.env, SKIP_KEYSPACE_CONFIG_CHECK: 'true' },
      stdio: 'pipe',
    });

    nextProcess.stderr?.on(
      'data',
      (d) => process.env.DEBUG_INTEGRATION && console.error(String(d)),
    );

    await waitForServer(BASE_URL);

    // Connect Redis
    redis = createClient({
      url: `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`,
    });
    await redis.connect();
  }, 180000);

  afterAll(async () => {
    try {
      if (redis) await redis.quit();
    } finally {
      if (nextProcess) nextProcess.kill();
    }
  });

  it('uses BUILD_ID as the Redis key prefix when no KEY_PREFIX/VERCEL_URL set', async () => {
    // Warm cache twice to ensure a set occurs even if first was during startup
    const res1 = await fetch(BASE_URL + '/api/cached-static-fetch');
    expect(res1.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const res2 = await fetch(BASE_URL + '/api/cached-static-fetch');
    expect(res2.ok).toBe(true);

    // Allow background syncs
    await new Promise((r) => setTimeout(r, 1500));

    const keys = await redis.keys(`${buildId}*`);
    expect(keys.length).toBeGreaterThan(0);
  });
});
