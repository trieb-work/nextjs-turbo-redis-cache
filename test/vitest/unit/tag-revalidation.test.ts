import { describe, it, expect } from 'vitest';
import {
  applyTagUpdate,
  areTagsExpired,
  areTagsStale,
  maxExpiredTimestamp,
  normalizeTagManifest,
  persistableTagManifest,
  type TagManifestEntry,
} from '../../../src/utils/tagRevalidation';

// Expire seconds from next/dist/server/config-shared.js cacheLife presets
// (identical in Next.js 16.0.11, 16.2.6, 16.3.0).
const CACHE_LIFE_EXPIRE_SECONDS = {
  default: 0xfffffffe, // INFINITE_CACHE in next/dist/lib/constants.js
  seconds: 60,
  minutes: 60 * 60,
  hours: 60 * 60 * 24,
  days: 60 * 60 * 24 * 7,
  weeks: 60 * 60 * 24 * 30,
  max: 60 * 60 * 24 * 365,
};

describe('applyTagUpdate (Next.js DefaultCacheHandler.updateTags)', () => {
  const now = 1_000_000;

  it('with no durations sets expired=now and does not set stale', () => {
    expect(applyTagUpdate({ stale: 9 }, undefined, now)).toEqual({
      stale: 9,
      expired: now,
    });
  });

  it('with { expire: 0 } sets stale=now and expired=now (blocking miss)', () => {
    expect(applyTagUpdate({}, { expire: 0 }, now)).toEqual({
      stale: now,
      expired: now,
    });
  });

  it('with { expire: N } sets stale=now and expired=now+N*1000 (SWR window)', () => {
    expect(applyTagUpdate({}, { expire: 2 }, now)).toEqual({
      stale: now,
      expired: now + 2_000,
    });
  });

  it('uses each built-in cacheLife expire for revalidateTag(tag, profile)', () => {
    for (const [profile, expire] of Object.entries(CACHE_LIFE_EXPIRE_SECONDS)) {
      const result = applyTagUpdate({}, { expire }, now);
      expect(result.stale, profile).toBe(now);
      expect(result.expired, profile).toBe(now + expire * 1000);
    }
  });

  it('with durations but expire undefined only marks stale (keeps prior expired)', () => {
    expect(applyTagUpdate({ expired: 50 }, { expire: undefined }, now)).toEqual(
      { stale: now, expired: 50 },
    );
  });
});

describe('areTagsExpired / areTagsStale (Next.js tags-manifest.external)', () => {
  const lookup = (entry: { stale?: number; expired?: number }) => () => entry;

  it('hard-expires when expired has elapsed and is newer than the entry', () => {
    expect(areTagsExpired(['t'], 100, 1_000, lookup({ expired: 500 }))).toBe(
      true,
    );
  });

  it('does not hard-expire while expired is still in the future', () => {
    expect(areTagsExpired(['t'], 100, 1_000, lookup({ expired: 2_000 }))).toBe(
      false,
    );
  });

  it('does not hard-expire when expiredAt equals the entry timestamp', () => {
    expect(areTagsExpired(['t'], 500, 1_000, lookup({ expired: 500 }))).toBe(
      false,
    );
  });

  it('does not hard-expire entries created after the expired timestamp', () => {
    expect(
      areTagsExpired(['t'], 2_000, 3_000, lookup({ expired: 1_000 })),
    ).toBe(false);
  });

  it('is stale when stale is newer than the entry timestamp', () => {
    expect(areTagsStale(['t'], 100, lookup({ stale: 500 }))).toBe(true);
  });

  it('is not stale when stale is older than the entry', () => {
    expect(areTagsStale(['t'], 1_000, lookup({ stale: 500 }))).toBe(false);
  });
});

describe('maxExpiredTimestamp (Next.js getExpiration)', () => {
  it('returns 0 when no tag was expired', () => {
    expect(maxExpiredTimestamp(['a'], () => ({}))).toBe(0);
  });

  it('returns a future expired timestamp (SWR window has not elapsed)', () => {
    expect(
      maxExpiredTimestamp(['a'], () => ({ stale: 1, expired: 9_000 })),
    ).toBe(9_000);
  });
});

describe('normalizeTagManifest', () => {
  it('reads Next.js { stale, expired } records', () => {
    expect(normalizeTagManifest({ stale: 1, expired: 2 })).toEqual({
      stale: 1,
      expired: 2,
    });
  });

  it('maps a legacy numeric timestamp to expired', () => {
    expect(normalizeTagManifest(1_234)).toEqual({ expired: 1_234 });
  });
});

describe('legacy plain numbers (rolling upgrade, not Next.js)', () => {
  const lookup = (entry: TagManifestEntry | undefined) => (tag: string) =>
    tag === 't' ? entry : undefined;

  it('past plain number hard-expires entries older than the revalidation', () => {
    const revalidatedAt = 500;
    const manifest = normalizeTagManifest(revalidatedAt);

    expect(areTagsExpired(['t'], 100, 1_000, lookup(manifest))).toBe(true);
    expect(areTagsStale(['t'], 100, lookup(manifest))).toBe(false);
  });

  it('clamps future plain numbers to now (cross-instance clock skew)', () => {
    // Instance A (clock ahead) wrote Date.now() = 1_005_000 into Redis.
    // This reader's clock is still at 1_000_000 — clamp treats it as now.
    const manifest = normalizeTagManifest(1_005_000, 1_000_000);

    expect(manifest).toEqual({ expired: 1_000_000 });
    expect(areTagsExpired(['t'], 900_000, 1_000_000, lookup(manifest))).toBe(
      true,
    );
  });

  it('intentional SWR uses stale + future expired, not a plain number', () => {
    const now = 1_000_000;
    const swr = applyTagUpdate({}, { expire: 2 }, now);

    expect(swr).toEqual({ stale: now, expired: now + 2_000 });
    expect(areTagsStale(['t'], 900_000, lookup(swr))).toBe(true);
    expect(areTagsExpired(['t'], 900_000, now + 500, lookup(swr))).toBe(false);
  });
});

describe('persistableTagManifest', () => {
  const now = 1_000_000;

  it('writes a plain number for immediate hard-expires (rolling-upgrade readers)', () => {
    expect(persistableTagManifest({ expired: now }, now)).toBe(now);
    expect(persistableTagManifest({ stale: now, expired: now }, now)).toBe(now);
  });

  it('keeps { stale, expired } objects for SWR windows', () => {
    const swr = { stale: now, expired: now + 2_000 };
    expect(persistableTagManifest(swr, now)).toEqual(swr);
  });
});
