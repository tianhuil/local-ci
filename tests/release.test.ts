import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (args: string[], cwd: string) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const releaseEnv = (path?: string) => {
	const { GH_TOKEN, GITHUB_TOKEN, ...env } = process.env;
	return { ...env, ...(path ? { PATH: path } : {}) };
};

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
	await chmod(join(root, "scripts/release.mts"), 0o755);
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
			const first = spawnSync(
				"node",
				["scripts/release.mts", "publish", "--no-github-release"],
				{
					env: releaseEnv(),
					cwd: repo.root,
					encoding: "utf8",
				},
			);
			if (first.status !== 0)
				throw new Error(`release failed: ${first.stderr}`);
			expect(first.status).toBe(0);
			const release = git(
				["ls-remote", "origin", "refs/heads/release"],
				repo.root,
			).split(/\s/)[0];
			const tag = git(
				["ls-remote", "--tags", "origin", "refs/tags/v0.1.0^{}"],
				repo.root,
			).split(/\s/)[0];
			expect(release).toBe(tag);
			expect(git(["cat-file", "-t", "refs/tags/v0.1.0"], repo.root)).toBe(
				"tag",
			);
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
			const second = spawnSync(
				"node",
				["scripts/release.mts", "publish", "--no-github-release"],
				{
					env: releaseEnv(),
					cwd: repo.root,
					encoding: "utf8",
				},
			);
			expect(second.status).toBe(0);
			expect(second.stderr).toContain(
				"v0.1.0 already exists on origin; nothing to release.",
			);
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
			const third = spawnSync(
				"node",
				["scripts/release.mts", "publish", "--no-github-release"],
				{
					env: releaseEnv(),
					cwd: repo.root,
					encoding: "utf8",
				},
			);
			expect(third.status).toBe(0);
			const secondRelease = git(
				["ls-remote", "origin", "refs/heads/release"],
				repo.root,
			).split(/\s/)[0];
			expect(
				git(["show", "-s", "--format=%P", secondRelease], repo.root).split(" "),
			).toEqual([previousRelease, newSourceHead]);

			const bumpedCheckout = await mkdtemp(
				join(tmpdir(), "local-ci-release-checkout-"),
			);
			execFileSync("git", [
				"clone",
				"-q",
				"--branch",
				"v0.1.1",
				repo.remote,
				bumpedCheckout,
			]);
			execFileSync("bun", ["install", "--frozen-lockfile", "--production"], {
				cwd: bumpedCheckout,
			});
			const bumpedInstalled = spawnSync(
				process.execPath,
				["bin/local-ci.js", "--version"],
				{ cwd: bumpedCheckout, encoding: "utf8" },
			);
			expect(bumpedInstalled.status).toBe(0);
			expect(bumpedInstalled.stdout).toBe("0.1.1\n");

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
		const refsBefore = git(["ls-remote", "origin"], repo.root);
		const result = spawnSync("node", ["scripts/release.mts", "check"], {
			env: releaseEnv(),
			cwd: repo.root,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
		expect(git(["rev-parse", "HEAD"], repo.root)).toBe(mainHead);
		expect(git(["status", "--porcelain"], repo.root)).toBe("");
		expect(git(["ls-remote", "origin"], repo.root)).toBe(refsBefore);
		expect(
			spawnSync("git", ["show-ref", "--tags"], {
				cwd: repo.root,
				encoding: "utf8",
			}).stdout,
		).toBe("");
	});

	test("uses fallback identity without git user configuration", async () => {
		const repo = await releaseRepo();
		for (const key of ["user.name", "user.email"]) {
			spawnSync("git", ["config", "--unset-all", key], { cwd: repo.root });
		}
		const env = releaseEnv();
		env.GIT_CONFIG_GLOBAL = "/dev/null";
		env.GIT_CONFIG_SYSTEM = "/dev/null";
		for (const key of [
			"GIT_AUTHOR_NAME",
			"GIT_AUTHOR_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_COMMITTER_EMAIL",
			"GITHUB_ACTOR",
		])
			delete env[key];
		const result = spawnSync(
			"node",
			["scripts/release.mts", "publish", "--no-github-release"],
			{
				cwd: repo.root,
				env,
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		const release = git(
			["ls-remote", "origin", "refs/heads/release"],
			repo.root,
		).split(/\s/)[0];
		expect(git(["show", "-s", "--format=%an <%ae>", release], repo.root)).toBe(
			"release.mts <release@local-ci>",
		);
	});

	test("leaves the real index clean when commit-tree fails", async () => {
		const repo = await releaseRepo();
		const shim = await mkdtemp(join(tmpdir(), "local-ci-git-shim-"));
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		await writeFile(
			join(shim, "git"),
			`#!/bin/sh\nif [ "$1" = commit-tree ]; then exit 42; fi\nexec ${realGit} "$@"\n`,
		);
		await chmod(join(shim, "git"), 0o755);
		const result = spawnSync(
			"node",
			["scripts/release.mts", "publish", "--no-github-release"],
			{
				cwd: repo.root,
				env: releaseEnv(`${shim}:${process.env.PATH}`),
				encoding: "utf8",
			},
		);
		expect(result.status).not.toBe(0);
		expect(git(["status", "--porcelain"], repo.root)).toBe("");
		expect(git(["diff", "--cached"], repo.root)).toBe("");
	});

	test("fails without publishing when the remote rejects the tag", async () => {
		const repo = await releaseRepo();
		const hook = join(repo.remote, "hooks/pre-receive");
		await writeFile(
			hook,
			"#!/bin/sh\nwhile read old new ref; do case $ref in refs/tags/*) echo reject-tag >&2; exit 1;; esac; done\nexit 0\n",
		);
		await chmod(hook, 0o755);
		const refsBefore = git(["ls-remote", "origin"], repo.root);
		const result = spawnSync(
			"node",
			["scripts/release.mts", "publish", "--no-github-release"],
			{
				cwd: repo.root,
				env: releaseEnv(),
				encoding: "utf8",
			},
		);
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"Failed to atomically publish v0.1.0 and release",
		);
		expect(git(["ls-remote", "origin"], repo.root)).toBe(refsBefore);
	});

	test("reports a failing GitHub release creation", async () => {
		const repo = await releaseRepo();
		const shim = await mkdtemp(join(tmpdir(), "local-ci-gh-shim-"));
		const calls = join(shim, "calls");
		await writeFile(
			join(shim, "gh"),
			`#!/bin/sh
if [ "$1" = release ] && [ "$2" = view ]; then exit 1; fi
if [ "$1" = release ] && [ "$2" = create ]; then
  echo create >> "${calls}"
  if [ ! -f "${calls}.succeeded" ]; then touch "${calls}.succeeded"; exit 7; fi
  exit 0
fi
exit 2
`,
		);
		await chmod(join(shim, "gh"), 0o755);
		const env = {
			...releaseEnv(`${shim}:${process.env.PATH}`),
			GH_TOKEN: "test",
		};
		const result = spawnSync("node", ["scripts/release.mts", "publish"], {
			cwd: repo.root,
			env,
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"GitHub Release v0.1.0 was not created; run gh release create v0.1.0",
		);
		const retry = spawnSync("node", ["scripts/release.mts", "publish"], {
			cwd: repo.root,
			env,
			encoding: "utf8",
		});
		expect(retry.status).toBe(0);
		expect((await readFile(calls, "utf8")).match(/^create$/gm)).toHaveLength(2);
	});

	test("rejects diverged tag and release branch refs", async () => {
		const repo = await releaseRepo();
		const other = git(["rev-parse", "HEAD"], repo.root);
		git(["commit", "--allow-empty", "-qm", "other"], repo.root);
		git(
			[
				"update-ref",
				"refs/heads/release",
				git(["rev-parse", "HEAD"], repo.root),
			],
			repo.root,
		);
		git(["tag", "-a", "v0.1.0", "-m", "diverged", other], repo.root);
		git(
			["push", "-q", "origin", "refs/heads/release", "refs/tags/v0.1.0"],
			repo.root,
		);
		const result = spawnSync(
			"node",
			["scripts/release.mts", "publish", "--no-github-release"],
			{
				cwd: repo.root,
				env: releaseEnv(),
				encoding: "utf8",
			},
		);
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"Inconsistent release refs",
		);
	});

	test(
		"packs an installable tarball and strips lifecycle scripts",
		{ timeout: 30000 },
		async () => {
			const repo = await releaseRepo();
			const result = spawnSync("node", ["scripts/release.mts", "pack"], {
				cwd: repo.root,
				env: releaseEnv(),
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
			const tarball = result.stdout.trim();
			expect(tarball).toEndWith(".tgz");
			const packageText = execFileSync(
				"tar",
				["-xOf", tarball, "package/package.json"],
				{
					encoding: "utf8",
				},
			);
			const packed = JSON.parse(packageText) as {
				scripts?: Record<string, string>;
			};
			expect(packed.scripts?.build).toBeUndefined();
			expect(packed.scripts?.test).toBe("bun test");
			const installDir = await mkdtemp(
				join(tmpdir(), "local-ci-pack-install-"),
			);
			execFileSync(
				"npm",
				[
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--prefix",
					installDir,
					tarball,
				],
				{
					encoding: "utf8",
					stdio: "ignore",
				},
			);
			const installed = spawnSync(
				join(installDir, "node_modules/.bin/local-ci"),
				["--version"],
				{ encoding: "utf8" },
			);
			expect(installed.status).toBe(0);
			expect(installed.stdout).toBe("0.1.0\n");
		},
	);

	test("fails when package files omit built output", async () => {
		const repo = await releaseRepo();
		const packagePath = join(repo.root, "package.json");
		const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
			files: string[];
		};
		packageJson.files = ["bin"];
		await writeFile(
			packagePath,
			`${JSON.stringify(packageJson, null, "\t")}\n`,
		);
		git(["add", "package.json"], repo.root);
		git(["commit", "-qm", "omit dist"], repo.root);
		const result = spawnSync("node", ["scripts/release.mts", "check"], {
			cwd: repo.root,
			env: releaseEnv(),
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"Installs would drop these built files",
		);
	});
});
