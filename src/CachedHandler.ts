import { CacheHandler } from "next/dist/server/lib/incremental-cache";
import RedisStringsHandler, { CreateRedisStringsHandlerOptions } from "./RedisStringsHandler";

let cachedHandler: RedisStringsHandler;

export default class CachedHandler implements CacheHandler {
  constructor(options: CreateRedisStringsHandlerOptions) {
    if (!cachedHandler) {
      console.log("created cached handler");
      cachedHandler = new RedisStringsHandler(options);
    }
  }
  get(...args: Parameters<RedisStringsHandler["get"]>): ReturnType<RedisStringsHandler["get"]> {
    return cachedHandler.get(...args);
  }
  set(...args: Parameters<RedisStringsHandler["set"]>): ReturnType<RedisStringsHandler["set"]> {
    return cachedHandler.set(...args);
  }
  revalidateTag(...args: Parameters<RedisStringsHandler["revalidateTag"]>): ReturnType<RedisStringsHandler["revalidateTag"]> {
    return cachedHandler.revalidateTag(...args);
  }
  resetRequestCache(...args: Parameters<RedisStringsHandler["resetRequestCache"]>): ReturnType<RedisStringsHandler["resetRequestCache"]> {
    return cachedHandler.resetRequestCache(...args);
  }
}