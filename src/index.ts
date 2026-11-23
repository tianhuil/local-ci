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
	postResult,
	postResults,
	statuses,
} from "./github.js";
import { command, errorMessage, git, killInFlightCommands } from "./proc.js";
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

// Handlers are installed before preflight: that early handler just exits
// 130 (nothing has run and nothing has been posted), killing any in-flight
// git/gh child so nothing outlives the Run. The stateful handler below
// replaces it after the push.
function installEarlySignalHandlers(): () => void {
	const onSignal = () => {
		killInFlightCommands();
		process.exit(130);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	return () => {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	};
}

// All shutdown posts share one global budget, so a Run with many Checks
// cannot spend one per-post timeout per blocked post before exiting 130.
const SHUTDOWN_BUDGET_MS = 10_000;

// Signal contract: the first SIGINT/SIGTERM stops the scheduler — no
// un-started Check begins — waits for the in-flight pending post (so it
// cannot land after the status that replaces it), kills the running Checks
// (SIGTERM, then SIGKILL, awaited), and gives every Check that posted
// pending either its final result (if it completed) or error/interrupted,
// then exits 130. A signal while results post lets the in-flight posts
// finish (they are final) and exits 130 without extra error posts. A second
// signal force-exits 130 at once, skipping the remaining best-effort posts.
// Handlers stay installed until exit.
type RunState = {
	phase: "running" | "posting" | "done";
	interrupted: boolean;
	toRun: Check[];
	results: Map<string, Result>;
	pendingPosted: Set<string>;
	postedFinal: Set<string>;
	pendingDone: Promise<void>;
	sha: string;
};

// Shutdown statuses: every Check that announced itself ends up with either
// its final result or error/interrupted — never a stale pending — and
// already-posted finals are never posted twice. `completed` is the snapshot
// taken when the signal arrived, so a Check killed by the shutdown itself
// still reads as interrupted, not as its synthetic failure result.
async function postShutdownStatuses(
	state: RunState,
	completed: Map<string, Result>,
	deadline: number,
): Promise<void> {
	for (const check of state.toRun) {
		if (state.postedFinal.has(check.name)) continue;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return; // budget spent: skip the remaining posts
		const result = completed.get(check.name);
		if (result) {
			if (await postResult(result, state.sha, remaining))
				state.postedFinal.add(check.name);
			continue;
		}
		if (state.pendingPosted.has(`local-ci/${check.name}`))
			await postInterrupted([check], state.sha, remaining);
	}
}

function installSignalHandlers(state: RunState) {
	const onSignal = () => {
		// A second signal force-exits at once: the in-flight gh call is
		// killed (so it cannot apply a status after the exit) and the
		// remaining best-effort posts are skipped.
		if (state.interrupted) {
			killInFlightCommands();
			process.exit(130);
		}
		state.interrupted = true;
		if (state.phase === "running") {
			// What finished before the signal: results recorded later belong
			// to Checks the shutdown killed, which read as interrupted.
			const completed = new Map(state.results);
			const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
			void (async () => {
				try {
					// Serialize with pending posting: the in-flight pending
					// post settles before any status that replaces it.
					await state.pendingDone;
					await terminateRunningChecks();
					await postShutdownStatuses(state, completed, deadline);
				} finally {
					killInFlightCommands();
					process.exit(130);
				}
			})();
			return;
		}
		if (state.phase === "posting") return; // main() exits 130 after posting
		killInFlightCommands();
		process.exit(130);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
}

export async function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const stopEarlySignals = installEarlySignalHandlers();
		const info = await preflight(options);
		await push(info.branch, options.noPush, info.sha);
		stopEarlySignals();
		const state: RunState = {
			phase: "running",
			interrupted: false,
			toRun: [],
			results: new Map(),
			pendingPosted: new Set(),
			postedFinal: new Set(),
			pendingDone: Promise.resolve(),
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
		const pendingPostsPromise = postPending(
			pending,
			info.sha,
			(context) => state.pendingPosted.add(context),
			() => state.interrupted,
		);
		state.pendingDone = pendingPostsPromise.then(
			() => undefined,
			() => undefined,
		);
		const pendingPosts = await pendingPostsPromise;
		const ran = await pMap(
			pending,
			async (check) => {
				// An interrupt stops the scheduler: an un-started Check never spawns.
				if (state.interrupted)
					return { check, status: "failed", duration: 0 } as Result;
				const result = await runCheck(check, process.cwd());
				state.results.set(check.name, result);
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
