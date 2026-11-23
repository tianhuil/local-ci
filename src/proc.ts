import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";

// Noninteractive git and gh: never prompt, fail instead.
export const safeEnv = {
	...process.env,
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
};

// The command() children currently in flight, each in its own process
// group, so a forced exit can kill the whole tree — a gh shell and its
// delay child alike — instead of letting it outlive the Run and apply a
// status after the exit. git() rides the same tracked path.
const inFlight = new Set<ChildProcess>();

export function killInFlightCommands(): ChildProcess[] {
	const killed = [...inFlight];
	for (const child of killed) {
		try {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {
			/* already exited */
		}
	}
	inFlight.clear();
	return killed;
}

// Waits, bounded, for the killed in-flight children to finish closing:
// 'close' fires only after the child ended and its stdio drained, so the
// wait confirms the kills landed instead of leaving an observable (zombie)
// child behind after the exit. A descendant outside the killed group can
// hold the pipes open; the bound keeps that from hanging the exit.
export function waitForInFlightCommands(
	children: ChildProcess[],
	ms: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const closed = children.map(
		(child) =>
			new Promise<void>((resolve) => {
				child.once("close", () => resolve());
			}),
	);
	const bound = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	return Promise.race([
		Promise.all(closed).then(() => undefined),
		bound,
	]).finally(() => clearTimeout(timer));
}

export function command(
	args: string[],
	cwd = process.cwd(),
	timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(args[0], args.slice(1), {
			cwd,
			env: safeEnv,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		inFlight.add(child);
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const timer =
			timeout === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						try {
							if (child.pid) process.kill(-child.pid, "SIGKILL");
						} catch {
							/* already exited */
						}
					}, timeout);
		const settle = (error: Error | null) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			inFlight.delete(child);
			if (error) {
				Object.assign(error, { stdout, stderr });
				reject(error);
			} else {
				resolve({ stdout, stderr });
			}
		};
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (error) => settle(error));
		child.on("close", (code, signal) => {
			if (timedOut) {
				const error = new Error(
					`Command timed out after ${timeout}ms: ${args.join(" ")}`,
				);
				Object.assign(error, { killed: true, code: null, signal: "SIGKILL" });
				settle(error);
				return;
			}
			if (code !== 0) {
				const error = new Error(
					`Command failed: ${args.join(" ")}${signal ? ` (killed by ${signal})` : ""}`,
				);
				Object.assign(error, { code, signal });
				settle(error);
				return;
			}
			settle(null);
		});
	});
}

export async function git(
	args: string[],
	cwd = process.cwd(),
): Promise<string> {
	return (await command(["git", ...args], cwd)).stdout.trimEnd();
}

export function commandStderr(error: unknown): string {
	if (
		error instanceof Error &&
		"stderr" in error &&
		typeof error.stderr === "string"
	) {
		return error.stderr;
	}
	return String(error);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
