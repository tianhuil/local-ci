import type { Result } from "./checks.js";

export function printCheckResults(results: Result[], width: number): void {
	for (const result of results) {
		const name = result.check.name.padEnd(width);
		if (result.status === "skipped") {
			console.log(
				`${name}  skipped  ${result.pathSkipped ? "no matching changes" : "already passed"}`,
			);
			continue;
		}
		if (result.status === "blocked") {
			console.log(
				`${name}  blocked  depends on ${(result.blockedOn ?? []).join(", ")}`,
			);
			continue;
		}
		const outcome =
			result.status === "failed"
				? `  ${result.timedOut ? "timeout" : `exit ${result.code}`}`
				: "";
		console.log(
			`${name}  ${result.status.padEnd(7)}  ${result.duration}s${outcome}`,
		);
	}
}

export function printFailurePreviews(results: Result[], sha: string): void {
	for (const result of results.filter((item) => item.status === "failed")) {
		const log = result.log ?? "";
		if (log.length > 1500) {
			console.log(
				`\n${result.check.name} output (last 1,500 of ${log.length} chars):\n${log.slice(-1500)}`,
			);
		} else {
			console.log(`\n${result.check.name} output:\n${log}`);
		}
		console.log(
			`full log: .git/local-ci/logs/${sha.slice(0, 7)}/${result.check.name}.log`,
		);
	}
}
