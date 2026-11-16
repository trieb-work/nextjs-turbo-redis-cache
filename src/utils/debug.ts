const FALSY_ENV_VALUES = new Set(['', 'false', '0', 'no', 'off']);

/**
 * Returns true when the given env var is set to something other than an
 * explicit "off" value. Plain truthiness is not enough: process.env values are
 * strings, so DEBUG_CACHE_HANDLER=false would otherwise enable debug logging.
 */
export function isEnvFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (value === undefined) return false;
  return !FALSY_ENV_VALUES.has(value.trim().toLowerCase());
}

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
  if (isEnvFlagEnabled('DEBUG_CACHE_HANDLER')) {
    console.log(colorCode[color], 'DEBUG CACHE HANDLER: ', ...args);
  }
}

export function debugVerbose(color: string, ...args: unknown[]) {
  if (isEnvFlagEnabled('DEBUG_CACHE_HANDLER_VERBOSE_VERBOSE')) {
    console.log('\x1b[35m', 'DEBUG SYNCED MAP: ', ...args);
  }
}
