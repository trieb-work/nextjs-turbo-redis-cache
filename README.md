# TypeScript Package Template

This is a template for creating a TypeScript package.

## Features

- TypeScript
- Eslint
- Prettier
- Semantic Release to NPM and GitHub Releases with auto-generated changelog
- Testing with Vitest
- GitHub Actions for test, build and release on main branch
- Commit message hook for linting staged files
- Conventional Commits
- Code Coverage Report and PR Comments

## Getting Started

1. Create a new repo using this as template repo
2. Clone the new repository
3. Run ./scripts/setup-repo-name.sh to configure the package name in all files
4. For private repos: set NPM_TOKEN in repository secrets (For public repos, it is already set via organization secrets)
5. Run `pnpm install` to install the dependencies
6. Run `pnpm run build` to build the project
7. Run `pnpm run dev` to develop the project
8. Run `pnpm run test` to test the project
10. Checkout into a new branch (main is protected)
11. Change code and commit it using conventional commit. Staged code will get checked
12. Push and create a PR (against main or beta) to run CI
13. Merge to main or beta to create a release or pre-release 

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
