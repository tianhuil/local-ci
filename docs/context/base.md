# Local CI Architecture & Decision Record

## Executive Summary

We will run all CI checks locally on developer machines and publish each check's pass/fail result directly to GitHub Pull Requests via the **GitHub Commit Statuses API** (`/repos/{owner}/{repo}/statuses/{sha}`), using each Author's existing `gh` login. Logs stay on the Author's machine for now.

To avoid repository bloat, ref contention, and maintenance overhead, we will **not** store test results in Git (`git notes` or custom `refs/test/*` hierarchies). GitHub's backend database will serve as the single source of truth for all CI results, while local execution remains fast, stateless, and free of cloud runner costs.

---

## Why now?

1. Agentic development means we consume a lot more GitHub CI time than previously. This gets expensive. Moving PR checks to local CI removes that cost for PR runs; main keeps running on GitHub CI, so its cost does not change.
2. Agentic development on a git worktree is already verified by the agent but then has to wait on a cloud CI pipeline as a PR for the same set of tests. This slows down the agent for no real gain.

## Intended Product Overview

The solution consists of a lightweight CLI wrapper (`local-ci`) paired with a declarative repository configuration file (`local-ci.yml`):

1. **Trigger:** The agent runs `local-ci` after each commit. By default the runner pushes the current branch first (see **Push Before Posting** below).
2. **Declarative Check Definition (`local-ci.yml`):** A committed YAML file at the repository root listing the required checks (e.g., `lint`, `typecheck`, `unit`, or `nektos/act` jobs; `act` needs Docker and does not support every GitHub Actions feature, so an `act` job can behave differently than on GitHub). Each check maps 1-to-1 to a named Commit Status in GitHub (context `local-ci/<check-name>`).
3. **Clean-State Verification:** Before running any check, the runner verifies that the working tree is clean (`git status --porcelain`) so unverified or uncommitted local edits cannot be certified against a commit SHA.
4. **Local Execution:** The runner executes each command locally, in parallel (`pMap`; all Checks at once by default, or up to `--jobs N` at a time), and records each exit code and duration. A Check that exceeds its timeout (default 60 seconds; configurable in `local-ci.yml`) is killed and fails. Output is shown in the Author's terminal only. A failing check does not stop the run: every check runs and every result is posted.
5. **GitHub Publishing:** Using the Author's `gh` token, the runner posts a `success` or `failure` Commit Status to the active `HEAD` commit SHA. Reviewers see pass/fail per check in the PR. They cannot see logs in GitHub (see **Future**).

---

## Key Architectural Decisions & Rationale

Recorded as ADRs:

- [ADR 0001: Local CI for pull requests; Main CI stays in the cloud](../adr/0001-local-ci-for-prs-main-ci-for-main.md)
- [ADR 0002: CI results live in GitHub, not in Git](../adr/0002-ci-results-live-in-github-not-git.md)

Smaller decisions, easy to reverse:

| Decision Area            | Chosen Approach                                                                                                                        | Rejected Alternatives                           | Why We Made This Decision                                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub Reporting API** | **Commit Statuses API** (`/statuses/{sha}`) via the Author's `gh` token                                                                | Check Runs API (`/check-runs`) via a GitHub App | **No Shared Secret:** Check Runs can only be written by a GitHub App, which means creating an app and distributing its private key to every Author. Commit Statuses accept the token Authors already have. We give up inline logs, which are out of scope for now. |
| **Check execution**      | Parallel by default, capped by `--jobs N` (`pMap`)                                                                                     | Sequential; fixed worker pool                   | Wall-clock time dominates when every Check must run; Authors with conflicting Checks pass `--jobs 1`.                                                                                                                                                              |
| **Check timeout**        | Kill a Check after 60 seconds; top-level and per-Check override in `local-ci.yml`                                                      | No timeout; CLI flag only                       | A hung Check would block the parallel Run forever.                                                                                                                                                                                                                 |
| **Distribution**         | Install from GitHub release tags (`pnpm add -D github:tianhuil/local-ci#vX.Y.Z`, or `#release`); an Action builds the `release` branch | npm registry                                    | npm publishing adds 2FA ceremony the team doesn't want; everyone already has GitHub access.                                                                                                                                                                        |
| **Release pipeline**     | Action on version bump → release branch + tag + GitHub Release (`scripts/release.mts`)                                                 | Tracked dist on main                            | main stays source-only; builds are reproducible from tags                                                                                                                                                                                                          |

---

## Operational Trade-Offs & Rollout Requirements

- **No Logs in GitHub:** A Commit Status carries only a state and a 140-character description. Reviewers see which check failed but not why; the Author re-runs locally to see the output.
- **Author Token Scope:** Each Author's `gh` token must be allowed to write commit statuses (the classic `repo` scope, or fine-grained `Commit statuses: write`). The default `gh auth login` scopes already include this.
- **No Branch Protection:** GitHub could require `local-ci/*` statuses in branch protection rules, but that list would live in GitHub settings and have to be kept in sync with `local-ci.yml` by hand. We don't use it. Commit Statuses are informational, so a PR can be merged with failing or missing checks; Main CI still verifies main.
- **Trust Model:** Because execution occurs on developer machines rather than isolated cloud runners, this relies on team trust rather than cryptographic server enforcement. Any Author with write access can post any status.
- **Main stays on GitHub CI:** We want main branch to be verified by a neutral authoritative CI. PRs are lower stake and agentically-run local CI is fine.
- **Already-Tested Commits:** Without local ref caching, amending a commit message or rebasing produces a new SHA and requires re-running the local checks. For the same SHA, the runner queries the GitHub API first and skips checks that already have a `success` Commit Status; `--force` runs every check anyway.
- **Clean Tree Is Not a Clean Environment:** `git status --porcelain` ignores gitignored state (`node_modules`, build caches, `.env`) and local tool versions, so a local run can differ from a fresh checkout. We accept this; it is good enough for PRs, and main still runs on GitHub CI.
- **Check List Drift:** `local-ci.yml` and the GitHub workflows that verify main are separate lists, so a PR can pass locally and still fail on main. This is a minor downside; main's CI catches it.
- **Push Before Posting:** A Commit Status attaches to a commit SHA that GitHub already has, so the runner pushes before running any check. It pushes the current branch to its upstream (setting `origin/<branch>` as upstream if there is none) and never force-pushes. If the push is rejected, nothing runs and nothing is posted. It refuses to run on the default branch, because pushing there would bypass PR review. `--no-push` skips the push and instead refuses to run unless `HEAD` is already on GitHub. No PR is needed: if a PR is opened later with that commit as its head, the existing statuses appear in it.

---

## Future

Out of scope for now:

- **Revert on Main CI failure:** A GitHub Action that reverts any commit that fails Main CI and re-creates it as a new PR.
- **Logs in the PR:** Let reviewers read a failing check's output from the PR. See the trade-off below.

### Logs in the PR: S3 vs GitHub App

Two ways to show logs. Either is an addition to today's design, not a rewrite.

**Recommendation:** Use S3 if every Author already signs in to AWS with their own account (e.g., AWS SSO). Otherwise use the GitHub App: its key can only write checks, so it is the smaller secret to hand out.

|                               | **S3 + Commit Status**                                                                                                                                                        | **GitHub App + Check Runs**                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **How it works**              | Runner uploads the log to S3 and sets the Commit Status `target_url` (the PR's **Details** link) to it.                                                                       | Runner switches from Commit Statuses to Check Runs, which hold the log inline.            |
| **Where reviewers read logs** | In S3, one click from the PR.                                                                                                                                                 | In the PR **Checks** tab.                                                                 |
| **Log size**                  | Unlimited.                                                                                                                                                                    | 65,535 characters per check; the runner keeps the end, where failures appear.             |
| **Secret every Author needs** | AWS credentials with write access to the bucket, on top of the existing `gh` login.                                                                                           | One shared GitHub App private key (`.pem`).                                               |
| **If that secret leaks**      | Depends on the IAM policy; at minimum, someone can write to or read the log bucket.                                                                                           | Someone can post fake Check Runs. The app has no other permission.                        |
| **Reviewer access**           | Reviewers need AWS access to a private bucket, or presigned links that expire within 7 days (sooner with SSO credentials), so old PR links break. A public bucket leaks logs. | Anyone who can see the PR.                                                                |
| **Setup and upkeep**          | Bucket, IAM policy, lifecycle rule to expire old logs.                                                                                                                        | Create the app, install it on the repo, store and rotate the key (e.g., 1Password/Vault). |
| **Retention**                 | We control it.                                                                                                                                                                | GitHub's.                                                                                 |
| **Fits best when**            | The team already uses AWS SSO, so no shared secret is added.                                                                                                                  | The team has no AWS footprint, or wants zero extra infrastructure.                        |
