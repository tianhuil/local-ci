import type { Result } from "./checks.js";
import { repoSlug } from "./git.js";
import { command } from "./proc.js";

type CommitStatus = { state: "success"; context: string };

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

export async function statuses(sha: string): Promise<Set<string>> {
	try {
		const response = await command([
			"gh",
			"api",
			`repos/${await repoSlug()}/statuses/${sha}`,
		]);
		const list: unknown = JSON.parse(response.stdout);
		if (!Array.isArray(list)) return new Set();
		return new Set(list.filter(isSuccessStatus).map((item) => item.context));
	} catch {
		return new Set();
	}
}

export async function postResults(
	results: Result[],
	sha: string,
	totalChecks: number,
): Promise<{ posted: number; failures: number }> {
	let posted = 0;
	let failures = 0;
	for (const result of results) {
		const state = result.status === "passed" ? "success" : "failure";
		const description =
			result.status === "passed"
				? `passed in ${result.duration}s`
				: `failed in ${result.duration}s (${result.timedOut ? "timeout" : `exit ${result.code}`})`;
		const context = `local-ci/${result.check.name}`;
		try {
			await command([
				"gh",
				"api",
				`repos/${await repoSlug()}/statuses/${sha}`,
				"-f",
				`state=${state}`,
				"-f",
				`context=${context}`,
				"-f",
				`description=${description}`,
			]);
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
			`\nposted ${posted} Commit Status${posted === 1 ? "" : "es"} to ${sha.slice(0, 7)}; ${checkFailures ? `${checkFailures} of ${totalChecks} Checks failed` : `all ${totalChecks} Checks passed`}`,
		);
	}
	return { posted, failures };
}
