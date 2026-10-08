/**
 * 記憶體版 process 管理服務（MCP 路徑使用）。
 * 對應 dist/process-service.js，但 spawn 決策改由 agent 定義驅動：
 *   - agent.win32SpawnMode === 'pty' 且 win32 → ConPTY（agy）
 *   - 否則一般 pipe spawn；win32 的 shell 由 agent.win32DirectExec 決定
 *
 * parser 改呼叫 agent.parseOutput；preserveRawOnFailure 由 process-result 處理。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildWorkerEnv } from './worker-env.js';
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

export type CliPaths = Record<Exclude<AgentId, 'direct-api'>, string>;

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
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
}

export class ProcessService {
  private processManager = new Map<number, ProcessEntry>();
  private cliPaths: CliPaths;
  private breaker: CircuitBreaker;
  private directPidSequence = 0;
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
    return [...this.processManager.values()].map(entry => ({
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
  }

  startProcess(options: StartProcessOptions): {
    pid: number;
    status: string;
    agent: AgentId;
    message: string;
    warnings?: string[];
  } {
    const cmd = buildCliCommand({
      ...options,
      cliPaths: this.cliPaths,
    } as BuildCliCommandOptions);

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
    const useStdinPrompt = typeof cmd.stdinPrompt === 'string';
    const needsShell = isWin && !agent.win32DirectExec;
    // Windows: 不用 shell:true（Node v24 DEP0190 + 沙盒 EFTYPE），
    // 改走明確 cmd.exe /c，跟 cross-spawn 相同策略。
    let spawnCmd: string;
    let spawnArgs: string[];
    if (needsShell) {
      const comSpec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
      spawnCmd = comSpec;
      spawnArgs = ['/d', '/s', '/c', `""${cmd.cliPath}" ${cmd.args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}"`];
    } else {
      spawnCmd = cmd.cliPath;
      spawnArgs = cmd.args;
    }
    const childProcess = spawn(spawnCmd, spawnArgs, {
      cwd: cmd.cwd,
      stdio: [useStdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: false,
      shell: false,
      windowsVerbatimArguments: needsShell,
      env: buildWorkerEnv(),
    });

    // 立即掛 error listener，避免 async spawn error 變成 uncaughtException 殺掉 MCP server
    childProcess.on('error', (error) => {
      const entry = childProcess.pid ? this.processManager.get(childProcess.pid) : undefined;
      if (entry) {
        entry.status = 'failed';
        entry.endTime = new Date().toISOString();
        entry.stderr += `\nProcess error: ${error.message}`;
        this.publishJobs();
      }
    });

    if (useStdinPrompt && childProcess.stdin) {
      childProcess.stdin.on('error', () => {});
      try {
        childProcess.stdin.write(cmd.stdinPrompt as string);
        childProcess.stdin.end();
      } catch {
        /* child 可能已死；error/close handler 會處理 */
      }
    }

    const pid = childProcess.pid;
    if (!pid) {
      throw new Error(`Failed to start ${cmd.agent} CLI process`);
    }

    const entry: ProcessEntry = {
      ...emptyOutputStats(),
      closed: false,
      pid,
      process: childProcess,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      model: options.model,
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
    childProcess.on('close', (code) => {
      const e = this.processManager.get(pid);
      if (e) {
        e.status = code === 0 ? 'completed' : 'failed';
        e.exitCode = code !== null ? code : undefined;
      }
    });

    return { pid, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully`, ...(cmd.warnings ? { warnings: cmd.warnings } : {}) };
  }

  private allocateDirectPid(): number {
    let pid: number;
    do {
      pid = process.pid * 100000 + ++this.directPidSequence;
    } while (this.processManager.has(pid));
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
        const e = this.processManager.get(pid);
        if (e) {
          e.status = directProcess.signal.aborted ? 'failed' : 'completed';
          e.exitCode = directProcess.signal.aborted ? 143 : 0;
        }
        directProcess.close(directProcess.signal.aborted ? 143 : 0);
      },
      (error: unknown) => {
        const e = this.processManager.get(pid);
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
      const entryRef = this.processManager.get(pid);
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

  listProcesses() {
    return [...this.processManager.values()].map((proc) => ({
      pid: proc.pid,
      agent: proc.toolType,
      status: proc.status,
      ...listProcessTiming(proc.startTime, proc.endTime,
        proc.status === 'running' ? buildLiveness(proc, proc.startTime, !proc.closed) : undefined),
    }));
  }

  getProcessResult(pid: number, verbose = false): Record<string, unknown> {
    const proc = this.processManager.get(pid);
    if (!proc) {
      throw new Error(`Process with PID ${pid} not found`);
    }
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
    for (const pid of pids) {
      if (!this.processManager.has(pid)) {
        throw new Error(`Process with PID ${pid} not found`);
      }
    }
    const listeners: Array<() => void> = [];
    const waitPromises = [...new Set(pids)].map((pid) => {
      const entry = this.processManager.get(pid)!;
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
      const entry = this.processManager.get(pid);
      if (!entry) {
        processes.push(buildNotFoundPeekProcess(pid));
        continue;
      }
      const result: PeekProcessResult = {
        pid,
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

  killProcess(pid: number): { pid: number; status: string; message: string } {
    const entry = this.processManager.get(pid);
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

  cleanupProcesses(): { removed: number; removedPids: number[]; message: string } {
    const removedPids: number[] = [];
    for (const [pid, proc] of this.processManager.entries()) {
      if (proc.status === 'completed' || proc.status === 'failed') {
        removedPids.push(pid);
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
