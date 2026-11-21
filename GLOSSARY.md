# Local CI

Runs pull request checks on the author's machine and reports the results to GitHub, so PRs don't spend cloud CI minutes or wait in a queue.

## Language

**Local CI**:
The practice of running a PR's Checks on the author's machine and posting each result to GitHub as a Check Run.
_Avoid_: local testing, pre-push checks

**Main CI**:
The cloud GitHub Actions pipeline that verifies the main branch. It is the neutral authority. Local CI never replaces it.
_Avoid_: cloud CI, GitHub CI (when main specifically is meant)

**Author**:
Whoever pushed the commit being checked, whether a coding agent or a human. Local CI trusts the Author's machine.
_Avoid_: developer, agent, user (when the person or agent who pushed is meant)

**Runner**:
The `local-ci` command-line tool that executes Checks and posts Check Runs.
_Avoid_: CLI wrapper, local runner, harness

**Run**:
One invocation of the Runner, which executes every Check against one commit.
_Avoid_: execution, build, pipeline

**Check**:
One named, required verification listed in `local-ci.yml`, such as `lint` or `unit`.
_Avoid_: job, test, task

**Check Run**:
GitHub's record of one Check's result on one commit, named `local-ci/<check>`.
_Avoid_: status, check result, commit status

**Clean Tree**:
A working tree with no uncommitted or untracked changes, so the results describe exactly the commit being reported. It says nothing about ignored files or tool versions.
_Avoid_: clean state, clean environment
