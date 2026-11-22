# local-ci

[![CI](https://github.com/tianhuil/local-ci/actions/workflows/ci.yml/badge.svg)](https://github.com/tianhuil/local-ci/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.1.0-blue)](https://github.com/tianhuil/local-ci/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`local-ci` runs a pull request's checks on the Author's own machine and posts each result to GitHub as a Commit Status (`local-ci/<check>`), so PRs don't spend cloud CI minutes or wait in a runner queue. Your `main` branch keeps its normal cloud CI as the neutral authority.

Works with any repository that uses GitHub pull requests and a YAML file of shell commands. Not for teams that need untrusted code isolated from Author machines.

## Install

Requires [Node.js 18+](https://nodejs.org), `git`, and the [GitHub CLI](https://cli.github.com) logged in (`gh auth login` — the default scopes already allow Commit Statuses).

```sh
pnpm add --global github:tianhuil/local-ci#v0.1.0   # or: npm i -g github:tianhuil/local-ci#v0.1.0
```

For one-off runs use `npx github:tianhuil/local-ci#v0.1.0`, `pnpm dlx`, or `bunx`; pin a tag for repeatability, because `pnpm dlx` and `bunx` cache the moving `#release` ref.

```sh
$ local-ci --version
0.1.0
```

`main` carries source only; installs come from the [`release`](https://github.com/tianhuil/local-ci/tree/release) branch and its tags.

## How it works

Commit, then run `local-ci` with no arguments:

```console
$ local-ci
pushed feature/login to origin (3f9c2ab)
lint       passed   4s
typecheck  passed  11s
unit       failed   7s  exit 1
build      passed  52s

unit output (last 1,500 of 8,432 chars):
 ...
full log: .git/local-ci/logs/3f9c2ab/unit.log

posted 4 Commit Statuses to 3f9c2ab; 1 of 4 Checks failed
```

Each run: verify the working tree is clean, push the current branch, run every Check from `local-ci.yml` in parallel (each killed after its timeout), and post one Commit Status per Check. The PR then shows:

```
✓ local-ci/lint        passed in 4s
✓ local-ci/typecheck   passed in 11s
✗ local-ci/unit        failed in 7s (exit 1)
✓ local-ci/build       passed in 52s
```

Checks are declared in `local-ci.yml` at the repository root:

```yaml
timeout: 60          # seconds per Check; default 60
checks:
  lint: pnpm lint
  typecheck: pnpm typecheck
  unit: vitest run
  build:
    command: act -j build   # run a GitHub Actions job locally; needs Docker
    timeout: 300            # overrides the top-level timeout
```

Key design choices, one line each:

- **Your `gh` token, no shared secret.** Statuses post through the Commit Statuses API with the login you already have; no GitHub App private key to distribute.
- **Logs stay local.** Reviewers see pass/fail per check; full output lives in `.git/local-ci/logs/`. A Commit Status only carries 140 characters.
- **Never force-pushes.** A rejected push is the Author's to resolve; nothing runs, nothing is posted.
- **Idempotent.** Checks that already passed on the exact SHA are skipped; `--force` re-runs everything.
- **Trust, not enforcement.** Any Author with write access can post any status — this is a team-trust tool, which is why `main` stays on cloud CI.

Full behavior — every option, the error table, exit codes — is specified in the [usage contract](docs/context/usage.md); the reasoning behind the architecture is in the [context doc](docs/context/base.md) and [ADRs](docs/adr/).

## Development

```sh
pnpm install
pnpm verify        # lint + typecheck + build + unit tests; run before review
pnpm test:e2e      # pushes a throwaway branch and posts real Commit Statuses
pnpm release check # build and validate the next release commit locally
```

Releases are automated: bump `version` in package.json and push to `main`; a workflow publishes and verifies the install seven ways. Never publish to the npm registry. See [AGENTS.md](AGENTS.md) for the full working agreement.

## License

[MIT](LICENSE) © 2026 tianhuil
