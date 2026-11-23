import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

// Guard for the design-owned denominator of required cases
// (notes/design/local-ci-features-manifest.yml): every case whose phase is
// enforced must have its id present in its named test file's source, so a
// case cannot silently vanish while future phases stay pending.
type ManifestCase = { id: string; phase: string; file: string };
type Manifest = { enforced_phases?: string[]; cases?: ManifestCase[] };

describe("required-case manifest", () => {
	test("every enforced case id appears in its named test file", async () => {
		const manifest = YAML.parse(
			await readFile(
				join("notes/design/local-ci-features-manifest.yml"),
				"utf8",
			),
		) as Manifest;
		expect(Array.isArray(manifest.cases)).toBe(true);
		const enforced = new Set(manifest.enforced_phases ?? []);
		const missing: string[] = [];
		for (const entry of manifest.cases ?? []) {
			if (!enforced.has(entry.phase)) continue;
			const source = await readFile(entry.file, "utf8");
			if (!source.includes(entry.id)) missing.push(entry.id);
		}
		expect(
			missing,
			`missing manifest case ids in their test files: ${missing.join(", ")}`,
		).toEqual([]);
	});
});
