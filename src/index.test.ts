import { describe, it, expect } from 'vitest';

import type { CreateRedisStringsHandlerOptions } from './index';

describe('Public exports', () => {
  it('exports CreateRedisStringsHandlerOptions type', () => {
    const _typeCheck: CreateRedisStringsHandlerOptions = {
      keyPrefix: 'test',
    };

    expect(_typeCheck.keyPrefix).toBe('test');
  });
});
