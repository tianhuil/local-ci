import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import pMap from "p-map";
import { type Result, runCheck } from "./checks.js";
import { type Options, parseArgs } from "./cli.js";
import { loadChecks } from "./config.js";
import { push, repoSlug, resolveGitDir } from "./git.js";
import { postResults, statuses } from "./github.js";
import { command, errorMessage, git } from "./proc.js";
import { printCheckResults, printFailurePreviews } from "./report.js";

async function preflight(options: Options) {
	const dirty = await git(["status", "--porcelain"]);
	if (dirty) {
		const files = dirty
			.split("\n")
			.map((line) => line.slice(3))
			.join(", ");
		throw new Error(
			`error: ${dirty.split("\n").length} uncommitted changes (${files}); run git commit or git stash, then local-ci`,
		);
	}
	const branch = await git(["branch", "--show-current"]);
	let defaultBranch = "main";
	try {
		defaultBranch = (
			await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
		).replace("origin/", "");
	} catch {
		/* no remote HEAD */
	}
	if (branch === defaultBranch)
		throw new Error(
			`error: on default branch ${defaultBranch}; run git switch -c <branch>, then local-ci`,
		);
	try {
		await command(["gh", "auth", "token"]);
	} catch {
		throw new Error("error: no GitHub token; run gh auth login, then local-ci");
	}
	const config = await loadChecks();
	const sha = await git(["rev-parse", "HEAD"]);
	if (options.noPush) {
		try {
			await command(["gh", "api", `repos/${await repoSlug()}/commits/${sha}`]);
		} catch {
			throw new Error(
				`error: ${sha.slice(0, 7)} is not on GitHub; run local-ci without --no-push`,
			);
		}
	}
	return { ...config, branch, sha };
}

export async function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const info = await preflight(options);
		await push(info.branch, options.noPush, info.sha);
		const passed = await statuses(info.sha);
		const skipped: Result[] = info.checks
			.filter((check) => passed.has(`local-ci/${check.name}`) && !options.force)
			.map((check) => ({ check, status: "skipped", duration: 0 }));
		const pending = info.checks.filter(
			(check) => !passed.has(`local-ci/${check.name}`) || options.force,
		);
		const gitDir = await resolveGitDir();
		const logDir = join(gitDir, "local-ci", "logs", info.sha.slice(0, 7));
		await mkdir(logDir, { recursive: true });
		const ran = await pMap(pending, (check) => runCheck(check, process.cwd()), {
			concurrency: options.jobs ?? Number.POSITIVE_INFINITY,
		});
		for (const result of ran)
			await writeFile(
				join(logDir, `${result.check.name}.log`),
				result.log ?? "",
			);
		const all = [...skipped, ...ran].sort(
			(a, b) => info.checks.indexOf(a.check) - info.checks.indexOf(b.check),
		);
		if (!ran.length) {
			console.log(
				`0 Checks run; all ${info.checks.length} already passed on ${info.sha.slice(0, 7)}`,
			);
			return;
		}
		const width = Math.max(...info.checks.map((check) => check.name.length));
		printCheckResults(all, width);
		printFailurePreviews(ran, info.sha);
		const posting = await postResults(ran, info.sha, info.checks.length);
		if (
			ran.some((result) => result.status === "failed") ||
			posting.failures > 0
		) {
			process.exitCode = 1;
		}
	} catch (error) {
		if (errorMessage(error) !== "ARGUMENT_ERROR") {
			console.error(errorMessage(error));
			process.exitCode = 1;
		}
	}
}

export { runCheck } from "./checks.js";
export { resolveGitDir } from "./git.js";
