import { describe, it, expect, vi } from 'vitest';
import { compareAndUnlink } from '../../../src/utils/compareAndUnlink';

describe('compareAndUnlink', () => {
  it('evals GET+UNLINK and reports whether the key was removed', async () => {
    const evalFn = vi.fn(async () => 1);
    await expect(compareAndUnlink({ eval: evalFn }, 'k', 'old')).resolves.toBe(
      true,
    );
    expect(evalFn).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('UNLINK'"),
      { keys: ['k'], arguments: ['old'] },
    );
  });

  it('returns false when the value no longer matches', async () => {
    const evalFn = vi.fn(async () => 0);
    await expect(compareAndUnlink({ eval: evalFn }, 'k', 'old')).resolves.toBe(
      false,
    );
  });
});
