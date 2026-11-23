import { readFileSync } from "node:fs";
import process from "node:process";
import type { Check } from "./config.js";

function loadVersion(): string {
	try {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		if (typeof packageJson.version !== "string" || packageJson.version === "")
			throw new Error("missing version");
		return packageJson.version;
	} catch {
		throw new Error("error: package.json: unable to read version");
	}
}
const VERSION = loadVersion();
const HELP = `Usage: local-ci [options]\n\nPush the current branch, run every Check in local-ci.yml, and post one\nCommit Status (local-ci/<check>) per Check to the pushed commit on GitHub.\nEach Check posts pending ("running…") while it runs, then its final state.\nPrints one line per Check; full logs go to .git/local-ci/logs/<sha>/.\n\nOptions:\n  --force          run every Check, even ones that already passed on this\n                   commit (default: skip them)\n  --only <names>   run only the named Checks, comma-separated; the rest\n                   keep their Commit Statuses from earlier Runs\n  --no-push        don't push; HEAD must already be on GitHub (default: push)\n  -j, --jobs <N>   run up to N Checks at once (default: all Checks at once)\n  -V, --version    print the version\n  -h, --help       print this help\n\nExamples:\n  local-ci                 run after each commit\n  local-ci --force         re-run everything, e.g. to rule out a flaky pass\n  local-ci --only unit     run one Check, e.g. after fixing a failure\n  local-ci --no-push       the commit was already pushed some other way\n  local-ci --jobs 1        run Checks one at a time, e.g. if they conflict\n\nExit codes:\n  0    every Check passed or had already passed\n  1    a Check failed, or the Run could not start (see the error line)\n  2    unknown option or argument\n  130  interrupted (Ctrl-C or SIGTERM): running Checks are killed and the\n       unfinished ones post error/interrupted\n`;
export type Options = {
	force: boolean;
	noPush: boolean;
	jobs?: number;
	only?: string[];
};
export function parseArgs(argv: string[]): Options {
	const options: Options = { force: false, noPush: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--force") options.force = true;
		else if (arg === "--only") {
			const value = argv[++i];
			options.only = (value ?? "").split(",").map((name) => name.trim());
		} else if (arg === "--no-push") options.noPush = true;
		else if (arg === "-j" || arg === "--jobs") {
			const value = argv[++i];
			if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
				console.error(
					`error: invalid value "${value ?? ""}" for --jobs; use a positive integer, such as --jobs 4`,
				);
				process.exitCode = 2;
				throw new Error("ARGUMENT_ERROR");
			}
			options.jobs = Number(value);
		} else if (arg === "-V" || arg === "--version") {
			process.stdout.write(`${VERSION}\n`);
			process.exit(0);
		} else if (arg === "-h" || arg === "--help") {
			process.stdout.write(HELP);
			process.exit(0);
		} else if (arg.startsWith("-")) {
			console.error(
				`error: unknown option ${arg}; valid options: --force, --only, --no-push, --jobs, --help, --version`,
			);
			process.exitCode = 2;
			throw new Error("ARGUMENT_ERROR");
		} else {
			console.error(
				`error: unexpected argument "${arg}"; local-ci takes no arguments`,
			);
			process.exitCode = 2;
			throw new Error("ARGUMENT_ERROR");
		}
	}
	return options;
}

// --only names cannot be validated at parse time: the valid names come from
// local-ci.yml, which preflight loads. Same exit-2 shape as parse errors, so
// nothing is pushed, run, or posted when a name is unknown.
export function validateOnly(options: Options, checks: Check[]): void {
	if (!options.only) return;
	const names = checks.map((check) => check.name);
	for (const name of options.only) {
		if (names.includes(name)) continue;
		console.error(
			`error: unknown Check "${name}" for --only; Checks: ${names.join(", ")}`,
		);
		process.exitCode = 2;
		throw new Error("ARGUMENT_ERROR");
	}
}
