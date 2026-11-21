# `local-ci` Usage

The Author commits and runs `local-ci` with no arguments. The Runner checks for a Clean Tree, pushes the current branch, runs every Check in `local-ci.yml`, and posts one Commit Status per Check to GitHub. It exits non-zero if any Check failed.

```console
$ git commit -m "Add login form"
$ local-ci
```

---

## Configure Checks

`local-ci.yml` at the repository root maps each Check name to a shell command. Each name becomes the Commit Status `local-ci/<name>`.

```yaml
checks:
  lint: bun run lint
  typecheck: bun run typecheck
  unit: bun test
  build: act -j build   # runs a GitHub Actions job locally; needs Docker
```

---

## Run all Checks

The Runner pushes first, then runs every Check, even after one fails, then posts every result.

```console
$ local-ci
Pushed feature/login to origin (3f9c2ab)
Run on 3f9c2ab

  lint       ✓ passed    4s
  typecheck  ✓ passed   11s
  unit       ✗ failed    7s  exit 1
  build      ✓ passed   52s

--- unit output ---
 FAIL  src/login.test.ts > rejects empty password
   expected 400, received 200
---

Posted 4 Commit Statuses to 3f9c2ab.
1 of 4 Checks failed.
$ echo $?
1
```

On a new branch with no upstream, the Runner sets `origin/<branch>` as the upstream.

On GitHub, the PR shows:

```
✓ local-ci/lint        passed in 4s
✓ local-ci/typecheck   passed in 11s
✗ local-ci/unit        failed in 7s (exit 1)
✓ local-ci/build       passed in 52s
```

Logs stay in the Author's terminal. Reviewers see only pass/fail.

---

## Re-run after a fix

A new commit is a new SHA, so every Check runs again.

```console
$ git commit -am "Reject empty password"
$ local-ci
Pushed feature/login to origin (8d41e07)
Run on 8d41e07

  lint       ✓ passed    4s
  typecheck  ✓ passed   10s
  unit       ✓ passed    7s
  build      ✓ passed   49s

Posted 4 Commit Statuses to 8d41e07.
All 4 Checks passed.
```

## Re-run on the same commit

There is nothing new to push. The Runner asks GitHub first and skips Checks that already passed on this SHA.

```console
$ local-ci
feature/login already up to date on origin (3f9c2ab)
Run on 3f9c2ab

  lint       – skipped  already passed
  typecheck  – skipped  already passed
  unit       ✗ failed    7s  exit 1
  build      – skipped  already passed

Posted 1 Commit Status to 3f9c2ab.
1 of 4 Checks failed.
```

`--force` runs every Check anyway, for example to rule out a flaky pass:

```console
$ local-ci --force
```

## Run without pushing

`--no-push` skips the push. The commit must already be on GitHub.

```console
$ local-ci --no-push
```

---

## When the Runner refuses to start

The Runner runs and posts nothing unless it can certify the exact pushed commit.

**Not a Clean Tree:**

```console
$ local-ci
error: working tree has uncommitted changes:
   M src/login.ts
  ?? notes.txt
Commit or stash them, then run local-ci again.
$ echo $?
2
```

**Push rejected** (the remote branch has commits you don't have). The Runner never force-pushes:

```console
$ local-ci
error: push of feature/login was rejected: origin has newer commits.
Run `git pull --rebase`, then run local-ci again.
$ echo $?
2
```

**On the default branch.** Pushing there would skip PR review:

```console
$ local-ci
error: on main, the default branch. Local CI runs on PR branches only.
Run `git switch -c <branch>`, then run local-ci again.
$ echo $?
2
```

**`--no-push` and the commit isn't on GitHub:**

```console
$ local-ci --no-push
error: 3f9c2ab is not on GitHub yet.
Run local-ci without --no-push, or `git push` first.
$ echo $?
2
```

**No `gh` login:**

```console
$ local-ci
error: no GitHub token. Run `gh auth login`, then run local-ci again.
$ echo $?
2
```

No PR is needed. Commit Statuses attach to the commit and appear once a PR is opened on it.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every Check passed or was skipped as already passed. |
| `1` | At least one Check failed. All results were posted. |
| `2` | The Run did not start: not a Clean Tree, push rejected, on the default branch, commit not on GitHub with `--no-push`, no `gh` login, or invalid `local-ci.yml`. Nothing was run or posted. |

---

## Not yet decided

This usage assumes a few things that `base.md` doesn't settle:

- The exit codes above.
- Printing only failed Checks' output after the summary, rather than streaming all output live.
- No way to run a subset of Checks (e.g., `local-ci unit`).
