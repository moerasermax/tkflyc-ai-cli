/** Detached runner：worker 的父行程，fd 直寫 log，唯一一次落 meta 與 exit。 */
import { spawn, execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { atomicJson, recordJobFailure as recordRunnerFailure, readJobExit, sameIdentity, mayBeAlive, type RunnerSpec, type JobExit } from './job-store.js';
import { lookupIdentities, type ProcessIdentity, type IdentityLookup } from './live-jobs.js';

import { identityOnly } from './principal.js';
import { loadPtyModule, releaseExitedPty, stopOwnedPty } from './pty-runner.js';
import { createAnsiCleaner } from './ansi.js';
import { startTreeTracker, TREE_SCAN_MS, type ProcessTable } from './process-tree.js';
import { WinJobClient, lookupNativeIdentities } from './win-job-client.js';
import { saveContainmentRef, findContainmentRef, readContainment, markContainmentIntent } from './containment-store.js';

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
interface RunnerOptions { lookup?: IdentityLookup; save?: typeof atomicJson; pause?: (ms: number) => Promise<void>; cleaner?: ReturnType<typeof createAnsiCleaner>; waitForLauncher?: boolean; launcherWaitMs?: number;
  /** 子孫追蹤用的程序表與掃描間隔；測試注入。 */
  table?: ProcessTable; treeIntervalMs?: number }
/** 掃描間隔可用 AI_CLI_TREE_SCAN_MS 調整（毫秒，500～60000）；不合法就用預設。 */
function treeScanInterval(): number {
  const value = Number(process.env.AI_CLI_TREE_SCAN_MS);
  return Number.isFinite(value) && value >= 500 && value <= 60000 ? value : TREE_SCAN_MS;
}
export async function runJob(directory: string, options: RunnerOptions = {}): Promise<void> {
  // launch.tmp 含指令參數與 prompt：等待期間保留給清理掃描判斷 serverPid，任何離開路徑都刪除。
  try { return await execute(directory, options); }
  catch(error) {
    recordRunnerFailure(directory, `Runner failed: ${(error as Error).message}`);
    const ref=process.platform==='win32'?findContainmentRef(dirname(dirname(directory)),basename(directory)):undefined;
    if(ref) {
      const status=await new WinJobClient().terminate(ref).catch(()=>({state:'unknown'}));
      if(status.state!=='drained')try { atomicJson(join(directory,'containment-status.json'),{state:'unknown',reason:'outer runner failure termination unconfirmed'}); } catch(e) { console.error('ai-cli runner containment status:',e); }
    }
    throw error;
  }
  finally {
    const ref=process.platform==='win32'?findContainmentRef(dirname(dirname(directory)),basename(directory)):undefined;
    if(ref&&['preparing','assigned'].includes(readContainment(ref)?.phase??''))await new WinJobClient().terminate(ref).catch(()=>undefined);
    try { rmSync(join(directory, 'launch.tmp'), { force: true }); } catch (error) { console.error('ai-cli runner cleanup:', error); }
  }
}
async function execute(directory: string, options: RunnerOptions): Promise<void> {
  const lookup = options.lookup ?? (process.platform === 'win32' ? lookupNativeIdentities : lookupIdentities), save = options.save ?? atomicJson;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const remove = (file: string) => { try { rmSync(join(directory, file), { force: true }); } catch (error) { console.error('ai-cli runner cleanup:', error); } };
  const spec: RunnerSpec = JSON.parse(readFileSync(join(directory, 'launch.tmp'), 'utf8'));
  if(process.platform==='win32'){markContainmentIntent(dirname(dirname(directory)),spec.meta.jobId);spec.meta.containmentProtocol=1;}
  if (!options.waitForLauncher) rmSync(join(directory, 'launch.tmp'), { force: true });
  let ids = new Map<number, ProcessIdentity>();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await pause(250 * 2 ** (attempt - 1));
    try { ids = await lookup([process.pid, spec.serverPid, spec.principalPid]); } catch (error) { console.error('ai-cli runner identity:', error); }
    if (ids.get(process.pid)?.started) break;
  }
  const runner = ids.get(process.pid)?.started ? identityOnly(ids.get(process.pid)!) : { pid: process.pid, started: '', name: 'node' };
  const fail = (message: string, worker: ProcessIdentity | null = null) => {
    console.error(message);
    recordRunnerFailure(directory, message);
    try { save(join(directory, 'meta.json'), { ...spec.meta, pid: process.pid, runner, worker }); } catch (error) { console.error('ai-cli runner metadata:', error); }
    try { if(!readJobExit(directory))save(join(directory, 'exit.json'), { exitCode: 1, signal: null, endTime: new Date().toISOString(), timedOut: false, killed: false, error: message }); } catch (error) { console.error('ai-cli runner exit:', error); }
    remove('stdin.tmp');
  };
  // 僅新 launcher 使用；舊 server 直接啟動 job-runner.js <dir> 不等待確認。
  if (options.waitForLauncher) {
    let activation: { pid?: number } | undefined, cancelled = false;
    try {
      const deadline = Date.now() + (options.launcherWaitMs ?? 10000);
      while (!existsSync(join(directory, 'launcher.ready')) && !readJobExit(directory) && Date.now() < deadline) await pause(25);
      cancelled = !!readJobExit(directory);
      if (!cancelled) try { activation = JSON.parse(readFileSync(join(directory, 'launcher.ready'), 'utf8')); } catch { /* 缺失／損壞都明確失敗。 */ }
    } catch (error) { console.error('ai-cli runner launcher wait:', error); }
    remove('launcher.ready'); remove('launch.tmp');
    if (cancelled) { remove('stdin.tmp'); return; }
    if (activation?.pid !== process.pid) { fail('Runner launcher activation timed out or returned invalid PID; worker was not started'); return; }
  }
  if (!runner.started) { fail('Cannot identify runner after 3 attempts; worker was not started'); return; }
  if (spec.pty && spec.stdin) { fail('PTY jobs do not support stdinPrompt'); return; }
  if (process.platform === 'win32') {
    try {
      if (!spec.meta.containment) {
        // 舊 server 仍可能寫舊 spec。新版 runner 自行補建意圖，之後才可取得 READY；
        // 不是退回無 containment。舊 server 的 kill.json 仍走同一終止通道。
        spec.meta.containment = await new WinJobClient().prepare(spec.meta.jobId, directory);
        saveContainmentRef(dirname(dirname(directory)), spec.meta.containment);
        save(join(directory, 'hold.json'), { containment: spec.meta.containment });
      }
      await new WinJobClient().register(spec.meta.containment);
    } catch (error) { fail(`Containment READY failed; worker was not started: ${(error as Error).message}`);if(spec.meta.containment)await new WinJobClient().terminate(spec.meta.containment).catch(()=>undefined); return; }
  }
  const stdout = openSync(join(directory, 'stdout.log'), 'a', 0o600);
  const stderr = openSync(join(directory, 'stderr.log'), 'a', 0o600);
  const stdin = spec.stdin ? openSync(join(directory, 'stdin.tmp'), 'r') : undefined;
  let child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean };
  let pipeChild: ReturnType<typeof spawn> | undefined;
  let ptyProc: any;
  let ended = false, outputFailed = false, ptyOutput = false;
  const reportPtyError = (message: string, error: unknown) => {
    const detail = `${message}: ${(error as Error).message}\n`;
    try { writeSync(stderr, detail); } catch { console.error(detail); }
  };
  let killed = false, timedOut = false, terminating = false, worker: ProcessIdentity | null = null;
  let resolveClose!: (exit: { code: number | null; signal: string | null }) => void;
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => { resolveClose = resolve; });
  const cleaner = options.cleaner ?? createAnsiCleaner();
  // 啟動 worker 之前取：查不到 worker 的啟動時間時，子孫追蹤拿它當出生時間的下限。
  const spawnedAfter = Date.now();
  try {
    if (spec.pty) {
      // JobStore 已以 buildWorkerEnv 啟動 runner，直接繼承；ConPTY 不經 cmd.exe。
      ptyProc = loadPtyModule().spawn(spec.command, spec.args, {
        name: 'xterm-color', cols: 200, rows: 50, cwd: spec.cwd, env: process.env,
      });
      if (!ptyProc.pid) throw new Error('pty.spawn returned no pid');
      child = { pid: ptyProc.pid, exitCode: null, signalCode: null, kill: () => stopOwnedPty(ptyProc) };
      ptyProc.onData((data: string) => {
        if (ended) return; // stdout 可能已關閉並被 exit.json 暫存檔重用。
        // 清掉 ANSI 後還有文字才算輸出；ConPTY 的初始化控制碼不算，寫入失敗也不改變判定。
        try { const text = cleaner.push(data); if (text) { ptyOutput = true; writeSync(stdout, text); } }
        catch (error) {
          if (!outputFailed) { outputFailed = true; reportPtyError('PTY stdout write failed', error); }
        }
      });
      ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
        if (ended) return;
        ended = true;
        child.exitCode = exitCode;
        try {
          try { const text = cleaner.flush(); if (text) { ptyOutput = true; writeSync(stdout, text); } }
          catch (error) { reportPtyError('PTY stdout flush failed', error); }
          try {
            releaseExitedPty(ptyProc);
          } catch (error) { reportPtyError('PTY resource release failed', error); }
        } finally { resolveClose({ code: exitCode, signal: null }); }
      });
    } else {
      const command = spec.needsShell ? process.env.ComSpec || process.env.COMSPEC || 'cmd.exe' : spec.command;
      const args = spec.needsShell ? ['/d', '/s', '/c', `""${spec.command}" ${spec.args.map(a => /[\s&|<>^()]/.test(a) ? `"${a}"` : a).join(' ')}"`] : spec.args;
      child = pipeChild = spawn(command, args, { cwd: spec.cwd, stdio: [stdin ?? 'ignore', stdout, stderr],
        // 必須在 READY 之後才第一次使用非 detached spawn：libuv 的 silent-breakaway
        // 子 job 位於 broker job 內層，後代可離開內層但不能離開 broker。cmd 需要正常
        // console/stdio；DETACHED_PROCESS 會讓其轉交給 CLI 的標準輸入輸出失效。
        shell: false, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: spec.needsShell });
      pipeChild.once('exit', () => { ended = true; });
      pipeChild.once('error', error => { ended = true; writeSync(stderr, `Process error: ${error.message}\n`); resolveClose({ code: 1, signal: null }); });
      pipeChild.once('close', (code, signal) => { ended = true; resolveClose({ code, signal }); });
    }
  } catch (error) {
    fail(`Worker spawn failed: ${(error as Error).message}`);

    closeSync(stderr);
    closeSync(stdout);
    rmSync(join(directory, 'stdin.tmp'), { force: true });
    return;
  } finally { if (stdin !== undefined) closeSync(stdin); if (pipeChild) closeSync(stdout); }
  // runner 不保留 prompt、指令參數；只在 launch.tmp 中存到讀完為止。
  spec.args = [];
  let interval: NodeJS.Timeout | undefined, timeout: NodeJS.Timeout | undefined;
  if (child.pid) { try { worker = (await lookup([child.pid])).get(child.pid) ?? null; } catch (error) { console.error('ai-cli worker identity:', error); } }
  if (worker) worker = identityOnly(worker);
  // tree: 1 表示這個 runner 會追蹤子孫（tree.json）。舊 runner 啟動的 job 沒有這一格，讀端照舊只看 runner 與 worker。
  const meta = { ...spec.meta, pid: process.pid, runner, worker, ...(child.pid && process.platform !== 'win32' ? { tree: 1 as const } : {}),
    server: spec.meta.server ?? (ids.get(spec.serverPid) ? identityOnly(ids.get(spec.serverPid)!) : null), principal: spec.meta.principal };
  try { save(join(directory, 'meta.json'), meta); }
  catch (error) {
    if (process.platform === 'win32' && spec.meta.containment) {
      // Whole-job termination also stops this runner. Persist the failure first;
      // this is an execution result, not proof that containment has drained.
      fail(`Cannot persist worker metadata: ${(error as Error).message}`, worker);
      await new WinJobClient().terminate(spec.meta.containment);
      return;
    }
    // child 是本 runner 剛 spawn 的 handle；meta 無法落盤就終止，避免無人追蹤的執行。
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await closed;
    fail(`Cannot persist worker metadata: ${(error as Error).message}`, worker);

    if (spec.pty) closeSync(stdout);
    closeSync(stderr); return;
  }
  // 只在 worker 活著時定期列舉；列舉或寫檔失敗都不影響 job。
  const tracker = child.pid && process.platform !== 'win32' ? startTreeTracker({ directory, pid: child.pid, identity: worker, since: spawnedAfter,
    alive: () => child.exitCode === null && child.signalCode === null, intervalMs: options.treeIntervalMs ?? treeScanInterval(),
    ...(options.table ? { table: options.table } : {}), save, lookup }) : undefined;
  let termination: Promise<void> | undefined;
  let terminationAttempts=0,nextTerminationAt=0,terminationUnknown=false,directTerminationSent=false;
  let terminationByTimeout: boolean | undefined;
  const send = async (): Promise<boolean> => {
    if (!worker) return false;
    if (process.platform === 'win32') {
      return false; // Windows terminate 直接走 broker，沒有 PID／taskkill fallback。
    } else {
      // The detached POSIX leader is still held by this runner; while it has
      // not exited, its process group cannot have been reused.
      const count = await tracker?.killRecorded() ?? 0;
      const current = (await lookup([worker.pid])).get(worker.pid);
      if (!sameIdentity(worker, current)) return count > 0;
      if(pipeChild&&pipeChild.exitCode===null&&pipeChild.signalCode===null) {
        try { process.kill(-worker.pid,'SIGKILL');return true; }catch { /* use held direct child */ }
      }
      try { child.kill('SIGKILL'); return true; } catch { return count > 0; }
    }
  };
  const requestTermination = worker ? verifiedTermination(worker, lookup, send) : undefined;
  const terminate = (byTimeout = false): Promise<void> => {
    // Once the child has closed, only finish a cancellation already in flight.
    // A late signal must not turn a natural exit into a new cancellation.
    if(process.platform==='win32'&&ended&&terminationAttempts===0)return Promise.resolve();
    if (terminating) return termination ?? Promise.resolve();
    if(process.platform==='win32'&&(terminationAttempts>=3||Date.now()<nextTerminationAt))return Promise.resolve();
    terminating = true;
    termination = (async () => {
      if (process.platform === 'win32') {
        terminationAttempts++;terminationUnknown=true;terminationByTimeout ??= byTimeout;byTimeout=terminationByTimeout;
        const status=spec.meta.containment?await new WinJobClient().terminate(spec.meta.containment, byTimeout ? 'timeout' : 'kill'):{state:'unknown'};
        terminationUnknown=status.state!=='drained';
        if(terminationUnknown) {
          // Only the original direct-child handle / owned pseudoconsole.
          let directSent=false;
          try{if(!ended&&child.exitCode===null&&child.signalCode===null)directSent=child.kill('SIGKILL')===true;}catch(error){reportPtyError('Direct worker termination failed',error);}
          directTerminationSent ||= directSent;
          timedOut=byTimeout;killed=!byTimeout;
          save(join(directory,'containment-status.json'),{state:'unknown',reason:'broker termination unconfirmed',attempts:terminationAttempts});
          writeSync(stderr,directSent?'\nContainment unknown; direct worker termination requested\n':'\nContainment unknown; no direct worker termination request was sent\n');
        }
        return;
      }
      let sent = false;
      if (spec.pty && !worker) {
        // 尚未 onExit 時 console 仍由這個 agent 持有；不可在退出後重查／終止 PID。
        if (!ended) { ptyProc.kill(); sent = true; }
      } else { sent = !!await requestTermination?.(); }
      if (sent) { timedOut = byTimeout; killed = !byTimeout; }
    })().catch(error => { reportPtyError('Termination failed', error); }).finally(() => { terminating = false; if(process.platform==='win32')nextTerminationAt=Date.now()+1000*2**(terminationAttempts-1); });
    return termination;
  };
  const timeoutAt = spec.timeoutMs === undefined ? Infinity : Date.now() + spec.timeoutMs;
  const onTerm = () => { void terminate(); };
  process.on('SIGTERM', onTerm); process.on('SIGINT', onTerm);
  interval = setInterval(() => {
    if (Date.now() >= timeoutAt && !ended && !killed) void terminate(true);
    let request: any; try { request = JSON.parse(readFileSync(join(directory, 'kill.json'), 'utf8')); } catch { return; }
    if (sameIdentity(request.runner, runner)) void terminate();
  }, 100);
  if (spec.timeoutMs !== undefined) timeout = setTimeout(() => { void terminate(true); }, spec.timeoutMs);
  const exit = await closed;
  tracker?.ended();
  if (interval) clearInterval(interval); if (timeout) clearTimeout(timeout);
  await termination;
  // A direct child exiting does not close the broker retry budget. Never kill
  // that child again; only ask the broker until drained or all three attempts end.
  while(process.platform==='win32' && terminationUnknown && terminationAttempts<3) {
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,nextTerminationAt-Date.now())));
    await terminate(terminationByTimeout);
  }
  process.off('SIGTERM', onTerm); process.off('SIGINT', onTerm);
  // 對齊舊 in-process PTY：使用者終止仍為 failed / 143，提示存進 stderr 供舊讀端解析。
  if (spec.pty && killed && (process.platform !== 'win32' || directTerminationSent)) {
    try { writeSync(stderr, '\nProcess terminated by user'); } catch (error) { reportPtyError('PTY termination hint failed', error); }
  }
  const exitError = spec.pty && !ptyOutput && exit.code !== 0 && exit.code !== null && !killed && !timedOut
    ? `PTY worker exited with code ${exit.code} without output` : undefined;
  if (exitError) reportPtyError('Process error', new Error(exitError));
  if (spec.pty) {
    try { closeSync(stdout); } catch (error) { reportPtyError('PTY stdout close failed', error); }
  }
  closeSync(stderr);
  const report: JobExit = { exitCode: spec.pty && killed ? 143 : exit.code, signal: exit.signal, endTime: new Date().toISOString(), timedOut, killed,
    ...(exitError ? { error: exitError } : {}), ...(tracker ? { termination: { confirmed: false, pending: true as const, reasons: ['Descendant cleanup pending'] } } : {}) };
  if (!readJobExit(directory)) save(join(directory, 'exit.json'), report);
  for (const file of ['stdin.tmp', 'kill.json']) rmSync(join(directory, file), { force: true });
  // 結果先落盤，呼叫端不必多等；runner 自己留下來補最後一次列舉。讀端要等 runner 也消失才會看子孫紀錄。
  // 兩段都有時間上限（TREE_SEAL_BUDGET_MS、TREE_KILL_BUDGET_MS）：列舉一直逾時也不會把 runner 拖住。
  if (tracker) {
    try {
      await tracker.seal();
      // 被終止或逾時：worker 的樹已經砍過，這裡補砍已經脫離那棵樹、但確定是它子孫的程序（每一筆送出前再核對身分）。自然結束的不動。
      if (killed || timedOut) await tracker.killRecorded();
    } catch (error) { console.error('ai-cli runner tree:', error); }
    const termination = await tracker.confirmation().catch(error => ({ confirmed: false, reasons: [String(error)] }));
    const current = readJobExit(directory);
    // Preserve an independent runner failure; only finish our own report.
    if (current?.endTime === report.endTime) save(join(directory, 'exit.json'), { ...current, termination });
  }
}
// 僅 runner 入口執行；其他模組不 import 本檔。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runJob(process.argv[2], { waitForLauncher: process.argv[3] === '--wait-launcher' }).catch(error => { console.error(error); process.exitCode = 1; });
