let counter = 0;

export class DeduplicatedRequestHandler<
  T extends (...args: [never, never]) => Promise<K>,
  K,
> {
  private inMemoryDeduplicationCache = new Map<string, Promise<K>>([]);
  private cachingTimeMs: number;
  private fn: T;

  constructor(fn: T, cachingTimeMs: number) {
    this.fn = fn;
    this.cachingTimeMs = cachingTimeMs;
    console.log('this 1', this);
  }

  // Getter to access the cache externally
  public get cache(): Map<string, Promise<K>> {
    return this.inMemoryDeduplicationCache;
  }

  // Method to manually seed a result into the cache
  seedRequestReturn(key: string, value: K): void {
    const resultPromise = new Promise<K>((res) => res(value));
    this.inMemoryDeduplicationCache.set(key, resultPromise);
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
        console.log(`redis get in-mem ${cnt} started`);
        console.time(`redis get in-mem ${cnt}`);
        const res = await self.inMemoryDeduplicationCache
          .get(key)!
          .then((v) => structuredClone(v));
        console.timeEnd(`redis get in-mem ${cnt}`);
        return res;
      }

      // If no pending request, call the original function and store the promise
      const promise = self.fn(...args);
      self.inMemoryDeduplicationCache.set(key, promise);

      try {
        console.log(`redis get origin ${cnt} started`);
        console.time(`redis get origin ${cnt}`);
        const result = await promise;
        console.timeEnd(`redis get origin ${cnt}`);
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
