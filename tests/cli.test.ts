import { execFileSync, spawnSync } from "node:child_process";
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
  case "$2" in
    */commits/*) [ "${"${GH_COMMIT_MISSING:-0}"}" = 1 ] && exit 1; echo '{}'; exit 0 ;;
    */statuses/*)
      case "$*" in *" -f "*) [ -n "${"${GH_POST_LOG:-}"}" ] && printf '%s\n' "$*" >> "${"${GH_POST_LOG}"}"; [ "${"${GH_POST_FAIL:-0}"}" = 1 ] && exit 1; case "$*" in *"${"${GH_FAIL_CONTEXT:-__never__}"}"*) exit 1;; esac; echo '{}'; exit 0;; esac
      echo "${"${GH_STATUSES:-[]}"}"; exit 0 ;;
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
async function installGitShim(repo: Repo, mode: "record-push" | "record-env") {
	const shim = join(repo.fakeBin, "git");
	const body =
		mode === "record-push"
			? `#!/bin/sh
[ "$1" = push ] && { echo push >> "$NO_PUSH_LOG"; exit 99; }
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
function allOutput(result: ReturnType<typeof runCli>) {
	return `${result.stdout}${result.stderr}`;
}

describe("local-ci CLI contract", () => {
	test("matches the help block byte-for-byte and prints version", async () => {
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
		expect(version.stdout).toBe("0.1.0\n");
		const shortVersion = spawnSync(process.execPath, [BIN, "-V"], {
			encoding: "utf8",
		});
		expect(shortVersion.stdout).toBe("0.1.0\n");
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
