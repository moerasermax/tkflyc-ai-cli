/**
 * 任務紀錄：每個 run 一個目錄，事實以 append-only 日誌為準。
 *
 * 核心紀律是「先記意圖，再動作」：日誌寫不進去就不能執行。當掉時最後一行可能寫到一半，
 * 那一行視同沒發生；中間的行壞掉則是真的損毀，不猜，直接報錯。
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { jobStateDir } from '../core/live-jobs.js';
import type { KernelContract, KernelEvent, KernelEventBody, KernelReleaseEvent } from './types.js';

export function kernelStateDir(): string { return join(jobStateDir(), 'kernel'); }
export function kernelRunsDir(): string { return join(kernelStateDir(), 'runs'); }
export function kernelRunDir(runId: string): string {
  if (!/^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(runId)) throw new Error(`不是有效的 run id：${runId}`);
  return join(kernelRunsDir(), runId);
}
export function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `kr-${stamp}-${randomBytes(2).toString('hex')}`;
}

export function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, 'w', 0o600);
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function digestText(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export class RunStore {
  readonly runId: string;
  constructor(readonly dir: string) { this.runId = basename(dir); }

  get contractPath(): string { return join(this.dir, 'contract.json'); }
  get journalPath(): string { return join(this.dir, 'journal.jsonl'); }
  get outputsDir(): string { return join(this.dir, 'outputs'); }
  get reportPath(): string { return join(this.dir, 'report.md'); }
  get verdictPath(): string { return join(this.dir, 'verdict.json'); }
  get cancelPath(): string { return join(this.dir, 'cancel.request'); }
  get runnerPath(): string { return join(this.dir, 'runner.json'); }
  get runnerLockPath(): string { return join(this.dir, 'runner.lock'); }

  get releasesPath(): string { return join(this.dir, 'releases.jsonl'); }

  /** 與 job 日誌不同：殘行可能是放行意圖，不能忽略，否則可能重做不可逆操作。 */
  readReleases(): KernelReleaseEvent[] {
    let text: string;
    try { text = readFileSync(this.releasesPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (text && !text.endsWith('\n')) throw new Error('放行紀錄殘行，結果不明，拒絕執行');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as KernelReleaseEvent);
  }

  appendRelease(event: KernelReleaseEvent): void {
    this.readReleases(); // 損毀或殘行不能被新事件蓋過。
    const fd = openSync(this.releasesPath, 'a', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  }

  /** 同一 run 的建立／執行互斥。當機留下鎖時拒絕，不能猜舊執行器已停止。 */
  withReleaseLock<T>(work: () => T): T {
    const path = join(this.dir, 'release.lock');
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('放行鎖已被佔用或上次中斷，請人工對帳；不會自動重試'); throw error; }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); return work(); }
    finally { closeSync(fd); rmSync(path); }
  }

  /** 建立 run 目錄並寫入委任書。回傳 digest。 */
  create(contract: KernelContract): string {
    mkdirSync(this.outputsDir, { recursive: true });
    const text = JSON.stringify(contract, null, 2) + '\n';
    atomicWrite(this.contractPath, text);
    const digest = digestText(text);
    this.append({ type: 'created', contractDigest: digest });
    return digest;
  }

  readContract(): KernelContract { return JSON.parse(readFileSync(this.contractPath, 'utf8')) as KernelContract; }
  contractDigest(): string { return digestText(readFileSync(this.contractPath, 'utf8')); }

  read(): KernelEvent[] {
    let text: string;
    try { text = readFileSync(this.journalPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const lines = text.split('\n');
    const events: KernelEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as KernelEvent); }
      catch (error) {
        // 只有最後一行可以是寫到一半（當掉造成）；中間的行壞掉不能假裝沒事。
        if (lines.slice(i + 1).every(rest => !rest.trim())) break;
        throw new Error(`任務紀錄第 ${i + 1} 行損毀，停止解讀：${(error as Error).message}`);
      }
    }
    return events;
  }

  /** 寫入並 fsync，回來才算落盤。寫不進去會丟例外，呼叫端不可以繼續動作。 */
  append(body: KernelEventBody): KernelEvent {
    const existing = this.read();
    const seq = (existing.at(-1)?.seq ?? 0) + 1;
    const event = { ...body, seq, at: new Date().toISOString() } as KernelEvent;
    // 上一次當掉留下的半行從來沒有生效，截掉它。只補換行的話，它會變成中間行，整份日誌都讀不了。
    if (existsSync(this.journalPath)) {
      const raw = readFileSync(this.journalPath);
      if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) truncateSync(this.journalPath, raw.lastIndexOf(0x0a) + 1);
    }
    const fd = openSync(this.journalPath, 'a', 0o600);
    try { writeSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    return event;
  }

  writeOutput(actionId: string, message: string): string {
    mkdirSync(this.outputsDir, { recursive: true });
    const path = join(this.outputsDir, `${actionId}.txt`);
    atomicWrite(path, message);
    return path;
  }
  readOutput(path: string): string { return readFileSync(path, 'utf8'); }
  writeReport(text: string): void { atomicWrite(this.reportPath, text); }
  writeVerdict(verdict: unknown): void { atomicWrite(this.verdictPath, JSON.stringify(verdict, null, 2) + '\n'); }
  requestCancel(): void { writeFileSync(this.cancelPath, new Date().toISOString(), { mode: 0o600 }); }
  cancelRequested(): boolean { return existsSync(this.cancelPath); }
}

export function listRunIds(): string[] {
  try {
    return readdirSync(kernelRunsDir()).filter(name => /^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(name)).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/* ---- 受治理任務一次一個 ----
   鎖只負責並行協調。預算和未確認的副作用記在各 run 的日誌裡，鎖消失也不會跟著消失。 */
function activeLockPath(): string { return join(kernelStateDir(), 'active.lock'); }

export function readActiveRun(): string | null {
  try { return (JSON.parse(readFileSync(activeLockPath(), 'utf8')) as { runId?: string }).runId ?? null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** 原子取得。已被自己持有也算成功；被別的 run 持有時回傳該 run id。 */
export function acquireActiveLock(runId: string): { ok: true } | { ok: false; heldBy: string } {
  mkdirSync(kernelStateDir(), { recursive: true });
  try {
    const fd = openSync(activeLockPath(), 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ runId, at: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
    return { ok: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const heldBy = readActiveRun();
    if (heldBy === runId) return { ok: true };
    return { ok: false, heldBy: heldBy ?? 'unknown' };
  }
}

export function releaseActiveLock(runId: string): void {
  if (readActiveRun() === runId) rmSync(activeLockPath(), { force: true });
}
