# `local-ci` Usage

The Author commits and runs `local-ci` with no arguments. The Runner checks for a Clean Tree, pushes the current branch, runs every Check in `local-ci.yml`, and posts one Commit Status per Check to GitHub. While Checks run, each one shows as `pending` (`running…`) on GitHub; the result replaces it when the Check finishes. It exits 0 only if every Check passed.

```console
$ git commit -m "Add login form"
$ local-ci
```

---

## Install

```console
$ pnpm add --global github:tianhuil/local-ci#v0.1.2
$ pnpm add --global github:tianhuil/local-ci#release
```

Install a newer tag to upgrade. `main` carries source only, so installs come from the `release` branch tags.

The Runner needs `git` and `gh` on PATH. Checks run in the Author's normal shell.

---

## Configure Checks

`local-ci.yml` at the repository root maps each Check name to a shell command. Each name becomes the Commit Status `local-ci/<name>`.

```yaml
timeout: 60 # seconds one Check may run; optional; default 60
checks:
  lint: pnpm lint
  typecheck: pnpm typecheck
  unit: vitest run
  build:
    command: act -j build # runs a GitHub Actions job locally; needs Docker
    timeout: 300 # optional; overrides the top-level timeout
```

A Check maps to either a command string or an object with a `command` and an optional `timeout` in seconds. A Check that exceeds its timeout is killed and fails; its line shows `timeout` in place of an exit code.

---

## Output

- **stdout:** one line per Check, a preview of each failed Check's output, and a totals line. The line shapes are stable: new fields may be added, and existing ones are never renamed or removed.
- **stderr:** progress (`pushing…`, `running unit…`) and errors.
- **Logs:** every Check's full output is saved to `.git/local-ci/logs/<sha>/<check>.log`. It stays on the Author's machine and is never committed.

The Runner never prompts. If `git push` would ask for credentials, it fails at once with an error instead.

---

## Run all Checks

The Runner pushes first, then posts a `pending` Commit Status (`running…`) for every Check about to run — so the PR shows the Run in progress — then runs every Check in parallel — all of them at once by default, or up to `--jobs N` at a time — even after one fails, then posts every result. Check lines print in `local-ci.yml` order once every Check has finished, so stdout stays stable while Checks interleave; live progress (`running lint…`) goes to stderr. The samples below show stdout and stderr together, as a terminal does.

```console
$ local-ci
pushed feature/login to origin (3f9c2ab)
lint       passed   4s
typecheck  passed  11s
unit       failed   7s  exit 1
build      passed  52s

unit output (last 1,500 of 8,432 chars):
 FAIL  src/login.test.ts > rejects empty password
   expected 400, received 200
full log: .git/local-ci/logs/3f9c2ab/unit.log

posted 4 Commit Statuses to 3f9c2ab; 1 of 4 Checks failed
$ echo $?
1
```

A failed Check's preview keeps the end of its output, where failures appear. A short log is shown whole, with no "last N chars" note. On a new branch with no upstream, the Runner sets `origin/<branch>` as the upstream.

On GitHub, the PR shows:

```
✓ local-ci/lint        passed in 4s
✓ local-ci/typecheck   passed in 11s
✗ local-ci/unit        failed in 7s (exit 1)
✓ local-ci/build       passed in 52s
```

Reviewers see only pass/fail.

---

## Re-run after a fix

A new commit is a new SHA, so every Check runs again.

```console
$ git commit -am "Reject empty password"
$ local-ci
pushed feature/login to origin (8d41e07)
lint       passed   4s
typecheck  passed  10s
unit       passed   7s
build      passed  49s

posted 4 Commit Statuses to 8d41e07; all 4 Checks passed
```

## Re-run on the same commit

Running twice is safe. There is nothing new to push, and Checks that already passed on this SHA are skipped. A Check counts as already passed only when the latest `local-ci/<check>` status on that commit is `success`: a Check that passed and later failed (for example under `--force`) runs again. Statuses posted by other tools never affect skipping.

```console
$ local-ci
feature/login already up to date on origin (3f9c2ab)
lint       skipped  already passed
typecheck  skipped  already passed
unit       failed   7s  exit 1
build      skipped  already passed
...
posted 1 Commit Status to 3f9c2ab; 1 of 4 Checks failed
```

If every Check already passed, nothing runs and the Runner exits 0:

```console
$ local-ci
feature/login already up to date on origin (8d41e07)
0 Checks run; all 4 already passed on 8d41e07
```

`--force` runs every Check anyway, for example to rule out a flaky pass.

---

## Run a subset of Checks

`--only` takes a comma-separated list of Check names and runs only those Checks. Preflight and the push are unchanged. A Check that is not named is neither run nor posted: its Commit Status from an earlier Run, if any, stands. Already-passed skipping still applies to the named Checks, and `--force` combines with `--only` (`local-ci --only unit --force`).

```console
$ local-ci --only unit
pushed feature/login to origin (3f9c2ab)
unit  passed   7s

posted 1 Commit Status to 3f9c2ab; all 1 Checks passed
```

The totals line and the posted-statuses line count only the selected Checks, not the whole config:

```console
$ local-ci --only lint,unit
pushed feature/login to origin (3f9c2ab)
lint  skipped  already passed
unit  failed   7s  exit 1
...
posted 1 Commit Status to 3f9c2ab; 1 of 2 Checks failed
```

If every named Check already passed on this commit, nothing runs and the Runner exits 0:

```console
$ local-ci --only lint,unit
feature/login already up to date on origin (3f9c2ab)
0 Checks run; all 2 already passed on 3f9c2ab
```

---

## Interrupting a Run

Ctrl-C (SIGINT) or SIGTERM kills the running Checks and posts an `error` Commit Status with description `interrupted` for every Check that has no final result, then exits 130. A signal while results are posting lets the in-flight posts finish — those results stand — and exits 130 without extra error posts.

---

## Errors

Each error is one line naming what failed, followed by the command that fixes it. Nothing is pushed, run, or posted when the Runner refuses to start.

| Situation                         | Error                                                                                                   | Exit |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ---- |
| Not a Clean Tree                  | `error: 2 uncommitted changes (src/login.ts, notes.txt); run git commit or git stash, then local-ci`    | 1    |
| On the default branch             | `error: on default branch main; run git switch -c <branch>, then local-ci`                              | 1    |
| Push rejected                     | `error: push of feature/login rejected, origin has newer commits; run git pull --rebase, then local-ci` | 1    |
| Push needs credentials            | `error: push to origin needs credentials; run gh auth setup-git, then local-ci`                         | 1    |
| `--no-push`, commit not on GitHub | `error: 3f9c2ab is not on GitHub; run local-ci without --no-push`                                       | 1    |
| No GitHub token                   | `error: no GitHub token; run gh auth login, then local-ci`                                              | 1    |
| Invalid `local-ci.yml`            | `error: local-ci.yml: check "unit" has no command; add one, e.g. unit: pnpm test`                       | 1    |
| Unknown option                    | `error: unknown option --forse; valid options: --force, --only, --no-push, --jobs, --help, --version`   | 2    |
| Unknown `--only` name             | `error: unknown Check "verfy" for --only; Checks: lint, audit, verify, build, browser-smoke`            | 2    |
| Invalid `--jobs` value            | `error: invalid value "0" for --jobs; use a positive integer, such as --jobs 4`                         | 2    |
| Extra argument                    | `error: unexpected argument "unit"; local-ci takes no arguments`                                        | 2    |

The Runner never force-pushes. A rejected push is the Author's to resolve.

No PR is needed. Commit Statuses attach to the commit and appear once a PR is opened on it.

---

## Exit codes

| Code  | Meaning                                                                       |
| ----- | ----------------------------------------------------------------------------- |
| `0`   | Every Check passed, or was skipped as already passed.                         |
| `1`   | A Check failed, or the Run could not start. The output says which.            |
| `2`   | Unknown option or extra argument. Nothing ran.                                |
| `130` | Interrupted (SIGINT/SIGTERM); unfinished Checks posted `error`/`interrupted`. |

---

## `local-ci --help`

```console
$ local-ci --help
Usage: local-ci [options]

Push the current branch, run every Check in local-ci.yml, and post one
Commit Status (local-ci/<check>) per Check to the pushed commit on GitHub.
Each Check posts pending ("running…") while it runs, then its final state.
Prints one line per Check; full logs go to .git/local-ci/logs/<sha>/.

Options:
  --force          run every Check, even ones that already passed on this
                   commit (default: skip them)
  --only <names>   run only the named Checks, comma-separated; the rest
                   keep their Commit Statuses from earlier Runs
  --no-push        don't push; HEAD must already be on GitHub (default: push)
  -j, --jobs <N>   run up to N Checks at once (default: all Checks at once)
  -V, --version    print the version
  -h, --help       print this help

Examples:
  local-ci                 run after each commit
  local-ci --force         re-run everything, e.g. to rule out a flaky pass
  local-ci --only unit     run one Check, e.g. after fixing a failure
  local-ci --no-push       the commit was already pushed some other way
  local-ci --jobs 1        run Checks one at a time, e.g. if they conflict

Exit codes:
  0    every Check passed or had already passed
  1    a Check failed, or the Run could not start (see the error line)
  2    unknown option or argument
  130  interrupted (Ctrl-C or SIGTERM): running Checks are killed and the
       unfinished ones post error/interrupted
```

`local-ci --version` prints only the version.

---

## Not yet decided

- **Streaming:** only failed Checks' output is shown, after the summary, rather than all output live.
- **`--force-with-lease`:** an opt-in force-push for Authors who amend or rebase.
