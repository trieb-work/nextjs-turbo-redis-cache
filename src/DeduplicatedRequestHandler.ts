import { SyncedMap } from './SyncedMap';

let counter = 0;

export class DeduplicatedRequestHandler<
  T extends (...args: [never, never]) => Promise<K>,
  K,
> {
  private inMemoryDeduplicationCache: SyncedMap<Promise<K>>;
  private cachingTimeMs: number;
  private fn: T;

  constructor(
    fn: T,
    cachingTimeMs: number,
    inMemoryDeduplicationCache: SyncedMap<Promise<K>>,
  ) {
    this.fn = fn;
    this.cachingTimeMs = cachingTimeMs;
    this.inMemoryDeduplicationCache = inMemoryDeduplicationCache;
  }

  // Method to manually seed a result into the cache
  seedRequestReturn(key: string, value: K): void {
    const resultPromise = new Promise<K>((res) => res(value));
    this.inMemoryDeduplicationCache.set(key, resultPromise);
    setTimeout(() => {
      this.inMemoryDeduplicationCache.delete(key);
    }, this.cachingTimeMs);
  }

  // Method to handle deduplicated requests
  deduplicatedFunction = (key: string): T => {
    //eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const dedupedFn = async (...args: [never, never]): Promise<K> => {
      const cnt = `${key}_${counter++}`;

      // If there's already a pending request with the same key, return it
      if (
        self.inMemoryDeduplicationCache &&
        self.inMemoryDeduplicationCache.has(key)
      ) {
        const res = await self.inMemoryDeduplicationCache
          .get(key)!
          .then((v) => structuredClone(v));
        return res;
      }

      // If no pending request, call the original function and store the promise
      const promise = self.fn(...args);
      self.inMemoryDeduplicationCache.set(key, promise);

      try {
        const result = await promise;
        return structuredClone(result);
      } finally {
        // Once the promise is resolved/rejected, remove it from the map
        setTimeout(() => {
          self.inMemoryDeduplicationCache.delete(key);
        }, self.cachingTimeMs);
      }
    };
    return dedupedFn as T;
  };
}
