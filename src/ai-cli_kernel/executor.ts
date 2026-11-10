/**
 * 真實執行器：透過原生的 FileProcessService 派 job，所以熔斷器、防遞迴、strict builder、
 * JobStore 全部照原本的路走，kernel 不另開旁路。
 */
import { existsSync, openSync, readdirSync, readSync, closeSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { FileProcessService } from '../core/file-process-service.js';
import { jobStateDir, lookupIdentities } from '../core/live-jobs.js';
import { mayBeAlive, readJobMetas, sameIdentity } from '../core/job-store.js';
import type { ActionSpec, JobPoll, JobRef, KernelContract, KernelExecutor, UsageCount } from './types.js';

const TAIL_BYTES = 256 * 1024;

export function readJobLogTail(jobId: string, stream: 'stdout' | 'stderr', bytes = TAIL_BYTES): string {
  const path = join(jobStateDir(), 'jobs', jobId, `${stream}.log`);
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  return buffer.toString('utf8');
}

/** 從檔頭讀。Claude 的 init 事件是 stream-json 的第一筆，輸出一長，尾端就看不到它。 */
export function readJobLogHead(jobId: string, stream: 'stdout' | 'stderr', bytes = TAIL_BYTES): string {
  const path = join(jobStateDir(), 'jobs', jobId, `${stream}.log`);
  if (!existsSync(path)) return '';
  const length = Math.min(statSync(path).size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, length, 0); } finally { closeSync(fd); }
  return buffer.toString('utf8');
}

function toUsage(raw: unknown): UsageCount | null {
  const usage = raw as { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown; incomplete?: unknown } | null | undefined;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number' || usage.incomplete === true) return null;
  return { input: usage.input_tokens, cached: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0, output: usage.output_tokens };
}

export class FileJobExecutor implements KernelExecutor {
  private readonly service = new FileProcessService();

  async start(action: ActionSpec, contract: KernelContract): Promise<JobRef> {
    // decide 只需要產出文字；唯讀 worker 多一個讀檔。兩者都走 strict builder，沒有 strict builder 的 agent 會被拒絕。
    const write = action.kind === 'worker' && action.mode === 'write';
    const cwd = action.cwd ?? contract.workFolder;
    if (write) {
      // 不帶 capabilities 就是全權限。這是唯一會走到全權限的路，條件要寫死：一定是 develop 範本，而且在它自己的 worktree 裡。
      if (!contract.develop) throw new Error(`範本 ${contract.template} 不能派會寫檔的 worker`);
      const within = relative(contract.develop.worktree, cwd);
      if (within.startsWith('..') || isAbsolute(within)) throw new Error(`會寫檔的 worker 只能在 ${contract.develop.worktree} 裡執行，收到 ${cwd}`);
    }
    const capabilities = write ? undefined : action.kind === 'decide' ? ['analysis/produce'] : ['fs/read', 'analysis/produce'];
    const started = await this.service.startProcess({
      prompt: action.prompt, cwd, model: action.model, ...(capabilities ? { capabilities } : {}),
      ...(action.effort ? { reasoning_effort: action.effort } : {}),
    }) as { pid: number; jobId?: string };
    if (!started.jobId) throw new Error(`${action.model} 沒有可接回的 jobId，kernel 不能追蹤它`);
    return { pid: started.pid, jobId: started.jobId };
  }

  async poll(job: JobRef): Promise<JobPoll> {
    let result: Record<string, unknown>;
    try { result = await this.service.getProcessResult(job.pid, false, job.jobId) as Record<string, unknown>; }
    catch (error) {
      if (/not found/i.test((error as Error).message)) return { state: 'missing' };
      throw error;
    }
    const status = String(result.status);
    if (status === 'running') return { state: 'running' };
    const output = result.agentOutput as { message?: unknown; result?: unknown; usage?: unknown; sandbox_warning?: { message?: unknown; detail?: unknown } } | undefined;
    const agentMessage = typeof output?.message === 'string' ? output.message : typeof output?.result === 'string' ? output.result : '';
    const warning = output?.sandbox_warning;
    const message = typeof warning?.message === 'string'
      ? `[sandbox_warning] ${warning.message}\n${typeof warning.detail === 'string' ? warning.detail : ''}\n\n${agentMessage}`
      : agentMessage;
    return {
      state: 'finished',
      result: {
        status, exitCode: typeof result.exitCode === 'number' ? result.exitCode : null, message, usage: toUsage(output?.usage),
        rawTail: message ? readJobLogTail(job.jobId, 'stderr', 8192) : `${readJobLogTail(job.jobId, 'stderr', 8192)}\n${readJobLogTail(job.jobId, 'stdout', 8192)}`,
      },
    };
  }

  async find(marker: string): Promise<JobRef | null | 'unknown'> {
    // runner 落 meta 可能比 kernel 當掉晚一點點，多看幾次再下「沒有啟動」的結論。
    // readJobMetas 遇到讀取失敗會回空清單，所以要自己分清楚：查過確定沒有才能回 null，
    // 否則會把還在跑的 job 判成沒啟動，然後重派一次。
    let unreadable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let names: string[];
      try { names = readdirSync(join(jobStateDir(), 'jobs')).filter(name => /^[0-9a-f-]{36}$/.test(name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown';
        names = [];
      }
      const metas = readJobMetas(jobStateDir());
      const meta = metas.find(item => item.task?.includes(marker));
      if (meta) return { pid: meta.pid, jobId: meta.jobId, startedAt: meta.startTime };
      unreadable = metas.length < names.length; // 有目錄讀不出 meta，要找的可能就是那一筆。
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return unreadable ? 'unknown' : null;
  }

  async kill(job: JobRef): Promise<boolean> {
    const killed = await this.service.killProcess(job.pid) as { status?: string };
    return killed.status !== 'running';
  }

  async isGone(job: JobRef): Promise<boolean> {
    // JobStore 只回收確認已結束的 job，所以目錄不在代表已經結束並被回收。
    // 目錄還在卻讀不出 meta，或連 jobs 目錄都查不了，都不能當作已經消失。
    const jobsDir = join(jobStateDir(), 'jobs');
    try { if (!statSync(jobsDir).isDirectory()) return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    if (!existsSync(join(jobsDir, job.jobId))) return true;
    const meta = readJobMetas(jobStateDir()).find(item => item.jobId === job.jobId);
    if (!meta) return false;
    const identities = [meta.runner, ...(meta.worker ? [meta.worker] : [])];
    const live = await lookupIdentities(identities.map(identity => identity.pid));
    for (const identity of identities) {
      const current = live.get(identity.pid);
      if (current) { if (!identity.started || sameIdentity(identity, current)) return false; }
      else if (mayBeAlive(identity.pid)) return false; // 查不到身分但 pid 還在：說不準，算還活著。
    }
    return true;
  }
}
