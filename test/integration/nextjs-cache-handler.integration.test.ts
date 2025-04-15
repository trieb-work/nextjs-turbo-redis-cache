import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { createClient } from 'redis';
import { join } from 'path';

const NEXT_APP_DIR = join(__dirname, 'next-app');
const NEXT_START_PORT = 3055;
const NEXT_START_URL = `http://localhost:${NEXT_START_PORT}`;

let nextProcess;
let redisClient;

async function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit' });
    proc.on('exit', (code) => {
      if (code === 0) resolve(undefined);
      else
        reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`));
    });
  });
}

async function waitForServer(url, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url + '/api/cache-test');
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Next.js server did not start in time');
}

describe('Next.js Turbo Redis Cache Integration', () => {
  beforeAll(async () => {
    // Build Next.js app first
    await runCommand('npx', ['next', 'build'], NEXT_APP_DIR);

    // Start Next.js app
    nextProcess = spawn(
      'npx',
      ['next', 'start', '-p', String(NEXT_START_PORT)],
      {
        cwd: NEXT_APP_DIR,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          REDIS_URL: 'redis://localhost:6379',
        },
        stdio: 'inherit',
      },
    );
    await waitForServer(NEXT_START_URL);

    // Connect to Redis
    redisClient = createClient({ url: 'redis://localhost:6379' });
    await redisClient.connect();
    // Optionally flush a test database
    await redisClient.flushDb();
  }, 60000);

  afterAll(async () => {
    if (nextProcess) nextProcess.kill();
    if (redisClient) await redisClient.quit();
  });

  it('should cache API responses in Redis', async () => {
    // First request (should increment counter)
    const res1 = await fetch(NEXT_START_URL + '/api/cache-test');
    const data1 = await res1.json();
    expect(data1.counter).toBe(1);

    // Second request (should hit cache, counter should not increment if cache works)
    const res2 = await fetch(NEXT_START_URL + '/api/cache-test');
    const data2 = await res2.json();

    // If cache is working, counter should stay 1; if not, it will increment
    expect(data2.counter).toBe(1);

    // Optionally, check Redis keys
    const keys = await redisClient.keys('*');
    expect(keys.length).toBeGreaterThan(0);
  });
});
