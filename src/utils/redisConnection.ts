let cachedPhaseProductionBuild: string | undefined;
let phaseResolved = false;

function getPhaseProductionBuild(): string | undefined {
  if (!phaseResolved) {
    phaseResolved = true;
    try {
      // next/constants is only available when the handler runs inside a Next.js app.
      cachedPhaseProductionBuild =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('next/constants') as { PHASE_PRODUCTION_BUILD: string })
          .PHASE_PRODUCTION_BUILD;
    } catch {
      cachedPhaseProductionBuild = undefined;
    }
  }
  return cachedPhaseProductionBuild;
}

/**
 * Returns true during `next build` so handlers can skip opening Redis
 * connections. Matches the official Next.js cache-handler-redis example.
 */
export function shouldDeferRedisConnection(): boolean {
  const phase = getPhaseProductionBuild();
  return !!phase && process.env.NEXT_PHASE === phase;
}
