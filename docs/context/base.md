# Local CI Architecture & Decision Record

## Executive Summary

We will run all CI checks locally on developer machines and publish each check's pass/fail result directly to GitHub Pull Requests via the **GitHub Commit Statuses API** (`/repos/{owner}/{repo}/statuses/{sha}`), using each Author's existing `gh` login. Logs stay on the Author's machine for now.

To avoid repository bloat, ref contention, and maintenance overhead, we will **not** store test results in Git (`git notes` or custom `refs/test/*` hierarchies). GitHub's backend database will serve as the single source of truth for all CI results, while local execution remains fast, stateless, and free of cloud runner costs.

---

## Why now?

1. Agentic development means we consume a lot more GitHub CI time than previously.  This gets expensive. Moving PR checks to local CI removes that cost for PR runs; main keeps running on GitHub CI, so its cost does not change.
2. Agentic development on a git worktree is already verified by the agent but then has to wait on a cloud CI pipeline as a PR for the same set of tests.  This slows down the agent for no real gain.

## Intended Product Overview

The solution consists of a lightweight CLI wrapper (`local-ci`) paired with a declarative repository configuration file (`local-ci.yml`):

1. **Trigger:** The agent runs `local-ci` after each commit. The commit must be pushed before results are posted (see **Push Before Posting** below).
2. **Declarative Check Definition (`local-ci.yml`):** A committed YAML file at the repository root listing the required checks (e.g., `lint`, `typecheck`, `unit`, or `nektos/act` jobs; `act` needs Docker and does not support every GitHub Actions feature, so an `act` job can behave differently than on GitHub). Each check maps 1-to-1 to a named Commit Status in GitHub (context `local-ci/<check-name>`).
3. **Clean-State Verification:** Before running any check, the runner verifies that the working tree is clean (`git status --porcelain`) so unverified or uncommitted local edits cannot be certified against a commit SHA.
4. **Local Execution:** The runner executes each command locally and records its exit code and duration. Output is shown in the Author's terminal only. A failing check does not stop the run: every check runs and every result is posted.
5. **GitHub Publishing:** Using the Author's `gh` token, the runner posts a `success` or `failure` Commit Status to the active `HEAD` commit SHA. Reviewers see pass/fail per check in the PR. They cannot see logs in GitHub (see **Future**).

---

## Key Architectural Decisions & Rationale

| Decision Area | Chosen Approach | Rejected Alternatives | Why We Made This Decision |
| --- | --- | --- | --- |
| **Result Storage** | **GitHub Commit Statuses** (stored in GitHub's database) | `git notes`, custom `refs/test/*` blobs, or `git-test` | **Performance & Repo Health:** Storing CI results as Git objects permanently inflates `.git/objects/pack` and slows down `git clone` and `git fetch` for the entire team. Keeping results in GitHub avoids adding a single byte to the Git repository. |
| **Caching & Rebase Tracking** | **Stateless / On-Demand Execution** (no custom Git ref caching) | Tree-hash caching (`HEAD^{tree}` refs) | **Simplicity & Zero Ref Contention:** Pushing shared `git notes` causes non-fast-forward push conflicts when developers work concurrently, while managing sharded `refs/test/<first-2>/<rest>` adds custom ref-pruning complexity. Running checks directly without custom Git plumbing keeps the toolchain minimal and predictable. |
| **GitHub Reporting API** | **Commit Statuses API** (`/statuses/{sha}`) via the Author's `gh` token | Check Runs API (`/check-runs`) via a GitHub App | **No Shared Secret:** Check Runs can only be written by a GitHub App, which means creating an app and distributing its private key to every Author. Commit Statuses accept the token Authors already have. We give up inline logs, which are out of scope for now. |
| **Compute & Execution** | **Local Machine Execution** (`act` or direct CLI commands) | Cloud GitHub Actions runners | **Speed & Cost:** Eliminates cloud runner queue times and billing minutes while giving developers immediate feedback before or during push. |

---

## Operational Trade-Offs & Rollout Requirements

* **No Logs in GitHub:** A Commit Status carries only a state and a 140-character description. Reviewers see which check failed but not why; the Author re-runs locally to see the output.
* **Author Token Scope:** Each Author's `gh` token must be allowed to write commit statuses (the classic `repo` scope, or fine-grained `Commit statuses: write`). The default `gh auth login` scopes already include this.
* **No Branch Protection:** GitHub could require `local-ci/*` statuses in branch protection rules, but that list would live in GitHub settings and have to be kept in sync with `local-ci.yml` by hand. We don't use it. Commit Statuses are informational, so a PR can be merged with failing or missing checks; Main CI still verifies main.
* **Trust Model:** Because execution occurs on developer machines rather than isolated cloud runners, this relies on team trust rather than cryptographic server enforcement. Any Author with write access can post any status.
* **Main stays on GitHub CI:** We want main branch to be verified by a neutral authoritative CI.  PRs are lower stake and agentically-run local CI is fine.
* **Already-Tested Commits:** Without local ref caching, amending a commit message or rebasing produces a new SHA and requires re-running the local checks. For the same SHA, the runner queries the GitHub API first and skips checks that already have a `success` Commit Status; `--force` runs every check anyway.
* **Clean Tree Is Not a Clean Environment:** `git status --porcelain` ignores gitignored state (`node_modules`, build caches, `.env`) and local tool versions, so a local run can differ from a fresh checkout. We accept this; it is good enough for PRs, and main still runs on GitHub CI.
* **Check List Drift:** `local-ci.yml` and the GitHub workflows that verify main are separate lists, so a PR can pass locally and still fail on main. This is a minor downside; main's CI catches it.
* **Push Before Posting:** A Commit Status attaches to a commit SHA that GitHub already has, so the runner must confirm the local `HEAD` is pushed before posting. No PR is needed: if a PR is opened later with that commit as its head, the existing statuses appear in it. This forces agents to push each commit, which is fine.

---

## Future

Out of scope for now:

* **Revert on Main CI failure:** A GitHub Action that reverts any commit that fails Main CI and re-creates it as a new PR.
* **Logs in the PR:** Let reviewers read a failing check's output from the PR. See the trade-off below.

### Logs in the PR: S3 vs GitHub App

Two ways to show logs. Either is an addition to today's design, not a rewrite.

**Recommendation:** Use S3 if every Author already signs in to AWS with their own account (e.g., AWS SSO). Otherwise use the GitHub App: its key can only write checks, so it is the smaller secret to hand out.

| | **S3 + Commit Status** | **GitHub App + Check Runs** |
| --- | --- | --- |
| **How it works** | Runner uploads the log to S3 and sets the Commit Status `target_url` (the PR's **Details** link) to it. | Runner switches from Commit Statuses to Check Runs, which hold the log inline. |
| **Where reviewers read logs** | In S3, one click from the PR. | In the PR **Checks** tab. |
| **Log size** | Unlimited. | 65,535 characters per check; the runner keeps the end, where failures appear. |
| **Secret every Author needs** | AWS credentials with write access to the bucket, on top of the existing `gh` login. | One shared GitHub App private key (`.pem`). |
| **If that secret leaks** | Depends on the IAM policy; at minimum, someone can write to or read the log bucket. | Someone can post fake Check Runs. The app has no other permission. |
| **Reviewer access** | Reviewers need AWS access to a private bucket, or presigned links that expire within 7 days (sooner with SSO credentials), so old PR links break. A public bucket leaks logs. | Anyone who can see the PR. |
| **Setup and upkeep** | Bucket, IAM policy, lifecycle rule to expire old logs. | Create the app, install it on the repo, store and rotate the key (e.g., 1Password/Vault). |
| **Retention** | We control it. | GitHub's. |
| **Fits best when** | The team already uses AWS SSO, so no shared secret is added. | The team has no AWS footprint, or wants zero extra infrastructure. |
