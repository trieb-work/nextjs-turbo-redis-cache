/**
 * Per-tag revalidation state stored in `revalidatedTagsMap` (Cache Components).
 *
 * Next.js treats a cache entry as stale when `getExpiration(tags)` is greater
 * than the entry timestamp. `revalidateTag(tag, 'max')` must therefore record
 * `Date.now()` immediately — `durations.expire` is the SWR stale-serve window,
 * not a delay before the tag becomes stale.
 *
 * Values may be a legacy number or `{ last, pending }`. `pending` is only
 * folded in once elapsed so older records stay readable.
 */
export type TagRevalidationState = {
  last: number;
  pending: number;
};

export function normalizeTagRevalidation(
  stored: unknown,
  now: number,
): TagRevalidationState {
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    return stored > now
      ? { last: 0, pending: stored }
      : { last: stored, pending: 0 };
  }

  if (stored && typeof stored === 'object') {
    const rec = stored as { last?: unknown; pending?: unknown };
    const last =
      typeof rec.last === 'number' && Number.isFinite(rec.last) ? rec.last : 0;
    const pending =
      typeof rec.pending === 'number' && Number.isFinite(rec.pending)
        ? rec.pending
        : 0;
    return { last, pending };
  }

  return { last: 0, pending: 0 };
}

export function effectiveRevalidationTimestamp(
  state: TagRevalidationState,
  now: number,
): number {
  let last = state.last;
  if (state.pending > 0 && state.pending <= now) {
    last = Math.max(last, state.pending);
  }
  return last;
}

export function applyImmediateRevalidation(now: number): TagRevalidationState {
  return { last: now, pending: 0 };
}

/**
 * `revalidateTag(tag)` / `updateTag(tag)` / `{ expire: 0 }` are blocking
 * misses. Any positive `expire` (including cacheLife `'max'` ~1y) is SWR:
 * mark stale now, keep Redis entries so `get()` can serve them.
 */
export function isHardTagExpiration(expire?: number): boolean {
  return expire === undefined || expire === 0;
}
