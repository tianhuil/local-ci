# CI results live in GitHub, not in Git

Each Run posts its results to GitHub against the commit SHA. We do not store results or logs in the repository, and we do not cache results by tree hash. Storing logs as Git objects inflates every clone and fetch for the whole team. Shared `git notes` refs cause non-fast-forward push conflicts when Authors work concurrently. Custom refs need their own pruning.

## Considered Options

- `git notes` on each commit: rejected because of push conflicts and repository growth.
- Custom `refs/test/*` blobs (the `git-test` approach): rejected because of repository growth and the pruning work.
- Tree-hash caching (`HEAD^{tree}` refs), so a rebase that keeps the same tree reuses old results: rejected because it needs the custom refs above.

## Consequences

- Amending or rebasing creates a new SHA and needs a new Run. On the same SHA, the Runner can skip Checks that already passed by asking GitHub.
