/**
 * 真實執行器：透過原生的 FileProcessService 派 job，所以熔斷器、防遞迴、strict builder、
 * JobStore 全部照原本的路走，kernel 不另開旁路。
 */
import { existsSync, openSync, readdirSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { FileProcessService } from '../core/file-process-service.js';
import { jobStateDir, lookupIdentities, type IdentityLookup, type ProcessIdentity } from '../core/live-jobs.js';
import { atomicJson, jobHeld, JOB_HOLD_FILE, mayBeAlive, readJobMetas, sameIdentity, type JobMeta } from '../core/job-store.js';
import { listProcessTable, readTreeRecord, surveyTree, terminateTreeMembers, treeGap, TREE_FILE, type ProcessSnapshot, type ProcessTable, type TreeMember, type TreeRecord } from '../core/process-tree.js';
import { isFullPermission } from './full-permission.js';
import { KernelUntrackedStartError, type ActionSpec, type JobPoll, type JobRef, type KernelContract, type KernelExecutor, type UsageCount } from './types.js';
import { WinJobClient } from '../core/win-job-client.js';
import { findContainmentRef, hasContainmentIntent, LEGACY_CONTAINMENT_NOTICE } from '../core/containment-store.js';

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

/** 測試注入用：假的程序表、身分查詢與終止函式。正式執行都用預設值。 */
export interface FileJobExecutorDeps {
  table?: ProcessTable; lookup?: IdentityLookup; terminate?: typeof terminateTreeMembers; runnerExitWaitMs?: number;
  /** 拿不到 jobId 時，送出終止後等多久確認程序消失。 */
  untrackedConfirmMs?: number;
  /** 對沒有 job 紀錄的程序送終止；測試注入假的。 */
  send?: (pid: number) => void;
  platform?: string;
}

const GONE: JobInspection = { gone: true, blockers: [], runnerGone: true, killable: [] };

interface JobInspection {
  /** runner、worker、已記錄的子孫全部確認不在。 */
  gone: boolean;
  /** 還活著或查不了的原因，給人看。 */
  blockers: string[];
  /** runner 確認不在了（它在的話，終止子孫是它的事，紀錄也只有它能寫）。 */
  runnerGone: boolean;
  /** runner 確定還活著（身分對得上）。查不了的情況兩者都是 false。 */
  runnerAlive?: boolean;
  /** 還活著、而且確定是子孫的程序；kill 會砍這些。 */
  killable: TreeMember[];
}

export class FileJobExecutor implements KernelExecutor {
  private readonly service = new FileProcessService();
  private readonly table: ProcessTable;
  private readonly lookup: IdentityLookup;
  private readonly terminate: typeof terminateTreeMembers;
  private readonly runnerExitWaitMs: number;
  private readonly untrackedConfirmMs: number;
  private readonly send: (pid: number) => void;
  private readonly platform: string;

  dispose(): void { this.service.dispose(); }

  constructor(deps: FileJobExecutorDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.table = deps.table ?? listProcessTable;
    this.lookup = deps.lookup ?? lookupIdentities;
    this.terminate = deps.terminate ?? terminateTreeMembers;
    this.runnerExitWaitMs = deps.runnerExitWaitMs ?? 10000;
    this.untrackedConfirmMs = deps.untrackedConfirmMs ?? 5000;
    this.send = deps.send ?? (pid => { process.kill(pid, 'SIGKILL'); });
  }

  /** 在 job 目錄放保留標記：JobStore 不會回收它，子孫紀錄才留得住。確認子孫都消失才拿掉。 */
  private hold(jobId: string): void {
    const directory = join(jobStateDir(), 'jobs', jobId);
    try { if (!jobHeld(directory)) atomicJson(join(directory, JOB_HOLD_FILE), { holder: 'ai-cli_kernel', at: new Date().toISOString() }); }
    catch { /* 目錄不在或寫不進去：下一次查核再試。 */ }
  }
  private unhold(jobId: string): void {
    try { rmSync(join(jobStateDir(), 'jobs', jobId, JOB_HOLD_FILE), { force: true }); } catch { /* 留著只是晚一點回收。 */ }
  }

  async start(action: ActionSpec, contract: KernelContract): Promise<JobRef> {
    // decide 只需要產出文字；唯讀 worker 多一個讀檔。兩者都走 strict builder，沒有 strict builder 的 agent 會被拒絕。
    const write = isFullPermission(action);
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
    if (!started.jobId) throw await this.untrackedStart(action, started.pid);
    if (!write) return { pid: started.pid, jobId: started.jobId, ...(this.platform==='win32'?{containmentProtocol:1 as const}:{}) };
    // 全權限 job：子孫紀錄在確認消失之前不能被回收，JobRef 也標明「沒有紀錄就不能當作消失」。
    this.hold(started.jobId);
    return { pid: started.pid, jobId: started.jobId, tracked: true, ...(this.platform==='win32'?{containmentProtocol:1 as const}:{}) };
  }

  /**
   * 程序已經啟動，卻沒有 job 紀錄可以接回。先記下它的身分、送出終止，再確認它真的不在了。
   * 確認消失：回一般的錯誤，這個動作就是單純的啟動失敗。確認不了：回 KernelUntrackedStartError，
   * 帶著 pid＋啟動時間，loop 會記進日誌，之後的關卡用它重查。
   */
  private async untrackedStart(action: ActionSpec, pid: number): Promise<Error> {
    const identity = await this.lookup([pid]).then(ids => ids.get(pid), () => undefined);
    const job: JobRef = { pid, jobId: '', untracked: { started: identity?.started ?? '' } };
    // 無 job 的 Windows 程序沒有可靠 handle；禁止沿裸 PID／tree 補殺。
    if (this.platform !== 'win32' && this.platform !== 'darwin' && identity?.started && await this.untrackedState(job) === 'alive') {
      try { this.send(pid); } catch { /* 身分已核對，送出失敗仍須確認。 */ }
    }
    const deadline = Date.now() + this.untrackedConfirmMs;
    for (;;) {
      if (await this.untrackedState(job) === 'gone') return new Error(`${action.model} 沒有可接回的 jobId，kernel 不能追蹤它（pid ${pid}，已確認終止）`);
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return new KernelUntrackedStartError(`${action.model} 沒有可接回的 jobId，kernel 不能追蹤它；pid ${pid} 尚未確認消失，已記下身分供之後重查`, job);
  }

  /** 沒有 job 紀錄的程序只能靠 pid＋啟動時間認。pid 還在卻比不了啟動時間就是 unknown，不能當作消失。 */
  private async untrackedState(job: JobRef): Promise<'alive' | 'gone' | 'unknown'> {
    if (this.platform === 'win32') return 'unknown'; // PID death cannot prove untracked descendants have stopped.
    let current: ProcessIdentity | undefined;
    try { current = (await this.lookup([job.pid])).get(job.pid); } catch { return 'unknown'; }
    if (current) {
      if (!job.untracked?.started) return 'unknown';
      if (this.platform === 'darwin' && current.started === job.untracked.started) return 'unknown';
      return current.started === job.untracked.started ? 'alive' : 'gone';
    }
    return mayBeAlive(job.pid) ? 'unknown' : 'gone';
  }

  async poll(job: JobRef): Promise<JobPoll> {
    if (job.untracked) return { state: 'missing' }; // 沒有 job 紀錄，拿不到結果。
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
      // 有保留標記的是 kernel 當成全權限 job 啟動、還沒確認消失的。
      if (meta) return { pid: meta.pid, jobId: meta.jobId, startedAt: meta.startTime, ...(hasContainmentIntent(jobStateDir(),meta.jobId)?{containmentProtocol:1 as const}:{}), ...(jobHeld(join(jobStateDir(), 'jobs', meta.jobId)) ? { tracked: true as const } : {}) };
      unreadable = metas.length < names.length; // 有目錄讀不出 meta，要找的可能就是那一筆。
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return unreadable ? 'unknown' : null;
  }

  async kill(job: JobRef): Promise<boolean> {
    if (this.platform === 'win32') {
      const ref = findContainmentRef(jobStateDir(), job.jobId);
      if (!ref) {
        if(!job.containmentProtocol&&!job.untracked&&!hasContainmentIntent(jobStateDir(),job.jobId)) {
          await this.service.killProcess(job.pid,job.jobId).catch(()=>undefined);job.legacyNotice=LEGACY_CONTAINMENT_NOTICE;
        }
        return false;
      }
      const status = await new WinJobClient().terminate(ref);
      if (status.state === 'unknown') await this.service.killProcess(job.pid, job.jobId).catch(() => undefined);
      return status.state === 'drained';
    }
    if (job.untracked) {
      // 沒有 job 紀錄：只在 pid 與啟動時間都對得上時才送終止，對不上或比不了就不動它。
      if (await this.untrackedState(job) !== 'alive') return true;
      try { this.send(job.pid); } catch { /* 已退出。 */ }
      return true;
    }
    let stopped: boolean | Error;
    try { stopped = (await this.service.killProcess(job.pid, job.jobId) as { status?: string }).status !== 'running'; }
    catch (error) { stopped = error as Error; }
    // job 已經結束時 runner 不在了，killProcess 什麼都不會做；留下來的子孫由這裡砍。
    // runner 還在就交給它（它收到終止後會自己補砍），這裡不插手。只砍確定是子孫的，每一筆送出前再核對一次身分。
    // worker 剛結束時 runner 還要補最後一次列舉才退出：等它一下，不然這次 kill 會剛好落空。
    try {
      const deadline = Date.now() + this.runnerExitWaitMs;
      for (;;) {
        const inspection = await this.inspect(job);
        if (inspection.runnerGone) { if (inspection.killable.length > 0) await this.terminate(inspection.killable, this.lookup); break; }
        if (stopped !== true || !inspection.runnerAlive || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch { /* 砍不到就留給 isGone 回報還活著。 */ }
    if (stopped instanceof Error) throw stopped;
    return stopped;
  }

  async isGone(job: JobRef): Promise<boolean> {
    return (await this.inspect(job)).gone;
  }

  async blockers(job: JobRef): Promise<string[]> {
    return (await this.inspect(job)).blockers;
  }

  /**
   * 一次列舉，同時回答「消失了沒」和「誰還活著」。
   * 目錄還在卻讀不出 meta、連 jobs 目錄都查不了，任何 job 都不算消失。
   * 全權限 job（JobRef 帶 tracked，啟動時就放了保留標記）另外要求子孫的證據齊全：程序表列舉失敗或不完整、
   * 子孫紀錄讀不出來或不見了、追蹤中途有缺口，都不算消失。
   * 其他 job（decide、唯讀 worker、舊日誌）維持原本的要求，只多擋「紀錄裡確定還活著的子孫」；
   * 它們不是全權限，不值得為了證據不足卡住整個 run。
   */
  private async inspect(job: JobRef): Promise<JobInspection> {
    const blocked = (reason: string, runnerGone = false): JobInspection => ({ gone: false, blockers: [reason], runnerGone, killable: [] });
    if (this.platform === 'win32') {
      const ref = findContainmentRef(jobStateDir(), job.jobId);
      if (!ref) {
        if(job.containmentProtocol||job.untracked||hasContainmentIntent(jobStateDir(),job.jobId))return blocked('Windows job 缺少 containment generation，無法確認停止');
        const directory=join(jobStateDir(),'jobs',job.jobId);
        let legacyPresent=false;
        try { legacyPresent=readdirSync(join(jobStateDir(),'jobs')).includes(job.jobId); }
        catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')return blocked('Windows legacy jobs 目錄讀不了'); }
        const meta=readJobMetas(jobStateDir()).find(m=>m.jobId===job.jobId);
        if(!meta) {
          if(legacyPresent||existsSync(directory)||job.tracked)return blocked('舊 job 身分資料不可讀，無法確認停止');
          job.legacyNotice=LEGACY_CONTAINMENT_NOTICE;return GONE; // HEAD: already-collected legacy logs.
        }
        const ids=await this.lookup([meta.runner.pid,...(meta.worker?[meta.worker.pid]:[])]);
        const gone=(id: ProcessIdentity|null)=>!id||(ids.has(id.pid)?!!id.started&&!sameIdentity(id,ids.get(id.pid)):!mayBeAlive(id.pid));
        job.legacyNotice=LEGACY_CONTAINMENT_NOTICE;
        if(gone(meta.runner)&&gone(meta.worker)){this.unhold(job.jobId);return GONE;}
        return blocked(LEGACY_CONTAINMENT_NOTICE+'；runner／worker 尚未確認停止');
      }
      const status = await new WinJobClient().inspect(ref);
      if (status.state === 'drained') { this.unhold(job.jobId); return GONE; }
      return blocked(status.state === 'active' ? `Job Object ActiveProcesses=${status.activeProcesses}，runnerExited=${status.runnerExited}` : status.reason ?? 'containment 啟動中，尚未確認停止', status.runnerExited === true);
    }
    if (job.untracked) {
      const state = await this.untrackedState(job);
      if (state === 'gone') return GONE;
      return blocked(state === 'alive' ? `pid ${job.pid}（啟動後拿不到 jobId 的程序）還活著` : `pid ${job.pid} 還在，但查不出是不是當初啟動的那個程序`, true);
    }
    const jobsDir = join(jobStateDir(), 'jobs');
    let present: boolean;
    try {
      if (!statSync(jobsDir).isDirectory()) return blocked('jobs 目錄讀不了');
      present = existsSync(join(jobsDir, job.jobId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return blocked('jobs 目錄讀不了');
      present = false;
    }
    if (!present) {
      // JobStore 只回收確認已結束的 job，所以目錄不在代表 runner 與 worker 已經結束。
      // 但全權限 job（tracked）的目錄有保留標記、不會被回收；它不見了就是子孫紀錄也沒了，沒有紀錄不能當作沒有子孫。
      // 其他 job 與舊日誌沒有這個要求，照舊當作消失。
      if (job.tracked) return blocked(`job ${job.jobId} 的目錄不見了（不是 JobStore 回收的），子孫紀錄無從查起`, true);
      return GONE;
    }
    const directory = join(jobsDir, job.jobId);
    const meta = readJobMetas(jobStateDir()).find(item => item.jobId === job.jobId);
    if (!meta) return blocked('job 目錄還在但讀不出 meta');
    // 整張程序表列舉一次，runner、worker、子孫都用它。列舉失敗時 runner／worker 退回逐一查身分（舊行為），子孫則查不了。
    const before = Date.now();
    let snapshot: ProcessSnapshot | null = null, tableError = '';
    try { snapshot = await this.table(); } catch (error) { tableError = (error as Error).message; }
    const alive = await this.identitiesAlive(meta, snapshot);
    if (alive.runner || alive.worker) {
      return { gone: false, blockers: [...(alive.runner ? [`runner pid ${meta.runner.pid}`] : []), ...(alive.worker ? [`worker pid ${meta.worker!.pid}`] : [])], runnerGone: !alive.runner, runnerAlive: alive.runner, killable: [] };
    }
    if (meta.tree !== 1) { this.unhold(job.jobId); return GONE; } // 舊 runner 啟動的 job，或 worker 根本沒啟動：沒有子孫紀錄可查。
    const strict = job.tracked === true;
    const record = readTreeRecord(directory);
    if (record === null || record === 'corrupt') return strict ? blocked('子孫紀錄（tree.json）讀不出來，無法確認子孫是否還在', true) : GONE;
    if (!snapshot) return strict ? blocked(`程序表列舉失敗，無法確認子孫是否還在：${tableError.slice(0, 200)}`, true) : GONE;
    const inspection = this.inspectTree(record, directory, snapshot, before, strict);
    // 還不能確認消失就保住這個目錄（JobStore 不回收有標記的），確認了才放手。
    if (inspection.gone) this.unhold(job.jobId); else this.hold(job.jobId);
    return inspection;
  }

  /** runner 與 worker 還在不在。pid 還在但查不到身分算還活著：說不準。 */
  private async identitiesAlive(meta: JobMeta, snapshot: ProcessSnapshot | null): Promise<{ runner: boolean; worker: boolean }> {
    const identities = [meta.runner, ...(meta.worker ? [meta.worker] : [])];
    const live: Map<number, { pid: number; started: string; name: string }> = snapshot ? new Map(snapshot.rows.map(row => [row.pid, row])) : await this.lookup(identities.map(identity => identity.pid));
    const isAlive = (identity: ProcessIdentity): boolean => {
      const current = live.get(identity.pid);
      if (current) return !identity.started || sameIdentity(identity, current);
      return mayBeAlive(identity.pid);
    };
    return { runner: isAlive(meta.runner), worker: meta.worker ? isAlive(meta.worker) : false };
  }

  /** 拿子孫紀錄對程序表重查。runner 已經不在，所以這裡可以把新看到的寫回去。 */
  private inspectTree(record: TreeRecord, directory: string, snapshot: ProcessSnapshot, before: number, strict: boolean): JobInspection {
    // 機器重開過：紀錄裡的程序不可能還在，當時的追蹤缺口也不必再管。
    if (record.boot && snapshot.boot && record.boot !== snapshot.boot) return GONE;
    const survey = surveyTree(record, snapshot, { before, now: Date.now() });
    try { atomicJson(join(directory, TREE_FILE), survey.record); } catch { /* 下次重算。 */ }
    const unsure = (member: TreeMember): string => member.loose ? '，親子關係不確定，不會自動終止' : member.weak ? '，啟動時間精度不足以認定身分，不會自動終止' : '';
    const blockers = survey.alive.map(member => `子孫 pid ${member.pid}（${member.name || '?'}${unsure(member)}）`);
    if (strict) {
      blockers.push(
        ...survey.unknown.map(member => `子孫 pid ${member.pid}（${member.name || '?'}）查不出還在不在`),
        ...survey.unverified.map(pid => `pid ${pid} 讀不出身分，可能是子孫`),
        ...(survey.blind ? ['程序表不完整，無法確認沒有別的子孫'] : []),
      );
      // 追蹤有缺口時，「現在看不到子孫」證明不了沒有子孫：缺口那段時間啟動的程序沒有紀錄可以接回。
      const gap = treeGap(survey.record);
      if (gap) blockers.push(`追蹤缺口：${gap}`);
    }
    if (blockers.length === 0) return GONE;
    return { gone: false, runnerGone: true, blockers, killable: survey.alive.filter(member => !member.loose && !member.weak) };
  }
}
