/** 共用持久化 job store。runner 寫 meta/exit，adopt 原子更新歸屬；讀端只保存尾端及 byte offset。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { AgentId, BuiltCommand } from '../agents/types.js';
import { getAgent } from '../agents/registry.js';
import { grokResultFailed, collectGrokPromptFiles } from '../agents/grok.js';
import { assertCanStartJob, buildWorkerEnv, isNestedWorker } from './worker-env.js';
import { jobStateDir, lookupIdentities, lookupPrincipalIdentities, taskSummary, shortText, type ProcessIdentity, type IdentityLookup, type LiveJob } from './live-jobs.js';
import { buildLiveness, emptyOutputStats, listProcessTiming, elapsedSeconds, type ProcessOutputStats } from './liveness.js';
import { LivenessEventExtractor } from './peek-extractor.js';
import { buildProcessResult } from './process-result.js';
import { PeekEventExtractor } from './peek-extractor.js';
import { appendPeekEvents, buildNotFoundPeekProcess, observedDurationSec, validatePeekPids, validatePeekTimeSec, type PeekProcessResult } from './peek.js';
import { identityOnly, resolvePrincipal } from './principal.js';

export const RETENTION_MS = 30 * 60 * 1000;
export const MAX_FINISHED_JOBS = 100;
export const MAX_FINISHED_BYTES = 500 * 1024 * 1024;
export const VERBOSE_MAX_BYTES = 8 * 1024 * 1024;
export const STARTUP_GRACE_MS = 30_000;
export const GC_INTERVAL_MS = 60_000;
export interface JobMeta {
  /** 舊 metadata 沒有此欄位，不推測其權限。 */
  strict?: boolean;
  version: 1; jobId: string; pid: number; agent: AgentId; model?: string; resolvedModel: string;
  effort?: string; task: string; workFolder: string; sessionId?: string; startTime: string;
  source: 'mcp' | 'cli'; principal: ProcessIdentity | null; server: ProcessIdentity | null; projectDir?: string;
  runner: ProcessIdentity; worker: ProcessIdentity | null; recoverable: true;
  adoptedFrom?: Array<{ principal: ProcessIdentity | null; server: ProcessIdentity | null; adoptedAt: string }>;
}
export interface JobExit { exitCode: number | null; signal: string | null; endTime: string; timedOut: boolean; killed: boolean; error?: string }
export interface RunnerSpec {
  command: string; args: string[]; cwd: string; stdin: boolean; needsShell: boolean; timeoutMs?: number;
  /** 可省略：舊 server 的 spec 照舊走 pipe；meta/exit 格式不變。 */
  pty?: boolean;
  meta: Omit<JobMeta, 'pid' | 'runner' | 'worker'>; serverPid: number; principalPid: number;
}
export function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function sameIdentity(a: ProcessIdentity | null | undefined, b: ProcessIdentity | null | undefined): boolean {
  return !!a && !!b && !!a.started && a.pid === b.pid && a.started === b.started;
}
export function mayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function json<T>(path: string): T | undefined { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } }
function readJobMeta(directory: string, name: string, includeBootstrap = true): JobMeta | undefined {
  const meta = json<JobMeta>(join(directory, 'meta.json')) ?? (includeBootstrap ? json<JobMeta>(join(directory, 'bootstrap.json')) : undefined);
  return meta?.version === 1 && meta.jobId === name && meta.pid === meta.runner?.pid && typeof meta.runner?.started === 'string' && Number.isFinite(Date.parse(meta.startTime)) ? meta : undefined;
}
export function readJobMetas(dir: string): JobMeta[] {
  let names: string[]; try { names = readdirSync(join(dir, 'jobs')); } catch { return []; }
  return names.flatMap(name => {
    if (!/^[0-9a-f-]{36}$/.test(name)) return [];
    const directory = join(dir, 'jobs', name);
    // bootstrap 不含 prompt；runner 尚未落 meta 或磁碟失敗時仍可找到並觀察此 job。
    const meta = readJobMeta(directory, name);
    return meta ? [meta] : [];
  });
}
/** 已確認死亡才算 dead；查詢失敗與缺少建立時間都維持 unknown。 */
async function principalState(principal: ProcessIdentity | null | undefined, lookup: IdentityLookup): Promise<'dead' | 'alive' | 'unknown'> {
  if (!principal || !Number.isInteger(principal.pid) || principal.pid <= 0) return 'unknown';
  if (!mayBeAlive(principal.pid)) return 'dead';
  try {
    const current = (await lookup([principal.pid])).get(principal.pid);
    if (!principal.started || !current?.started) return 'unknown';
    return current.started === principal.started ? 'alive' : 'dead';
  } catch { return 'unknown'; }
}
type OwnerState = 'dead' | 'alive' | 'unknown' | 'server-alive' | 'server-unknown' | 'ownerless';
/**
 * principal 為 null（identify 失敗仍派工）時改看派工的 server：server 還在就不是孤兒。
 * 兩者皆 null 為無主，只能手動接管。
 */
async function ownerState(meta: Pick<JobMeta, 'principal' | 'server'>, lookup: IdentityLookup): Promise<OwnerState> {
  if (meta.principal !== null) return principalState(meta.principal, lookup);
  if (meta.server === null) return 'ownerless';
  const server = await principalState(meta.server, lookup);
  return server === 'dead' ? 'dead' : server === 'alive' ? 'server-alive' : 'server-unknown';
}
/** 只讀一份已完成的查詢結果，不再碰 OS 或共用快取。 */
function fromSnapshot(ids: Map<number, ProcessIdentity>): IdentityLookup {
  return async pids => new Map(pids.flatMap(pid => ids.has(pid) ? [[pid, ids.get(pid)!] as const] : []));
}
/** cwd 已被刪除時 process.cwd() 會丟 ENOENT；取不到就沒有專案目錄，自動接管停用。 */
export function currentProjectDir(): string | null { try { return process.cwd(); } catch { return null; } }
/** AI_CLI_AUTO_ADOPT 去空白、不分大小寫；off／0／false／no 都關閉。 */
export function autoAdoptSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:off|0|false|no)$/.test((env.AI_CLI_AUTO_ADOPT ?? '').trim().toLowerCase());
}
const WORKER_ADOPT_ERROR = 'Cannot adopt: this MCP server runs under an ai-cli worker (AI_CLI_WORKER=1, or a job runner/worker is among its ancestors). 此 MCP 是 worker 底下的 server，不接管 job，否則會把自己的父 job 接走；請由使用者的 session 接管。';
/** 接管時 null 只等於 null；其餘必須有相同的 PID 與 OS 建立時間。 */
function unchangedOwner(a: ProcessIdentity | null, b: ProcessIdentity | null): boolean {
  return a === null || b === null ? a === b : !!a && !!b && a.pid === b.pid && a.started === b.started;
}
function normalizeProjectDir(directory: string): string {
  const full = resolve(directory);
  return full === parse(full).root ? full : full.replace(process.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
}
/** 沒有 HOME（且查不到帳號家目錄）時 os.homedir() 會丟例外；取不到就只用根目錄規則。 */
export function currentHomeDir(): string | null { try { return homedir(); } catch { return null; } }
/** 新 job 精準比對 session 專案；舊 job 以 workFolder 的路徑邊界判定，不能搶走相似前綴的專案。 */
export function inAutoAdoptScope(meta: Pick<JobMeta, 'projectDir' | 'workFolder'>, projectDir: string | null, home: string | null = currentHomeDir()): boolean {
  const directory = meta.projectDir === undefined ? meta.workFolder : meta.projectDir;
  if (typeof directory !== 'string' || projectDir === null) return false;
  const normalize = (value: string) => { const full = normalizeProjectDir(value); return process.platform === 'win32' ? full.toLowerCase() : full; };
  const folder = normalize(directory), root = normalize(projectDir);
  if (meta.projectDir !== undefined) return folder === root;
  // 在磁碟根目錄或家目錄開 session 時，底下每個專案的舊 job 都落在前綴內；只接完全相同的 workFolder。
  if (root === normalize(parse(root).root) || home !== null && root === normalize(home)) return folder === root;
  return folder === root || folder.startsWith(root.endsWith(sep) ? root : root + sep);
}
class AdoptionError extends Error {
  constructor(message: string, readonly reason: 'ineligible' | 'locked' | 'changed') { super(message); }
}
export interface AdoptCandidate {
  pid: number; jobId: string; agent: AgentId; model: string | null; status: StoredJob['status'];
  startTime: string; endTime?: string; workFolder: string; task: string;
  principal: Pick<ProcessIdentity, 'pid' | 'name'> | null; autoAdopt: boolean; projectDir: string | null;
}
/**
 * CLI 與 MCP 共用的唯讀候選查詢，不建立 store、不落 lost.json 或延長保留期。
 * status 只看 exit.json／lost.json，不讀輸出 log；歸屬與 runner／worker 存活併成一次批次查詢。
 * `autoAdopt` 旗標同時反映開關與 worker 判定，不只是專案範圍。
 */
export async function listAdoptCandidates(dir = jobStateDir(), lookup: IdentityLookup = lookupIdentities, principal: ProcessIdentity | null = null,
  projectDir: string | null = currentProjectDir(), autoAdopt = autoAdoptSwitchOn() && !isNestedWorker(), home = currentHomeDir()): Promise<AdoptCandidate[]> {
  const listed = readJobMetas(dir).flatMap(({ jobId }) => {
    const directory = join(dir, 'jobs', jobId), meta = readJobMeta(directory, jobId, false);
    if (!meta || !meta.runner.started || meta.source !== 'mcp' || sameIdentity(meta.principal, principal)) return [];
    const exit = readJobExit(directory), lost = exit ? undefined : lostTime(directory);
    return [{ meta, directory, exit, lost }];
  });
  const pids = listed.flatMap(({ meta, exit, lost }) => {
    const owner = meta.principal ?? meta.server;
    return [...(owner ? [owner.pid] : []), ...(exit || lost ? [] : [meta.runner.pid, ...(meta.worker ? [meta.worker.pid] : [])])];
  }).filter(mayBeAlive);
  // 查詢失敗時歸屬維持 unknown（不列入），running 維持 running。
  let ids = new Map<number, ProcessIdentity>();
  try { ids = await lookup(pids); } catch { /* 存活不明。 */ }
  const batch = fromSnapshot(ids), candidates: AdoptCandidate[] = [];
  for (const { meta, directory, exit, lost } of listed) {
    const state = await ownerState(meta, batch);
    if (state !== 'dead' && state !== 'ownerless') continue;
    let status: StoredJob['status'] = exit ? (exit.exitCode === 0 && !exit.killed && !exit.timedOut ? 'completed' : 'failed') : lost ? 'lost' : 'running';
    let endTime = exit?.endTime ?? lost;
    if (status === 'running') {
      const gone = (id: ProcessIdentity | null) => !id || (ids.has(id.pid) ? !sameIdentity(id, ids.get(id.pid)) : !mayBeAlive(id.pid));
      if (gone(meta.runner) && gone(meta.worker)) { status = 'lost'; endTime = new Date().toISOString(); }
    }
    // GC 可能在讀取途中把目錄改名刪除；跳過該筆，不讓整個清單失敗。
    if (!existsSync(directory)) continue;
    candidates.push({ pid: meta.pid, jobId: meta.jobId, agent: meta.agent, model: meta.model ?? meta.resolvedModel ?? null,
      status, startTime: meta.startTime, ...(endTime ? { endTime } : {}), workFolder: meta.workFolder,
      task: taskSummary(meta.task), principal: meta.principal ? { pid: meta.principal.pid, name: meta.principal.name } : null,
      // 無主 job 自動接管一律不接，旗標不能說會接。
      autoAdopt: autoAdopt && state !== 'ownerless' && inAutoAdoptScope(meta, projectDir, home), projectDir: meta.projectDir ?? null });
  }
  return candidates;
}
export function readJobExit(dir: string): JobExit | undefined { return json<JobExit>(join(dir, 'exit.json')); }
function lostTime(dir: string): string | undefined {
  const value = json<{ endTime: string }>(join(dir, 'lost.json'))?.endTime;
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}
/** 先移走整個名稱，再刪檔；sharing violation 留在 .deleting，下輪無條件重試。 */
export function removeJobDirectory(directory: string): boolean {
  const deleting = directory.endsWith('.deleting') ? directory : `${directory}.deleting`;
  try { if (directory !== deleting) renameSync(directory, deleting); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; return false; }
  try { rmSync(deleting, { recursive: true, force: true }); } catch { /* 下輪重試，不遺失回收身分。 */ }
  return true;
}
/** 整個 store 共用容量上限，跨主導者回收只處理已結束／已確認遺失的 job。 */
export async function collectStoreFiles(dir: string, now = Date.now(), lookup: IdentityLookup = lookupIdentities): Promise<string[]> {
  collectGrokPromptFiles();
  const metas = readJobMetas(dir);
  const unidentified = metas.filter(meta => !readJobExit(join(dir, 'jobs', meta.jobId)));
  const ids = await lookup(unidentified.flatMap(meta => [meta.runner.pid, ...(meta.worker ? [meta.worker.pid] : [])]).filter(mayBeAlive));
  const gone = (identity: ProcessIdentity | null) => !identity || (identity.started && ids.has(identity.pid) ? !sameIdentity(identity, ids.get(identity.pid)) : !mayBeAlive(identity.pid));
  const finished = metas.flatMap(meta => {
    const directory = join(dir, 'jobs', meta.jobId), exit = readJobExit(directory);
    if (!exit && (!gone(meta.runner) || !gone(meta.worker))) return [];
    if (!meta.runner.started && now - Date.parse(meta.startTime) < STARTUP_GRACE_MS) return [];
    try {
      // 沉默很久的 job 可能剛剛才死；不能用舊 log mtime 把 lost 輸出立刻回收。
      if (!exit && !lostTime(directory)) atomicJson(join(directory, 'lost.json'), { endTime: new Date(now).toISOString() });
      const files = readdirSync(directory).map(f => statSync(join(directory, f)));
      const end = Date.parse(exit?.endTime ?? lostTime(directory)!);
      return [{ meta, directory, end, size: files.reduce((sum, f) => sum + f.size, 0) }];
    } catch { return []; }
  }).sort((a, b) => a.end - b.end);
  let count = finished.length, size = finished.reduce((sum, j) => sum + j.size, 0); const removed: string[] = [];
  for (const job of finished) {
    if (now - job.end < RETENTION_MS && count <= MAX_FINISHED_JOBS && size <= MAX_FINISHED_BYTES) continue;
    if (removeJobDirectory(job.directory)) { count--; size -= job.size; removed.push(job.meta.jobId); }
  }
  let names: string[] = []; try { names = readdirSync(join(dir, 'jobs')); } catch {}
  for (const name of names) {
    const directory = join(dir, 'jobs', name);
    if (/^[0-9a-f-]{36}\.deleting$/.test(name)) { removeJobDirectory(directory); continue; }
    if (!/^[0-9a-f-]{36}$/.test(name) || metas.some(meta => meta.jobId === name)) continue;
    try {
      if (now - statSync(directory).mtimeMs < STARTUP_GRACE_MS) continue;
      // 無 meta/已損壞：僅在 bootstrap/launch 的 runner 也不在時清理。
      const bootstrap = json<JobMeta>(join(directory, 'bootstrap.json'));
      const launch = json<RunnerSpec>(join(directory, 'launch.tmp'));
      if (bootstrap?.runner?.pid && mayBeAlive(bootstrap.runner.pid)) continue;
      if (launch && !bootstrap && mayBeAlive(launch.serverPid)) continue;
      removeJobDirectory(directory);
    } catch { /* 目錄被鎖，下輪重試。 */ }
  }
  return removed;
}
export class JobHandle extends EventEmitter {
  // EventEmitter 不會像未消費的 PassThrough 一樣累積 bytes。
  stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = null;
  constructor(public pid: number) { super(); }
}
interface Cursor { offset: number; chars: number; lineStart: number; pendingBytes: number; decoder: StringDecoder; pending: string; extractor: LivenessEventExtractor; flushed: boolean }
interface Reference { stream: 'stdout' | 'stderr'; offset: number; length: number }
export interface StoredJob extends ProcessOutputStats {
  meta: JobMeta; directory: string; pid: number; process: JobHandle; prompt: string; workFolder: string;
  model?: string; resolvedModel: string; reasoning_effort?: string; toolType: AgentId; startTime: string;
  endTime?: string; closed: boolean; status: 'running' | 'completed' | 'failed' | 'lost'; exitCode?: number;
  stdout: string; stderr: string; recovered?: true; adopted?: true;
  cursors: Record<'stdout' | 'stderr', Cursor>; parsed: Record<string, any>; messageRef?: Reference;
  incompleteUsage?: boolean; terminalRef?: Reference; outputFailed?: boolean;
}
const cursor = (agent: AgentId): Cursor => ({ offset: 0, chars: 0, lineStart: 0, pendingBytes: 0, decoder: new StringDecoder('utf8'), pending: '', extractor: new LivenessEventExtractor(agent), flushed: false });
function record(meta: JobMeta, directory: string, recovered = false): StoredJob {
  return { ...emptyOutputStats(), meta, directory, pid: meta.pid, process: new JobHandle(meta.pid), prompt: meta.task,
    workFolder: meta.workFolder, model: meta.model, resolvedModel: meta.resolvedModel, reasoning_effort: meta.effort,
    toolType: meta.agent, startTime: meta.startTime, closed: false, status: 'running', stdout: '', stderr: '',
    cursors: { stdout: cursor(meta.agent), stderr: cursor(meta.agent) }, parsed: {}, ...(recovered ? { recovered: true as const } : {}),
    ...(meta.adoptedFrom?.length ? { adopted: true as const } : {}) };
}
/** 檔案可很大；一次只讀 16 KiB。新增 bytes 的接收者不得保存完整輸出。 */
export function readChunks(path: string, offset: number, consume: (chunk: Buffer, position: number) => void): number {
  if (!existsSync(path)) return offset;
  const size = statSync(path).size;
  if (size <= offset) return offset;
  const fd = openSync(path, 'r'), buffer = Buffer.allocUnsafe(16 * 1024);
  try {
    while (offset < size) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset); if (!n) break; consume(buffer.subarray(0, n), offset); offset += n; }
  } finally { closeSync(fd); }
  return offset;
}
function readReference(job: StoredJob, ref: Reference): string {
  const fd = openSync(join(job.directory, `${ref.stream}.log`), 'r');
  try { const b = Buffer.alloc(ref.length); const n = readSync(fd, b, 0, b.length, ref.offset); return b.subarray(0, n).toString('utf8'); }
  finally { closeSync(fd); }
}
function event(job: StoredJob, text: string, ref: Reference): void {
  // 巨大的訊息只保留檔案座標；呼叫 result 時再讀該筆，避免 50 個 job 各留 1 MB。
  const agent = getAgent(job.toolType);
  const events = job.cursors[ref.stream].extractor.push(text.endsWith('\n') ? text : text + '\n');
  // V8 sliced/cons strings 可能讓 80 字摘要仍引用整筆 1 MB JSON，必須實體複製。
  job.eventCount += events.length; if (events.length) job.lastEvent = Buffer.from(events.at(-1)!).toString('utf8');
  const parsed: any = agent.parseOutput(job.toolType === 'claude' ? '{}\n' + text : text, '', job.exitCode, { workFolder: job.workFolder, status: job.status, strict: job.meta.strict });
  let raw: any; try { raw = JSON.parse(text); } catch { return; }
  if (parsed?.sandbox_warning) { job.parsed.sandbox_warning = parsed.sandbox_warning; job.outputFailed = true; }
  if (parsed?.session_id) job.parsed.session_id = Buffer.from(String(parsed.session_id)).toString('utf8');
  if (parsed?.message || (job.toolType === 'claude' && raw.type === 'result' && raw.result)) job.messageRef = ref;
  if (job.toolType === 'claude' && raw.type === 'result') { job.terminalRef = ref; job.outputFailed = raw.is_error === true; }
  if (job.toolType === 'grok' && raw.type === 'result') { job.terminalRef = ref; job.outputFailed = grokResultFailed(raw);
    job.parsed.subtype = raw.subtype; job.parsed.stop_reason = raw.stop_reason;
    if (parsed?.error) job.parsed.error = parsed.error; }
  if (parsed?.token_count) job.parsed.token_count = parsed.token_count;
  if (job.toolType === 'codex' && raw.type === 'turn.completed' && !parsed?.usage) job.incompleteUsage = true;
  if (parsed?.usage) {
    if (job.toolType === 'codex' && job.parsed.usage) {
      for (const [key, value] of Object.entries(parsed.usage)) if (typeof value === 'number') job.parsed.usage[key] = (job.parsed.usage[key] ?? 0) + value;
    } else job.parsed.usage = parsed.usage;
  }
}
export function refreshJob(job: StoredJob): void {
  if (job.closed) return;
  if (!job.meta.runner.started) { const meta = json<JobMeta>(join(job.directory, 'meta.json')); if (meta) job.meta = meta; }
  const exit = readJobExit(job.directory);
  const lost = !exit && lostTime(job.directory);
  if (lost) { job.status = 'lost'; job.endTime = lost; }
  for (const stream of ['stdout', 'stderr'] as const) {
    const c = job.cursors[stream], path = join(job.directory, `${stream}.log`);
    c.offset = readChunks(path, c.offset, (chunk) => {
      const decoded = c.decoder.write(chunk); c.chars += decoded.length;
      const tail = Buffer.from(job[stream] + decoded).subarray(-4096);
      let first = 0; while (first < tail.length && (tail[first] & 0xc0) === 0x80) first++;
      job[stream] = tail.subarray(first).toString('utf8');
      job.process[stream].emit('data', chunk);
      // 解碼完整 NDJSON 行的 parser 和 liveness 各自保有增量進度。
      let from = 0;
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
        const segment = chunk.subarray(from, i + 1);
        c.pending += segment.toString('latin1'); c.pendingBytes += segment.length;
        const ref = { stream, offset: c.lineStart, length: c.pendingBytes };
        event(job, c.pending.length === c.pendingBytes ? Buffer.from(c.pending, 'latin1').toString('utf8') : readReference(job, ref), ref);
        c.lineStart += c.pendingBytes; c.pending = ''; c.pendingBytes = 0; from = i + 1;
      }
      c.pending += chunk.subarray(from).toString('latin1'); c.pendingBytes += chunk.length - from;
      // 非 NDJSON/超長未完成行不累積於 heap；terminal 時以檔案座標解析。
      if (c.pendingBytes > 4096) c.pending = '';
    });
    job[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] = c.offset;
    if (c.offset) { const at = statSync(path).mtime.toISOString(); if (!job.lastOutputAt || at > job.lastOutputAt) job.lastOutputAt = at; }
    if ((exit || job.status === 'lost') && !c.flushed) {
      if (c.pendingBytes) event(job, readReference(job, { stream, offset: c.lineStart, length: c.pendingBytes }), { stream, offset: c.lineStart, length: c.pendingBytes });
      c.pending = ''; c.pendingBytes = 0;
      const events = c.extractor.flush(); job.eventCount += events.length; if (events.length) job.lastEvent = events.at(-1)!; c.flushed = true;
    }
  }
  if (exit && !job.closed) {
    if (exit.error) job.parsed.error = exit.error;
    job.exitCode = exit.exitCode ?? undefined; job.endTime = exit.endTime; job.status = exit.exitCode === 0 && !exit.killed && !exit.timedOut && !job.outputFailed ? 'completed' : 'failed';
    job.closed = true; job.process.emit('close', job.exitCode);
  }
  if (lost && !job.closed) { job.closed = true; job.process.emit('close'); }
}
export function jobResult(job: StoredJob, verbose = false): Record<string, unknown> {
  refreshJob(job);
  let stdout = job.stdout, stderr = job.stderr, parsed: any = { ...job.parsed };
  if (job.messageRef && (!verbose || job.messageRef.length <= VERBOSE_MAX_BYTES)) {
    const text = readReference(job, job.messageRef);
    const output: any = getAgent(job.toolType).parseOutput(job.toolType === 'claude' ? '{}\n' + text : text, '');
    parsed.message = output?.message ?? output?.result;
  }
  if (job.incompleteUsage && parsed.usage) parsed.usage = { ...parsed.usage, incomplete: true };
  if (verbose) {
    const readBounded = (stream: string) => {
      const path = join(job.directory, `${stream}.log`); if (!existsSync(path)) return '';
      const fd = openSync(path, 'r');
      try { const buffer = Buffer.alloc(Math.min(statSync(path).size, VERBOSE_MAX_BYTES)); return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'); }
      finally { closeSync(fd); }
    };
    stdout = readBounded('stdout'); stderr = readBounded('stderr');
    parsed = { ...(getAgent(job.toolType).parseOutput(stdout, stderr, job.exitCode, { workFolder: job.workFolder, status: job.status, strict: job.meta.strict }) as object ?? {}), ...parsed };
  }
  const result = buildProcessResult({ ...job, agent: job.toolType, stdout, stderr,
    liveness: job.status === 'running' ? buildLiveness(job, job.startTime, true) : undefined }, parsed, verbose);
  for (const stream of ['stdout', 'stderr'] as const) if (!verbose && stream in result && job.cursors[stream].chars > job[stream].length) {
    result[`${stream}Truncated`] = { totalChars: job.cursors[stream].chars, shownChars: job[stream].length };
  }
  result.jobId = job.meta.jobId;
  if (verbose && job.messageRef && job.messageRef.length > VERBOSE_MAX_BYTES) result.agentOutputTruncated = { totalBytes: job.messageRef.length, limitBytes: VERBOSE_MAX_BYTES };
  for (const stream of ['stdout', 'stderr'] as const) if (verbose && job.cursors[stream].offset > VERBOSE_MAX_BYTES) {
    result[`${stream}Truncated`] = { totalBytes: job.cursors[stream].offset, shownBytes: VERBOSE_MAX_BYTES };
  }
  if (job.recovered) result.recovered = true;
  if (job.adopted) result.adopted = true;
  if (verbose && job.meta.adoptedFrom) result.adoptedFrom = job.meta.adoptedFrom;
  return result;
}
export function jobSummary(job: StoredJob, now = Date.now()): LiveJob {
  refreshJob(job);
  return { pid: job.pid, jobId: job.meta.jobId, agent: job.toolType, model: job.resolvedModel || job.model || null, reasoning_effort: job.reasoning_effort ?? null,
    task: job.meta.task, workFolder: job.workFolder, status: job.status, startTime: job.startTime, endTime: job.endTime,
    elapsedSec: elapsedSeconds(job.startTime, job.endTime ?? now), sinceLastOutputSec: job.lastOutputAt ? Math.max(0, ((job.endTime ? Date.parse(job.endTime) : now) - Date.parse(job.lastOutputAt)) / 1000) : null,
    lastEvent: job.lastEvent === null ? null : shortText(job.lastEvent, 80), source: job.meta.source,
    dispatcher: { pid: job.meta.server?.pid ?? 0, started: job.meta.server?.started, parentPid: job.meta.principal?.pid ?? 0, parentName: job.meta.principal?.name }, identityVerified: !!job.meta.runner.started };
}

export class JobStore {
  readonly jobs = new Map<string, StoredJob>();
  readonly ready: Promise<void>;
  /**
   * 啟動那一輪自動接管的完成點。它在 ready 之後才在背景開始，不阻塞 ready（祖先鏈查詢在 Windows 每層約 430 ms）；
   * 只供測試與診斷等待，工具呼叫不必等它——接管成功會 scan，下一次 list／result 就看得到。
   */
  readonly autoAdoptSettled: Promise<void>;
  private adopting?: Promise<void>;
  private server: ProcessIdentity | null = null; private principal: ProcessIdentity | null = null;
  private timer?: NodeJS.Timeout; private checking?: Promise<void>;
  private checkedAt = -Infinity;
  private collecting?: Promise<void>;
  private collectedAt = -Infinity;
  private identities = new Map<number, { identity: ProcessIdentity; checkedAt: number }>();
  private owned = new Set<string>();
  private reportedAdoptLocks = new Set<string>();
  /** GC 那一輪的候選與它自己的查詢結果；自動接管只讀這份，不讀會被晚到查詢改寫的共用快取。 */
  private autoAdoptSnapshot?: { metas: JobMeta[]; identities: Map<number, ProcessIdentity>; at: number };
  /** 祖先鏈判定只快取確定的結果；無法確認時下次需要再查。 */
  private ancestry?: 'worker' | 'none';
  private initialized = false;
  /** 僅供測試：持有 adopt.lock 的同步臨界區內呼叫，預設不啟用。 */
  private adoptLockHeld?: () => void;
  readonly projectDir: string | null;
  private readonly home = currentHomeDir();
  constructor(readonly dir = jobStateDir(), private source: 'mcp' | 'cli' = 'cli', private readOnly = false, private lookup: IdentityLookup = lookupIdentities, projectDir: string | null = currentProjectDir()) {
    this.projectDir = projectDir === null ? null : normalizeProjectDir(projectDir);
    this.ready = this.initialize();
    this.autoAdoptSettled = readOnly ? Promise.resolve() : this.ready.then(() => this.runAutoAdopt(), () => {});
    // 只有 GC 計時器到期那一路繞過 2 秒節流。
    // 啟動完成前不讓計時器跑：它的強制 check 會清快取、多一輪 OS 查詢，直接加在 ready 上。
    const started = () => { this.initialized = true; };
    this.ready.then(started, started);
    if (!readOnly) { this.timer = setInterval(() => { if (!this.initialized) return; void this.check(this.lookup, Date.now() - this.collectedAt >= GC_INTERVAL_MS).then(async () => {
      if (Date.now() - this.collectedAt >= GC_INTERVAL_MS) await this.gcPass();
    }).catch(e => console.error('ai-cli jobs:', e)); }, 2000); this.timer.unref(); }
  }
  private async initialize(): Promise<void> {
    if (this.source === 'mcp') await this.identify();
    // 啟動時只回收、不接管；接管交給 autoAdoptSettled 在 ready 之後背景進行，check 建好的身分快照留給它用。
    this.scan(); await this.check(); if (!this.readOnly) { this.collect(); await this.collectAll(); }
  }
  /** GC 計時器那一輪：回收後接管。接管不能放進 collectAll 的 single-flight，見 collectAll。 */
  private async gcPass(): Promise<void> { this.collect(); await this.collectAll(); await this.runAutoAdopt(); }
  /** single-flight；錯誤只記 log。成功接管的 job 由 scan 納入。 */
  private runAutoAdopt(): Promise<void> {
    this.adopting ??= this.autoAdoptJobs().then(() => this.scan())
      .catch(e => console.error('ai-cli jobs auto-adopt:', e)).finally(() => { this.adopting = undefined; });
    return this.adopting;
  }
  /**
   * 只回收、不接管。這是 single-flight，initialize 也會 await 它：GC 計時器若剛好在啟動期間觸發，
   * 而接管放在這個 promise 裡，ready 就會跟著等接管（含祖先鏈查詢）。2026-10-12 verify-liveness 實測
   * ready 因此有時 7.6–8.3 秒（正常約 1.9 秒），6 秒結束的 stub 在 wait 開始前就跑完。
   */
  private collectAll(): Promise<void> {
    this.collecting ??= collectStoreFiles(this.dir, Date.now(), pids => this.cachedLookup(pids)).then(() => this.scan())
      .catch(e => console.error('ai-cli jobs GC:', e)).finally(() => { this.collecting = undefined; this.collectedAt = Date.now(); });
    return this.collecting;
  }
  /** 開關、cwd 與環境標記；祖先鏈判定較貴，只在真的有候選時才查。 */
  private autoAdoptAllowed(): boolean { return autoAdoptSwitchOn() && this.projectDir !== null && !isNestedWorker(); }
  private autoAdoptEnabled(): boolean { return this.source === 'mcp' && !this.readOnly && this.autoAdoptAllowed(); }
  /**
   * worker 底下的 MCP（cwd 常是同一個專案）不得接管，否則原 session 一關，它就把孤兒連同自己的父 job 接走。
   * codex 只把白名單 env 轉給 MCP，標記可能漏掉，所以再看 principal 以上有沒有尚未結束的 job 的 runner／worker。
   * 查詢失敗、祖先還在卻查不到、缺 ppid、或祖先是尚未落身分的 runner，都是無法確認。
   *
   * MCP→principal 那段 resolvePrincipal 已走過，從 principal 開始。worker 樹的形狀是
   * runner →（Windows cmd shell）→（node 啟動器）→ CLI，principal 最低就是那支 CLI，
   * 所以 runner 一定在 principal 之上 3 層內；查 4 層多留一層給沒被辨識成啟動器的 shim，超過就判 none。
   * 每層一次 OS 查詢：2026-10-12 這台 Windows 實測 lookupIdentities 單次 408–1047 ms、5 次中位數 430 ms，
   * 舊版無上限地查到鏈尾（5–8 層）會讓有孤兒候選時的 ready 慢好幾秒。
   */
  private async workerAncestry(): Promise<'worker' | 'none' | 'unknown'> {
    if (this.ancestry) return this.ancestry;
    const targets: ProcessIdentity[] = [], workers: ProcessIdentity[] = [], pending = new Set<number>();
    for (const meta of readJobMetas(this.dir)) {
      if (readJobExit(join(this.dir, 'jobs', meta.jobId))) continue;
      if (!meta.runner.started) { if (mayBeAlive(meta.runner.pid)) pending.add(meta.runner.pid); continue; }
      targets.push(meta.runner, ...(meta.worker ? [meta.worker] : []));
      if (meta.worker) workers.push(meta.worker);
    }
    // worker 啟動 MCP 前，runner 早已落 bootstrap；沒有未結束的 job 就不可能在 worker 底下。
    if (!targets.length && !pending.size) return this.ancestry = 'none';
    const principal = this.principal;
    if (!principal) return 'unknown';
    // 快速路徑：principal 本身就是某個 job 的 worker（claude 直接被 runner 啟動），不必查鏈。
    if (workers.some(worker => sameIdentity(worker, principal))) return this.ancestry = 'worker';
    if (principal.ppid === undefined) return 'unknown';
    try {
      const seen = new Set<number>([principal.pid]);
      let pid = principal.ppid;
      for (let depth = 0; depth < 4; depth++) {
        if (pid <= 0 || seen.has(pid)) return this.ancestry = 'none';
        seen.add(pid);
        if (pending.has(pid)) return 'unknown';
        const parent = (await this.lookup([pid])).get(pid);
        if (!parent) return mayBeAlive(pid) ? 'unknown' : this.ancestry = 'none';
        if (!parent.started) return 'unknown';
        if (targets.some(target => sameIdentity(target, parent))) return this.ancestry = 'worker';
        if (parent.ppid === undefined) return 'unknown';
        pid = parent.ppid;
      }
    } catch { return 'unknown'; }
    // runner 不可能在 principal 之上超過 4 層。
    return this.ancestry = 'none';
  }
  /** 候選的 autoAdopt 旗標與實際自動接管用同一組條件。 */
  private async autoAdoptActive(): Promise<boolean> { return this.autoAdoptAllowed() && await this.workerAncestry() === 'none'; }
  private autoAdoptMetas(): JobMeta[] {
    return readJobMetas(this.dir).flatMap(listed => {
      const meta = readJobMeta(join(this.dir, 'jobs', listed.jobId), listed.jobId, false);
      return meta && meta.runner.started && meta.source === 'mcp' && !sameIdentity(meta.principal, this.principal)
        && inAutoAdoptScope(meta, this.projectDir, this.home) ? [meta] : [];
    });
  }
  private async autoAdoptJobs(): Promise<void> {
    const snapshot = this.autoAdoptSnapshot; this.autoAdoptSnapshot = undefined;
    if (!snapshot?.metas.length || !this.autoAdoptEnabled() || !this.principal || !this.server) return;
    if (Date.now() - snapshot.at >= GC_INTERVAL_MS) return;
    // 祖先鏈查不到也不接（fail closed）；確定結果會快取，不會每輪重查。
    if (await this.workerAncestry() !== 'none') return;
    // check 已將原 principal／server 併入 GC 查詢；缺席的查詢結果維持 unknown，不另開 OS 查詢。
    const lookup = fromSnapshot(snapshot.identities);
    for (const meta of snapshot.metas) {
      try { await this.adoptJob(meta.jobId, lookup, true, meta); }
      catch (error) {
        if (error instanceof AdoptionError) {
          if (error.reason !== 'locked' || this.reportedAdoptLocks.has(meta.jobId)) continue;
          this.reportedAdoptLocks.add(meta.jobId);
        }
        console.error('ai-cli jobs auto-adopt:', error);
      }
    }
  }
  async identify(): Promise<void> {
    try {
      if (!this.server) { const id = (await this.lookup([process.pid])).get(process.pid); this.server = id ? identityOnly(id) : null; }
      if (!this.principal) this.principal = await resolvePrincipal(process.ppid, this.lookup === lookupIdentities ? lookupPrincipalIdentities : this.lookup);
      if (!this.server || !this.principal) console.error(`ai-cli jobs: cannot identify ${!this.server ? 'server' : 'principal'}; retrying on next check`);
    } catch (error) { console.error('ai-cli jobs: identity lookup failed; retrying on next check:', error); }
  }
  private async cachedLookup(pids: number[], lookup = this.lookup): Promise<Map<number, ProcessIdentity>> {
    const result = new Map<number, ProcessIdentity>(), needed: number[] = [], now = Date.now();
    for (const pid of new Set(pids)) {
      if (!mayBeAlive(pid)) { this.identities.delete(pid); continue; }
      const cached = this.identities.get(pid);
      if (cached && now - cached.checkedAt < GC_INTERVAL_MS) result.set(pid, cached.identity);
      else needed.push(pid);
    }
    if (needed.length) for (const [pid, identity] of await lookup(needed)) {
      this.identities.set(pid, { identity: identityOnly(identity), checkedAt: now }); result.set(pid, identity);
    }
    return result;
  }
  scan(): void {
    for (const [jobId, job] of this.jobs) if (!existsSync(job.directory)) { this.jobs.delete(jobId); this.owned.delete(jobId); }
    for (const meta of readJobMetas(this.dir)) {
      if (this.source === 'mcp' && (meta.source !== 'mcp' || !sameIdentity(meta.principal, this.principal))) continue;
      if (this.jobs.has(meta.jobId)) continue;
      // recovered 是同一 principal 重啟後接回；這個 server 剛接管進來的不算。
      this.jobs.set(meta.jobId, record(meta, join(this.dir, 'jobs', meta.jobId), this.source === 'mcp' && !this.owned.has(meta.jobId)));
    }
  }
  async adopt(pid?: number, jobId?: string): Promise<AdoptCandidate[] | { pid: number; jobId: string; adopted?: true; alreadyOwned?: true }> {
    if (this.source !== 'mcp') throw new Error('CLI stores cannot adopt jobs; call adopt from the receiving MCP session. CLI ps/result/wait/kill already see all jobs.');
    await this.ready;
    if (!this.principal) throw new Error('Cannot adopt: this MCP principal identity is unknown.');
    if (!this.server) throw new Error('Cannot adopt: this MCP server identity is unknown.');
    if (pid === undefined && jobId === undefined) return listAdoptCandidates(this.dir, this.lookup, this.principal, this.projectDir, await this.autoAdoptActive(), this.home);
    if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) throw new Error('pid must be a positive integer.');
    if (jobId !== undefined && (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/.test(jobId))) throw new Error('jobId must be a durable job UUID.');
    const metas = readJobMetas(this.dir);
    // 與 find 相同：PID 重用時只選最新那筆，不略過仍活著或尚未落 meta 的 job。
    let latest: JobMeta | undefined;
    for (const meta of metas) if (meta.pid === pid && (!latest || meta.startTime > latest.startTime
      || meta.startTime === latest.startTime && meta.jobId > latest.jobId)) latest = meta;
    const selected = jobId === undefined ? latest : metas.find(meta => meta.jobId === jobId);
    if (!selected) throw new Error(`Job ${jobId ?? pid} not found.`);
    if (pid !== undefined && (selected.pid !== pid || latest?.jobId !== selected.jobId)) throw new Error('pid and jobId must resolve to the same latest job.');
    if (await this.workerState() === 'worker') throw new AdoptionError(WORKER_ADOPT_ERROR, 'ineligible');
    return this.adoptJob(selected.jobId, this.lookup);
  }
  /** 手動接管只拒絕確定是 worker 的；祖先鏈無法確認時仍可由人手動接。 */
  private async workerState(): Promise<'worker' | 'none' | 'unknown'> {
    if (isNestedWorker()) return 'worker';
    return this.workerAncestry();
  }
  private async adoptJob(jobId: string, lookup: IdentityLookup, automatic = false, expectedOwner?: JobMeta): Promise<{ pid: number; jobId: string; adopted?: true; alreadyOwned?: true }> {
    const directory = resolve(this.dir, 'jobs', jobId);
    const verified = readJobMeta(directory, jobId, false);
    if (!verified || !verified.runner.started) throw new AdoptionError('Cannot adopt: meta.json with a verified runner identity is required; bootstrap-only jobs are not ready.', 'ineligible');
    if (verified.source !== 'mcp') throw new AdoptionError('Only MCP jobs can be adopted.', 'ineligible');
    // GC 查詢後才新增或換主的 job，不能沿用同 PID 的另一個 principal 的查證結果。
    if (expectedOwner && (!unchangedOwner(verified.principal, expectedOwner.principal) || !unchangedOwner(verified.server, expectedOwner.server))) throw new AdoptionError('Job ownership changed after the GC identity batch.', 'changed');
    if (automatic && !inAutoAdoptScope(verified, this.projectDir, this.home)) throw new AdoptionError('Job is outside this MCP project.', 'ineligible');
    if (sameIdentity(verified.principal, this.principal)) return { pid: verified.pid, jobId: verified.jobId, alreadyOwned: true };
    const state = await ownerState(verified, lookup);
    if (state === 'alive') throw new AdoptionError('Cannot adopt: the original dispatching session is still alive.', 'ineligible');
    if (state === 'server-alive') throw new AdoptionError('Cannot adopt: principal is null and the dispatching MCP server is still alive. 派工的 MCP server 仍在，這個 job 不是孤兒。', 'ineligible');
    if (state === 'server-unknown') throw new AdoptionError('Cannot adopt: principal is null and the dispatching MCP server cannot be confirmed as ended. 無法確認派工的 MCP server 已結束，視為仍在。', 'ineligible');
    if (state === 'unknown') throw new AdoptionError('無法確認原派工者已結束 (cannot confirm the original dispatching session has ended).', 'ineligible');
    if (state === 'ownerless' && automatic) throw new AdoptionError('Job has neither principal nor server; only manual adoption can take it.', 'ineligible');
    return this.commitAdoption(directory, verified, automatic);
  }
  /**
   * 同步臨界區：拿 lock、重讀比對、原子寫入。不可 await：A/B 都讀到舊 lock 時，B 的回收會刪掉 A 剛取得的新 lock，兩方都能寫入。
   * 殘留 lock 一律由人工確認後清理；所有非同步身分查詢都已在呼叫前完成。
   */
  private commitAdoption(directory: string, verified: JobMeta, automatic: boolean): { pid: number; jobId: string; adopted: true } {
    const lockPath = join(directory, 'adopt.lock');
    let fd: number;
    try { fd = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = json<{ principal?: ProcessIdentity; createdAt?: string }>(lockPath);
      throw new AdoptionError(`Adoption lock exists: ${lockPath}; holder PID: ${lock?.principal?.pid ?? 'unknown'}; created at: ${lock?.createdAt ?? 'unknown'}. 另一個 session 可能正在接管這個 job；若這個檔持續存在（例如接管中的 MCP 當掉），才手動刪除此檔後重試。`, 'locked');
    }
    try {
      try { writeFileSync(fd, JSON.stringify({ principal: this.principal, server: this.server, createdAt: new Date().toISOString() }) + '\n'); }
      finally { closeSync(fd); }
      this.adoptLockHeld?.();
      const current = readJobMeta(directory, verified.jobId, false);
      if (!current || !current.runner.started || current.source !== 'mcp' || !unchangedOwner(current.principal, verified.principal) || !unchangedOwner(current.server, verified.server) || automatic && !inAutoAdoptScope(current, this.projectDir, this.home)) {
        throw new AdoptionError('這個 job 在驗證期間已被其他 session 接管或變更，請重新呼叫 adopt。', 'changed');
      }
      const meta: JobMeta = { ...current, principal: this.principal, server: this.server,
        adoptedFrom: [...(current.adoptedFrom ?? []), { principal: current.principal, server: current.server, adoptedAt: new Date().toISOString() }] };
      atomicJson(join(directory, 'meta.json'), meta);
      this.owned.add(meta.jobId);
      const existing = this.jobs.get(meta.jobId);
      if (existing) { existing.meta = meta; existing.adopted = true; }
      this.scan();
      return { pid: meta.pid, jobId: meta.jobId, adopted: true };
    } finally {
      // 刪不掉（防毒、delete-pending）不可蓋掉已寫入的接管結果；殘鎖照常留給人工確認。
      try { rmSync(lockPath, { force: true }); } catch (error) { console.error(`ai-cli jobs: cannot remove adoption lock ${lockPath}:`, error); }
    }
  }
  async start(cmd: BuiltCommand, model?: string, timeoutMs?: number): Promise<StoredJob> {
    // 直接呼叫底層也要擋。pty-runner 的 spawnPty 刻意不加：runner 本來就帶 worker 標記，加了會連授權的 vendor 都啟動不了。
    assertCanStartJob();
    const pty = process.platform === 'win32' && getAgent(cmd.agent).win32SpawnMode === 'pty';
    // ConPTY 沒有 stdin prompt 通道；現有 agy 只傳 -p argv，不可默默遺失未來的 prompt。
    if (pty && typeof cmd.stdinPrompt === 'string') throw new Error('PTY jobs do not support stdinPrompt');
    const jobId = randomUUID(), directory = join(this.dir, 'jobs', jobId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (cmd.temporaryPromptFile) {
      const target = join(directory, 'prompt.txt');
      try { renameSync(cmd.temporaryPromptFile, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        writeFileSync(target, readFileSync(cmd.temporaryPromptFile), { mode: 0o600 }); rmSync(cmd.temporaryPromptFile);
      }
      cmd.args = cmd.args.map(arg => arg === cmd.temporaryPromptFile ? target : arg);
      cmd.releaseTemporaryPrompt?.();
    }
    if (typeof cmd.stdinPrompt === 'string') writeFileSync(join(directory, 'stdin.tmp'), cmd.stdinPrompt, { mode: 0o600 });
    const metaBase: RunnerSpec['meta'] = { ...(cmd.strict ? { strict: true } : {}), version: 1, jobId, agent: cmd.agent, model, resolvedModel: cmd.resolvedModel, effort: cmd.reasoningEffort,
      task: taskSummary(cmd.prompt), workFolder: cmd.cwd, sessionId: cmd.sessionId, startTime: new Date().toISOString(), source: this.source,
      // cwd 取不到時不寫，該 job 依舊 meta 規則以 workFolder 判定範圍。
      ...(this.source === 'mcp' && this.projectDir !== null ? { projectDir: this.projectDir } : {}),
      server: this.server, principal: this.principal, recoverable: true };
    const spec: RunnerSpec = { command: cmd.cliPath, args: cmd.args, cwd: cmd.cwd, stdin: typeof cmd.stdinPrompt === 'string',
      needsShell: process.platform === 'win32' && !getAgent(cmd.agent).win32DirectExec, ...(pty ? { pty: true } : {}), timeoutMs, meta: metaBase, serverPid: process.pid, principalPid: this.principal?.pid ?? process.ppid };
    atomicJson(join(directory, 'launch.tmp'), spec);
    const viaLauncher = process.platform === 'win32';
    const launchFailure = (error: unknown): Error => {
      const launchError = json<{ error?: string }>(join(directory, 'launcher.json'))?.error;
      const message = `Failed to start ${cmd.agent} runner: ${launchError ?? (error as Error).message}`;
      writeFileSync(join(directory, 'stderr.log'), `Process error: ${message}\n`, { flag: 'a', mode: 0o600 });
      atomicJson(join(directory, 'exit.json'), { exitCode: 1, signal: null, endTime: new Date().toISOString(), timedOut: false, killed: false, error: message });
      rmSync(join(directory, 'stdin.tmp'), { force: true }); rmSync(join(directory, 'launch.tmp'), { force: true });
      return new Error(message);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL(viaLauncher ? './job-launcher.js' : './job-runner.js', import.meta.url)), directory], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), env: buildWorkerEnv(), detached: true, stdio: 'ignore', windowsHide: true });
    } catch (error) { throw launchFailure(error); }
    let pid = child.pid;
    if (viaLauncher) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Runner launcher timed out')); }, 5000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Runner launcher exited with code ${code}`)); });
        });
        const result = json<{ pid?: number; launcherPid?: number; error?: string }>(join(directory, 'launcher.json'));
        if (!result || result.error || !Number.isSafeInteger(result.pid) || result.pid! <= 0 || result.launcherPid !== child.pid) {
          throw new Error(result?.error ?? 'Runner launcher returned no valid runner PID');
        }
        pid = result.pid;
      } catch (error) {
        throw launchFailure(error);
      }
    } else {
      child.on('error', error => { const job = this.jobs.get(jobId); if (job) { job.status = 'failed'; job.closed = true; job.endTime = new Date().toISOString(); job.stderr = error.message; job.process.emit('close', 1); } });
    }
    child.unref();
    if (!pid) { rmSync(directory, { recursive: true, force: true }); throw new Error(`Failed to start ${cmd.agent} runner`); }
    const job = record({ ...metaBase, pid, runner: { pid, started: '', name: 'node' }, worker: null }, directory);
    // 保留摘要與 runner PID，完全不含 prompt；meta 寫入失敗仍可觀察／回收。
    try { atomicJson(join(directory, 'bootstrap.json'), job.meta); }
    catch (error) { console.error('ai-cli jobs: bootstrap write failed:', error); }
    this.jobs.set(job.meta.jobId, job);
    this.owned.add(job.meta.jobId);
    if (viaLauncher) {
      try { atomicJson(join(directory, 'launcher.ready'), { pid }); }
      catch (error) {
        const failure = launchFailure(error); refreshJob(job); throw failure;
      }
    }
    return job;
  }
  refresh(): void { for (const job of this.jobs.values()) { try { refreshJob(job); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.jobs.delete(job.meta.jobId); else throw e; } } }
  /** force 只給 GC 計時器；wait／peek 每 50ms 的 check 一律受 2 秒節流。 */
  async check(lookup = this.lookup, force = false): Promise<void> {
    if (this.checking) return this.checking;
    if (!force && lookup === this.lookup && Date.now() - this.checkedAt < 2000) return;
    this.checking = (async () => {
      if (this.source === 'mcp' && (!this.server || !this.principal)) { await this.identify(); this.scan(); }
      this.refresh();
      const running = [...this.jobs.values()].filter(j => j.status === 'running' && (this.readOnly || sameIdentity(j.meta.server, this.server) || this.owned.has(j.meta.jobId)));
      const candidates = running.map(job => job.meta);
      const gcDue = !this.readOnly && Date.now() - this.collectedAt >= GC_INTERVAL_MS;
      // GC 到期時把全域候選併入同一批 OS 查詢；下一步 GC 直接重用快取。
      if (gcDue) {
        this.identities.clear();
        candidates.push(...readJobMetas(this.dir).filter(meta => !readJobExit(join(this.dir, 'jobs', meta.jobId))));
      }
      const expected = candidates.flatMap(meta => [meta.runner, ...(meta.worker ? [meta.worker] : [])]);
      const autoDue = gcDue && this.autoAdoptEnabled();
      let batch: JobMeta[] = [];
      // 候選篩選失敗只放棄這一輪自動接管，running／lost 判定照常。
      if (autoDue) try { batch = this.autoAdoptMetas(); } catch (error) { console.error('ai-cli jobs auto-adopt candidates:', error); }
      // principal 為 null 時改查派工的 server；存活判斷只需建立時間，不抓命令列。
      if (autoDue) expected.push(...batch.flatMap(meta => { const owner = meta.principal ?? meta.server; return owner ? [owner] : []; }));
      // 同一 PID 的新 job 若帶不同 token，不能套用舊 job 的身分快取。
      for (const id of expected) if (id.started && this.identities.get(id.pid)?.identity.started !== id.started) this.identities.delete(id.pid);
      const pids = expected.map(id => id.pid), queriedAt = Date.now();
      const ids = await (lookup === this.lookup ? this.cachedLookup(pids) : lookup(pids)).catch(error => {
        if (!autoDue) throw error;
        // 合併查詢失敗時不接管；活著但無身分的 principal 仍為 unknown。
        return new Map<number, ProcessIdentity>();
      });
      if (gcDue) this.autoAdoptSnapshot = { metas: batch, identities: ids, at: queriedAt };
      for (const job of running) {
        refreshJob(job); if (job.status !== 'running') continue;
        if (!job.meta.runner.started) {
          if (Date.now() - Date.parse(job.startTime) >= STARTUP_GRACE_MS) {
            job.status = 'lost'; job.closed = true; job.endTime = new Date().toISOString(); job.parsed.error = 'Runner metadata unavailable after startup grace period; worker was not redispatched';
            job.process.emit('close');
          }
          continue;
        }
        const knownGone = (id: ProcessIdentity | null) => !id || (ids.has(id.pid) ? !sameIdentity(id, ids.get(id.pid)) : !mayBeAlive(id.pid));
        if (knownGone(job.meta.runner) && knownGone(job.meta.worker)) {
          job.status = 'lost'; refreshJob(job); job.closed = true; job.endTime = lostTime(job.directory) ?? new Date().toISOString();
          job.process.emit('close');
        }
      }
    })().finally(() => { this.checking = undefined; this.checkedAt = Date.now(); });
    return this.checking;
  }
  /** PID 可重用；UUID 保留全部，PID 查詢只解析到最新 job。 */
  find(pid: number): StoredJob | undefined {
    let latest: StoredJob | undefined;
    for (const job of this.jobs.values()) if (job.pid === pid && (!latest || job.startTime > latest.startTime
      || job.startTime === latest.startTime && job.meta.jobId > latest.meta.jobId)) latest = job;
    return latest;
  }
  hasPid(pid: number): boolean { return this.find(pid) !== undefined; }
  get(pid: number, jobId?: string): StoredJob { const job = jobId ? this.jobs.get(jobId) : this.find(pid); if (!job || job.pid !== pid) throw new Error(`Process with PID ${pid}${jobId ? ` and jobId ${jobId}` : ''} not found`); refreshJob(job); return job; }
  list() { this.refresh(); return [...this.jobs.values()].map(j => ({ pid: j.pid, jobId: j.meta.jobId, agent: j.toolType, model: j.meta.model ?? j.meta.resolvedModel, status: j.status, ...(j.recovered ? { recovered: true } : {}), ...(j.adopted ? { adopted: true } : {}),
    ...listProcessTiming(j.startTime, j.endTime, j.status === 'running' ? buildLiveness(j, j.startTime, true) : undefined) })); }
  async wait(pids: number[], seconds = 180, verbose = false) {
    const deadline = Date.now() + seconds * 1000;
    for (const pid of pids) this.get(pid);
    for (;;) {
      this.refresh();
      if (pids.every(pid => this.get(pid).status !== 'running') || Date.now() >= deadline) break;
      void this.check().catch(e => console.error('ai-cli jobs:', e));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return pids.map(pid => { const result = jobResult(this.get(pid), verbose); if (result.status === 'running') result.timedOut = true; return result; });
  }
  async peek(pids: number[], seconds = 10, includeToolCalls = false) {
    pids = validatePeekPids(pids); seconds = validatePeekTimeSec(seconds); this.refresh();
    const started = Date.now(); const processes: PeekProcessResult[] = [];
    const observers = pids.flatMap(pid => {
      const job = this.find(pid); if (!job) { processes.push(buildNotFoundPeekProcess(pid)); return []; }
      const result: PeekProcessResult = { pid, jobId: job.meta.jobId, agent: job.toolType, status: job.status, events: [], truncated: false, error: null };
      processes.push(result);
      const stdout = new PeekEventExtractor(job.toolType, { includeToolCalls }), stderr = new PeekEventExtractor(job.toolType, { includeToolCalls });
      const onStdout = (b: Buffer) => appendPeekEvents(result, stdout.push(b));
      const onStderr = (b: Buffer) => appendPeekEvents(result, stderr.push(b));
      if (job.status === 'running') { job.process.stdout.on('data', onStdout); job.process.stderr.on('data', onStderr); }
      return [{ job, result, stdout, stderr, onStdout, onStderr }];
    });
    try {
      while (Date.now() < started + seconds * 1000 && observers.some(o => o.job.status === 'running')) { await new Promise(resolve => setTimeout(resolve, 50)); this.refresh(); void this.check().catch(e => console.error('ai-cli jobs:', e)); }
    } finally {
      for (const o of observers) { o.job.process.stdout.off('data', o.onStdout); o.job.process.stderr.off('data', o.onStderr);
        appendPeekEvents(o.result, o.stdout.flush()); appendPeekEvents(o.result, o.stderr.flush()); o.result.status = o.job.status; }
    }
    return { peek_started_at: new Date(started).toISOString(), observed_duration_sec: observedDurationSec(started), processes };
  }
  collect(now = Date.now(), immediate = false): number[] {
    this.refresh();
    const finished = [...this.jobs.values()].filter(j => j.status !== 'running').sort((a, b) => (a.endTime ?? a.startTime).localeCompare(b.endTime ?? b.startTime));
    const bytes = (j: StoredJob) => { try { return readdirSync(j.directory).reduce((sum, f) => sum + statSync(join(j.directory, f)).size, 0); } catch { return 0; } };
    let count = finished.length, total = finished.reduce((sum, j) => sum + bytes(j), 0); const removed: number[] = [];
    for (const job of finished) {
      if (!immediate && now - Date.parse(job.endTime ?? job.startTime) < RETENTION_MS && count <= MAX_FINISHED_JOBS && total <= MAX_FINISHED_BYTES) continue;
      // 第二次確認：完成資料才能刪；遺失 job 的身分必須先由 check 判定。
      if (job.status === 'running') continue;
      if (job.status === 'lost' && !job.meta.runner.started && mayBeAlive(job.pid)) continue;
      if (removeJobDirectory(job.directory)) { total -= bytes(job); count--; this.jobs.delete(job.meta.jobId); this.owned.delete(job.meta.jobId); removed.push(job.pid); }
    }
    return removed;
  }
  async kill(pid: number) {
    await this.ready; const job = this.get(pid); await this.check();
    const startupDeadline = Date.now() + 15000;
    while (!job.meta.runner.started && job.status === 'running' && Date.now() < startupDeadline) { await new Promise(resolve => setTimeout(resolve, 25)); refreshJob(job); }
    if (job.status !== 'running') return { pid, jobId: job.meta.jobId, status: job.status, message: 'Process already terminated' };
    const ids = await this.lookup([job.meta.runner.pid, ...(job.meta.worker ? [job.meta.worker.pid] : [])]);
    if (!sameIdentity(job.meta.runner, ids.get(job.meta.runner.pid))) throw new Error('Runner identity is unavailable or changed; refusing to kill an unverified process');
    // Windows 不用 taskkill runner，讓它有機會落 exit.json；檔案控制通道跨平台可用。
    atomicJson(join(job.directory, 'kill.json'), { runner: job.meta.runner, requestedAt: new Date().toISOString() });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !readJobExit(job.directory)) await new Promise(resolve => setTimeout(resolve, 50));
    refreshJob(job);
    if (job.status === 'running') throw new Error('Runner did not acknowledge termination');
    return { pid, jobId: job.meta.jobId, status: 'terminated', message: 'Process terminated successfully' };
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); }
}
