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
type Options = { force: boolean; noPush: boolean; jobs?: number };
type Check = { name: string; command: string; timeout: number };
type Result = { check: Check; status: 'passed'|'failed'|'skipped'; duration: number; code?: number; timedOut?: boolean; log?: string };
async function git(args: string[], cwd = process.cwd()) { return (await exec('git', args, { cwd, env: process.env })).stdout.trim(); }
async function command(args: string[], cwd = process.cwd()) { return exec(args[0], args.slice(1), { cwd, env: process.env }); }
function parseArgs(argv: string[]): Options {
  const o: Options = { force: false, noPush: false };
  for (let i=0;i<argv.length;i++) { const a=argv[i];
    if (a==='--force') o.force=true; else if (a==='--no-push') o.noPush=true; else if (a==='-j'||a==='--jobs') { const v=argv[++i]; if (!v || !/^\d+$/.test(v) || Number(v)<1) { console.error(`error: invalid value "${v ?? ''}" for --jobs; use a positive integer, such as --jobs 4`); process.exitCode=2; throw new Error('ARGUMENT_ERROR'); } o.jobs=Number(v); }
    else if (a==='-V'||a==='--version') { process.stdout.write(`${VERSION}\n`); process.exit(0); } else if (a==='-h'||a==='--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`error: unknown option ${a}; valid options: --force, --no-push, --jobs, --help, --version`); process.exitCode=2; throw new Error('ARGUMENT_ERROR'); }
    else { console.error(`error: unexpected argument "${a}"; local-ci takes no arguments`); process.exitCode=2; throw new Error('ARGUMENT_ERROR'); }
  } return o;
}
async function loadChecks(): Promise<{checks: Check[]; timeout:number}> {
  let raw: string; try { raw=await readFile('local-ci.yml','utf8'); } catch { throw new Error('error: local-ci.yml: could not read file'); }
  let doc: any; try { doc=YAML.parse(raw); } catch { throw new Error('error: local-ci.yml: invalid YAML'); }
  const timeout=doc?.timeout ?? 60; const entries=doc?.checks;
  if (!entries || typeof entries!=='object' || Array.isArray(entries)) throw new Error('error: local-ci.yml: checks must be a map');
  const checks: Check[]=[];
  for (const [name,value] of Object.entries(entries)) { const command=typeof value==='string'?value:(value as any)?.command; if (!command) throw new Error(`error: local-ci.yml: check "${name}" has no command; add one, e.g. ${name}: bun test`); const t=typeof value==='object'&&(value as any).timeout !== undefined ? (value as any).timeout:timeout; if (!Number.isFinite(t)||t<=0) throw new Error(`error: local-ci.yml: check "${name}" has invalid timeout`); checks.push({name,command,timeout:Number(t)}); }
  return {checks,timeout};
}
async function preflight(opts: Options) {
  const dirty=await git(['status','--porcelain']); if (dirty) { const files=dirty.split('\n').map(x=>x.slice(3)).join(', '); throw new Error(`error: ${dirty.split('\n').length} uncommitted changes (${files}); run git commit or git stash, then local-ci`); }
  const branch=await git(['branch','--show-current']); let def='main'; try { def=(await git(['symbolic-ref','--short','refs/remotes/origin/HEAD'])).replace('origin/',''); } catch {} if (branch===def) throw new Error(`error: on default branch ${def}; run git switch -c <branch>, then local-ci`);
  try { await command(['gh','auth','token']); } catch { throw new Error('error: no GitHub token; run gh auth login, then local-ci'); }
  const config=await loadChecks(); const sha=await git(['rev-parse','HEAD']);
  if (opts.noPush) { try { const remote=await git(['ls-remote','origin',sha]); if (!remote) throw new Error(); } catch { throw new Error(`error: ${sha.slice(0,7)} is not on GitHub; run local-ci without --no-push`); } }
  return { ...config, branch, sha };
}
async function push(branch:string, noPush:boolean, sha:string) {
  if (noPush) return;
  const upstream = await git(['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}']).catch(()=> '');
  try { if (!upstream) { await command(['git','push','-u','origin',branch]); } else { await command(['git','push']); } }
  catch (e:any) { const text=String(e?.stderr||''); if (/credential|authentication|password/i.test(text)) throw new Error('error: push to origin needs credentials; run gh auth setup-git, then local-ci'); throw new Error(`error: push of ${branch} rejected, origin has newer commits; run git pull --rebase, then local-ci`); }
  const now=await git(['rev-parse','HEAD']); if (now===sha) { if (upstream) console.error(`${branch} already up to date on origin (${sha.slice(0,7)})`); else console.error(`pushed ${branch} to origin (${sha.slice(0,7)})`); }
}
async function repoSlug() { const url=await git(['config','--get','remote.origin.url']); return url.replace(/^.*github\.com[/:]/,'').replace(/\.git$/,''); }
async function statuses(sha:string):Promise<Set<string>> { try { const s=await command(['gh','api',`repos/${await repoSlug()}/statuses/${sha}`]); const list=JSON.parse(s.stdout); return new Set(list.filter((x:any)=>x.state==='success').map((x:any)=>x.context)); } catch { return new Set(); } }
function runCheck(c:Check, root:string, logPath:string):Promise<Result> { return new Promise(resolve=> { const start=Date.now(); console.error(`running ${c.name}…`); const child=spawn(c.command,{shell:true,cwd:root,env:process.env}); let out=''; child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>out+=d); let timed=false; const timer=setTimeout(()=>{timed=true; child.kill('SIGTERM'); setTimeout(()=>child.kill('SIGKILL'),500);},c.timeout*1000); child.on('close',code=>{clearTimeout(timer); resolve({check:c,status:timed||code!==0?'failed':'passed',duration:Math.max(1,Math.round((Date.now()-start)/1000)),code:timed?undefined:code??1,timedOut:timed,log:out});}); }); }
async function main() { let opts:Options; try { opts=parseArgs(process.argv.slice(2)); const info=await preflight(opts); await push(info.branch,opts.noPush,info.sha); const passed=await statuses(info.sha); const results:Result[]=info.checks.map(c=>passed.has(`local-ci/${c.name}`)&&!opts.force?{check:c,status:'skipped',duration:0}:null).filter(Boolean) as Result[]; const pending=info.checks.filter(c=>!passed.has(`local-ci/${c.name}`)||opts.force); const root=process.cwd(), dir=join(root,'.git','local-ci','logs',info.sha.slice(0,7)); await mkdir(dir,{recursive:true}); const ran=await pMap(pending,c=>runCheck(c,root,join(dir,`${c.name}.log`)),{concurrency:opts.jobs??Number.POSITIVE_INFINITY}); for(const r of ran){await writeFile(join(dir,`${r.check.name}.log`),r.log??'');} const all=[...results,...ran].sort((a,b)=>info.checks.indexOf(a.check)-info.checks.indexOf(b.check)); if(!ran.length){console.log(`0 Checks run; all ${info.checks.length} already passed on ${info.sha.slice(0,7)}`); return;} for(const r of all){const pad=r.check.name.padEnd(Math.max(...info.checks.map(c=>c.name.length))); if(r.status==='skipped') console.log(`${pad}  skipped  already passed`); else console.log(`${pad}  ${r.status.padEnd(7)}  ${r.duration}s${r.status==='failed'?`  ${r.timedOut?'timeout':`exit ${r.code}`}`:''}`);}
  for(const r of ran.filter(x=>x.status==='failed')) { const log=r.log??''; if(log.length>1500) console.log(`\n${r.check.name} output (last 1,500 of ${log.length} chars):\n${log.slice(-1500)}`); else console.log(`\n${r.check.name} output:\n${log}`); console.log(`full log: .git/local-ci/logs/${info.sha.slice(0,7)}/${r.check.name}.log`); }
  let failures=0; for(const r of ran){const state=r.status==='passed'?'success':'failure'; const desc=r.status==='passed'?`passed in ${r.duration}s`:`failed in ${r.duration}s (${r.timedOut?'timeout':`exit ${r.code}`})`; try { await command(['gh','api',`repos/${await repoSlug()}/statuses/${info.sha}`,'-f',`state=${state}`,'-f',`context=local-ci/${r.check.name}`,'-f',`description=${desc}`]); } catch { failures++; }} failures=ran.filter(r=>r.status==='failed').length; console.log(`\nposted ${ran.length} Commit Status${ran.length===1?'':'es'} to ${info.sha.slice(0,7)}; ${failures?`${failures} of ${info.checks.length} Checks failed`:`all ${info.checks.length} Checks passed`}`); if(failures) process.exitCode=1;
 } catch(e:any) { if(e.message!=='ARGUMENT_ERROR'){console.error(e.message); process.exitCode=1;} } }
export { main };
