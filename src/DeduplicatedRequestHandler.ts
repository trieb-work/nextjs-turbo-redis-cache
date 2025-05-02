import { debug } from './debug';
import { SyncedMap } from './SyncedMap';
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
    debug('DeduplicatedRequestHandler.deduplicatedFunction() called with', key);
    //eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const dedupedFn = async (...args: [never, never]): Promise<K> => {
      // If there's already a pending request with the same key, return it
      debug(
        'DeduplicatedRequestHandler.deduplicatedFunction().dedupedFn called with',
        key,
        args,
        self.fn.name,
      );
      if (
        self.inMemoryDeduplicationCache &&
        self.inMemoryDeduplicationCache.has(key)
      ) {
        debug(
          'DeduplicatedRequestHandler.deduplicatedFunction().dedupedFn ',
          key,
          args,
          self.fn.name,
          'found key in inMemoryDeduplicationCache',
        );
        const res = await self.inMemoryDeduplicationCache
          .get(key)!
          .then((v) => structuredClone(v));
        debug(
          'DeduplicatedRequestHandler.deduplicatedFunction().dedupedFn ',
          key,
          args,
          self.fn.name,
          'found key in inMemoryDeduplicationCache and served result from there',
          res,
        );
        return res;
      }

      // If no pending request, call the original function and store the promise
      const promise = self.fn(...args);
      self.inMemoryDeduplicationCache.set(key, promise);

      debug(
        'DeduplicatedRequestHandler.deduplicatedFunction().dedupedFn ',
        key,
        args,
        self.fn.name,
        'did not found key in inMemoryDeduplicationCache. Setting it now and waiting for promise to resolve',
      );

      try {
        const result = await promise;
        debug(
          'DeduplicatedRequestHandler.deduplicatedFunction().dedupedFn ',
          key,
          args,
          self.fn.name,
          'promise resolved. Returning result',
          result,
        );
        return structuredClone(result);
      } finally {
        // Once the promise is resolved/rejected and caching timeout is over, remove it from the map
        setTimeout(() => {
          self.inMemoryDeduplicationCache.delete(key);
        }, self.cachingTimeMs);
      }
    };
    return dedupedFn as T;
  };
}
