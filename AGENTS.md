# Development

Install dependencies with `bun install`. Run `bun run verify` before review. It runs lint, typecheck, tests, and build.

Use Bun only. Run `bun run verify` before review. `dist/` is gitignored; main is source only. Run `bun run release -- check` locally, or `bun run release -- pack --install` to test the tarball. Releases are automated: bump `version` in package.json and push to main; the Action publishes and verify-installs seven ways. Never publish to the npm registry.
