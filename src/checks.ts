import { spawn } from "node:child_process";
import process from "node:process";
import type { Check } from "./config.js";
import { safeEnv } from "./proc.js";

export type Result = {
	check: Check;
	status: "passed" | "failed" | "skipped";
	duration: number;
	code?: number;
	timedOut?: boolean;
	log?: string;
};

// PIDs of the detached process groups currently running a Check, so a
// SIGINT/SIGTERM handler can kill them before posting interrupted statuses.
const running = new Set<number>();

export function killRunningChecks(): void {
	for (const pid of running) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			/* already exited */
		}
	}
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
		if (child.pid) running.add(child.pid);
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
			if (child.pid) running.delete(child.pid);
			clearTimeout(timer);
			finish(timedOut, code ?? 1);
		});
	});
}
