# Feature: Check pipeline — pending statuses, `--only`, `depends_on`, `run_if_changed`

## Executive Summary

mockatoo wants its PR Checks on local-ci instead of GitHub Actions. Four features make that possible without workarounds; two earlier ideas (`local-ci status`, `env_file`) are dropped. Ship one PR per feature, in PR order below, each bumping `version` so the release workflow publishes it on merge: 0.1.1, 0.1.2, 0.2.0 (breaking), 0.2.1. Every PR updates `docs/context/usage.md`, the README, the `--help` text in `src/cli.ts` (a test matches it byte for byte), and `tests/cli.test.ts`.

Success: after 0.2.1, a mockatoo Run posts `pending` while Checks execute, runs a dependency-ordered subset on `--only`, skips Checks whose files did not change, and reports `blocked` for Dependents of a failed Check.

## Scope, Terminology, and Invariants

**In scope:** the four features below, in local-ci. **Out of scope:** `local-ci status` and `env_file` (see Decision Log); mockatoo adoption (follow-up).

Terms follow `GLOSSARY.md` (**Check**, **Run**, **Author**, **Runner**, **Commit Status** — one named verification posted as `local-ci/<name>`; **Clean Tree**). This design adds:

- **Dependent**: a Check that lists another Check in its `depends_on` field.

Invariants:

1. Stdout prints Check lines in `local-ci.yml` list order, whatever the execution order.
2. A Check is never skipped while a Dependent of it runs: if `connectors` passed earlier on this SHA but `unit` must run now, `connectors` reruns (its build output may not exist in this working tree). Applies to already-passed skipping, `--only`, and `run_if_changed`.
3. Posting depends on why a Check didn't run: not selected by `--only` — nothing posted (its status from an earlier Run, if any, stands); skipped as already passed — nothing posted (its `success` status already exists); skipped by `run_if_changed` — posts `success`/`no matching changes`; blocked — posts `failure`/`not run; depends on <names>`.
4. List order is the order everywhere: output order, and which ready Check starts first.
5. Precedence, outermost first: `--only` selection → already-passed skip (bypassed by `--force` and by invariant 2) → `run_if_changed` filter → dependency blocking. `--force` reruns already-passed Checks but does not bypass the path filter; to force a path-filtered Check, change its globs. Invariant 2 overrides the path filter: a dependency of a Check that will run is rerun even when its own paths didn't change.

## User Stories

1. As an Author, I want a `pending` Commit Status while Checks run, so reviewers see the Run in progress.
2. As an Author, I want `local-ci --only unit`, so I rerun one Check plus its dependencies.
3. As an Author, I want `depends_on`, so a Check waits for the Checks it needs built first.
4. As an Author, I want `run_if_changed`, so unrelated Changes don't run unrelated Checks.

## Requirements and Ownership

| ID   | Observable outcome                                                                                                         | Owner                           | Source of truth | Verification              | Severity |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------- | ------------------------- | -------- |
| R-01 | `pending` posted for every Check about to run, after push, before execution                                                | `src/github.ts`                 | this design §P1 | `tests/cli.test.ts` MC-01 | High     |
| R-02 | SIGINT/SIGTERM: kill Checks, post `error`/`interrupted` for unfinished, exit 130                                           | `src/index.ts`                  | this design §P1 | MC-02                     | High     |
| R-03 | Skip decision uses only the latest status per `local-ci/*` context                                                         | `src/github.ts`                 | this design §P1 | MC-03, MC-04              | High     |
| R-04 | `--only` runs/posts named Checks plus their dependencies; others untouched                                                 | `src/cli.ts`, `src/index.ts`    | this design §P2 | MC-06, MC-08              | High     |
| R-05 | Unknown `--only` name: exit 2, exact error listing valid names                                                             | `src/cli.ts`                    | this design §P2 | MC-07                     | Medium   |
| R-06 | List-form config validates via zod with fix-it messages, one issue per line                                                | `src/config.ts`                 | this design §P3 | MC-11–MC-17               | High     |
| R-07 | v0.1.0 map form fails with `checks must be a list; see usage.md for the list form`                                         | `src/config.ts`                 | this design §P3 | MC-12                     | High     |
| R-08 | Dependent starts when dependencies passed; never more than `--jobs` at once; blocked Dependent posts `failure` and exits 1 | `src/index.ts`                  | this design §P3 | MC-18–MC-20               | High     |
| R-09 | `run_if_changed` Check runs only when a changed file matches; skips post `success`                                         | `src/config.ts`, `src/index.ts` | this design §P4 | MC-22–MC-27               | High     |
| R-10 | Each PR: version bump, README, usage.md, help text, tests synchronized                                                     | every PR                        | this design     | `pnpm verify`; MC-21      | High     |

## Technical Design

### PR order

| PR  | Feature                                                 | Depends on                       | Version |
| --- | ------------------------------------------------------- | -------------------------------- | ------- |
| 1   | #3 pending Commit Status + latest-status-per-Check read | —                                | 0.1.1   |
| 2   | #5 `--only` subset                                      | —                                | 0.1.2   |
| 3   | #1 Checks as list with `depends_on`                     | PR 2 (shares "which Checks run") | 0.2.0   |
| 4   | #2 `run_if_changed`                                     | PR 3                             | 0.2.1   |

PR 1 goes first because later PRs rely on its bug fix (R-03).

### P1 — pending Commit Status, latest status per Check (PR 1)

Today `statuses()` reads `GET repos/{slug}/statuses/{sha}` and keeps any context that ever had `success`, so a Check that passed then failed under `--force` still counts as passed. Switch to `GET repos/{slug}/commits/{sha}/status?per_page=100`, which returns only the latest state per context. Use only `local-ci/*` contexts; ignore the response's top-level `state` (GitHub computes it over every tool's contexts).

After the push and before running, post `pending` with description `running…` for every Check about to run. Install signal handlers after the push and keep them until exit: while Checks run, SIGINT/SIGTERM kills running Checks and posts `error` with description `interrupted` for each Check without a final result, then exits 130; while results post, finish the in-flight posts (they are final) and exit 130 without extra error posts. In `tests/cli.test.ts`, the fake `gh` must route `*/commits/*/status*` before the generic `*/commits/*` case and return the combined `{ statuses: […] }` shape, and tests must assert the combined endpoint was actually called (log request URLs), so keeping the old history endpoint cannot pass (MC-03, MC-04). The e2e test spawns the Runner asynchronously and polls `commits/{sha}/status` while a slow Check still runs, asserting some `local-ci/*` context is `pending` at least once (MC-05). An interrupt stops the scheduler first — no un-started Check starts, and every Check that posted pending but has no final result gets error/interrupted — and a failed pending post fails the Run (exit 1), like a failed result post. Every Check that posted pending receives either its final result (if it completed) or error/interrupted; shutdown posts share one global bound rather than 10 seconds each, and a second signal force-exits 130. Handlers are installed before preflight — a signal there exits 130 immediately, with nothing posted — and the stateful handler takes over after the push. Every git and gh child runs in a tracked process group that each signal exit path kills, and the repository slug is resolved once, before any posting.

### P2 — `--only <names>` (PR 2)

`local-ci --only verify,lint` runs and posts only those Checks (plus every Check they depend on, after PR 3). Preflight and push unchanged. The totals line and the posted-statuses line use the selected closure (named Checks plus dependencies) as their denominator, not the full config (MC-39). Already-passed skipping still applies to named Checks; `--force` combines (`--only verify --force`). If every named Check already passed, print `0 Checks run; all N already passed on <sha>` and exit 0. Invariant 2 overrides the skip. Unknown name exits 2: `error: unknown Check "verfy" for --only; Checks: lint, audit, verify, build, browser-smoke`. Positional arguments stay an error; delete the "Subset of Checks" bullet under usage.md's "Not yet decided".

### P3 — Checks as a list with `depends_on` (PR 3)

`checks` becomes a list; the map form is removed and fails with `checks must be a list; see usage.md for the list form`. v0.1.0 has no known users outside tianhuil's repos; bump to 0.2.0 and move local-ci's own `local-ci.yml` to the list form.

```yaml
timeout: 120
checks:
  - name: connectors
    command: pnpm --filter ./connectors build
  - name: typecheck
    command: pnpm exec tsc --noEmit
    depends_on: [connectors]
  - name: unit
    command: pnpm test:ci
    depends_on: [connectors]
    timeout: 600
```

Add `zod@^4` to `dependencies`. Replace `src/config.ts`'s hand-written checks with `ConfigSchema = z.strictObject({ timeout, checks })`, `CheckSchema = z.strictObject({ name, command, timeout?, depends_on? })`, derive `Check` via `z.infer`. Field rules: `name` keeps the existing regex and rejects `..`; `command` is `z.string().trim().min(1)`; `timeout` finite positive, top-level default 60; `depends_on` an array of names. Whole-config rules in one `.superRefine` with a `path` per bad item: unique names; every `depends_on` name exists and isn't the Check itself; no cycles, message names the cycle (`depends_on cycle unit -> build -> unit`). Every rule sets a fix-it message (`has no command; add one, e.g. command: pnpm test`), never zod's default. On failure print `error: local-ci.yml is invalid` then `z.prettifyError(error)` and exit 1; invalid YAML stays a one-line error. Strict objects reject typos such as `depends-on`.

Replace the single `pMap` with a scheduler that starts a Check once every dependency has passed, never exceeds `--jobs`, and among ready Checks starts in list order. A Dependent whose dependency failed, timed out, or was blocked doesn't run: its line reads `blocked  depends on <names>` naming every direct dependency that did not pass, in `depends_on` order; a transitively blocked Check names its direct (blocked) dependency. It posts `failure` with description `not run; depends on <names>`, and the Run exits 1. This PR also migrates every map-form fixture to the list form — `local-ci.yml`, `tests/cli.test.ts` (including `makeRepo`'s default config), `tests/github.e2e.test.ts`, and doc examples — updates `pnpm-lock.yaml` for zod, and keeps `pnpm install --frozen-lockfile` passing (the release workflow installs frozen).

### P4 — `run_if_changed` (PR 4)

Optional per-Check list of globs (GitHub Actions `paths` syntax, `!` exclusions). Absent: runs every Run. Empty list: schema error, not a way to never run. Schema: `run_if_changed: z.array(z.string().min(1)).min(1).optional()`.

Changed files: `git diff --name-only $(git merge-base origin/<default> HEAD) HEAD`, default branch as preflight finds it today. Don't fetch first. No merge base: run every Check. The merge base is where the branch left the default branch, so later default-branch commits never count as changes; a stale `origin/<default>` can only add Checks, never miss one. A path-skipped Check is a result of the Run, not a skip past the post step: it prints `skipped  no matching changes`, posts `success` with that description, and counts in the totals line; the existing `0 Checks run; all N already passed` early return fires only when every Check was skipped as already passed (MC-29). An already-passed Check short-circuits before the path filter and posts nothing (MC-28). Add `picomatch` for matching (`engines` allows Node 18, which lacks `path.matchesGlob`), update `pnpm-lock.yaml`, and keep `pnpm install --frozen-lockfile` passing.

### State and Mode Matrix

| Mode                                | Runs                                                      | Posts                                                                                      | Exit                                                    |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| default                             | Checks not already passed                                 | pending → result; path-skipped → `success`/`no matching changes`; already-passed → nothing | 0/1                                                     |
| `--force`                           | everything not path-skipped                               | pending → result; path-skipped → `success`                                                 | 0/1                                                     |
| `--only`                            | named + dependencies (dep-of-named forced by invariant 2) | only those; totals use the selected closure                                                | 0/1                                                     |
| `--only --force`                    | named + dependencies, rerun (path filter still applies)   | only those                                                                                 | 0/1                                                     |
| every selected Check already passed | none                                                      | none                                                                                       | 0, prints `0 Checks run; all N already passed on <sha>` |
| every Check path-skipped            | none                                                      | `success`/`no matching changes` per Check                                                  | 0                                                       |
| dependency failed or blocked        | Dependents don't run                                      | `failure`/`not run; depends on <names>`                                                    | 1                                                       |
| SIGINT/SIGTERM while running        | killed                                                    | `error`/`interrupted` for unfinished                                                       | 130                                                     |
| SIGINT/SIGTERM while posting        | posting finishes                                          | in-flight results stand                                                                    | 130                                                     |
| unknown `--only` name               | nothing                                                   | nothing                                                                                    | 2                                                       |
| map-form config                     | nothing                                                   | nothing                                                                                    | 1, `checks must be a list; …`                           |

## Required-Case Manifest

`notes/design/local-ci-features-manifest.yml` is the design-owned denominator: one row per required case with `id`, `phase`, `file` (test file that must contain the id in a test name), and `behavior`. It also carries `enforced_phases`, initially `[P1]`; each PR appends its own phase. `tests/manifest.test.ts` loads it and fails unless every `id` whose phase is enforced appears in its `file`'s source, so a missing case fails in code while future phases stay pending instead of red. Cases MC-01…MC-42 cover: P1 pending-before-run, signal kill (including during posting), latest-state rerun, foreign contexts ignored, real pending in e2e; P2 subset, unknown name, `--force` combine, all-passed message, positional still error, closure-denominator totals; P3 list parses, map rejected, unknown field, duplicate name, missing/self `depends_on`, cycle, every field-rule rejection (invalid name, blank command, bad timeouts, empty list, malformed `depends_on`), scheduler order and jobs cap, blocked line/post/exit (single, multi-dependency, transitive), rerun rule, help byte-for-byte; P4 glob match, `!` ordering, empty list, no merge base, skip line/post, stale-origin over-run only, skip-reason precedence, all-path-skipped Run, `--force`/`--only` × path filter, dependency rerun despite unchanged paths. The guard is the denominator tripwire only — it proves no case vanished, not that its test asserts anything. Assertion strength is enforced by review: every case's test carries real assertions (negative assertions where the behavior says "rejected"), and each review round's absence check stubs the behavior in a disposable copy and confirms that case's test fails.

## External-Assumption Register

| Assumption                                                       | Probe / citation                                                                                       | Result                                                   | Policy if false                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pending` is a valid Commit Status state                         | GitHub REST docs, Commit Statuses                                                                      | documented                                               | none expected; e2e covers                                                                                |
| `commits/{sha}/status` returns latest state per context          | observed 2026-11-22, `gh` 2.97.0, mockatoo commit `130d045` (`total_count: 2` after 4 history entries) | observed, undocumented                                   | P1 e2e fails; fall back to newest-first history + last-state-wins fold                                   |
| `per_page` default 30, cap 100; history newest-first             | GitHub REST docs                                                                                       | documented                                               | always pass `per_page=100`                                                                               |
| ≤1,000 statuses per SHA and context                              | GitHub docs                                                                                            | documented                                               | `pending` doubles posts → 500 Runs per Check per SHA to cap; accept                                      |
| `gh api` passes `-f state=pending` through                       | observed via `gh` 2.97.0                                                                               | observed                                                 | e2e covers                                                                                               |
| `picomatch` matches Actions `paths` semantics incl. `!` ordering | **unverified**                                                                                         | P4 probe: unit tests against Actions-documented examples | divergence on documented examples blocks P4: owner picks documented-subset semantics or a custom matcher |
| `z.prettifyError` fits local-ci error style (multi-line)         | **unverified**                                                                                         | P3 decides against usage.md's error table                | format issues manually, same content                                                                     |

## Evidence and Provenance

- Source: `notes/design/local-ci-features-handoff.md` in the mockatoo repo (private), read 2026-11-23; its file pointers were written against `main` at `81e3551` and re-verified against `f59ce7d` (current `main`): `statuses()` history bug, byte-for-byte help test, positional-arg error, engines `>=18`, release script no-ops when the tag exists.
- The mockatoo motivation and replaced workarounds live in that handoff; this doc carries only what local-ci needs.
- GitHub API observations: captured read-only on 2026-11-22 with `gh` 2.97.0 (see register). Drift policy: any behavior change surfaces as an e2e failure; re-observe and update the register in the same PR.

## Implementation Plan

### Phase P1 (PR 1, v0.1.1)

- [x] P1-01 Manifest + guard — done when `notes/design/local-ci-features-manifest.yml` and `tests/manifest.test.ts` exist, `enforced_phases` is `[P1]`, and `pnpm verify` is green with every P1 case present — verify: cmd: `pnpm verify` — covers: R-10
- [x] P1-02 `statuses()` reads combined endpoint, latest per context, `local-ci/*` only — done when a Check whose latest state is `failure` after an older `success` reruns — verify: cmd: `pnpm test` (MC-03, MC-04) — covers: R-03
- [x] P1-03 Post `pending`/`running…` before running; `error`/`interrupted` + exit 130 on SIGINT/SIGTERM — done when the fake `gh` log shows pending before each result, and SIGTERM posts error — verify: cmd: `pnpm test` (MC-01, MC-02) — covers: R-01, R-02
- [x] P1-04 e2e posts a real `pending` — done when `pnpm test:e2e` observes it on GitHub — verify: cmd: `pnpm test:e2e` (MC-05) — covers: R-01
- [x] P1-05 Docs, help, README, version 0.1.1; `tests/cli.test.ts` hardcoded `0.1.0` expectations updated; `tests/release.test.ts` derives its baseline tag and next version from `package.json` instead of hardcoding `v0.1.0`/`0.1.1` — done when help matches usage.md byte for byte and release tests pass at the new version — verify: cmd: `pnpm verify` (MC-21) — covers: R-10

### Phase P2 (PR 2, v0.1.2)

- [x] P2-01 `--only` parsing, subset selection, skip/force interaction, exact unknown-name error, positional still an error — done when MC-06…MC-10 pass and P2 is appended to `enforced_phases` — verify: cmd: `pnpm test` — covers: R-04, R-05
- [x] P2-02 Docs, help, README, version 0.1.2; "Not yet decided" subset bullet removed — verify: cmd: `pnpm verify` — covers: R-10

### Phase P3 (PR 3, v0.2.0)

- [x] P3-01 zod schemas, messages, `z.infer` Check type; local-ci's own `local-ci.yml` in list form — done when MC-11…MC-17 pass — verify: cmd: `pnpm test` — covers: R-06, R-07
- [x] P3-02 Scheduler with `depends_on`, `--jobs` cap, list-order starts and output; blocked semantics — done when MC-18…MC-20 pass and P3 is appended to `enforced_phases` — verify: cmd: `pnpm test` — covers: R-08
- [x] P3-03 Decide `z.prettifyError` vs manual formatting; update usage.md error table — done when the invalid-config row matches the shipped output — verify: review: error output matches the documented row
- [x] P3-04 Docs, help, README, version 0.2.0 — verify: cmd: `pnpm verify` (MC-21) — covers: R-10

### Phase P4 (PR 4, v0.2.1)

- [ ] P4-01 Probe picomatch against Actions `paths` examples; record result in the register — verify: review: probe tests cited, register updated
- [ ] P4-02 `run_if_changed` schema + changed-files diff + skip posts — done when MC-22…MC-27 pass and P4 is appended to `enforced_phases` — verify: cmd: `pnpm test` — covers: R-09
- [ ] P4-03 Docs, help, README, version 0.2.1 — verify: cmd: `pnpm verify` — covers: R-10

## Protected Paths

`notes/design/local-ci-features-design.md` (this file), `notes/design/local-ci-features-manifest.yml`, `tests/manifest.test.ts`, `tests/cli.test.ts`, `tests/github.e2e.test.ts`, `docs/context/usage.md`. Written/approved with P1; implementers may add cases but not remove, rename, or weaken one.

## Acceptance Environment

The local-ci clone on `main` with pnpm 10 and Node 24, `gh` authenticated as tianhuil (e2e pushes throwaway `local-ci-e2e/*` branches to this repo and deletes them). Consumer side: a mockatoo checkout with `gh`, installing `github:tianhuil/local-ci#v0.2.1`.

## Owner Acceptance Script

1. `pnpm verify` — expected: all green, help matches usage.md byte for byte.
2. `pnpm test:e2e` — expected: a real `pending` Commit Status observed on GitHub, then `success`.
3. In mockatoo with the new config: `local-ci` — expected: Check lines in list order; `gh pr checks --watch` shows `local-ci/*` as pending during the Run.
4. `local-ci --only lint` (plus a dependency) — expected: only those run and post.
5. Ctrl-C during a slow Check — expected: unfinished Checks post `error`/`interrupted`, exit code 130.
6. Break a dependency Check on purpose — expected: Dependent line `blocked  depends on <name>`, Run exits 1.
7. Restore a v0.1.0 map-form config — expected: `error: local-ci.yml: checks must be a list; see usage.md for the list form`, exit 1.

## Acceptance Matrix and Completion Gate

Per PR: `pnpm verify` green; `tests/manifest.test.ts` green (every manifest id for that phase present in its file); review approved. A phase counts as complete only after the owner runs the Owner Acceptance Script on installed release tag `v<version>`; failures become fix work in the same phase. The gate fails closed: a missing manifest case, a failing e2e, or an unrun owner script blocks the next phase.

## Review Record

- Round 1 (2026-11-23): independent adversarial reviewer (`reviewer` agent, gpt-5.6-luna:high), verdict BLOCK — 1 Critical, 8 High, 4 Medium. All resolved in the design the same day: guard scoped to the denominator with assertion strength proven by review absence checks (C); fake-gh combined-endpoint routing with an endpoint-called assertion (H); async e2e polling to observe transient pending (H); skip-reason posting precedence replacing the contradictory invariant (H); path-skip results fix the `0 Checks run` fast path (H); mode precedence stated with matrix cases (H); schema field-rule cases added (H); PR 3 migrates every map-form fixture including e2e (H); release tests derive versions from `package.json` (H); `--only` closure denominator (M); blocked-message selection rules (M); signal-during-posting semantics (M); picomatch divergence blocks P4 (M); lockfile + frozen-install steps (M). Details: `notes/design/local-ci-features-review.md`.
- Approval authority: tianhuil.
- Approved-by: tianhuil 2026-11-23 (owner directed implementation and merge of all four PRs in the build session).

## Out of Scope and Follow-ups

- mockatoo adoption (rewrite its `local-ci.yml` in list form; point `build-worktree`'s `monitor-ci.sh` at local-ci's exit code or `gh pr checks --watch` plus the never-posted check) — owner: tianhuil, after 0.2.1.
- Merge-gate skills must confirm every Check in `local-ci.yml` has a `local-ci/<name>` entry (`gh pr checks --json name,bucket`), because `gh pr checks` cannot know the expected list — owner: tianhuil, in mockatoo.

## Decision Log

- 2026-11-23 Drop `local-ci status`: the Author gets the answer from the exit code; anyone else uses `gh pr checks`. — alternatives: read-only status query — contract impact: none.
- 2026-11-23 Drop `env_file`: a test loads its own env so it behaves the same under local-ci, `pnpm test`, and cloud CI; the mockatoo case it served doesn't exist.
- 2026-11-23 `--only` flag, not positional names; positional stays an error. — keeps preflight-free argument grammar consistent.
- 2026-11-23 zod for config validation; `Check` derived by `z.infer` so type and validation can't drift; strict objects to reject typos.
- 2026-11-23 picomatch for globs; Node 18 lacks `path.matchesGlob`.
- 2026-11-23 Break the map form in 0.2.0 rather than dual-parse; no known users outside tianhuil's repos.
- 2026-11-23 PR order 1–4 as tabulated; PR 1 first because later PRs rely on the latest-status fix.
- 2026-11-23 Merge-base diff without fetching; a stale `origin/<default>` can only over-run Checks, never miss one.

## Boundaries

- ✅ Always: one PR per feature in order; update usage.md, README, help, tests, and version in the same PR; keep GLOSSARY terms; `pnpm verify` green before review.
- ⚠️ Ask first: dependencies beyond zod and picomatch; changing posted-status semantics; supporting the old map form.
- 🚫 Never: publish to npm; weaken the byte-for-byte help test or the manifest guard; claim a case passes without its test.
