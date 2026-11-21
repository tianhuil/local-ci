# local-ci

Run repository Checks locally and publish GitHub Commit Statuses without cloud CI.

```sh
bun install --global github:tianhuil/local-ci#v0.1.0
# or install the latest release branch:
# bun install --global github:tianhuil/local-ci#release
```

For one-off runs, use `npx`, `pnpm dlx`, or `bunx`; pin a tag for repeatability because `pnpm dlx` and `bunx` cache the moving `#release` ref.

See [the usage contract](docs/context/usage.md).
