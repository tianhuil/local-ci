# Local CI for pull requests; Main CI stays in the cloud

PR Checks run on the Author's machine (Local CI), while the main branch keeps running on cloud GitHub Actions (Main CI). Agent-driven PRs are where CI cost and waiting pile up, and the Author has usually just run the same checks anyway. Main still needs a neutral authority, because Local CI trusts the Author's machine and a Clean Tree is not a clean environment.

## Consequences

- `local-ci.yml` and main's workflows are separate lists that can drift, so a PR can pass locally and still fail on main. Main CI catches it after merge.
- Main CI's cost does not change; only PR runs get cheaper.
