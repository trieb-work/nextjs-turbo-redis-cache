import { describe, it, expect } from 'vitest';
import {
  applyImmediateRevalidation,
  effectiveRevalidationTimestamp,
  isHardTagExpiration,
  normalizeTagRevalidation,
} from '../../../src/utils/tagRevalidation';

describe('normalizeTagRevalidation', () => {
  it('treats a legacy past timestamp as last', () => {
    expect(normalizeTagRevalidation(1_000, 2_000)).toEqual({
      last: 1_000,
      pending: 0,
    });
  });

  it('treats a legacy future timestamp as pending', () => {
    expect(normalizeTagRevalidation(3_000, 2_000)).toEqual({
      last: 0,
      pending: 3_000,
    });
  });

  it('reads last + pending objects', () => {
    expect(normalizeTagRevalidation({ last: 10, pending: 20 }, 15)).toEqual({
      last: 10,
      pending: 20,
    });
  });

  it('defaults missing or invalid values to zero', () => {
    expect(normalizeTagRevalidation(undefined, 1)).toEqual({
      last: 0,
      pending: 0,
    });
    expect(normalizeTagRevalidation({ last: 'x', pending: NaN }, 1)).toEqual({
      last: 0,
      pending: 0,
    });
  });
});

describe('effectiveRevalidationTimestamp', () => {
  it('returns last while pending is still in the future', () => {
    expect(
      effectiveRevalidationTimestamp({ last: 1_000, pending: 5_000 }, 4_999),
    ).toBe(1_000);
  });

  it('returns the pending timestamp once it has elapsed', () => {
    expect(
      effectiveRevalidationTimestamp({ last: 0, pending: 5_000 }, 5_000),
    ).toBe(5_000);
  });
});

describe('applyImmediateRevalidation', () => {
  it('clears any pending deadline', () => {
    expect(applyImmediateRevalidation(9_000)).toEqual({
      last: 9_000,
      pending: 0,
    });
  });
});

describe('isHardTagExpiration', () => {
  it('treats omitted expire and expire 0 as blocking misses', () => {
    expect(isHardTagExpiration(undefined)).toBe(true);
    expect(isHardTagExpiration(0)).toBe(true);
  });

  it('treats positive expire including cacheLife max as SWR', () => {
    expect(isHardTagExpiration(2)).toBe(false);
    expect(isHardTagExpiration(60 * 60 * 24 * 365)).toBe(false);
    expect(isHardTagExpiration(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
