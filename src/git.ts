import { command, commandStderr, git } from "./proc.js";

export async function resolveGitDir(cwd = process.cwd()): Promise<string> {
	return git(["rev-parse", "--path-format=absolute", "--git-dir"], cwd);
}

// Resolved once per Run: the slug cannot change mid-Run, and the shutdown
// path must never stall resolving it again before a post. The lookup is
// cached as a promise, failure included, so a failed lookup is attempted
// exactly once too.
let slugLookup: Promise<string> | undefined;

export function repoSlug(): Promise<string> {
	slugLookup ??= git(["config", "--get", "remote.origin.url"]).then((url) =>
		url.replace(/^.*github\.com[/:]/, "").replace(/\.git$/, ""),
	);
	return slugLookup;
}

function isAuthFailure(text: string) {
	return /could not read username|terminal prompts disabled|permission denied|authentication|credential|403/i.test(
		text,
	);
}

export async function push(branch: string, noPush: boolean, sha: string) {
	if (noPush) return;
	console.error("pushing…");
	let remoteSha = "";
	try {
		remoteSha = await git(["ls-remote", "origin", `refs/heads/${branch}`]);
	} catch {
		/* push will provide the useful error */
	}
	if (remoteSha.split(/\s/)[0] === sha) {
		console.error(
			`${branch} already up to date on origin (${sha.slice(0, 7)})`,
		);
		return;
	}
	try {
		const upstream = await git([
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{u}",
		]).catch(() => "");
		await command(
			upstream ? ["git", "push"] : ["git", "push", "-u", "origin", branch],
		);
		console.error(`pushed ${branch} to origin (${sha.slice(0, 7)})`);
	} catch (error) {
		const text = commandStderr(error);
		if (isAuthFailure(text))
			throw new Error(
				"error: push to origin needs credentials; run gh auth setup-git, then local-ci",
			);
		if (/non-fast-forward|fetch first|rejected/i.test(text))
			throw new Error(
				`error: push of ${branch} rejected, origin has newer commits; run git pull --rebase, then local-ci`,
			);
		throw new Error(
			`error: push of ${branch} failed; run git push, then local-ci`,
		);
	}
}
