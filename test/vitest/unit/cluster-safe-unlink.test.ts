import { describe, expect, it, vi } from 'vitest';
import {
  clusterSafeUnlink,
  ClusterSafeUnlinkError,
  redisClusterKeySlot,
} from '../../../src/utils/clusterSafeUnlink';

describe('redisClusterKeySlot', () => {
  it('matches Valkey cluster slots for the issue 101 repro keys', () => {
    expect(redisClusterKeySlot('cache:item:a')).toBe(11600);
    expect(redisClusterKeySlot('cache:item:b')).toBe(7475);
  });

  it('uses Redis hash tags when present', () => {
    expect(redisClusterKeySlot('cache:{tenant}:a')).toBe(
      redisClusterKeySlot('other:{tenant}:b'),
    );
  });
});

describe('clusterSafeUnlink', () => {
  it('groups keys by slot before sending multi-key UNLINK commands', async () => {
    const unlink = vi.fn(async () => 1);

    const result = await clusterSafeUnlink(
      { unlink },
      ['cache:{tenant}:a', 'cache:{tenant}:b', 'cache:item:b'],
      { concurrency: 4 },
    );

    expect(result.failures).toEqual([]);
    expect(result.commandCount).toBe(2);
    expect(unlink).toHaveBeenCalledWith([
      'cache:{tenant}:a',
      'cache:{tenant}:b',
    ]);
    expect(unlink).toHaveBeenCalledWith('cache:item:b');
  });

  it('caps concurrent UNLINK commands', async () => {
    let active = 0;
    let maxActive = 0;
    const unblock: Array<() => void> = [];
    const unlink = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          unblock.push(() => {
            active--;
            resolve(1);
          });
        }),
    );

    let completed = false;
    const operation = clusterSafeUnlink(
      { unlink },
      ['cache:item:a', 'cache:item:b', 'cache:item:c', 'cache:item:d'],
      { concurrency: 2 },
    ).then(() => {
      completed = true;
    });

    while (!completed) {
      const release = unblock.shift();
      if (release) {
        release();
      }
      await Promise.resolve();
    }

    await operation;
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('reports partial failures while preserving successful keys', async () => {
    const unlink = vi.fn(async (keys: string | string[]) => {
      if (keys === 'cache:item:b') {
        throw new Error('network outage');
      }
      return Array.isArray(keys) ? keys.length : 1;
    });

    await expect(
      clusterSafeUnlink({ unlink }, ['cache:item:a', 'cache:item:b'], {
        concurrency: 2,
      }),
    ).rejects.toMatchObject({
      name: 'ClusterSafeUnlinkError',
      result: {
        successfulKeys: ['cache:item:a'],
        failures: [
          {
            keys: ['cache:item:b'],
          },
        ],
      },
    });
  });

  it('calls onGroupSuccess after a slot group was deleted', async () => {
    const onGroupSuccess = vi.fn();

    await clusterSafeUnlink(
      { unlink: vi.fn(async () => 2) },
      ['cache:{tenant}:a', 'cache:{tenant}:b'],
      { onGroupSuccess },
    );

    expect(onGroupSuccess).toHaveBeenCalledWith([
      'cache:{tenant}:a',
      'cache:{tenant}:b',
    ]);
  });
});
