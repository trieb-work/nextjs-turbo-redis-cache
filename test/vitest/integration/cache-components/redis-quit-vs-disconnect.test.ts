import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  hasContainerRuntime,
  runNode,
  parseResults,
  type TestResult,
} from './scripts/redis-test-helpers';

const describeOrSkip = hasContainerRuntime() ? describe : describe.skip;

describeOrSkip('subscriber teardown: quit() vs disconnect()', () => {
  let results: Map<string, TestResult>;
  let exitCode: number;
  let stderr: string;

  beforeAll(async () => {
    const script = path.join(
      __dirname,
      'scripts',
      'redis-quit-vs-disconnect.ts',
    );
    const res = await runNode(script, 60_000);
    exitCode = res.code;
    stderr = res.stderr;
    results = parseResults(res.stdout);
  }, 60_000);

  it('script exits successfully', () => {
    if (exitCode !== 0) {
      process.stderr.write(stderr);
    }
    expect(exitCode).toBe(0);
  });

  it('subscriber clients are ready before outage', () => {
    const r = results.get('subscribers-ready');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('quit() does not immediately close a subscriber during outage', () => {
    const r = results.get('quit-does-not-immediately-close');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('disconnect() closes the subscriber immediately during outage', () => {
    const r = results.get('disconnect-closes-immediately');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });

  it('disconnected subscriber stays dead after Redis restarts', () => {
    const r = results.get('disconnected-client-stays-dead');
    expect(r).toBeDefined();
    expect(r!.pass, r!.detail).toBe(true);
  });
});
