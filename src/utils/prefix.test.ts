import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { resolveKeyPrefix } from './prefix';

function withEnv<T>(env: Partial<NodeJS.ProcessEnv>, fn: () => T): T {
  const original: NodeJS.ProcessEnv = { ...process.env };
  Object.entries(env).forEach(([k, v]) => {
    const envRec = process.env as Record<string, string | undefined>;
    if (v === undefined) delete envRec[k];
    else envRec[k] = v as string;
  });
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

function makeBuildIdTree(buildId: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-test-'));
  const nextDir = path.join(tmp, '.next');
  const serverDir = path.join(nextDir, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), buildId, 'utf8');
  return {
    serverDistDir: serverDir,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('resolveKeyPrefix', () => {
  beforeEach(() => {
    const envRec = process.env as Record<string, string | undefined>;
    delete envRec.KEY_PREFIX;
    delete envRec.VERCEL_URL;
  });

  it('returns option keyPrefix when provided (including empty string)', () => {
    const p1 = resolveKeyPrefix({ optionKeyPrefix: 'opt_', env: process.env });
    expect(p1).toBe('opt_');

    const p2 = resolveKeyPrefix({ optionKeyPrefix: '', env: process.env });
    expect(p2).toBe('');
  });

  it('uses KEY_PREFIX when option is undefined', () => {
    const res = withEnv({ KEY_PREFIX: 'envkp_' }, () =>
      resolveKeyPrefix({ optionKeyPrefix: undefined, env: process.env }),
    );
    expect(res).toBe('envkp_');
  });

  it('uses BUILD_ID when KEY_PREFIX and VERCEL_URL are absent and BUILD_ID readable', () => {
    const { serverDistDir, cleanup } = makeBuildIdTree('BID123');
    try {
      const res = resolveKeyPrefix({
        optionKeyPrefix: undefined,
        env: process.env,
        serverDistDir,
      });
      expect(res).toBe('BID123');
    } finally {
      cleanup();
    }
  });

  it('uses VERCEL_URL before BUILD_ID when both are available', () => {
    const { serverDistDir, cleanup } = makeBuildIdTree('BIDXYZ');
    try {
      const res = withEnv({ VERCEL_URL: 'vercel.example' }, () =>
        resolveKeyPrefix({
          optionKeyPrefix: undefined,
          env: process.env,
          serverDistDir,
        }),
      );
      expect(res).toBe('vercel.example');
    } finally {
      cleanup();
    }
  });

  it('uses VERCEL_URL when KEY_PREFIX and BUILD_ID not available', () => {
    const res = withEnv({ VERCEL_URL: 'vercel.example' }, () =>
      resolveKeyPrefix({ optionKeyPrefix: undefined, env: process.env }),
    );
    expect(res).toBe('vercel.example');
  });

  it('falls back to UNDEFINED_URL_ when nothing else available', () => {
    const res = resolveKeyPrefix({
      optionKeyPrefix: undefined,
      env: process.env,
    });
    expect(res).toBe('UNDEFINED_URL_');
  });

  it('treats empty env values as absent', () => {
    const { serverDistDir, cleanup } = makeBuildIdTree('BIDX');
    try {
      const res = withEnv({ KEY_PREFIX: '', VERCEL_URL: '' }, () =>
        resolveKeyPrefix({
          optionKeyPrefix: undefined,
          env: process.env,
          serverDistDir,
        }),
      );
      expect(res).toBe('BIDX');
    } finally {
      cleanup();
    }
  });
});
