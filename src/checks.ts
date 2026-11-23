import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import type { Check } from "./config.js";
import { safeEnv } from "./proc.js";

export type Result = {
	check: Check;
	status: "passed" | "failed" | "skipped" | "blocked";
	duration: number;
	code?: number;
	timedOut?: boolean;
	log?: string;
	// Set when status is "blocked": every direct dependency that did not
	// pass, in depends_on order.
	blockedOn?: string[];
	pathSkipped?: boolean;
};

// Checks currently running, so a SIGINT/SIGTERM handler can stop them
// before posting interrupted statuses and exiting.
const running = new Set<ChildProcess>();
const KILL_GRACE_MS = 100;

// Stops every running Check and resolves only once they are all gone:
// SIGTERM to each process group, SIGKILL to whatever survives the grace
// period (a Check may ignore SIGTERM), then wait for every exit.
export async function terminateRunningChecks(): Promise<void> {
	const children = [...running];
	const exited = new Set<ChildProcess>();
	const closes = children.map(
		(child) =>
			new Promise<void>((resolve) => {
				child.on("close", () => {
					exited.add(child);
					resolve();
				});
			}),
	);
	for (const child of children) {
		try {
			if (child.pid) process.kill(-child.pid, "SIGTERM");
		} catch {
			/* already exited */
		}
	}
	await Promise.race([
		Promise.all(closes),
		new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS)),
	]);
	for (const child of children) {
		if (exited.has(child)) continue;
		try {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {
			/* already exited */
		}
	}
	await Promise.all(closes);
}

export function runCheck(check: Check, root: string): Promise<Result> {
	return new Promise((resolve) => {
		const start = Date.now();
		console.error(`running ${check.name}…`);
		const child = spawn(check.command, {
			shell: true,
			cwd: root,
			env: safeEnv,
			detached: true,
		});
		if (child.pid) running.add(child);
		let output = "";
		let settled = false;
		let timedOut = false;
		child.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			output += data.toString();
		});
		const finish = (timedOut: boolean, code: number) => {
			if (settled) return;
			settled = true;
			resolve({
				check,
				status: timedOut || code !== 0 ? "failed" : "passed",
				duration: Math.max(1, Math.round((Date.now() - start) / 1000)),
				code: timedOut ? undefined : code,
				timedOut,
				log: output,
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM");
			} catch {
				/* already exited */
			}
			setTimeout(() => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already exited */
				}
				finish(true, 1);
			}, 100);
		}, check.timeout * 1000);
		child.on("close", (code) => {
			running.delete(child);
			clearTimeout(timer);
			finish(timedOut, code ?? 1);
		});
	});
}
