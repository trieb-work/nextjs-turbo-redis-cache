import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3101',
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'pnpm -C test/integration/next-app-16-1-1-cache-components dev -p 3101',
    url: 'http://localhost:3101',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
