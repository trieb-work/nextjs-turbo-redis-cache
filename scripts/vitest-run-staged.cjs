#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Helper to find the co-aligned test file
const findTestFile = (filePath) => {
  const ext = path.extname(filePath);
  const testFile = filePath.replace(ext, `.test${ext}`);
  return fs.existsSync(testFile) ? testFile : null;
};

// Run Vitest for staged test files
(async () => {
  const stagedFilesOutput = execSync('git diff --cached --name-only', {
    encoding: 'utf-8',
  });
  const stagedFiles = stagedFilesOutput.trim().split('\n');

  const stagedTsFiles = stagedFiles
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.config.ts') && !file.includes('test/'))

  const testFiles = stagedTsFiles
    .map((file) => findTestFile(file))
    .filter(Boolean); // Remove nulls

  const nonTestFiles = stagedTsFiles
    .filter((file) => !findTestFile(file))

  if (testFiles.length > 0) {
    console.log('Running tests for staged files:\n  ', testFiles.join('\n  '));

    const includeFiles = testFiles.map((testFile) => testFile.replace(/\.test\.ts$/, ".ts"));
    process.env.VITEST_COVERAGE_INCLUDE = includeFiles.join(",");

    execSync(`npm test -- run ${testFiles.join(' ')}`, { stdio: 'inherit' });
  } else if (nonTestFiles.length === 0) {
    console.log('No co-aligned test files found for staged files.');
  }

  if (nonTestFiles.length > 0) {
    console.error('Found some staged files without a co-aligned test files:\n\t', nonTestFiles.join('\n\t'));
  }
})();
