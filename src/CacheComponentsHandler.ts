import { commandOptions, createClient } from 'redis';
import type { RedisClientOptions } from 'redis';
import {
  Client,
  CreateRedisStringsHandlerOptions,
  redisErrorHandler,
} from './RedisStringsHandler';
import { SyncedMap } from './SyncedMap';
import { DeduplicatedRequestHandler } from './DeduplicatedRequestHandler';
import { debug } from './utils/debug';
import { resolveKeyPrefix } from './utils/prefix';
import { shouldDeferRedisConnection } from './utils/redisConnection';
import {
  applyTagUpdate,
  areTagsExpired,
  areTagsStale,
  maxExpiredTimestamp,
  normalizeTagManifest,
  persistableTagManifest,
  type TagManifestEntry,
} from './utils/tagRevalidation';

export interface CacheComponentsEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

export interface CacheComponentsHandler {
  get(
    cacheKey: string,
    softTags: string[],
  ): Promise<CacheComponentsEntry | undefined>;
  set(
    cacheKey: string,
    pendingEntry: Promise<CacheComponentsEntry>,
  ): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

type StoredCacheEntry = Omit<CacheComponentsEntry, 'value'> & {
  value: Uint8Array | string;
};

const REVALIDATED_TAGS_KEY = '__cacheComponents_revalidated_tags__';
const SHARED_TAGS_KEY = '__cacheComponents_sharedTags__';

let killContainerOnErrorCount = 0;

export type CreateCacheComponentsHandlerOptions =
  CreateRedisStringsHandlerOptions & { serverDistDir?: string };

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
    }
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function bufferToReadableStream(
  buffer: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

class RedisCacheComponentsHandler implements CacheComponentsHandler {
  private client: Client;
  private revalidatedTagsMap: SyncedMap<TagManifestEntry | number>;
  private sharedTagsMap: SyncedMap<string[]>;
  private inMemoryDeduplicationCache: SyncedMap<
    Promise<ReturnType<Client['get']>>
  >;
  private keyPrefix: string;
  private getTimeoutMs: number;
  private redisGet: Client['get'];
  private redisDeduplicationHandler: DeduplicatedRequestHandler<
    Client['get'],
    string | Buffer | null
  >;
  private deduplicatedRedisGet: (key: string) => Client['get'];
  private redisGetDeduplication: boolean;
  private inMemoryCachingTime: number;
  private redisConnectionDeferred: boolean;

  constructor({
    redisUrl = process.env.REDIS_URL
      ? process.env.REDIS_URL
      : process.env.REDISHOST
        ? `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`
        : 'redis://localhost:6379',
    database = process.env.VERCEL_ENV === 'production' ? 0 : 1,
    keyPrefix,
    getTimeoutMs = process.env.REDIS_COMMAND_TIMEOUT_MS
      ? (Number.parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS) ?? 500)
      : 500,
    revalidateTagQuerySize = 250,
    avgResyncIntervalMs = 60 * 60 * 1_000,
    redisGetDeduplication = true,
    inMemoryCachingTime = 10_000,
    socketOptions,
    clientOptions,
    killContainerOnErrorThreshold = process.env
      .KILL_CONTAINER_ON_ERROR_THRESHOLD
      ? (Number.parseInt(process.env.KILL_CONTAINER_ON_ERROR_THRESHOLD) ?? 0)
      : 0,
    serverDistDir,
  }: CreateCacheComponentsHandlerOptions) {
    try {
      this.keyPrefix = resolveKeyPrefix({
        optionKeyPrefix: keyPrefix,
        serverDistDir,
        env: process.env,
      });
      this.getTimeoutMs = getTimeoutMs;
      this.redisGetDeduplication = redisGetDeduplication;
      this.inMemoryCachingTime = inMemoryCachingTime;
      this.redisConnectionDeferred = shouldDeferRedisConnection();

      this.client = createClient({
        url: redisUrl,
        pingInterval: 10_000,
        ...(database !== 0 ? { database } : {}),
        ...(socketOptions
          ? { socket: { ...socketOptions } as RedisClientOptions['socket'] }
          : {}),
        ...(clientOptions || {}),
      });

      this.client.on('error', (error) => {
        console.error(
          'RedisCacheComponentsHandler client error',
          error,
          killContainerOnErrorCount++,
        );
        setTimeout(() => {
          // node-redis throws "Socket already opened" if connect() is called while a socket is already open.
          // When we get an error while isOpen=true (but isReady=false), we should *not* force an extra connect.
          if (this.client.isOpen) return;

          this.client.connect().catch((err) => {
            console.error(
              'Failed to reconnect RedisCacheComponentsHandler client after connection loss:',
              err,
            );
          });
        }, 1000);
        if (
          killContainerOnErrorThreshold > 0 &&
          killContainerOnErrorCount >= killContainerOnErrorThreshold
        ) {
          console.error(
            'RedisCacheComponentsHandler client error threshold reached, disconnecting and exiting (please implement a restart process/container watchdog to handle this error)',
            error,
            killContainerOnErrorCount++,
          );
          this.client.disconnect();
          this.client.quit();
          setTimeout(() => {
            process.exit(1);
          }, 500);
        }
      });

      if (!this.redisConnectionDeferred) {
        this.client
          .connect()
          .then(() => {
            debug('green', 'RedisCacheComponentsHandler client connected.');
          })
          .catch(() => {
            this.client.connect().catch((error) => {
              console.error(
                'Failed to connect RedisCacheComponentsHandler client:',
                error,
              );
              this.client.disconnect();
              throw error;
            });
          });
      }

      const filterKeys = (key: string): boolean =>
        key !== REVALIDATED_TAGS_KEY && key !== SHARED_TAGS_KEY;

      this.revalidatedTagsMap = new SyncedMap<TagManifestEntry | number>({
        client: this.client,
        keyPrefix: this.keyPrefix,
        redisKey: REVALIDATED_TAGS_KEY,
        database,
        querySize: revalidateTagQuerySize,
        filterKeys,
        customizedSync: { withoutOrphanCleanup: true },
        resyncIntervalMs:
          avgResyncIntervalMs +
          avgResyncIntervalMs / 10 +
          Math.random() * (avgResyncIntervalMs / 10),
      });

      this.sharedTagsMap = new SyncedMap<string[]>({
        client: this.client,
        keyPrefix: this.keyPrefix,
        redisKey: SHARED_TAGS_KEY,
        database,
        querySize: revalidateTagQuerySize,
        filterKeys,
        resyncIntervalMs:
          avgResyncIntervalMs -
          avgResyncIntervalMs / 10 +
          Math.random() * (avgResyncIntervalMs / 10),
      });

      this.inMemoryDeduplicationCache = new SyncedMap({
        client: this.client,
        keyPrefix: this.keyPrefix,
        redisKey: '__cacheComponents_inMemoryDeduplicationCache__',
        database,
        querySize: revalidateTagQuerySize,
        filterKeys,
        customizedSync: {
          withoutRedisHashmap: true,
          withoutSetSync: true,
        },
      });

      const redisGet: Client['get'] = this.client.get.bind(this.client);
      this.redisDeduplicationHandler = new DeduplicatedRequestHandler(
        redisGet,
        inMemoryCachingTime,
        this.inMemoryDeduplicationCache,
      );
      this.redisGet = redisGet;
      this.deduplicatedRedisGet =
        this.redisDeduplicationHandler.deduplicatedFunction;
    } catch (error) {
      console.error('RedisCacheComponentsHandler constructor error', error);
      throw error;
    }
  }

  private async assertClientIsReady(): Promise<void> {
    if (this.redisConnectionDeferred) {
      await Promise.all([
        this.revalidatedTagsMap.waitUntilReady(),
        this.sharedTagsMap.waitUntilReady(),
      ]);
      return;
    }

    if (!this.client.isReady && !this.client.isOpen) {
      await this.client.connect().catch((error) => {
        console.error(
          'RedisCacheComponentsHandler assertClientIsReady reconnect error:',
          error,
        );
        throw error;
      });
    }
    await Promise.all([
      this.revalidatedTagsMap.waitUntilReady(),
      this.sharedTagsMap.waitUntilReady(),
    ]);
  }

  private isClientUnavailable(): boolean {
    return this.redisConnectionDeferred || !this.client.isReady;
  }

  private tagManifestFor(tag: string, now = Date.now()): TagManifestEntry {
    return normalizeTagManifest(this.revalidatedTagsMap.get(tag), now);
  }

  async get(
    cacheKey: string,
    _softTags: string[],
  ): Promise<CacheComponentsEntry | undefined> {
    // Soft-tag staleness is handled by Next.js via getExpiration() (implicit
    // `_N_T_` tags). Explicit cacheTag()s are checked below via the tag
    // manifest, matching DefaultCacheHandler.get() in Next.js 16.0–16.3.
    void _softTags;

    // Construct the full Redis key
    // For cache components, Next.js provides the full key including environment prefix
    // We prepend our keyPrefix for multi-tenant isolation
    const redisKey = `${this.keyPrefix}${cacheKey}`;

    try {
      await this.assertClientIsReady();
      if (this.isClientUnavailable()) {
        return undefined;
      }

      const readSerialized = (useDedup: boolean) =>
        redisErrorHandler(
          'RedisCacheComponentsHandler.get(), operation: get' +
            (useDedup ? ' deduplicated' : '') +
            ' ' +
            this.getTimeoutMs +
            'ms ' +
            redisKey,
          (useDedup ? this.deduplicatedRedisGet(cacheKey) : this.redisGet)(
            commandOptions({ signal: AbortSignal.timeout(this.getTimeoutMs) }),
            redisKey,
          ),
        );

      let usedDedup = this.redisGetDeduplication;
      let serialized = await readSerialized(usedDedup);

      for (let attempt = 0; attempt < 2; attempt++) {
        if (!serialized) {
          return undefined;
        }

        const stored: StoredCacheEntry = JSON.parse(serialized);
        const now = Date.now();
        const tags = stored.tags || [];
        const expiryTime = stored.timestamp + stored.expire * 1000;
        const ttlExpired =
          Number.isFinite(stored.expire) &&
          stored.expire > 0 &&
          now > expiryTime;
        const tagsExpired = areTagsExpired(tags, stored.timestamp, now, (tag) =>
          this.tagManifestFor(tag, now),
        );

        if (ttlExpired || tagsExpired) {
          if (usedDedup) {
            usedDedup = false;
            serialized = await readSerialized(false);
            continue;
          }

          const current = await this.redisGet(
            commandOptions({ signal: AbortSignal.timeout(this.getTimeoutMs) }),
            redisKey,
          );
          if (current === serialized) {
            await this.client.unlink(redisKey).catch(() => {});
            await this.sharedTagsMap.delete(cacheKey).catch(() => {});
          }
          return undefined;
        }

        const valueBuffer =
          typeof stored.value === 'string'
            ? new Uint8Array(Buffer.from(stored.value, 'base64'))
            : stored.value;

        const entry: CacheComponentsEntry = {
          ...stored,
          value: bufferToReadableStream(valueBuffer),
        };

        if (
          areTagsStale(tags, stored.timestamp, (tag) =>
            this.tagManifestFor(tag, now),
          )
        ) {
          entry.revalidate = -1;
        }

        return entry;
      }

      return undefined;
    } catch (error) {
      console.error(
        'RedisCacheComponentsHandler.get() Error occurred while getting cache entry. Returning undefined so site can continue to serve content while cache is disabled. The original error was:',
        error,
        killContainerOnErrorCount++,
      );
      return undefined;
    }
  }

  async set(
    cacheKey: string,
    pendingEntry: Promise<CacheComponentsEntry>,
  ): Promise<void> {
    try {
      await this.assertClientIsReady();
      if (this.isClientUnavailable()) {
        return;
      }

      const entry = await pendingEntry;

      const [storeStream] = entry.value.tee();

      // Don't mutate entry.value as Next.js may still be using it internally
      // entry.value = forwardStream;

      const buffer = await streamToBuffer(storeStream);

      const stored: StoredCacheEntry = {
        value: Buffer.from(buffer).toString('base64'),
        tags: entry.tags || [],
        stale: entry.stale,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate: entry.revalidate,
      };

      let serialized: string;
      try {
        const cleanStored = {
          value: stored.value,
          tags: Array.isArray(stored.tags) ? [...stored.tags] : [],
          stale: Number(stored.stale),
          timestamp: Number(stored.timestamp),
          expire: Number(stored.expire),
          revalidate: Number(stored.revalidate),
        };
        serialized = JSON.stringify(cleanStored);
      } catch (jsonError) {
        console.error('JSON.stringify error:', jsonError);
        console.error('Stored object:', stored);
        throw jsonError;
      }

      if (this.redisGetDeduplication) {
        this.redisDeduplicationHandler.seedRequestReturn(cacheKey, serialized);
      }

      // expire is already a duration in seconds, use it directly
      const ttlSeconds =
        Number.isFinite(stored.expire) && stored.expire > 0
          ? Math.floor(stored.expire)
          : undefined;

      const redisKey = `${this.keyPrefix}${cacheKey}`;

      const setOperation = redisErrorHandler(
        'RedisCacheComponentsHandler.set(), operation: set ' + redisKey,
        this.client.set(redisKey, serialized, {
          ...(ttlSeconds ? { EX: ttlSeconds } : {}),
        }),
      );

      let tagsOperation: Promise<void> | undefined;
      const tags = stored.tags || [];
      if (tags.length > 0) {
        const currentTags = this.sharedTagsMap.get(cacheKey);
        const currentIsSameAsNew =
          currentTags?.length === tags.length &&
          currentTags.every((v) => tags.includes(v)) &&
          tags.every((v) => currentTags!.includes(v));

        if (!currentIsSameAsNew) {
          tagsOperation = this.sharedTagsMap.set(cacheKey, [...tags]);
        }
      }

      await Promise.all([setOperation, tagsOperation]);
    } catch (error) {
      console.error(
        'RedisCacheComponentsHandler.set() Error occurred while setting cache entry. The original error was:',
        error,
        killContainerOnErrorCount++,
      );
      throw error;
    }
  }

  async refreshTags(): Promise<void> {
    await this.assertClientIsReady();
  }

  async getExpiration(tags: string[]): Promise<number> {
    try {
      await this.assertClientIsReady();
      return maxExpiredTimestamp(tags || [], (tag) => this.tagManifestFor(tag));
    } catch (error) {
      console.error(
        'RedisCacheComponentsHandler.getExpiration() Error occurred while getting expiration for tags. The original error was:',
        error,
      );
      return 0;
    }
  }

  async updateTags(
    tags: string[],
    durations?: { expire?: number },
  ): Promise<void> {
    try {
      await this.assertClientIsReady();
      if (this.isClientUnavailable()) {
        return;
      }

      const now = Date.now();
      const updated = new Set(tags || []);
      for (const tag of updated) {
        const next = applyTagUpdate(this.tagManifestFor(tag), durations, now);
        await this.revalidatedTagsMap.set(
          tag,
          persistableTagManifest(next, now),
        );
      }

      if (this.redisGetDeduplication && this.inMemoryCachingTime > 0) {
        for (const [key, sharedTags] of this.sharedTagsMap.entries()) {
          if (sharedTags.some((tag) => updated.has(tag))) {
            await this.inMemoryDeduplicationCache.delete(key, true);
          }
        }
      }
    } catch (error) {
      console.error(
        'RedisCacheComponentsHandler.updateTags() Error occurred while updating tags. The original error was:',
        error,
        killContainerOnErrorCount++,
      );
      throw error;
    }
  }
}

let singletonHandler: CacheComponentsHandler | undefined;

export function getRedisCacheComponentsHandler(
  options: CreateCacheComponentsHandlerOptions = {},
): CacheComponentsHandler {
  if (!singletonHandler) {
    singletonHandler = new RedisCacheComponentsHandler(options);
  }
  return singletonHandler;
}

// Lazily resolve the default Cache Components handler.
//
// Constructing a RedisCacheComponentsHandler opens a Redis connection in its
// constructor. Building the singleton at module-eval time therefore means that simply
// *importing this package* — e.g. only for `RedisStringsHandler` (the legacy
// `cacheHandler`), with Cache Components never enabled — eagerly connects to Redis,
// defaulting to `redis://localhost:6379` when neither `REDIS_URL` nor `REDISHOST` is
// set. In a deployment whose Redis is not on localhost that yields a non-stop
// `RedisCacheComponentsHandler client error ECONNREFUSED 127.0.0.1:6379` reconnect
// loop, and it also makes a consumer's later `getRedisCacheComponentsHandler(options)`
// a no-op, because the singleton was already built with defaults (see #84).
//
// Defer construction to first use via a Proxy: importing the package never connects, a
// consumer that configures the handler via `getRedisCacheComponentsHandler(options)`
// before it is first used has that configuration honored, and a consumer that never
// touches Cache Components never opens a Redis connection at all.
let resolvedHandler: CacheComponentsHandler | undefined;

export const redisCacheHandler: CacheComponentsHandler = new Proxy(
  {} as CacheComponentsHandler,
  {
    get(_target, prop) {
      if (!resolvedHandler) {
        resolvedHandler = getRedisCacheComponentsHandler();
      }
      const value = resolvedHandler[prop as keyof CacheComponentsHandler];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(resolvedHandler)
        : value;
    },
    has(_target, prop) {
      return prop in RedisCacheComponentsHandler.prototype;
    },
  },
);
