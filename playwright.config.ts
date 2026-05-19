import { defineConfig } from '@playwright/test';

const testApp =
  process.env.PLAYWRIGHT_TEST_APP || 'next-app-16-2-3-cache-components';

export default defineConfig({
  testDir: 'test/playwright',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3101',
    trace: 'on-first-retry',
  },
  webServer: {
    command: `pnpm -C test/nextjs-test-projects/${testApp} dev -p 3101`,
    url: 'http://localhost:3101',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
