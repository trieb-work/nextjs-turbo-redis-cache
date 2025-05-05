import { commandOptions, createClient } from 'redis';
import { SyncedMap } from './SyncedMap';
import { DeduplicatedRequestHandler } from './DeduplicatedRequestHandler';
import { debug } from './debug';

export type CommandOptions = ReturnType<typeof commandOptions>;
export type Client = ReturnType<typeof createClient>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bufferReviver(_: string, value: any): any {
  if (value && typeof value === 'object' && typeof value.$binary === 'string') {
    return Buffer.from(value.$binary, 'base64');
  }
  return value;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bufferReplacer(_: string, value: any): any {
  if (Buffer.isBuffer(value)) {
    return {
      $binary: value.toString('base64'),
    };
  }
  if (
    value &&
    typeof value === 'object' &&
    value?.type === 'Buffer' &&
    Array.isArray(value.data)
  ) {
    return {
      $binary: Buffer.from(value.data).toString('base64'),
    };
  }
  return value;
}

type CacheEntry = {
  value: unknown;
  lastModified: number;
  tags: string[];
};

export type CreateRedisStringsHandlerOptions = {
  /** Redis database number to use. Uses DB 0 for production, DB 1 otherwise
   * @default process.env.VERCEL_ENV === 'production' ? 0 : 1
   */
  database?: number;
  /** Prefix added to all Redis keys
   * @default process.env.VERCEL_URL || 'UNDEFINED_URL_'
   */
  keyPrefix?: string;
  /** Timeout in milliseconds for Redis operations
   * @default 5000
   */
  timeoutMs?: number;
  /** Number of entries to query in one batch during full sync of shared tags hash map
   * @default 250
   */
  revalidateTagQuerySize?: number;
  /** Key used to store shared tags hash map in Redis
   * @default '__sharedTags__'
   */
  sharedTagsKey?: string;
  /** Average interval in milliseconds between tag map full re-syncs
   * @default 3600000 (1 hour)
   */
  avgResyncIntervalMs?: number;
  /** Enable deduplication of Redis get requests via internal in-memory cache
   * @default true
   */
  redisGetDeduplication?: boolean;
  /** Time in milliseconds to cache Redis get results in memory. Set this to 0 to disable in-memory caching completely
   * @default 10000
   */
  inMemoryCachingTime?: number;
  /** Default stale age in seconds for cached items
   * @default 1209600 (14 days)
   */
  defaultStaleAge?: number;
  /** Function to calculate expire age (redis TTL value) from stale age
   * @default Production: staleAge * 2, Other: staleAge * 1.2
   */
  estimateExpireAge?: (staleAge: number) => number;
};

export function getTimeoutRedisCommandOptions(
  timeoutMs: number,
): CommandOptions {
  return commandOptions({ signal: AbortSignal.timeout(timeoutMs) });
}

export default class RedisStringsHandler {
  private client: Client;
  private sharedTagsMap: SyncedMap<string[]>;
  private inMemoryDeduplicationCache: SyncedMap<
    Promise<ReturnType<Client['get']>>
  >;
  private redisGet: Client['get'];
  private redisDeduplicationHandler: DeduplicatedRequestHandler<
    Client['get'],
    string | Buffer | null
  >;
  private deduplicatedRedisGet: (key: string) => Client['get'];
  private timeoutMs: number;
  private keyPrefix: string;
  private redisGetDeduplication: boolean;
  private inMemoryCachingTime: number;
  private defaultStaleAge: number;
  private estimateExpireAge: (staleAge: number) => number;

  constructor({
    database = process.env.VERCEL_ENV === 'production' ? 0 : 1,
    keyPrefix = process.env.VERCEL_URL || 'UNDEFINED_URL_',
    sharedTagsKey = '__sharedTags__',
    timeoutMs = 5_000,
    revalidateTagQuerySize = 250,
    avgResyncIntervalMs = 60 * 60 * 1_000,
    redisGetDeduplication = true,
    inMemoryCachingTime = 10_000,
    defaultStaleAge = 60 * 60 * 24 * 14,
    estimateExpireAge = (staleAge) =>
      process.env.VERCEL_ENV === 'production' ? staleAge * 2 : staleAge * 1.2,
  }: CreateRedisStringsHandlerOptions) {
    this.keyPrefix = keyPrefix;
    this.timeoutMs = timeoutMs;
    this.redisGetDeduplication = redisGetDeduplication;
    this.inMemoryCachingTime = inMemoryCachingTime;
    this.defaultStaleAge = defaultStaleAge;
    this.estimateExpireAge = estimateExpireAge;

    try {
      this.client = createClient({
        ...(database !== 0 ? { database } : {}),
        url: process.env.REDISHOST
          ? `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`
          : 'redis://localhost:6379',
      });

      this.client.on('error', (error) => {
        console.error('Redis client error', error);
      });

      this.client
        .connect()
        .then(() => {
          console.info('Redis client connected.');
        })
        .catch((error) => {
          console.error('Failed to connect Redis client:', error);
          this.client.disconnect();
        });
    } catch (error: unknown) {
      console.error('Failed to initialize Redis client');
      throw error;
    }

    const filterKeys = (key: string): boolean => key !== sharedTagsKey;

    this.sharedTagsMap = new SyncedMap<string[]>({
      client: this.client,
      keyPrefix,
      redisKey: sharedTagsKey,
      database,
      timeoutMs,
      querySize: revalidateTagQuerySize,
      filterKeys,
      resyncIntervalMs:
        avgResyncIntervalMs -
        avgResyncIntervalMs / 10 +
        Math.random() * (avgResyncIntervalMs / 10),
    });

    this.inMemoryDeduplicationCache = new SyncedMap({
      client: this.client,
      keyPrefix,
      redisKey: 'inMemoryDeduplicationCache',
      database,
      timeoutMs,
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
  }

  resetRequestCache(): void {}

  private async assertClientIsReady(): Promise<void> {
    await this.sharedTagsMap.waitUntilReady();
    if (!this.client.isReady) {
      throw new Error('Redis client is not ready yet or connection is lost.');
    }
  }

  public async get(
    key: string,
    ctx: {
      kind: 'APP_ROUTE' | 'APP_PAGE';
      isRoutePPREnabled: boolean;
      isFallback: boolean;
    },
  ): Promise<CacheEntry | null> {
    if (ctx.kind !== 'APP_ROUTE' && ctx.kind !== 'APP_PAGE') {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        ' this cache handler is only designed and tested for kind APP_ROUTE and APP_PAGE and not for kind ',
        (ctx as { kind: string })?.kind,
      );
    }

    debug('RedisStringsHandler.get() called with', key, ctx);
    await this.assertClientIsReady();

    const clientGet = this.redisGetDeduplication
      ? this.deduplicatedRedisGet(key)
      : this.redisGet;
    const serializedCacheEntry = await clientGet(
      getTimeoutRedisCommandOptions(this.timeoutMs),
      this.keyPrefix + key,
    );

    debug(
      'RedisStringsHandler.get() finished with result (serializedCacheEntry)',
      serializedCacheEntry?.substring(0, 200),
    );

    if (!serializedCacheEntry) {
      return null;
    }

    const cacheEntry: CacheEntry | null = JSON.parse(
      serializedCacheEntry,
      bufferReviver,
    );

    debug(
      'RedisStringsHandler.get() finished with result (cacheEntry)',
      JSON.stringify(cacheEntry).substring(0, 200),
    );

    if (!cacheEntry) {
      return null;
    }

    if (!cacheEntry?.tags) {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        'cacheEntry is mall formed (missing tags)',
      );
    }
    if (!cacheEntry?.value) {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        'cacheEntry is mall formed (missing value)',
      );
    }
    if (!cacheEntry?.lastModified) {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        'cacheEntry is mall formed (missing lastModified)',
      );
    }

    return cacheEntry;
  }
  public async set(
    key: string,
    data:
      | {
          kind: 'APP_PAGE';
          status: number;
          headers: Record<string, string>;
          html: string;
          rscData: Buffer;
          segmentData: unknown;
          postboned: unknown;
        }
      | {
          kind: 'APP_ROUTE';
          status: number;
          headers: Record<string, string>;
          body: Buffer;
        },
    ctx: {
      revalidate: number | false;
      isRoutePPREnabled: boolean;
      isFallback: boolean;
      tags?: string[];
    },
  ) {
    if (data.kind !== 'APP_ROUTE' && data.kind !== 'APP_PAGE') {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        data,
        ' this cache handler is only designed and tested for kind APP_ROUTE and APP_PAGE and not for kind ',
        (data as { kind: string })?.kind,
      );
    }

    await this.assertClientIsReady();

    // Constructing and serializing the value for storing it in redis
    const cacheEntry: CacheEntry = {
      value: data,
      lastModified: Date.now(),
      tags: ctx?.tags || [],
    };
    const serializedCacheEntry = JSON.stringify(cacheEntry, bufferReplacer);
    debug(
      'RedisStringsHandler.set() will set the following serializedCacheEntry',
      serializedCacheEntry?.substring(0, 200),
    );

    // pre seed data into deduplicated get client. This will reduce redis load by not requesting
    // the same value from redis which was just set.
    if (this.redisGetDeduplication) {
      this.redisDeduplicationHandler.seedRequestReturn(
        key,
        serializedCacheEntry,
      );
    }

    // Constructing the expire time for the cache entry
    const expireAt =
      ctx.revalidate &&
      Number.isSafeInteger(ctx.revalidate) &&
      ctx.revalidate > 0
        ? this.estimateExpireAge(ctx.revalidate)
        : this.estimateExpireAge(this.defaultStaleAge);

    // Setting the cache entry in redis
    const options = getTimeoutRedisCommandOptions(this.timeoutMs);
    const setOperation: Promise<string | null> = this.client.set(
      options,
      this.keyPrefix + key,
      serializedCacheEntry,
      {
        EX: expireAt,
      },
    );

    // Setting the tags for the cache entry in the sharedTagsMap (locally stored hashmap synced via redis)
    let setTagsOperation: Promise<void> | undefined;
    if (ctx.tags && ctx.tags.length > 0) {
      const currentTags = this.sharedTagsMap.get(key);
      const currentIsSameAsNew =
        currentTags?.length === ctx.tags.length &&
        currentTags.every((v) => ctx.tags!.includes(v)) &&
        ctx.tags.every((v) => currentTags.includes(v));

      if (!currentIsSameAsNew) {
        setTagsOperation = this.sharedTagsMap.set(
          key,
          structuredClone(ctx.tags) as string[],
        );
      }
    }

    await Promise.all([setOperation, setTagsOperation]);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async revalidateTag(tagOrTags: string | string[], ...rest: any[]) {
    debug('RedisStringsHandler.revalidateTag() called with', tagOrTags, rest);
    const tags = new Set([tagOrTags || []].flat());
    await this.assertClientIsReady();

    // find all keys that are related to this tag
    const keysToDelete: string[] = [];
    for (const [key, sharedTags] of this.sharedTagsMap.entries()) {
      if (sharedTags.some((tag) => tags.has(tag))) {
        keysToDelete.push(key);
      }
    }

    debug(
      'RedisStringsHandler.revalidateTag() found',
      keysToDelete,
      'keys to delete',
    );

    // exit early if no keys are related to this tag
    if (keysToDelete.length === 0) {
      return;
    }

    // prepare deletion of all keys in redis that are related to this tag
    const fullRedisKeys = keysToDelete.map((key) => this.keyPrefix + key);
    const options = getTimeoutRedisCommandOptions(this.timeoutMs);
    const deleteKeysOperation = this.client.unlink(options, fullRedisKeys);

    // also delete entries from in-memory deduplication cache if they get revalidated
    if (this.redisGetDeduplication && this.inMemoryCachingTime > 0) {
      for (const key of keysToDelete) {
        this.inMemoryDeduplicationCache.delete(key);
      }
    }

    // prepare deletion of entries from shared tags map if they get revalidated so that the map will not grow indefinitely
    const deleteTagsOperation = this.sharedTagsMap.delete(keysToDelete);

    // execute keys and tag maps deletion
    await Promise.all([deleteKeysOperation, deleteTagsOperation]);
    debug('RedisStringsHandler.revalidateTag() finished delete operations');
  }
}
