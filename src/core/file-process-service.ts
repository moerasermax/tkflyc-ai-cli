/**
 * 檔案版 process 管理服務（`ai-cli` CLI 的 detached 路徑使用）。
 * 對應 dist/cli-process-service.js。
 *
 * claude/codex 與 MCP 共用 JobStore + detached runner，輸出由 OS fd 直寫。
 * 舊 cwds/meta.json + exit-status.json 保留相容讀取。
 * agy/win32 維持 ConPTY；direct-api 維持行程內 HTTP。
 *
 * spawn/parser 決策改由 registry 驅動。
 */

import { spawn } from 'node:child_process';
import { buildWorkerEnv } from './worker-env.js';
import { JobStore, jobResult, jobSummary } from './job-store.js';
import { lookupIdentities, retainedJob, shortText, taskSummary, type IdentityLookup, type JobDispatcher, type LiveJob } from './live-jobs.js';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { AgentId } from '../agents/types.js';
import { getAgent } from '../agents/registry.js';
import { buildCliCommand, type BuildCliCommandOptions } from './command-builder.js';
import { resolveAllCliPaths } from './doctor.js';
import { buildProcessResult } from './process-result.js';
import { buildLiveness, emptyOutputStats, listProcessTiming, type ProcessOutputStats } from './liveness.js';
import { stripAnsi } from './ansi.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  LivenessEventExtractor,
  PeekEventExtractor,
} from './peek-extractor.js';
import {
  appendPeekEvents,
  buildNotFoundPeekProcess,
  observedDurationSec,
  validatePeekPids,
  validatePeekTimeSec,
  type PeekProcessResult,
} from './peek.js';

const SIGTERM_EXIT_CODE = 143;
const pendingJobIdentities = new Set<Promise<unknown>>();
/** CLI 已送出 PID 後，退出前等 metadata 補寫完成，避免強制退出截斷查詢。 */
export async function flushJobIdentities(): Promise<void> { await Promise.all([...pendingJobIdentities]); }

const patchRequire = createRequire(import.meta.url);
let ptyModule: any = null;
function loadPtyModule(): any {
  if (ptyModule) return ptyModule;
  ptyModule = patchRequire('@homebridge/node-pty-prebuilt-multiarch');
  return ptyModule;
}

function resolveDefaultStateDir(): string {
  return process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function normalizeCwdForStorage(cwd: string): string {
  return cwd
    .split('')
    .map((char) =>
      /^[A-Za-z0-9.-]$/.test(char) ? char : `_${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    )
    .join('');
}

interface StoredProcess extends ProcessOutputStats {
  pid: number;
  prompt: string;
  workFolder: string;
  cwdKey: string;
  model?: string;
  reasoning_effort?: string;
  dispatcher?: JobDispatcher;
  processStarted?: string;
  resolvedModel?: string;
  toolType: AgentId;
  startTime: string;
  endTime?: string;
  stdoutPath: string;
  stderrPath: string;
  /**
   * ★ `lost` 與 `failed` 是**不同的事**，不可互換：
   *     failed = 收到了結束回報，而它是失敗的
   *     lost   = **沒有收到結束回報**，我們不知道它怎麼結束的
   *
   *   舊版把「PID 不見了但沒有 exit-status」直接寫成 `failed`——
   *   那是拿一個看起來合理的結論蓋掉「不知道」。呼叫端會據此判定
   *   任務失敗並重跑，而它可能其實成功了。
   */
  status: 'running' | 'completed' | 'failed' | 'lost';
  exitCode?: number;
}

export interface FileStartOptions {
  prompt?: string;
  prompt_file?: string;
  cwd: string;
  model?: string;
  session_id?: string;
  reasoning_effort?: string;
  /**
   * 只給這些能力 → 走 agent 的 strict builder（fail-closed，見 command-builder.ts）。
   * 這一條與 process-service 必須同時支援：兩條啟動路徑只有一條擋得住，
   * 等於呼叫端要看運氣才知道自己有沒有被限制住。
   */
  capabilities?: readonly string[];
}

export class FileProcessService {
  private stateDir: string;
  private store: JobStore;
  private gc?: NodeJS.Timeout;
  private cliPaths: Partial<Record<AgentId, string>>;
  private ptyManagedPids = new Set<number>();
  private breaker: CircuitBreaker;
  private directPidSequence = 0;
  private dispatcher: JobDispatcher = { pid: process.pid, parentPid: process.ppid };
  private dispatcherReady?: Promise<JobDispatcher>;
  private identityLookup: IdentityLookup;
  private outputEvents = new Map<string, {
    startTime: string;
    offset: number;
    extractor: LivenessEventExtractor;
    lastEvent: string | null;
    eventCount: number;
    lastEventAt: number;
  }>();

  constructor(
    options: { stateDir?: string; cliPaths?: Partial<Record<AgentId, string>>; breaker?: CircuitBreaker; readOnly?: boolean; identityLookup?: IdentityLookup } = {}
  ) {
    this.stateDir = options.stateDir || resolveDefaultStateDir();
    this.cliPaths = options.cliPaths || resolveAllCliPaths();
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.identityLookup = options.identityLookup ?? lookupIdentities;
    this.store = new JobStore(this.stateDir, 'cli', !!options.readOnly);
    if (!options.readOnly) {
      this.gc = setInterval(() => this.collectLegacy(), 60000); this.gc.unref();
      this.collectLegacy();
    }
    if (!options.readOnly) mkdirSync(this.stateDir, { recursive: true });
  }

  async startProcess(options: FileStartOptions) {
    const cmd = buildCliCommand({
      prompt: options.prompt,
      prompt_file: options.prompt_file,
      workFolder: options.cwd,
      model: options.model,
      session_id: options.session_id,
      reasoning_effort: options.reasoning_effort,
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
      cliPaths: this.cliPaths,
    } as BuildCliCommandOptions);
    cmd.sessionId = options.session_id;
    // 熔斷器：偵測同一行程內框架迴圈造成的爆量/重複啟動。
    this.breaker.check(cmd.agent, cmd.prompt);
    const result = await this.startDetachedTracked(cmd, options.model);
    return { ...result, ...((cmd.warnings || 'warnings' in result) ? { warnings: [...('warnings' in result ? result.warnings as string[] : []), ...(cmd.warnings ?? [])] } : {}) };
  }

  private async startDetachedTracked(cmd: ReturnType<typeof buildCliCommand>, model?: string) {
    const agent = getAgent(cmd.agent);
    const isWin = process.platform === 'win32';
    const spawnMode = isWin && agent.win32SpawnMode ? agent.win32SpawnMode : agent.spawnMode || 'pipe';
    if (spawnMode === 'direct') {
      return this.startDirectTracked(cmd, model);
    }
    if (spawnMode === 'pty') {
      return this.startPtyTracked(cmd, model);
    }

    if (cmd.agent !== 'antigravity') {
      await this.store.ready; await this.store.identify();
      const job = this.store.start(cmd, model);
      const pending = this.waitForRunnerMeta(job.pid);
      pendingJobIdentities.add(pending);
      const warning = await pending.finally(() => pendingJobIdentities.delete(pending));
      return { pid: job.pid, jobId: job.meta.jobId, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully`, ...(warning ? { warnings: [warning] } : {}) };
    }
    return this.startLegacyDetached(cmd, model);
  }

  private async waitForRunnerMeta(pid: number): Promise<string | undefined> {
    const job = this.store.get(pid), deadline = Date.now() + 15000;
    while (!existsSync(join(job.directory, 'meta.json'))) {
      if (Date.now() >= deadline) return 'Runner metadata handshake timed out; job has already been launched. Track this pid/jobId; do not redispatch.';
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.store.get(pid);
  }

  private async startLegacyDetached(cmd: ReturnType<typeof buildCliCommand>, model?: string) {
    const cwdKey = this.resolveCwdKey(cmd.cwd);
    const child = spawn(this.ensureDetachedWrapperScript(), [this.stateDir, cwdKey, cmd.cliPath, ...cmd.args], { env: buildWorkerEnv(), cwd: cmd.cwd, detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
    if (!child.pid) throw new Error(`Failed to start ${cmd.agent} CLI process`);
    const processDir = this.resolveProcessDir(cmd.cwd, child.pid); mkdirSync(processDir, { recursive: true });
    const stdoutPath = this.resolveStdoutPath(processDir), stderrPath = this.resolveStderrPath(processDir);
    this.touchFile(stdoutPath); this.touchFile(stderrPath);
    const stored: StoredProcess = { ...emptyOutputStats(), pid: child.pid, prompt: cmd.prompt, workFolder: cmd.cwd, cwdKey, model, resolvedModel: cmd.resolvedModel,
      reasoning_effort: cmd.reasoningEffort, dispatcher: this.dispatcher, toolType: cmd.agent, startTime: new Date().toISOString(), stdoutPath, stderrPath, status: 'running' };
    this.writeProcess(stored); this.trackJobIdentity(stored);
    return { pid: stored.pid, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully` };
  }

  private allocateDirectPid(): number {
    return Date.now() * 1000 + ++this.directPidSequence;
  }

  private async startDirectTracked(
    cmd: ReturnType<typeof buildCliCommand>,
    model?: string
  ): Promise<{ pid: number; status: string; agent: AgentId; message: string }> {
    const agent = getAgent(cmd.agent);
    if (!agent.runDirect) {
      throw new Error(`${cmd.agent} does not implement direct execution`);
    }
    const cwdKey = this.resolveCwdKey(cmd.cwd);
    const pid = this.allocateDirectPid();
    const startTime = new Date().toISOString();
    const processDir = this.resolveProcessDir(cmd.cwd, pid);
    mkdirSync(processDir, { recursive: true });
    const stdoutPath = this.resolveStdoutPath(processDir);
    const stderrPath = this.resolveStderrPath(processDir);
    this.touchFile(stdoutPath);
    this.touchFile(stderrPath);
    const stored: StoredProcess = {
      ...emptyOutputStats(),
      pid,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      cwdKey,
      model,
      resolvedModel: cmd.resolvedModel,
      reasoning_effort: cmd.reasoningEffort || undefined,
      dispatcher: this.dispatcher,
      toolType: cmd.agent,
      startTime,
      stdoutPath,
      stderrPath,
      status: 'running',
    };
    this.writeProcess(stored);
    this.trackJobIdentity(stored);

    try {
      await agent.runDirect(cmd, {
        stdout: (chunk) => this.appendTextFileSafe(stdoutPath, chunk),
        stderr: (chunk) => this.appendTextFileSafe(stderrPath, chunk),
      });
      stored.status = 'completed';
      stored.exitCode = 0;
      this.writeExitStatus(stored, { status: 'completed', exitCode: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendTextFileSafe(stderrPath, `\nDirect API error: ${message}`);
      stored.status = 'failed';
      stored.exitCode = 1;
      this.writeExitStatus(stored, { status: 'failed', exitCode: 1 });
    }
    stored.endTime = new Date().toISOString();
    this.writeProcess(stored);
    return {
      pid,
      status: stored.status,
      agent: cmd.agent,
      message: `${cmd.agent} request ${stored.status}`,
    };
  }

  /**
   * Windows detached spawn：用 Node 腳本當 wrapper（避開 batch 引號地獄）。
   * Node 子程序可取得自己的 PID，對齊 FileProcessService 的 PID→目錄映射。
   */
  private async startPtyTracked(cmd: ReturnType<typeof buildCliCommand>, model?: string) {
    const pty = loadPtyModule();
    const cwdKey = this.resolveCwdKey(cmd.cwd);
    const ptyProc = pty.spawn(cmd.cliPath, cmd.args, {
      name: 'xterm-color',
      cols: 200,
      rows: 50,
      cwd: cmd.cwd,
      env: buildWorkerEnv(),
    });
    const pid: number | undefined = ptyProc.pid;
    if (!pid) {
      throw new Error(`Failed to start ${cmd.agent} CLI process (pty.spawn returned no pid)`);
    }
    const startTime = new Date().toISOString();
    const processDir = this.resolveProcessDir(cmd.cwd, pid);
    mkdirSync(processDir, { recursive: true });
    const stdoutPath = this.resolveStdoutPath(processDir);
    const stderrPath = this.resolveStderrPath(processDir);
    const exitStatusPath = this.resolveExitStatusPath(processDir);
    this.touchFile(stdoutPath);
    this.touchFile(stderrPath);
    this.ptyManagedPids.add(pid);
    ptyProc.onData((d: string) => {
      try {
        appendFileSync(stdoutPath, stripAnsi(d));
      } catch {
        /* ignore */
      }
    });
    ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
      const code = exitCode ?? 0;
      const status = code === 0 ? 'completed' : 'failed';
      try {
        const tmp = exitStatusPath + '.' + pid;
        writeFileSync(tmp, JSON.stringify({ status, exitCode: code }, null, 2));
        renameSync(tmp, exitStatusPath);
      } catch {
        /* ignore */
      }
      this.ptyManagedPids.delete(pid);
    });
    const stored: StoredProcess = {
      ...emptyOutputStats(),
      pid,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      cwdKey,
      model,
      resolvedModel: cmd.resolvedModel,
      reasoning_effort: cmd.reasoningEffort || undefined,
      dispatcher: this.dispatcher,
      toolType: cmd.agent,
      startTime,
      stdoutPath,
      stderrPath,
      status: 'running',
    };
    this.writeProcess(stored);
    this.trackJobIdentity(stored);
    return {
      pid,
      status: 'started',
      agent: cmd.agent,
      message: `${cmd.agent} process started successfully (pty mode)`,
    };
  }

  async listProcesses() {
    await this.store.ready; this.store.scan(); await this.store.check();
    if (this.gc) { this.store.collect(); this.collectLegacy(); }
    return [...this.store.list(), ... this.readAllProcesses().map((stored) => {
      const proc = this.refreshStatus(stored);
      const liveness = proc.status === 'running' ? this.processLiveness(proc) : undefined;
      return {
        pid: proc.pid,
        agent: proc.toolType,
        status: proc.status,
        ...listProcessTiming(proc.startTime, proc.endTime, liveness),
      };
    })];
  }

  private trackJobIdentity(stored: StoredProcess): void {
    const pid = stored.toolType === 'direct-api' ? process.pid : stored.pid;
    // 第一個 job 同批取得 dispatcher 與 child；之後只查 child，dispatcher 在 instance 共用。
    const ids = this.identityLookup(this.dispatcherReady ? [pid] : [pid, process.pid, process.ppid]);
    this.dispatcherReady ??= ids.then(identities => {
      this.dispatcher = { pid: process.pid, started: identities.get(process.pid)?.started,
        parentPid: process.ppid, parentName: identities.get(process.ppid)?.name };
      return this.dispatcher;
    }).catch(() => this.dispatcher);
    const pending = Promise.all([ids, this.dispatcherReady]).then(([identities, dispatcher]) => {
      stored.processStarted = identities.get(pid)?.started;
      stored.dispatcher = dispatcher;
      // cleanup／狀態更新可能先發生；只補身分，不能重建或覆寫較新的狀態。
      const path = this.resolveMetaPath(this.resolveStoredProcessDir(stored));
      const current = this.parseProcessFile(path);
      if (current.startTime !== stored.startTime) return;
      current.processStarted = stored.processStarted;
      current.dispatcher = dispatcher;
      this.writeProcess(current);
    }).catch(() => {}).finally(() => pendingJobIdentities.delete(pending));
    pendingJobIdentities.add(pending);
  }

  /** jobs 專用唯讀投影：不呼叫 refreshStatus，不改 meta／stderr，也不建立目錄。 */
  async listJobSummaries(lookup: IdentityLookup = lookupIdentities, now = Date.now()): Promise<LiveJob[]> {
    await this.store.ready; this.store.scan(); await this.store.check(lookup);
    const processes = this.readAllProcesses();
    const identities = await lookup(processes.filter(proc => proc.status === 'running').map(proc =>
      proc.toolType === 'direct-api' && proc.dispatcher ? proc.dispatcher.pid : proc.pid));
    const jobs: LiveJob[] = [...this.store.jobs.values()].map(job => jobSummary(job, now)).filter(job => retainedJob(job, now));
    for (const proc of processes) {
      try {
        let identityVerified: boolean | undefined;
        const exit = this.readExitStatus(proc);
        if (exit) { proc.status = exit.status; proc.endTime = exit.endTime; }
        if (proc.status === 'running') {
          const pid = proc.toolType === 'direct-api' && proc.dispatcher ? proc.dispatcher.pid : proc.pid;
          const started = proc.toolType === 'direct-api' ? proc.dispatcher?.started : proc.processStarted;
          const identity = identities.get(pid);
          identityVerified = !!identity && started !== undefined && identity.started === started;
          // 缺建立時間／查詢暫時失敗但 PID 仍在，顯示 running 並標示未驗證。
          if ((!identity && !isProcessRunning(pid)) || (identity && started !== undefined && identity.started !== started)) {
            proc.status = 'lost';
            proc.endTime = statSync(this.resolveMetaPath(this.resolveStoredProcessDir(proc))).mtime.toISOString();
          }
        }
        const liveness = this.processLiveness(proc);
        const job: LiveJob = {
          pid: proc.pid, agent: proc.toolType, model: proc.resolvedModel || proc.model || null, reasoning_effort: proc.reasoning_effort ?? null,
          task: taskSummary(proc.prompt), workFolder: proc.workFolder, status: proc.status,
          startTime: proc.startTime, endTime: proc.endTime,
          elapsedSec: Math.max(0, ((proc.endTime ? Date.parse(proc.endTime) : now) - Date.parse(proc.startTime)) / 1000),
          sinceLastOutputSec: liveness.sinceLastOutputSec,
          lastEvent: proc.lastEvent === null ? null : shortText(proc.lastEvent, 80),
          dispatcher: proc.dispatcher ?? { pid: 0, parentPid: 0 }, source: 'cli', identityVerified,
        };
        if (retainedJob(job, now)) jobs.push(job);
      } catch { /* 單個 job 正被 cleanup 移除或檔案損壞，略過它。 */ }
    }
    return jobs;
  }

  async getProcessResult(pid: number, verbose = false, jobId?: string) {
    await this.store.ready; this.store.scan(); await this.store.check();
    if (jobId || this.store.hasPid(pid)) return jobResult(this.store.get(pid, jobId), verbose);
    const stored = this.readProcess(pid);
    const refreshed = this.refreshStatus(stored);
    const stdout = this.readTextFileSafe(refreshed.stdoutPath);
    const stderr = this.readTextFileSafe(refreshed.stderrPath);
    const agent = getAgent(refreshed.toolType);
    const agentOutput = agent.parseOutput(stdout, stderr, refreshed.exitCode, {
      workFolder: refreshed.workFolder,
      status: refreshed.status,
    });
    return buildProcessResult(
      {
        pid,
        agent: refreshed.toolType,
        status: refreshed.status,
        exitCode: refreshed.exitCode,
        startTime: refreshed.startTime,
        workFolder: refreshed.workFolder,
        prompt: refreshed.prompt,
        model: refreshed.model,
        stdout,
        stderr,
        liveness: refreshed.status === 'running' ? this.processLiveness(refreshed) : undefined,
      },
      agentOutput,
      verbose
    );
  }

  async waitForProcesses(pids: number[], timeoutSeconds = 180, verbose = false) {
    await this.store.ready; this.store.scan();
    if (pids.every(pid => this.store.hasPid(pid))) return this.store.wait(pids, timeoutSeconds, verbose);
    const start = Date.now();
    for (const pid of pids) if (!this.store.hasPid(pid)) this.readProcess(pid);
    for (;;) {
      const statuses = pids.map((pid) => this.store.hasPid(pid) ? this.store.get(pid).status : this.refreshStatus(this.readProcess(pid)).status);
      if (statuses.every((status) => status !== 'running')) {
        return Promise.all(pids.map((pid) => this.getProcessResult(pid, verbose)));
      }
      if (Date.now() - start >= timeoutSeconds * 1000) {
        const results = await Promise.all(pids.map((pid) => this.getProcessResult(pid, verbose)));
        for (const result of results) {
          if (result.status === 'running') result.timedOut = true;
        }
        return results;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async peekProcesses(pids: number[], peekTimeSec = 10, includeToolCalls = false): Promise<{ peek_started_at: string; observed_duration_sec: number; processes: PeekProcessResult[] }> {
    await this.store.ready; this.store.scan();
    const persistent = pids.filter(pid => this.store.hasPid(pid));
    if (persistent.length === pids.length) return this.store.peek(pids, peekTimeSec, includeToolCalls);
    if (persistent.length) {
      const results = await Promise.all([this.store.peek(persistent, peekTimeSec, includeToolCalls), this.peekProcesses(pids.filter(pid => !this.store.hasPid(pid)), peekTimeSec, includeToolCalls)]);
      return { ...results[0], processes: pids.map(pid => results.flatMap(r => r.processes).find(p => p.pid === pid)!) };
    }
    const targetPids = validatePeekPids(pids);
    const targetPeekTimeSec = validatePeekTimeSec(peekTimeSec);
    const processes: PeekProcessResult[] = [];
    const observers: Array<{
      process: StoredProcess;
      result: PeekProcessResult;
      stdoutExtractor: PeekEventExtractor;
      stderrExtractor: PeekEventExtractor;
      stdoutOffset: number;
      stderrOffset: number;
    }> = [];

    for (const pid of targetPids) {
      let proc: StoredProcess;
      try {
        proc = this.refreshStatus(this.readProcess(pid));
      } catch {
        processes.push(buildNotFoundPeekProcess(pid));
        continue;
      }
      const result: PeekProcessResult = {
        pid,
        agent: proc.toolType,
        status: proc.status,
        events: [],
        truncated: false,
        error: null,
      };
      processes.push(result);
      observers.push({
        process: proc,
        result,
        stdoutExtractor: new PeekEventExtractor(proc.toolType, { includeToolCalls }),
        stderrExtractor: new PeekEventExtractor(proc.toolType, { includeToolCalls }),
        stdoutOffset: this.fileSizeSafe(proc.stdoutPath),
        stderrOffset: this.fileSizeSafe(proc.stderrPath),
      });
    }

    const startedAt = new Date();
    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + targetPeekTimeSec * 1000;
    while (Date.now() <= deadlineMs) {
      const observedAt = new Date().toISOString();
      let allTerminal = true;
      for (const observer of observers) {
        const stdoutRead = this.readTextFromOffset(observer.process.stdoutPath, observer.stdoutOffset);
        observer.stdoutOffset = stdoutRead.offset;
        appendPeekEvents(observer.result, observer.stdoutExtractor.push(stdoutRead.text, observedAt));
        const stderrRead = this.readTextFromOffset(observer.process.stderrPath, observer.stderrOffset);
        observer.stderrOffset = stderrRead.offset;
        appendPeekEvents(observer.result, observer.stderrExtractor.push(stderrRead.text, observedAt));
        observer.process = this.refreshStatus(this.readProcess(observer.process.pid));
        observer.result.status = observer.process.status;
        if (observer.process.status === 'running') allTerminal = false;
      }
      if (allTerminal) break;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
    }

    const flushTs = new Date().toISOString();
    for (const observer of observers) {
      observer.process = this.refreshStatus(this.readProcess(observer.process.pid));
      observer.result.status = observer.process.status;
      appendPeekEvents(observer.result, observer.stdoutExtractor.flush(flushTs));
      appendPeekEvents(observer.result, observer.stderrExtractor.flush(flushTs));
    }
    return {
      peek_started_at: startedAt.toISOString(),
      observed_duration_sec: observedDurationSec(startedAtMs),
      processes,
    };
  }

  async killProcess(pid: number) {
    await this.store.ready; this.store.scan();
    if (this.store.hasPid(pid)) return this.store.kill(pid);
    const proc = this.readProcess(pid);
    const refreshed = this.refreshStatus(proc);
    if (refreshed.status !== 'running') {
      return { pid, status: refreshed.status, message: 'Process already terminated' };
    }
    this.killPidOrGroup(pid, 'SIGTERM');
    await this.waitForProcessExit(pid, 250);
    if (isProcessRunning(pid)) {
      return { pid, status: 'running', message: 'Signal sent but process is still running' };
    }
    const exitStatus = this.readExitStatus(refreshed);
    if (exitStatus) {
      refreshed.status = exitStatus.status;
      refreshed.exitCode = exitStatus.exitCode;
      refreshed.endTime = exitStatus.endTime;
    } else {
      /*
        我們送了 SIGTERM，程序也不見了，但**沒有拿到結束回報**。
        「被我們砍掉」不等於「失敗」——它可能在收到信號前就已經做完。
        照實記 lost，讓呼叫端自己決定要不要重跑。
      */
      refreshed.status = 'lost';
      refreshed.exitCode = SIGTERM_EXIT_CODE;
      this.writeExitStatus(refreshed, { status: 'lost', exitCode: SIGTERM_EXIT_CODE });
    }
    this.writeProcess(refreshed);
    return { pid, status: 'terminated', message: 'Process terminated successfully' };
  }

  async cleanupProcesses() {
    await this.store.ready; this.store.scan(); await this.store.check();
    let removed = this.store.collect(Date.now(), true).length;
    for (const proc of this.readAllProcesses()) {
      const refreshed = this.refreshStatus(proc);
      if (refreshed.status === 'running') continue;
      const processDir = this.resolveStoredProcessDir(refreshed);
      if (existsSync(processDir)) {
        rmSync(processDir, { recursive: true, force: true });
        this.outputEvents.delete(refreshed.stdoutPath);
        this.outputEvents.delete(refreshed.stderrPath);
        removed++;
      }
    }
    this.removeEmptyCwdDirs();
    return { removed, message: `Removed ${removed} processes` };
  }

  // ---- 內部：儲存/狀態 ----

  private collectLegacy(now = Date.now()): void {
    for (const stored of this.readAllProcesses()) {
      const proc = this.refreshStatus(stored);
      if (proc.status !== 'running' && proc.endTime && now - Date.parse(proc.endTime) >= 30 * 60 * 1000) {
        rmSync(this.resolveStoredProcessDir(proc), { recursive: true, force: true });
        this.outputEvents.delete(proc.stdoutPath); this.outputEvents.delete(proc.stderrPath);
      }
    }
  }
  dispose(): void { this.store.dispose(); if (this.gc) clearInterval(this.gc); }

  private readAllProcesses(): StoredProcess[] {
    const cwdsDir = this.resolveCwdsDir();
    if (!existsSync(cwdsDir)) return [];
    const processes: StoredProcess[] = [];
    for (const cwdEntry of readdirSync(cwdsDir)) {
      const cwdDir = join(cwdsDir, cwdEntry);
      let pidEntries: string[];
      try { pidEntries = readdirSync(cwdDir); } catch { continue; }
      for (const pidEntry of pidEntries) {
        const metaPath = join(cwdDir, pidEntry, 'meta.json');
        if (existsSync(metaPath)) { try { processes.push(this.parseProcessFile(metaPath)); } catch {} }
      }
    }
    return processes;
  }

  private readProcess(pid: number): StoredProcess {
    const proc = this.readAllProcesses().find((entry) => entry.pid === pid);
    if (!proc) throw new Error(`Process with PID ${pid} not found`);
    return proc;
  }

  private parseProcessFile(metaPath: string): StoredProcess {
    const proc = { ...emptyOutputStats(), ...JSON.parse(readFileSync(metaPath, 'utf-8')) } as StoredProcess;
    if (!proc.cwdKey) proc.cwdKey = basename(dirname(dirname(metaPath)));
    return proc;
  }

  private writeProcess(proc: StoredProcess): void {
    const processDir = this.resolveStoredProcessDir(proc);
    mkdirSync(processDir, { recursive: true });
    const metaPath = this.resolveMetaPath(processDir);
    const temporary = `${metaPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(proc, null, 2));
    renameSync(temporary, metaPath);
  }

  private refreshStatus(proc: StoredProcess): StoredProcess {
    if (proc.status !== 'running') return proc;
    const persisted = this.readExitStatus(proc);
    if (persisted) {
      proc.status = persisted.status;
      proc.exitCode = persisted.exitCode;
      proc.endTime = persisted.endTime;
      this.writeProcess(proc);
      return proc;
    }
    if (!isProcessRunning(proc.pid)) {
      // pty-managed：OS 報告 pid 消失可能早於 onExit 寫 exit-status，先維持 running
      if (this.ptyManagedPids.has(proc.pid)) return proc;
      /*
        PID 不見了，但**沒有**結束回報。我們不知道它是成功還是失敗
        ——說 failed 是拿一個看起來合理的結論蓋掉「不知道」。
        呼叫端會據此判定任務失敗並重跑，而它可能其實成功了。
      */
      proc.status = 'lost';
      proc.endTime = new Date().toISOString();
      this.appendTextFileSafe(
        proc.stderrPath,
        '\nProcess disappeared without exit-status metadata; marking as lost ' +
          '(NOT failed — no terminal report was received).\n'
      );
      this.writeProcess(proc);
    }
    return proc;
  }

  private readExitStatus(proc: StoredProcess): { status: 'completed' | 'failed'; exitCode: number; endTime: string } | null {
    const exitMetaPath = this.resolveExitStatusPath(this.resolveStoredProcessDir(proc));
    if (!existsSync(exitMetaPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(exitMetaPath, 'utf-8'));
      if (parsed.status === 'completed' || parsed.status === 'failed') {
        // 舊 wrapper 沒寫結束時間；exit-status 檔的 mtime 是結束時刻的近似值。
        return { ...parsed, endTime: statSync(exitMetaPath).mtime.toISOString() };
      }
    } catch {
      return null;
    }
    return null;
  }

  private writeExitStatus(proc: StoredProcess, exitStatus: { status: string; exitCode: number }): void {
    const exitStatusPath = this.resolveExitStatusPath(this.resolveStoredProcessDir(proc));
    const tempPath = `${exitStatusPath}.${proc.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(exitStatus, null, 2) + '\n');
    renameSync(tempPath, exitStatusPath);
  }

  private readTextFileSafe(filePath: string): string {
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8');
  }

  private touchFile(filePath: string): void {
    closeSync(openSync(filePath, 'a'));
  }

  private appendTextFileSafe(filePath: string, text: string): void {
    try {
      appendFileSync(filePath, text);
    } catch {
      /* ignore */
    }
  }

  private fileSizeSafe(filePath: string): number {
    if (!existsSync(filePath)) return 0;
    return statSync(filePath).size;
  }

  /**
   * 選擇讀端推導：size / mtime 可跨 CLI 行程取得，零 bytes 的空檔不算曾有輸出。
   * eventCount 要完整計數，所以新讀端首次逐塊掃描（16 KiB，不保留整份文字），
   * 同一讀端之後只解碼新增 bytes；半行保留到下個 chunk，避免重算事件。
   * 兩個串流的事件先後只能以各自 mtime 近似，不在 meta 製造多 writer 競爭。
   */
  private processLiveness(proc: StoredProcess) {
    const outputs = (['stdout', 'stderr'] as const).map((stream) => {
      const filePath = proc[stream === 'stdout' ? 'stdoutPath' : 'stderrPath'];
      const stat = existsSync(filePath) ? statSync(filePath) : null;
      const size = stat?.size ?? 0;
      let cached = this.outputEvents.get(filePath);
      if (!cached || cached.startTime !== proc.startTime || size < cached.offset) {
        cached = { startTime: proc.startTime, offset: 0, extractor: new LivenessEventExtractor(proc.toolType),
          lastEvent: null, eventCount: 0, lastEventAt: 0 };
        this.outputEvents.set(filePath, cached);
      }
      if (size > cached.offset) {
        const fd = openSync(filePath, 'r');
        try {
          const buffer = Buffer.alloc(16 * 1024);
          while (cached.offset < size) {
            const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - cached.offset), cached.offset);
            if (!read) break;
            cached.offset += read;
            const events = cached.extractor.push(buffer.subarray(0, read));
            cached.eventCount += events.length;
            if (events.length) {
              cached.lastEvent = events[events.length - 1];
              cached.lastEventAt = stat!.mtimeMs;
            }
          }
        } finally {
          closeSync(fd);
        }
      }
      proc[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] = size;
      return { ...cached, outputAt: size > 0 ? stat!.mtimeMs : null };
    });
    const outputTimes = outputs.flatMap((output) => output.outputAt === null ? [] : [output.outputAt]);
    proc.lastOutputAt = outputTimes.length ? new Date(Math.max(...outputTimes)).toISOString() : null;
    proc.eventCount = outputs.reduce((sum, output) => sum + output.eventCount, 0);
    proc.lastEvent = outputs.sort((a, b) => b.lastEventAt - a.lastEventAt)[0].lastEvent;
    return buildLiveness(proc, proc.startTime, isProcessRunning(proc.pid) && !this.readExitStatus(proc));
  }

  private readTextFromOffset(filePath: string, offset: number): { text: string; offset: number } {
    if (!existsSync(filePath)) return { text: '', offset };
    const size = statSync(filePath).size;
    if (size <= offset) return { text: '', offset: size };
    const fd = openSync(filePath, 'r');
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      return { text: buffer.subarray(0, bytesRead).toString('utf-8'), offset: size };
    } finally {
      closeSync(fd);
    }
  }

  private resolveCwdsDir(): string {
    return join(this.stateDir, 'cwds');
  }
  private resolveProcessDir(cwd: string, pid: number): string {
    return join(this.resolveCwdsDir(), this.resolveCwdKey(cwd), String(pid));
  }
  private resolveStoredProcessDir(proc: StoredProcess): string {
    if (!proc.cwdKey) proc.cwdKey = this.resolveCwdKey(proc.workFolder);
    return join(this.resolveCwdsDir(), proc.cwdKey, String(proc.pid));
  }
  private resolveCwdKey(cwd: string): string {
    return normalizeCwdForStorage(realpathSync(cwd));
  }
  private resolveMetaPath(processDir: string): string {
    return join(processDir, 'meta.json');
  }
  private resolveStdoutPath(processDir: string): string {
    return join(processDir, 'stdout.log');
  }
  private resolveStderrPath(processDir: string): string {
    return join(processDir, 'stderr.log');
  }
  private resolveExitStatusPath(processDir: string): string {
    return join(processDir, 'exit-status.json');
  }
  private resolveDetachedWrapperPath(): string {
    return join(this.stateDir, 'detached-runner-v2.sh');
  }

  private ensureDetachedWrapperScript(): string {
    const wrapperPath = this.resolveDetachedWrapperPath();
    this.removeLegacyDetachedWrappers();
    if (existsSync(wrapperPath)) return wrapperPath;
    writeFileSync(
      wrapperPath,
      `#!/bin/sh
set +e
state_dir="$1"
cwd_key="$2"
shift 2
pid="$$"
process_dir="$state_dir/cwds/$cwd_key/$pid"
stdout_path="$process_dir/stdout.log"
stderr_path="$process_dir/stderr.log"
exit_meta_path="$process_dir/exit-status.json"
mkdir -p "$process_dir"
: > "$stdout_path"
: > "$stderr_path"
write_exit_status() {
  status="$1"
  exit_code="$2"
  tmp_exit_meta_path="$exit_meta_path.$$"
  printf '{\\n  "status": "%s",\\n  "exitCode": %s\\n}\\n' "$status" "$exit_code" > "$tmp_exit_meta_path"
  mv "$tmp_exit_meta_path" "$exit_meta_path"
}
handle_signal() {
  signal="$1"
  exit_code="$2"
  if [ -n "\${child_pid:-}" ]; then
    kill "-$signal" "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null
  fi
  write_exit_status "failed" "$exit_code"
  exit "$exit_code"
}
trap 'handle_signal TERM 143' TERM
trap 'handle_signal INT 130' INT
trap 'handle_signal HUP 129' HUP
"$@" >> "$stdout_path" 2>> "$stderr_path" &
child_pid="$!"
wait "$child_pid"
exit_code="$?"
trap - TERM INT HUP
status="completed"
if [ "$exit_code" -ne 0 ]; then
  status="failed"
fi
write_exit_status "$status" "$exit_code"
exit "$exit_code"
`
    );
    chmodSync(wrapperPath, 0o755);
    return wrapperPath;
  }

  private removeLegacyDetachedWrappers(): void {
    for (const fileName of ['detached-runner-v1.sh', 'detached-runner-v2.cmd']) {
      const legacyPath = join(this.stateDir, fileName);
      if (!existsSync(legacyPath)) continue;
      try {
        rmSync(legacyPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private killPidOrGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EINVAL') {
        process.kill(pid, signal);
        return;
      }
      if (code === 'EPERM') throw error;
      process.kill(pid, signal);
    }
  }

  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (isProcessRunning(pid) && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private removeEmptyCwdDirs(): void {
    const cwdsDir = this.resolveCwdsDir();
    if (!existsSync(cwdsDir)) return;
    for (const cwdEntry of readdirSync(cwdsDir)) {
      const cwdDir = join(cwdsDir, cwdEntry);
      if (readdirSync(cwdDir).length === 0) {
        rmSync(cwdDir, { recursive: true, force: true });
      }
    }
  }
}
