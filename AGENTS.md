# Development

Install dependencies with `pnpm install`. Run `pnpm verify` before review. It runs lint, typecheck, tests, and build.

Use pnpm for scripts and vitest for tests; never introduce bun-specific APIs (`bun:test`, `Bun.*`) in this repo. Run `pnpm verify` before review. `dist/` is gitignored; main is source only. Run `pnpm release -- check` locally, or `pnpm release -- pack --install` to test the tarball. Releases are automated: bump `version` in package.json and push to main; the Action publishes and verify-installs seven ways. Never publish to the npm registry.

`pnpm test:e2e` pushes a throwaway `local-ci-e2e/*` branch to this repo, checks the real Commit Statuses, and deletes the branch. It uses your `gh` login; CI runs it in the `e2e` job with the job's `GITHUB_TOKEN`. Set `LOCAL_CI_E2E_TIMEOUT` (seconds, default 0.5) to change how fast its timeout Check is killed.
