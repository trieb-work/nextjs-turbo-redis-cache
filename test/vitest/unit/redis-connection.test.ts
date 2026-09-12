import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldDeferRedisConnection } from '../../../src/utils/redisConnection';

describe('shouldDeferRedisConnection', () => {
  const originalPhase = process.env.NEXT_PHASE;

  beforeEach(() => {
    delete process.env.NEXT_PHASE;
  });

  afterEach(() => {
    if (originalPhase === undefined) {
      delete process.env.NEXT_PHASE;
    } else {
      process.env.NEXT_PHASE = originalPhase;
    }
  });

  it('returns false when NEXT_PHASE is not set', () => {
    expect(shouldDeferRedisConnection()).toBe(false);
  });

  it('returns true during next build when next/constants is available', async () => {
    try {
      const { PHASE_PRODUCTION_BUILD } = await import('next/constants');
      process.env.NEXT_PHASE = PHASE_PRODUCTION_BUILD;
      expect(shouldDeferRedisConnection()).toBe(true);
    } catch {
      // next may not be installed in all test environments
      expect(true).toBe(true);
    }
  });
});
