import { readFile } from "node:fs/promises";
import YAML from "yaml";

export type Check = { name: string; command: string; timeout: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export async function loadChecks(): Promise<{ checks: Check[] }> {
	let doc: unknown;
	try {
		doc = YAML.parse(await readFile("local-ci.yml", "utf8"));
	} catch {
		throw new Error("error: local-ci.yml: invalid YAML");
	}
	if (!isRecord(doc))
		throw new Error("error: local-ci.yml: checks must be a map");
	const top = doc;
	const timeout = top.timeout === undefined ? 60 : top.timeout;
	if (!positiveNumber(timeout))
		throw new Error("error: local-ci.yml: timeout must be a positive number");
	const entries = top.checks;
	if (!isRecord(entries) || Object.keys(entries).length === 0)
		throw new Error("error: local-ci.yml: checks must be a non-empty map");
	const checks: Check[] = [];
	for (const [name, raw] of Object.entries(entries)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes(".."))
			throw new Error(
				`error: local-ci.yml: check "${name}" has invalid name; use letters, numbers, ., _, or -`,
			);
		const objectValue = isRecord(raw) ? raw : undefined;
		const checkCommand = typeof raw === "string" ? raw : objectValue?.command;
		if (typeof checkCommand !== "string" || checkCommand.trim() === "")
			throw new Error(
				`error: local-ci.yml: check "${name}" has no command; add one, e.g. ${name}: pnpm test`,
			);
		const checkTimeout =
			objectValue?.timeout === undefined ? timeout : objectValue.timeout;
		if (!positiveNumber(checkTimeout))
			throw new Error(
				`error: local-ci.yml: check "${name}" has invalid timeout`,
			);
		checks.push({ name, command: checkCommand, timeout: checkTimeout });
	}
	return { checks };
}
