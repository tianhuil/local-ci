import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (args: string[], cwd: string) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function releaseRepo() {
	const root = await mkdtemp(join(tmpdir(), "local-ci-release-"));
	const remote = join(
		await mkdtemp(join(tmpdir(), "local-ci-release-remote-")),
		"origin.git",
	);
	execFileSync("git", ["init", "-q", "--bare", remote]);
	execFileSync("git", ["init", "-q", "-b", "main", root]);
	git(["config", "user.email", "test@example.com"], root);
	git(["config", "user.name", "Test"], root);
	for (const file of [
		"package.json",
		"bun.lock",
		"tsconfig.json",
		".gitignore",
	]) {
		execFileSync("cp", [join(process.cwd(), file), root]);
	}
	for (const directory of ["src", "scripts", "bin"]) {
		execFileSync("cp", ["-R", join(process.cwd(), directory), root]);
	}
	await symlink(
		join(process.cwd(), "node_modules"),
		join(root, "node_modules"),
	);
	await chmod(join(root, "scripts/release.sh"), 0o755);
	git(["add", "."], root);
	git(["commit", "-qm", "source"], root);
	git(["remote", "add", "origin", remote], root);
	git(["push", "-q", "-u", "origin", "main"], root);
	return { root, remote };
}

describe("release flow", () => {
	test(
		"creates a tagged release commit, then no-ops and installs from its tag",
		{ timeout: 30000 },
		async () => {
			const repo = await releaseRepo();
			const sourceHead = git(["rev-parse", "HEAD"], repo.root);
			const first = spawnSync("scripts/release.sh", [], {
				cwd: repo.root,
				encoding: "utf8",
			});
			if (first.status !== 0)
				throw new Error(`release failed: ${first.stderr}`);
			expect(first.status).toBe(0);
			const release = git(
				["ls-remote", "origin", "refs/heads/release"],
				repo.root,
			).split(/\s/)[0];
			const tag = git(
				["ls-remote", "origin", "refs/tags/v0.1.0"],
				repo.root,
			).split(/\s/)[0];
			expect(release).toBe(tag);
			expect(release).not.toBe("");
			const tree = git(["show", "-s", "--format=%T", release], repo.root);
			expect(
				execFileSync("git", ["ls-tree", "-r", "--name-only", tree], {
					cwd: repo.root,
					encoding: "utf8",
				}),
			).toContain("dist/index.js");
			const parents = git(
				["show", "-s", "--format=%P", release],
				repo.root,
			).split(" ");
			expect(parents).toEqual([sourceHead]);
			const second = spawnSync("scripts/release.sh", [], {
				cwd: repo.root,
				encoding: "utf8",
			});
			expect(second.status).toBe(0);
			expect(second.stdout).toContain("already released v0.1.0");
			const previousRelease = release;
			const packagePath = join(repo.root, "package.json");
			const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
				version: string;
			};
			packageJson.version = "0.1.1";
			await writeFile(
				packagePath,
				`${JSON.stringify(packageJson, null, "\t")}\n`,
			);
			git(["add", "package.json"], repo.root);
			git(["commit", "-qm", "source 0.1.1"], repo.root);
			const newSourceHead = git(["rev-parse", "HEAD"], repo.root);
			git(["push", "-q", "origin", "main"], repo.root);
			const third = spawnSync("scripts/release.sh", [], {
				cwd: repo.root,
				encoding: "utf8",
			});
			expect(third.status).toBe(0);
			const secondRelease = git(
				["ls-remote", "origin", "refs/heads/release"],
				repo.root,
			).split(/\s/)[0];
			expect(
				git(["show", "-s", "--format=%P", secondRelease], repo.root).split(" "),
			).toEqual([previousRelease, newSourceHead]);

			const checkout = await mkdtemp(
				join(tmpdir(), "local-ci-release-checkout-"),
			);
			execFileSync("git", [
				"clone",
				"-q",
				"--branch",
				"v0.1.0",
				repo.remote,
				checkout,
			]);
			execFileSync("bun", ["install", "--frozen-lockfile", "--production"], {
				cwd: checkout,
			});
			const installed = spawnSync(
				process.execPath,
				["bin/local-ci.js", "--version"],
				{ cwd: checkout, encoding: "utf8" },
			);
			if (installed.status !== 0)
				throw new Error(`tag install failed: ${installed.stderr}`);
			expect(installed.status).toBe(0);
			expect(installed.stdout).toBe("0.1.0\n");
			const archive = await mkdtemp(
				join(tmpdir(), "local-ci-release-archive-"),
			);
			execFileSync(
				"sh",
				["-c", `git archive ${release} | tar -x -C ${archive}`],
				{ cwd: repo.root },
			);
			execFileSync("bun", ["install", "--frozen-lockfile", "--production"], {
				cwd: archive,
			});
			const archived = spawnSync(
				process.execPath,
				["bin/local-ci.js", "--version"],
				{ cwd: archive, encoding: "utf8" },
			);
			expect(archived.status).toBe(0);
			expect(archived.stdout).toBe("0.1.0\n");
		},
	);

	test("dry-run creates no remote refs and leaves main and the tree unchanged", async () => {
		const repo = await releaseRepo();
		const packagePath = join(repo.root, "package.json");
		const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
			version: string;
		};
		packageJson.version = "0.1.1";
		await writeFile(
			packagePath,
			`${JSON.stringify(packageJson, null, "\t")}\n`,
		);
		git(["add", "package.json"], repo.root);
		git(["commit", "-qm", "version 0.1.1"], repo.root);
		git(["push", "-q", "origin", "main"], repo.root);
		const mainHead = git(["rev-parse", "HEAD"], repo.root);
		const result = spawnSync("scripts/release.sh", ["--dry-run"], {
			cwd: repo.root,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(
			/would push [0-9a-f]+:refs\/heads\/release and tag v0\.1\.1/,
		);
		expect(git(["rev-parse", "HEAD"], repo.root)).toBe(mainHead);
		expect(git(["status", "--porcelain"], repo.root)).toBe("");
		expect(git(["ls-remote", "origin", "refs/heads/release"], repo.root)).toBe(
			"",
		);
	});
});
