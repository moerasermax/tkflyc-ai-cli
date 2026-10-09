/** 跨 session 的唯讀 job 摘要與 MCP 快照；不保存 prompt／原始輸出。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { elapsedSeconds } from './liveness.js';

export const JOB_RETENTION_MS = 30 * 60 * 1000;
export const JOB_REFRESH_MS = 2000;
export interface ProcessIdentity { pid: number; started: string; name: string; ppid?: number; commandLine?: string }
export interface JobDispatcher { pid: number; started?: string; parentPid: number; parentName?: string }
export interface LiveJob {
  jobId?: string;
  pid: number; agent: string; model: string | null; reasoning_effort: string | null;
  task: string; workFolder: string; status: 'running' | 'completed' | 'failed' | 'lost';
  startTime: string; endTime?: string; elapsedSec: number;
  sinceLastOutputSec: number | null; lastEvent: string | null; dispatcher: JobDispatcher;
  source: 'mcp' | 'cli'; identityVerified?: boolean;
}
export interface JobSnapshot { version: 1; owner: ProcessIdentity; updatedAt: string; jobs: LiveJob[] }
export type IdentityLookup = (pids: number[]) => Promise<Map<number, ProcessIdentity>>;
const exec = promisify(execFile);
export function jobStateDir(): string { return process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli'); }

/** 去除控制字元（包括終端機 escape），摘要以 Unicode code point 截短。 */
export function shortText(value: string, limit: number): string {
  return Array.from(value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}
export function taskSummary(prompt: string): string {
  return shortText(prompt.split(/\r?\n/).find(line => /[\p{L}\p{N}]/u.test(line)) || '', 40);
}

/** 每輪批次查詢；建立時間 token 由 OS 提供，不能用檔案 mtime 或 kill(pid, 0) 代替。 */
async function lookupProcessIdentities(pids: number[], includeCommandLine = false): Promise<Map<number, ProcessIdentity>> {
  const ids = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff);
  const result = new Map<number, ProcessIdentity>();
  if (!ids.length) return result;
  try {
    if (process.platform === 'win32') {
      const filter = ids.map(pid => `ProcessId=${pid}`).join(' OR ');
      const script = `@(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');name=$_.Name${includeCommandLine ? ';commandLine=$_.CommandLine' : ''}} }) | ConvertTo-Json -Compress`;
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
      const rows = JSON.parse(stdout || '[]');
      for (const row of Array.isArray(rows) ? rows : [rows]) if (row?.started) result.set(row.pid, row);
    } else if (process.platform === 'linux') {
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      for (const pid of ids) {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const end = stat.lastIndexOf(')');
          const fields = stat.slice(end + 2).split(' ');
          if (fields[0] === 'Z' || fields[0] === 'X') continue;
          result.set(pid, { pid, started: `${boot}:${fields[19]}`, name: stat.slice(stat.indexOf('(') + 1, end), ppid: Number(fields[1]), ...(includeCommandLine ? { commandLine: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } : {}) });
        } catch { /* 結束中的行程可以消失。 */ }
      }
    } else {
      let stdout: string;
      try {
        ({ stdout } = await exec('ps', ['-p', ids.join(','), '-o', 'pid=,ppid=,lstart=,comm='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 5000 }));
      } catch (error) {
        // BSD ps 可在部分 PID 消失時非零退出，仍保留有效的其他行。
        stdout = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
      }
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
        if (match) result.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), started: match[3], name: match[4].split('/').pop()! });
      }
      if (includeCommandLine && result.size) {
        const { stdout: commands } = await exec('ps', ['-p', [...result.keys()].join(','), '-o', 'pid=,args='], { timeout: 5000 }).catch(() => ({ stdout: '' }));
        for (const line of commands.split('\n')) { const match = line.trim().match(/^(\d+)\s+(.+)$/); if (match && result.has(Number(match[1]))) result.get(Number(match[1]))!.commandLine = match[2]; }
      }
    }
  } catch { /* 無法查證身分時不冒充存活；下一輪再試。 */ }
  return result;
}
export const lookupIdentities: IdentityLookup = pids => lookupProcessIdentities(pids);
/** 命令列可能含 prompt；只有主導者祖先辨識才能請求，不供一般 worker/GC 查詢。 */
export const lookupPrincipalIdentities: IdentityLookup = pids => lookupProcessIdentities(pids, true);

export async function currentDispatcher(lookup: IdentityLookup = lookupIdentities): Promise<JobDispatcher> {
  const identities = await lookup([process.pid, process.ppid]);
  return { pid: process.pid, started: identities.get(process.pid)?.started,
    parentPid: process.ppid, parentName: identities.get(process.ppid)?.name };
}
export function retainedJob(job: LiveJob, now: number): boolean {
  return job.status === 'running' || (!!job.endTime && now - Date.parse(job.endTime) < JOB_RETENTION_MS);
}
export function jobTiming(job: LiveJob, now: number): LiveJob {
  // 快照上的 sinceLastOutputSec 已經計算過；讀端依 updatedAt 補進度，見 readLiveJobs。
  return { ...job, elapsedSec: elapsedSeconds(job.startTime, job.endTime ?? now) };
}

function readSnapshot(path: string): JobSnapshot | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const snapshot = JSON.parse(readFileSync(path, 'utf8'));
      if (snapshot.version === 1 && Number.isSafeInteger(snapshot.owner?.pid) && snapshot.owner.pid > 0 && typeof snapshot.owner?.started === 'string' && Array.isArray(snapshot.jobs) && Number.isFinite(Date.parse(snapshot.updatedAt))) return snapshot;
      return undefined;
    } catch { /* rename 的短暫 sharing violation／ENOENT 立即重試一次。 */ }
  }
  return undefined;
}
function ownerMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** 只有寫端回收已過期且確認身分失效的快照；查詢失敗不能當成已死。 */
export async function collectStaleSnapshots(dir: string, lookup: IdentityLookup = lookupIdentities, now = Date.now(), alive = ownerMayBeAlive): Promise<void> {
  let files: string[];
  try { files = readdirSync(join(dir, 'live-jobs')); } catch { return; }
  const candidates = files.filter(file => file.endsWith('.json')).flatMap(file => {
    const path = join(dir, 'live-jobs', file), snapshot = readSnapshot(path);
    return snapshot && now - Date.parse(snapshot.updatedAt) > JOB_RETENTION_MS ? [{ path, snapshot }] : [];
  });
  const identities = await lookup(candidates.map(({ snapshot }) => snapshot.owner.pid));
  for (const { path, snapshot } of candidates) {
    const identity = identities.get(snapshot.owner.pid);
    if (identity ? identity.started === snapshot.owner.started : alive(snapshot.owner.pid)) continue;
    // 查詢期間若快照被更新，留給下次建立 publisher 時再處理。
    const current = readSnapshot(path);
    if (!current || current.updatedAt !== snapshot.updatedAt || current.owner.started !== snapshot.owner.started || current.owner.pid !== snapshot.owner.pid) continue;
    try { rmSync(path); } catch { /* GC 不影響派工。 */ }
  }
}

export class LiveJobPublisher {
  readonly filePath: string;
  private sources = new Map<object, () => LiveJob[]>();
  private lastWrite = -Infinity;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private lastContent?: string;
  private lastError?: string;
  readonly ready: Promise<void>;
  private onExit = () => this.dispose();
  constructor(private dir: string, private owner: ProcessIdentity, private now = Date.now, lookup: IdentityLookup = lookupIdentities, alive = ownerMayBeAlive) {
    // principal 探查需要命令列，但監看快照不得保存 CLI 的 prompt 參數。
    const { commandLine: _commandLine, ...safeOwner } = owner; this.owner = safeOwner;
    // ISO、Linux boot token、POSIX lstart 都可能含不能當檔名的字元。
    this.filePath = join(dir, 'live-jobs', `${owner.pid}-${owner.started.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    process.once('exit', this.onExit);
    this.ready = collectStaleSnapshots(dir, lookup, now(), alive).catch(() => {});
  }
  setSource(key: object, source: () => LiveJob[]): void {
    if (this.stopped) return;
    this.sources.set(key, source);
    if (!this.timer) { this.timer = setInterval(() => this.publish(), JOB_REFRESH_MS); this.timer.unref(); }
    this.publish(true);
  }
  publish(force = false): void {
    if (this.stopped) return;
    const now = this.now();
    if (!force && now - this.lastWrite < JOB_REFRESH_MS - 50) return;
    const jobs = [...this.sources.values()].flatMap(source => source()).filter(job => retainedJob(job, now));
    const content = JSON.stringify(jobs);
    if (!force && !jobs.some(job => job.status === 'running') && content === this.lastContent) return;
    const temp = `${this.filePath}.tmp`;
    try {
      mkdirSync(join(this.dir, 'live-jobs'), { recursive: true });
      const snapshot: JobSnapshot = { version: 1, owner: this.owner, updatedAt: new Date(now).toISOString(), jobs };
      writeFileSync(temp, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
      renameSync(temp, this.filePath);
      this.lastWrite = now;
      this.lastContent = content;
      if (this.lastError !== undefined) console.error('ai-cli jobs: snapshot write recovered');
      this.lastError = undefined;
    } catch (error) {
      // 監看失敗不應讓派工失敗，也不能污染 MCP stdout。
      const message = (error as Error).message;
      if (message !== this.lastError) console.error(`ai-cli jobs: snapshot write failed: ${message}`);
      this.lastError = message;
    } finally { try { rmSync(temp, { force: true }); } catch {} }
  }
  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    process.off('exit', this.onExit);
    try { rmSync(this.filePath, { force: true }); } catch {}
  }
}

// 一個 OS 行程／狀態目錄只寫一份；多個 ProcessService 的來源合併，避免互相覆蓋。
const publishers = new Map<string, Promise<LiveJobPublisher | undefined>>();
export function processJobPublisher(dir = jobStateDir()): Promise<LiveJobPublisher | undefined> {
  let pending = publishers.get(dir);
  if (!pending) {
    pending = lookupIdentities([process.pid]).then(ids => {
      const owner = ids.get(process.pid);
      if (!owner) { console.error('ai-cli jobs: cannot identify snapshot owner'); publishers.delete(dir); return undefined; }
      return new LiveJobPublisher(dir, owner);
    });
    publishers.set(dir, pending);
  }
  return pending;
}

export async function readLiveJobs(dir = jobStateDir(), lookup: IdentityLookup = lookupIdentities, now = Date.now()): Promise<LiveJob[]> {
  // 6.7.0 快照仍供舊版與不可接回的 PTY/direct-api 使用；新 runner 不另寫快照。
  const persistent = await readPersistentMcpJobs(dir, lookup, now);
  const snapshots: JobSnapshot[] = [];
  let files: string[];
  try { files = readdirSync(join(dir, 'live-jobs')); } catch { return persistent; }
  for (const file of files.filter(file => file.endsWith('.json'))) {
    const snapshot = readSnapshot(join(dir, 'live-jobs', file));
    if (snapshot) snapshots.push(snapshot);
  }
  const owners = await lookup(snapshots.map(snapshot => snapshot.owner.pid));
  return snapshots.flatMap(snapshot => {
    const identity = owners.get(snapshot.owner.pid);
    if (!identity || identity.started !== snapshot.owner.started) return [];
    return snapshot.jobs.filter(job => validJob(job) && retainedJob(job, now)).map(job => ({
      ...jobTiming(job, now),
      sinceLastOutputSec: job.sinceLastOutputSec === null ? null : job.sinceLastOutputSec + (job.status === 'running' ? Math.max(0, now - Date.parse(snapshot.updatedAt)) / 1000 : 0),
      task: shortText(job.task, 40), lastEvent: job.lastEvent === null ? null : shortText(job.lastEvent, 80),
    }));
  }).concat(persistent);
}
const storeReaders = new Map<string, import('./job-store.js').JobStore>();
async function readPersistentMcpJobs(dir: string, lookup: IdentityLookup, now: number): Promise<LiveJob[]> {
  const { JobStore, jobSummary } = await import('./job-store.js');
  let store = storeReaders.get(dir);
  if (!store) { store = new JobStore(dir, 'cli', true); storeReaders.set(dir, store); }
  await store.ready; store.scan(); await store.check(lookup);
  return [...store.jobs.values()].filter(job => job.meta.source === 'mcp').map(job => jobSummary(job, now)).filter(job => retainedJob(job, now));
}
function validJob(job: LiveJob): boolean {
  return !!job && Number.isSafeInteger(job.pid) && typeof job.agent === 'string' && typeof job.task === 'string'
    && typeof job.workFolder === 'string' && ['running', 'completed', 'failed', 'lost'].includes(job.status)
    && Number.isFinite(Date.parse(job.startTime)) && (job.lastEvent === null || typeof job.lastEvent === 'string')
    && (job.sinceLastOutputSec === null || Number.isFinite(job.sinceLastOutputSec)) && Number.isSafeInteger(job.dispatcher?.pid);
}
