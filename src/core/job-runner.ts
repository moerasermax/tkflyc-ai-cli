/** Detached runner：worker 的父行程，fd 直寫 log，唯一一次落 meta 與 exit。 */
import { spawn, execFile } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { atomicJson, readJobExit, sameIdentity, mayBeAlive, type RunnerSpec, type JobExit } from './job-store.js';
import { lookupIdentities, type ProcessIdentity, type IdentityLookup } from './live-jobs.js';

import { identityOnly } from './principal.js';

/** 身分查詢暫時失敗可重試；只有不同建立時間才永久停止。 */
export function verifiedTermination(worker: ProcessIdentity, lookup: IdentityLookup, send: () => Promise<boolean>, alive = mayBeAlive) {
  let active: Promise<boolean> | undefined, gone = false;
  return (): Promise<boolean> => {
    if (gone) return Promise.resolve(false);
    if (active) return active;
    active = (async () => {
      const current = (await lookup([worker.pid])).get(worker.pid);
      if (!sameIdentity(worker, current)) { gone = !!current || !alive(worker.pid); return false; }
      return send();
    })().finally(() => { active = undefined; });
    return active;
  };
}
interface RunnerOptions { lookup?: IdentityLookup; save?: typeof atomicJson; pause?: (ms: number) => Promise<void> }
export async function runJob(directory: string, options: RunnerOptions = {}): Promise<void> {
  const lookup = options.lookup ?? lookupIdentities, save = options.save ?? atomicJson;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const remove = (file: string) => { try { rmSync(join(directory, file), { force: true }); } catch (error) { console.error('ai-cli runner cleanup:', error); } };
  const spec: RunnerSpec = JSON.parse(readFileSync(join(directory, 'launch.tmp'), 'utf8'));
  rmSync(join(directory, 'launch.tmp'), { force: true });
  let ids = new Map<number, ProcessIdentity>();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await pause(250 * 2 ** (attempt - 1));
    try { ids = await lookup([process.pid, spec.serverPid, spec.principalPid]); } catch (error) { console.error('ai-cli runner identity:', error); }
    if (ids.get(process.pid)?.started) break;
  }
  const runner = ids.get(process.pid)?.started ? identityOnly(ids.get(process.pid)!) : { pid: process.pid, started: '', name: 'node' };
  const fail = (message: string, worker: ProcessIdentity | null = null) => {
    console.error(message);
    try { writeSync(openFailureLog(), `Process error: ${message}\n`); } catch { /* 磁碟失敗仍盡力寫結果。 */ }
    try { save(join(directory, 'meta.json'), { ...spec.meta, pid: process.pid, runner, worker }); } catch (error) { console.error('ai-cli runner metadata:', error); }
    try { save(join(directory, 'exit.json'), { exitCode: 1, signal: null, endTime: new Date().toISOString(), timedOut: false, killed: false, error: message }); } catch (error) { console.error('ai-cli runner exit:', error); }
    remove('stdin.tmp');
  };
  let failureFd: number | undefined;
  const openFailureLog = () => failureFd ??= openSync(join(directory, 'stderr.log'), 'a', 0o600);
  if (!runner.started) { fail('Cannot identify runner after 3 attempts; worker was not started'); if (failureFd !== undefined) closeSync(failureFd); return; }
  const stdout = openSync(join(directory, 'stdout.log'), 'a', 0o600);
  const stderr = openSync(join(directory, 'stderr.log'), 'a', 0o600);
  const stdin = spec.stdin ? openSync(join(directory, 'stdin.tmp'), 'r') : undefined;
  let child: ReturnType<typeof spawn>;
  try {
    const command = spec.needsShell ? process.env.ComSpec || process.env.COMSPEC || 'cmd.exe' : spec.command;
    const args = spec.needsShell ? ['/d', '/s', '/c', `""${spec.command}" ${spec.args.map(a => /[\s&|<>^()]/.test(a) ? `"${a}"` : a).join(' ')}"`] : spec.args;
    child = spawn(command, args, { cwd: spec.cwd, stdio: [stdin ?? 'ignore', stdout, stderr],
      shell: false, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: spec.needsShell });
  } catch (error) {
    fail(`Worker spawn failed: ${(error as Error).message}`);
    if (failureFd !== undefined) closeSync(failureFd);
    closeSync(stderr);
    rmSync(join(directory, 'stdin.tmp'), { force: true });
    return;
  } finally { if (stdin !== undefined) closeSync(stdin); closeSync(stdout); }
  // runner 不保留 prompt、指令參數；只在 launch.tmp 中存到讀完為止。
  spec.args = [];
  let killed = false, timedOut = false, terminating = false, worker: ProcessIdentity | null = null;
  let interval: NodeJS.Timeout | undefined, timeout: NodeJS.Timeout | undefined;
  let resolveClose!: (exit: { code: number | null; signal: string | null }) => void;
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => { resolveClose = resolve; });
  child.once('error', error => { writeSync(stderr, `Process error: ${error.message}\n`); resolveClose({ code: 1, signal: null }); });
  child.once('close', (code, signal) => resolveClose({ code, signal }));
  if (child.pid) { try { worker = (await lookup([child.pid])).get(child.pid) ?? null; } catch (error) { console.error('ai-cli worker identity:', error); } }
  if (worker) worker = identityOnly(worker);
  const meta = { ...spec.meta, pid: process.pid, runner, worker,
    server: spec.meta.server ?? (ids.get(spec.serverPid) ? identityOnly(ids.get(spec.serverPid)!) : null), principal: spec.meta.principal };
  try { save(join(directory, 'meta.json'), meta); }
  catch (error) {
    // child 是本 runner 剛 spawn 的 handle；meta 無法落盤就終止，避免無人追蹤的執行。
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') { try { await promisify(execFile)('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }); } catch { child.kill('SIGKILL'); } }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }
    await closed;
    fail(`Cannot persist worker metadata: ${(error as Error).message}`, worker);
    if (failureFd !== undefined) closeSync(failureFd);
    closeSync(stderr); return;
  }
  let termination: Promise<void> | undefined;
  const send = async (): Promise<boolean> => {
    if (!worker) return false;
    if (process.platform === 'win32') {
      try { await promisify(execFile)('taskkill.exe', ['/pid', String(worker.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }); return true; } catch { return false; }
    } else {
      // 子孫可能自行 detached 而離開 process group；先快照 PPID 樹並核對 OS 身分。
      const { stdout: tree } = await promisify(execFile)('ps', ['-e', '-o', 'pid=,ppid='], { timeout: 5000 }).catch(error => {
        writeSync(stderr, `Tree lookup failed: ${error.message}; terminating verified process group\n`);
        return { stdout: '' };
      });
      const rows = tree.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const descendants: number[] = [];
      const visit = (parent: number) => { for (const [pid, ppid] of rows) if (ppid === parent && pid !== parent && !descendants.includes(pid)) { descendants.push(pid); visit(pid); } };
      visit(worker.pid);
      const snapshot = await lookup([worker.pid, ...descendants]);
      if (!sameIdentity(worker, snapshot.get(worker.pid))) return false;
      const verified = await lookup([worker.pid, ...descendants]);
      if (!sameIdentity(worker, verified.get(worker.pid))) return false;
      let sent = false;
      for (const pid of descendants.reverse()) if (sameIdentity(snapshot.get(pid), verified.get(pid))) {
        try { process.kill(pid, 'SIGKILL'); sent = true; } catch { /* 已退出。 */ }
      }
      // 已核對 group leader；一次終止自己的整個 group，避免 leader 先退出後
      // 忽略 SIGTERM 的孫行程失去可驗證的 leader 而逃過 escalation。
      try { process.kill(-worker.pid, 'SIGKILL'); sent = true; } catch { /* 已退出。 */ }
      return sent;
    }
  };
  const requestTermination = worker ? verifiedTermination(worker, lookup, send) : undefined;
  const terminate = (byTimeout = false): Promise<void> => {
    if (terminating) return termination ?? Promise.resolve();
    terminating = true;
    termination = (async () => {
      if (await requestTermination?.()) { timedOut = byTimeout; killed = !byTimeout; }
    })().catch(error => { writeSync(stderr, `Termination failed: ${error.message}\n`); }).finally(() => { terminating = false; });
    return termination;
  };
  const timeoutAt = spec.timeoutMs === undefined ? Infinity : Date.now() + spec.timeoutMs;
  const onTerm = () => { void terminate(); };
  process.on('SIGTERM', onTerm); process.on('SIGINT', onTerm);
  interval = setInterval(() => {
    if (Date.now() >= timeoutAt && !timedOut && !killed) void terminate(true);
    let request: any; try { request = JSON.parse(readFileSync(join(directory, 'kill.json'), 'utf8')); } catch { return; }
    if (sameIdentity(request.runner, runner)) void terminate();
  }, 100);
  if (spec.timeoutMs !== undefined) timeout = setTimeout(() => { void terminate(true); }, spec.timeoutMs);
  const exit = await closed;
  await termination;
  if (interval) clearInterval(interval); if (timeout) clearTimeout(timeout);
  process.off('SIGTERM', onTerm); process.off('SIGINT', onTerm);
  closeSync(stderr);
  const report: JobExit = { exitCode: exit.code, signal: exit.signal, endTime: new Date().toISOString(), timedOut, killed };
  if (!readJobExit(directory)) save(join(directory, 'exit.json'), report);
  for (const file of ['stdin.tmp', 'kill.json']) rmSync(join(directory, file), { force: true });
}
// 僅 runner 入口執行；其他模組不 import 本檔。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runJob(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
