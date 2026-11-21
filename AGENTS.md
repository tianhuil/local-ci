# Development

Install dependencies with `bun install`. Run `bun run verify` before review. It runs lint, typecheck, tests, and build.

Use Bun only. Run `bun run verify` before review. `dist/` is gitignored; main is source only. Releases are automated: bump `version` in package.json and push to main; the Action builds and tags `release`. Use `scripts/release.sh --dry-run` to test a release locally. Never publish to the npm registry.
