export function debug(
  color:
    | 'red'
    | 'blue'
    | 'green'
    | 'yellow'
    | 'cyan'
    | 'white'
    | 'none' = 'none',
  ...args: unknown[]
): void {
  const colorCode = {
    red: '\x1b[31m',
    blue: '\x1b[34m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    none: '',
  };
  if (process.env.DEBUG_CACHE_HANDLER) {
    console.log(colorCode[color], 'DEBUG CACHE HANDLER: ', ...args);
  }
}

export function debugVerbose(color: string, ...args: unknown[]) {
  if (process.env.DEBUG_CACHE_HANDLER_VERBOSE_VERBOSE) {
    console.log('\x1b[35m', 'DEBUG SYNCED MAP: ', ...args);
  }
}
