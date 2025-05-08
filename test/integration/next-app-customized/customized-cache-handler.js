const { RedisStringsHandler } = require('@trieb.work/nextjs-turbo-redis-cache');

let cachedHandler;

module.exports = class CustomizedCacheHandler {
  constructor() {
    if (!cachedHandler) {
      cachedHandler = new RedisStringsHandler({
        database: 0,
        keyPrefix: 'test',
        timeoutMs: 2_000,
        revalidateTagQuerySize: 500,
        sharedTagsKey: '__sharedTags__',
        avgResyncIntervalMs: 10_000 * 60,
        redisGetDeduplication: false,
        inMemoryCachingTime: 0,
        defaultStaleAge: 1209600,
        estimateExpireAge: (staleAge) => staleAge * 2,
      });
    }
  }
  get(...args) {
    return cachedHandler.get(...args);
  }
  set(...args) {
    return cachedHandler.set(...args);
  }
  revalidateTag(...args) {
    return cachedHandler.revalidateTag(...args);
  }
  resetRequestCache(...args) {
    return cachedHandler.resetRequestCache(...args);
  }
};
