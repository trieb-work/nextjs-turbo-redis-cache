import CachedHandler from './CachedHandler';
export default CachedHandler;

import RedisStringsHandler from './RedisStringsHandler';
export { RedisStringsHandler };
export type { CreateRedisStringsHandlerOptions } from './RedisStringsHandler';

export { jsonCacheValueSerializer } from './serializer';
export type { CacheValueSerializer } from './serializer';
export { bufferAndMapReplacer, bufferAndMapReviver } from './utils/json';
export { resolveCacheEntryTtlSeconds } from './utils/cacheTtl';
export type {
  ResolveCacheEntryTtlContext,
  ResolveCacheEntryTtlData,
  ResolveCacheEntryTtlOptions,
} from './utils/cacheTtl';
export { shouldDeferRedisConnection } from './utils/redisConnection';

import {
  redisCacheHandler,
  getRedisCacheComponentsHandler,
} from './CacheComponentsHandler';
export { redisCacheHandler, getRedisCacheComponentsHandler };
