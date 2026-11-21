import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import pMap from 'p-map';
import YAML from 'yaml';
const exec = promisify(execFile);
const VERSION = '0.1.0';
const HELP = `Usage: local-ci [options]\n\nPush the current branch, run every Check in local-ci.yml, and post one\nCommit Status (local-ci/<check>) per Check to the pushed commit on GitHub.\nPrints one line per Check; full logs go to .git/local-ci/logs/<sha>/.\n\nOptions:\n  --force          run every Check, even ones that already passed on this\n                   commit (default: skip them)\n  --no-push        don't push; HEAD must already be on GitHub (default: push)\n  -j, --jobs <N>   run up to N Checks at once (default: all Checks at once)\n  -V, --version    print the version\n  -h, --help       print this help\n\nExamples:\n  local-ci                 run after each commit\n  local-ci --force         re-run everything, e.g. to rule out a flaky pass\n  local-ci --no-push       the commit was already pushed some other way\n  local-ci --jobs 1        run Checks one at a time, e.g. if they conflict\n\nExit codes:\n  0  every Check passed or had already passed\n  1  a Check failed, or the Run could not start (see the error line)\n  2  unknown option or argument\n`;
const safeEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' };
async function git(args, cwd = process.cwd()) {
    return (await exec('git', args, { cwd, env: safeEnv })).stdout.trimEnd();
}
async function command(args, cwd = process.cwd()) { return exec(args[0], args.slice(1), { cwd, env: safeEnv }); }
function parseArgs(argv) {
    const options = { force: false, noPush: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--force')
            options.force = true;
        else if (arg === '--no-push')
            options.noPush = true;
        else if (arg === '-j' || arg === '--jobs') {
            const value = argv[++i];
            if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
                console.error(`error: invalid value "${value ?? ''}" for --jobs; use a positive integer, such as --jobs 4`);
                process.exitCode = 2;
                throw new Error('ARGUMENT_ERROR');
            }
            options.jobs = Number(value);
        }
        else if (arg === '-V' || arg === '--version') {
            process.stdout.write(`${VERSION}\n`);
            process.exit(0);
        }
        else if (arg === '-h' || arg === '--help') {
            process.stdout.write(HELP);
            process.exit(0);
        }
        else if (arg.startsWith('-')) {
            console.error(`error: unknown option ${arg}; valid options: --force, --no-push, --jobs, --help, --version`);
            process.exitCode = 2;
            throw new Error('ARGUMENT_ERROR');
        }
        else {
            console.error(`error: unexpected argument "${arg}"; local-ci takes no arguments`);
            process.exitCode = 2;
            throw new Error('ARGUMENT_ERROR');
        }
    }
    return options;
}
function positiveNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
async function loadChecks() {
    let doc;
    try {
        doc = YAML.parse(await readFile('local-ci.yml', 'utf8'));
    }
    catch {
        throw new Error('error: local-ci.yml: invalid YAML');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
        throw new Error('error: local-ci.yml: checks must be a map');
    const top = doc;
    const timeout = top.timeout === undefined ? 60 : top.timeout;
    if (!positiveNumber(timeout))
        throw new Error('error: local-ci.yml: timeout must be a positive number');
    const entries = top.checks;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0)
        throw new Error('error: local-ci.yml: checks must be a non-empty map');
    const checks = [];
    for (const [name, raw] of Object.entries(entries)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..'))
            throw new Error(`error: local-ci.yml: check "${name}" has invalid name; use letters, numbers, ., _, or -`);
        const objectValue = typeof raw === 'object' && raw !== null ? raw : undefined;
        const checkCommand = typeof raw === 'string' ? raw : objectValue?.command;
        if (typeof checkCommand !== 'string' || checkCommand.trim() === '')
            throw new Error(`error: local-ci.yml: check "${name}" has no command; add one, e.g. ${name}: bun test`);
        const checkTimeout = objectValue?.timeout === undefined ? timeout : objectValue.timeout;
        if (!positiveNumber(checkTimeout))
            throw new Error(`error: local-ci.yml: check "${name}" has invalid timeout`);
        checks.push({ name, command: checkCommand, timeout: checkTimeout });
    }
    return { checks };
}
async function resolveGitDir(cwd = process.cwd()) { return git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd); }
async function repoSlug() {
    const url = await git(['config', '--get', 'remote.origin.url']);
    return url.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '');
}
async function preflight(options) {
    const dirty = await git(['status', '--porcelain']);
    if (dirty) {
        const files = dirty.split('\n').map((line) => line.slice(3)).join(', ');
        throw new Error(`error: ${dirty.split('\n').length} uncommitted changes (${files}); run git commit or git stash, then local-ci`);
    }
    const branch = await git(['branch', '--show-current']);
    let defaultBranch = 'main';
    try {
        defaultBranch = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace('origin/', '');
    }
    catch { /* no remote HEAD */ }
    if (branch === defaultBranch)
        throw new Error(`error: on default branch ${defaultBranch}; run git switch -c <branch>, then local-ci`);
    try {
        await command(['gh', 'auth', 'token']);
    }
    catch {
        throw new Error('error: no GitHub token; run gh auth login, then local-ci');
    }
    const config = await loadChecks();
    const sha = await git(['rev-parse', 'HEAD']);
    if (options.noPush) {
        try {
            await command(['gh', 'api', `repos/${await repoSlug()}/commits/${sha}`]);
        }
        catch {
            throw new Error(`error: ${sha.slice(0, 7)} is not on GitHub; run local-ci without --no-push`);
        }
    }
    return { ...config, branch, sha };
}
function isAuthFailure(text) { return /could not read username|terminal prompts disabled|permission denied|authentication|credential|403/i.test(text); }
async function push(branch, noPush, sha) {
    if (noPush)
        return;
    console.error('pushing…');
    let remoteSha = '';
    try {
        remoteSha = await git(['ls-remote', 'origin', `refs/heads/${branch}`]);
    }
    catch { /* push will provide the useful error */ }
    if (remoteSha.split(/\s/)[0] === sha) {
        console.error(`${branch} already up to date on origin (${sha.slice(0, 7)})`);
        return;
    }
    try {
        const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
        await command(upstream ? ['git', 'push'] : ['git', 'push', '-u', 'origin', branch]);
        console.error(`pushed ${branch} to origin (${sha.slice(0, 7)})`);
    }
    catch (error) {
        const text = String(error.stderr ?? error);
        if (isAuthFailure(text))
            throw new Error('error: push to origin needs credentials; run gh auth setup-git, then local-ci');
        if (/non-fast-forward|fetch first|rejected/i.test(text))
            throw new Error(`error: push of ${branch} rejected, origin has newer commits; run git pull --rebase, then local-ci`);
        throw new Error(`error: push of ${branch} failed; run git push, then local-ci`);
    }
}
async function statuses(sha) {
    try {
        const response = await command(['gh', 'api', `repos/${await repoSlug()}/statuses/${sha}`]);
        const list = JSON.parse(response.stdout);
        if (!Array.isArray(list))
            return new Set();
        return new Set(list.filter((item) => !!item && typeof item === 'object' && item.state === 'success' && typeof item.context === 'string').map((item) => item.context));
    }
    catch {
        return new Set();
    }
}
export function runCheck(check, root) {
    return new Promise((resolve) => {
        const start = Date.now();
        console.error(`running ${check.name}…`);
        const child = spawn(check.command, { shell: true, cwd: root, env: safeEnv, detached: true });
        let output = '';
        let settled = false;
        let timedOut = false;
        child.stdout?.on('data', (data) => { output += data.toString(); });
        child.stderr?.on('data', (data) => { output += data.toString(); });
        const finish = (timedOut, code) => {
            if (settled)
                return;
            settled = true;
            resolve({ check, status: timedOut || code !== 0 ? 'failed' : 'passed', duration: Math.max(1, Math.round((Date.now() - start) / 1000)), code: timedOut ? undefined : code, timedOut, log: output });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (child.pid)
                    process.kill(-child.pid, 'SIGTERM');
            }
            catch { /* already exited */ }
            setTimeout(() => { try {
                if (child.pid)
                    process.kill(-child.pid, 'SIGKILL');
            }
            catch { /* already exited */ } finish(true, 1); }, 100);
        }, check.timeout * 1000);
        child.on('close', (code) => { clearTimeout(timer); finish(timedOut, code ?? 1); });
    });
}
export async function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        const info = await preflight(options);
        await push(info.branch, options.noPush, info.sha);
        const passed = await statuses(info.sha);
        const skipped = info.checks.filter((check) => passed.has(`local-ci/${check.name}`) && !options.force).map((check) => ({ check, status: 'skipped', duration: 0 }));
        const pending = info.checks.filter((check) => !passed.has(`local-ci/${check.name}`) || options.force);
        const gitDir = await resolveGitDir();
        const logDir = join(gitDir, 'local-ci', 'logs', info.sha.slice(0, 7));
        await mkdir(logDir, { recursive: true });
        const ran = await pMap(pending, (check) => runCheck(check, process.cwd()), { concurrency: options.jobs ?? Number.POSITIVE_INFINITY });
        for (const result of ran)
            await writeFile(join(logDir, `${result.check.name}.log`), result.log ?? '');
        const all = [...skipped, ...ran].sort((a, b) => info.checks.indexOf(a.check) - info.checks.indexOf(b.check));
        if (!ran.length) {
            console.log(`0 Checks run; all ${info.checks.length} already passed on ${info.sha.slice(0, 7)}`);
            return;
        }
        const width = Math.max(...info.checks.map((check) => check.name.length));
        for (const result of all) {
            const name = result.check.name.padEnd(width);
            if (result.status === 'skipped')
                console.log(`${name}  skipped  already passed`);
            else
                console.log(`${name}  ${result.status.padEnd(7)}  ${result.duration}s${result.status === 'failed' ? `  ${result.timedOut ? 'timeout' : `exit ${result.code}`}` : ''}`);
        }
        for (const result of ran.filter((item) => item.status === 'failed')) {
            const log = result.log ?? '';
            if (log.length > 1500)
                console.log(`\n${result.check.name} output (last 1,500 of ${log.length} chars):\n${log.slice(-1500)}`);
            else
                console.log(`\n${result.check.name} output:\n${log}`);
            console.log(`full log: .git/local-ci/logs/${info.sha.slice(0, 7)}/${result.check.name}.log`);
        }
        let posted = 0;
        const checkFailures = ran.filter((result) => result.status === 'failed').length;
        let postFailures = 0;
        for (const result of ran) {
            const state = result.status === 'passed' ? 'success' : 'failure';
            const description = result.status === 'passed' ? `passed in ${result.duration}s` : `failed in ${result.duration}s (${result.timedOut ? 'timeout' : `exit ${result.code}`})`;
            const context = `local-ci/${result.check.name}`;
            try {
                await command(['gh', 'api', `repos/${await repoSlug()}/statuses/${info.sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`]);
                posted += 1;
            }
            catch {
                console.error(`error: failed to post Commit Status ${context} to GitHub; run gh auth login, then local-ci`);
                postFailures += 1;
            }
        }
        if (posted > 0)
            console.log(`\nposted ${posted} Commit Status${posted === 1 ? '' : 'es'} to ${info.sha.slice(0, 7)}; ${checkFailures ? `${checkFailures} of ${info.checks.length} Checks failed` : `all ${info.checks.length} Checks passed`}`);
        if (checkFailures || postFailures)
            process.exitCode = 1;
    }
    catch (error) {
        if (error.message !== 'ARGUMENT_ERROR') {
            console.error(error.message);
            process.exitCode = 1;
        }
    }
}
export { resolveGitDir };
