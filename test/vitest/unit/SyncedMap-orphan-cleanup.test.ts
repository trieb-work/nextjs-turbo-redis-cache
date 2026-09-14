import { describe, it, expect } from 'vitest';
import { SyncedMap } from '../../../src/SyncedMap';

class HashMockClient {
  hash = new Map<string, string>();
  stringKeys: string[] = [];
  hDelCalls: string[][] = [];
  isOpen = true;
  isReady = true;

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
    return new HashMockClient();
  }

  async sendCommand(args: string[]) {
    const [command] = args;
    if (command === 'HSCAN') {
      const tuples: string[] = [];
      for (const [field, value] of this.hash) {
        tuples.push(field, value);
      }
      return ['0', tuples];
    }
    if (command === 'SCAN') {
      return ['0', this.stringKeys];
    }
    throw new Error(`Unexpected sendCommand: ${command}`);
  }

  async hSet(_key: string, field: string, value: string) {
    this.hash.set(field, value);
    return 1;
  }

  async hDel(_key: string, fields: string | string[]) {
    const list = Array.isArray(fields) ? fields : [fields];
    this.hDelCalls.push(list);
    for (const field of list) {
      this.hash.delete(field);
    }
    return list.length;
  }

  async publish() {
    return 1;
  }
}

describe('SyncedMap orphan cleanup', () => {
  it('deletes hash fields whose names are not Redis string keys', async () => {
    const client = new HashMockClient();
    const map = new SyncedMap<number>({
      client: client as never,
      keyPrefix: 'app:',
      redisKey: '__revalidated_tags__',
      database: 0,
      querySize: 50,
      filterKeys: () => true,
    });
    await map.waitUntilReady();
    await map.set('posts', 1);

    client.stringKeys = ['app:some-cache-entry'];
    await (map as any).initialSync();

    expect(client.hDelCalls.flat()).toContain('posts');
    expect(map.get('posts')).toBeUndefined();
  });

  it('keeps tag-manifest fields when withoutOrphanCleanup is set', async () => {
    const client = new HashMockClient();
    const map = new SyncedMap<number>({
      client: client as never,
      keyPrefix: 'app:',
      redisKey: '__cacheComponents_revalidated_tags__',
      database: 0,
      querySize: 50,
      filterKeys: () => true,
      customizedSync: { withoutOrphanCleanup: true },
    });
    await map.waitUntilReady();
    await map.set('posts', 1);

    client.stringKeys = ['app:some-cache-entry'];
    await (map as any).initialSync();

    expect(client.hDelCalls).toEqual([]);
    expect(map.get('posts')).toBe(1);
  });
});
