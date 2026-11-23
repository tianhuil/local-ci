import { execFile } from "node:child_process";
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

export async function command(
	args: string[],
	cwd = process.cwd(),
	timeout?: number,
) {
	return exec(args[0], args.slice(1), {
		cwd,
		env: safeEnv,
		timeout,
		killSignal: "SIGKILL",
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
