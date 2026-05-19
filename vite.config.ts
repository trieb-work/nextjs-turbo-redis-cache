import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'test/vitest/unit/**/*.test.ts',
      'test/vitest/unit/**/*.test.tsx',
      'test/vitest/integration/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      '.git',
      '**/node_modules/**',
      '**/node_modules',
      'test/vitest/integration/cache-components/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: process.env.VITEST_COVERAGE_INCLUDE?.split(',') || [
        'src/**/*.ts',
      ],
      exclude: [
        'node_modules',
        'dist',
        '**/node_modules/**',
        '**/node_modules',
      ],
    },
  },
});
