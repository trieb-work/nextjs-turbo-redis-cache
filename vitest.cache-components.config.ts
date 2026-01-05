import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/cache-components/**/*.spec.ts'],
    exclude: [
      'node_modules',
      'dist',
      '.git',
      '**/node_modules/**',
      '**/node_modules',
    ],
  },
});
