export function debug(...args: unknown[]) {
  if (process.env.DEBUG_CACHE_HANDLER) {
    console.log('DEBUG CACHE HANDLER: ', ...args);
  }
}
