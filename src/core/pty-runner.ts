/**
 * ConPTY 子程序執行器。供需要「真實終端機」的 agent 使用（目前 agy/win32）。
 *
 * agy.exe 在 stdout 不是 TTY 時靜默不輸出。透過 @homebridge/node-pty-prebuilt-multiarch
 * 配置 ConPTY，並把 pty handle 包成 ChildProcess-like 介面，讓 process-service
 * 的其餘程式碼（list/wait/peek/kill）對 PTY 完全無感。
 *
 * Windows 的工作派送已改由 job-runner 持有 PTY。本 adapter 保留給既有
 * worker-env 驗證及直接使用者；與 runner 共用載入器及串流 ANSI 清理。
 */

import { EventEmitter } from 'node:events';
import { buildWorkerEnv } from './worker-env.js';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { createAnsiCleaner } from './ansi.js';

const patchRequire = createRequire(import.meta.url);
let ptyModule: any = null;

export function loadPtyModule(): any {
  if (ptyModule) return ptyModule;
  ptyModule = patchRequire('@homebridge/node-pty-prebuilt-multiarch');
  return ptyModule;
}

/**
 * 只在 onExit（輸出 socket 已關閉）後釋放 runner 的資源，不再對任何 PID 送 signal。
 * 目前 prebuilt node-pty 的自然退出只 destroy outSocket，留下 inSocket 及 conout
 * Worker；公開 kill()/destroy() 又會重新列舉 console PID，不能在 PID 可重用後呼叫。
 * 此處依賴已安裝版本的內部生命週期 API，升級 node-pty 時須跑 verify-pty-jobs。
 */
export function releaseExitedPty(ptyProc: any): boolean {
  const input = ptyProc?._agent?.inSocket;
  const conout = ptyProc?._agent?._conoutSocketWorker;
  input?.destroy?.();
  conout?.dispose?.();
  return typeof input?.destroy === 'function' || typeof conout?.dispose === 'function';
}

const stoppedPtys = new WeakSet<object>();
/** node-pty 0.13.1 ConPTY native baton owns HPCON/hShell. Bypass its JS
 * console PID enumeration (which races PID reuse). Never fall back to kill(pid).
 * ClosePseudoConsole is called at most once; whole-tree proof still belongs to broker.
 */
export function stopOwnedPty(ptyProc: any): boolean {
  if (process.platform !== 'win32') { ptyProc.kill(); return true; }
  const agent = ptyProc?._agent;
  if (!agent?._useConpty || typeof agent._ptyNative?.kill !== 'function' || typeof agent._pty !== 'number') return false;
  if (stoppedPtys.has(ptyProc)) return false;
  stoppedPtys.add(ptyProc);
  agent._ptyNative.kill(agent._pty, agent._useConptyDll);
  return true;
}

/** ChildProcess-like 介面，供 process-service 統一處理。 */
export interface PtyChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: null;
  pid?: number;
  kill(signal?: string): boolean;
}

export interface PtySpawnResult {
  pid: number;
  child: PtyChild;
}

/**
 * 用 ConPTY 啟動子程序，回傳 pid 與 ChildProcess-like adapter。
 * adapter：
 *  - once('close', cb) 供 waitForProcesses
 *  - stdout/stderr 串流 on/off('data') 供 peekProcesses
 *  - kill() 供 killProcess（win32 PTY 忽略 signal 名稱）
 *
 * onClose 回呼參數：(code, killedByUser) — 讓呼叫端更新 entry 狀態。
 */
export function spawnPty(
  cliPath: string,
  args: string[],
  cwd: string,
  onClose: (code: number | undefined, killedByUser: boolean) => void
): PtySpawnResult {
  const pty = loadPtyModule();
  const ptyProc = pty.spawn(cliPath, args, {
    name: 'xterm-color',
    cols: 200,
    rows: 50,
    cwd,
    env: buildWorkerEnv(),
  });

  const pid: number | undefined = ptyProc.pid;
  if (!pid) {
    throw new Error('Failed to start CLI process (pty.spawn returned no pid)');
  }

  const child = new EventEmitter() as PtyChild;
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough(); // PTY 合併串流；stderr 維持空
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.stdin = null;
  child.pid = pid;

  let closed = false;
  let killedByUser = false;
  const cleaner = createAnsiCleaner();

  child.kill = (_signal?: string): boolean => {
    if (closed) return false;
    killedByUser = true;
    try {
      if (!stopOwnedPty(ptyProc)) return false;
    } catch {
      /* ignore */
    }
    return true;
  };

  ptyProc.onData((d: string) => {
    if (closed) return;
    const cleaned = cleaner.push(d);
    if (cleaned) stdoutStream.write(cleaned);
  });

  ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
    if (closed) return;
    closed = true;
    const flushed = cleaner.flush();
    if (flushed) stdoutStream.write(flushed);
    const code = killedByUser ? 143 : exitCode;
    onClose(code, killedByUser);
    try {
      stdoutStream.end();
    } catch {
      /* ignore */
    }
    try {
      stderrStream.end();
    } catch {
      /* ignore */
    }
    child.emit('close', code);
  });

  return { pid, child };
}
