// SyncedMap.ts
import { commandOptions } from 'redis';
import type { createClient } from 'redis';

type SyncedMapOptions = {
  client: ReturnType<typeof createClient>;
  keyPrefix: string;
  redisKey: string; // Redis Hash key
  database: number;
  timeoutMs: number;
  querySize: number;
  filterKeys: (key: string) => boolean;
  resyncIntervalMs?: number;
};

type CommandOptions = ReturnType<typeof commandOptions>;
function getTimeoutRedisCommandOptions(timeoutMs: number): CommandOptions {
  return commandOptions({ signal: AbortSignal.timeout(timeoutMs) });
}

export type SyncMessage = {
  type: 'insert' | 'delete';
  key?: string;
  value?: any;
  keys?: string[];
};

const SYNC_CHANNEL_SUFFIX = ":sync-channel";

export class SyncedMap<V> {
  private client: ReturnType<typeof createClient>;
  private subscriberClient: ReturnType<typeof createClient>;
  private map: Map<string, V>;
  private keyPrefix: string;
  private syncChannel: string;
  private redisKey: string;
  private database: number;
  private timeoutMs: number;
  private querySize: number;
  private filterKeys: (key: string) => boolean;
  private resyncIntervalMs?: number;

  private setupLock: Promise<void>;
  private setupLockResolve!: () => void;

  constructor(options: SyncedMapOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix;
    this.redisKey = options.redisKey;
    this.syncChannel = `${options.keyPrefix}${options.redisKey}${SYNC_CHANNEL_SUFFIX}`;
    this.database = options.database;
    this.timeoutMs = options.timeoutMs;
    this.querySize = options.querySize;
    this.filterKeys = options.filterKeys;
    this.resyncIntervalMs = options.resyncIntervalMs;

    this.map = new Map<string, V>();
    this.subscriberClient = this.client.duplicate();
    this.setupLock = new Promise<void>((resolve) => {
      this.setupLockResolve = resolve;
    });

    this.setup().catch((error) => {
      console.error("Failed to setup SyncedMap:", error);
      throw error;
    });
  }

  private async setup() {
    await this.initialSync();
    await this.setupPubSub();
    this.setupPeriodicResync();
    this.setupLockResolve();
  }

  private async initialSync() {
    let cursor = 0;
    const hScanOptions = { COUNT: this.querySize };

    try {
      do {
        const remoteItems = await this.client.hScan(
          getTimeoutRedisCommandOptions(this.timeoutMs),
          this.keyPrefix + this.redisKey,
          cursor,
          hScanOptions
        );
        for (const { field, value } of remoteItems.tuples) {
          if (this.filterKeys(field)) {
            const parsedValue = JSON.parse(value);
            this.map.set(field, parsedValue);
          }
        }
        cursor = remoteItems.cursor;
      } while (cursor !== 0);

      // Clean up keys not in Redis
      await this.cleanupKeysNotInRedis();
    } catch (error) {
      console.error("Error during initial sync:", error);
      throw error;
    }
  }

  private async cleanupKeysNotInRedis() {
    let cursor = 0;
    const scanOptions = { COUNT: this.querySize, MATCH: `${this.keyPrefix}*` };
    let remoteKeys: string[] = [];
    try {
      do {
        const remoteKeysPortion = await this.client.scan(
          getTimeoutRedisCommandOptions(this.timeoutMs),
          cursor,
          scanOptions
        );
        remoteKeys = remoteKeys.concat(remoteKeysPortion.keys);
        cursor = remoteKeysPortion.cursor;
      } while (cursor !== 0);

      const remoteKeysSet = new Set(
        remoteKeys.map((key) => key.substring(this.keyPrefix.length))
      );

      const keysToDelete: string[] = [];
      for (const key of this.map.keys()) {
        const keyStr = key as unknown as string;
        if (!remoteKeysSet.has(keyStr) && this.filterKeys(keyStr)) {
          keysToDelete.push(keyStr);
        }
      }

      if (keysToDelete.length > 0) {
        await this.delete(keysToDelete);
      }
    } catch (error) {
      console.error("Error during cleanup of keys not in Redis:", error);
      throw error;
    }
  }

  private setupPeriodicResync() {
    if (this.resyncIntervalMs && this.resyncIntervalMs > 0) {
      setInterval(() => {
        this.initialSync().catch(error => {
          console.error("Error during periodic resync:", error);
        });
      }, this.resyncIntervalMs);
    }
  }

  private async setupPubSub() {
    const syncHandler = async (message: string) => {
      const syncMessage: SyncMessage = JSON.parse(message);
      if (syncMessage.type === 'insert') {
        if (syncMessage.key !== undefined && syncMessage.value !== undefined) {
          this.map.set(syncMessage.key, syncMessage.value);
        }
      } else if (syncMessage.type === 'delete') {
        if (syncMessage.keys) {
          for (const key of syncMessage.keys) {
            this.map.delete(key);
          }
        }
      }
    };

    const keyEventHandler = async (_channel: string, message: string) => {
      const key = message;
      if (key.startsWith(this.keyPrefix)) {
        const keyInMap = key.substring(this.keyPrefix.length);
        if (this.filterKeys(keyInMap)) {
          await this.delete(keyInMap);
        }
      }
    };

    try {
      await this.subscriberClient.connect();

      await Promise.all([
        this.subscriberClient.subscribe(this.syncChannel, syncHandler),
        // Subscribe to Redis keyspace notifications for evicted and expired keys
        this.subscriberClient.subscribe(`__keyevent@${this.database}__:evicted`, keyEventHandler),
        this.subscriberClient.subscribe(`__keyevent@${this.database}__:expired`, keyEventHandler),
      ]);

      // Error handling for reconnection
      this.subscriberClient.on('error', async (err) => {
        console.error('Subscriber client error:', err);
        try {
          await this.subscriberClient.quit();
          this.subscriberClient = this.client.duplicate();
          await this.setupPubSub();
        } catch (reconnectError) {
          console.error('Failed to reconnect subscriber client:', reconnectError);
        }
      });

    } catch (error) {
      console.error("Error setting up pub/sub client:", error);
      throw error;
    }
  }

  public async waitUntilReady() {
    await this.setupLock;
  }

  public get(key: string): V | undefined {
    return this.map.get(key);
  }

  public async set(key: string, value: V): Promise<void> {
    this.map.set(key, value);

    const options = getTimeoutRedisCommandOptions(this.timeoutMs);
    await this.client.hSet(
      options,
      this.keyPrefix + this.redisKey,
      key as unknown as string,
      JSON.stringify(value)
    );

    const insertMessage: SyncMessage = {
      type: 'insert',
      key: key as unknown as string,
      value,
    };
    await this.client.publish(
      this.syncChannel,
      JSON.stringify(insertMessage)
    );
  }

  public async delete(keys: string[] | string): Promise<void> {
    const keysArray = Array.isArray(keys) ? keys : [keys];

    for (const key of keysArray) {
      this.map.delete(key);
    }

    const options = getTimeoutRedisCommandOptions(this.timeoutMs);
    await this.client.hDel(
      options,
      this.keyPrefix + this.redisKey,
      keysArray
    );

    const deletionMessage: SyncMessage = {
      type: 'delete',
      keys: keysArray,
    };
    await this.client.publish(
      this.syncChannel,
      JSON.stringify(deletionMessage)
    );
  }

  public has(key: string): boolean {
    return this.map.has(key);
  }

  public entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }
}