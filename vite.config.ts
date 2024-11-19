import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true, // Enable global test APIs like `describe`, `it`, and `expect`
    environment: 'node', // Use 'node' as the test environment
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], // Only include TypeScript test files
    exclude: ['node_modules', 'dist', '.git'], // Exclude unnecessary directories
    coverage: {
      provider: 'v8', // Use v8 for coverage reporting
      reporter: ['text', 'lcov'], // Generate text and lcov coverage reports
      include: process.env.VITEST_COVERAGE_INCLUDE?.split(',') || [
        'src/**/*.ts',
      ], // Use the specified files (by scripts/vitest-run-staged.cjs) or default to all files
      exclude: ['node_modules', 'dist'], // Exclude specific directories from coverage
    },
  },
});
