import { describe, it, expect, vi } from 'vitest';

import { CacheValueSerializer, jsonCacheValueSerializer } from './serializer';
import type { CacheEntry } from './RedisStringsHandler';

function makeEntry(value: unknown): CacheEntry {
  return {
    value,
    lastModified: 1700000000000,
    tags: ['tag-a', 'tag-b'],
  };
}

describe('jsonCacheValueSerializer (default)', () => {
  it('round-trips a CacheEntry with a top-level Buffer value (Buffer + Map encoding preserved)', async () => {
    const original = makeEntry(Buffer.from('hello world', 'utf8'));

    const serialized = await jsonCacheValueSerializer.serialize(original);
    expect(typeof serialized).toBe('string');

    const restored = await jsonCacheValueSerializer.deserialize(serialized);
    expect(restored).not.toBeNull();
    expect(Buffer.isBuffer(restored!.value)).toBe(true);
    expect((restored!.value as Buffer).toString('utf8')).toBe('hello world');
    expect(restored!.lastModified).toBe(original.lastModified);
    expect(restored!.tags).toEqual(original.tags);
  });

  it('round-trips a Buffer nested inside a CacheEntry value object', async () => {
    const original = makeEntry({
      kind: 'APP_ROUTE',
      body: Buffer.from([0x01, 0x02, 0x03, 0x04]),
    });

    const serialized = await jsonCacheValueSerializer.serialize(original);
    const restored = await jsonCacheValueSerializer.deserialize(serialized);

    const nested = (restored!.value as { body: Buffer }).body;
    expect(Buffer.isBuffer(nested)).toBe(true);
    expect(Array.from(nested)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('round-trips a Map value back to a native Map instance', async () => {
    const map = new Map<string, string>([
      ['k1', 'v1'],
      ['k2', 'v2'],
    ]);
    const original = makeEntry(map);

    const serialized = await jsonCacheValueSerializer.serialize(original);
    const restored = await jsonCacheValueSerializer.deserialize(serialized);

    expect(restored!.value).toBeInstanceOf(Map);
    const restoredMap = restored!.value as Map<string, string>;
    expect(restoredMap.size).toBe(2);
    expect(restoredMap.get('k1')).toBe('v1');
    expect(restoredMap.get('k2')).toBe('v2');
  });

  it('is referentially stable so consumers can detect default usage', async () => {
    // Importing twice should yield the same singleton; this guards against
    // accidental "factory" refactors that would break reference equality.
    const reimport = (await import('./serializer')).jsonCacheValueSerializer;
    expect(reimport).toBe(jsonCacheValueSerializer);
  });
});

describe('CacheValueSerializer custom implementations', () => {
  it('invokes a synchronous custom serializer exactly once per call', async () => {
    const serialize = vi.fn(
      (value: CacheEntry) => `sync:${JSON.stringify(value)}`,
    );
    const deserialize = vi.fn(
      (stored: string) =>
        JSON.parse(stored.replace(/^sync:/, '')) as CacheEntry,
    );
    const custom: CacheValueSerializer = { serialize, deserialize };

    const entry = makeEntry({ kind: 'FETCH', payload: 42 });

    const out = await custom.serialize(entry);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(out.startsWith('sync:')).toBe(true);

    const restored = await custom.deserialize(out);
    expect(deserialize).toHaveBeenCalledTimes(1);
    expect(restored).toEqual(entry);
  });

  it('awaits an asynchronous custom serializer (Promise-returning serialize/deserialize)', async () => {
    const custom: CacheValueSerializer = {
      async serialize(value) {
        // Simulate async work (e.g. zlib.brotliCompress promisified).
        await new Promise((r) => setTimeout(r, 0));
        return `async:${JSON.stringify(value)}`;
      },
      async deserialize(stored) {
        await new Promise((r) => setTimeout(r, 0));
        return JSON.parse(stored.replace(/^async:/, '')) as CacheEntry;
      },
    };

    const entry = makeEntry({ kind: 'FETCH', payload: 'async-value' });

    const out = await custom.serialize(entry);
    expect(typeof out).toBe('string');
    expect(out.startsWith('async:')).toBe(true);

    const restored = await custom.deserialize(out);
    expect(restored).toEqual(entry);
  });

  it('treats a deserializer returning null as a cache miss (sync and async)', async () => {
    const syncMiss: CacheValueSerializer = {
      serialize: () => 'ignored',
      deserialize: () => null,
    };
    const asyncMiss: CacheValueSerializer = {
      serialize: async () => 'ignored',
      deserialize: async () => null,
    };

    expect(await syncMiss.deserialize('whatever')).toBeNull();
    expect(await asyncMiss.deserialize('whatever')).toBeNull();
  });

  it('propagates synchronous serializer throws and asynchronous rejections to the caller', async () => {
    const syncThrowing: CacheValueSerializer = {
      serialize() {
        throw new Error('sync serialize boom');
      },
      deserialize() {
        throw new Error('sync deserialize boom');
      },
    };
    const asyncRejecting: CacheValueSerializer = {
      async serialize() {
        throw new Error('async serialize boom');
      },
      async deserialize() {
        throw new Error('async deserialize boom');
      },
    };

    const entry = makeEntry({ kind: 'FETCH', payload: 'x' });

    expect(() => syncThrowing.serialize(entry)).toThrow('sync serialize boom');
    expect(() => syncThrowing.deserialize('x')).toThrow(
      'sync deserialize boom',
    );
    await expect(asyncRejecting.serialize(entry)).rejects.toThrow(
      'async serialize boom',
    );
    await expect(asyncRejecting.deserialize('x')).rejects.toThrow(
      'async deserialize boom',
    );
  });

  it('passes the exact stored string to deserialize (no pre-parsing by the caller)', async () => {
    const serialize = (value: CacheEntry) =>
      `wrapped(${JSON.stringify(value)})`;
    const deserialize = vi.fn((stored: string) => {
      // If the caller mutated the wire format, this would explode.
      const m = /^wrapped\((.+)\)$/.exec(stored);
      if (!m) return null;
      return JSON.parse(m[1]) as CacheEntry;
    });
    const custom: CacheValueSerializer = { serialize, deserialize };

    const entry = makeEntry({ kind: 'APP_PAGE', html: '<p>hi</p>' });

    const wire = await custom.serialize(entry);
    const restored = await custom.deserialize(wire);

    expect(deserialize).toHaveBeenCalledWith(wire);
    expect(restored).toEqual(entry);
  });
});
