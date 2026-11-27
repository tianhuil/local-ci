import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { safeEnv } from "./proc.js";
// Checks currently running, so a SIGINT/SIGTERM handler can stop them
// before posting interrupted statuses and exiting.
const running = new Set();
const KILL_GRACE_MS = 100;
// Stops every running Check and resolves only once they are all gone:
// SIGTERM to each process group, SIGKILL to whatever survives the grace
// period (a Check may ignore SIGTERM), then wait for every exit.
export async function terminateRunningChecks() {
    const children = [...running];
    const exited = new Set();
    const closes = children.map((child) => new Promise((resolve) => {
        child.on("close", () => {
            exited.add(child);
            resolve();
        });
    }));
    for (const child of children) {
        try {
            if (child.pid)
                process.kill(-child.pid, "SIGTERM");
        }
        catch {
            /* already exited */
        }
    }
    await Promise.race([
        Promise.all(closes),
        new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS)),
    ]);
    for (const child of children) {
        if (exited.has(child))
            continue;
        try {
            if (child.pid)
                process.kill(-child.pid, "SIGKILL");
        }
        catch {
            /* already exited */
        }
    }
    await Promise.all(closes);
}
// Extracts `path` as committed at `sha` into `dir`: `git archive` of that
// tree piped into `tar`, so the copy holds only committed files, never
// untracked or ignored ones, and nothing from outside `path`.
function extractTree(root, sha, path, dir) {
    return new Promise((resolve, reject) => {
        const tree = path === "." ? sha : `${sha}:${path}`;
        const archive = spawn("git", ["archive", "--format=tar", tree], {
            cwd: root,
            env: safeEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const tar = spawn("tar", ["-x", "-C", dir], {
            stdio: ["pipe", "ignore", "pipe"],
        });
        let archiveError = "";
        let tarError = "";
        archive.stderr?.on("data", (data) => {
            archiveError += data.toString();
        });
        tar.stderr?.on("data", (data) => {
            tarError += data.toString();
        });
        archive.stdout?.pipe(tar.stdin);
        const closed = (child) => new Promise((done) => {
            child.on("error", () => done(1));
            child.on("close", (code) => done(code ?? 1));
        });
        Promise.all([closed(archive), closed(tar)]).then(([archiveCode, tarCode]) => {
            if (archiveCode !== 0)
                reject(new Error(`copy: ${path} is not a folder at ${sha.slice(0, 7)}; fix copy in local-ci.yml (${archiveError.trim() || `git archive exited ${archiveCode}`})`));
            else if (tarCode !== 0)
                reject(new Error(`copy: extracting ${path} failed (${tarError.trim() || `tar exited ${tarCode}`})`));
            else
                resolve();
        });
    });
}
// Runs a Check's command. Every Check gets LOCAL_CI_ROOT, the worktree's
// root. A Check with `copy` runs in a fresh temp directory holding only
// that folder at `sha`; the copy is deleted when the Check passes and kept,
// with its path at the end of the log, when it fails or times out.
export async function runCheck(check, root, sha = "HEAD") {
    const start = Date.now();
    console.error(`running ${check.name}…`);
    let cwd = root;
    let copyDir;
    if (check.copy !== undefined) {
        copyDir = await mkdtemp(join(tmpdir(), `local-ci-${check.name}-`));
        try {
            await extractTree(root, sha, check.copy, copyDir);
        }
        catch (error) {
            await rm(copyDir, { recursive: true, force: true });
            return {
                check,
                status: "failed",
                duration: Math.max(1, Math.round((Date.now() - start) / 1000)),
                code: 1,
                timedOut: false,
                log: `local-ci: ${error instanceof Error ? error.message : String(error)}\n`,
            };
        }
        cwd = copyDir;
    }
    const result = await spawnCheck(check, cwd, root, start);
    if (copyDir !== undefined) {
        if (result.status === "passed") {
            await rm(copyDir, { recursive: true, force: true });
        }
        else {
            const log = result.log ?? "";
            result.log = `${log}${log === "" || log.endsWith("\n") ? "" : "\n"}local-ci: copy of ${check.copy} kept in ${copyDir}\n`;
        }
    }
    return result;
}
function spawnCheck(check, cwd, root, start) {
    return new Promise((resolve) => {
        const child = spawn(check.command, {
            shell: true,
            cwd,
            env: { ...safeEnv, LOCAL_CI_ROOT: root },
            detached: true,
        });
        if (child.pid)
            running.add(child);
        let output = "";
        let settled = false;
        let timedOut = false;
        child.stdout?.on("data", (data) => {
            output += data.toString();
        });
        child.stderr?.on("data", (data) => {
            output += data.toString();
        });
        const finish = (timedOut, code) => {
            if (settled)
                return;
            settled = true;
            resolve({
                check,
                status: timedOut || code !== 0 ? "failed" : "passed",
                duration: Math.max(1, Math.round((Date.now() - start) / 1000)),
                code: timedOut ? undefined : code,
                timedOut,
                log: output,
            });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (child.pid)
                    process.kill(-child.pid, "SIGTERM");
            }
            catch {
                /* already exited */
            }
            setTimeout(() => {
                try {
                    if (child.pid)
                        process.kill(-child.pid, "SIGKILL");
                }
                catch {
                    /* already exited */
                }
                finish(true, 1);
            }, 100);
        }, check.timeout * 1000);
        child.on("close", (code) => {
            running.delete(child);
            clearTimeout(timer);
            finish(timedOut, code ?? 1);
        });
    });
}
