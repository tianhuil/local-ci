import type { Result } from "./checks.js";
import type { Check } from "./config.js";
import { repoSlug } from "./git.js";
import { command } from "./proc.js";

type CommitStatus = { state: "success"; context: string };

// Every Commit Status post is bounded, so a hung gh call cannot block the
// exit an interrupt already requested.
const POST_TIMEOUT_MS = 10_000;

function statusFor(result: Result): { state: string; description: string } {
	const state = result.status === "passed" ? "success" : "failure";
	const description =
		result.status === "passed"
			? `passed in ${result.duration}s`
			: `failed in ${result.duration}s (${result.timedOut ? "timeout" : `exit ${result.code}`})`;
	return { state, description };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccessStatus(value: unknown): value is CommitStatus {
	return (
		isRecord(value) &&
		value.state === "success" &&
		typeof value.context === "string"
	);
}

// Latest state per local-ci/* context, as GitHub reports on the combined
// status endpoint. The top-level state is ignored: GitHub computes it over
// every tool's contexts, not just local-ci's.
export async function statuses(sha: string): Promise<Set<string>> {
	try {
		const response = await command([
			"gh",
			"api",
			`repos/${await repoSlug()}/commits/${sha}/status?per_page=100`,
		]);
		const combined: unknown = JSON.parse(response.stdout);
		if (!isRecord(combined) || !Array.isArray(combined.statuses))
			return new Set();
		return new Set(
			combined.statuses
				.filter(isSuccessStatus)
				.map((status) => status.context)
				.filter((context) => context.startsWith("local-ci/")),
		);
	} catch {
		return new Set();
	}
}

export async function postPending(
	checks: Check[],
	sha: string,
	onPosted?: (context: string) => void,
	shouldStop?: () => boolean,
): Promise<{ failures: number }> {
	let failures = 0;
	for (const check of checks) {
		// An interrupt stops announcing Checks: the in-flight post settles,
		// then no further pending posts.
		if (shouldStop?.()) break;
		const context = `local-ci/${check.name}`;
		try {
			await command(
				[
					"gh",
					"api",
					`repos/${await repoSlug()}/statuses/${sha}`,
					"-f",
					"state=pending",
					"-f",
					`context=${context}`,
					"-f",
					"description=running…",
				],
				process.cwd(),
				POST_TIMEOUT_MS,
			);
			onPosted?.(context);
		} catch {
			console.error(
				`error: failed to post Commit Status ${context} to GitHub; run gh auth login, then local-ci`,
			);
			failures += 1;
		}
	}
	return { failures };
}

export async function postInterrupted(
	checks: Check[],
	sha: string,
	timeout: number = POST_TIMEOUT_MS,
): Promise<void> {
	for (const check of checks) {
		try {
			await command(
				[
					"gh",
					"api",
					`repos/${await repoSlug()}/statuses/${sha}`,
					"-f",
					"state=error",
					"-f",
					`context=local-ci/${check.name}`,
					"-f",
					"description=interrupted",
				],
				process.cwd(),
				timeout,
			);
		} catch {
			/* best effort: the Run is already exiting 130 */
		}
	}
}

// Posts one Check's final Commit Status; false means the post failed.
export async function postResult(
	result: Result,
	sha: string,
	timeout: number = POST_TIMEOUT_MS,
): Promise<boolean> {
	const { state, description } = statusFor(result);
	const context = `local-ci/${result.check.name}`;
	try {
		await command(
			[
				"gh",
				"api",
				`repos/${await repoSlug()}/statuses/${sha}`,
				"-f",
				`state=${state}`,
				"-f",
				`context=${context}`,
				"-f",
				`description=${description}`,
			],
			process.cwd(),
			timeout,
		);
		return true;
	} catch {
		console.error(
			`error: failed to post Commit Status ${context} to GitHub; run gh auth login, then local-ci`,
		);
		return false;
	}
}

export async function postResults(
	results: Result[],
	sha: string,
	totalSelected: number,
): Promise<{ posted: number; failures: number }> {
	let posted = 0;
	let failures = 0;
	for (const result of results) {
		const { state, description } = statusFor(result);
		const context = `local-ci/${result.check.name}`;
		try {
			await command(
				[
					"gh",
					"api",
					`repos/${await repoSlug()}/statuses/${sha}`,
					"-f",
					`state=${state}`,
					"-f",
					`context=${context}`,
					"-f",
					`description=${description}`,
				],
				process.cwd(),
				POST_TIMEOUT_MS,
			);
			posted += 1;
		} catch {
			console.error(
				`error: failed to post Commit Status ${context} to GitHub; run gh auth login, then local-ci`,
			);
			failures += 1;
		}
	}
	const checkFailures = results.filter(
		(result) => result.status === "failed",
	).length;
	if (posted > 0) {
		console.log(
			`\nposted ${posted} Commit Status${posted === 1 ? "" : "es"} to ${sha.slice(0, 7)}; ${checkFailures ? `${checkFailures} of ${totalSelected} Checks failed` : `all ${totalSelected} Checks passed`}`,
		);
	}
	return { posted, failures };
}
