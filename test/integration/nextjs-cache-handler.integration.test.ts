import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { createClient } from 'redis';
import { join } from 'path';

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
    process.env.REDISHOST = 'localhost';
    process.env.REDISPORT = '6379';

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
    redisClient = createClient({ url: 'redis://localhost:6379' });
    await redisClient.connect();
  }, 60000);

  afterAll(async () => {
    if (nextProcess) nextProcess.kill();
    if (redisClient) await redisClient.quit();
  });

  it('should cache API responses in Redis', async () => {
    // First request (should increment counter)
    const res1 = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
    const data1: any = await res1.json();
    expect(data1.counter).toBe(1);

    // Second request (should hit cache, counter should not increment if cache works)
    const res2 = await fetch(NEXT_START_URL + '/api/cached-static-fetch');
    const data2: any = await res2.json();

    // If cache is working, counter should stay 1; if not, it will increment
    expect(data2.counter).toBe(1);

    // Optionally, check Redis keys
    const keys = await redisClient.keys(process.env.VERCEL_URL + '*');
    expect(keys.length).toBeGreaterThan(0);
  });
});
