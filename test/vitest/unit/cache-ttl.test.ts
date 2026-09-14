import { describe, it, expect } from 'vitest';
import { resolveCacheEntryTtlSeconds } from '../../../src/utils/cacheTtl';

const estimateExpireAge = (staleAge: number) => staleAge * 1.2;
const defaultStaleAge = 60 * 60 * 24 * 14;

describe('resolveCacheEntryTtlSeconds', () => {
  it('prefers cacheControl.expire over revalidate (SWR-safe TTL)', () => {
    const ttl = resolveCacheEntryTtlSeconds(
      { cacheControl: { revalidate: 60, expire: 3600 } },
      { kind: 'APP_PAGE' },
      { estimateExpireAge, defaultStaleAge },
    );

    expect(ttl).toBe(3600);
  });

  it('falls back to estimateExpireAge(revalidate) when expire is omitted', () => {
    const ttl = resolveCacheEntryTtlSeconds(
      { cacheControl: { revalidate: 60, expire: undefined } },
      { kind: 'PAGES' },
      { estimateExpireAge, defaultStaleAge },
    );

    expect(ttl).toBe(72);
  });

  it('uses FETCH data.revalidate when cacheControl is absent', () => {
    const ttl = resolveCacheEntryTtlSeconds(
      {},
      { kind: 'FETCH', revalidate: 30 },
      { estimateExpireAge, defaultStaleAge },
    );

    expect(ttl).toBe(36);
  });

  it('uses defaultStaleAge when revalidate is false', () => {
    const ttl = resolveCacheEntryTtlSeconds(
      { cacheControl: { revalidate: false, expire: undefined } },
      { kind: 'PAGES' },
      { estimateExpireAge, defaultStaleAge },
    );

    expect(ttl).toBe(estimateExpireAge(defaultStaleAge));
  });

  it('returns undefined when no expire or revalidate is provided', () => {
    const ttl = resolveCacheEntryTtlSeconds(
      { cacheControl: { revalidate: undefined, expire: undefined } },
      { kind: 'APP_ROUTE' },
      { estimateExpireAge, defaultStaleAge },
    );

    expect(ttl).toBeUndefined();
  });

  it('supports legacy ctx.revalidate (Next.js 15.0.3)', () => {
    const ttl = resolveCacheEntryTtlSeconds(
      { revalidate: 60 },
      { kind: 'PAGES' },
      { estimateExpireAge, defaultStaleAge },
    );

    expect(ttl).toBe(72);
  });
});
