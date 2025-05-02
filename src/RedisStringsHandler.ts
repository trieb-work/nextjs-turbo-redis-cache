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
  value: object;
  lastModified: number;
  tags: string[];
};
type CacheHandlerContext = {
  tags: string[];
  softTags: string[];
  revalidate?: number;
};

export type CreateRedisStringsHandlerOptions = {
  database?: number;
  keyPrefix?: string;
  timeoutMs?: number;
  revalidateTagQuerySize?: number;
  sharedTagsKey?: string;
  avgResyncIntervalMs?: number;
  redisGetDeduplication?: boolean;
  inMemoryCachingTime?: number;
  defaultStaleAge?: number;
  estimateExpireAge?: (staleAge: number) => number;
};

const NEXT_CACHE_IMPLICIT_TAG_ID = '_N_T_';
const REVALIDATED_TAGS_KEY = '__revalidated_tags__';

function isImplicitTag(tag: string): boolean {
  return tag.startsWith(NEXT_CACHE_IMPLICIT_TAG_ID);
}

export function getTimeoutRedisCommandOptions(
  timeoutMs: number,
): CommandOptions {
  return commandOptions({ signal: AbortSignal.timeout(timeoutMs) });
}

export default class RedisStringsHandler {
  private client: Client;
  private sharedTagsMap: SyncedMap<string[]>;
  private revalidatedTagsMap: SyncedMap<number>;
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
    timeoutMs = 5000,
    revalidateTagQuerySize = 250,
    avgResyncIntervalMs = 60 * 60 * 1000,
    // redisGetDeduplication = true, TODO change back
    redisGetDeduplication = false,
    // inMemoryCachingTime = 10_000, TODO change back
    inMemoryCachingTime = 0,
    defaultStaleAge = 60 * 60 * 24 * 14,
    estimateExpireAge = (staleAge) =>
      process.env.VERCEL_ENV === 'preview' ? staleAge * 1.2 : staleAge * 2,
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

    const filterKeys = (key: string): boolean =>
      key !== REVALIDATED_TAGS_KEY && key !== sharedTagsKey;

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

    this.revalidatedTagsMap = new SyncedMap<number>({
      client: this.client,
      keyPrefix,
      redisKey: REVALIDATED_TAGS_KEY,
      database,
      timeoutMs,
      querySize: revalidateTagQuerySize,
      filterKeys,
      resyncIntervalMs:
        avgResyncIntervalMs +
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
    debug('RedisStringsHandler.assertClientIsReady() called');
    await Promise.all([
      this.sharedTagsMap.waitUntilReady(),
      this.revalidatedTagsMap.waitUntilReady(),
    ]);
    if (!this.client.isReady) {
      throw new Error('Redis client is not ready yet or connection is lost.');
    }
    debug(
      'RedisStringsHandler.assertClientIsReady() finished with client ready',
    );
  }

  public async get(
    key: string,
    ctx: CacheHandlerContext,
  ): Promise<CacheEntry | null> {
    // TODO fix type of ctx. Example requests:
    // {kind: 'APP_ROUTE', isRoutePPREnabled: false, isFallback: false}

    debug('RedisStringsHandler.get() called with', key, ctx);
    await this.assertClientIsReady();

    const clientGet = this.redisGetDeduplication
      ? this.deduplicatedRedisGet(this.keyPrefix + key)
      : this.redisGet;
    const serializedCacheEntry = await clientGet(
      getTimeoutRedisCommandOptions(this.timeoutMs),
      this.keyPrefix + key,
    );

    debug(
      'RedisStringsHandler.get() finished with result (serializedCacheEntry)',
      serializedCacheEntry?.substring(0, 1000),
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
      cacheEntry,
    );

    if (!cacheEntry) {
      return null;
    }

    const combinedTags = new Set([
      ...(ctx?.softTags || []), // TODO: check what softTags are and if they can be removed. Maybe something old?
      ...(ctx?.tags || []),
    ]);

    if (combinedTags.size === 0) {
      return cacheEntry;
    }

    for (const tag of combinedTags) {
      // TODO: check how this revalidatedTagsMap is used or if it can be deleted. Looks like implicit tags is something old
      const revalidationTime = this.revalidatedTagsMap.get(tag);
      if (revalidationTime && revalidationTime > cacheEntry.lastModified) {
        const redisKey = this.keyPrefix + key;
        // Do not await here as this can happen in the background while we can already serve the cacheEntry
        this.client
          .unlink(getTimeoutRedisCommandOptions(this.timeoutMs), redisKey)
          .catch((err) => {
            console.error(
              'Error occurred while unlinking stale data. Retrying now. Error was:',
              err,
            );
            this.client.unlink(
              getTimeoutRedisCommandOptions(this.timeoutMs),
              redisKey,
            );
          })
          .finally(async () => {
            await this.sharedTagsMap.delete(key);
            await this.revalidatedTagsMap.delete(tag);
          });
        return null;
      }
    }

    return cacheEntry;
  }
  public async set(key: string, data: object, ctx: CacheHandlerContext) {
    // fix type of data:
    // { kind: 'APP_ROUTE', status: 200, body: Buffer(13), headers: {… } }
    // fix type of ctx:
    // {revalidate: false, isRoutePPREnabled: false, isFallback: false}

    await this.assertClientIsReady();

    // Constructing and serializing the value for storing it in redis
    const cacheEntry: CacheEntry = {
      value: data,
      lastModified: Date.now(),
      tags: ctx.tags,
    };
    const serializedCacheEntry = JSON.stringify(cacheEntry, bufferReplacer);
    debug(
      'RedisStringsHandler.set() will set the following serializedCacheEntry',
      serializedCacheEntry?.substring(0, 1000),
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
  public async revalidateTag(tagOrTags: string | string[]) {
    const tags = new Set([tagOrTags || []].flat());
    await this.assertClientIsReady();

    // TODO: check how this revalidatedTagsMap is used or if it can be deleted
    for (const tag of tags) {
      if (isImplicitTag(tag)) {
        const now = Date.now();
        await this.revalidatedTagsMap.set(tag, now);
      }
    }

    const keysToDelete: string[] = [];

    for (const [key, sharedTags] of this.sharedTagsMap.entries()) {
      if (sharedTags.some((tag) => tags.has(tag))) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length === 0) {
      return;
    }

    const fullRedisKeys = keysToDelete.map((key) => this.keyPrefix + key);

    const options = getTimeoutRedisCommandOptions(this.timeoutMs);

    const deleteKeysOperation = this.client.unlink(options, fullRedisKeys);

    // delete entries from in-memory deduplication cache
    if (this.redisGetDeduplication && this.inMemoryCachingTime > 0) {
      for (const key of keysToDelete) {
        this.inMemoryDeduplicationCache.delete(key);
      }
    }

    const deleteTagsOperation = this.sharedTagsMap.delete(keysToDelete);

    await Promise.all([deleteKeysOperation, deleteTagsOperation]);
  }
}
