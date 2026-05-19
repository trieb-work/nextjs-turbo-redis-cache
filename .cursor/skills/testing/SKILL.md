---
name: testing
description: >-
  Run tests and add Next.js version coverage for the cache handler. Use when
  running tests, adding a new Next.js version to the test matrix, creating test
  apps, or debugging CI failures.
---

# Testing

## Running Tests

```bash
# Unit tests (fast, no Redis needed)
pnpm test:unit
pnpm test:unit:watch          # watch mode
pnpm test:unit:coverage       # with coverage

# Integration tests (needs Redis + pre-built Next.js app)
pnpm test:integration
pnpm test:integration:build-id-prefix
pnpm test:integration:cache-components

# E2E / Playwright for cached components (needs Redis, auto-starts Next.js app)
pnpm test:e2e
```

## Test Structure

```
test/
├── playwright/              # E2E (Playwright browser tests)
├── vitest/
│   ├── unit/                # Unit tests (no external deps)
│   └── integration/         # Integration tests (Redis + Next.js)
│       └── cache-components/
└── nextjs-test-projects/    # Shared Next.js app fixtures
```

For details on each layer, see `test/README.md`.

## Adding a New Next.js Version

### 1. Standard Integration Test App

For testing the core cache handler against a new Next.js version (e.g. 16.5.0):

```bash
cp -r test/nextjs-test-projects/next-app-16-2-3 test/nextjs-test-projects/next-app-16-5-0
rm -rf test/nextjs-test-projects/next-app-16-5-0/{node_modules,.next,pnpm-lock.yaml}
```

Edit `test/nextjs-test-projects/next-app-16-5-0/package.json`:

- Change `"name"` to `"next-app-16-5-0"`
- Change `"next"` version to `"16.5.0"`
- Change `"eslint-config-next"` version to `"16.5.0"`

Then add the app to the CI integration matrix in `.github/workflows/ci.yml`:

```yaml
# In the `integration` job → strategy.matrix.next-test-app
- next-app-16-5-0
```

### 2. Cache Components Test App (Next.js 16+ only)

If the new version supports `use cache` / `cacheTag` / `cacheLife`:

```bash
cp -r test/nextjs-test-projects/next-app-16-2-3-cache-components test/nextjs-test-projects/next-app-16-5-0-cache-components
rm -rf test/nextjs-test-projects/next-app-16-5-0-cache-components/{node_modules,.next,pnpm-lock.yaml}
```

Edit the `package.json`:

- Change `"name"` to `"next-app-16-5-0-cache-components"`
- Change `"next"` to `"16.5.0"`
- Change `"eslint-config-next"` to `"16.5.0"`

Then add it to both CI matrix jobs in `.github/workflows/ci.yml`:

```yaml
# In `integration-cache-components` → strategy.matrix.cache-components-app
- next-app-16-5-0-cache-components

# In `e2e` → strategy.matrix.cache-components-app
- next-app-16-5-0-cache-components
```

### 3. Checklist After Adding

- [ ] `package.json` has correct Next.js version + matching `eslint-config-next`
- [ ] `"@trieb.work/nextjs-turbo-redis-cache": "file:../../../"` path is correct
- [ ] No leftover `node_modules/`, `.next/`, or `pnpm-lock.yaml` from the copy
- [ ] CI matrix updated (integration and/or cache-components + e2e)
- [ ] `test/README.md` → "Next.js Test Projects" table updated
- [ ] Run `cd test/nextjs-test-projects/next-app-16-5-0 && pnpm install && pnpm build` to verify it builds

### 4. Removing a Version

Remove the folder, remove it from the CI matrix entries, and update `test/README.md`.

## Environment Variables

| Variable               | Default                            | Purpose                                   |
| ---------------------- | ---------------------------------- | ----------------------------------------- |
| `NEXT_TEST_APP`        | `next-app-15-4-7`                  | Which app for `pnpm test:integration`     |
| `CACHE_COMPONENTS_APP` | `next-app-16-2-3-cache-components` | Which app for cache-components tests      |
| `PLAYWRIGHT_TEST_APP`  | `next-app-16-2-3-cache-components` | Which app Playwright starts               |
| `PLAYWRIGHT_BASE_URL`  | `http://localhost:3101`            | Override to use an already-running server |
| `SKIP_BUILD`           | —                                  | Skip Next.js build in integration tests   |
| `DEBUG_INTEGRATION`    | —                                  | Print child process output                |

## Writing New Tests

- **Unit tests**: Add `*.test.ts` in `test/vitest/unit/`. No Redis, no Next.js. Use mocks.
- **Integration tests**: Add `*.test.ts` in `test/vitest/integration/`. Spawn Next.js, use `fetch()`, check Redis.
- **E2E tests**: Add `*.spec.ts` in `test/playwright/`. Use Playwright browser automation.

Unit tests use `.test.ts` extension. Playwright tests use `.spec.ts` extension.
