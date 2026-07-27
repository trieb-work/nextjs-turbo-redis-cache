# Test Structure

```
test/
├── playwright/              # E2E tests — browser automation (Playwright)
├── vitest/                  # Unit + Integration tests (Vitest)
│   ├── unit/                # Pure unit tests (no external deps)
│   └── integration/         # Integration tests (Redis + Next.js server)
│       └── cache-components/  # Cache Components integration (Next.js 16+)
└── nextjs-test-projects/    # Next.js app fixtures (shared across test types)
```

## Overview

| Layer           | Runner     | What it validates                                                       | Needs Redis? | Needs Next.js app? |
| --------------- | ---------- | ----------------------------------------------------------------------- | ------------ | ------------------ |
| **Unit**        | Vitest     | Logic in isolation (serializer, prefix resolution, reconnect handling)  | No           | No                 |
| **Integration** | Vitest     | Cache handler ↔ Redis ↔ Next.js HTTP responses (server-side plumbing) | Yes          | Yes                |
| **E2E**         | Playwright | User-facing behavior in a real browser (Cache Components / `use cache`) | Yes          | Yes                |

---

## Unit Tests (`test/vitest/unit/`)

**Runner:** Vitest
**Command:** `pnpm test:unit`
**Config:** `vite.config.ts`

Fast tests with no external dependencies. Mocks are used where needed.

| File                                      | What it tests                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `serializer.test.ts`                      | `CacheValueSerializer` interface, JSON round-trips, singleton stability                        |
| `index.test.ts`                           | `RedisStringsHandler` constructor options, default behaviors                                   |
| `utils/prefix.test.ts`                    | `resolveKeyPrefix` logic (BUILD_ID fallback, env var precedence)                               |
| `reconnect-socket-already-opened.test.ts` | Regression: reconnect logic doesn't call `connect()` when socket is already open               |
| `pages-router-kinds.test.ts`              | Pages Router cache kinds (`PAGES`, `REDIRECT`, `null`/notFound), implicit tags, TTL derivation |

```bash
pnpm test:unit          # single run
pnpm test:unit:watch    # watch mode
pnpm test:unit:coverage # with coverage report (used in CI)
```

---

## Integration Tests (`test/vitest/integration/`)

**Runner:** Vitest
**Command:** `pnpm test:integration`
**Config:** `vite.config.ts`
**Requires:** Redis on localhost:6379, pre-built Next.js test app

These tests spawn a real Next.js server as a child process, make `fetch()` requests against it, and verify both HTTP responses and Redis state directly.

### Standard Integration (`nextjs-cache-handler.integration.test.ts`)

Full cache lifecycle: static pages, fetch caching, revalidation, tag invalidation, TTL behavior. In CI this runs against a matrix of Next.js versions (15.4–16.2).

```bash
pnpm test:integration
```

### Pages Router (`pages-router.integration.test.ts`)

Pages Router cache lifecycle against the `next-pages-16-2-6` app: `PAGES` entry format, TTL derivation from `getStaticProps` `revalidate`, `fallback: 'blocking'` first hits, `notFound: true` (null cache entries), `redirect:` results, and `revalidate: false` TTL fallback.

Starts **two** `next start` instances of the same build sharing one Redis and proves that on-demand revalidation (`res.revalidate(path)`) triggered on instance A is served fresh by instance B (HTML and `/_next/data` pageData JSON) — the multi-instance ISR scenario behind a load balancer.

```bash
pnpm test:integration:pages
```

### BUILD_ID Prefix (`build-id-prefix.integration.test.ts`)

Verifies that when neither `KEY_PREFIX` nor `VERCEL_URL` is set, the handler falls back to `.next/BUILD_ID` as the Redis key prefix. Runs in its own CI job because it needs a clean environment without those env vars.

```bash
pnpm test:integration:build-id-prefix
```

### Cache Components (`cache-components/`)

Integration tests specific to Next.js 16 Cache Components (`use cache`). Uses `next-app-16-2-6-cache-components` as the test app.

| File                                   | What it tests                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `cache-components.integration.test.ts` | `use cache` lifecycle: store, retrieve, tag invalidation, `cacheLife` expiry |
| `redis-kill-reconnect.test.ts`         | Graceful recovery when Redis drops and reconnects                            |

`redis-kill-reconnect.test.ts` uses a container runtime and auto-detects `podman` first, then `docker`. You can force runtime selection with `CONTAINER_RUNTIME=podman` or `CONTAINER_RUNTIME=docker`.

```bash
pnpm test:integration:cache-components
```

**Prerequisites for all integration tests:**

```bash
cd test/nextjs-test-projects/<app-name>
pnpm install && pnpm build
```

---

## E2E Tests (`test/playwright/`)

**Runner:** Playwright
**Command:** `pnpm test:e2e`
**Config:** `playwright.config.ts`
**Requires:** Redis on localhost:6379 (Playwright auto-starts `next-app-16-2-6-cache-components` via `webServer`)

Browser-based tests that validate Cache Components behavior from the user's perspective. Playwright was introduced because the Cache Components (`use cache`) feature in Next.js 16 relies on interactions that `fetch()` alone cannot reproduce:

- **Server Actions** are triggered by form submissions / button clicks — requires a real browser context
- `**updateTag`\*\* must be called from within a Server Action — needs actual UI interaction to verify
- **Cookie-based cache keys** depend on the browser sending cookies during navigation
- **Stale-while-revalidate** effects are only observable through page reloads and DOM diffing

The Vitest cache-components integration tests verify the server-side plumbing (Redis state, HTTP responses). Playwright closes the gap by testing the full user-facing flow.

| File                 | What it tests                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cache-lab.spec.ts`  | `use cache` stability, tag invalidation (`updateTag`/`revalidateTag`), runtime cookie-based cache keys, SWR behavior |
| `update-tag.spec.ts` | `updateTag` via Server Actions (button click → action → UI update)                                                   |

```bash
pnpm test:e2e

# Test against a specific Next.js version:
PLAYWRIGHT_TEST_APP=next-app-16-0-11-cache-components pnpm test:e2e

# Or point at an already-running server:
PLAYWRIGHT_BASE_URL=http://localhost:3001 pnpm test:e2e
```

---

## Next.js Test Projects (`test/nextjs-test-projects/`)

Minimal Next.js applications used as fixtures. They are not test runners — they provide the server that tests run against.

| App                                 | Next.js | Used by                                                        |
| ----------------------------------- | ------- | -------------------------------------------------------------- |
| `next-app-15-4-11`                  | 15.4.11 | Integration (matrix, default for local), build-id-prefix       |
| `next-app-16-0-11`                  | 16.0.11 | Integration (matrix)                                           |
| `next-app-16-2-6`                   | 16.2.6  | Integration (matrix)                                           |
| `next-pages-16-2-6`                 | 16.2.6  | Integration (Pages Router, two-instance revalidation)          |
| `next-app-16-0-11-cache-components` | 16.0.11 | Integration (cache-components matrix), E2E (Playwright matrix) |
| `next-app-16-2-6-cache-components`  | 16.2.6  | Integration (cache-components matrix), E2E (Playwright matrix) |
| `next-app-customized`               | —       | Example of custom config (referenced in project README)        |

---

## CI Jobs

The CI workflow (`.github/workflows/ci.yml`) is structured as:

```
lint-and-unit                        → Lint + Unit Tests + Coverage
  ├── integration                    → Matrix: 3 Next.js versions (15.4–16.2)
  ├── integration-pages              → Pages Router (two-instance revalidation)
  ├── integration-build-id-prefix    → Isolated BUILD_ID prefix test
  ├── integration-cache-components   → Matrix: 16.0.11 + 16.2.6 cache-components
  └── e2e                            → Matrix: Playwright against 16.0.11 + 16.2.6
```

`lint-and-unit` runs first as a gate. All other jobs run in parallel after it passes.

| CI Job                         | Test App(s)                                               | What runs                                                       |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| `lint-and-unit`                | —                                                         | `pnpm lint` + `pnpm test:unit:coverage`                         |
| `integration`                  | `next-app-15-4-11`, `next-app-16-0-11`, `next-app-16-2-6` | `pnpm test:integration` (per matrix entry)                      |
| `integration-pages`            | `next-pages-16-2-6`                                       | `pnpm test:integration:pages`                                   |
| `integration-build-id-prefix`  | `next-app-15-4-11`                                        | `pnpm test:integration:build-id-prefix`                         |
| `integration-cache-components` | `next-app-16-{0-3,2-3}-cache-components`                  | `pnpm test:integration:cache-components` + Redis kill/reconnect |
| `e2e`                          | `next-app-16-{0-3,2-3}-cache-components`                  | `pnpm test:e2e` (Playwright)                                    |

---

## Environment Variables

| Variable                | Used by                        | Description                                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `NEXT_TEST_APP`         | Integration                    | Which test app to use (default: `next-app-15-4-11`)                       |
| `NEXT_PAGES_TEST_APP`   | Integration (Pages Router)     | Which Pages Router test app to use (default: `next-pages-16-2-6`)         |
| `CACHE_COMPONENTS_APP`  | Integration (cache-components) | Which cache-components app (default: `next-app-16-2-6-cache-components`)  |
| `PLAYWRIGHT_TEST_APP`   | E2E                            | Which app Playwright starts (default: `next-app-16-2-6-cache-components`) |
| `PLAYWRIGHT_BASE_URL`   | E2E                            | Override base URL (skips `webServer` auto-start)                          |
| `SKIP_BUILD`            | Integration                    | Skip Next.js build if app is pre-built                                    |
| `DEBUG_INTEGRATION`     | Integration                    | Print child process stdout/stderr                                         |
| `CACHE_COMPONENTS_PORT` | Integration (cache-components) | Port for the server (default: 3065)                                       |
