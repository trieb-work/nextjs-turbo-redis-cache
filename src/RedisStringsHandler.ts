import { commandOptions, createClient } from 'redis';
import { SyncedMap } from './SyncedMap';
import { DeduplicatedRequestHandler } from './DeduplicatedRequestHandler';
import {
  CacheHandler,
  CacheHandlerValue,
  IncrementalCache,
} from 'next/dist/server/lib/incremental-cache';
import { IncrementalCacheKind } from 'next/dist/server/response-cache';

export type CommandOptions = ReturnType<typeof commandOptions>;
type GetParams = Parameters<IncrementalCache['get']>;
type SetParams = Parameters<IncrementalCache['set']>;
type RevalidateParams = Parameters<IncrementalCache['revalidateTag']>;
export type Client = ReturnType<typeof createClient>;

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
  maxMemoryCacheSize?: number;
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

export default class RedisStringsHandler implements CacheHandler {
  private maxMemoryCacheSize: undefined | number;
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
    maxMemoryCacheSize,
    database = process.env.VERCEL_ENV === 'production' ? 0 : 1,
    keyPrefix = process.env.VERCEL_URL || 'UNDEFINED_URL_',
    sharedTagsKey = '__sharedTags__',
    timeoutMs = 5000,
    revalidateTagQuerySize = 250,
    avgResyncIntervalMs = 60 * 60 * 1000,
    redisGetDeduplication = true,
    inMemoryCachingTime = 10_000,
    defaultStaleAge = 60 * 60 * 24 * 14,
    estimateExpireAge = (staleAge) =>
      process.env.VERCEL_ENV === 'preview' ? staleAge * 1.2 : staleAge * 2,
    ...options
  }: CreateRedisStringsHandlerOptions) {
    console.log('constructor called, options ', options);
    this.maxMemoryCacheSize = maxMemoryCacheSize;
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
  resetRequestCache(...args: never[]): void {
    console.warn('WARNING resetRequestCache() was called', args);
  }

  private async assertClientIsReady(): Promise<void> {
    await Promise.all([
      this.sharedTagsMap.waitUntilReady(),
      this.revalidatedTagsMap.waitUntilReady(),
    ]);
    if (!this.client.isReady) {
      throw new Error('Redis client is not ready yet or connection is lost.');
    }
  }

  public async get(key: GetParams[0], ctx: GetParams[1]) {
    if (ctx?.kind !== IncrementalCacheKind.FETCH) {
      console.log('get key', key, 'ctx', ctx);
    }
    await this.assertClientIsReady();

    const clientGet = this.redisGetDeduplication
      ? this.deduplicatedRedisGet(key)
      : this.redisGet;
    const result = await clientGet(
      getTimeoutRedisCommandOptions(this.timeoutMs),
      this.keyPrefix + key,
    );

    if (!result) {
      return null;
    }

    const cacheValue = JSON.parse(result) as
      | (CacheHandlerValue & { lastModified: number })
      | null;

    if (!cacheValue) {
      return null;
    }

    if (cacheValue.value?.kind === 'FETCH') {
      console.time('decoding' + key);
      cacheValue.value.data.body = Buffer.from(
        cacheValue.value.data.body,
      ).toString('base64');
      console.timeEnd('decoding' + key);
    }

    const combinedTags = new Set([
      ...(ctx?.softTags || []),
      ...(ctx?.tags || []),
    ]);

    if (combinedTags.size === 0) {
      return cacheValue;
    }

    for (const tag of combinedTags) {
      // TODO: check how this revalidatedTagsMap is used or if it can be deleted
      const revalidationTime = this.revalidatedTagsMap.get(tag);
      if (revalidationTime && revalidationTime > cacheValue.lastModified) {
        const redisKey = this.keyPrefix + key;
        // Do not await here as this can happen in the background while we can already serve the cacheValue
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

    return cacheValue;
  }
  public async set(
    key: SetParams[0],
    data: SetParams[1] & { lastModified: number },
    ctx: SetParams[2],
  ) {
    if (data.kind === 'FETCH') {
      console.time('encoding' + key);
      data.data.body = Buffer.from(data.data.body, 'base64').toString();
      console.timeEnd('encoding' + key);
    }
    if (data.kind !== 'FETCH') {
      console.log('set key', key, 'data', data, 'ctx', ctx);
    }
    await this.assertClientIsReady();

    data.lastModified = Date.now();

    const value = JSON.stringify(data);

    // pre seed data into deduplicated get client. This will reduce redis load by not requesting
    // the same value from redis which was just set.
    if (this.redisGetDeduplication) {
      this.redisDeduplicationHandler.seedRequestReturn(key, value);
    }

    const expireAt =
      ctx.revalidate &&
      Number.isSafeInteger(ctx.revalidate) &&
      ctx.revalidate > 0
        ? this.estimateExpireAge(ctx.revalidate)
        : this.estimateExpireAge(this.defaultStaleAge);
    const options = getTimeoutRedisCommandOptions(this.timeoutMs);
    const setOperation: Promise<string | null> = this.client.set(
      options,
      this.keyPrefix + key,
      value,
      {
        EX: expireAt,
      },
    );

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
  public async revalidateTag(tagOrTags: RevalidateParams[0]) {
    console.log('revalidateTag tagOrTags', tagOrTags);
    const tags = new Set([tagOrTags || []].flat());
    await this.assertClientIsReady();

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
