# Local CI Architecture & Decision Record

## Executive Summary

We will run all CI checks locally on developer machines and publish the results—including pass/fail status and execution logs—directly to GitHub Pull Requests via the **GitHub Check Runs API** (`/repos/{owner}/{repo}/check-runs`).

To avoid repository bloat, ref contention, and maintenance overhead, we will **not** store test results or logs in Git (`git notes` or custom `refs/test/*` hierarchies). GitHub’s backend database will serve as the single source of truth for all CI results and logs, while local execution remains fast, stateless, and free of cloud runner costs.

---

## Why now?

1. Agentic development means we consume a lot more GitHub CI time than previously.  This gets expensive. Moving PR checks to local CI removes that cost for PR runs; main keeps running on GitHub CI, so its cost does not change.
2. Agentic development on a git worktree is already verified by the agent but then has to wait on a cloud CI pipeline as a PR for the same set of tests.  This slows down the agent for no real gain.

## Intended Product Overview

The solution consists of a lightweight CLI wrapper (`local-ci`) paired with a declarative repository configuration file (`local-ci.yml`):

1. **Trigger:** The agent runs `local-ci` after each commit. The commit must be pushed before results are posted (see **Push Before Posting** below).
2. **Declarative Check Definition (`local-ci.yml`):** A committed YAML file at the repository root listing the required checks (e.g., `lint`, `typecheck`, `unit`, or `nektos/act` jobs; `act` needs Docker and does not support every GitHub Actions feature, so an `act` job can behave differently than on GitHub). Each check maps 1-to-1 to a named Check Run in GitHub (`local-ci/<check-name>`).
3. **Clean-State Verification:** Before running any check, the runner verifies that the working tree is clean (`git status --porcelain`) so unverified or uncommitted local edits cannot be certified against a commit SHA.
4. **Local Execution & Log Capture:** The runner executes each command locally, captures exit codes and stdout/stderr (truncated to GitHub's 65,535-character limit if necessary, keeping the end of the log, where failures appear), and records execution duration. A failing check does not stop the run: every check runs and every result is posted.
5. **Native GitHub UI Publishing:** Using a lightweight GitHub App installation token and `gh api`, the runner posts a completed Check Run to the active `HEAD` commit SHA. Reviewers see native check statuses and can click **Details** inside the PR **Checks** tab to read failure logs directly in GitHub.

---

## Key Architectural Decisions & Rationale

| Decision Area | Chosen Approach | Rejected Alternatives | Why We Made This Decision |
| --- | --- | --- | --- |
| **Result & Log Storage** | **GitHub Check Runs API** (stored in GitHub's database) | `git notes`, custom `refs/test/*` blobs, or `git-test` | **Performance & Repo Health:** Storing 10,000-line CI logs as Git blobs prevents delta-compression, permanently inflates `.git/objects/pack`, and slows down `git clone` and `git fetch` for the entire team. Keeping logs in GitHub avoids adding a single byte to the Git repository. |
| **Caching & Rebase Tracking** | **Stateless / On-Demand Execution** (no custom Git ref caching) | Tree-hash caching (`HEAD^{tree}` refs) | **Simplicity & Zero Ref Contention:** Pushing shared `git notes` causes non-fast-forward push conflicts when developers work concurrently, while managing sharded `refs/test/<first-2>/<rest>` adds custom ref-pruning complexity. Running checks directly without custom Git plumbing keeps the toolchain minimal and predictable. |
| **GitHub Reporting API** | **Check Runs API** (`/check-runs`) via GitHub App token | Commit Statuses API (`/statuses/{sha}`) | **Native Log Visibility:** Commit Statuses only allow a 140-character description string and cannot host test output without external Gists or artifact servers. The Check Runs API natively displays Markdown summaries and up to 65,535 characters of stdout/stderr directly in the PR Checks tab. |
| **Compute & Execution** | **Local Machine Execution** (`act` or direct CLI commands) | Cloud GitHub Actions runners | **Speed & Cost:** Eliminates cloud runner queue times and billing minutes while giving developers immediate feedback before or during push. |

---

## Operational Trade-Offs & Rollout Requirements

* **GitHub App Key Distribution:** Because GitHub restricts `/check-runs` writes to GitHub Apps (rejecting standard user PATs), the team must create one internal GitHub App with `Checks: Read & Write` permission and distribute its `.pem` private key securely (e.g., via 1Password/Vault) so local runners can mint short-lived installation tokens.
* **No Branch Protection:** GitHub could require `local-ci/*` checks in branch protection rules, but that list would live in GitHub settings and have to be kept in sync with `local-ci.yml` by hand. We don't use it. Check Runs are informational, so a PR can be merged with failing or missing checks; Main CI still verifies main.
* **Trust Model:** Because execution occurs on developer machines rather than isolated cloud runners, this relies on team trust rather than cryptographic server enforcement.
* **Main stays on GitHub CI:** We want main branch to be verified by a neutral authoritative CI.  PRs are lower stake and agentically-run local CI is fine.
* **Already-Tested Commits:** Without local ref caching, amending a commit message or rebasing produces a new SHA and requires re-running the local checks. For the same SHA, the runner queries the GitHub API first and skips checks that already have a passing Check Run; `--force` runs every check anyway.
* **Clean Tree Is Not a Clean Environment:** `git status --porcelain` ignores gitignored state (`node_modules`, build caches, `.env`) and local tool versions, so a local run can differ from a fresh checkout. We accept this; it is good enough for PRs, and main still runs on GitHub CI.
* **Check List Drift:** `local-ci.yml` and the GitHub workflows that verify main are separate lists, so a PR can pass locally and still fail on main. This is a minor downside; main's CI catches it.
* **Push Before Posting:** A Check Run attaches to a commit SHA that GitHub already has, so the runner must confirm the local `HEAD` is pushed before posting. No PR is needed: if a PR is opened later with that commit as its head, the existing Check Runs appear in it. This forces agents to push each commit, which is fine.

---

## Future

Out of scope for now:

* **Revert on Main CI failure:** A GitHub Action that reverts any commit that fails Main CI and re-creates it as a new PR.
