/**
 * Delete keys with one UNLINK per Redis Cluster hash slot.
 *
 * Cluster mode rejects a multi-key command whose keys are not in the same
 * slot, with `CROSSSLOT`. That check happens even when every slot currently
 * lives on the node that received the command. A cache tag does not imply a
 * hash slot, so the old single UNLINK of every key for a tag failed and left
 * the values in place (issue #101).
 *
 * The slot comes from the cluster protocol, unchanged since Redis 3.0 and
 * copied by Valkey:
 *
 *   HASH_SLOT = CRC16(key) mod 16384
 *
 * CRC16 is the XMODEM variant: polynomial 0x1021, initial value 0. The table
 * below is that algorithm, built once at load, matching Appendix A of the
 * Redis cluster specification. `CLUSTER KEYSLOT` on a cluster node returns
 * the same number. Hash tags are part of the same rule: if the key contains
 * `{...}` with at least one character between the braces, only that text is
 * hashed. `{user}.a` and `{user}.b` therefore share a slot.
 *
 * https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
 * https://valkey.io/topics/cluster-spec/#key-distribution-model
 *
 * `redis` 4.7 does not export this function. `@redis/client` calculates it
 * with the `cluster-key-slot` package and keeps that package private, so the
 * formula is inlined instead of imported from a path pnpm does not allow.
 * The CRC itself will not change quietly: a different formula would move
 * every existing key to another slot and break every running cluster. Hash-tag
 * edge cases are the part that a future client release might correct, and
 * those corrections have to be applied here by hand.
 *
 * `revalidateTag()` always uses this function. There is no cluster-mode
 * switch. Standalone Redis accepts one UNLINK across slots, so grouping is
 * not required there and cannot drop a key: every input key is sent in
 * exactly one group. What does change on a single node is the command shape.
 * One tag becomes one UNLINK per occupied slot, at most `concurrency` of
 * those commands at a time. A failure deletes the groups that succeeded and
 * leaves the rest, instead of one command covering every key.
 *
 * This does not speak the cluster bus. The handler uses the standalone
 * client. Same-slot UNLINK avoids CROSSSLOT on the node it is connected to,
 * including a cluster node that owns all 16,384 slots (the #101 setup). A
 * slot owned by another node comes back as MOVED, and that group is reported
 * as a failure. Redirects are not followed.
 */

const REDIS_CLUSTER_SLOT_COUNT = 16_384;

// XMODEM CRC16 table from Appendix A of the Redis cluster specification.
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

// Hash-tag exception from the same specification: hash only the first
// non-empty `{...}` segment. Anything else hashes as the whole key.
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
      // Count the UNLINK once, before either the command or the success
      // callback can reject. A callback failure happens after the command
      // already ran, so counting again in the catch would report two
      // commands for one UNLINK.
      result.commandCount++;
      try {
        const deleted = await client.unlink(
          groupKeys.length === 1 ? groupKeys[0]! : groupKeys,
        );
        result.deleted += deleted;
        // No spread: one slot group can hold more keys than the engine
        // accepts as function arguments.
        for (const key of groupKeys) {
          result.successfulKeys.push(key);
        }
        await options.onGroupSuccess?.(groupKeys);
      } catch (error) {
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
