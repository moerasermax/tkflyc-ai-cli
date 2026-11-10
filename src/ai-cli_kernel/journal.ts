/**
 * 任務紀錄：每個 run 一個目錄，事實以 append-only 日誌為準。
 *
 * 核心紀律是「先記意圖，再動作」：日誌寫不進去就不能執行。當掉時最後一行可能寫到一半，
 * 那一行視同沒發生；中間的行壞掉則是真的損毀，不猜，直接報錯。
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LegacyMarkerReplaceFailed, readActiveRuns, readReservedRun, releaseRunSlot } from './admission.js';
import { ProcessMutexBusy, type MutexRetryDeps } from './process-mutex.js';
import { jobStateDir } from '../core/live-jobs.js';
import type { KernelContract, KernelEvent, KernelEventBody, KernelReleaseEvent } from './types.js';

export function kernelStateDir(): string { return join(jobStateDir(), 'kernel'); }
export function kernelRunsDir(): string { return join(kernelStateDir(), 'runs'); }
export function kernelRunDir(runId: string): string {
  if (!/^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(runId)) throw new Error(`不是有效的 run id：${runId}`);
  return join(kernelRunsDir(), runId);
}
/** 同一秒可能建好幾個 run，2 bytes 亂數會撞。撞到已存在的就換一個；真的搶輸了，create 會拒絕。 */
export function newRunId(now = new Date(), random: () => string = () => randomBytes(2).toString('hex')): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  for (let attempt = 0; attempt < 32; attempt++) {
    const runId = `kr-${stamp}-${random()}`;
    if (!existsSync(kernelRunDir(runId))) return runId;
  }
  throw new Error('run id 連續撞號，請稍後再試');
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
    // 目錄是這個 run 的所有權：不帶 recursive 才是原子的，已存在就丟 EEXIST。
    // 不擋的話，撞號時會蓋掉別人已核准的委任書，還接著寫同一份日誌。
    mkdirSync(dirname(this.dir), { recursive: true });
    mkdirSync(this.dir);
    mkdirSync(this.outputsDir, { recursive: true });
    const text = JSON.stringify(contract, null, 2) + '\n';
    atomicWrite(this.contractPath, text);
    const digest = digestText(text);
    // 自動選模型的結果也記進日誌：之後就算委任書檔案被動過，當初選了什麼還查得到。
    const selection = contract.modelSelection?.mode === 'auto' ? contract.modelSelection : null;
    this.append({ type: 'created', contractDigest: digest, ...(selection ? { modelSelection: {
      mode: 'auto' as const, difficulty: selection.difficulty, decide: contract.decide, worker: contract.worker, allowedWorkerModels: contract.allowedWorkerModels, quotas: selection.quotas,
    } } : {}) });
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
  const slots = readActiveRuns();
  if (slots.length) return slots[0].runId;
  const reserved = readReservedRun();
  if (reserved) return reserved;
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

export const SLOT_RELEASE_DEFERRED_NOTE = '名額釋放時協調忙碌，重試耗盡；名額檔留著，之後的 admission 會回收指向已結束 run 的名額';
/** I2：active.lock 原子覆蓋重試耗盡（LegacyMarkerReplaceFailed）。和忙碌一樣不是 run 的結果。 */
export const SLOT_RELEASE_MARKER_NOTE = '名額釋放時 active.lock 改指向重試耗盡；標記暫時仍指向這個 run，之後的協調（runner 定期檢查、下一次釋放或 admission）會用原子覆蓋補上並回收名額檔';
/** 名額釋放失敗不是 run 的結果：不寫 state，只記一筆 slot_release_failed。寫不進去也不丟出，免得蓋掉呼叫端原本的結論。 */
export function recordSlotReleaseFailed(runId: string, detail: string): void {
  try { new RunStore(kernelRunDir(runId)).append({ type: 'slot_release_failed', detail }); }
  catch { /* 紀錄寫不進去時，殘留名額仍由之後的 admission 回收 */ }
}
/**
 * 釋放名額。admission 協調忙碌時由 releaseRunSlot 有限重試（retryProcessMutex：3 次、間隔 1 秒）；
 * 仍忙碌就記 slot_release_failed 並回傳 false，不丟例外——已結束的 run 不能因此被改寫成 failed。
 * active.lock 原子覆蓋重試耗盡（LegacyMarkerReplaceFailed，I2）比照辦理，記錄說明不同。
 * 其他錯誤照常丟出。`keep` 在 admission 互斥區內判斷，回 true 就保留名額。
 */
export async function releaseActiveLock(runId: string, options: { deps?: Partial<MutexRetryDeps>; keep?: () => boolean | Promise<boolean> } = {}): Promise<boolean> {
  try { await releaseRunSlot(runId, options.deps, options.keep); return true; }
  catch (error) {
    if (error instanceof LegacyMarkerReplaceFailed) {
      recordSlotReleaseFailed(runId, `${SLOT_RELEASE_MARKER_NOTE}（${error.message}）`);
      return false;
    }
    if (!(error instanceof ProcessMutexBusy)) throw error;
    recordSlotReleaseFailed(runId, `${SLOT_RELEASE_DEFERRED_NOTE}（${error.message}）`);
    return false;
  }
}
