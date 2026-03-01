import { spawnSync } from 'child_process';

function sh(cmd: string, args: string[], opts: { timeoutMs?: number } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (res.error) throw res.error;
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 20_000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await sleep(200);
  }
}

async function main() {
  const name = `redis-e2e-${Math.random().toString(36).slice(2, 8)}`;

  // Pick a free localhost port
  const net = await import('net');
  const port: number = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string')
        return reject(new Error('bad addr'));
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });

  // cleanup
  sh('podman', ['rm', '-f', name]);

  // Start redis with keyspace notifications enabled (required by SyncedMap)
  {
    const r = sh(
      'podman',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-p',
        `${port}:6379`,
        'docker.io/redis:7-alpine',
        'redis-server',
        '--notify-keyspace-events',
        'Exe',
      ],
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) throw new Error(`podman run failed: ${r.stderr}`);
  }

  // IMPORTANT: importing from "src" will eagerly instantiate the singleton via `redisCacheHandler`.
  // So we must set env BEFORE importing.
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.VERCEL_URL = `e2e-${name}-`;

  const { getRedisCacheComponentsHandler } = await import('../../../src');

  const handler = getRedisCacheComponentsHandler({
    redisUrl: `redis://127.0.0.1:${port}`,
    socketOptions: {
      connectTimeout: 2_000,
      // allow redis client to reconnect; this scenario is about stability under restart
      reconnectStrategy: (retries) => Math.min(50 + retries * 50, 500),
    },
    clientOptions: {
      disableOfflineQueue: true,
    } as any,
  });

  const client = (handler as any).client as {
    ping: () => Promise<string>;
    isReady: boolean;
  };

  await waitUntil(async () => client.isReady, 20_000);
  if ((await client.ping()) !== 'PONG') throw new Error('expected PONG');

  // Kill redis
  sh('podman', ['stop', '-t', '0', name], { timeoutMs: 30_000 });

  // Wait a bit, then start again
  await sleep(500);

  {
    const r = sh(
      'podman',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-p',
        `${port}:6379`,
        'docker.io/redis:7-alpine',
        'redis-server',
        '--notify-keyspace-events',
        'Exe',
      ],
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) throw new Error(`podman run2 failed: ${r.stderr}`);
  }

  // Should recover
  await waitUntil(async () => {
    try {
      return (await client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }, 30_000);

  // Shut down clients before cleaning up Redis, otherwise reconnect loops keep the process alive.
  try {
    await (handler as any).client?.quit?.();
  } catch {}

  // cleanup best effort
  sh('podman', ['rm', '-f', name]);

  // If we reach here without crashing due to Socket already opened, we're good.
  // (Vitest will check stdout for this line.)
  process.stdout.write('OK\n');

  // Ensure we exit even if background reconnect timers exist.
  process.exit(0);
}

main().catch((err) => {
  // Ensure we don't hide the key error string
  console.error(err);
  process.exit(1);
});
