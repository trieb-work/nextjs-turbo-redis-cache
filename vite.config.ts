import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/integration/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '.git'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: process.env.VITEST_COVERAGE_INCLUDE?.split(',') || [
        'src/**/*.ts',
      ],
      exclude: ['node_modules', 'dist'],
    },
  },
});
