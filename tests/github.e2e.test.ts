import { execFileSync, spawnSync } from "node:child_process";
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
	return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
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

async function makeRepo(): Promise<{ dir: string; branch: string }> {
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
		`checks:\n  pass: "true"\n  fail: "false"\n  slow:\n    command: sleep 30\n    timeout: ${TIMEOUT}\n`,
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

afterAll(() => {
	for (const { dir, branch } of pushed) {
		spawnSync("git", ["push", "-q", "origin", "--delete", branch], {
			cwd: dir,
			encoding: "utf8",
		});
	}
});

describe.skipIf(process.env.LOCAL_CI_E2E !== "1")("local-ci on GitHub", () => {
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
		let statuses = latestStatuses(sha);
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
		expect(statusCount(sha, "local-ci/pass")).toBe(1);

		result = localCi(dir, ["--force", "--no-push"]);
		if (result.status !== 1)
			throw new Error(`force: ${result.stderr}\n${result.stdout}`);
		expect(result.stdout).toMatch(/^pass +passed +\d+s$/m);
		expect(result.stdout).toContain(
			`posted 3 Commit Statuses to ${short}; 2 of 3 Checks failed`,
		);
		expect(statusCount(sha, "local-ci/pass")).toBe(2);
		statuses = latestStatuses(sha);
		expect(Object.keys(statuses).sort()).toEqual([
			"local-ci/fail",
			"local-ci/pass",
			"local-ci/slow",
		]);
	});
});
