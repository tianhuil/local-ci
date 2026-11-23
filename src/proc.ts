import { type ChildProcess, execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Noninteractive git and gh: never prompt, fail instead.
export const safeEnv = {
	...process.env,
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
};

export async function git(
	args: string[],
	cwd = process.cwd(),
): Promise<string> {
	return (await exec("git", args, { cwd, env: safeEnv })).stdout.trimEnd();
}

// The command() children currently in flight, so a forced exit can kill an
// in-flight gh/git call instead of letting it outlive the Run and apply a
// status after the exit.
const inFlight = new Set<ChildProcess>();

export function killInFlightCommands(): void {
	for (const child of inFlight) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already exited */
		}
	}
	inFlight.clear();
}

export function command(
	args: string[],
	cwd = process.cwd(),
	timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			args[0],
			args.slice(1),
			{
				cwd,
				env: safeEnv,
				timeout,
				killSignal: "SIGKILL",
			},
			(error, stdout, stderr) => {
				inFlight.delete(child);
				if (error) {
					Object.assign(error, { stdout, stderr });
					reject(error);
				} else {
					resolve({ stdout, stderr });
				}
			},
		);
		inFlight.add(child);
	});
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
