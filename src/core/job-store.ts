/** 共用持久化 job store。只有 runner 寫 meta/exit，讀端只保存尾端及 byte offset。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { AgentId, BuiltCommand } from '../agents/types.js';
import { getAgent } from '../agents/registry.js';
import { grokResultFailed, collectGrokPromptFiles } from '../agents/grok.js';
import { buildWorkerEnv } from './worker-env.js';
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
  version: 1; jobId: string; pid: number; agent: AgentId; model?: string; resolvedModel: string;
  effort?: string; task: string; workFolder: string; sessionId?: string; startTime: string;
  source: 'mcp' | 'cli'; principal: ProcessIdentity | null; server: ProcessIdentity | null;
  runner: ProcessIdentity; worker: ProcessIdentity | null; recoverable: true;
}
export interface JobExit { exitCode: number | null; signal: string | null; endTime: string; timedOut: boolean; killed: boolean; error?: string }
export interface RunnerSpec {
  command: string; args: string[]; cwd: string; stdin: boolean; needsShell: boolean; timeoutMs?: number;
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
export function readJobMetas(dir: string): JobMeta[] {
  let names: string[]; try { names = readdirSync(join(dir, 'jobs')); } catch { return []; }
  return names.flatMap(name => {
    if (!/^[0-9a-f-]{36}$/.test(name)) return [];
    const directory = join(dir, 'jobs', name);
    // bootstrap 不含 prompt；runner 尚未落 meta 或磁碟失敗時仍可找到並觀察此 job。
    const meta = json<JobMeta>(join(directory, 'meta.json')) ?? json<JobMeta>(join(directory, 'bootstrap.json'));
    return meta?.version === 1 && meta.jobId === name && meta.pid === meta.runner?.pid && typeof meta.runner?.started === 'string' && Number.isFinite(Date.parse(meta.startTime)) ? [meta] : [];
  });
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
  stdout: string; stderr: string; recovered?: true;
  cursors: Record<'stdout' | 'stderr', Cursor>; parsed: Record<string, any>; messageRef?: Reference;
  incompleteUsage?: boolean; terminalRef?: Reference; outputFailed?: boolean;
}
const cursor = (agent: AgentId): Cursor => ({ offset: 0, chars: 0, lineStart: 0, pendingBytes: 0, decoder: new StringDecoder('utf8'), pending: '', extractor: new LivenessEventExtractor(agent), flushed: false });
function record(meta: JobMeta, directory: string, recovered = false): StoredJob {
  return { ...emptyOutputStats(), meta, directory, pid: meta.pid, process: new JobHandle(meta.pid), prompt: meta.task,
    workFolder: meta.workFolder, model: meta.model, resolvedModel: meta.resolvedModel, reasoning_effort: meta.effort,
    toolType: meta.agent, startTime: meta.startTime, closed: false, status: 'running', stdout: '', stderr: '',
    cursors: { stdout: cursor(meta.agent), stderr: cursor(meta.agent) }, parsed: {}, ...(recovered ? { recovered: true as const } : {}) };
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
  const parsed: any = agent.parseOutput(job.toolType === 'claude' ? '{}\n' + text : text, '', job.exitCode, { workFolder: job.workFolder, status: job.status });
  let raw: any; try { raw = JSON.parse(text); } catch { return; }
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
    parsed = { ...(getAgent(job.toolType).parseOutput(stdout, stderr, job.exitCode, { workFolder: job.workFolder, status: job.status }) as object ?? {}), ...parsed };
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
  private server: ProcessIdentity | null = null; private principal: ProcessIdentity | null = null;
  private timer?: NodeJS.Timeout; private checking?: Promise<void>;
  private checkedAt = -Infinity;
  private collecting?: Promise<void>;
  private collectedAt = -Infinity;
  private identities = new Map<number, { identity: ProcessIdentity; checkedAt: number }>();
  private owned = new Set<string>();
  constructor(readonly dir = jobStateDir(), private source: 'mcp' | 'cli' = 'cli', private readOnly = false, private lookup: IdentityLookup = lookupIdentities) {
    this.ready = this.initialize();
    if (!readOnly) { this.timer = setInterval(() => { void this.check().then(async () => {
      if (Date.now() - this.collectedAt >= GC_INTERVAL_MS) { this.collect(); await this.collectAll(); }
    }).catch(e => console.error('ai-cli jobs:', e)); }, 2000); this.timer.unref(); }
  }
  private async initialize(): Promise<void> {
    if (this.source === 'mcp') await this.identify();
    this.scan(); await this.check(); if (!this.readOnly) { this.collect(); await this.collectAll(); }
  }
  private collectAll(): Promise<void> {
    this.collecting ??= collectStoreFiles(this.dir, Date.now(), pids => this.cachedLookup(pids)).then(() => this.scan()).catch(e => console.error('ai-cli jobs GC:', e)).finally(() => { this.collecting = undefined; this.collectedAt = Date.now(); });
    return this.collecting;
  }
  async identify(): Promise<void> {
    try {
      if (!this.server) { const id = (await this.lookup([process.pid])).get(process.pid); this.server = id ? identityOnly(id) : null; }
      if (!this.principal) this.principal = await resolvePrincipal(process.ppid, this.lookup === lookupIdentities ? lookupPrincipalIdentities : this.lookup);
      if (!this.server || !this.principal) console.error(`ai-cli jobs: cannot identify ${!this.server ? 'server' : 'principal'}; retrying on next check`);
    } catch (error) { console.error('ai-cli jobs: identity lookup failed; retrying on next check:', error); }
  }
  private async cachedLookup(pids: number[]): Promise<Map<number, ProcessIdentity>> {
    const result = new Map<number, ProcessIdentity>(), needed: number[] = [], now = Date.now();
    for (const pid of new Set(pids)) {
      if (!mayBeAlive(pid)) { this.identities.delete(pid); continue; }
      const cached = this.identities.get(pid);
      if (cached && now - cached.checkedAt < GC_INTERVAL_MS) result.set(pid, cached.identity);
      else needed.push(pid);
    }
    if (needed.length) for (const [pid, identity] of await this.lookup(needed)) {
      this.identities.set(pid, { identity: identityOnly(identity), checkedAt: now }); result.set(pid, identity);
    }
    return result;
  }
  scan(): void {
    for (const [jobId, job] of this.jobs) if (!existsSync(job.directory)) { this.jobs.delete(jobId); this.owned.delete(jobId); }
    for (const meta of readJobMetas(this.dir)) {
      if (this.source === 'mcp' && (meta.source !== 'mcp' || !sameIdentity(meta.principal, this.principal))) continue;
      if (this.jobs.has(meta.jobId)) continue;
      this.jobs.set(meta.jobId, record(meta, join(this.dir, 'jobs', meta.jobId), this.source === 'mcp'));
    }
  }
  start(cmd: BuiltCommand, model?: string, timeoutMs?: number): StoredJob {
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
    const metaBase: RunnerSpec['meta'] = { version: 1, jobId, agent: cmd.agent, model, resolvedModel: cmd.resolvedModel, effort: cmd.reasoningEffort,
      task: taskSummary(cmd.prompt), workFolder: cmd.cwd, sessionId: cmd.sessionId, startTime: new Date().toISOString(), source: this.source,
      server: this.server, principal: this.principal, recoverable: true };
    const spec: RunnerSpec = { command: cmd.cliPath, args: cmd.args, cwd: cmd.cwd, stdin: typeof cmd.stdinPrompt === 'string',
      needsShell: process.platform === 'win32' && !getAgent(cmd.agent).win32DirectExec, timeoutMs, meta: metaBase, serverPid: process.pid, principalPid: this.principal?.pid ?? process.ppid };
    atomicJson(join(directory, 'launch.tmp'), spec);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./job-runner.js', import.meta.url)), directory], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: buildWorkerEnv(), detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', error => { const job = this.jobs.get(jobId); if (job) { job.status = 'failed'; job.closed = true; job.endTime = new Date().toISOString(); job.stderr = error.message; job.process.emit('close', 1); } });
    child.unref();
    if (!child.pid) { rmSync(directory, { recursive: true, force: true }); throw new Error(`Failed to start ${cmd.agent} runner`); }
    const job = record({ ...metaBase, pid: child.pid, runner: { pid: child.pid, started: '', name: 'node' }, worker: null }, directory);
    // 保留摘要與 runner PID，完全不含 prompt；meta 寫入失敗仍可觀察／回收。
    try { atomicJson(join(directory, 'bootstrap.json'), job.meta); }
    catch (error) { console.error('ai-cli jobs: bootstrap write failed:', error); }
    this.jobs.set(job.meta.jobId, job);
    this.owned.add(job.meta.jobId);
    return job;
  }
  refresh(): void { for (const job of this.jobs.values()) { try { refreshJob(job); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.jobs.delete(job.meta.jobId); else throw e; } } }
  async check(lookup = this.lookup): Promise<void> {
    if (this.checking) return this.checking;
    if (lookup === this.lookup && Date.now() - this.checkedAt < 2000) return;
    this.checking = (async () => {
      if (this.source === 'mcp' && (!this.server || !this.principal)) { await this.identify(); this.scan(); }
      this.refresh();
      const running = [...this.jobs.values()].filter(j => j.status === 'running' && (this.readOnly || sameIdentity(j.meta.server, this.server) || this.owned.has(j.meta.jobId)));
      const candidates = running.map(job => job.meta);
      // GC 到期時把全域候選併入同一批 OS 查詢；下一步 GC 直接重用快取。
      if (!this.readOnly && Date.now() - this.collectedAt >= GC_INTERVAL_MS) {
        this.identities.clear();
        candidates.push(...readJobMetas(this.dir).filter(meta => !readJobExit(join(this.dir, 'jobs', meta.jobId))));
      }
      const expected = candidates.flatMap(meta => [meta.runner, ...(meta.worker ? [meta.worker] : [])]);
      // 同一 PID 的新 job 若帶不同 token，不能套用舊 job 的身分快取。
      for (const id of expected) if (id.started && this.identities.get(id.pid)?.identity.started !== id.started) this.identities.delete(id.pid);
      const pids = expected.map(id => id.pid);
      const ids = lookup === this.lookup ? await this.cachedLookup(pids) : await lookup(pids);
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
  list() { this.refresh(); return [...this.jobs.values()].map(j => ({ pid: j.pid, jobId: j.meta.jobId, agent: j.toolType, status: j.status, ...(j.recovered ? { recovered: true } : {}),
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
