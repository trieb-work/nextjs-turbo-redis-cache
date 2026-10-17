const REDIS_CLUSTER_SLOT_COUNT = 16_384;

const CRC16_TABLE = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
    table[i] = crc & 0xffff;
  }
  return table;
})();

type UnlinkClient = {
  unlink(keys: string | string[]): Promise<number>;
};

export type ClusterSafeUnlinkFailure = {
  slot: number;
  keys: string[];
  error: unknown;
};

export type ClusterSafeUnlinkResult = {
  deleted: number;
  commandCount: number;
  successfulKeys: string[];
  failures: ClusterSafeUnlinkFailure[];
};

export type ClusterSafeUnlinkOptions = {
  concurrency?: number;
  onGroupSuccess?: (keys: string[]) => void | Promise<void>;
};

export class ClusterSafeUnlinkError extends Error {
  constructor(public readonly result: ClusterSafeUnlinkResult) {
    super(
      `Cluster-safe unlink failed for ${result.failures.reduce(
        (sum, failure) => sum + failure.keys.length,
        0,
      )} key(s) across ${result.failures.length} hash slot group(s)`,
    );
    this.name = 'ClusterSafeUnlinkError';
  }
}

function hashSlotKey(key: string): string {
  const open = key.indexOf('{');
  if (open === -1) {
    return key;
  }

  const close = key.indexOf('}', open + 1);
  if (close === -1 || close === open + 1) {
    return key;
  }

  return key.slice(open + 1, close);
}

function crc16(value: string): number {
  const bytes = Buffer.from(value);
  let crc = 0;

  for (const byte of bytes) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ byte) & 0xff]!) & 0xffff;
  }

  return crc;
}

export function redisClusterKeySlot(key: string): number {
  return crc16(hashSlotKey(key)) % REDIS_CLUSTER_SLOT_COUNT;
}

function normalizeConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined || !Number.isFinite(concurrency)) {
    return 16;
  }
  return Math.max(1, Math.floor(concurrency));
}

export async function clusterSafeUnlink(
  client: UnlinkClient,
  keys: string[],
  options: ClusterSafeUnlinkOptions = {},
): Promise<ClusterSafeUnlinkResult> {
  const groups = new Map<number, string[]>();
  for (const key of keys) {
    const slot = redisClusterKeySlot(key);
    const group = groups.get(slot);
    if (group) {
      group.push(key);
    } else {
      groups.set(slot, [key]);
    }
  }

  const work = Array.from(groups.entries());
  const concurrency = normalizeConcurrency(options.concurrency);
  const result: ClusterSafeUnlinkResult = {
    deleted: 0,
    commandCount: 0,
    successfulKeys: [],
    failures: [],
  };
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < work.length) {
      const [slot, groupKeys] = work[nextIndex++]!;
      try {
        const deleted = await client.unlink(
          groupKeys.length === 1 ? groupKeys[0]! : groupKeys,
        );
        result.deleted += deleted;
        result.commandCount++;
        result.successfulKeys.push(...groupKeys);
        await options.onGroupSuccess?.(groupKeys);
      } catch (error) {
        result.commandCount++;
        result.failures.push({ slot, keys: groupKeys, error });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, work.length) }, () => worker()),
  );

  if (result.failures.length > 0) {
    throw new ClusterSafeUnlinkError(result);
  }

  return result;
}
