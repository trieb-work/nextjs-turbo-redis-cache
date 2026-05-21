import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/vitest/integration/cache-components/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      '.git',
      '**/node_modules/**',
      '**/node_modules',
    ],
  },
});
