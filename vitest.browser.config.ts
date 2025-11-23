import { defineConfig } from 'vitest/config';

// Browser mode disabled; Playwright is used via its own runner instead.
export default defineConfig({
  test: {
    browser: {
      enabled: false,
    },
  },
});
