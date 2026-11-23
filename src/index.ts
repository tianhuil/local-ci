import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import pMap from "p-map";
import { type Result, runCheck, terminateRunningChecks } from "./checks.js";
import { type Options, parseArgs } from "./cli.js";
import { type Check, loadChecks } from "./config.js";
import { push, repoSlug, resolveGitDir } from "./git.js";
import {
	postInterrupted,
	postPending,
	postResults,
	statuses,
} from "./github.js";
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

// Signal contract: the first SIGINT/SIGTERM stops the scheduler — no
// un-started Check begins — kills the running Checks (SIGTERM, then SIGKILL,
// awaited), posts error/interrupted for every Check that posted pending but
// has no final result, and exits 130. A signal while results post lets the
// in-flight posts finish (they are final) and exits 130 without extra error
// posts. Handlers stay installed until exit.
type RunState = {
	phase: "running" | "posting" | "done";
	interrupted: boolean;
	toRun: Check[];
	finished: Set<string>;
	sha: string;
};

function installSignalHandlers(state: RunState) {
	const onSignal = () => {
		if (state.interrupted) return;
		state.interrupted = true;
		if (state.phase === "running") {
			const unfinished = state.toRun.filter(
				(check) => !state.finished.has(check.name),
			);
			void (async () => {
				try {
					await terminateRunningChecks();
					await postInterrupted(unfinished, state.sha);
				} finally {
					process.exit(130);
				}
			})();
			return;
		}
		if (state.phase === "posting") return; // main() exits 130 after posting
		process.exit(130);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
}

export async function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const info = await preflight(options);
		await push(info.branch, options.noPush, info.sha);
		const state: RunState = {
			phase: "running",
			interrupted: false,
			toRun: [],
			finished: new Set(),
			sha: info.sha,
		};
		installSignalHandlers(state);
		const passed = await statuses(info.sha);
		const skipped: Result[] = info.checks
			.filter((check) => passed.has(`local-ci/${check.name}`) && !options.force)
			.map((check) => ({ check, status: "skipped", duration: 0 }));
		const pending = info.checks.filter(
			(check) => !passed.has(`local-ci/${check.name}`) || options.force,
		);
		state.toRun = pending;
		const gitDir = await resolveGitDir();
		const logDir = join(gitDir, "local-ci", "logs", info.sha.slice(0, 7));
		await mkdir(logDir, { recursive: true });
		const pendingPosts = await postPending(pending, info.sha);
		const ran = await pMap(
			pending,
			async (check) => {
				// An interrupt stops the scheduler: an un-started Check never spawns.
				if (state.interrupted)
					return { check, status: "failed", duration: 0 } as Result;
				const result = await runCheck(check, process.cwd());
				state.finished.add(check.name);
				return result;
			},
			{ concurrency: options.jobs ?? Number.POSITIVE_INFINITY },
		);
		if (state.interrupted) return; // the signal handler posts and exits 130
		state.phase = "posting";
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
			state.phase = "done";
			if (state.interrupted) process.exit(130);
			return;
		}
		const width = Math.max(...info.checks.map((check) => check.name.length));
		printCheckResults(all, width);
		printFailurePreviews(ran, info.sha);
		const posting = await postResults(ran, info.sha, info.checks.length);
		state.phase = "done";
		if (state.interrupted) process.exit(130);
		if (
			ran.some((result) => result.status === "failed") ||
			posting.failures > 0 ||
			pendingPosts.failures > 0
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
