import { readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'vitest';
import type { RedisClientType } from 'redis';

const SHARED_TAGS_KEY = '__sharedTags__';

/** True when the `next` dependency of the test app is at least `major.minor`. */
export function nextVersionAtLeast(
  appDir: string,
  major: number,
  minor: number,
): boolean {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8'));
  const [appMajor, appMinor] = String(pkg.dependencies.next)
    .replace(/^[^\d]*/, '')
    .split('.')
    .map(Number);
  return appMajor > major || (appMajor === major && appMinor >= minor);
}

/**
 * Finds the cache entry of a route (APP_PAGE, APP_ROUTE, PAGES) by its path.
 * Next.js 16.4+ keys these entries as
 * `/route-cache/<kind>/<sha256(sourceRoute)>/$<path>`, older versions as
 * `<path>`. The lookup expects the layout of the test app's Next.js version.
 */
export function createRouteCacheLookup(
  appDir: string,
  context: () => { redis: RedisClientType; prefix: string },
) {
  const usesRouteCacheKeys = nextVersionAtLeast(appDir, 16, 4);
  const isKeyOf = (key: string, path: string) =>
    usesRouteCacheKeys
      ? key.startsWith('/route-cache/') && key.endsWith('/$' + path)
      : key === path;

  /** Prefixed Redis keys of the route at `path`. */
  async function findRouteKeys(path: string): Promise<string[]> {
    const { redis, prefix } = context();
    const keys = await redis.keys(prefix + '*');
    return keys.filter((key) => isKeyOf(key.slice(prefix.length), path));
  }

  /** The prefixed Redis key of the route at `path`. Fails if it is missing. */
  async function getRouteKey(path: string): Promise<string> {
    const keys = await findRouteKeys(path);
    expect(keys).toHaveLength(1);
    return keys[0]!;
  }

  /** Tags in the shared tags map for the route at `path`, if any. */
  async function findRouteSharedTags(
    path: string,
  ): Promise<string[] | undefined> {
    const { redis, prefix } = context();
    const sharedTags = await redis.hGetAll(prefix + SHARED_TAGS_KEY);
    const entries = Object.entries(sharedTags).filter(([key]) =>
      isKeyOf(key, path),
    );
    expect(entries.length).toBeLessThanOrEqual(1);
    return entries[0] ? (JSON.parse(entries[0][1]) as string[]) : undefined;
  }

  return { findRouteKeys, getRouteKey, findRouteSharedTags };
}
