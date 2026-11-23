import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, test } from "vitest";
import {
	binPaths,
	buildProgram,
	DEFAULTS,
	detectPackageManager,
	findUnpackedFiles,
	parseConfigFile,
	type ReleaseConfig,
	ReleaseError,
	type Run,
	stripLifecycleScripts,
} from "./release.mts";

describe("stripLifecycleScripts", () => {
	test("drops install-time scripts, keeps the rest and the indentation", () => {
		const raw =
			'{\n\t"name": "x",\n\t"scripts": {\n\t\t"build": "tsc",\n\t\t"prepare": "tsc",\n\t\t"test": "node --test"\n\t}\n}\n';
		expect(stripLifecycleScripts(raw)).toBe(
			'{\n\t"name": "x",\n\t"scripts": {\n\t\t"test": "node --test"\n\t}\n}\n',
		);
	});

	test('removes "scripts" once it is empty', () => {
		expect(
			stripLifecycleScripts('{"name":"x","scripts":{"build":"tsc"}}'),
		).toBe('{\n  "name": "x"\n}\n');
	});
});

test("findUnpackedFiles lists built files the pack left out", () => {
	expect(
		findUnpackedFiles(["bin/x.js", "package.json"], ["dist/a.js", "bin/x.js"]),
	).toEqual(["dist/a.js"]);
	expect(findUnpackedFiles(["dist/a.js"], ["dist/a.js"])).toEqual([]);
});

test("detectPackageManager reads the lockfile", () => {
	expect(detectPackageManager((f) => f === "pnpm-lock.yaml")).toBe("pnpm");
	expect(detectPackageManager((f) => f === "bun.lock")).toBe("bun");
	expect(detectPackageManager((f) => f === "yarn.lock")).toBe("yarn");
	expect(detectPackageManager(() => false)).toBe("npm");
});

test("binPaths normalizes string and object forms", () => {
	expect(binPaths({ bin: "./dist/cli.js" })).toEqual(["dist/cli.js"]);
	expect(binPaths({ bin: { a: "dist/a.js", b: "./dist/b.js" } })).toEqual([
		"dist/a.js",
		"dist/b.js",
	]);
	expect(() => binPaths({})).toThrow(ReleaseError);
});

describe("parseConfigFile", () => {
	test("accepts known keys", () => {
		expect(
			parseConfigFile('{"distDir":"out","githubRelease":false}', "c.json"),
		).toEqual({
			distDir: "out",
			githubRelease: false,
		});
	});

	test("rejects unknown keys and wrong types", () => {
		expect(() => parseConfigFile('{"dist":"out"}', "c.json")).toThrow(
			/unknown key "dist"/,
		);
		expect(() => parseConfigFile('{"distDir":1}', "c.json")).toThrow(
			/"distDir" must be a string/,
		);
		expect(() => parseConfigFile("[]", "c.json")).toThrow(
			/expected a JSON object/,
		);
	});
});

describe("buildProgram", () => {
	const parse = (
		args: string[],
	): { mode: string; config: ReleaseConfig; install: boolean } => {
		let seen:
			| { mode: string; config: ReleaseConfig; install: boolean }
			| undefined;
		const run: Run = (mode, config, { install }) => {
			seen = { mode, config, install };
		};
		const program = buildProgram(run);
		for (const command of [program, ...program.commands] satisfies Command[]) {
			command
				.exitOverride()
				.configureOutput({ writeErr: () => {}, writeOut: () => {} });
		}
		program.parse(args, { from: "user" });
		if (!seen) throw new Error("action did not run");
		return seen;
	};

	test("defaults apply when there are no flags and no release.config.json", () => {
		expect(parse(["check"]).config).toEqual(DEFAULTS);
	});

	test("a missing --config file is an error", () => {
		expect(() => parse(["--config", "missing.json", "check"])).toThrow(
			/missing\.json not found/,
		);
	});

	test("flags override the config file, which overrides defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "release-test-"));
		const config = join(dir, "release.json");
		writeFileSync(
			config,
			JSON.stringify({
				distDir: "out",
				tagPrefix: "release-",
				githubRelease: false,
			}),
		);
		const { mode, config: resolved } = parse([
			"--config",
			config,
			"--dist-dir",
			"build",
			"publish",
		]);
		expect(mode).toBe("publish");
		expect(resolved).toEqual({
			...DEFAULTS,
			distDir: "build",
			tagPrefix: "release-",
			githubRelease: false,
		});
	});

	test("--no-github-release and --install reach the action", () => {
		expect(parse(["publish", "--no-github-release"]).config.githubRelease).toBe(
			false,
		);
		expect(parse(["pack", "--install"]).install).toBe(true);
	});

	test("rejects flags on the wrong command", () => {
		let code: string | undefined;
		try {
			parse(["publish", "--install"]);
		} catch (error) {
			code = (error as NodeJS.ErrnoException).code;
		}
		expect(code).toBe("commander.unknownOption");
	});
});
