import { commandOptions, createClient } from 'redis';
import type { RedisClientOptions } from 'redis';
import {
  Client,
  CreateRedisStringsHandlerOptions,
  redisErrorHandler,
} from './RedisStringsHandler';
import { SyncedMap } from './SyncedMap';
import { debug } from './utils/debug';

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
  CreateRedisStringsHandlerOptions;

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
  private revalidatedTagsMap: SyncedMap<number>;
  private sharedTagsMap: SyncedMap<string[]>;
  private keyPrefix: string;
  private getTimeoutMs: number;

  constructor({
    redisUrl = process.env.REDIS_URL
      ? process.env.REDIS_URL
      : process.env.REDISHOST
        ? `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`
        : 'redis://localhost:6379',
    database = process.env.VERCEL_ENV === 'production' ? 0 : 1,
    keyPrefix = process.env.VERCEL_URL || 'UNDEFINED_URL_',
    getTimeoutMs = process.env.REDIS_COMMAND_TIMEOUT_MS
      ? (Number.parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS) ?? 500)
      : 500,
    revalidateTagQuerySize = 250,
    avgResyncIntervalMs = 60 * 60 * 1_000,
    socketOptions,
    clientOptions,
    killContainerOnErrorThreshold = process.env
      .KILL_CONTAINER_ON_ERROR_THRESHOLD
      ? (Number.parseInt(process.env.KILL_CONTAINER_ON_ERROR_THRESHOLD) ?? 0)
      : 0,
  }: CreateCacheComponentsHandlerOptions) {
    try {
      this.keyPrefix = keyPrefix;
      this.getTimeoutMs = getTimeoutMs;

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
        setTimeout(
          () =>
            this.client.connect().catch((err) => {
              console.error(
                'Failed to reconnect RedisCacheComponentsHandler client after connection loss:',
                err,
              );
            }),
          1000,
        );
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

      const filterKeys = (key: string): boolean =>
        key !== REVALIDATED_TAGS_KEY && key !== SHARED_TAGS_KEY;

      this.revalidatedTagsMap = new SyncedMap<number>({
        client: this.client,
        keyPrefix,
        redisKey: REVALIDATED_TAGS_KEY,
        database,
        querySize: revalidateTagQuerySize,
        filterKeys,
        resyncIntervalMs:
          avgResyncIntervalMs +
          avgResyncIntervalMs / 10 +
          Math.random() * (avgResyncIntervalMs / 10),
      });

      this.sharedTagsMap = new SyncedMap<string[]>({
        client: this.client,
        keyPrefix,
        redisKey: SHARED_TAGS_KEY,
        database,
        querySize: revalidateTagQuerySize,
        filterKeys,
        resyncIntervalMs:
          avgResyncIntervalMs -
          avgResyncIntervalMs / 10 +
          Math.random() * (avgResyncIntervalMs / 10),
      });
    } catch (error) {
      console.error('RedisCacheComponentsHandler constructor error', error);
      throw error;
    }
  }

  private async assertClientIsReady(): Promise<void> {
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

  private async computeMaxRevalidation(tags: string[]): Promise<number> {
    let max = 0;
    for (const tag of tags) {
      const ts = this.revalidatedTagsMap.get(tag);
      if (ts && ts > max) {
        max = ts;
      }
    }
    return max;
  }

  async get(
    cacheKey: string,
    softTags: string[],
  ): Promise<CacheComponentsEntry | undefined> {
    // Construct the full Redis key
    // For cache components, Next.js provides the full key including environment prefix
    // We prepend our keyPrefix for multi-tenant isolation
    const redisKey = `${this.keyPrefix}${cacheKey}`;

    try {
      await this.assertClientIsReady();

      const serialized = await redisErrorHandler(
        'RedisCacheComponentsHandler.get(), operation: get ' +
          this.getTimeoutMs +
          'ms ' +
          redisKey,
        this.client.get(
          commandOptions({ signal: AbortSignal.timeout(this.getTimeoutMs) }),
          redisKey,
        ),
      );

      if (!serialized) {
        return undefined;
      }

      const stored: StoredCacheEntry = JSON.parse(serialized);
      const now = Date.now();

      // expire is a duration in seconds, calculate absolute expiry time
      const expiryTime = stored.timestamp + stored.expire * 1000;
      if (
        Number.isFinite(stored.expire) &&
        stored.expire > 0 &&
        now > expiryTime
      ) {
        await this.client.unlink(redisKey).catch(() => {});
        await this.sharedTagsMap.delete(cacheKey).catch(() => {});
        return undefined;
      }

      const maxRevalidation = await this.computeMaxRevalidation([
        ...(stored.tags || []),
        ...(softTags || []),
      ]);

      if (maxRevalidation > 0 && maxRevalidation > stored.timestamp) {
        await this.client.unlink(redisKey).catch(() => {});
        await this.sharedTagsMap.delete(cacheKey).catch(() => {});
        return undefined;
      }

      const valueBuffer =
        typeof stored.value === 'string'
          ? new Uint8Array(Buffer.from(stored.value, 'base64'))
          : stored.value;

      return {
        ...stored,
        value: bufferToReadableStream(valueBuffer),
      };
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
      return this.computeMaxRevalidation(tags || []);
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
    _durations?: { expire?: number },
  ): Promise<void> {
    try {
      // Mark optional argument as used to satisfy lint rules while keeping the signature
      void _durations;
      await this.assertClientIsReady();
      const now = Date.now();

      const tagsSet = new Set(tags || []);

      for (const tag of tagsSet) {
        await this.revalidatedTagsMap.set(tag, now);
      }

      const keysToDelete: Set<string> = new Set();

      for (const [key, storedTags] of this.sharedTagsMap.entries()) {
        if (storedTags.some((tag) => tagsSet.has(tag))) {
          keysToDelete.add(key);
        }
      }

      if (keysToDelete.size === 0) {
        return;
      }

      const cacheKeys = Array.from(keysToDelete);

      // Construct full Redis keys (same format as in get/set)
      const fullRedisKeys = cacheKeys.map((key) => `${this.keyPrefix}${key}`);

      await redisErrorHandler(
        'RedisCacheComponentsHandler.updateTags(), operation: unlink',
        this.client.unlink(fullRedisKeys),
      );

      // Delete from sharedTagsMap
      const deleteTagsOperation = this.sharedTagsMap.delete(cacheKeys);
      await deleteTagsOperation;
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

export const redisCacheHandler: CacheComponentsHandler =
  getRedisCacheComponentsHandler();
