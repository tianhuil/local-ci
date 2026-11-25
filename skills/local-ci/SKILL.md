---

name: local-ci
description: Runs a pull request's Checks on this machine with `local-ci` and posts each result to GitHub as a Commit Status. Use after committing on a PR branch in a repo with `local-ci.yml`, when a `local-ci/<check>` status failed, or when adding or changing a Check.
---

# local-ci

`local-ci` pushes the current branch, runs every Check in `local-ci.yml`, and posts one Commit Status, `local-ci/<check>`, per Check to the pushed commit. It is installed as a dev dependency, so run it through the package manager: `pnpm exec local-ci` or `npx local-ci`.

## Run after each commit

```sh
git commit -am "Reject empty password"
pnpm exec local-ci
```

Exit 0 means every Check passed. Wait for the Run to finish: it exits once every Check has finished or hit its timeout.

## Fix a failed Check

1. Read the failure preview on stdout, or the full log it names: `.git/local-ci/logs/<sha>/<check>.log`.
2. Fix the code and commit. A new commit is a new SHA, so every Check runs again.
3. Run `local-ci` again, or `local-ci --only <check>` to run that Check and the Checks it depends on.

## Add or change a Check

Edit `local-ci.yml` at the repository root, commit, and run `local-ci`:

```yaml
timeout: 60 # seconds per Check; optional
checks:
  - name: lint # posts Commit Status local-ci/lint
    command: pnpm lint
  - name: unit
    command: pnpm test
    depends_on: [lint] # optional; runs only after lint passes
    run_if_changed: ["src/**"] # optional; runs only when a matching file changed
  - name: example
    command: pnpm install --frozen-lockfile && pnpm test
    copy: examples/app # optional; runs in a fresh copy of only this folder's committed files
```

A `copy` Check runs outside the worktree; reach the repository's scripts through `$LOCAL_CI_ROOT`.

An invalid file exits 1 with one line per problem, each naming the fix.

## Gotchas

- **Commit first.** The Run needs a Clean Tree: any uncommitted or untracked file stops it before anything runs.
- **It pushes.** It pushes the current branch (never with force) and refuses to run on the default branch. Start on a feature branch: `git switch -c <branch>`.
- **It posts with your `gh` login.** Run `gh auth login` once on the machine.
- **Same commit, same results.** Checks that already passed on this SHA are skipped. Commit a fix to rerun; `--force` reruns a passed Check only to rule out a flaky pass.

Run `local-ci --help` for options, examples, and exit codes. The full behavior is in the [usage contract](https://github.com/tianhuil/local-ci/blob/main/docs/context/usage.md).
