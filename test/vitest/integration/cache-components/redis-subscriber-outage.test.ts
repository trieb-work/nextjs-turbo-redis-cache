import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { spawnSync } from 'child_process';

function hasContainerRuntime() {
  const podman = spawnSync('podman', ['--version'], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  if (!podman.error && (podman.status ?? 1) === 0) return true;

  const docker = spawnSync('docker', ['--version'], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  return !docker.error && (docker.status ?? 1) === 0;
}

function runNode(script: string, timeoutMs = 300_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
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
    },
  );
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

function parseResults(stdout: string): Map<string, TestResult> {
  const map = new Map<string, TestResult>();
  // Try JSON first
  const jsonLine = stdout
    .split('\n')
    .find((l) => l.startsWith('RESULTS_JSON|'));
  if (jsonLine) {
    try {
      const json: TestResult[] = JSON.parse(
        jsonLine.slice('RESULTS_JSON|'.length),
      );
      for (const r of json) map.set(r.name, r);
      return map;
    } catch {}
  }
  // Fallback: parse RESULT lines
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

const describeOrSkip = hasContainerRuntime() ? describe : describe.skip;

describeOrSkip('issue #86: subscriber outage recovery', () => {
  let results: Map<string, TestResult>;

  beforeAll(async () => {
    const script = path.join(
      __dirname,
      'scripts',
      'redis-subscriber-outage.ts',
    );
    const res = await runNode(script, 300_000);
    // Script always exits 0 (it records pass/fail per sub-test)
    if (res.code !== 0) {
      throw new Error(
        `Script exited with code ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      );
    }
    results = parseResults(res.stdout);
  }, 300_000);

  // --- Tests that should PASS (verify correct behavior before outage) ---

  it('PubSub sync works before outage', () => {
    const r = results.get('pubsub-initial-strings');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('subscriber clients have error listeners before outage', () => {
    const r = results.get('error-listener-initial');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  // --- Tests that verify symptoms during outage ---

  it('get() returns null during outage', () => {
    const r = results.get('get-during-outage');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('heap does not grow excessively during 50 get() calls in outage', () => {
    const r = results.get('heap-growth-during-outage');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('main client reconnects after Redis restart', () => {
    const r = results.get('main-client-reconnects');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('get() works after Redis restart (main client path)', () => {
    const r = results.get('get-after-outage');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  // --- Tests that reproduce the bug (EXPECTED TO FAIL with current code) ---

  it('PubSub sync works after outage (issue #86 — subscriber never recovers)', () => {
    const r = results.get('pubsub-after-outage-strings');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('subscriber error listener state after outage (informational)', () => {
    const r = results.get('error-listener-after-outage');
    expect(r).toBeDefined();
    // Informational — always passes. Detail shows whether the listener
    // survived and whether the subscriber client object was replaced.
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('duplicate() call count during outage (informational)', () => {
    const r = results.get('duplicate-count-during-outage');
    expect(r).toBeDefined();
    // Informational — always passes. Detail has the actual count.
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('total duplicate() call count (informational)', () => {
    const r = results.get('duplicate-count-total');
    expect(r).toBeDefined();
    // Informational — always passes. Detail has the actual count.
    expect(r!.pass, r!.detail).toBe(true);
  });
});
