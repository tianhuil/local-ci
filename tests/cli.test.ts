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
      case "$*" in *" -f "*) [ -n "${"${GH_POST_LOG:-}"}" ] && printf '%s\n' "$*" >> "${"${GH_POST_LOG}"}"; [ -n "${"${GH_POST_DELAY:-}"}" ] && sleep "${"${GH_POST_DELAY}"}"; case "$*" in *"state=pending"*) [ -n "${"${GH_PENDING_DELAY:-}"}" ] && sleep "${"${GH_PENDING_DELAY}"}";; esac; case "$*" in *"state=error"*) [ -n "${"${GH_ERROR_DELAY:-}"}" ] && sleep "${"${GH_ERROR_DELAY}"}";; esac; [ "${"${GH_POST_FAIL:-0}"}" = 1 ] && exit 1; case "$*" in *"state=pending"*) [ "${"${GH_PENDING_FAIL:-0}"}" = 1 ] && exit 1;; esac; case "$*" in *"${"${GH_FAIL_CONTEXT:-__never__}"}"*) exit 1;; esac; [ -n "${"${GH_APPLY_LOG:-}"}" ] && printf '%s\n' "$*" >> "${"${GH_APPLY_LOG}"}"; echo '{}'; exit 0;; esac
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
	config = "checks:\n  unit: echo ok\n",
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
	mode: "record-push" | "record-env" | "trace-push" | "slow-push",
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
					: `#!/bin/sh
printf '%s|%s\n' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" >> "$GIT_ENV_LOG"
exec ${REAL_GIT} "$@"
`;
	await writeFile(shim, body);
	await chmod(shim, 0o755);
	return shim;
}
// Reads the pid file the slow-push shim leaves, for exact cleanup.
const slowPushPgid = async (path: string): Promise<number | undefined> => {
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
		expect(version.stdout).toBe("0.1.1\n");
		const shortVersion = spawnSync(process.execPath, [BIN, "-V"], {
			encoding: "utf8",
		});
		expect(shortVersion.stdout).toBe("0.1.1\n");
		const shortHelp = spawnSync(process.execPath, [BIN, "-h"], {
			encoding: "utf8",
		});
		expect(shortHelp.stdout).toBe(expected);
	});

	test("returns exit 2 and exact errors for argument failures", () => {
		for (const [args, message] of [
			[
				["--forse"],
				"error: unknown option --forse; valid options: --force, --no-push, --jobs, --help, --version",
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
		const main = await makeRepo("checks:\n  unit: echo ok\n", "main");
		result = runCli(main);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			"error: on default branch main; run git switch -c <branch>, then local-ci",
		);
	});

	test("rejects unsafe check names before creating logs", async () => {
		const repo = await makeRepo('checks:\n  "../../victim": echo bad\n');
		const result = runCli(repo);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			'error: local-ci.yml: check "../../victim" has invalid name; use letters, numbers, ., _, or -',
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
		const invalid = await makeRepo("checks:\n  unit:\n    timeout: 2\n");
		result = runCli(invalid);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			'error: local-ci.yml: check "unit" has no command; add one, e.g. unit: pnpm test',
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

	test("runs checks in parallel by default, serializes with jobs 1, and preserves output order", async () => {
		const config = 'checks:\n  slow: "sleep 1"\n  fast: "sleep 1"\n';
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
			"timeout: 1\nchecks:\n  pass: echo passed\n  fail: >-\n    node -e \"process.stdout.write('short failure'); process.exit(3)\"\n  timeout: sleep 5\n";
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
			"checks:\n  unit: >-\n    node -e \"process.stdout.write('x'.repeat(1596)+'TAIL'); process.exit(1)\"\n",
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
			'checks:\n  unit: "echo ran"\n  other: "echo other"\n',
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
		const repo = await makeRepo('checks:\n  unit: "echo ran"\n');
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
		const repo = await makeRepo('checks:\n  unit: "echo ran"\n');
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

	test("MC-01: posts a pending Commit Status for every Check about to run, after push, before execution", async () => {
		const config =
			'checks:\n  one: "echo ran-one >> $TRACE"\n  two: "echo ran-two >> $TRACE"\n  done: "echo ran-done >> $TRACE"\n';
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
  first: "echo $$ > $READY/first.pid; sleep 9871"
  stubborn: "trap '' TERM; echo $$ > $READY/stubborn.pid; sleep 9871"
  second: "echo $$ > $READY/second.pid; sleep 9871"
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
		const repo = await makeRepo('checks:\n  a: "echo a"\n  b: "echo b"\n');
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
		const repo = await makeRepo('checks:\n  a: "echo a"\n  b: "echo b"\n');
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
			'checks:\n  quick: "echo quick-done >> $TRACE"\n  slow: "echo $$ > $READY/slow.pid; sleep 9871"\n';
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
			'checks:\n  only: "echo $$ > $READY/only.pid; sleep 9871"\n',
		);
		const dir = await mkdtemp(join(tmpdir(), "local-ci-sig-"));
		const ready = join(dir, "ready");
		await mkdir(ready);
		const postLog = join(dir, "posts.log");
		const applyLog = join(dir, "applies.log");
		const runner = spawnCli(repo, [], {
			READY: ready,
			GH_POST_LOG: postLog,
			GH_APPLY_LOG: applyLog,
			GH_ERROR_DELAY: "10",
		});
		try {
			await waitUntil(async () => existsSync(join(ready, "only.pid")));
			// First signal: the shutdown starts but blocks inside the error post.
			runner.child.kill("SIGINT");
			await waitUntil(async () =>
				(await readIfPresent(postLog)).includes("state=error"),
			);
			const signaled = Date.now();
			runner.child.kill("SIGINT");
			expect(await runner.exited).toBe(130);
			expect(Date.now() - signaled).toBeLessThan(2000);
			const posts = await readFile(postLog, "utf8");
			expect(posts.match(/state=error/g)).toHaveLength(1);
			// The in-flight gh died with the Runner: no fake gh process survives
			// the force-exit (its script lives under the run's fakeBin path).
			await sleep(200);
			const processes = spawnSync("ps", ["-eo", "args"], {
				encoding: "utf8",
			});
			expect(processes.stdout).not.toContain(repo.fakeBin);
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
			await waitUntil(
				async () => (await slowPushPgid(pushPidFile)) !== undefined,
			);
			const signaled = Date.now();
			runner.child.kill("SIGTERM");
			expect(await runner.exited).toBe(130);
			expect(Date.now() - signaled).toBeLessThan(2000);
			// No Check ran and no status was requested or applied.
			expect(await readIfPresent(postLog)).toBe("");
			expect(await readIfPresent(applyLog)).toBe("");
			// The blocked push child died with the Runner, not after it.
			const pushPid = await slowPushPgid(pushPidFile);
			if (pushPid !== undefined) expect(deadPid(pushPid)).toBe(true);
		} finally {
			const pushPid = await slowPushPgid(pushPidFile);
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
			'checks:\n  a: "echo $$ > $READY/a.pid; sleep 9871"\n  b: "echo $$ > $READY/b.pid; sleep 9871"\n  c: "echo $$ > $READY/c.pid; sleep 9871"\n';
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
		const repo = await makeRepo("checks:\n  a: echo a\n  b: echo b\n");
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
		const repo = await makeRepo('checks:\n  unit: "echo ok"\n');
		const result = runCli(repo, [], { GH_PENDING_FAIL: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"error: failed to post Commit Status local-ci/unit to GitHub; run gh auth login, then local-ci",
		);
		expect(result.stdout).toContain("unit  passed");
		expect(result.stdout).toContain("posted 1 Commit Status to");
	});

	test("uses the resolved git directory for linked-worktree logs", async () => {
		const root = await makeRepo('checks:\n  unit: "echo linked"\n');
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
