# Development

Install dependencies with `bun install`. Run `bun run verify` before review. It runs lint, typecheck, tests, and build.

Use Bun only. Run `bun run verify` before review. `dist/` is gitignored; main is source only. Run `bun run release -- check` locally, or `bun run release -- pack --install` to test the tarball. Releases are automated: bump `version` in package.json and push to main; the Action publishes and verify-installs seven ways. Never publish to the npm registry.

`bun run test:e2e` pushes a throwaway `local-ci-e2e/*` branch to this repo, checks the real Commit Statuses, and deletes the branch. It uses your `gh` login; CI runs it in the `e2e` job with the job's `GITHUB_TOKEN`. Set `LOCAL_CI_E2E_TIMEOUT` (seconds, default 0.5) to change how fast its timeout Check is killed.
