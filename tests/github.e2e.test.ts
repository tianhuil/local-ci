import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// End-to-end: real git push and real Commit Statuses on this GitHub repo.
// Opt in with LOCAL_CI_E2E=1 (`pnpm test:e2e`). Needs a gh login (or
// GH_TOKEN) that can push branches and write statuses to the repo.
import { afterAll, describe, expect, test } from "vitest";

const BIN = join(process.cwd(), "bin/local-ci.js");
// Seconds before the `slow` Check is killed. Short, because the test only
// needs the timeout path to fire.
const TIMEOUT = Number(process.env.LOCAL_CI_E2E_TIMEOUT ?? "0.5");
const PREFIX = "local-ci-e2e/";

function run(cmd: string, args: string[], cwd: string) {
	return execFileSync(cmd, args, {
		cwd,
		encoding: "utf8",
		// A blocked subprocess must fail, not stall polling and vitest deadlines.
		timeout: 30000,
	}).trim();
}
function repoSlug(): string {
	if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
	const url = run("git", ["config", "--get", "remote.origin.url"], ".");
	return url.replace(/^.*github\.com[/:]/, "").replace(/\.git$/, "");
}
// Unique per test, so parallel runs never share a branch or a commit.
// The leading epoch lets the CI sweep delete leftovers by age.
function branchName(): string {
	const run = process.env.GITHUB_RUN_ID
		? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
		: "local";
	const epoch = Math.floor(Date.now() / 1000);
	return `${PREFIX}${epoch}-${run}-${randomBytes(4).toString("hex")}`;
}

const slug = repoSlug();
const pushed: { dir: string; branch: string }[] = [];

async function makeRepo(
	slowTimeout = TIMEOUT,
): Promise<{ dir: string; branch: string }> {
	const dir = await mkdtemp(join(tmpdir(), "local-ci-e2e-"));
	const branch = branchName();
	run("git", ["init", "-q", "-b", branch], dir);
	run("git", ["config", "user.name", "local-ci e2e"], dir);
	run(
		"git",
		["config", "user.email", "local-ci-e2e@users.noreply.github.com"],
		dir,
	);
	// Push with gh's token only, whatever helpers the machine has configured.
	run("git", ["config", "--add", "credential.helper", ""], dir);
	run(
		"git",
		["config", "--add", "credential.helper", "!gh auth git-credential"],
		dir,
	);
	run(
		"git",
		["remote", "add", "origin", `https://github.com/${slug}.git`],
		dir,
	);
	await writeFile(
		join(dir, "local-ci.yml"),
		`checks:\n  pass: "true"\n  fail: "false"\n  slow:\n    command: sleep 30\n    timeout: ${slowTimeout}\n`,
	);
	await writeFile(join(dir, "id.txt"), `${branch}\n`);
	run("git", ["add", "."], dir);
	run("git", ["commit", "-qm", `local-ci e2e ${branch}`], dir);
	pushed.push({ dir, branch });
	return { dir, branch };
}
function localCi(dir: string, args: string[] = []) {
	return spawnSync(process.execPath, [BIN, ...args], {
		cwd: dir,
		encoding: "utf8",
		timeout: 60000,
	});
}
// Spawns the Runner asynchronously so a test can poll GitHub while it runs.
function localCiAsync(dir: string) {
	const child = spawn(process.execPath, [BIN], {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (data) => {
		output += data;
	});
	child.stderr?.on("data", (data) => {
		output += data;
	});
	const exited = new Promise<{ status: number | null; output: string }>(
		(resolve) => {
			child.on("close", (status) => resolve({ status, output }));
		},
	);
	const guard = setTimeout(() => child.kill("SIGKILL"), 90000);
	child.on("close", () => clearTimeout(guard));
	return { exited };
}
// Latest status per context, as GitHub shows on the commit.
function latestStatuses(sha: string): Record<string, string> {
	const out = run(
		"gh",
		[
			"api",
			`repos/${slug}/commits/${sha}/status`,
			"--jq",
			'.statuses[] | select(.context | startswith("local-ci/")) | "\\(.context)\\t\\(.state)\\t\\(.description)"',
		],
		".",
	);
	return Object.fromEntries(
		out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [context, state, description] = line.split("\t");
				return [context, `${state}: ${description}`];
			}),
	);
}
// A poll read that is not ready yet — the commit may not be pushed, or the
// read transiently failed — is a retry, not a test failure.
function latestStatusesOrNone(sha: string): Record<string, string> {
	try {
		return latestStatuses(sha);
	} catch {
		return {};
	}
}

// The final poll's readiness: every expected context must already show its
// final state and description — a still-pending context never satisfies it.
function finalStatusesReady(
	statuses: Record<string, string>,
	expected: Record<string, RegExp>,
): boolean {
	return Object.entries(expected).every(([context, pattern]) =>
		pattern.test(statuses[context] ?? ""),
	);
}
function statusCount(sha: string, context: string): number {
	return Number(
		run(
			"gh",
			[
				"api",
				`repos/${slug}/commits/${sha}/statuses`,
				"--jq",
				`[.[] | select(.context == "${context}")] | length`,
			],
			".",
		),
	);
}
// The statuses endpoints are eventually consistent: a POST can succeed and
// still be missing from the reads for roughly a second (measured: second
// post to an existing context lagged in 3 of 40 probes). Poll instead of
// asserting on the first read; on timeout the stale value fails the
// assertion with a meaningful diff.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(
	read: () => T,
	isReady: (value: T) => boolean,
	ms = 15000,
): Promise<T> {
	let value = read();
	const deadline = Date.now() + ms;
	while (!isReady(value) && Date.now() < deadline) {
		await sleep(500);
		value = read();
	}
	return value;
}

afterAll(() => {
	for (const { dir, branch } of pushed) {
		spawnSync("git", ["push", "-q", "origin", "--delete", branch], {
			cwd: dir,
			encoding: "utf8",
			timeout: 30000,
		});
	}
});

// Unit coverage for the final-poll predicate; the e2e itself cannot be
// driven deterministically with a pending response.
describe("final-status readiness", () => {
	const finals = {
		"local-ci/fail": /^failure: failed in \d+s \(exit 1\)$/,
		"local-ci/pass": /^success: passed in \d+s$/,
	} as const;

	test("a still-pending context never satisfies the final poll", () => {
		expect(
			finalStatusesReady(
				{
					"local-ci/pass": "pending: running…",
					"local-ci/fail": "failure: failed in 1s (exit 1)",
				},
				finals,
			),
		).toBe(false);
	});

	test("every final state and description satisfies it", () => {
		expect(
			finalStatusesReady(
				{
					"local-ci/pass": "success: passed in 4s",
					"local-ci/fail": "failure: failed in 7s (exit 1)",
				},
				finals,
			),
		).toBe(true);
	});

	test("a missing context never satisfies it", () => {
		expect(
			finalStatusesReady({ "local-ci/pass": "success: passed in 4s" }, finals),
		).toBe(false);
	});
});

describe.skipIf(process.env.LOCAL_CI_E2E !== "1")("local-ci on GitHub", () => {
	test("MC-05: shows a pending local-ci Commit Status on GitHub while a slow Check still runs", {
		timeout: 180000,
	}, async () => {
		const { dir, branch } = await makeRepo(8);
		const sha = run("git", ["rev-parse", "HEAD"], dir);
		const short = sha.slice(0, 7);
		const runner = localCiAsync(dir);
		// Poll the combined status endpoint while the slow Check (timeout 8s)
		// still runs; some local-ci/* context must read pending at least once.
		// The first polls may race the branch push (404), so retry failed reads.
		let pendingSeen = false;
		const deadline = Date.now() + 30000;
		while (!pendingSeen && Date.now() < deadline) {
			pendingSeen = Object.entries(latestStatusesOrNone(sha)).some(
				([context, value]) =>
					context.startsWith("local-ci/") && value.startsWith("pending"),
			);
			if (!pendingSeen) await sleep(300);
		}
		expect(pendingSeen).toBe(true);
		const result = await runner.exited;
		if (result.status !== 1) throw new Error(`run: ${result.output}`);
		expect(result.output).toContain(`pushed ${branch} to origin (${short})`);
		expect(result.output).toContain(
			`posted 3 Commit Statuses to ${short}; 2 of 3 Checks failed`,
		);
		// The poll is satisfied only by the final state and description of
		// every expected context, never by a still-pending one.
		const finals = {
			"local-ci/fail": /^failure: failed in \d+s \(exit 1\)$/,
			"local-ci/pass": /^success: passed in \d+s$/,
			"local-ci/slow": /^failure: failed in \d+s \(timeout\)$/,
		} as const;
		const statuses = await eventually(
			() => latestStatuses(sha),
			(s) => finalStatusesReady(s, finals),
		);
		for (const [context, pattern] of Object.entries(finals))
			expect(statuses[context]).toMatch(pattern);
	});

	test("pushes the branch, posts real Commit Statuses, skips passed Checks, and --force reposts", {
		timeout: 180000,
	}, async () => {
		const { dir, branch } = await makeRepo();
		const sha = run("git", ["rev-parse", "HEAD"], dir);
		const short = sha.slice(0, 7);

		let result = localCi(dir);
		if (result.status !== 1)
			throw new Error(`first run: ${result.stderr}\n${result.stdout}`);
		expect(result.stderr).toContain(`pushed ${branch} to origin (${short})`);
		expect(result.stdout).toMatch(/^pass +passed +\d+s$/m);
		expect(result.stdout).toMatch(/^fail +failed +\d+s +exit 1$/m);
		expect(result.stdout).toMatch(/^slow +failed +\d+s +timeout$/m);
		expect(result.stdout).toContain(
			`posted 3 Commit Statuses to ${short}; 2 of 3 Checks failed`,
		);
		const head = run(
			"git",
			["ls-remote", "origin", `refs/heads/${branch}`],
			dir,
		);
		expect(head.startsWith(sha)).toBe(true);
		const contexts = [
			"local-ci/fail",
			"local-ci/pass",
			"local-ci/slow",
		] as const;
		let statuses = await eventually(
			() => latestStatuses(sha),
			(s) => contexts.every((context) => context in s),
		);
		expect(statuses["local-ci/pass"]).toMatch(/^success: passed in \d+s$/);
		expect(statuses["local-ci/fail"]).toMatch(
			/^failure: failed in \d+s \(exit 1\)$/,
		);
		expect(statuses["local-ci/slow"]).toMatch(
			/^failure: failed in \d+s \(timeout\)$/,
		);

		result = localCi(dir);
		if (result.status !== 1)
			throw new Error(`rerun: ${result.stderr}\n${result.stdout}`);
		expect(result.stderr).toContain(
			`${branch} already up to date on origin (${short})`,
		);
		expect(result.stdout).toMatch(/^pass +skipped +already passed$/m);
		expect(result.stdout).toContain(
			`posted 2 Commit Statuses to ${short}; 2 of 3 Checks failed`,
		);
		expect(
			await eventually(
				() => statusCount(sha, "local-ci/pass"),
				// Each executed Check posts pending + final: 2 history entries
				// per context after the initial Run.
				(count) => count === 2,
			),
		).toBe(2);

		result = localCi(dir, ["--force", "--no-push"]);
		if (result.status !== 1)
			throw new Error(`force: ${result.stderr}\n${result.stdout}`);
		expect(result.stdout).toMatch(/^pass +passed +\d+s$/m);
		expect(result.stdout).toContain(
			`posted 3 Commit Statuses to ${short}; 2 of 3 Checks failed`,
		);
		expect(
			await eventually(
				() => statusCount(sha, "local-ci/pass"),
				// The --force Run adds another pending + final pair: 4 entries.
				(count) => count === 4,
			),
		).toBe(4);
		statuses = await eventually(
			() => latestStatuses(sha),
			(s) => contexts.every((context) => context in s),
		);
		expect(Object.keys(statuses).sort()).toEqual([
			"local-ci/fail",
			"local-ci/pass",
			"local-ci/slow",
		]);
	});
});
