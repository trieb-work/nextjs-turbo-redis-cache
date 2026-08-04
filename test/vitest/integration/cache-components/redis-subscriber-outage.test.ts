import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  hasContainerRuntime,
  runNode,
  parseResults,
  type TestResult,
} from './scripts/redis-test-helpers';

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
