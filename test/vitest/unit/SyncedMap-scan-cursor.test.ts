import { describe, it, expect } from 'vitest';
import { SyncedMap } from '../../../src/SyncedMap';

/** Real ElastiCache/Valkey cursor from https://github.com/trieb-work/nextjs-turbo-redis-cache/issues/97 */
const LARGE_CURSOR = '9283289373254615040';
/** Value redis@4.7.0 sends after Number() coercion — never matches the server cursor. */
const ROUNDED_CURSOR = '9283289373254615000';

function v4ScanTransformReply(cursor: string): number {
  return Number(cursor);
}

function v4ScanTransformArguments(cursor: number): string {
  return cursor.toString();
}

type SendCommandArgs = string[];

/** Minimal Redis client mock for SyncedMap startup tests. */
class ScanCursorMockClient {
  hscanCalls: string[];
  scanCalls: string[];
  hash = new Map<string, string>();
  stringKeys: string[] = [];
  isOpen = true;
  isReady = true;

  constructor() {
    this.hscanCalls = [];
    this.scanCalls = [];
  }

  on() {
    return this;
  }

  async connect() {
    this.isOpen = true;
    this.isReady = true;
  }

  async configGet() {
    return { 'notify-keyspace-events': 'Exe' };
  }

  async subscribe() {}

  async quit() {}

  async disconnect() {
    this.isOpen = false;
    this.isReady = false;
  }

  duplicate() {
    return new ScanCursorMockClient();
  }

  async hSet(_key: string, field: string, value: string) {
    this.hash.set(field, value);
    return 1;
  }

  async hDel(_key: string, fields: string | string[]) {
    const list = Array.isArray(fields) ? fields : [fields];
    for (const field of list) {
      this.hash.delete(field);
    }
    return list.length;
  }

  async publish() {
    return 1;
  }

  /**
   * Simulates a Redis server that requires the exact uint64 cursor string.
   * Returns the large cursor again when the client sends the rounded value.
   */
  async sendCommand(args: SendCommandArgs): Promise<[string, string[]]> {
    const [command, ...rest] = args;

    if (command === 'HSCAN') {
      const cursor = rest[1];
      this.hscanCalls.push(cursor);

      if (cursor === '0') {
        return [LARGE_CURSOR, []];
      }

      if (cursor === ROUNDED_CURSOR) {
        return [LARGE_CURSOR, []];
      }

      if (cursor === LARGE_CURSOR) {
        const tuples: string[] = [];
        for (const [field, value] of this.hash) {
          tuples.push(field, value);
        }
        return ['0', tuples];
      }

      throw new Error(`unexpected HSCAN cursor: ${cursor}`);
    }

    if (command === 'SCAN') {
      const cursor = rest[0];
      this.scanCalls.push(cursor);

      if (cursor === '0') {
        return [LARGE_CURSOR, []];
      }

      if (cursor === ROUNDED_CURSOR) {
        return [LARGE_CURSOR, []];
      }

      if (cursor === LARGE_CURSOR) {
        return ['0', this.stringKeys];
      }

      throw new Error(`unexpected SCAN cursor: ${cursor}`);
    }

    throw new Error(`unexpected sendCommand: ${command}`);
  }
}

async function expectCompletesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`operation did not complete within ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

async function simulateBrokenV4HScanLoop(
  hScan: (cursor: number) => Promise<{ cursor: number }>,
  maxIterations: number,
): Promise<string[]> {
  let cursor = 0;
  const sentCursors: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    sentCursors.push(v4ScanTransformArguments(cursor));
    const reply = await hScan(cursor);
    cursor = reply.cursor;
    if (cursor === 0) {
      break;
    }
  }

  return sentCursors;
}

describe('SyncedMap SCAN/HSCAN cursor precision (issue #97)', () => {
  it('documents redis@4.7.0 cursor rounding above MAX_SAFE_INTEGER', () => {
    expect(Number(LARGE_CURSOR)).toBe(Number(ROUNDED_CURSOR));
    expect(String(Number(LARGE_CURSOR))).toBe(ROUNDED_CURSOR);
    expect(ROUNDED_CURSOR).not.toBe(LARGE_CURSOR);
  });

  it('documents that redis@4.7.0 hScan() would keep sending rounded cursors', async () => {
    const client = new ScanCursorMockClient();

    const sentCursors = await simulateBrokenV4HScanLoop(async (cursor) => {
      if (cursor === 0) {
        return { cursor: v4ScanTransformReply(LARGE_CURSOR) };
      }
      if (String(cursor) === ROUNDED_CURSOR) {
        return { cursor: v4ScanTransformReply(LARGE_CURSOR) };
      }
      throw new Error(`unexpected hScan cursor: ${cursor}`);
    }, 5);

    expect(sentCursors).toEqual([
      '0',
      ROUNDED_CURSOR,
      ROUNDED_CURSOR,
      ROUNDED_CURSOR,
      ROUNDED_CURSOR,
    ]);
    void client;
  });

  describe('initialSync() via HSCAN', () => {
    it('completes and preserves the exact server cursor on each page', async () => {
      const client = new ScanCursorMockClient();
      client.hash.set('posts', JSON.stringify(['posts-tag']));

      const map = new SyncedMap<string[]>({
        client: client as never,
        keyPrefix: 'app:',
        redisKey: '__sharedTags__',
        database: 0,
        querySize: 250,
        filterKeys: () => true,
        customizedSync: { withoutOrphanCleanup: true },
      });

      await expectCompletesWithin(map.waitUntilReady(), 1000);

      expect(client.hscanCalls).toEqual(['0', LARGE_CURSOR]);
      expect(map.get('posts')).toEqual(['posts-tag']);
    });

    it('does not hang when the server returns a uint64 cursor', async () => {
      const client = new ScanCursorMockClient();
      const map = new SyncedMap<string[]>({
        client: client as never,
        keyPrefix: 'app:',
        redisKey: '__sharedTags__',
        database: 0,
        querySize: 250,
        filterKeys: () => true,
        customizedSync: { withoutOrphanCleanup: true },
      });

      await expectCompletesWithin(map.waitUntilReady(), 1000);
      expect(client.hscanCalls.length).toBeLessThanOrEqual(2);
      expect(client.hscanCalls).not.toContain(ROUNDED_CURSOR);
    });
  });

  describe('cleanupKeysNotInRedis() via SCAN', () => {
    it('completes and collects keys from the final SCAN page', async () => {
      const client = new ScanCursorMockClient();
      client.stringKeys = ['app:cache-entry'];

      const map = new SyncedMap<number>({
        client: client as never,
        keyPrefix: 'app:',
        redisKey: '__revalidated_tags__',
        database: 0,
        querySize: 250,
        filterKeys: () => true,
      });

      await expectCompletesWithin(map.waitUntilReady(), 1000);

      expect(client.hscanCalls).toEqual(['0', LARGE_CURSOR]);
      expect(client.scanCalls).toEqual(['0', LARGE_CURSOR]);
    });

    it('does not hang when SCAN pagination uses a uint64 cursor', async () => {
      const client = new ScanCursorMockClient();
      client.stringKeys = ['app:cache-entry'];

      const map = new SyncedMap<number>({
        client: client as never,
        keyPrefix: 'app:',
        redisKey: '__revalidated_tags__',
        database: 0,
        querySize: 250,
        filterKeys: () => true,
      });

      await expectCompletesWithin(map.waitUntilReady(), 1000);
      expect(client.scanCalls.length).toBeLessThanOrEqual(2);
      expect(client.scanCalls).not.toContain(ROUNDED_CURSOR);
    });
  });

  describe('full Cache Components-style startup (HSCAN + SCAN)', () => {
    it('waitUntilReady() resolves for both maps without rounded cursors', async () => {
      const client = new ScanCursorMockClient();
      client.hash.set('posts', JSON.stringify(1));
      client.stringKeys = ['app:some-cache-entry'];

      const revalidatedTagsMap = new SyncedMap<number>({
        client: client as never,
        keyPrefix: 'app:',
        redisKey: '__cacheComponents_revalidated_tags__',
        database: 0,
        querySize: 250,
        filterKeys: () => true,
        customizedSync: { withoutOrphanCleanup: true },
      });

      const sharedTagsMap = new SyncedMap<string[]>({
        client: client as never,
        keyPrefix: 'app:',
        redisKey: '__cacheComponents_sharedTags__',
        database: 0,
        querySize: 250,
        filterKeys: () => true,
      });

      await expectCompletesWithin(
        Promise.all([
          revalidatedTagsMap.waitUntilReady(),
          sharedTagsMap.waitUntilReady(),
        ]),
        1000,
      );

      expect(
        client.hscanCalls.every((cursor) => cursor !== ROUNDED_CURSOR),
      ).toBe(true);
      expect(
        client.scanCalls.every((cursor) => cursor !== ROUNDED_CURSOR),
      ).toBe(true);
    });
  });

  describe('regression: small cursors unchanged', () => {
    it('completes in one HSCAN page when the server returns cursor 0 immediately', async () => {
      class SmallCursorClient extends ScanCursorMockClient {
        override async sendCommand(args: SendCommandArgs) {
          const [command] = args;
          if (command === 'HSCAN') {
            const tuples: string[] = [];
            for (const [field, value] of this.hash) {
              tuples.push(field, value);
            }
            this.hscanCalls.push('0');
            return ['0', tuples];
          }
          if (command === 'SCAN') {
            this.scanCalls.push('0');
            return ['0', this.stringKeys];
          }
          return super.sendCommand(args);
        }
      }

      const client = new SmallCursorClient();
      client.hash.set('tag-a', JSON.stringify(42));

      const map = new SyncedMap<number>({
        client: client as never,
        keyPrefix: 'app:',
        redisKey: '__sharedTags__',
        database: 0,
        querySize: 250,
        filterKeys: () => true,
        customizedSync: { withoutOrphanCleanup: true },
      });

      await expectCompletesWithin(map.waitUntilReady(), 1000);
      expect(client.hscanCalls).toEqual(['0']);
      expect(map.get('tag-a')).toBe(42);
    });
  });
});
