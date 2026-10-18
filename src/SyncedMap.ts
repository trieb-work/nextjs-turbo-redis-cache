// SyncedMap.ts
import { Client, redisErrorHandler } from './RedisStringsHandler';
import { debugVerbose, debug } from './utils/debug';
import { shouldDeferRedisConnection } from './utils/redisConnection';

type CustomizedSync = {
  withoutRedisHashmap?: boolean;
  withoutSetSync?: boolean;
  /**
   * Skip SCAN-based orphan cleanup. Required for maps whose keys are not Redis
   * string keys (tag manifests). Otherwise startup/resync HDELs every tag.
   */
  withoutOrphanCleanup?: boolean;
};

type SyncedMapOptions = {
  client: Client;
  keyPrefix: string;
  redisKey: string; // Redis Hash key
  database: number;
  querySize: number;
  filterKeys: (key: string) => boolean;
  resyncIntervalMs?: number;
  customizedSync?: CustomizedSync;
};

export type SyncMessage<V> = {
  type: 'insert' | 'delete';
  key?: string;
  value?: V;
  keys?: string[];
};

const SYNC_CHANNEL_SUFFIX = ':sync-channel:';
const READY_TIMEOUT_MS = 30_000;

type ReadyWaiter = {
  ready: () => void;
  fail: (error: Error) => void;
};

const retryDelayMs = (attempt: number) =>
  Math.min(500 * Math.pow(2, Math.min(attempt, 5)), 10_000);

export class SyncedMap<V> {
  private client: Client;
  private subscriberClient?: Client;
  private map: Map<string, V>;
  private keyPrefix: string;
  private syncChannel: string;
  private redisKey: string;
  private database: number;
  private querySize: number;
  private filterKeys: (key: string) => boolean;
  private resyncIntervalMs?: number;
  private customizedSync?: CustomizedSync;

  private isSetUp = false;
  private lastSetupError: unknown;
  private readyWaiters = new Set<ReadyWaiter>();
  private subscriberSetup?: Promise<void>;
  private sync?: Promise<void>;
  private resyncNeeded = false;

  constructor(options: SyncedMapOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix;
    this.redisKey = options.redisKey;
    this.syncChannel = `${options.keyPrefix}${SYNC_CHANNEL_SUFFIX}${options.redisKey}`;
    this.database = options.database;
    this.querySize = options.querySize;
    this.filterKeys = options.filterKeys;
    this.resyncIntervalMs = options.resyncIntervalMs;
    this.customizedSync = options.customizedSync;

    this.map = new Map<string, V>();

    void this.setup();
  }

  private async setup() {
    if (shouldDeferRedisConnection()) {
      this.markReady();
      return;
    }
    if (!this.customizedSync?.withoutRedisHashmap) {
      this.setupPeriodicResync();
    }
    await this.subscribeAndSync();
  }

  /**
   * Sync messages published while no subscriber listens are lost. Subscribe
   * first, then load the Redis hash, so the map misses no entry. Run again if
   * the subscriber fails during the load.
   */
  private subscribeAndSync(): Promise<void> {
    this.sync ??= (async () => {
      do {
        this.resyncNeeded = false;
        await this.reconnectSubscriber();
        if (!this.customizedSync?.withoutRedisHashmap) {
          await this.retryUntilSuccess('Initial sync', () =>
            this.initialSync(),
          );
        }
      } while (this.resyncNeeded);
      this.markReady();
    })().finally(() => {
      this.sync = undefined;
    });
    return this.sync;
  }

  private markReady() {
    this.lastSetupError = undefined;
    this.isSetUp = true;
    for (const waiter of this.readyWaiters) waiter.ready();
  }

  /**
   * Until the subscriber is back and the map is reloaded, the map can miss
   * entries, so revalidateTag() could skip keys. Report not ready meanwhile.
   */
  private onSubscriberError(error: unknown) {
    console.error('Subscriber client error:', error);
    this.isSetUp = false;
    this.recordSetupError(error);
    // A subscriber setup in flight already creates a new client.
    if (!this.subscriberSetup) this.resyncNeeded = true;
    void this.subscribeAndSync();
  }

  /**
   * A pod can start while Redis is down, or lose the socket during the first
   * HSCAN. One failed attempt must not leave the map unready for good.
   */
  private async retryUntilSuccess(
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        this.recordSetupError(error);
        const delay = retryDelayMs(attempt);
        console.error(
          `${label} attempt ${attempt + 1} failed, retrying in ${delay}ms`,
          error,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async initialSync() {
    // Redis cursors are opaque uint64 strings. redis@4's hScan() coerces them
    // through Number(), which loses precision above 2^53-1 and can loop forever
    // on large keyspaces (see issue #97). Bypass with sendCommand until redis ^5,
    // where SCAN/HSCAN keep cursor as a string.
    let cursor = '0';

    try {
      do {
        const [nextCursor, tuples] = (await redisErrorHandler(
          'SyncedMap.initialSync(), operation: HSCAN ' +
            this.keyPrefix +
            this.redisKey,
          this.client.sendCommand([
            'HSCAN',
            this.keyPrefix + this.redisKey,
            cursor,
            'COUNT',
            String(this.querySize),
          ]),
        )) as [string, string[]];
        for (let i = 0; i < tuples.length; i += 2) {
          const field = tuples[i];
          if (this.filterKeys(field)) {
            this.map.set(field, JSON.parse(tuples[i + 1]));
          }
        }
        cursor = nextCursor;
      } while (cursor !== '0');

      // sharedTagsMap keys are cache keys (Redis strings). Tag-manifest maps
      // use tag names as hash fields — those never appear in SCAN.
      if (!this.customizedSync?.withoutOrphanCleanup) {
        await this.cleanupKeysNotInRedis();
      }
    } catch (error) {
      console.error('Error during initial sync:', error);
      throw error;
    }
  }

  private async cleanupKeysNotInRedis() {
    // Same uint64 cursor issue as initialSync(); sendCommand until redis ^5.
    let cursor = '0';
    let remoteKeys: string[] = [];
    try {
      do {
        const [nextCursor, keys] = (await redisErrorHandler(
          'SyncedMap.cleanupKeysNotInRedis(), operation: SCAN ' +
            this.keyPrefix,
          this.client.sendCommand([
            'SCAN',
            cursor,
            'MATCH',
            `${this.keyPrefix}*`,
            'COUNT',
            String(this.querySize),
          ]),
        )) as [string, string[]];
        remoteKeys = remoteKeys.concat(keys);
        cursor = nextCursor;
      } while (cursor !== '0');

      const remoteKeysSet = new Set(
        remoteKeys.map((key) => key.substring(this.keyPrefix.length)),
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
      console.error('Error during cleanup of keys not in Redis:', error);
      throw error;
    }
  }

  private setupPeriodicResync() {
    if (this.resyncIntervalMs && this.resyncIntervalMs > 0) {
      setInterval(() => {
        this.initialSync().catch((error) => {
          console.error('Error during periodic resync:', error);
        });
      }, this.resyncIntervalMs);
    }
  }

  private async setupPubSub(subscriber: Client) {
    const syncHandler = async (message: string) => {
      const syncMessage: SyncMessage<V> = JSON.parse(message);
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

    const keyEventHandler = async (key: string, message: string) => {
      debug(
        'yellow',
        'SyncedMap.keyEventHandler() called with message',
        this.redisKey,
        message,
        key,
      );
      // const key = message;
      if (key.startsWith(this.keyPrefix)) {
        const keyInMap = key.substring(this.keyPrefix.length);
        if (this.filterKeys(keyInMap)) {
          debugVerbose(
            'SyncedMap.keyEventHandler() key matches filter and will be deleted',
            this.redisKey,
            message,
            key,
          );
          await this.delete(keyInMap, true);
        }
      } else {
        debugVerbose(
          'SyncedMap.keyEventHandler() key does not have prefix',
          this.redisKey,
          message,
          key,
        );
      }
    };

    try {
      // Attach error handler BEFORE subscribing so that errors during
      // subscribe or after connection loss are always caught and trigger
      // a reconnection. Previously this was attached after the subscribe()
      // calls, which meant if subscribe threw during an outage the handler
      // was never attached and the subscriber was permanently dead.
      subscriber.on('error', (err) => this.onSubscriberError(err));

      await subscriber.connect();

      // Check if keyspace event configuration is set correctly
      if (
        (process.env.SKIP_KEYSPACE_CONFIG_CHECK || '').toUpperCase() !== 'TRUE'
      ) {
        const keyspaceEventConfig = (
          await subscriber.configGet('notify-keyspace-events')
        )?.['notify-keyspace-events'];
        if (!keyspaceEventConfig.includes('E')) {
          throw new Error(
            'Keyspace event configuration is set to "' +
              keyspaceEventConfig +
              " but has to include 'E' for Keyevent events, " +
              'published with __keyevent@<db>__ prefix. We recommend to set it to ' +
              "'Exe' like so `redis-cli -h localhost config set notify-keyspace-events Exe`",
          );
        }
        if (
          !keyspaceEventConfig.includes('A') &&
          !(
            keyspaceEventConfig.includes('x') &&
            keyspaceEventConfig.includes('e')
          )
        ) {
          throw new Error(
            'Keyspace event configuration is set to "' +
              keyspaceEventConfig +
              " but has to include 'A' or 'x' and 'e' for expired and " +
              'evicted events. We recommend to set it to ' +
              "'Exe' like so `redis-cli -h localhost config set notify-keyspace-events Exe`",
          );
        }
      }

      await Promise.all([
        // We use a custom channel for insert/delete For the following reason:
        // With custom channel we can delete multiple entries in one message. If we would listen to unlink / del we
        // could get thousands of messages for one revalidateTag (For example revalidateTag("algolia") would send an enormous amount of network packages)
        // Also we can send the value in the message for insert
        subscriber.subscribe(this.syncChannel, syncHandler),
        // Subscribe to Redis keyevent notifications for evicted and expired keys
        subscriber.subscribe(
          `__keyevent@${this.database}__:evicted`,
          keyEventHandler,
        ),
        subscriber.subscribe(
          `__keyevent@${this.database}__:expired`,
          keyEventHandler,
        ),
      ]);
    } catch (error) {
      console.error('Error setting up pub/sub client:', error);
      throw error;
    }
  }

  /**
   * Replace the subscriber client and subscribe again, with exponential
   * backoff until it works. Concurrent callers (setup and every error event
   * during an outage) share one attempt loop.
   */
  private reconnectSubscriber(): Promise<void> {
    this.subscriberSetup ??= this.retryUntilSuccess(
      'Subscriber setup',
      async () => {
        // Forcibly tear down the old subscriber so its internal reconnect
        // loop cannot come back to life once Redis recovers. `quit()` waits
        // for the server and can silently fail during an outage, leaving a
        // zombie client that still fires our error handler. Remove that
        // handler first so a delayed error from the old socket cannot tear
        // down the replacement subscriber we are about to create.
        try {
          this.subscriberClient?.removeAllListeners('error');
          await this.subscriberClient?.disconnect();
        } catch {
          // expected during outage
        }
        const subscriber = this.client.duplicate();
        this.subscriberClient = subscriber;
        await this.setupPubSub(subscriber);
      },
    ).finally(() => {
      this.subscriberSetup = undefined;
    });
    return this.subscriberSetup;
  }

  private recordSetupError(error: unknown) {
    this.lastSetupError = error;
    for (const waiter of this.readyWaiters) waiter.fail(this.notReadyError());
  }

  private notReadyError() {
    return new Error(
      `SyncedMap ${this.redisKey} is not ready, setup is retrying after: ${String(this.lastSetupError)}`,
    );
  }

  /**
   * Waits for the initial sync and the subscriber of every map. Rejects as
   * soon as a setup attempt fails, so cache calls miss instead of hanging.
   */
  public static async waitUntilAllReady(
    maps: SyncedMap<unknown>[],
    timeoutMs = READY_TIMEOUT_MS,
  ): Promise<void> {
    const pending = maps.filter((map) => !map.isSetUp);
    if (pending.length === 0) return;
    const failed = pending.find((map) => map.lastSetupError !== undefined);
    if (failed) throw failed.notReadyError();

    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    let waiter: ReadyWaiter | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let notReady = pending.length;
        waiter = {
          ready: () => {
            if (--notReady === 0) resolve();
          },
          fail: reject,
        };
        for (const map of pending) map.readyWaiters.add(waiter);
        readyTimeout = setTimeout(() => {
          reject(
            new Error(
              `SyncedMap ${pending.map((map) => map.redisKey).join(', ')} is not ready after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      });
    } finally {
      // Timers capture the ambient async context (AsyncLocalStorage), so in a
      // Next.js server a leaked timer pins the request's object graph.
      clearTimeout(readyTimeout);
      for (const map of pending) map.readyWaiters.delete(waiter!);
    }
  }

  public waitUntilReady(timeoutMs?: number): Promise<void> {
    return SyncedMap.waitUntilAllReady([this], timeoutMs);
  }

  public get(key: string): V | undefined {
    debugVerbose(
      'SyncedMap.get() called with key',
      key,
      JSON.stringify(this.map.get(key))?.substring(0, 100),
    );
    return this.map.get(key);
  }

  public async set(key: string, value: V): Promise<void> {
    debugVerbose(
      'SyncedMap.set() called with key',
      key,
      JSON.stringify(value)?.substring(0, 100),
    );
    this.map.set(key, value);
    const operations = [];

    // This is needed if we only want to sync delete commands. This is especially useful for non serializable data like a promise map
    if (this.customizedSync?.withoutSetSync) {
      return;
    }
    if (!this.customizedSync?.withoutRedisHashmap) {
      operations.push(
        redisErrorHandler(
          'SyncedMap.set(), operation: hSet ' +
            this.syncChannel +
            ' ' +
            this.keyPrefix +
            ' ' +
            key,
          this.client.hSet(
            this.keyPrefix + this.redisKey,
            key as unknown as string,
            JSON.stringify(value),
          ),
        ),
      );
    }

    const insertMessage: SyncMessage<V> = {
      type: 'insert',
      key: key as unknown as string,
      value,
    };
    operations.push(
      redisErrorHandler(
        'SyncedMap.set(), operation: publish ' +
          this.syncChannel +
          ' ' +
          this.keyPrefix +
          ' ' +
          key,
        this.client.publish(this.syncChannel, JSON.stringify(insertMessage)),
      ),
    );
    await Promise.all(operations);
  }

  public async delete(
    keys: string[] | string,
    withoutSyncMessage = false,
  ): Promise<void> {
    debugVerbose(
      'SyncedMap.delete() called with keys',
      this.redisKey,
      keys,
      withoutSyncMessage,
    );

    const keysArray = Array.isArray(keys) ? keys : [keys];
    const operations = [];

    for (const key of keysArray) {
      this.map.delete(key);
    }

    if (!this.customizedSync?.withoutRedisHashmap) {
      operations.push(
        redisErrorHandler(
          'SyncedMap.delete(), operation: hDel ' +
            this.syncChannel +
            ' ' +
            this.keyPrefix +
            ' ' +
            this.redisKey +
            ' ' +
            keysArray,
          this.client.hDel(this.keyPrefix + this.redisKey, keysArray),
        ),
      );
    }

    if (!withoutSyncMessage) {
      const deletionMessage: SyncMessage<V> = {
        type: 'delete',
        keys: keysArray,
      };
      operations.push(
        redisErrorHandler(
          'SyncedMap.delete(), operation: publish ' +
            this.syncChannel +
            ' ' +
            this.keyPrefix +
            ' ' +
            keysArray,
          this.client.publish(
            this.syncChannel,
            JSON.stringify(deletionMessage),
          ),
        ),
      );
    }

    await Promise.all(operations);
    debugVerbose(
      'SyncedMap.delete() finished operations',
      this.redisKey,
      keys,
      operations.length,
    );
  }

  public has(key: string): boolean {
    return this.map.has(key);
  }

  public entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }
}
