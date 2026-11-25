import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveGitDir } from "../src/index.ts";

const BIN = join(process.cwd(), "bin/local-ci.js");
const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

type Repo = { dir: string; remote: string; sha: string; fakeBin: string };
function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
	return execFileSync("git", args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
	}).trim();
}
async function fakeGh() {
	const fakeBin = await mkdtemp(join(tmpdir(), "local-ci-gh-"));
	await writeFile(
		join(fakeBin, "gh"),
		`#!/bin/sh
if [ -n "${"${GH_ENV_LOG:-}"}" ]; then printf '%s|%s\n' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" >> "$GH_ENV_LOG"; fi
if [ "$1" = auth ] && [ "$2" = token ]; then
  [ "${"${GH_NO_TOKEN:-0}"}" = 1 ] && exit 1
  echo token
  exit 0
fi
if [ "$1" = api ]; then
  case "$*" in *" -f "*) ;; *) [ -n "${"${GH_API_LOG:-}"}" ] && printf '%s\n' "$2" >> "${"${GH_API_LOG}"}";; esac
  case "$2" in
    */commits/*/status*) echo '{"state":"'"${"${GH_COMBINED_STATE:-failure}"}"'","statuses":'"${"${GH_STATUSES:-[]}"}"'}'; exit 0 ;;
    */commits/*) [ "${"${GH_COMMIT_MISSING:-0}"}" = 1 ] && exit 1; echo '{}'; exit 0 ;;
    */statuses/*)
      case "$*" in *" -f "*) [ -n "${"${GH_POST_LOG:-}"}" ] && printf '%s\n' "$*" >> "${"${GH_POST_LOG}"}"; [ -n "${"${GH_POST_DELAY:-}"}" ] && sleep "${"${GH_POST_DELAY}"}"; case "$*" in *"state=pending"*) [ -n "${"${GH_PENDING_DELAY:-}"}" ] && sleep "${"${GH_PENDING_DELAY}"}";; esac; case "$*" in *"state=error"*) [ -n "${"${GH_ERROR_DELAY:-}"}" ] && { sleep "${"${GH_ERROR_DELAY}"}" & echo $! >> "${"${GH_DELAY_PIDS:-/dev/null}"}"; wait; };; esac; [ "${"${GH_POST_FAIL:-0}"}" = 1 ] && exit 1; case "$*" in *"state=pending"*) [ "${"${GH_PENDING_FAIL:-0}"}" = 1 ] && exit 1;; esac; case "$*" in *"${"${GH_FAIL_CONTEXT:-__never__}"}"*) exit 1;; esac; [ -n "${"${GH_APPLY_LOG:-}"}" ] && printf '%s\n' "$*" >> "${"${GH_APPLY_LOG}"}"; echo '{}'; exit 0;; esac
      exit 1 ;;
  esac
fi
exit 1
`,
	);
	await chmod(join(fakeBin, "gh"), 0o755);
	return fakeBin;
}
async function makeRepo(
	config = "checks:\n  - name: unit\n    command: echo ok\n",
	branch = "feature/login",
): Promise<Repo> {
	const dir = await mkdtemp(join(tmpdir(), "local-ci-run-"));
	const remote = join(
		await mkdtemp(join(tmpdir(), "local-ci-remote-")),
		"remote.git",
	);
	execFileSync("git", ["init", "-q", "--bare", remote]);
	execFileSync("git", ["init", "-q", "-b", branch, dir]);
	git(["config", "user.email", "test@example.com"], dir);
	git(["config", "user.name", "Test"], dir);
	await writeFile(join(dir, "local-ci.yml"), config);
	await writeFile(join(dir, "tracked.txt"), "tracked\n");
	git(["add", "."], dir);
	git(["commit", "-qm", "initial"], dir);
	git(["remote", "add", "origin", remote], dir);
	const fakeBin = await fakeGh();
	return { dir, remote, sha: git(["rev-parse", "HEAD"], dir), fakeBin };
}
function runCli(repo: Repo, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
	const path = `${repo.fakeBin}:${process.env.PATH}`;
	return spawnSync(process.execPath, [BIN, ...args], {
		cwd: repo.dir,
		env: { ...process.env, PATH: path, ...env },
		encoding: "utf8",
		timeout: 15000,
	});
}
async function installGitShim(
	repo: Repo,
	mode:
		| "record-push"
		| "record-env"
		| "trace-push"
		| "slow-push"
		| "block-git"
		| "count-slug",
) {
	const shim = join(repo.fakeBin, "git");
	const body =
		mode === "record-push"
			? `#!/bin/sh
[ "$1" = push ] && { echo push >> "$NO_PUSH_LOG"; exit 99; }
exec ${REAL_GIT} "$@"
`
			: mode === "trace-push"
				? `#!/bin/sh
[ "$1" = push ] && echo PUSH >> "$TRACE"
exec ${REAL_GIT} "$@"
`
				: mode === "slow-push"
					? `#!/bin/sh
if [ "$1" = push ]; then
  echo $$ >> "$SLOW_PUSH_PID"
  exec sleep 30
fi
exec ${REAL_GIT} "$@"
`
					: mode === "block-git"
						? `#!/bin/sh
case "$*" in *"${"${BLOCK_GIT_ARGS:-__never__}"}"*)
  echo $$ >> "$BLOCKED_GIT_PID"
  if [ -n "${"${BLOCK_GIT_HOLD:-}"}" ]; then
    setsid sleep 30 &
    echo $! >> "${"${HELD_PID:-/dev/null}"}"
  fi
  exec sleep 30;;
esac
exec ${REAL_GIT} "$@"
`
						: mode === "count-slug"
							? `#!/bin/sh
if [ "$1" = config ] && [ "$3" = remote.origin.url ]; then
  echo slug >> "$SLUG_LOG"
  [ "${"${SLUG_FAIL:-0}"}" = 1 ] && exit 1
fi
exec ${REAL_GIT} "$@"
`
							: `#!/bin/sh
printf '%s|%s\n' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" >> "$GIT_ENV_LOG"
exec ${REAL_GIT} "$@"
`;
	await writeFile(shim, body);
	await chmod(shim, 0o755);
	return shim;
}
// Reads the last pid a shim appended to a pid file, for exact cleanup.
const lastPidIn = async (path: string): Promise<number | undefined> => {
	const pid = Number(
		(await readIfPresent(path)).split("\n").filter(Boolean).at(-1),
	);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};
const deadPid = (pid: number) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};
function allOutput(result: ReturnType<typeof runCli>) {
	return `${result.stdout}${result.stderr}`;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(check: () => Promise<boolean>, ms = 10000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(100);
	}
	throw new Error("condition not met before timeout");
}
const readIfPresent = (path: string) => readFile(path, "utf8").catch(() => "");
// Spawns the Runner asynchronously so a test can signal it mid-Run.
function spawnCli(
	repo: Repo,
	args: string[] = [],
	env: NodeJS.ProcessEnv = {},
) {
	const child = spawn(process.execPath, [BIN, ...args], {
		cwd: repo.dir,
		env: {
			...process.env,
			PATH: `${repo.fakeBin}:${process.env.PATH}`,
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (data) => {
		output += data;
	});
	child.stderr?.on("data", (data) => {
		output += data;
	});
	const exited = new Promise<number | null>((resolve) => {
		child.on("close", (code) => resolve(code));
	});
	return { child, exited, output: () => output };
}

describe("local-ci CLI contract", () => {
	test("MC-21: --help matches usage.md byte for byte and prints the version", async () => {
		const docs = await readFile("docs/context/usage.md", "utf8");
		const expected = docs.match(/\$ local-ci --help\n([\s\S]*?)```/)?.[1];
		expect(expected).toBeDefined();
		const result = spawnSync(process.execPath, [BIN, "--help"], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(expected);
		const version = spawnSync(process.execPath, [BIN, "--version"], {
			encoding: "utf8",
		});
		expect(version.status).toBe(0);
		expect(version.stdout).toBe("0.2.2\n");
		const shortVersion = spawnSync(process.execPath, [BIN, "-V"], {
			encoding: "utf8",
		});
		expect(shortVersion.stdout).toBe("0.2.2\n");
		const shortHelp = spawnSync(process.execPath, [BIN, "-h"], {
			encoding: "utf8",
		});
		expect(shortHelp.stdout).toBe(expected);
	});

	test("returns exit 2 and exact errors for argument failures", () => {
		for (const [args, message] of [
			[
				["--forse"],
				"error: unknown option --forse; valid options: --force, --only, --no-push, --jobs, --help, --version",
			],
			[
				["unit"],
				'error: unexpected argument "unit"; local-ci takes no arguments',
			],
			[
				["--jobs", "0"],
				'error: invalid value "0" for --jobs; use a positive integer, such as --jobs 4',
			],
		] as const) {
			const result = spawnSync(process.execPath, [BIN, ...args], {
				encoding: "utf8",
			});
			expect(result.status).toBe(2);
			expect(result.stderr.trim()).toBe(message);
		}
	});

	test("reports dirty tree and default branch without starting", async () => {
		const dirty = await makeRepo();
		await mkdir(join(dirty.dir, "src"));
		await writeFile(join(dirty.dir, "src/login.ts"), "clean");
		git(["add", "src/login.ts"], dirty.dir);
		git(["commit", "-qm", "add login"], dirty.dir);
		await writeFile(join(dirty.dir, "src/login.ts"), "dirty");
		await writeFile(join(dirty.dir, "notes.txt"), "dirty");
		let result = runCli(dirty);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			"error: 2 uncommitted changes (src/login.ts, notes.txt); run git commit or git stash, then local-ci",
		);
		const main = await makeRepo(
			"checks:\n  - name: unit\n    command: echo ok\n",
			"main",
		);
		result = runCli(main);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			"error: on default branch main; run git switch -c <branch>, then local-ci",
		);
	});

	test("rejects unsafe check names before creating logs", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: "../../victim"\n    command: echo bad\n',
		);
		const result = runCli(repo);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			'error: local-ci.yml is invalid\nchecks[0].name: "../../victim" is not a valid Check name; use letters, numbers, ., _, or -, and never ".."',
		);
		expect(existsSync(join(repo.dir, "..", "victim"))).toBe(false);
	});

	test("reports missing token and invalid configuration exactly", async () => {
		const noToken = await makeRepo();
		let result = runCli(noToken, [], { GH_NO_TOKEN: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			"error: no GitHub token; run gh auth login, then local-ci",
		);
		const invalid = await makeRepo("checks:\n  - name: unit\n    timeout: 2\n");
		result = runCli(invalid);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			"error: local-ci.yml is invalid\nchecks[0].command: has no command; add one, e.g. command: pnpm test",
		);
	});

	test("reports push rejection and credential failures", async () => {
		const rejected = await makeRepo();
		git(["push", "-q", "-u", "origin", "feature/login"], rejected.dir);
		const other = join(
			await mkdtemp(join(tmpdir(), "local-ci-other-")),
			"other",
		);
		execFileSync("git", [
			"clone",
			"-q",
			"-b",
			"feature/login",
			rejected.remote,
			other,
		]);
		git(["config", "user.email", "other@example.com"], other);
		git(["config", "user.name", "Other"], other);
		await writeFile(join(other, "other.txt"), "other");
		git(["add", "."], other);
		git(["commit", "-qm", "other"], other);
		git(["push", "-q", "origin", "feature/login"], other);
		await writeFile(join(rejected.dir, "local.txt"), "local");
		git(["add", "."], rejected.dir);
		git(["commit", "-qm", "local"], rejected.dir);
		let result = runCli(rejected);
		if (result.status !== 1)
			throw new Error(`rejection failed: ${result.stderr} ${result.stdout}`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"error: push of feature/login rejected, origin has newer commits; run git pull --rebase, then local-ci",
		);
		const credentials = await makeRepo();
		const shim = join(credentials.fakeBin, "git");
		await writeFile(
			shim,
			`#!/bin/sh
case " $* " in *" push "*) echo "fatal: could not read Username for 'https://github.com'" >&2; exit 128;; esac
exec ${REAL_GIT} "$@"
`,
		);
		await chmod(shim, 0o755);
		result = runCli(credentials, []);
		// The repository's git executable is used through PATH; use a remote that forces the shim path.
		expect(result.status).toBe(1);
		expect(allOutput(result)).toContain(
			"error: push to origin needs credentials; run gh auth setup-git, then local-ci",
		);
	});

	test("--no-push uses the GitHub commit API and reports missing commits", async () => {
		const repo = await makeRepo();
		const result = runCli(repo, ["--no-push"], { GH_COMMIT_MISSING: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			`error: ${repo.sha.slice(0, 7)} is not on GitHub; run local-ci without --no-push`,
		);
	});

	test("runs checks in parallel by default, serializes with jobs 1, and preserves output order", {
		timeout: 15000,
	}, async () => {
		const config =
			'checks:\n  - name: slow\n    command: "sleep 1"\n  - name: fast\n    command: "sleep 1"\n';
		const parallel = await makeRepo(config);
		let started = Date.now();
		let result = runCli(parallel);
		const parallelElapsed = Date.now() - started;
		expect(result.status).toBe(0);
		expect(result.stdout.indexOf("slow")).toBeLessThan(
			result.stdout.indexOf("fast"),
		);
		expect(result.stdout).toContain("slow  ");
		expect(result.stderr).toContain("pushing…");
		expect(result.stderr).toContain("running slow…");
		expect(result.stderr).toContain("pushed feature/login to origin (");
		expect(parallelElapsed).toBeLessThan(1800);
		const upToDate = runCli(parallel, [], {
			GH_STATUSES:
				'[{"state":"success","context":"local-ci/slow"},{"state":"success","context":"local-ci/fast"}]',
		});
		expect(upToDate.status).toBe(0);
		expect(upToDate.stderr).toContain(
			"feature/login already up to date on origin (",
		);
		const serial = await makeRepo(config);
		started = Date.now();
		result = runCli(serial, ["-j", "1"]);
		expect(result.status).toBe(0);
		expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
	});

	test("prints passed, failed, timeout, previews, full log, totals, and writes logs", async () => {
		const config =
			"timeout: 1\nchecks:\n  - name: pass\n    command: echo passed\n  - name: fail\n    command: >-\n      node -e \"process.stdout.write('short failure'); process.exit(3)\"\n  - name: timeout\n    command: sleep 5\n";
		const repo = await makeRepo(config);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-post-")),
			"posts.log",
		);
		const result = runCli(repo, [], { GH_POST_LOG: postLog });
		expect(result.status).toBe(1);
		expect(result.stdout.split("\n")).toContain("pass     passed   1s");
		expect(result.stdout.split("\n")).toContain("fail     failed   1s  exit 3");
		expect(result.stdout.split("\n")).toContain(
			"timeout  failed   1s  timeout",
		);
		expect(result.stdout).toContain("timeout");
		expect(result.stdout).toContain("fail output:\nshort failure");
		expect(result.stdout).not.toContain("fail output (last 1,500");
		expect(result.stdout).toContain(
			`full log: .git/local-ci/logs/${repo.sha.slice(0, 7)}/fail.log`,
		);
		expect(result.stdout).toContain(
			`posted 3 Commit Statuses to ${repo.sha.slice(0, 7)}; 2 of 3 Checks failed`,
		);
		const posts = await readFile(postLog, "utf8");
		expect(posts).toContain("description=passed in 1s");
		expect(posts).toContain("description=failed in 1s (exit 3)");
		expect(posts).toContain("description=failed in 1s (timeout)");
		const long = await makeRepo(
			"checks:\n  - name: unit\n    command: >-\n      node -e \"process.stdout.write('x'.repeat(1596)+'TAIL'); process.exit(1)\"\n",
		);
		const longResult = runCli(long);
		expect(longResult.status).toBe(1);
		expect(longResult.stdout).toContain(
			"unit output (last 1,500 of 1600 chars):",
		);
		expect(longResult.stdout).toContain("TAIL");
		expect(longResult.stdout).not.toContain("output:\nx");
	});

	test("skips existing successful statuses, force reruns, and handles all-skipped totals", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: unit\n    command: "echo ran"\n  - name: other\n    command: "echo other"\n',
		);
		let result = runCli(repo, [], {
			GH_STATUSES: '[{"state":"success","context":"local-ci/unit"}]',
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("unit   skipped  already passed");
		expect(result.stdout).toContain(
			`posted 1 Commit Status to ${repo.sha.slice(0, 7)}; all 2 Checks passed`,
		);
		result = runCli(repo, [], {
			GH_STATUSES:
				'[{"state":"success","context":"local-ci/unit"},{"state":"success","context":"local-ci/other"}]',
		});
		if (result.status !== 0)
			throw new Error(`all skipped failed: ${result.stderr} ${result.stdout}`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			`0 Checks run; all 2 already passed on ${repo.sha.slice(0, 7)}`,
		);
		result = runCli(repo, ["--force"], {
			GH_STATUSES:
				'[{"state":"success","context":"local-ci/unit"},{"state":"success","context":"local-ci/other"}]',
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("posted 2 Commit Statuses");
	});

	test("MC-03: reruns a Check whose latest local-ci/* state is failure after an older success", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: unit\n    command: "echo ran"\n',
		);
		const logs = await mkdtemp(join(tmpdir(), "local-ci-mc03-"));
		const apiLog = join(logs, "api.log");
		const postLog = join(logs, "posts.log");
		const result = runCli(repo, [], {
			GH_STATUSES: '[{"state":"failure","context":"local-ci/unit"}]',
			GH_API_LOG: apiLog,
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("unit  passed");
		expect(result.stdout).not.toContain("skipped");
		expect(result.stdout).not.toContain("already passed");
		const posts = await readFile(postLog, "utf8");
		expect(posts).toContain(
			"-f state=success -f context=local-ci/unit -f description=passed in 1s",
		);
		// The skip decision must read the combined endpoint, which reports only
		// the latest state per context, never the full history endpoint.
		const api = await readFile(apiLog, "utf8");
		expect(api).toContain(`commits/${repo.sha}/status?per_page=100`);
		expect(api).not.toContain("/statuses/");
	});

	test("MC-04: ignores other tools' contexts and the combined top-level state when skipping", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: unit\n    command: "echo ran"\n',
		);
		const apiLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-mc04-")),
			"api.log",
		);
		const result = runCli(repo, [], {
			GH_COMBINED_STATE: "success",
			GH_STATUSES:
				'[{"state":"success","context":"ci/github-actions"},{"state":"success","context":"continuous-integration/travis"},{"state":"pending","context":"local-ci/unit"}]',
			GH_API_LOG: apiLog,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("unit  passed");
		expect(result.stdout).not.toContain("already passed");
		const api = await readFile(apiLog, "utf8");
		expect(api).toContain(`commits/${repo.sha}/status?per_page=100`);
		expect(api).not.toContain("/statuses/");
	});

	test("MC-06: --only runs and posts only the named Checks plus their dependencies", async () => {
		const config =
			'checks:\n  - name: one\n    command: "echo ran-one >> $TRACE"\n  - name: two\n    command: "echo ran-two >> $TRACE"\n  - name: three\n    command: "echo ran-three >> $TRACE"\n';
		const repo = await makeRepo(config);
		const dir = await mkdtemp(join(tmpdir(), "local-ci-mc06-"));
		const trace = join(dir, "trace.log");
		const postLog = join(dir, "posts.log");
		const result = runCli(repo, ["--only", "two"], {
			TRACE: trace,
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(0);
		// Only the named Check gets a line; the rest are absent (invariant 1).
		expect(result.stdout).toContain("two  passed");
		expect(result.stdout).not.toContain("one");
		expect(result.stdout).not.toContain("three");
		// Invariant 3: a not-selected Check posts nothing, so the status from
		// an earlier Run stands — no pending and no result for one or three.
		const posts = await readFile(postLog, "utf8");
		expect(posts).toContain("state=pending -f context=local-ci/two");
		expect(posts).toContain("state=success -f context=local-ci/two");
		expect(posts).not.toContain("local-ci/one");
		expect(posts).not.toContain("local-ci/three");
		const traceText = await readFile(trace, "utf8");
		expect(traceText).toContain("ran-two");
		expect(traceText).not.toContain("ran-one");
		expect(traceText).not.toContain("ran-three");
	});

	test("MC-07: unknown --only name exits 2 with the exact error listing valid names", async () => {
		const config =
			"checks:\n  - name: lint\n    command: echo lint\n  - name: audit\n    command: echo audit\n  - name: verify\n    command: echo verify\n  - name: build\n    command: echo build\n  - name: browser-smoke\n    command: echo smoke\n";
		const repo = await makeRepo(config);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-mc07-")),
			"posts.log",
		);
		const result = runCli(repo, ["--only", "verfy"], {
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(2);
		expect(result.stderr.trim()).toBe(
			'error: unknown Check "verfy" for --only; Checks: lint, audit, verify, build, browser-smoke',
		);
		// Refused to start: nothing pushed, run, or posted.
		expect(allOutput(result)).not.toContain("pushed");
		expect(await readIfPresent(postLog)).toBe("");
	});

	test("MC-08: --only and --force combine; named Checks rerun", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: unit\n    command: "echo ran-unit >> $TRACE"\n  - name: other\n    command: "echo ran-other >> $TRACE"\n',
		);
		const dir = await mkdtemp(join(tmpdir(), "local-ci-mc08-"));
		const trace = join(dir, "trace.log");
		const postLog = join(dir, "posts.log");
		const result = runCli(repo, ["--only", "unit", "--force"], {
			GH_STATUSES:
				'[{"state":"success","context":"local-ci/unit"},{"state":"success","context":"local-ci/other"}]',
			TRACE: trace,
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(0);
		// --force bypasses the already-passed skip for the named Check only.
		expect(result.stdout).toContain("unit  passed");
		expect(result.stdout).not.toContain("skipped");
		const traceText = await readFile(trace, "utf8");
		expect(traceText).toContain("ran-unit");
		expect(traceText).not.toContain("ran-other");
		const posts = await readFile(postLog, "utf8");
		expect(posts).toContain("state=success -f context=local-ci/unit");
		expect(posts).not.toContain("local-ci/other");
	});

	test("MC-09: every named Check already passed prints the zero-Checks line and exits 0", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: unit\n    command: "echo ran-unit"\n  - name: other\n    command: "echo ran-other"\n',
		);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-mc09-")),
			"posts.log",
		);
		const result = runCli(repo, ["--only", "unit,other"], {
			GH_STATUSES:
				'[{"state":"success","context":"local-ci/unit"},{"state":"success","context":"local-ci/other"}]',
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			`0 Checks run; all 2 already passed on ${repo.sha.slice(0, 7)}`,
		);
		expect(await readIfPresent(postLog)).toBe("");
	});

	test("MC-10: a positional argument is still an error", async () => {
		const repo = await makeRepo();
		const result = runCli(repo, ["unit"]);
		expect(result.status).toBe(2);
		expect(result.stderr.trim()).toBe(
			'error: unexpected argument "unit"; local-ci takes no arguments',
		);
	});

	test("MC-39: the totals and posted-statuses lines count the selected closure, not the full config", async () => {
		const repo = await makeRepo(
			"checks:\n  - name: pass\n    command: echo ok\n  - name: fail\n    command: exit 3\n  - name: other\n    command: echo other\n",
		);
		const result = runCli(repo, ["--only", "fail,pass"], {
			GH_STATUSES: '[{"state":"success","context":"local-ci/pass"}]',
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("pass  skipped  already passed");
		expect(result.stdout).toContain("fail  failed   1s  exit 3");
		expect(result.stdout).not.toContain("other");
		// The denominator is the selection (2), never the config (3), and one
		// post reads in the singular.
		expect(result.stdout).toContain(
			`posted 1 Commit Status to ${repo.sha.slice(0, 7)}; 1 of 2 Checks failed`,
		);
		expect(result.stdout).not.toContain("1 of 3");
	});

	test("--only parsing edges: trimmed names, duplicate names, missing value, = form, repeated flags are last-wins", async () => {
		const config =
			'checks:\n  - name: lint\n    command: "echo ran-lint >> $TRACE"\n  - name: unit\n    command: "echo ran-unit >> $TRACE"\n  - name: other\n    command: "echo ran-other >> $TRACE"\n';
		type Edge = {
			label: string;
			args: string[];
			env?: NodeJS.ProcessEnv;
			assert: (context: {
				result: ReturnType<typeof runCli>;
				label: string;
				sha: string;
				posts: string;
				trace: string;
			}) => void;
		};
		const cases: Edge[] = [
			{
				label: "whitespace around names is trimmed",
				args: ["--only", "lint, unit"],
				assert: ({ result, label, posts, trace }) => {
					expect(result.status, label).toBe(0);
					expect(result.stdout, label).toContain("lint  passed");
					expect(result.stdout, label).toContain("unit  passed");
					expect(posts, label).toContain("context=local-ci/lint");
					expect(posts, label).toContain("context=local-ci/unit");
					expect(trace, label).toContain("ran-lint");
					expect(trace, label).toContain("ran-unit");
				},
			},
			{
				label:
					"duplicate names run and post a Check once, with the unique selection as denominator",
				args: ["--only", "unit,unit"],
				assert: ({ result, label, posts, trace }) => {
					expect(result.status, label).toBe(0);
					expect(result.stdout, label).toContain("unit  passed");
					expect(posts.match(/context=local-ci\/unit/g), label).toHaveLength(2); // one pending, one result — never two Runs
					expect(posts.match(/state=pending/g), label).toHaveLength(1);
					expect(posts.match(/state=success/g), label).toHaveLength(1);
					expect(trace.match(/ran-unit/g), label).toHaveLength(1);
					expect(result.stdout, label).toContain("all 1 Checks passed");
					expect(result.stdout, label).not.toContain("other");
				},
			},
			{
				label: "the all-already-passed count uses the unique selection",
				args: ["--only", "unit,unit"],
				env: {
					GH_STATUSES: '[{"state":"success","context":"local-ci/unit"}]',
				},
				assert: ({ result, label, sha, posts, trace }) => {
					expect(result.status, label).toBe(0);
					expect(result.stdout, label).toContain(
						`0 Checks run; all 1 already passed on ${sha.slice(0, 7)}`,
					);
					expect(result.stdout, label).not.toContain("all 2");
					expect(posts, label).toBe("");
					expect(trace, label).toBe("");
				},
			},
			{
				// Pinned deliberately: a repeated --only is last-wins, matching
				// how a repeated --jobs value behaves.
				label: "a repeated --only flag is last-wins",
				args: ["--only", "lint", "--only", "unit"],
				assert: ({ result, label, posts, trace }) => {
					expect(result.status, label).toBe(0);
					expect(result.stdout, label).toContain("unit  passed");
					expect(result.stdout, label).not.toContain("lint");
					expect(result.stdout, label).not.toContain("other");
					expect(posts, label).toContain("context=local-ci/unit");
					expect(posts, label).not.toContain("local-ci/lint");
					expect(posts, label).not.toContain("local-ci/other");
					expect(trace, label).toContain("ran-unit");
					expect(trace, label).not.toContain("ran-lint");
				},
			},
			{
				label: "a missing value is an unknown Check error",
				args: ["--only"],
				assert: ({ result, label, posts }) => {
					expect(result.status, label).toBe(2);
					expect(result.stderr.trim(), label).toBe(
						'error: unknown Check "" for --only; Checks: lint, unit, other',
					);
					expect(posts, label).toBe("");
				},
			},
			{
				label: "the = form is an unknown option, not a value",
				args: ["--only=a=b"],
				assert: ({ result, label, posts }) => {
					expect(result.status, label).toBe(2);
					expect(result.stderr.trim(), label).toBe(
						"error: unknown option --only=a=b; valid options: --force, --only, --no-push, --jobs, --help, --version",
					);
					expect(posts, label).toBe("");
				},
			},
		];
		for (const { label, args, env, assert } of cases) {
			const repo = await makeRepo(config);
			const dir = await mkdtemp(join(tmpdir(), "local-ci-only-edge-"));
			const trace = join(dir, "trace.log");
			const postLog = join(dir, "posts.log");
			const result = runCli(repo, args, {
				TRACE: trace,
				GH_POST_LOG: postLog,
				...env,
			});
			await assert({
				result,
				label,
				sha: repo.sha,
				posts: await readIfPresent(postLog),
				trace: await readIfPresent(trace),
			});
		}
	});

	test("an invalid config surfaces before --only validation, with nothing pushed or posted", async () => {
		const repo = await makeRepo("checks:\n  - name: unit\n    timeout: 2\n");
		await installGitShim(repo, "record-push");
		const dir = await mkdtemp(join(tmpdir(), "local-ci-only-order-"));
		const pushLog = join(dir, "push.log");
		const postLog = join(dir, "posts.log");
		const result = runCli(repo, ["--only", "verfy"], {
			NO_PUSH_LOG: pushLog,
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(1);
		// The config error wins: exit 1, and validateOnly's message never ran.
		expect(result.stderr.trim()).toBe(
			"error: local-ci.yml is invalid\nchecks[0].command: has no command; add one, e.g. command: pnpm test",
		);
		expect(result.stderr).not.toContain("--only");
		expect(await readIfPresent(pushLog)).toBe("");
		expect(await readIfPresent(postLog)).toBe("");
	});

	test("MC-01: posts a pending Commit Status for every Check about to run, after push, before execution", async () => {
		const config =
			'checks:\n  - name: one\n    command: "echo ran-one >> $TRACE"\n  - name: two\n    command: "echo ran-two >> $TRACE"\n  - name: done\n    command: "echo ran-done >> $TRACE"\n';
		const repo = await makeRepo(config);
		await installGitShim(repo, "trace-push");
		const trace = join(
			await mkdtemp(join(tmpdir(), "local-ci-mc01-")),
			"trace.log",
		);
		// One interleaved log: git push, every Commit Status post, and each
		// Check's first output, so ordering is provable.
		const result = runCli(repo, [], {
			TRACE: trace,
			GH_POST_LOG: trace,
			GH_STATUSES: '[{"state":"success","context":"local-ci/done"}]',
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("done  skipped  already passed");
		const traceText = await readFile(trace, "utf8");
		expect(traceText).toContain(
			"-f state=pending -f context=local-ci/one -f description=running…",
		);
		expect(traceText).toContain(
			"-f state=pending -f context=local-ci/two -f description=running…",
		);
		// No pending for the Check that is not about to run.
		expect(traceText).not.toContain("local-ci/done");
		expect(traceText).not.toContain("ran-done");
		// The push precedes the pending posts, and every pending post precedes
		// its Check's execution.
		expect(traceText.indexOf("PUSH")).toBeLessThan(
			traceText.indexOf("state=pending"),
		);
		expect(traceText.indexOf("state=pending")).toBeLessThan(
			traceText.indexOf("ran-one"),
		);
		expect(traceText.indexOf("state=pending")).toBeLessThan(
			traceText.indexOf("ran-two"),
		);
		expect(traceText).toContain(
			"-f state=success -f context=local-ci/one -f description=passed in 1s",
		);
	});

	test("MC-02: SIGTERM kills running Checks, posts error/interrupted for unfinished ones, and exits 130", {
		timeout: 30000,
	}, async () => {
		// -j 2: first and stubborn run, second stays queued and must never
		// start once the Run is interrupted. stubborn ignores SIGTERM, so only
		// the SIGKILL escalation can end it before the exit.
		const config = `checks:
  - name: first
    command: "echo $$ > $READY/first.pid; sleep 9871"
  - name: stubborn
    command: "trap '' TERM; echo $$ > $READY/stubborn.pid; sleep 9871"
  - name: second
    command: "echo $$ > $READY/second.pid; sleep 9871"
`;
		const repo = await makeRepo(config);
		const ready = join(
			await mkdtemp(join(tmpdir(), "local-ci-mc02-")),
			"ready",
		);
		await mkdir(ready);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-mc02-")),
			"posts.log",
		);
		const runner = spawnCli(repo, ["-j", "2"], {
			READY: ready,
			GH_POST_LOG: postLog,
		});
		// Each pid file holds its Check's process-group leader pid: Checks
		// spawn detached, so the sh pid is the pgid.
		const pgidOf = async (name: string): Promise<number | undefined> => {
			const pid = Number(await readIfPresent(join(ready, `${name}.pid`)));
			return Number.isInteger(pid) && pid > 0 ? pid : undefined;
		};
		const deadGroup = (pgid: number) => {
			try {
				process.kill(-pgid, 0);
				return false;
			} catch {
				return true;
			}
		};
		let first: number | undefined;
		let stubborn: number | undefined;
		try {
			await waitUntil(async () => {
				first = await pgidOf("first");
				stubborn = await pgidOf("stubborn");
				return first !== undefined && stubborn !== undefined;
			});
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			// The queued Check never started.
			expect(existsSync(join(ready, "second.pid"))).toBe(false);
			// Every Check that posted pending but has no final result is
			// interrupted, including the never-started one.
			const posts = await readFile(postLog, "utf8");
			expect(posts).toContain(
				"-f state=error -f context=local-ci/first -f description=interrupted",
			);
			expect(posts).toContain(
				"-f state=error -f context=local-ci/stubborn -f description=interrupted",
			);
			expect(posts).toContain(
				"-f state=error -f context=local-ci/second -f description=interrupted",
			);
			expect(posts).not.toContain("state=success");
			expect(posts).not.toContain("state=failure");
			// Both running Checks are gone before the exit, the
			// SIGTERM-ignorer included.
			if (first !== undefined) expect(deadGroup(first)).toBe(true);
			if (stubborn !== undefined) expect(deadGroup(stubborn)).toBe(true);
		} finally {
			// Stop only processes this test started, by exact process-group id,
			// whether or not the assertions above passed. Re-read every pid
			// file at cleanup time: one can appear after the setup above
			// already gave up, and killing only the Runner would leave its
			// detached Check group alive.
			for (const name of ["first", "stubborn", "second"]) {
				const pgid = await pgidOf(name);
				if (pgid === undefined) continue;
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("MC-42: a signal while results are posting lets the in-flight posts finish and exits 130 without error posts", {
		timeout: 30000,
	}, async () => {
		const repo = await makeRepo(
			'checks:\n  - name: a\n    command: "echo a"\n  - name: b\n    command: "echo b"\n',
		);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-mc42-")),
			"posts.log",
		);
		// Every post takes 2s, so the first result post is still in flight
		// when its request appears in the log.
		const runner = spawnCli(repo, [], {
			GH_POST_LOG: postLog,
			GH_POST_DELAY: "2",
		});
		await waitUntil(async () =>
			(await readIfPresent(postLog)).includes("state=success"),
		);
		runner.child.kill("SIGTERM");
		expect(await runner.exited).toBe(130);
		const posts = await readFile(postLog, "utf8");
		expect(posts.match(/state=success/g)).toHaveLength(2);
		expect(posts).toContain("-f context=local-ci/a");
		expect(posts).toContain("-f context=local-ci/b");
		expect(posts).not.toContain("state=error");
	});

	test("a signal while a pending post is in flight lets it settle, then posts the interruption", {
		timeout: 30000,
	}, async () => {
		const repo = await makeRepo(
			'checks:\n  - name: a\n    command: "echo a"\n  - name: b\n    command: "echo b"\n',
		);
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const postLog = join(dir, "posts.log");
		const applyLog = join(dir, "applies.log");
		// Pending posts take 3s and every other post is fast, so without
		// serializing the shutdown the interruption would land before the
		// in-flight pending and be overwritten by it.
		const runner = spawnCli(repo, [], {
			GH_POST_LOG: postLog,
			GH_APPLY_LOG: applyLog,
			GH_PENDING_DELAY: "3",
		});
		try {
			// The first pending post is logged while still in flight.
			await waitUntil(async () =>
				(await readIfPresent(postLog)).includes("state=pending"),
			);
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			// Leave room for an orphaned request (the defect) to land late.
			await sleep(3500);
			const applies = await readIfPresent(applyLog);
			const pendingA = applies.indexOf(
				"-f state=pending -f context=local-ci/a",
			);
			const errorA = applies.indexOf("-f state=error -f context=local-ci/a");
			expect(pendingA).toBeGreaterThanOrEqual(0);
			expect(errorA).toBeGreaterThan(pendingA);
			// b never announced itself, so it gets no status at all.
			expect(applies).not.toContain("local-ci/b");
			const posts = await readFile(postLog, "utf8");
			expect(posts).not.toContain("local-ci/b");
		} finally {
			runner.child.kill("SIGKILL");
		}
	});

	test("an interrupt after one Check completed posts its result, not just interrupted statuses", {
		timeout: 30000,
	}, async () => {
		const config =
			'checks:\n  - name: quick\n    command: "echo quick-done >> $TRACE"\n  - name: slow\n    command: "echo $$ > $READY/slow.pid; sleep 9871"\n';
		const repo = await makeRepo(config);
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const ready = join(dir, "ready");
		await mkdir(ready);
		const trace = join(dir, "trace.log");
		const postLog = join(dir, "posts.log");
		const runner = spawnCli(repo, [], {
			READY: ready,
			TRACE: trace,
			GH_POST_LOG: postLog,
		});
		try {
			// quick finished (its marker landed) while slow still runs.
			await waitUntil(
				async () =>
					(await readIfPresent(trace)).includes("quick-done") &&
					existsSync(join(ready, "slow.pid")),
			);
			// Let the completed Check's result register before signaling.
			await sleep(300);
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			const posts = await readFile(postLog, "utf8");
			expect(posts).toContain(
				"-f state=success -f context=local-ci/quick -f description=passed in 1s",
			);
			expect(posts).toContain(
				"-f state=error -f context=local-ci/slow -f description=interrupted",
			);
			// quick's pending was replaced by its result, in order.
			expect(
				posts.indexOf("state=pending -f context=local-ci/quick"),
			).toBeLessThan(posts.indexOf("state=success -f context=local-ci/quick"));
		} finally {
			const pgid = Number(await readIfPresent(join(ready, "slow.pid")));
			if (Number.isInteger(pgid) && pgid > 0) {
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("a second signal during a blocked shutdown post force-exits 130 without duplicate posts or gh leftovers", {
		timeout: 30000,
	}, async () => {
		const repo = await makeRepo(
			'checks:\n  - name: only\n    command: "echo $$ > $READY/only.pid; sleep 9871"\n',
		);
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const ready = join(dir, "ready");
		await mkdir(ready);
		const postLog = join(dir, "posts.log");
		const applyLog = join(dir, "applies.log");
		const delayPids = join(dir, "delayed-pids");
		const runner = spawnCli(repo, [], {
			READY: ready,
			GH_POST_LOG: postLog,
			GH_APPLY_LOG: applyLog,
			GH_ERROR_DELAY: "10",
			GH_DELAY_PIDS: delayPids,
		});
		try {
			await waitUntil(async () => existsSync(join(ready, "only.pid")));
			// First signal: the shutdown starts but blocks inside the error post.
			runner.child.kill("SIGINT");
			await waitUntil(async () =>
				(await readIfPresent(postLog)).includes("state=error"),
			);
			// The blocked fake gh has a delay child by now (the sleep backing the
			// error post), recorded by pid.
			await waitUntil(async () => (await lastPidIn(delayPids)) !== undefined);
			const signaled = Date.now();
			runner.child.kill("SIGINT");
			expect(await runner.exited).toBe(130);
			expect(Date.now() - signaled).toBeLessThan(2000);
			const posts = await readFile(postLog, "utf8");
			expect(posts.match(/state=error/g)).toHaveLength(1);
			// The in-flight gh died with the Runner: no fake gh process survives
			// the force-exit (its script lives under the run's fakeBin path)…
			await sleep(200);
			const processes = spawnSync("ps", ["-eo", "args"], {
				encoding: "utf8",
			});
			expect(processes.stdout).not.toContain(repo.fakeBin);
			// …and its delay child is gone too, not just the tracked shell.
			const delayPid = await lastPidIn(delayPids);
			if (delayPid !== undefined) expect(deadPid(delayPid)).toBe(true);
			// …and the killed post never applies after the exit.
			await sleep(11000);
			const applies = await readIfPresent(applyLog);
			expect(applies).not.toContain("state=error");
		} finally {
			const pgid = Number(await readIfPresent(join(ready, "only.pid")));
			if (Number.isInteger(pgid) && pgid > 0) {
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("a signal during a blocked push exits 130 immediately with nothing posted", {
		timeout: 30000,
	}, async () => {
		const repo = await makeRepo();
		await installGitShim(repo, "slow-push");
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const pushPidFile = join(dir, "push.pid");
		const postLog = join(dir, "posts.log");
		const applyLog = join(dir, "applies.log");
		const runner = spawnCli(repo, [], {
			GH_POST_LOG: postLog,
			GH_APPLY_LOG: applyLog,
			SLOW_PUSH_PID: pushPidFile,
		});
		try {
			// The push is blocked in the shim's sleep 30.
			await waitUntil(async () => (await lastPidIn(pushPidFile)) !== undefined);
			const signaled = Date.now();
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			expect(Date.now() - signaled).toBeLessThan(2000);
			// No Check ran and no status was requested or applied.
			expect(await readIfPresent(postLog)).toBe("");
			expect(await readIfPresent(applyLog)).toBe("");
			// The blocked push child died with the Runner, not after it.
			const pushPid = await lastPidIn(pushPidFile);
			if (pushPid !== undefined) expect(deadPid(pushPid)).toBe(true);
		} finally {
			const pushPid = await lastPidIn(pushPidFile);
			if (pushPid !== undefined) {
				try {
					process.kill(pushPid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("shutdown posts share one global bound, not one timeout per post", {
		timeout: 60000,
	}, async () => {
		const config =
			'checks:\n  - name: a\n    command: "echo $$ > $READY/a.pid; sleep 9871"\n  - name: b\n    command: "echo $$ > $READY/b.pid; sleep 9871"\n  - name: c\n    command: "echo $$ > $READY/c.pid; sleep 9871"\n';
		const repo = await makeRepo(config);
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const ready = join(dir, "ready");
		await mkdir(ready);
		const postLog = join(dir, "posts.log");
		// Every error post blocks for 30s, far past the shutdown budget: with a
		// per-post bound the Run would spend 3× the budget before exiting.
		const runner = spawnCli(repo, [], {
			READY: ready,
			GH_POST_LOG: postLog,
			GH_ERROR_DELAY: "30",
		});
		const pgidOf = async (name: string): Promise<number | undefined> => {
			const pid = Number(await readIfPresent(join(ready, `${name}.pid`)));
			return Number.isInteger(pid) && pid > 0 ? pid : undefined;
		};
		try {
			await waitUntil(
				async () =>
					(await pgidOf("a")) !== undefined &&
					(await pgidOf("b")) !== undefined &&
					(await pgidOf("c")) !== undefined,
			);
			const signaled = Date.now();
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			// One ~10s budget for the whole shutdown, not 10s per blocked post.
			expect(Date.now() - signaled).toBeLessThan(14000);
			const posts = await readFile(postLog, "utf8");
			expect(posts).toContain(
				"-f state=error -f context=local-ci/a -f description=interrupted",
			);
			// The budget ran out mid-shutdown: the later posts were skipped.
			expect(posts.match(/state=error/g)).toHaveLength(1);
		} finally {
			for (const name of ["a", "b", "c"]) {
				const pgid = await pgidOf(name);
				if (pgid === undefined) continue;
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("a blocked repoSlug git child dies before the signal exit", {
		timeout: 30000,
	}, async () => {
		const repo = await makeRepo();
		await installGitShim(repo, "block-git");
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const pidFile = join(dir, "blocked.pid");
		const runner = spawnCli(repo, [], {
			BLOCK_GIT_ARGS: "remote.origin.url",
			BLOCKED_GIT_PID: pidFile,
		});
		try {
			// The slug lookup inside statuses() blocks after the push.
			await waitUntil(async () => (await lastPidIn(pidFile)) !== undefined);
			runner.child.kill("SIGTERM");
			await sleep(300);
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			const blocked = await lastPidIn(pidFile);
			if (blocked !== undefined) expect(deadPid(blocked)).toBe(true);
		} finally {
			const blocked = await lastPidIn(pidFile);
			if (blocked !== undefined) {
				try {
					process.kill(blocked, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("a blocked preflight git child dies with the early signal handler", {
		timeout: 30000,
	}, async () => {
		const repo = await makeRepo();
		await installGitShim(repo, "block-git");
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const pidFile = join(dir, "blocked.pid");
		const runner = spawnCli(repo, [], {
			BLOCK_GIT_ARGS: "--porcelain",
			BLOCKED_GIT_PID: pidFile,
		});
		try {
			// The very first preflight call (git status --porcelain) blocks.
			await waitUntil(async () => (await lastPidIn(pidFile)) !== undefined);
			const signaled = Date.now();
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			expect(Date.now() - signaled).toBeLessThan(2000);
			const blocked = await lastPidIn(pidFile);
			if (blocked !== undefined) expect(deadPid(blocked)).toBe(true);
		} finally {
			const blocked = await lastPidIn(pidFile);
			if (blocked !== undefined) {
				try {
					process.kill(blocked, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("the early exit waits, bounded, for killed children to close", {
		timeout: 30000,
	}, async () => {
		const repo = await makeRepo();
		await installGitShim(repo, "block-git");
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const pidFile = join(dir, "blocked.pid");
		const heldPidFile = join(dir, "held.pid");
		const runner = spawnCli(repo, [], {
			BLOCK_GIT_ARGS: "--porcelain",
			BLOCKED_GIT_PID: pidFile,
			BLOCK_GIT_HOLD: "1",
			HELD_PID: heldPidFile,
		});
		try {
			await waitUntil(async () => (await lastPidIn(pidFile)) !== undefined);
			// The blocked child also left a grandchild OUTSIDE its process
			// group holding the Runner's pipes: the group SIGKILL ends the
			// tracked shell, but its stdio cannot drain until the grandchild
			// exits, so the wait must run to its bound before the exit.
			await waitUntil(async () => (await lastPidIn(heldPidFile)) !== undefined);
			const signaled = Date.now();
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			const elapsed = Date.now() - signaled;
			expect(elapsed).toBeGreaterThanOrEqual(2500);
			// The bound, not the pipe holder, ends the wait: no hang.
			expect(elapsed).toBeLessThan(8000);
			const blocked = await lastPidIn(pidFile);
			if (blocked !== undefined) expect(deadPid(blocked)).toBe(true);
		} finally {
			for (const file of [pidFile, heldPidFile]) {
				const pid = await lastPidIn(file);
				if (pid === undefined) continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}
			runner.child.kill("SIGKILL");
		}
	});

	test("the stateful signal handler is installed before the early one is removed", async () => {
		const repo = await makeRepo();
		const swapLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-sig-")),
			"swap.log",
		);
		const result = runCli(repo, [], { LOCAL_CI_SWAP_LOG: swapLog });
		expect(result.status).toBe(0);
		const swap = (await readFile(swapLog, "utf8")).trim().split("\n");
		expect(swap.indexOf("stateful-installed")).toBeGreaterThanOrEqual(0);
		expect(swap.indexOf("early-removed")).toBeGreaterThan(
			swap.indexOf("stateful-installed"),
		);
	});

	test("the repository slug is resolved once per Run, not once per post", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: a\n    command: "echo a"\n  - name: b\n    command: "echo b"\n',
		);
		await installGitShim(repo, "count-slug");
		const slugLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-sig-")),
			"slug.log",
		);
		const result = runCli(repo, [], { SLUG_LOG: slugLog });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("posted 2 Commit Statuses");
		// One lookup serves the statuses read and all pending/result posts.
		expect(
			(await readIfPresent(slugLog)).split("\n").filter(Boolean),
		).toHaveLength(1);
	});

	test("a failed slug lookup is attempted exactly once and still fails the Run", async () => {
		const repo = await makeRepo();
		await installGitShim(repo, "count-slug");
		const slugLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-sig-")),
			"slug.log",
		);
		const result = runCli(repo, [], { SLUG_LOG: slugLog, SLUG_FAIL: "1" });
		expect(result.status).toBe(1);
		// Today's failure shape: the posting error names the context and the fix.
		expect(result.stderr).toContain(
			"error: failed to post Commit Status local-ci/unit to GitHub; run gh auth login, then local-ci",
		);
		// The failed lookup is cached like a successful one: one invocation
		// across the statuses read and every post.
		expect(
			(await readIfPresent(slugLog)).split("\n").filter(Boolean),
		).toHaveLength(1);
	});

	test("runs --no-push against a commit already on the remote without pushing", async () => {
		const repo = await makeRepo();
		git(["push", "-q", "-u", "origin", "feature/login"], repo.dir);
		await installGitShim(repo, "record-push");
		const pushLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-no-push-")),
			"push.log",
		);
		const result = runCli(repo, ["--no-push"], { NO_PUSH_LOG: pushLog });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("posted 1 Commit Status to");
		expect(existsSync(pushLog)).toBe(false);
	});

	test("passes noninteractive git and gh environment variables", async () => {
		const repo = await makeRepo();
		await installGitShim(repo, "record-env");
		const gitLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-env-")),
			"git.log",
		);
		const ghLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-env-")),
			"gh.log",
		);
		const result = runCli(repo, [], { GIT_ENV_LOG: gitLog, GH_ENV_LOG: ghLog });
		expect(result.status).toBe(0);
		expect(
			(await readFile(gitLog, "utf8"))
				.split("\n")
				.filter(Boolean)
				.every((line) => line === "0|"),
		).toBe(true);
		expect(
			(await readFile(ghLog, "utf8"))
				.split("\n")
				.filter(Boolean)
				.every((line) => line === "0|"),
		).toBe(true);
	});

	test("reports partial posting failures without corrupting check totals", async () => {
		const repo = await makeRepo(
			"checks:\n  - name: a\n    command: echo a\n  - name: b\n    command: echo b\n",
		);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-post-")),
			"posts.log",
		);
		const result = runCli(repo, [], {
			GH_FAIL_CONTEXT: "local-ci/b",
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(
			`posted 1 Commit Status to ${repo.sha.slice(0, 7)}; all 2 Checks passed`,
		);
		expect(result.stderr).toContain(
			"error: failed to post Commit Status local-ci/b to GitHub; run gh auth login, then local-ci",
		);
		const posts = await readFile(postLog, "utf8");
		expect(posts).toContain("state=success");
		expect(posts).toContain("description=passed in 1s");
	});

	test("reports posting failures and exits one", async () => {
		const repo = await makeRepo();
		const result = runCli(repo, [], { GH_POST_FAIL: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"error: failed to post Commit Status local-ci/unit to GitHub; run gh auth login, then local-ci",
		);
		expect(result.stdout).not.toContain("posted 1 Commit Status");
	});

	test("a failed pending post fails the Run even when every Check passes", async () => {
		const repo = await makeRepo(
			'checks:\n  - name: unit\n    command: "echo ok"\n',
		);
		const result = runCli(repo, [], { GH_PENDING_FAIL: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"error: failed to post Commit Status local-ci/unit to GitHub; run gh auth login, then local-ci",
		);
		expect(result.stdout).toContain("unit  passed");
		expect(result.stdout).toContain("posted 1 Commit Status to");
	});

	test("MC-11 MC-18 MC-19 MC-20 MC-40 MC-41: schedules dependencies, blocks failures, and reruns required dependencies", async () => {
		const config = `checks:
  - name: base
    command: exit 2
  - name: other
    command: echo other
  - name: dependent
    command: echo dependent
    depends_on: [base, other]
  - name: transitive
    command: echo transitive
    depends_on: [dependent]
`;
		const repo = await makeRepo(config);
		const result = runCli(repo, ["--jobs", "1"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("dependent   blocked  depends on base");
		expect(result.stdout).toContain(
			"transitive  blocked  depends on dependent",
		);
		expect(result.stdout).toContain("posted 4 Commit Statuses");
		const rerun = await makeRepo(`checks:
  - name: base
    command: echo base
  - name: unit
    command: echo unit
    depends_on: [base]
`);
		const rerunResult = runCli(rerun, [], {
			GH_STATUSES: '[{"state":"success","context":"local-ci/base"}]',
		});
		expect(rerunResult.status).toBe(0);
		expect(rerunResult.stdout).toContain("base  passed");
	});

	test("a dependent that becomes ready while later pending posts are in flight runs and posts once", async () => {
		// base finishes during later's slow pending post, after the announce
		// pass has already skipped dependent as not ready.
		const repo = await makeRepo(`checks:
  - name: dependent
    command: echo ran >> "$RUN_LOG"
    depends_on: [base]
  - name: base
    command: echo base
  - name: later
    command: echo later
`);
		const runLog = join(repo.dir, "..", `runs-${Date.now()}.log`);
		const postLog = join(repo.dir, "..", `posts-${Date.now()}.log`);
		const result = runCli(repo, [], {
			RUN_LOG: runLog,
			GH_POST_LOG: postLog,
			GH_PENDING_DELAY: "1",
		});
		expect(result.status, allOutput(result)).toBe(0);
		expect((await readFile(runLog, "utf8")).match(/ran/g)).toHaveLength(1);
		const posts = await readFile(postLog, "utf8");
		expect(posts.match(/context=local-ci\/dependent/g)).toHaveLength(2); // one pending, one result
		expect(result.stdout.match(/dependent +passed/g)).toHaveLength(1);
	});

	test("MC-12 MC-13 MC-14 MC-15 MC-16 MC-17 MC-33 MC-34 MC-35 MC-36 MC-37 MC-38: rejects invalid list configurations with paths and fixes", {
		timeout: 30000,
	}, async () => {
		const cases = [
			[
				"checks:\n  unit: echo old\n",
				"checks must be a list; see usage.md for the list form",
			],
			[
				"checks:\n  - name: unit\n    command: echo ok\n    depends-on: [base]\n",
				"unknown field",
			],
			[
				"checks:\n  - name: unit\n    command: echo a\n  - name: unit\n    command: echo b\n",
				"listed twice",
			],
			[
				"checks:\n  - name: unit\n    command: echo ok\n    depends_on: [missing]\n",
				"not a Check",
			],
			[
				"checks:\n  - name: unit\n    command: echo ok\n    depends_on: [unit]\n",
				"Check itself",
			],
			[
				"checks:\n  - name: unit\n    command: echo ok\n    depends_on: [build]\n  - name: build\n    command: echo ok\n    depends_on: [unit]\n",
				"depends_on cycle",
			],
			["checks:\n  - name: bad name\n    command: '   '\n", "valid Check name"],
			["checks:\n  - name: unit\n    command: '   '\n", "has no command"],
			[
				"timeout: 0\nchecks:\n  - name: unit\n    command: echo ok\n",
				"positive finite",
			],
			["checks: []\n", "at least one Check"],
			[
				"bogus: true\nchecks:\n  - name: unit\n    command: echo ok\n",
				"unknown field",
			],
			[
				"checks:\n  - name: unit\n    command: echo ok\n    depends_on: nope\n",
				"depends_on must be a list",
			],
		] as const;
		for (const [config, message] of cases) {
			const repo = await makeRepo(config);
			const result = runCli(repo);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(message);
		}
	});

	test("MC-22 MC-23 MC-24 MC-26 MC-27 MC-29 MC-30: run_if_changed matching", async () => {
		const config = `checks:
  - name: source
    command: "echo source"
    run_if_changed: ["src/**", "!src/generated/**"]
  - name: generated
    command: "touch generated-ran"
    run_if_changed: ["src/generated/**", "!src/generated/**"]
  - name: docs
    command: "echo docs"
    run_if_changed: ["docs/**"]
`;
		const repo = await makeRepo(config);
		git(["push", "-q", "origin", "HEAD:refs/heads/main"], repo.dir);
		await mkdir(join(repo.dir, "src"), { recursive: true });
		await mkdir(join(repo.dir, "src/generated"), { recursive: true });
		await writeFile(join(repo.dir, "src/app.ts"), "changed");
		await writeFile(join(repo.dir, "src/generated/out.ts"), "generated");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "source change"], repo.dir);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-p4-")),
			"posts",
		);
		const result = runCli(repo, ["--force"], { GH_POST_LOG: postLog });
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/source\s+passed/);
		expect(result.stdout).toMatch(/generated\s+skipped {2}no matching changes/);
		expect(result.stdout).toMatch(/docs\s+skipped {2}no matching changes/);
		expect(existsSync(join(repo.dir, "generated-ran"))).toBe(false);
		const posts = await readFile(postLog, "utf8");
		expect(posts).toContain("state=success");
		expect(posts).toContain("context=local-ci/generated");
		expect(posts).toContain("description=no matching changes");
		const empty = await makeRepo(
			`checks:\n  - name: empty\n    command: echo bad\n    run_if_changed: []\n`,
		);
		const invalid = runCli(empty);
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain(
			"run_if_changed must contain at least one glob",
		);
	});

	test("MC-43 MC-44 MC-45: copy runs the Check in a fresh copy of its folder at the tested commit", async () => {
		const out = await mkdtemp(join(tmpdir(), "local-ci-copy-out-"));
		const config = `checks:
  - name: inside
    copy: ./app/
    command: 'ls -A > "$OUT/listing"; pwd > "$OUT/cwd"; printf %s "$LOCAL_CI_ROOT" > "$OUT/root"; cat committed.txt > "$OUT/content"'
  - name: kept
    copy: app
    command: 'pwd > "$OUT/kept-cwd"; echo kept-output; exit 3'
  - name: plain
    command: 'printf %s "$LOCAL_CI_ROOT" > "$OUT/plain-root"; pwd > "$OUT/plain-cwd"'
`;
		const repo = await makeRepo(config);
		await mkdir(join(repo.dir, "app/nested"), { recursive: true });
		await writeFile(
			join(repo.dir, ".gitignore"),
			"app/ignored.txt\napp/node_modules/\n",
		);
		await writeFile(join(repo.dir, "app/committed.txt"), "committed\n");
		await writeFile(join(repo.dir, "app/nested/deep.txt"), "deep\n");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "app"], repo.dir);
		const sha = git(["rev-parse", "HEAD"], repo.dir);
		// Ignored files keep the tree clean but must never reach the copy.
		await writeFile(join(repo.dir, "app/ignored.txt"), "ignored\n");
		await mkdir(join(repo.dir, "app/node_modules"), { recursive: true });
		await writeFile(join(repo.dir, "app/node_modules/dep.js"), "dep\n");
		const result = runCli(repo, [], { OUT: out });
		expect(result.status).toBe(1);
		expect(result.stdout.split("\n")).toContain("inside  passed   1s");
		expect(result.stdout.split("\n")).toContain("kept    failed   1s  exit 3");
		expect(result.stdout.split("\n")).toContain("plain   passed   1s");
		// MC-43: only that folder's committed files, nothing from outside it.
		expect(
			(await readFile(join(out, "listing"), "utf8"))
				.split("\n")
				.filter(Boolean),
		).toEqual(["committed.txt", "nested"]);
		expect(await readFile(join(out, "content"), "utf8")).toBe("committed\n");
		const cwd = (await readFile(join(out, "cwd"), "utf8")).trim();
		expect(cwd.startsWith(join(repo.dir, ""))).toBe(false);
		// MC-44: LOCAL_CI_ROOT is the worktree, for copied and in-place Checks.
		const root = git(["rev-parse", "--show-toplevel"], repo.dir);
		expect(await readFile(join(out, "root"), "utf8")).toBe(root);
		expect(await readFile(join(out, "plain-root"), "utf8")).toBe(root);
		expect((await readFile(join(out, "plain-cwd"), "utf8")).trim()).toBe(root);
		// MC-45: deleted on success, kept and named in the log on failure.
		expect(existsSync(cwd)).toBe(false);
		const keptCwd = (await readFile(join(out, "kept-cwd"), "utf8")).trim();
		expect(existsSync(join(keptCwd, "committed.txt"))).toBe(true);
		const log = await readFile(
			join(repo.dir, ".git/local-ci/logs", sha.slice(0, 7), "kept.log"),
			"utf8",
		);
		expect(log).toBe(`kept-output\nlocal-ci: copy of app kept in ${keptCwd}\n`);
		expect(result.stdout).toContain(`local-ci: copy of app kept in ${keptCwd}`);
	});

	test("MC-46: copy of a folder that is missing at the tested commit fails the Check without running it", async () => {
		const out = await mkdtemp(join(tmpdir(), "local-ci-copy-missing-"));
		const repo = await makeRepo(
			`checks:\n  - name: missing\n    copy: nope\n    command: 'touch "$OUT/ran"'\n  - name: file\n    copy: tracked.txt\n    command: 'touch "$OUT/ran"'\n`,
		);
		const result = runCli(repo, [], { OUT: out });
		expect(result.status).toBe(1);
		expect(result.stdout.split("\n")).toContain("missing  failed   1s  exit 1");
		expect(result.stdout.split("\n")).toContain("file     failed   1s  exit 1");
		expect(result.stdout).toContain(
			`local-ci: copy: nope is not a folder at ${repo.sha.slice(0, 7)}; fix copy in local-ci.yml`,
		);
		expect(result.stdout).toContain(
			`local-ci: copy: tracked.txt is not a folder at ${repo.sha.slice(0, 7)}`,
		);
		expect(existsSync(join(out, "ran"))).toBe(false);
	});

	test("MC-47: rejects a copy path that is absolute, leaves the tree, or is not a string", async () => {
		for (const copy of ["/etc", "../outside", "app/../../x", "''", "3"]) {
			const repo = await makeRepo(
				`checks:\n  - name: unit\n    copy: ${copy}\n    command: echo ok\n`,
			);
			const result = runCli(repo);
			expect(result.status, copy).toBe(1);
			expect(result.stderr, copy).toContain(
				"checks[0].copy: copy must be a folder path relative to the repository root, e.g. copy: packages/app",
			);
		}
	});

	test("MC-27: stale origin/main only causes extra Checks to run", async () => {
		const repo = await makeRepo(
			`checks:\n  - name: base\n    command: echo base\n    run_if_changed: [docs/**]\n  - name: source\n    command: echo source\n    run_if_changed: [src/**]\n`,
		);
		const branchPoint = repo.sha;
		git(["branch", "main", branchPoint], repo.dir);
		git(["switch", "main"], repo.dir);
		await mkdir(join(repo.dir, "docs"));
		await writeFile(join(repo.dir, "docs/base.md"), "base");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "default branch change"], repo.dir);
		git(["push", "-q", "origin", "main"], repo.dir);
		git(["switch", "-C", "feature/login", "main"], repo.dir);
		await mkdir(join(repo.dir, "src"));
		await writeFile(join(repo.dir, "src/app.ts"), "source");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "source change"], repo.dir);
		// Make origin/main stale: the actual branch point contains docs/base.md,
		// but origin/main is reset to the original commit.
		git(["push", "-qf", "origin", `${branchPoint}:refs/heads/main`], repo.dir);
		const result = runCli(repo, ["--force"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/base\s+passed/);
		expect(result.stdout).toMatch(/source\s+passed/);
	});

	test("MC-25: no merge base runs every path-filtered Check", async () => {
		const repo = await makeRepo(
			`checks:\n  - name: filtered\n    command: echo ran\n    run_if_changed: [docs/**]\n`,
		);
		const result = runCli(repo);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("filtered  passed");
	});

	test("MC-28: already-passed filtered Check posts nothing", async () => {
		const repo = await makeRepo(
			`checks:\n  - name: docs\n    command: echo docs\n    run_if_changed: [docs/**]\n`,
		);
		git(["push", "-q", "origin", "HEAD:refs/heads/main"], repo.dir);
		await writeFile(join(repo.dir, "other.txt"), "unrelated");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "unrelated change"], repo.dir);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-p4-passed-")),
			"posts",
		);
		const result = runCli(repo, [], {
			GH_STATUSES: '[{"state":"success","context":"local-ci/docs"}]',
			GH_POST_LOG: postLog,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("0 Checks run; all 1 already passed");
		expect(result.stdout).not.toContain("no matching changes");
		expect(await readIfPresent(postLog)).toBe("");
	});

	test("MC-29: every Check path-skipped posts success without all-already-passed", async () => {
		const repo = await makeRepo(
			`checks:\n  - name: docs\n    command: echo docs\n    run_if_changed: [docs/**]\n  - name: source\n    command: echo source\n    run_if_changed: [src/**]\n`,
		);
		git(["push", "-q", "origin", "HEAD:refs/heads/main"], repo.dir);
		await writeFile(join(repo.dir, "other.txt"), "unrelated");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "unrelated change"], repo.dir);
		const postLog = join(
			await mkdtemp(join(tmpdir(), "local-ci-p4-all-skipped-")),
			"posts",
		);
		const result = runCli(repo, [], { GH_POST_LOG: postLog });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("no matching changes");
		expect(result.stdout).not.toContain("already passed on");
		const posts = await readFile(postLog, "utf8");
		expect(posts.match(/state=success/g)?.length).toBe(2);
	});

	test("MC-31: --only applies run_if_changed to a nonmatching selected Check", async () => {
		const repo = await makeRepo(
			`checks:\n  - name: docs\n    command: echo docs\n    run_if_changed: [docs/**]\n  - name: source\n    command: echo source\n    run_if_changed: [src/**]\n`,
		);
		git(["push", "-q", "origin", "HEAD:refs/heads/main"], repo.dir);
		await mkdir(join(repo.dir, "docs"));
		await writeFile(join(repo.dir, "docs/readme.md"), "docs");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "docs change"], repo.dir);
		const result = runCli(repo, ["--only", "source"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/source\s+skipped {2}no matching changes/);
		expect(result.stdout).not.toMatch(/docs\s+(passed|skipped)/);
	});

	test("MC-32: precedence and dependency rerun", async () => {
		const repo = await makeRepo(
			`checks:\n  - name: build\n    command: echo build\n    run_if_changed: [src/**]\n  - name: unit\n    command: echo unit\n    depends_on: [build]\n    run_if_changed: [tests/**]\n`,
		);
		git(["push", "-q", "origin", "HEAD:refs/heads/main"], repo.dir);
		await mkdir(join(repo.dir, "tests"));
		await writeFile(join(repo.dir, "tests/unit.ts"), "changed");
		git(["add", "."], repo.dir);
		git(["commit", "-qm", "test change"], repo.dir);
		const result = runCli(repo, ["--only", "unit"], {
			GH_STATUSES: '[{"state":"success","context":"local-ci/build"}]',
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("build  passed");
		expect(result.stdout).toContain("unit   passed");
	});

	test("uses the resolved git directory for linked-worktree logs", async () => {
		const root = await makeRepo(
			'checks:\n  - name: unit\n    command: "echo linked"\n',
		);
		const linked = join(root.dir, "linked");
		git(["worktree", "add", "-qb", "linked-branch", linked], root.dir);
		const result = runCli({ ...root, dir: linked });
		expect(result.status).toBe(0);
		const gitDir = await resolveGitDir(linked);
		expect(
			existsSync(
				join(gitDir, "local-ci", "logs", root.sha.slice(0, 7), "unit.log"),
			),
		).toBe(true);
	});
});
