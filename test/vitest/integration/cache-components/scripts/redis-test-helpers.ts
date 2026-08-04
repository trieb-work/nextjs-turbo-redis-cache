import { spawn, spawnSync } from 'child_process';

export type ContainerRuntime = 'podman' | 'docker';

export function canRun(cmd: string): boolean {
  const res = spawnSync(cmd, ['--version'], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  return !res.error && (res.status ?? 1) === 0;
}

export function hasContainerRuntime(): boolean {
  return canRun('podman') || canRun('docker');
}

export function detectContainerRuntime(): ContainerRuntime {
  if (process.env.CONTAINER_RUNTIME === 'podman') return 'podman';
  if (process.env.CONTAINER_RUNTIME === 'docker') return 'docker';
  if (canRun('podman')) return 'podman';
  if (canRun('docker')) return 'docker';
  throw new Error(
    'Neither podman nor docker is available. Install one of them or set CONTAINER_RUNTIME.',
  );
}

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function sh(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): ShResult {
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

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitUntil(
  fn: () => Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<boolean> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(intervalMs);
  }
}

export async function getFreePort(): Promise<number> {
  const net = await import('net');
  return new Promise((resolve, reject) => {
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
}

export function startRedis(
  runtime: ContainerRuntime,
  name: string,
  port: number,
): void {
  const r = sh(
    runtime,
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
  if (r.code !== 0) throw new Error(`${runtime} run failed: ${r.stderr}`);
}

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function record(name: string, pass: boolean, detail: string): void {
  process.stdout.write(`RESULT|${name}|${pass ? 'PASS' : 'FAIL'}|${detail}\n`);
}

export function parseResults(stdout: string): Map<string, TestResult> {
  const map = new Map<string, TestResult>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^RESULT\|([^|]+)\|(PASS|FAIL)\|(.*)$/);
    if (m) {
      map.set(m[1], {
        name: m[1],
        pass: m[2] === 'PASS',
        detail: m[3],
      });
    }
  }
  return map;
}

export function runNode(
  script: string,
  timeoutMs = 300_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('pnpm', ['-s', 'tsx', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
