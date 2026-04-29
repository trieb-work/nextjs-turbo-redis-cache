/**
 * Pluggable wire-format codec for Redis string values used by `RedisStringsHandler`.
 *
 * The serializer is the single point at which an in-memory `CacheEntry` becomes the
 * string written to Redis (and back). Plugging in a custom serializer lets you add
 * compression (gzip/brotli), encryption, or any other custom encoding without forking
 * this package or losing the existing dedup / batch / keyspace features.
 *
 * Both `serialize` and `deserialize` may return either a value directly or a `Promise`,
 * which enables non-blocking async codecs such as stream-based compression
 * (`zlib.brotliCompress`) or encryption (`crypto.subtle`). Synchronous implementations
 * continue to work unchanged - awaiting a plain value is a no-op.
 *
 * The default export {@link jsonCacheValueSerializer} is `JSON.stringify` /
 * `JSON.parse` paired with {@link bufferAndMapReplacer} / {@link bufferAndMapReviver},
 * so native `Buffer` and `Map` values inside a `CacheEntry` round-trip transparently
 * (this is required for Next.js RSC payloads).
 *
 * Operational note: changing the serializer (or any of its parameters such as a
 * compression level or encryption key) makes existing Redis keys unreadable, because
 * the deserializer will fail or return `null` for entries written by the previous
 * format. Either flush the affected keys, bump `keyPrefix`, or migrate values
 * out-of-band before deploying a new serializer.
 */
import type { CacheEntry } from './RedisStringsHandler';
import { bufferAndMapReplacer, bufferAndMapReviver } from './utils/json';

export type CacheValueSerializer = {
  /**
   * Encode an in-memory `CacheEntry` into the string written to Redis.
   * May return a `Promise` for async codecs (e.g. compression, encryption).
   */
  serialize(value: CacheEntry): string | Promise<string>;
  /**
   * Decode a string read from Redis back into a `CacheEntry`.
   * Returning `null` (or a `Promise<null>`) signals "treat as cache miss" -
   * the handler will return `null` from `get()` without surfacing an error.
   * May return a `Promise` for async codecs.
   */
  deserialize(stored: string): CacheEntry | null | Promise<CacheEntry | null>;
};

/**
 * Default serializer used by `RedisStringsHandler` when no `valueSerializer` is
 * configured. Wraps `JSON.stringify` / `JSON.parse` with this package's
 * {@link bufferAndMapReplacer} / {@link bufferAndMapReviver} so native `Buffer`
 * and `Map` values inside a `CacheEntry` survive the round-trip.
 *
 * Exported as a singleton so consumers can compare against the default by
 * reference (e.g. to detect that no custom serializer was configured).
 */
export const jsonCacheValueSerializer: CacheValueSerializer = {
  serialize(value) {
    return JSON.stringify(value, bufferAndMapReplacer);
  },
  deserialize(stored) {
    return JSON.parse(stored, bufferAndMapReviver) as CacheEntry | null;
  },
};
