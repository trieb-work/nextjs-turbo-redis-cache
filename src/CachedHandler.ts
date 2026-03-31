import fs from 'node:fs';
import path from 'node:path';
import RedisStringsHandler, {
  CreateRedisStringsHandlerOptions,
} from './RedisStringsHandler';
import { debugVerbose } from './utils/debug';

let cachedHandler: RedisStringsHandler;

type NextCacheHandlerOptions = CreateRedisStringsHandlerOptions & {
  serverDistDir?: string;
};

function getBuildIdKeyPrefix(serverDistDir?: string): string | undefined {
  if (!serverDistDir) return undefined;

  try {
    const buildIdPath = path.join(serverDistDir, '..', 'BUILD_ID');
    const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();

    return buildId ? `${buildId}:` : undefined;
  } catch {
    return undefined;
  }
}

export default class CachedHandler {
  constructor(options: NextCacheHandlerOptions) {
    if (!cachedHandler) {
      console.log('created cached handler');
      const keyPrefix =
        options.keyPrefix ||
        process.env.KEY_PREFIX ||
        getBuildIdKeyPrefix(options.serverDistDir);

      cachedHandler = new RedisStringsHandler({
        ...options,
        ...(keyPrefix ? { keyPrefix } : {}),
      });
    }
  }
  get(
    ...args: Parameters<RedisStringsHandler['get']>
  ): ReturnType<RedisStringsHandler['get']> {
    debugVerbose('CachedHandler.get called with', args);
    return cachedHandler.get(...args);
  }
  set(
    ...args: Parameters<RedisStringsHandler['set']>
  ): ReturnType<RedisStringsHandler['set']> {
    debugVerbose('CachedHandler.set called with', args);
    return cachedHandler.set(...args);
  }
  revalidateTag(
    ...args: Parameters<RedisStringsHandler['revalidateTag']>
  ): ReturnType<RedisStringsHandler['revalidateTag']> {
    debugVerbose('CachedHandler.revalidateTag called with', args);
    return cachedHandler.revalidateTag(...args);
  }
  resetRequestCache(
    ...args: Parameters<RedisStringsHandler['resetRequestCache']>
  ): ReturnType<RedisStringsHandler['resetRequestCache']> {
    // debug("CachedHandler.resetRequestCache called with", args);
    return cachedHandler.resetRequestCache(...args);
  }
}
