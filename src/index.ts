import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { type Result, runCheck, terminateRunningChecks } from "./checks.js";
import { type Options, parseArgs, validateOnly } from "./cli.js";
import { type Check, loadChecks } from "./config.js";
import { changedFiles, push, repoSlug, resolveGitDir } from "./git.js";
import {
	postInterrupted,
	postPending,
	postResult,
	postResults,
	statuses,
} from "./github.js";
import {
	command,
	errorMessage,
	git,
	killInFlightCommands,
	waitForInFlightCommands,
} from "./proc.js";
import { printCheckResults, printFailurePreviews } from "./report.js";

const picomatch = createRequire(import.meta.url)("picomatch") as (
	pattern: string,
) => (value: string) => boolean;

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
	return { ...config, branch, defaultBranch, sha };
}

// Handlers are installed before preflight: that early handler just exits
// 130 (nothing has run and nothing has been posted), killing any in-flight
// git/gh child and waiting, bounded, for it to be gone so nothing
// observable outlives the Run. The stateful handler below replaces it
// after the push.
const EARLY_EXIT_WAIT_MS = 3000;

function installEarlySignalHandlers(): () => void {
	let signaled = false;
	const onSignal = () => {
		// A second signal skips the wait and force-exits at once.
		if (signaled) process.exit(130);
		signaled = true;
		void (async () => {
			try {
				const killed = killInFlightCommands();
				await waitForInFlightCommands(killed, EARLY_EXIT_WAIT_MS);
			} finally {
				process.exit(130);
			}
		})();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	return () => {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	};
}

// Test seam: records the handler-swap order, so a test can prove the
// stateful handler is installed before the early one is removed and no
// stretch runs on Node's default signal behavior.
function recordSwap(step: string): void {
	const log = process.env.LOCAL_CI_SWAP_LOG;
	if (!log) return;
	try {
		appendFileSync(log, `${step}\n`);
	} catch {
		/* test-only log */
	}
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

// The selected closure: with --only, the named Checks plus every Check
// they depend on, transitively — dependencies of selected Checks run even
// when not named. Without it, every Check. Everything downstream —
// skipping, pending, output, and the totals denominators — runs on the
// selection.
function selectClosure(checks: Check[], names: Set<string>): Check[] {
	const byName = new Map(checks.map((check) => [check.name, check]));
	const included = new Set<string>();
	const queue = [...names];
	while (queue.length > 0) {
		const name = queue.pop();
		if (name === undefined || included.has(name) || !byName.has(name)) continue;
		included.add(name);
		for (const dep of byName.get(name)?.depends_on ?? []) queue.push(dep);
	}
	return checks.filter((check) => included.has(check.name));
}

// Invariant 2 (the rerun rule): a selected Check that must run brings
// every dependency with it, even one that already passed on this SHA —
// its build output may not exist in this working tree. --force puts every
// selected Check in the must-run set, so the same expansion covers it.
function matchesChangedPath(patterns: string[], files: string[]): boolean {
	return files.some((file) => {
		let included = false;
		for (const pattern of patterns) {
			const negative = pattern.startsWith("!");
			const matcher = picomatch(negative ? pattern.slice(1) : pattern);
			if (matcher(file)) included = !negative;
		}
		return included;
	});
}

function withDependencies(selected: Check[], mustRun: Check[]): Set<string> {
	const byName = new Map(selected.map((check) => [check.name, check]));
	const names = new Set(mustRun.map((check) => check.name));
	const queue = [...names];
	while (queue.length > 0) {
		const check = byName.get(queue.pop() ?? "");
		if (!check) continue;
		for (const dep of check.depends_on) {
			if (names.has(dep)) continue;
			names.add(dep);
			queue.push(dep);
		}
	}
	return names;
}

// The dependency scheduler. A Check starts once every dependency has
// passed, never more than jobs run at once, and among ready Checks the one
// first in local-ci.yml list order starts first. A Check becomes ready —
// and announces its pending Commit Status — only when every dependency
// passed, so blocked and skipped Checks never announce. A Check whose
// dependency failed, timed out, or was blocked never runs: it is reported
// blocked, naming every direct dependency that did not pass, in
// depends_on order. An interrupt stops the loop: no un-started Check ever
// spawns.
async function runScheduled(
	toRun: Check[],
	state: RunState,
	jobs: number,
	root: string,
): Promise<{ results: Result[]; announceFailures: number }> {
	const results: Result[] = [];
	let announceFailures = 0;
	const byName = new Map(toRun.map((check) => [check.name, check]));
	const passed = new Set<string>();
	const settled = new Set<string>(); // passed, failed, or blocked
	const announced = new Set<string>();
	const started = new Set<string>();
	const blocked: Check[] = [];
	const running = new Map<string, Promise<void>>();
	let wake: (() => void) | undefined;
	let progress = false;
	const settleSignal = () => {
		if (progress) {
			progress = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			wake = resolve;
		});
	};
	let idle = settleSignal();
	const ready = (check: Check) =>
		check.depends_on.every((dep) => !byName.has(dep) || passed.has(dep));
	while (true) {
		if (state.interrupted) break;
		// Blocked first: a settled-but-not-passed dependency blocks its
		// dependents without running them, transitively. The blocked names
		// are finalized after the loop, when every dependency has settled.
		for (const check of toRun) {
			if (started.has(check.name) || settled.has(check.name)) continue;
			const blocker = check.depends_on.some(
				(dep) => settled.has(dep) && !passed.has(dep),
			);
			if (!blocker) continue;
			settled.add(check.name);
			blocked.push(check);
		}
		// Announce every ready Check in list order before starting it.
		for (const check of toRun) {
			if (state.interrupted) break;
			if (announced.has(check.name) || settled.has(check.name) || !ready(check))
				continue;
			announced.add(check.name);
			const announce = postPending(
				[check],
				state.sha,
				(context) => state.pendingPosted.add(context),
				() => state.interrupted,
			);
			state.pendingDone = announce.then(
				() => undefined,
				() => undefined,
			);
			announceFailures += (await announce).failures;
			// Start each Check immediately after its pending post. This keeps
			// independent Checks parallel without serializing their execution on
			// all pending-status posts, and lets an interrupt stop later posts.
			if (!state.interrupted && running.size < jobs) {
				started.add(check.name);
				const done = runCheck(check, root, state.sha).then((result) => {
					state.results.set(check.name, result);
					settled.add(check.name);
					if (result.status === "passed") passed.add(check.name);
					results.push(result);
					running.delete(check.name);
					if (wake) {
						const resolve = wake;
						wake = undefined;
						resolve();
					} else {
						progress = true;
					}
				});
				running.set(check.name, done);
			}
		}
		if (state.interrupted) break;
		// Announced Checks that found no free slot above start here when one
		// frees up. Only announced ones: starting a Check here that became
		// ready during the announce pass would skip its pending post, and the
		// next pass would announce and start it a second time.
		for (const check of toRun) {
			if (running.size >= jobs) break;
			if (
				!announced.has(check.name) ||
				started.has(check.name) ||
				settled.has(check.name) ||
				!ready(check)
			)
				continue;
			started.add(check.name);
			const done = runCheck(check, root, state.sha).then((result) => {
				state.results.set(check.name, result);
				settled.add(check.name);
				if (result.status === "passed") passed.add(check.name);
				results.push(result);
				running.delete(check.name);
				if (wake) {
					const resolve = wake;
					wake = undefined;
					resolve();
				} else {
					progress = true;
				}
			});
			running.set(check.name, done);
		}
		// A Check that became ready during the announce pass is announced on
		// the next pass, before waiting or concluding nothing is left to run.
		if (
			toRun.some(
				(check) =>
					!announced.has(check.name) &&
					!settled.has(check.name) &&
					ready(check),
			)
		)
			continue;
		if (running.size === 0) break; // nothing running: all progress has settled (or deadlocked)
		await idle;
		idle = settleSignal();
	}
	for (const check of blocked) {
		results.push({
			check,
			status: "blocked",
			duration: 0,
			blockedOn: check.depends_on.filter((dep) => !passed.has(dep)),
		});
	}
	const order = new Map(toRun.map((check, i) => [check.name, i]));
	results.sort(
		(a, b) => (order.get(a.check.name) ?? 0) - (order.get(b.check.name) ?? 0),
	);
	return { results, announceFailures };
}

export async function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const stopEarlySignals = installEarlySignalHandlers();
		const info = await preflight(options);
		validateOnly(options, info.checks);
		const only = options.only ? new Set(options.only) : undefined;
		const selected = only ? selectClosure(info.checks, only) : info.checks;
		await push(info.branch, options.noPush, info.sha);
		// The stateful handler is installed before the early one is removed,
		// so no stretch — now or after future edits — runs on Node's default
		// signal behavior.
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
		recordSwap("stateful-installed");
		recordSwap("early-removed");
		stopEarlySignals();
		const passed = await statuses(info.sha);
		// Precedence, outermost first: --only selection (above) → the
		// already-passed skip, bypassed by --force and by invariant 2's rerun
		// rule → dependency blocking (inside runScheduled).
		const changed = await changedFiles(info.defaultBranch);
		// Skip precedence is explicit: already-passed Checks short-circuit before
		// path filtering; only Checks that would run are filtered by paths.
		const eligible = selected.filter(
			(check) => !passed.has(`local-ci/${check.name}`) || options.force,
		);
		const pathSkipped = eligible.filter(
			(check) =>
				check.run_if_changed &&
				changed !== undefined &&
				!matchesChangedPath(check.run_if_changed, changed),
		);
		const mustRun = withDependencies(
			selected,
			eligible.filter((check) => !pathSkipped.includes(check)),
		);
		const skipped: Result[] = selected
			.filter((check) => !mustRun.has(check.name))
			.map((check) => ({
				check,
				status: "skipped",
				duration: 0,
				pathSkipped: pathSkipped.includes(check),
			}));
		const pending = selected.filter((check) => mustRun.has(check.name));
		state.toRun = pending;
		const gitDir = await resolveGitDir();
		const logDir = join(gitDir, "local-ci", "logs", info.sha.slice(0, 7));
		await mkdir(logDir, { recursive: true });
		const { results: ran, announceFailures } = await runScheduled(
			pending,
			state,
			options.jobs ?? Number.POSITIVE_INFINITY,
			process.cwd(),
		);
		if (state.interrupted) return; // the signal handler posts and exits 130
		state.phase = "posting";
		for (const result of ran.filter((item) => item.status !== "blocked"))
			await writeFile(
				join(logDir, `${result.check.name}.log`),
				result.log ?? "",
			);
		const all = [...skipped, ...ran].sort(
			(a, b) => info.checks.indexOf(a.check) - info.checks.indexOf(b.check),
		);
		if (!ran.length && skipped.every((result) => !result.pathSkipped)) {
			console.log(
				`0 Checks run; all ${selected.length} already passed on ${info.sha.slice(0, 7)}`,
			);
			state.phase = "done";
			if (state.interrupted) process.exit(130);
			return;
		}
		const width = Math.max(...selected.map((check) => check.name.length));
		printCheckResults(all, width);
		printFailurePreviews(ran, info.sha);
		const posting = await postResults(
			[...skipped.filter((result) => result.pathSkipped), ...ran],
			info.sha,
			selected.length,
		);
		state.phase = "done";
		if (state.interrupted) process.exit(130);
		if (
			ran.some(
				(result) => result.status === "failed" || result.status === "blocked",
			) ||
			posting.failures > 0 ||
			announceFailures > 0
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
