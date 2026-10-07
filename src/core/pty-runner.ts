/**
 * ConPTY 子程序執行器。供需要「真實終端機」的 agent 使用（目前 agy/win32）。
 *
 * agy.exe 在 stdout 不是 TTY 時靜默不輸出。透過 @homebridge/node-pty-prebuilt-multiarch
 * 配置 ConPTY，並把 pty handle 包成 ChildProcess-like 介面，讓 process-service
 * 的其餘程式碼（list/wait/peek/kill）對 PTY 完全無感。
 *
 * 1:1 還原 dist/process-service.js 的 _startAntigravityPty。
 */

import { EventEmitter } from 'node:events';
import { buildWorkerEnv } from './worker-env.js';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { stripAnsi } from './ansi.js';

const patchRequire = createRequire(import.meta.url);
let ptyModule: any = null;

function loadPtyModule(): any {
  if (ptyModule) return ptyModule;
  ptyModule = patchRequire('@homebridge/node-pty-prebuilt-multiarch');
  return ptyModule;
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
  let ansiCarry = '';

  child.kill = (_signal?: string): boolean => {
    if (closed) return false;
    killedByUser = true;
    try {
      ptyProc.kill();
    } catch {
      /* ignore */
    }
    return true;
  };

  ptyProc.onData((d: string) => {
    if (closed) return;
    // 跨 chunk 保留結尾未完成的 ESC 序列，避免切斷半個序列
    const combined = ansiCarry + d;
    const lastEsc = combined.lastIndexOf('\x1b');
    let toClean = combined;
    ansiCarry = '';
    if (lastEsc !== -1 && lastEsc > combined.length - 32) {
      toClean = combined.slice(0, lastEsc);
      ansiCarry = combined.slice(lastEsc);
    }
    const cleaned = stripAnsi(toClean);
    if (cleaned) stdoutStream.write(cleaned);
  });

  ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
    if (closed) return;
    closed = true;
    if (ansiCarry) {
      const flushed = stripAnsi(ansiCarry);
      if (flushed) stdoutStream.write(flushed);
      ansiCarry = '';
    }
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
