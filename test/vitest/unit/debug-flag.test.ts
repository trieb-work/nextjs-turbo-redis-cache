import { afterEach, describe, expect, it, vi } from 'vitest';
import { debug, isEnvFlagEnabled } from '../../../src/utils/debug';

describe('isEnvFlagEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is disabled when the variable is unset', () => {
    expect(isEnvFlagEnabled('DEBUG_CACHE_HANDLER')).toBe(false);
  });

  it.each(['', 'false', 'FALSE', ' False ', '0', 'no', 'off'])(
    'is disabled for %j',
    (value) => {
      vi.stubEnv('DEBUG_CACHE_HANDLER', value);
      expect(isEnvFlagEnabled('DEBUG_CACHE_HANDLER')).toBe(false);
    },
  );

  it.each(['true', 'TRUE', '1', 'yes', 'on', 'anything'])(
    'is enabled for %j',
    (value) => {
      vi.stubEnv('DEBUG_CACHE_HANDLER', value);
      expect(isEnvFlagEnabled('DEBUG_CACHE_HANDLER')).toBe(true);
    },
  );
});

describe('debug()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not log when DEBUG_CACHE_HANDLER=false', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('DEBUG_CACHE_HANDLER', 'false');
    debug('red', 'hello');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs when DEBUG_CACHE_HANDLER=true', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('DEBUG_CACHE_HANDLER', 'true');
    debug('red', 'hello');
    expect(log).toHaveBeenCalled();
  });
});
