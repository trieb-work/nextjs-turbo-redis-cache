/**
 * Tag manifest matching Next.js 16.0–16.3
 * `next/dist/server/lib/cache-handlers/default.js` `updateTags`
 * and `next/dist/server/lib/incremental-cache/tags-manifest.external.js`.
 *
 * `revalidateTag(tag, profile)` resolves `cacheLife[profile].expire` (seconds)
 * and calls `updateTags(tags, { expire })`. `updateTag` / no profile calls
 * `updateTags(tags)` with no durations (immediate hard expire).
 */
export type TagManifestEntry = {
  stale?: number;
  expired?: number;
};

export function normalizeTagManifest(stored: unknown): TagManifestEntry {
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    return { expired: stored };
  }

  if (stored && typeof stored === 'object') {
    const rec = stored as {
      stale?: unknown;
      expired?: unknown;
      last?: unknown;
      pending?: unknown;
    };
    const stale =
      typeof rec.stale === 'number' && Number.isFinite(rec.stale)
        ? rec.stale
        : typeof rec.last === 'number' && Number.isFinite(rec.last)
          ? rec.last
          : undefined;
    const expired =
      typeof rec.expired === 'number' && Number.isFinite(rec.expired)
        ? rec.expired
        : typeof rec.pending === 'number' && Number.isFinite(rec.pending)
          ? rec.pending
          : undefined;
    return {
      ...(stale !== undefined ? { stale } : {}),
      ...(expired !== undefined ? { expired } : {}),
    };
  }

  return {};
}

/**
 * Mirrors Next.js DefaultCacheHandler.updateTags().
 */
export function applyTagUpdate(
  existing: TagManifestEntry,
  durations: { expire?: number } | undefined,
  now: number,
): TagManifestEntry {
  if (durations) {
    const updates = { ...existing };
    updates.stale = now;
    if (durations.expire !== undefined) {
      updates.expired = now + durations.expire * 1000;
    }
    return updates;
  }

  return {
    ...existing,
    expired: now,
  };
}

/**
 * Mirrors Next.js `areTagsExpired`: hard miss once `expired` has elapsed
 * and is newer than the entry timestamp.
 */
export function areTagsExpired(
  tags: string[],
  entryTimestamp: number,
  now: number,
  getEntry: (tag: string) => TagManifestEntry | undefined,
): boolean {
  for (const tag of tags) {
    const expiredAt = getEntry(tag)?.expired;
    if (
      typeof expiredAt === 'number' &&
      expiredAt <= now &&
      expiredAt > entryTimestamp
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Mirrors Next.js `areTagsStale`: SWR when `stale` is newer than the entry.
 */
export function areTagsStale(
  tags: string[],
  entryTimestamp: number,
  getEntry: (tag: string) => TagManifestEntry | undefined,
): boolean {
  for (const tag of tags) {
    const staleAt = getEntry(tag)?.stale ?? 0;
    if (typeof staleAt === 'number' && staleAt > entryTimestamp) {
      return true;
    }
  }
  return false;
}

/**
 * Mirrors Next.js DefaultCacheHandler.getExpiration(): max `expired` or 0.
 */
export function maxExpiredTimestamp(
  tags: string[],
  getEntry: (tag: string) => TagManifestEntry | undefined,
): number {
  let max = 0;
  for (const tag of tags) {
    const expired = getEntry(tag)?.expired || 0;
    if (expired > max) {
      max = expired;
    }
  }
  return max;
}
