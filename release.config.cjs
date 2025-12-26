module.exports = {
  branches: [
    { name: 'main' }, // Stable releases
    { name: 'beta', prerelease: true }, // Beta releases
  ],
  plugins: [
    '@semantic-release/commit-analyzer', // Analyze commits to determine the release type
    '@semantic-release/release-notes-generator', // Generate release notes
    '@semantic-release/changelog', // Update changelog
    [
      '@semantic-release/npm',
      {
        npmPublish: true, // Publish to NPM
        tag: 'beta', // Publish beta releases under the "beta" tag
      },
    ],
    [
      '@semantic-release/github',
      {
        assets: ['dist/*.tgz'], // Attach tarballs to GitHub releases
        labels: [],
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'],
        message: 'chore(release): ${nextRelease.version} [skip ci]',
      },
    ],
  ],
};
