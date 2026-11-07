/** 全螢幕生命週期與 Windows Terminal 啟動器；不取消、不停止任何 run。 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { DashboardController, type DashboardEffects } from './dashboard.js';
import { renderDashboard, type CommandShell } from './dashboard-view.js';

export interface DashboardLaunch {
  platform: string; env: NodeJS.ProcessEnv; executable: string; execArgs: string[]; entry: string | undefined; cwd: string;
  findWt(): string | null;
  launch(file: string, args: string[], cwd: string): Promise<number>;
}
export function dashboardRefusal(worker: string | undefined, inputTTY: boolean | undefined, outputTTY: boolean | undefined): string | null {
  if (worker === '1') return 'AI_CLI_WORKER=1：worker 不能開啟 dashboard（包含 --new-tab）。請由人在終端機操作。';
  if (!inputTTY || !outputTTY) return 'dashboard 需要 stdin 與 stdout 都是 TTY。請在互動終端機執行 ai-cli kernel dashboard。';
  return null;
}
export function newTabArgs(config: DashboardLaunch): string[] {
  if (!config.entry) throw new Error('無法取得目前 CLI 入口，沒有啟動新分頁。');
  return ['-w', '0', 'new-tab', '--title', 'ai-cli_kernel', '--startingDirectory', config.cwd, '--',
    config.executable, ...config.execArgs, resolve(config.cwd, config.entry), 'kernel', 'dashboard'];
}
export async function launchDashboardTab(config: DashboardLaunch, io: { stdout(text: string): void; stderr(text: string): void }): Promise<number> {
  const worker = dashboardRefusal(config.env.AI_CLI_WORKER, true, true);
  if (worker) { io.stderr(worker + '\n'); return 1; }
  if (config.platform !== 'win32' || !config.env.WT_SESSION) {
    io.stderr('dashboard --new-tab 僅支援 Windows Terminal（Windows 且 WT_SESSION 存在）。\n');
    io.stdout('請在互動終端機自行貼上：ai-cli kernel dashboard\n'); return 2;
  }
  const wt = config.findWt();
  if (!wt) {
    io.stderr('PATH 找不到 wt.exe，沒有啟動其他終端機。\n');
    io.stdout('請在互動終端機自行貼上：ai-cli kernel dashboard\n'); return 2;
  }
  try {
    const code = await config.launch(wt, newTabArgs(config), config.cwd);
    if (code !== 0) throw new Error(`wt.exe 結束碼 ${code}`);
    io.stdout('Windows Terminal 已接受新分頁啟動要求；新分頁會檢查 TTY 並顯示 dashboard。\n'); return 0;
  } catch (error) { io.stderr(`無法啟動 dashboard 新分頁：${message(error)}\n`); return 1; }
}
export function nativeLaunch(startProcess: typeof spawn = spawn): DashboardLaunch {
  return {
    platform: process.platform, env: process.env, executable: process.execPath, execArgs: [...process.execArgv], entry: process.argv[1], cwd: process.cwd(),
    findWt() {
      for (const folder of (process.env.PATH ?? '').split(delimiter)) {
        if (!folder) continue;
        const file = join(folder.replace(/^"|"$/g, ''), 'wt.exe');
        try { if (statSync(file).isFile()) return file; } catch { /* 下一個 PATH 目錄 */ }
      }
      return null;
    },
    launch(file, args, cwd) {
      return new Promise((done, reject) => {
        const child = startProcess(file, args, { cwd, shell: false, windowsHide: true, stdio: 'ignore', timeout: 5_000 });
        child.once('error', reject);
        child.once('close', (code, signal) => signal ? reject(new Error(`wt.exe 被 ${signal} 終止`)) : done(code ?? 1));
      });
    },
  };
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface Events {
  on(name: string, listener: (...args: any[]) => void): unknown;
  removeListener(name: string, listener: (...args: any[]) => void): unknown;
}
export interface DashboardTerminal {
  input: Events & { isTTY?: boolean; isRaw?: boolean; isPaused(): boolean; setRawMode(mode: boolean): unknown; resume(): unknown; pause(): unknown };
  output: Events & { isTTY?: boolean; columns?: number; rows?: number; write(text: string, callback?: (error?: Error | null) => void): unknown };
  events: Events;
  worker?: string;
  commandShell?: CommandShell;
  error(text: string): void;
  clock?: {
    setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout> | undefined): void;
  };
}
export const nativeTerminal = (): DashboardTerminal => ({ input: process.stdin, output: process.stdout, events: process,
  worker: process.env.AI_CLI_WORKER, commandShell: process.platform === 'win32' ? 'powershell' : 'posix',
  error: text => { process.stderr.write(text); } });

/** 小型可測輸入解碼器：處理跨 chunk 的方向鍵、Esc 及 bracketed paste，貼上內容不變成操作。 */
export class DashboardKeys {
  private buffer = '';
  private paste = false;
  feed(text: string): string[] {
    this.buffer += text;
    const keys: string[] = [];
    const sequences: Record<string, string> = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1bOA': 'up', '\x1bOB': 'down', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown' };
    while (this.buffer) {
      if (this.paste) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end < 0) { this.buffer = this.buffer.slice(-5); break; }
        this.buffer = this.buffer.slice(end + 6); this.paste = false; continue;
      }
      if (this.buffer.startsWith('\x1b[200~')) { this.buffer = this.buffer.slice(6); this.paste = true; continue; }
      const match = Object.keys(sequences).find(seq => this.buffer.startsWith(seq));
      if (match) { keys.push(sequences[match]); this.buffer = this.buffer.slice(match.length); continue; }
      if ([...Object.keys(sequences), '\x1b[200~'].some(seq => seq.startsWith(this.buffer))) break;
      if (this.buffer.startsWith('\x1b[')) {
        const csi = this.buffer.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (!csi && this.buffer.length < 64) break;
        this.buffer = csi ? this.buffer.slice(csi[0].length) : ''; continue;
      }
      if (this.buffer.startsWith('\x1bO')) {
        if (this.buffer.length < 3) break;
        this.buffer = this.buffer.slice(3); continue;
      }
      const char = this.buffer[0]; this.buffer = this.buffer.slice(1);
      keys.push(char === '\x1b' ? 'escape' : char === '\x03' ? 'ctrl+c' : char);
    }
    return keys;
  }
  flush(): string[] {
    if (this.buffer === '\x1b') { this.buffer = ''; return ['escape']; }
    if (!this.paste) this.buffer = '';
    return [];
  }
}

/** 空寫入 callback 排在前面的 stdout 之後；外層 CLI 仍使用既有 exitAfterFlush。 */
export async function drainDashboardOutput(output: DashboardTerminal['output']): Promise<void> {
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('stdout 排空超過 2 秒')), 2_000);
    try { output.write('', error => { clearTimeout(timeout); error ? reject(error) : done(); }); }
    catch (error) { clearTimeout(timeout); reject(error); }
  });
}

export async function runDashboard(effects: DashboardEffects, terminal: DashboardTerminal = nativeTerminal()): Promise<number> {
  const refusal = dashboardRefusal(terminal.worker, terminal.input.isTTY, terminal.output.isTTY);
  if (refusal) { terminal.error(refusal + '\n'); return 1; }
  const { input, output, events } = terminal;
  const clock = terminal.clock ?? { setTimeout, clearTimeout };
  const originalRaw = Boolean(input.isRaw), originalPaused = input.isPaused();
  let touchedRaw = false, alternate = false, cleaned = false, done = false;
  let timer: ReturnType<typeof setTimeout> | undefined, escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (code: number) => void;
  const stopped = new Promise<number>(resolve => { finish = resolve; });
  const listeners: Array<[Events, string, (...args: any[]) => void]> = [];
  const listen = (target: Events, name: string, handler: (...args: any[]) => void) => {
    listeners.push([target, name, handler]); target.on(name, handler);
  };
  const controller = new DashboardController(effects, () => draw());
  function draw(): void {
    if (done || !alternate) return;
    const frame = renderDashboard(controller, output.columns ?? 80, output.rows ?? 24, terminal.commandShell);
    controller.scroll = frame.scroll;
    output.write('\x1b[H\x1b[2J' + frame.text);
  }
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true; controller.close(); clock.clearTimeout(timer); clock.clearTimeout(escapeTimer);
    for (const [target, name, handler] of listeners) {
      try { target.removeListener(name, handler); } catch { /* 其他復原步驟仍須完成 */ }
    }
    let first: unknown;
    const restore = (fn: () => void) => { try { fn(); } catch (error) { first ??= error; } };
    if (alternate) restore(() => { output.write('\x1b[?2004l\x1b[?25h\x1b[?1049l'); });
    if (touchedRaw) restore(() => { input.setRawMode(originalRaw); });
    if (originalPaused) restore(() => { input.pause(); });
    if (first) throw first;
  }
  function stop(code: number, error?: unknown): void {
    if (done) return;
    done = true;
    try { cleanup(); } catch (failure) { code = 1; error ??= failure; }
    if (error) terminal.error(`dashboard 錯誤：${message(error)}\n`);
    finish(code);
  }
  function scheduleRefresh(): void {
    // g 與輪詢可能等待同一個讀取。每次安排行程都清掉前一個，不能遺留無法清理的 timer。
    clock.clearTimeout(timer);
    timer = undefined;
    if (!done) timer = clock.setTimeout(() => { void refresh(); }, controller.interval);
  }
  async function refresh(): Promise<void> {
    if (done) return;
    clock.clearTimeout(timer);
    try { await controller.refresh(); } catch (error) { stop(1, error); return; }
    scheduleRefresh();
  }
  async function key(key: string): Promise<void> {
    if (done) return;
    try {
      const frame = renderDashboard(controller, output.columns ?? 80, output.rows ?? 24, terminal.commandShell);
      const result = await controller.key(key, frame.pageSize, frame.confirmationFits);
      if (result === 'quit') { stop(key === 'ctrl+c' ? 130 : 0); return; }
      // 即時更新或操作改變 active 狀態後，立刻改用正確輪詢間隔。
      if (key === 'g' || key === 'y' || key === 'n' || key === 'escape') {
        scheduleRefresh();
      }
    } catch (error) { stop(1, error); }
  }
  const decoder = new DashboardKeys();
  try {
    listen(events, 'SIGINT', () => stop(130));
    listen(events, 'SIGTERM', () => stop(143));
    listen(events, 'uncaughtException', error => stop(1, error));
    listen(events, 'unhandledRejection', error => stop(1, error));
    listen(input, 'error', error => stop(1, error));
    listen(output, 'error', error => stop(1, error));
    listen(output, 'resize', () => { try { draw(); } catch (error) { stop(1, error); } });
    listen(input, 'end', () => stop(1, new Error('stdin 已關閉')));
    listen(input, 'data', chunk => {
      clock.clearTimeout(escapeTimer);
      for (const value of decoder.feed(String(chunk))) void key(value);
      escapeTimer = clock.setTimeout(() => { for (const value of decoder.flush()) void key(value); }, 40);
    });
    touchedRaw = true; input.setRawMode(true);
    alternate = true; output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
    input.resume(); draw(); void refresh();
  } catch (error) { stop(1, error); }
  let code = await stopped;
  try { cleanup(); await drainDashboardOutput(output); }
  catch (error) { terminal.error(`dashboard 輸出排空失敗：${message(error)}\n`); code = 1; }
  return code;
}
