import fs from 'node:fs';
import path from 'node:path';

export function readBuildId(serverDistDir?: string): string | undefined {
  if (!serverDistDir) return undefined;
  try {
    const buildIdPath = path.join(serverDistDir, '..', 'BUILD_ID');
    const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();
    return buildId || undefined;
  } catch {
    return undefined;
  }
}

export function resolveKeyPrefix({
  optionKeyPrefix,
  serverDistDir,
  env,
}: {
  optionKeyPrefix?: string;
  serverDistDir?: string;
  env: NodeJS.ProcessEnv;
}): string {
  // If the option is explicitly provided, honor it even if it's an empty string
  if (optionKeyPrefix !== undefined) {
    return optionKeyPrefix;
  }

  const keyPrefixEnv =
    env.KEY_PREFIX && env.KEY_PREFIX.length > 0 ? env.KEY_PREFIX : undefined;
  const buildId = readBuildId(serverDistDir);
  const vercelUrl =
    env.VERCEL_URL && env.VERCEL_URL.length > 0 ? env.VERCEL_URL : undefined;

  return keyPrefixEnv ?? buildId ?? vercelUrl ?? 'UNDEFINED_URL_';
}
