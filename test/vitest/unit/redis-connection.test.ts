import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PHASE_PRODUCTION_BUILD,
  shouldDeferRedisConnection,
} from '../../../src/utils/redisConnection';

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

  it('returns true when NEXT_PHASE is phase-production-build', () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    expect(shouldDeferRedisConnection()).toBe(true);
  });

  it('returns false for other Next.js phases', () => {
    process.env.NEXT_PHASE = 'phase-production-server';
    expect(shouldDeferRedisConnection()).toBe(false);
  });

  it('uses the Next.js PHASE_PRODUCTION_BUILD string', () => {
    expect(PHASE_PRODUCTION_BUILD).toBe('phase-production-build');
  });
});
