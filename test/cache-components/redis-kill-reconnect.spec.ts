import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

function runNode(script: string, timeoutMs = 120_000) {
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

describe('cache components: redis kill/reconnect end-to-end', () => {
  it('survives redis restart without Socket already opened', async () => {
    const script = path.join(__dirname, 'scripts', 'redis-kill-reconnect.ts');

    const res = await runNode(script, 180_000);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('OK');
    expect(res.stderr).not.toContain('Socket already opened');
  }, 180_000);
});
