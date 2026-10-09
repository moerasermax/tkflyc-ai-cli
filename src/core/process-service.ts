/**
 * MCP process 管理：pipe agent 交給持久化 runner，PTY/direct 保持行程內管理。
 * spawn 決策由 agent 定義驅動：
 *   - agent.win32SpawnMode === 'pty' 且 win32 → ConPTY（agy）
 *   - claude/codex → JobStore；agy 的 POSIX pipe 維持舊路徑
 *
 * parser 改呼叫 agent.parseOutput；preserveRawOnFailure 由 process-result 處理。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildWorkerEnv } from './worker-env.js';
import { JobStore, jobResult, type StoredJob } from './job-store.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentId } from '../agents/types.js';
import { getAgent } from '../agents/registry.js';
import { buildCliCommand, type BuildCliCommandOptions } from './command-builder.js';
import { buildProcessResult } from './process-result.js';
import { buildLiveness, emptyOutputStats, elapsedSeconds, listProcessTiming, type ProcessOutputStats } from './liveness.js';
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
import { spawnPty, type PtyChild } from './pty-runner.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { currentDispatcher, processJobPublisher, shortText, taskSummary, type LiveJobPublisher, type JobDispatcher, type LiveJob } from './live-jobs.js';

export type CliPaths = Record<Exclude<AgentId, 'direct-api' | 'grok'>, string> & { grok?: string };

export interface StartProcessOptions {
  prompt?: string;
  prompt_file?: string;
  workFolder: string;
  model?: string;
  session_id?: string;
  reasoning_effort?: string;
  /**
   * 只給這些能力 → 走 agent 的 strict builder（fail-closed，見 command-builder.ts）。
   * 不傳 = 沒有意見 = 一般模式；傳空陣列 = 什麼都不給，仍走 strict。
   */
  capabilities?: readonly string[];
  system_prompt?: string;
}

class DirectManagedProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = null;
  private controller = new AbortController();
  private closed = false;

  constructor(public pid: number) {
    super();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  kill(_signal?: NodeJS.Signals | string): boolean {
    if (this.closed) return false;
    this.controller.abort();
    return true;
  }

  close(exitCode: number | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', exitCode);
  }
}

type ManagedProcess = ChildProcess | PtyChild | DirectManagedProcess;

interface ProcessEntry extends ProcessOutputStats {
  pid: number;
  process: ManagedProcess;
  prompt: string;
  workFolder: string;
  model?: string;
  toolType: AgentId;
  resolvedModel?: string;
  reasoning_effort?: string;
  startTime: string;
  endTime?: string;
  closed: boolean;
  stdout: string;
  stderr: string;
  status: 'running' | 'completed' | 'failed' | 'lost';
  recovered?: true;
  directory?: string;
  exitCode?: number;
}

export class ProcessService {
  private processManager = new Map<number | string, ProcessEntry>();
  private cliPaths: CliPaths;
  private breaker: CircuitBreaker;
  private directPidSequence = 0;
  private store = new JobStore(undefined, 'mcp');
  readonly ready: Promise<void>;
  private poll: NodeJS.Timeout;
  private gc: NodeJS.Timeout;
  private publisher?: LiveJobPublisher;
  private publishing?: Promise<void>;
  private dispatcher: JobDispatcher = { pid: process.pid, parentPid: process.ppid };

  private publishJobs(): void {
    if (this.publisher) { this.publisher.publish(true); return; }
    this.publishing ??= Promise.all([processJobPublisher(), currentDispatcher()]).then(([publisher, dispatcher]) => {
      this.dispatcher = dispatcher;
      this.publisher = publisher;
      publisher?.setSource(this, () => this.jobSummaries());
      if (!publisher) this.publishing = undefined;
    }).catch(() => { this.publishing = undefined; });
  }

  private jobSummaries(): LiveJob[] {
    return [...this.processManager.values()].filter(entry => !entry.directory).map(entry => ({
      pid: entry.pid, agent: entry.toolType, model: entry.resolvedModel || entry.model || null, reasoning_effort: entry.reasoning_effort ?? null,
      task: taskSummary(entry.prompt), workFolder: entry.workFolder, status: entry.status,
      startTime: entry.startTime, endTime: entry.endTime,
      elapsedSec: elapsedSeconds(entry.startTime, entry.endTime ?? Date.now()),
      sinceLastOutputSec: entry.lastOutputAt ? Math.max(0, ((entry.endTime ? Date.parse(entry.endTime) : Date.now()) - Date.parse(entry.lastOutputAt)) / 1000) : null,
      lastEvent: entry.lastEvent === null ? null : shortText(entry.lastEvent, 80),
      dispatcher: this.dispatcher, source: 'mcp',
    }));
  }

  constructor(options: { cliPaths: CliPaths; breaker?: CircuitBreaker }) {
    this.cliPaths = options.cliPaths;
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.ready = this.store.ready.then(() => {
      for (const [jobId, job] of this.store.jobs) this.processManager.set(jobId, job as unknown as ProcessEntry);
    });
    this.poll = setInterval(() => {
      this.store.refresh();
      for (const [pid, entry] of this.processManager) if (entry.directory && !this.store.jobs.has(String(pid))) this.processManager.delete(pid);
    }, 100);
    this.gc = setInterval(() => this.collectExpired(), 60000); this.gc.unref();
    this.poll.unref();
  }

  startProcess(options: StartProcessOptions): {
    pid: number;
    jobId?: string;
    status: string;
    agent: AgentId;
    message: string;
    warnings?: string[];
  } {
    const cmd = buildCliCommand({
      ...options,
      cliPaths: this.cliPaths,
    } as BuildCliCommandOptions);
    // agent builder 只把 resume session 放進 argv；store 另需保留原始 session 欄位。
    cmd.sessionId = options.session_id;

    // 熔斷器：偵測框架迴圈造成的爆量/重複啟動，啟動前先攔截。
    this.breaker.check(cmd.agent, cmd.prompt);

    const agent = getAgent(cmd.agent);
    const isWin = process.platform === 'win32';
    const spawnMode = isWin && agent.win32SpawnMode ? agent.win32SpawnMode : agent.spawnMode || 'pipe';

    if (spawnMode === 'direct') {
      return this.startDirectProcess(cmd, options.model);
    }

    if (spawnMode === 'pty') {
      return this.startPtyProcess(cmd, options.model);
    }

    // 一般 pipe spawn
    if (cmd.agent !== 'antigravity') {
      const job = this.store.start(cmd, options.model);
      this.processManager.set(job.meta.jobId, job as unknown as ProcessEntry);
      return { pid: job.pid, jobId: job.meta.jobId, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully`, ...(cmd.warnings ? { warnings: cmd.warnings } : {}) };
    }
    return this.startLegacyPipe(cmd, options.model);
  }

  private startLegacyPipe(cmd: ReturnType<typeof buildCliCommand>, model?: string) {
    const child = spawn(cmd.cliPath, cmd.args, { cwd: cmd.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: buildWorkerEnv(), detached: false });
    child.on('error', error => { const entry = child.pid ? this.processManager.get(child.pid) : undefined; if (entry) { entry.status = 'failed'; entry.stderr += error.message; } });
    if (!child.pid) throw new Error(`Failed to start ${cmd.agent} CLI process`);
    if (cmd.stdinPrompt !== undefined) { child.stdin?.on('error', () => {}); child.stdin?.end(cmd.stdinPrompt); } else child.stdin?.end();
    const entry: ProcessEntry = { ...emptyOutputStats(), pid: child.pid, process: child, prompt: cmd.prompt, workFolder: cmd.cwd, model, resolvedModel: cmd.resolvedModel,
      reasoning_effort: cmd.reasoningEffort, toolType: cmd.agent, startTime: new Date().toISOString(), closed: false, stdout: '', stderr: '', status: 'running' };
    this.processManager.set(entry.pid, entry); this.observeOutput(entry);
    child.on('close', code => { entry.exitCode = code ?? undefined; entry.status = code === 0 ? 'completed' : 'failed'; });
    return { pid: entry.pid, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully`, ...(cmd.warnings ? { warnings: cmd.warnings } : {}) };
  }

  private allocateDirectPid(): number {
    let pid: number;
    do {
      pid = process.pid * 100000 + ++this.directPidSequence;
    } while (!!this.findProcess(pid));
    return pid;
  }

  /** pipe、PTY（合併為 stdout）與 direct-api 都經過同一個 chunk 記帳入口。 */
  private observeOutput(entry: ProcessEntry): void {
    this.publishJobs();
    const extractors = {
      stdout: new LivenessEventExtractor(entry.toolType),
      stderr: new LivenessEventExtractor(entry.toolType),
    };
    const recordEvents = (events: string[]) => {
      entry.eventCount += events.length;
      if (events.length) entry.lastEvent = events[events.length - 1];
    };
    for (const stream of ['stdout', 'stderr'] as const) {
      entry.process[stream]?.on('data', (chunk: Buffer | string) => {
        entry[stream] += chunk.toString();
        entry[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += Buffer.byteLength(chunk);
        entry.lastOutputAt = new Date().toISOString();
        recordEvents(extractors[stream].push(chunk));
      });
    }
    entry.process.once('close', () => {
      entry.closed = true;
      entry.endTime = new Date().toISOString();
      recordEvents(extractors.stdout.flush());
      recordEvents(extractors.stderr.flush());
      // pipe 的 status listener 比 observeOutput 晚註冊，等本輪 close listeners 完成。
      queueMicrotask(() => this.publishJobs());
    });
  }

  private startDirectProcess(
    cmd: ReturnType<typeof buildCliCommand>,
    model?: string
  ): { pid: number; status: string; agent: AgentId; message: string } {
    const agent = getAgent(cmd.agent);
    if (!agent.runDirect) {
      throw new Error(`${cmd.agent} does not implement direct execution`);
    }
    const pid = this.allocateDirectPid();
    const directProcess = new DirectManagedProcess(pid);
    const entry: ProcessEntry = {
      ...emptyOutputStats(),
      closed: false,
      pid,
      process: directProcess,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      model,
      resolvedModel: cmd.resolvedModel,
      reasoning_effort: cmd.reasoningEffort || undefined,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdout: '',
      stderr: '',
      status: 'running',
    };
    this.processManager.set(pid, entry);
    this.observeOutput(entry);

    const writeStdout = (chunk: string): void => {
      directProcess.stdout.write(chunk);
    };
    const writeStderr = (chunk: string): void => {
      directProcess.stderr.write(chunk);
    };

    agent.runDirect(cmd, {
      stdout: writeStdout,
      stderr: writeStderr,
      signal: directProcess.signal,
    }).then(
      () => {
        const e = this.findProcess(pid);
        if (e) {
          e.status = directProcess.signal.aborted ? 'failed' : 'completed';
          e.exitCode = directProcess.signal.aborted ? 143 : 0;
        }
        directProcess.close(directProcess.signal.aborted ? 143 : 0);
      },
      (error: unknown) => {
        const e = this.findProcess(pid);
        const aborted = directProcess.signal.aborted;
        if (e) {
          e.status = 'failed';
          e.exitCode = aborted ? 143 : 1;
          if (!aborted) {
            const message = error instanceof Error ? error.message : String(error);
            directProcess.stderr.write(`\nDirect API error: ${message}`);
          }
        }
        directProcess.close(aborted ? 143 : 1);
      }
    );

    return {
      pid,
      status: 'started',
      agent: cmd.agent,
      message: `${cmd.agent} request started successfully`,
      ...(cmd.warnings ? { warnings: cmd.warnings } : {}),
    };
  }

  private startPtyProcess(
    cmd: ReturnType<typeof buildCliCommand>,
    model?: string
  ): { pid: number; status: string; agent: AgentId; message: string } {
    const { pid, child } = spawnPty(cmd.cliPath, cmd.args, cmd.cwd, (code, killedByUser) => {
      const entryRef = this.findProcess(pid);
      if (entryRef) {
        // 在 emit('close') 前同步更新狀態，避免 waitForProcesses 漏接
        entryRef.status = killedByUser ? 'failed' : code === 0 ? 'completed' : 'failed';
        entryRef.exitCode = code ?? undefined;
        if (killedByUser && !entryRef.stderr.includes('Process terminated by user')) {
          entryRef.stderr += '\nProcess terminated by user';
        }
      }
    });

    const entry: ProcessEntry = {
      ...emptyOutputStats(),
      closed: false,
      pid,
      process: child,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      model,
      resolvedModel: cmd.resolvedModel,
      reasoning_effort: cmd.reasoningEffort || undefined,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdout: '',
      stderr: '',
      status: 'running',
    };
    this.processManager.set(pid, entry);
    this.observeOutput(entry);

    return {
      pid,
      status: 'started',
      agent: cmd.agent,
      message: `${cmd.agent} process started successfully (pty mode)`,
      ...(cmd.warnings ? { warnings: cmd.warnings } : {}),
    };
  }

  private findProcess(pid: number): ProcessEntry | undefined {
    return (this.store.find(pid) as unknown as ProcessEntry | undefined) ?? this.processManager.get(pid);
  }
  private pruneStored(): void {
    for (const [key, entry] of this.processManager) if (entry.directory && !this.store.jobs.has(String(key))) this.processManager.delete(key);
  }

  listProcesses() {
    this.store.refresh(); this.collectExpired(); this.pruneStored();
    return [...this.processManager.values()].map((proc) => ({
      pid: proc.pid,
      ...(proc.directory ? { jobId: (proc as unknown as StoredJob).meta.jobId } : {}),
      agent: proc.toolType,
      status: proc.status,
      ...(proc.recovered ? { recovered: true } : {}),
      ...listProcessTiming(proc.startTime, proc.endTime,
        proc.status === 'running' ? buildLiveness(proc, proc.startTime, !proc.closed) : undefined),
    }));
  }

  getProcessResult(pid: number, verbose = false, jobId?: string): Record<string, unknown> {
    if (jobId) return jobResult(this.store.get(pid, jobId), verbose);
    const proc = this.findProcess(pid);
    if (!proc) {
      throw new Error(`Process with PID ${pid} not found`);
    }
    if (proc.directory) return jobResult(proc as unknown as StoredJob, verbose);
    const agent = getAgent(proc.toolType);
    const agentOutput = agent.parseOutput(proc.stdout, proc.stderr, proc.exitCode, {
      workFolder: proc.workFolder,
      status: proc.status,
    });
    const result = buildProcessResult(
      {
        pid,
        agent: proc.toolType,
        status: proc.status,
        exitCode: proc.exitCode,
        startTime: proc.startTime,
        workFolder: proc.workFolder,
        prompt: proc.prompt,
        model: proc.model,
        stdout: proc.stdout,
        stderr: proc.stderr,
        liveness: proc.status === 'running' ? buildLiveness(proc, proc.startTime, !proc.closed) : undefined,
      },
      agentOutput,
      verbose
    );
    return result;
  }

  async waitForProcesses(
    pids: number[],
    timeoutSeconds = 180,
    verbose = false
  ): Promise<Array<Record<string, unknown>>> {
    await this.ready; this.store.refresh();
    for (const pid of pids) {
      if (!this.findProcess(pid)) {
        throw new Error(`Process with PID ${pid} not found`);
      }
    }
    const polling = setInterval(() => this.store.refresh(), 50);
    const listeners: Array<() => void> = [];
    const waitPromises = [...new Set(pids)].map((pid) => {
      const entry = this.findProcess(pid)!;
      if (entry.status !== 'running') {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const done = () => resolve();
        entry.process.once('close', done);
        entry.process.once('error', done);
        listeners.push(() => {
          entry.process.off('close', done);
          entry.process.off('error', done);
        });
      });
    });

    const timeoutMs = timeoutSeconds * 1000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([Promise.all(waitPromises), timeoutPromise]);
      return pids.map((pid) => {
        const result = this.getProcessResult(pid, verbose);
        if (timedOut && result.status === 'running') result.timedOut = true;
        return result;
      });
    } finally {
      clearInterval(polling);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // 呼叫端會反覆短等候；逾時的 listener 不可一直留到 child close 才清。
      for (const removeListeners of listeners) removeListeners();
    }
  }

  async peekProcesses(
    pids: number[],
    peekTimeSec = 10,
    includeToolCalls = false
  ): Promise<{ peek_started_at: string; observed_duration_sec: number; processes: PeekProcessResult[] }> {
    await this.ready; this.store.refresh();
    const targetPids = validatePeekPids(pids);
    const targetPeekTimeSec = validatePeekTimeSec(peekTimeSec);
    const processes: PeekProcessResult[] = [];
    const observers: Array<{
      entry: ProcessEntry;
      result: PeekProcessResult;
      stdoutExtractor: PeekEventExtractor;
      stderrExtractor: PeekEventExtractor;
      onStdout: (data: Buffer | string) => void;
      onStderr: (data: Buffer | string) => void;
    }> = [];

    for (const pid of targetPids) {
      const entry = this.findProcess(pid);
      if (!entry) {
        processes.push(buildNotFoundPeekProcess(pid));
        continue;
      }
      const result: PeekProcessResult = {
        pid,
        ...(entry.directory ? { jobId: (entry as unknown as StoredJob).meta.jobId } : {}),
        agent: entry.toolType,
        status: entry.status,
        events: [],
        truncated: false,
        error: null,
      };
      processes.push(result);
      const stdoutExtractor = new PeekEventExtractor(entry.toolType, { includeToolCalls });
      const stderrExtractor = new PeekEventExtractor(entry.toolType, { includeToolCalls });
      const onStdout = (data: Buffer | string) => {
        appendPeekEvents(result, stdoutExtractor.push(data, new Date().toISOString()));
      };
      const onStderr = (data: Buffer | string) => {
        appendPeekEvents(result, stderrExtractor.push(data, new Date().toISOString()));
      };
      if (entry.status === 'running') {
        entry.process.stdout?.on('data', onStdout);
        entry.process.stderr?.on('data', onStderr);
      }
      observers.push({ entry, result, stdoutExtractor, stderrExtractor, onStdout, onStderr });
    }

    const polling = setInterval(() => this.store.refresh(), 50);
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const runningObservers = observers.filter((o) => o.entry.status === 'running');
    const terminalPromise = Promise.all(
      runningObservers.map((o) => this.waitForProcessTerminal(o.entry))
    );
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, targetPeekTimeSec * 1000);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([terminalPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      clearInterval(polling);
      const flushTs = new Date().toISOString();
      for (const o of observers) {
        o.entry.process.stdout?.off('data', o.onStdout);
        o.entry.process.stderr?.off('data', o.onStderr);
        appendPeekEvents(o.result, o.stdoutExtractor.flush(flushTs));
        appendPeekEvents(o.result, o.stderrExtractor.flush(flushTs));
        o.result.status = o.entry.status;
      }
    }

    return {
      peek_started_at: startedAt.toISOString(),
      observed_duration_sec: observedDurationSec(startedAtMs),
      processes,
    };
  }

  private waitForProcessTerminal(entry: ProcessEntry): Promise<void> {
    if (entry.status !== 'running') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        entry.process.off('close', done);
        entry.process.off('error', done);
        resolve();
      };
      entry.process.once('close', done);
      entry.process.once('error', done);
    });
  }

  async killProcess(pid: number): Promise<{ pid: number; status: string; message: string }> {
    await this.ready;
    if (this.store.hasPid(pid)) return this.store.kill(pid);
    const entry = this.findProcess(pid);
    if (!entry) {
      throw new Error(`Process with PID ${pid} not found`);
    }
    if (entry.status !== 'running') {
      return { pid, status: entry.status, message: 'Process already terminated' };
    }
    entry.process.kill('SIGTERM');
    entry.status = 'failed';
    entry.endTime = new Date().toISOString();
    entry.stderr += '\nProcess terminated by user';
    this.publishJobs();
    return { pid, status: 'terminated', message: 'Process terminated successfully' };
  }

  private collectExpired(now = Date.now()): void {
    this.store.collect(now); this.pruneStored();
    for (const [pid, entry] of this.processManager) if (!entry.directory && entry.status !== 'running' && entry.endTime && now - Date.parse(entry.endTime) >= 30 * 60 * 1000) this.processManager.delete(pid);
  }

  dispose(): void { clearInterval(this.gc); clearInterval(this.poll); this.store.dispose(); }

  cleanupProcesses(): { removed: number; removedPids: number[]; message: string } {
    const removedPids: number[] = this.store.collect(Date.now(), true);
    this.pruneStored();
    for (const [pid, proc] of this.processManager.entries()) {
      if (proc.status !== 'running') {
        removedPids.push(proc.pid);
        this.processManager.delete(pid);
      }
    }
    this.publishJobs();
    return {
      removed: removedPids.length,
      removedPids,
      message: `Cleaned up ${removedPids.length} finished process(es)`,
    };
  }
}
