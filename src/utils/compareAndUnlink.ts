/**
 * Atomically delete `key` only if its current value still equals `expected`.
 * GET then UNLINK would race: another instance can SET a replacement in between.
 */
const COMPARE_AND_UNLINK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('UNLINK', KEYS[1])
end
return 0
`;

type EvalClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};

export async function compareAndUnlink(
  client: EvalClient,
  key: string,
  expected: string,
): Promise<boolean> {
  const deleted = await client.eval(COMPARE_AND_UNLINK, {
    keys: [key],
    arguments: [expected],
  });
  return deleted === 1 || deleted === 1n;
}
