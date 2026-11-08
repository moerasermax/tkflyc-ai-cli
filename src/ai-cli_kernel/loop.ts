/**
 * Kernel 迴圈：確定性程式，模型只出現在 decide 這一格。
 *
 *   讀日誌 → 該停就停 → 恢復未結案動作 → 消化結果 → 閘 → 先記意圖 → 執行 → 記結果 → 驗收
 *
 * 所有依賴都從參數傳入，測試用假執行器就能走遍每一種當機位置，不必啟動 vendor。
 */
import { randomBytes } from 'node:crypto';
export { aiCliKernelRunTrigger, type KernelTriggerDeps } from './triggers.js';
import { aiCliKernelReplayReleases } from './replay.js';
import type { KernelRelease, KernelReleaseView, ReleaseWorkspaceOps } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeMinutes, derivedStop, nextStep, openActions, replayJournal, unprocessedActions, type ActionRecord, type RunView } from './replay.js';
import { actionMarker, buildDecidePrompt, buildWorkerPrompt, parseDecision } from './plan.js';
import { aiCliKernelMemoryCandidates, type KernelMemoryOps } from './memory.js';
import { classifyJobResult, evaluateChecks, snapshotsEqual } from './verdict.js';
import type { RunStore } from './journal.js';
import { outOfScope } from './workspace.js';
import { kernelTestInventory } from './evidence.js';
import { workDirOf, type ActionOutcome, type ActionSpec, type BoundaryStatus, type FailureClass, type GitSnapshot, type JobRef, type KernelContract, type KernelEventBody, type KernelExecutor, type PlanStep, type RawJobResult, type RunState, type WorkspaceOps, type WorkspaceState } from './types.js';

export interface KernelLoopDeps {
  store: RunStore;
  contract: KernelContract;
  executor: KernelExecutor;
  boundary(agent: string): Promise<BoundaryStatus>;
  /** 週額度剩餘百分比；量不到回 null。 */
  quota(agent: string): Promise<number | null>;
  agentFor(model: string): string;
  versionId(): string;
  snapshot(dir: string): GitSnapshot | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  pollMs: number;
  killConfirmMs: number;
  /** 這個 runner 的 pid，只寫進日誌供查核。 */
  pid: number;
  /** develop 工作區及兩種範本的 contextCommand 執行器。 */
  workspace?: WorkspaceOps;
  memory?: KernelMemoryOps;
}

const PREVIEW_CHARS = 1500;
const REVIEW_DIFF_CHARS = 20000;

/** CLI 單次放行；不經 decide、不派 worker。I/O 都在 deps，replay 只還原事實。 */
export interface KernelReleaseDeps {
  store: RunStore;
  workspace: ReleaseWorkspaceOps & Pick<WorkspaceOps, 'checkpointValid'>;
  now(): number;
  newId(): string;
  assertHuman(): void;
}
export interface KernelReleaseCreateInput {
  action: string;
  target: string;
  confirm: string;
  remote?: string;
  hours?: number;
  allowDefaultBranch?: boolean;
}

function releaseDelivery(deps: KernelReleaseDeps): { contract: KernelContract; spec: NonNullable<KernelContract['develop']>; commit: string } {
  const { store, workspace } = deps;
  const contract = store.readContract();
  const view = replayJournal(store.read());
  if (contract.template !== 'develop' || !contract.develop || view.state !== 'completed') throw new Error('只能放行 completed 的 develop run');
  // 觸發的 run 一樣可以放行：半夜自動開發的成果，人早上看過要收得下來。自動流程本身沒有呼叫放行的路徑，放行也只有 CLI。
  if (!view.approvedDigest || view.contractDigest !== view.approvedDigest || store.contractDigest() !== view.approvedDigest) throw new Error('委任書與核准 digest 不符，拒絕放行');
  const spec = contract.develop;
  const commit = view.headCommit;
  if (!commit || !view.acceptance?.passed || !view.verification?.passed || view.verification.commit !== commit || view.verification.exitCode !== 0 || view.verification.timedOut || view.openCheck || openActions(view).length) throw new Error('交付 commit 沒有通過測試／驗收，拒絕放行');
  if (workspace.releaseBranchHead(spec) !== commit) throw new Error('交付分支 HEAD 已變動，拒絕放行');
  if (spec.checkpoint && spec.checkpoint.mode !== 'off' && (!view.checkpoint || !workspace.checkpointValid(spec, view.checkpoint))) throw new Error('回復點 ref 已變動，拒絕放行');
  return { contract, spec, commit };
}

export function aiCliKernelCreateRelease(deps: KernelReleaseDeps, input: KernelReleaseCreateInput): KernelRelease {
  deps.assertHuman();
  return deps.store.withReleaseLock(() => {
    const { spec, commit } = releaseDelivery(deps);
    if (input.action !== 'merge' && input.action !== 'push') throw new Error('action 必須是 merge 或 push');
    if (input.confirm !== commit.slice(0, 10)) throw new Error('confirm 必須等於交付 commit 前 10 碼');
    const hours = input.hours ?? 1;
    if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(deps.now() + hours * 3600000)) throw new Error('hours 必須是大於零的有限數字');
    if (!input.target || input.target.startsWith('-') || /[\s\x00-\x1f]/.test(input.target)) throw new Error('target 必須是有效分支名稱');
    if (input.action === 'merge' && (input.remote !== undefined || input.allowDefaultBranch)) throw new Error('merge 不接受 remote 或 allow-default-branch');
    const remote = input.action === 'push' ? input.remote ?? 'origin' : null;
    const remoteUrl = remote ? deps.workspace.releaseRemoteUrl(spec, remote) : null;
    const targetCommitAtCreate = deps.workspace.releaseTarget(spec, input.action, input.target, remote);
    if (remote && deps.workspace.releaseDefaultBranch(spec, remote) === input.target && input.allowDefaultBranch !== true) throw new Error('target 是遠端預設分支，這可能等於部署；請另外加 --allow-default-branch');
    const release: KernelRelease = {
      id: deps.newId(), action: input.action, target: input.target, remote, remoteUrl,
      commit, baseCommit: spec.baseCommit, targetCommitAtCreate,
      expiresAt: new Date(deps.now() + hours * 3600000).toISOString(), allowDefaultBranch: input.allowDefaultBranch === true,
    };
    const known = aiCliKernelReplayReleases(deps.store.readReleases());
    if (known.has(release.id)) throw new Error('放行 id 已存在');
    deps.store.appendRelease({ type: 'release_created', at: new Date(deps.now()).toISOString(), ...release });
    return release;
  });
}

export function aiCliKernelRunRelease(deps: KernelReleaseDeps, id: string): KernelReleaseView {
  deps.assertHuman();
  return deps.store.withReleaseLock(() => {
    const view = aiCliKernelReplayReleases(deps.store.readReleases()).get(id);
    if (!view) throw new Error('找不到放行 id');
    if (view.attempted || view.status !== 'available') throw new Error(`放行已使用或結果不明（${view.status}），絕不自動重試`);
    const release = view.release;
    if (!Number.isFinite(Date.parse(release.expiresAt)) || deps.now() >= Date.parse(release.expiresAt)) throw new Error('放行已過期');
    const { spec, commit } = releaseDelivery(deps);
    if (release.commit !== commit || release.baseCommit !== spec.baseCommit) throw new Error('放行版本與交付 commit 不符');
    if (release.action !== 'merge' && release.action !== 'push') throw new Error('放行 action 不合法');
    if (release.action === 'push') {
      if (!release.remote || deps.workspace.releaseRemoteUrl(spec, release.remote) !== release.remoteUrl) throw new Error('遠端 URL 已變動，拒絕放行');
      if (deps.workspace.releaseDefaultBranch(spec, release.remote) === release.target && release.allowDefaultBranch !== true) throw new Error('target 現為遠端預設分支，這可能等於部署；需重新加 --allow-default-branch 建立放行');
    } else deps.workspace.releaseMergeReady(spec, release.target);
    if (deps.workspace.releaseTarget(spec, release.action, release.target, release.remote) !== release.targetCommitAtCreate) throw new Error('target 已漂移，拒絕放行');
    // 遠端查詢可能花掉整個有效期；在記意圖前再核對版本與期限。
    releaseDelivery(deps);
    if (deps.now() >= Date.parse(release.expiresAt)) throw new Error('放行已過期');
    // 在任何不可逆 I/O 之前 fsync。落盤失敗，絕不執行。
    deps.store.appendRelease({ type: 'release_intent', id, at: new Date(deps.now()).toISOString() });
    let result: { status: 'succeeded' | 'failed' | 'unknown'; detail: string };
    try {
      result = deps.workspace.releaseExecute(spec, release);
      if (result.status === 'succeeded' && deps.workspace.releaseTarget(spec, release.action, release.target, release.remote) !== release.commit) {
        result = { status: 'unknown', detail: '執行後 target 不等於交付 commit，結果不明，絕不自動重試' };
      }
    }
    catch (error) { result = { status: 'unknown', detail: `結果不明，絕不自動重試：${(error as Error).message}` }; }
    deps.store.appendRelease({ type: 'release_result', id, at: new Date(deps.now()).toISOString(), ...result });
    return aiCliKernelReplayReleases(deps.store.readReleases()).get(id)!;
  });
}

/** 別的 runner 接手了。從任何一層丟出來，迴圈最外層接住後直接退出，不再寫任何東西。 */
class SupersededError extends Error {}

export async function runKernelLoop(deps: KernelLoopDeps): Promise<RunState> {
  const { store, contract, executor } = deps;
  const develop = contract.develop;
  const ws = deps.workspace;
  if (develop && !ws) throw new Error('develop 範本一定要有 workspace');
  /** worker、檢查和引用核對都在這裡；develop 是它自己的 worktree，不是使用者的主目錄。 */
  const workDir = develop ? workDirOf(develop) : contract.workFolder;
  const refsBaselinePath = join(store.outputsDir, 'refs-baseline.txt');
  const read = (): RunView => replayJournal(store.read());
  // fencing token：萬一有兩個 runner 同時活著，只有最後啟動的算數。
  const token = randomBytes(8).toString('hex');
  let tokenWritten = false;
  /** 所有寫入都走這裡。舊 runner 從 poll 回來時，不能把結果寫進已經被接手的日誌。 */
  const commit = (body: KernelEventBody): void => {
    if (tokenWritten && read().runnerToken !== token) throw new SupersededError();
    store.append(body);
  };
  const setState = (state: RunState, reason?: string, detail?: string): void => {
    commit({ type: 'state', state, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
  };

  const observeWorkspace = (): void => {
    if (!develop) return;
    const state = ws!.inspect(develop);
    commit({ type: 'workspace_observed', head: state.head, changedFiles: state.changed,
      commits: ws!.commitHistory?.(develop) ?? (state.head === develop.baseCommit ? [] : [state.head]), complete: !!ws!.commitHistory });
  };

  const initial = read();
  if (initial.state !== 'running') return initial.state;
  if (!initial.approvedDigest || store.contractDigest() !== initial.approvedDigest) {
    setState('failed', 'contract_mismatch', '委任書內容和核准時的 digest 不一致，拒絕執行');
    return 'failed';
  }
  const startVersion = deps.versionId();
  store.append({ type: 'runner_started', pid: deps.pid, versionId: startVersion, token });
  tokenWritten = true;
  if (!initial.baselineRecorded) {
    if (develop) store.writeOutput('refs-baseline', ws!.refs(develop).join('\n'));
    commit({ type: 'baseline', git: deps.snapshot(contract.workFolder) });
  }
  const superseded = (view: RunView): boolean => view.runnerToken !== token;

  const recordOutcome = (action: ActionSpec, outcome: ActionOutcome): void => {
    commit({ type: 'action_result', actionId: action.actionId, outcome });
  };
  const failureOutcome = (failureClass: FailureClass, detail: string, status: string | null = null): ActionOutcome => ({
    ok: false, failureClass, detail, jobStatus: status, exitCode: null, messageFile: null, messageChars: 0, messagePreview: '', usage: null,
  });
  const recordJobResult = (action: ActionSpec, result: RawJobResult): void => {
    const verdict = classifyJobResult(result);
    // 先寫輸出再寫結果：當在中間時，結果沒落盤，恢復會重新從 job 讀一次，不會遺失。
    const messageFile = result.message ? store.writeOutput(action.actionId, result.message) : null;
    recordOutcome(action, {
      ok: verdict.ok, failureClass: verdict.failureClass, detail: verdict.detail, jobStatus: result.status, exitCode: result.exitCode,
      messageFile, messageChars: result.message.length, messagePreview: result.message.slice(0, PREVIEW_CHARS), usage: result.usage,
    });
  };

  /** 送出停止並確認程序真的消失。回報 terminated 不算數，舊行程可能還會繼續寫。 */
  const stopJob = async (job: JobRef): Promise<boolean> => {
    await executor.kill(job).catch(() => false);
    const deadline = deps.now() + deps.killConfirmMs;
    for (;;) {
      if (await executor.isGone(job).catch(() => false)) return true;
      if (deps.now() >= deadline) return false;
      await deps.sleep(deps.pollMs);
    }
  };

  /** 回傳 false 表示 run 已經暫停、結束或被別的 runner 接手，迴圈要停。 */
  const waitAndRecord = async (action: ActionSpec, job: JobRef, startedAt: number): Promise<boolean> => {
    // 時限從 job 真正啟動算起，接回不會重新起算。
    const actionDeadline = startedAt + contract.budget.maxActionMinutes * 60000;
    for (;;) {
      const view = read();
      if (superseded(view)) return false;
      if (store.cancelRequested()) {
        if (await stopJob(job)) { recordOutcome(action, failureOutcome('cancelled', '使用者取消')); setState('cancelled', 'user_cancelled'); }
        else setState('stop_pending', 'worker_still_alive', `job ${job.jobId} 還沒確認停止`);
        return false;
      }
      const overAction = deps.now() > actionDeadline;
      const overWall = activeMinutes(view, deps.now()) >= contract.budget.maxWallMinutes;
      if (overAction || overWall) {
        const detail = overWall ? `執行時間超過 ${contract.budget.maxWallMinutes} 分鐘` : `單一 job 超過 ${contract.budget.maxActionMinutes} 分鐘`;
        if (await stopJob(job)) { recordOutcome(action, failureOutcome('timeout', detail)); return true; }
        setState('stop_pending', 'worker_still_alive', `job ${job.jobId} ${detail}，還沒確認停止`);
        return false;
      }
      const poll = await executor.poll(job);
      if (poll.state === 'finished') { recordJobResult(action, poll.result); return true; }
      if (poll.state === 'missing') {
        setState('needs_reconcile', 'job_record_missing', `動作 ${action.actionId} 的 job ${job.jobId} 查不到紀錄，分不出做了沒`);
        return false;
      }
      await deps.sleep(deps.pollMs);
    }
  };

  /** 有意圖、沒結果：不能直接重跑。 */
  const recoverOpen = async (record: ActionRecord): Promise<boolean> => {
    if (record.job) return waitAndRecord(record.spec, record.job, record.startedAt ?? deps.now());
    const found = await executor.find(record.spec.marker);
    if (found === 'unknown') {
      setState('needs_reconcile', 'cannot_verify_start', `查不了動作 ${record.spec.actionId} 是否啟動過`);
      return false;
    }
    if (found === null) {
      commit({ type: 'action_abandoned', actionId: record.spec.actionId, reason: 'JobStore 查無紀錄，確認沒有啟動', refund: true });
      return true;
    }
    commit({ type: 'action_started', actionId: record.spec.actionId, job: found });
    return waitAndRecord(record.spec, found, read().actions.get(record.spec.actionId)?.startedAt ?? deps.now());
  };

  /** 主 repo 的 ref 和開工時比，哪些動了。push、動 master、開分支都會落在這裡。 */
  const refsChanged = (): string[] => {
    if (!develop) return [];
    if (!develop.baseRefRef && !existsSync(refsBaselinePath)) return [];
    const now = ws!.refs(develop);
    // 建立委任書到第一次 runner 啟動之間也可能移動；不能用啟動時的新值取代已核准的 commit。
    const pinned = develop.baseRefRef && !now.includes(`${develop.baseCommit} ${develop.baseRefRef}`) ? [develop.baseRefRef] : [];
    if (!existsSync(refsBaselinePath)) return pinned;
    const before = new Set(readFileSync(refsBaselinePath, 'utf8').split('\n').filter(Boolean));
    const after = new Set(now);
    const name = (line: string) => line.slice(line.indexOf(' ') + 1);
    const changed = [...[...before].filter(line => !after.has(line)), ...now.filter(line => !before.has(line))].map(name);
    return [...new Set([...pinned, ...changed])];
  };

  /** develop 的交付條件。模型的自述不算數，全部從 git 和測試結果判斷。 */
  const developFindings = (view: RunView): string[] => {
    const state = ws!.inspect(develop!);
    const findings: string[] = [];
    if (develop!.checkpoint && develop!.checkpoint.mode !== 'off') {
      try {
        if (!view.checkpoint || !ws!.checkpointValid(develop!, view.checkpoint)) findings.push('回復點 ref 已變動或不存在');
      } catch { findings.push('回復點無法驗證'); }
    }
    if (state.branch !== develop!.branch) findings.push(`目前在 ${state.branch ?? 'detached HEAD'}，不是 ${develop!.branch}`);
    if (!state.ancestorOk) findings.push(`基準 commit ${develop!.baseCommit.slice(0, 10)} 不再是 HEAD 的祖先，歷史被改寫了`);
    if (state.changed.length === 0) findings.push('沒有任何改動，開發任務沒有交付東西');
    const outside = outOfScope(state.changed, develop!.allowedPaths);
    if (outside.length > 0) findings.push(`改到範圍外的路徑：${outside.slice(0, 8).join('、')}`);
    if (state.dirty.length > 0) findings.push(`還有沒 commit 的改動：${state.dirty.slice(0, 8).join('、')}`);
    if (!view.verification?.passed || view.verification.commit !== state.head) findings.push(`最新的 commit ${state.head.slice(0, 10)} 沒有通過測試`);
    return findings;
  };

  const runAcceptance = (stepId: string, messageFile: string | null): void => {
    const message = messageFile ? store.readOutput(messageFile) : '';
    const check = evaluateChecks(contract.acceptance, message, workDir);
    const findings = [...check.findings, ...(develop ? developFindings(read()) : [])];
    commit({ type: 'acceptance', stepId, passed: findings.length === 0, findings });
  };

  /** 工作者的結果要先查 git 才算數。查完才 commit，所以範圍外的改動不會進分支。 */
  const checkDevelopStep = (record: ActionRecord, view: RunView): { passed: true; commit?: string } | { passed: false; failureClass: FailureClass; findings: string[] } => {
    const state: WorkspaceState = ws!.inspect(develop!);
    if (record.spec.mode !== 'write') {
      // 工作目錄本來就不乾淨時（上一步失敗留下的）分不出是誰改的，不能冤枉它。
      if (record.spec.cleanAtStart && (state.dirty.length > 0 || state.head !== view.headCommit)) {
        return { passed: false, failureClass: 'scope_violation', findings: [`唯讀步驟改動了工作目錄：${state.dirty.slice(0, 8).join('、') || `HEAD 變成 ${state.head.slice(0, 10)}`}`] };
      }
      return { passed: true };
    }
    if (state.branch !== develop!.branch) return { passed: false, failureClass: 'scope_violation', findings: [`worker 離開了分支 ${develop!.branch}，目前在 ${state.branch ?? 'detached HEAD'}`] };
    if (!state.ancestorOk) return { passed: false, failureClass: 'scope_violation', findings: [`基準 commit ${develop!.baseCommit.slice(0, 10)} 不再是 HEAD 的祖先，worker 改寫了歷史`] };
    const outside = outOfScope(state.changed, develop!.allowedPaths);
    if (outside.length > 0) return { passed: false, failureClass: 'scope_violation', findings: [`改到範圍外的路徑：${outside.slice(0, 8).join('、')}`] };
    // 跟 kernel 最後確認的 commit 比，不是跟上次 inspect 比：當在 commit 和落盤之間時，重來不會把已經 commit 的誤判成沒改動。
    if (state.dirty.length === 0 && state.head === view.headCommit) return { passed: false, failureClass: 'check_failed', findings: ['worker 回報完成，但工作目錄沒有任何改動'] };
    if (state.dirty.length === 0) return { passed: true, commit: state.head };
    const title = view.plan?.steps.find(step => step.id === record.spec.stepId)?.title ?? record.spec.stepId;
    let commit: string;
    try { commit = ws!.commit(develop!, `ai-cli_kernel(${store.runId}): ${title}`); }
    catch (error) { return { passed: false, failureClass: 'commit_failed', findings: [(error as Error).message] }; }
    // commit hook 是 repo 自己的規矩，kernel 不跳過，但它可能在檢查之後才加東西。commit 完要再查一次。
    const outsideAfter = outOfScope(ws!.inspect(develop!).changed, develop!.allowedPaths);
    if (outsideAfter.length > 0) return { passed: false, failureClass: 'scope_violation', findings: [`commit 之後多了範圍外的路徑（可能是 commit hook 加的）：${outsideAfter.slice(0, 8).join('、')}`] };
    return { passed: true, commit };
  };

  /** job 回報結束不等於程序停了。還活著就不能 commit：它之後寫的東西會混進來。 */
  const confirmWorkerGone = async (job: JobRef): Promise<boolean> => {
    const deadline = deps.now() + deps.killConfirmMs;
    for (;;) {
      if (await executor.isGone(job).catch(() => false)) return true;
      if (deps.now() >= deadline) return stopJob(job);
      await deps.sleep(deps.pollMs);
    }
  };

  /** 回傳 false 表示 run 暫停了。 */
  const digestWorker = async (record: ActionRecord, view: RunView): Promise<boolean> => {
    const stepId = record.spec.stepId!;
    const actionId = record.spec.actionId;
    const outcome = record.outcome!;
    if (develop && record.spec.mode === 'write' && record.job && !await confirmWorkerGone(record.job)) {
      setState('stop_pending', 'worker_still_alive', `job ${record.job.jobId} 回報結束了但程序還在，不能接著動工作目錄`);
      return false;
    }
    if (!outcome.ok) {
      if (develop) observeWorkspace();
      commit({ type: 'step_checked', actionId, stepId, passed: false, failureClass: outcome.failureClass ?? 'process_failed', findings: [outcome.detail] });
      return true;
    }
    const message = outcome.messageFile ? store.readOutput(outcome.messageFile) : '';
    const check = evaluateChecks(contract.stepChecks, message, workDir);
    if (!check.passed) {
      if (develop) observeWorkspace();
      commit({ type: 'step_checked', actionId, stepId, passed: false, failureClass: 'check_failed', findings: check.findings });
      return true;
    }
    if (develop) {
      const result = checkDevelopStep(record, view);
      observeWorkspace();
      if (!result.passed) { commit({ type: 'step_checked', actionId, stepId, passed: false, failureClass: result.failureClass, findings: result.findings }); return true; }
      commit({ type: 'step_checked', actionId, stepId, passed: true, findings: [], ...(result.commit ? { commit: result.commit } : {}) });
      return true; // 驗收要等測試跑完，由主迴圈接手。
    }
    commit({ type: 'step_checked', actionId, stepId, passed: true, findings: [] });
    if (view.plan?.reportStep === stepId) runAcceptance(stepId, outcome.messageFile);
    return true;
  };

  /** kernel 自己跑指令。回傳 null 表示 run 被取消或被接手，呼叫端要停。 */
  const runCheck = async (kind: 'setup' | 'test' | 'context', command: string, seq: number): Promise<{ exitCode: number | null; timedOut: boolean; tail: string; output?: string } | null> => {
    let handle;
    try { handle = ws!.startCheck(command, kind === 'context' ? contract.workFolder : workDir, join(store.dir, 'checks', `${kind}-${seq}.log`), kind === 'context' ? 8000 : undefined); }
    catch (error) {
      if (kind !== 'context') throw error;
      return { exitCode: null, timedOut: false, tail: (error as Error).message };
    }
    /** 確認真的停了才算數。送出訊號不等於停了，舊程序可能還在動工作目錄。 */
    const stopConfirmed = async (): Promise<boolean> => {
      if (await handle.kill()) { commit({ type: 'check_finished', pid: handle.pid }); return true; }
      setState('stop_pending', 'check_still_alive', `kernel 跑的檢查指令（pid ${handle.pid}）還沒確認停止`);
      return false;
    };
    try {
      // spawn 完馬上記 pid，查身分要好幾秒，不能等。這樣當機時最多只漏掉幾毫秒的窗口。
      commit({ type: 'check_started', kind, pid: handle.pid, started: '', name: '' });
      const identity = await handle.identify();
      commit({ type: 'check_started', kind, pid: handle.pid, started: identity.started, name: identity.name });
    } catch (error) { await handle.kill(); throw error; }
    // 總時間也要算進來：測試跑得比剩下的預算久時，不能等它自己跑完。
    const startedAt = deps.now();
    const wallLeftMs = (contract.budget.maxWallMinutes - activeMinutes(read(), startedAt)) * 60000;
    const deadline = startedAt + Math.min(contract.budget.maxActionMinutes * 60000, wallLeftMs);
    for (;;) {
      if (superseded(read())) { await handle.kill(); return null; }
      if (store.cancelRequested()) {
        if (await stopConfirmed()) setState('cancelled', 'user_cancelled');
        return null;
      }
      if (deps.now() > deadline) {
        if (!await stopConfirmed()) return null;
        return { exitCode: null, timedOut: true, tail: handle.tail() };
      }
      // 用真的計時器等：只靠 deps.sleep 的話，測試的假 sleep 不會讓出 I/O，結束事件永遠進不來。
      const done = await handle.wait(Math.max(20, Math.min(deps.pollMs, 500)));
      if (done) {
        commit({ type: 'check_finished', pid: handle.pid });
        return { exitCode: done.exitCode, timedOut: false, tail: done.tail, ...(done.output !== undefined ? { output: done.output } : {}) };
      }
    }
  };

  /** 上一個 runner 留下的檢查指令。舊程序還在跑就不能接著動工作目錄。 */
  const clearOrphanCheck = async (view: RunView): Promise<boolean> => {
    const check = view.openCheck;
    if (!check) return true;
    if (!await ws!.stopOrphanCheck(check).catch(() => false)) {
      // 當初沒查到身分就認不出來，重查也沒用，要人確認。不開這條路的話，pid 剛好被重用時會永遠卡住。
      if (!check.started) setState('needs_reconcile', 'check_identity_unknown', `kernel 跑的檢查指令 pid ${check.pid} 還在，但認不出是不是當初那個。確認後執行 ai-cli kernel approve ${store.runId} --reconcile abandon`);
      else setState('stop_pending', 'check_still_alive', `kernel 跑的檢查指令（pid ${check.pid}）還沒確認停止`);
      return false;
    }
    // 測試開始時工作目錄一定是乾淨的，所以留下的只會是副產物。正常路徑跑完也會清，這裡補當機那條路。
    if (check.kind === 'test' && view.workspaceReady) {
      try {
        ws!.restore(develop!);
      } catch (error) {
        setState('waiting_human', 'workspace_failed', `接回時還原工作目錄失敗：${(error as Error).message}`);
        return false;
      }
    }
    commit({ type: 'check_finished', pid: check.pid });
    return true;
  };

  /** 回復點必須先完成，才可以準備工作區、跑指令或派模型。 */
  const prepareCheckpoint = (view: RunView): boolean => {
    const spec = develop!.checkpoint;
    if (!spec) return true; // 舊委任書的 digest 不變，不能偷偷加上新操作。
    if (spec.mode === 'off') {
      if (contract.origin?.kind === 'trigger') {
        setState('waiting_human', 'checkpoint_off_forbidden', '觸發的 run 不能關閉回復點');
        return false;
      }
      return true;
    }
    if (view.checkpoint) {
      if (!ws!.checkpointValid(develop!, view.checkpoint)) {
        setState('waiting_human', 'checkpoint_changed', '回復點 ref 已變動或不存在');
        return false;
      }
      return true;
    }
    let prepared = view.checkpointPrepared;
    if (!prepared) {
      let snapshot: string;
      try { snapshot = ws!.checkpointSnapshot(develop!); }
      catch (error) { setState('waiting_human', 'checkpoint_failed', (error as Error).message); return false; }
      prepared = { commit: snapshot, ref: spec.ref };
      commit({ type: 'checkpoint_prepared', ...prepared });
    }
    try { ws!.checkpointRef(develop!, prepared.commit); }
    catch (error) { setState('waiting_human', 'checkpoint_failed', (error as Error).message); return false; }
    const localOnly = view.overrides.has('checkpoint_push_failed') && contract.origin?.kind !== 'trigger';
    let pushed = false;
    if (spec.mode === 'push' && !localOnly) {
      let secrets: string[];
      try { secrets = ws!.checkpointSecretPaths(develop!, prepared.commit); }
      catch (error) { setState('waiting_human', 'checkpoint_failed', (error as Error).message); return false; }
      if (secrets.length) {
        setState('waiting_human', 'checkpoint_secret_risk', `回復點含疑似秘密路徑，不會推送：${secrets.slice(0, 8).join('、')}`);
        return false;
      }
      try { ws!.pushCheckpoint(develop!, prepared.commit); }
      catch (error) { setState('waiting_human', 'checkpoint_push_failed', (error as Error).message); return false; }
      pushed = true;
    }
    commit({ type: 'checkpoint', ...prepared, pushed, remote: spec.remote });
    return true;
  };

  const prepareWorkspace = async (view: RunView): Promise<boolean> => {
    try { ws!.prepare(develop!); }
    catch (error) { setState('waiting_human', 'workspace_failed', (error as Error).message); return false; }
    if (develop!.setupCommand) {
      const result = await runCheck('setup', develop!.setupCommand, view.lastSeq);
      if (!result) return false;
      if (result.exitCode !== 0) {
        setState('waiting_human', 'workspace_failed', `準備指令 ${develop!.setupCommand} 失敗（${result.timedOut ? '逾時' : `exit ${result.exitCode}`}）：${result.tail.slice(-1500)}`);
        return false;
      }
    }
    const ready = ws!.inspect(develop!);
    // 準備指令留下的東西（例如 npm install 改了 lockfile）會被下一次 commit 一起交付，而且那不是任何 worker 改的。
    if (ready.dirty.length > 0) {
      setState('waiting_human', 'workspace_failed', `準備好的工作目錄不乾淨，這些會混進交付：${ready.dirty.slice(0, 8).join('、')}。請改用不會動到這些檔案的準備指令（例如 npm ci），或把它們加進 .gitignore。`);
      return false;
    }
    commit({ type: 'workspace_ready', head: ready.head });
    observeWorkspace();
    return true;
  };

  /** 跑測試。結果綁定 commit：之後只要 HEAD 動了，這次通過就不算數。 */
  const verify = async (head: string, view: RunView): Promise<boolean> => {
    const result = await runCheck('test', develop!.testCommand, view.lastSeq);
    if (!result) return false;
    const after = ws!.inspect(develop!).head;
    const moved = after !== head;
    try { ws!.restore(develop!); }
    catch (error) { setState('waiting_human', 'workspace_failed', `測試後還原工作目錄失敗：${(error as Error).message}`); return false; }
    const tail = (moved ? `測試指令移動了 HEAD（${head.slice(0, 10)} → ${after.slice(0, 10)}），不算通過。\n` : '') + result.tail.slice(-4000);
    observeWorkspace();
    commit({ type: 'verification', commit: head, passed: result.exitCode === 0 && !result.timedOut && !moved, exitCode: result.exitCode, timedOut: result.timedOut, tail });
    return true;
  };

  const digestDecide = (record: ActionRecord, view: RunView): void => {
    const actionId = record.spec.actionId;
    const outcome = record.outcome!;
    if (!outcome.ok) {
      commit({ type: 'decide_processed', actionId, ok: false, reason: `${outcome.failureClass}：${outcome.detail}` });
      return;
    }
    const message = outcome.messageFile ? store.readOutput(outcome.messageFile) : '';
    let decision;
    try { decision = parseDecision(message, contract, view.planCount + 1); }
    catch (error) {
      commit({ type: 'decide_processed', actionId, ok: false, reason: (error as Error).message });
      return;
    }
    const memories = decision.action === 'plan' || decision.action === 'finish'
      ? aiCliKernelMemoryCandidates(decision.lessons ?? [], store.runId, actionId, { template: contract.template, ...(deps.memory?.paths.length ? { paths: deps.memory.paths } : {}) }, new Date(deps.now()).toISOString()) : [];
    switch (decision.action) {
      case 'plan':
        commit({ type: 'decide_processed', actionId, ok: true, decision: 'plan', memories, plan: { planId: decision.planId, steps: decision.steps, ...(decision.reportStep ? { reportStep: decision.reportStep } : {}) } });
        return;
      case 'ask_human':
        // 問題和處理標記寫在同一筆：當在中間也不會漏掉人工閘。
        commit({ type: 'decide_processed', actionId, ok: true, decision: 'ask_human', stop: { state: 'waiting_human', reason: 'decide_question', detail: decision.question } });
        return;
      case 'give_up':
        commit({ type: 'decide_processed', actionId, ok: true, decision: 'give_up', stop: { state: 'failed', reason: 'decide_gave_up', detail: decision.reason } });
        return;
      case 'finish': {
        const step = view.stepResults.get(decision.reportStep);
        if (!step?.passed) {
          commit({ type: 'decide_processed', actionId, ok: false, reason: `finish 指定的步驟 ${decision.reportStep} 不存在或沒有通過` });
          return;
        }
        // 要結案哪一步和處理標記寫在同一筆：當在中間時，接回還知道要驗收，不會多花一次 decide。
        commit({ type: 'decide_processed', actionId, ok: true, decision: 'finish', finishStep: decision.reportStep, memories });
        runAcceptance(decision.reportStep, step.messageFile);
        return;
      }
    }
  };

  /** 所有檢查都過了才走到這裡。 */
  const finalize = (view: RunView): void => {
    const stepId = view.acceptance!.stepId;
    // 驗收和交付之間可能隔著一次暫停，這段時間分支可能又動過。當初的驗收不能替現在的 HEAD 背書。
    if (develop) {
      const findings = developFindings(view);
      if (findings.length > 0) { commit({ type: 'acceptance', stepId, passed: false, findings }); return; }
    }
    const step = view.stepResults.get(stepId)!;
    let readOnly: 'unchanged' | 'changed' | 'changed_accepted' | 'not_git' | 'unverifiable' = 'not_git';
    if (view.baseline) {
      const current = deps.snapshot(contract.workFolder);
      if (!current) readOnly = 'unverifiable';
      else if (snapshotsEqual(view.baseline, current)) readOnly = 'unchanged';
      else if (view.overrides.has('worktree_changed')) readOnly = 'changed_accepted';
      // develop 的成果只在分支上，還沒合併。主目錄動過多半是使用者自己在工作或 hook 寫了檔，停下來救不回已發生的事，
      // 只會讓跑完的任務卡到天亮、還佔著鎖。所以寫進報告讓人收下前看到，不擋交付。
      else if (develop) readOnly = 'changed';
      else {
        setState('waiting_human', 'worktree_changed', `${develop ? '主目錄' : '工作目錄'}在 run 期間有變動（基準 ${view.baseline.head.slice(0, 8)}、${view.baseline.dirtyEntries} 筆未提交；目前 ${current.head.slice(0, 8)}、${current.dirtyEntries} 筆）。可能是其他 session，也可能是 worker，請先確認。`);
        return;
      }
    }
    const movedRefs = develop ? refsChanged() : [];
    const warnings = develop ? [
      ...(readOnly === 'changed' || readOnly === 'changed_accepted' ? ['主目錄在 run 期間有變動。可能是你自己在工作、其他 session 或 hook，也可能是 worker 越界，收下前請確認。'] : []),
      ...(movedRefs.length > 0 ? [`repo 裡這些 ref 在 run 期間動過：${movedRefs.slice(0, 8).join('、')}。可能是其他 session，也可能是 worker 動了分支或 push，收下前請確認。`] : []),
    ] : [];
    const worker = view.actions.get(step.actionId)?.outcome;
    const delivered = develop ? ws!.inspect(develop) : null;
    if (develop) observeWorkspace();
    const evidence = develop ? ws!.reviewEvidence(develop, REVIEW_DIFF_CHARS) : null;
    const stat = evidence?.stat ?? '';
    const report = store.readOutput(step.messageFile!);
    store.writeReport(develop && delivered ? `${report.trimEnd()}

${warnings.length > 0 ? `## 注意（由 kernel 產生）\n${warnings.map(warning => `- ${warning}`).join('\n')}\n\n` : ''}## 交付（由 kernel 產生）
- 分支：${develop.branch}
- 基準：${develop.baseCommit}
- 最新：${delivered.head}
- 測試：${develop.testCommand} 在最新 commit 上通過
- worktree：${develop.worktree}
- 回復點：${view.checkpoint ? `${view.checkpoint.ref} @ ${view.checkpoint.commit}（${view.checkpoint.pushed ? `已推到 ${view.checkpoint.remote}` : '只留本地'}）` : develop.checkpoint?.mode === 'off' ? '人手動核准關閉' : '舊委任書未設定'}
- 交付分支還沒合併、也沒有 push。看過沒問題再自己合併：git merge ${develop.branch}
- 如需 kernel 執行，先由人在 CLI 建立單次放行：ai-cli kernel release create ${store.runId} --action merge|push --target <branch> --confirm ${delivered.head.slice(0, 10)}，再 release run <id>。推遠端預設分支可能等於部署，需額外同意。

\`\`\`
${stat}
\`\`\`
` : report);
    if (view.context && !view.context.ok) store.writeReport(`${store.readOutput(store.reportPath).trimEnd()}\n\n## 外部資料讀取\ncontextCommand 失敗（不阻擋開工）：${view.context.detail}\n`);
    if (evidence) store.writeReport(`${store.readOutput(store.reportPath).trimEnd()}${kernelTestInventory(evidence.baselineTests)}`);
    store.writeVerdict({
      authorization: { ok: true, contractDigest: view.approvedDigest },
      execution: { ok: true, jobStatus: worker?.jobStatus ?? null, exitCode: worker?.exitCode ?? null },
      delivery: { ok: true, reportStep: stepId, checks: contract.acceptance.map(check => check.type) },
      ...(develop && delivered ? {
        checkpoint: view.checkpoint,
        checkpointMode: develop.checkpoint?.mode === 'push' && view.overrides.has('checkpoint_push_failed') && contract.origin?.kind !== 'trigger' ? 'local' : develop.checkpoint?.mode ?? null,
        mainFolder: readOnly,
        refsChanged: movedRefs,
        develop: { branch: develop.branch, baseCommit: develop.baseCommit, headCommit: delivered.head, changedFiles: delivered.changed, testCommand: develop.testCommand, testPassedOn: view.verification?.commit ?? null, testFailures: view.testFailures, worktree: develop.worktree },
      } : { readOnly }),
      boundaryLabel: develop ? 'declared-not-isolated' : contract.allowUnverifiedBoundary ? 'unverified_allowed_by_caller' : 'tool-limited-not-isolated',
      usage: view.counters,
      context: view.context,
      finishedAt: new Date(deps.now()).toISOString(),
    });
    setState('completed', 'delivered', warnings.join(' '));
  };

  /** 閘：派工前最後一關。回傳 false 表示暫停。 */
  const gateDispatch = async (spec: ActionSpec): Promise<boolean> => {
    const view = read();
    const agent = deps.agentFor(spec.model);
    if (develop && spec.kind === 'worker') {
      if (deps.now() > Date.parse(develop.expiresAt) && !view.overrides.has('mandate_expired')) {
        setState('waiting_human', 'mandate_expired', `委任書在 ${develop.expiresAt} 失效了。worker 是全權限，要你重新同意才繼續派。`);
        return false;
      }
      const moved = refsChanged();
      if (moved.length > 0 && !view.overrides.has('repo_refs_changed')) {
        setState('waiting_human', 'repo_refs_changed', `repo 裡這些 ref 在 run 期間動過：${moved.slice(0, 8).join('、')}。可能是其他 session，也可能是 worker 動了分支或 push，請先確認。`);
        return false;
      }
    }
    // develop 已經明示未隔離：探針證明的「工具受限」在這裡本來就不成立，不用拿來擋。
    if (!develop && !contract.allowUnverifiedBoundary) {
      const boundary = await deps.boundary(agent).catch((): BoundaryStatus => 'UNKNOWN');
      if (boundary !== 'PASS') {
        setState('waiting_human', 'boundary_unverified', `${agent} 的權限邊界探針結果是 ${boundary}。可能是 CLI 更新過，請先跑 probe。`);
        return false;
      }
    }
    const remaining = await deps.quota(agent).catch(() => null);
    if (remaining === null) {
      // 未知不等於還夠：只能在委任書事先核准的保守上限內繼續。
      if (view.counters.quotaUnknownDispatches >= contract.budget.quotaUnknownMaxDispatches && !view.overrides.has('quota_unknown')) {
        setState('waiting_human', 'quota_unknown', `${agent} 額度量不到，已用完 ${contract.budget.quotaUnknownMaxDispatches} 次保守上限`);
        return false;
      }
      commit({ type: 'quota_unknown', agent });
    } else if (remaining < contract.budget.minQuotaRemainingPercent && !view.overrides.has('quota_low')) {
      setState('waiting_human', 'quota_low', `${agent} 週額度只剩 ${remaining}%，低於 ${contract.budget.minQuotaRemainingPercent}%`);
      return false;
    }
    return true;
  };

  const dispatch = async (spec: ActionSpec): Promise<boolean> => {
    if (!await gateDispatch(spec)) return false;
    // 探針和額度查詢可能花掉不少時間，派工前再確認一次：這段時間可能已經被取消或超時。
    const fresh = read();
    if (superseded(fresh)) return false;
    if (store.cancelRequested()) { setState('cancelled', 'user_cancelled'); return false; }
    if (activeMinutes(fresh, deps.now()) >= contract.budget.maxWallMinutes) { setState('budget_exhausted', 'wall_clock', `已用滿 ${contract.budget.maxWallMinutes} 分鐘`); return false; }
    // 先記意圖。這行丟例外就不會執行，這正是要的行為。
    commit({ type: 'action_intent', action: spec });
    let job: JobRef;
    try { job = await executor.start(spec, contract); }
    catch (error) {
      recordOutcome(spec, failureOutcome('start_failed', (error as Error).message));
      return true;
    }
    commit({ type: 'action_started', actionId: spec.actionId, job });
    return waitAndRecord(spec, job, deps.now());
  };

  const makeSpec = (view: RunView, kind: 'decide' | 'worker', step?: PlanStep): ActionSpec => {
    const actionId = `a${view.actions.size + 1}`;
    const marker = actionMarker(store.runId, actionId);
    const placement = develop ? { cwd: workDir } : {};
    if (kind === 'decide') {
      const context = view.context?.ok && view.context.outputFile ? store.readOutput(view.context.outputFile) : undefined;
      return { actionId, kind, model: contract.decide.model, ...(contract.decide.effort ? { effort: contract.decide.effort } : {}), marker, prompt: buildDecidePrompt(contract, view, marker, deps.now(), { memories: deps.memory?.read(), paths: deps.memory?.paths, context }), ...placement };
    }
    const isReport = view.plan?.reportStep === step!.id;
    const mode = step!.mode ?? 'read';
    const review = develop && (mode !== 'write' || isReport) ? { verification: view.verification, ...ws!.reviewEvidence(develop, REVIEW_DIFF_CHARS) } : undefined;
    return {
      actionId, kind, stepId: step!.id, model: step!.model ?? contract.worker.model,
      ...(contract.worker.effort ? { effort: contract.worker.effort } : {}), marker, prompt: buildWorkerPrompt(contract, step!, marker, isReport, review),
      ...placement, ...(develop ? { mode, cleanAtStart: ws!.inspect(develop).dirty.length === 0 } : {}),
    };
  };

  /* ---- 主迴圈 ---- */
  try {
  for (;;) {
    const view = read();
    if (superseded(view)) return view.state; // 別的 runner 接手了，這裡不再寫任何東西。
    if (view.state !== 'running') return view.state;
    if (view.openCheck && !await clearOrphanCheck(view)) return read().state;
    // 日誌先存候選，再補本機記憶。當在兩次寫入之間也不遺失；已 promote/revoke 的 id 不覆蓋。
    deps.memory?.candidates(view.candidateMemories);
    if (store.cancelRequested() && openActions(view).length === 0) { setState('cancelled', 'user_cancelled'); return 'cancelled'; }
    if (develop && !view.workspaceReady && !prepareCheckpoint(view)) return read().state;
    if (contract.contextCommand && !view.context) {
      if (view.contextStarted) {
        commit({ type: 'context_result', ok: false, outputFile: null, exitCode: null, timedOut: false, detail: '上次 contextCommand 執行中斷，結果不明；不重試，繼續開工' });
        continue;
      }
      commit({ type: 'context_intent' });
      const result = await runCheck('context', contract.contextCommand, view.lastSeq);
      if (!result) return read().state;
      const ok = result.exitCode === 0 && !result.timedOut;
      const outputFile = store.writeOutput('context', ok ? (result.output ?? '').slice(0, 8000) : '');
      commit({ type: 'context_result', ok, outputFile, exitCode: result.exitCode, timedOut: result.timedOut, detail: ok ? '' : `${result.timedOut ? '逾時' : `exit ${result.exitCode}`}：${result.tail.slice(-1500)}` });
      continue;
    }
    if (develop && !view.workspaceReady) {
      if (!await prepareWorkspace(view)) return read().state;
      continue;
    }

    const open = openActions(view);
    if (open.length > 0) { if (!await recoverOpen(open[0])) return read().state; continue; }

    const pending = unprocessedActions(view);
    if (pending.length > 0) {
      if (pending[0].spec.kind === 'decide') digestDecide(pending[0], view);
      else if (!await digestWorker(pending[0], view)) return read().state;
      continue;
    }

    const stop = derivedStop(view);
    if (stop) { setState(stop.state, stop.reason, stop.detail); return stop.state; }

    if (view.acceptance?.passed) {
      finalize(view);
      const after = read();
      if (after.state === 'running') continue; // 交付前發現分支又動過，回去重來。
      return after.state;
    }
    if (view.pendingFinish) { runAcceptance(view.pendingFinish, view.stepResults.get(view.pendingFinish)?.messageFile ?? null); continue; }
    if (!develop && view.plan?.reportStep && view.stepResults.get(view.plan.reportStep)?.passed && !view.acceptance) {
      // 報告步驟通過、驗收還沒寫就當掉了。develop 要先跑測試，在下面處理。
      runAcceptance(view.plan.reportStep, view.stepResults.get(view.plan.reportStep)!.messageFile);
      continue;
    }

    const { budget } = contract;
    if (activeMinutes(view, deps.now()) >= budget.maxWallMinutes) { setState('budget_exhausted', 'wall_clock', `已用滿 ${budget.maxWallMinutes} 分鐘`); return 'budget_exhausted'; }
    const uncachedTokens = view.counters.inputTokens - view.counters.cachedTokens;
    if (uncachedTokens >= budget.maxInputTokens) { setState('budget_exhausted', 'input_tokens', `已用 ${uncachedTokens} 未快取的 input tokens（另有 ${view.counters.cachedTokens} 快取）`); return 'budget_exhausted'; }
    // 更新會原地換掉 dist：停下來，不讓舊的探針結果替新程式背書。
    if (deps.versionId() !== startVersion) { setState('version_drift', 'dist_changed', '執行中偵測到 ai-cli 程式被更新'); return 'version_drift'; }

    if (develop) {
      if (view.testFailures >= budget.maxTestFailures) { setState('budget_exhausted', 'test_failures', `測試已經失敗 ${view.testFailures} 次`); return 'budget_exhausted'; }
      const report = view.plan?.reportStep;
      const reportPassed = !!report && !!view.stepResults.get(report)?.passed;
      const upcoming = nextStep(view);
      // 接下來是審查、或計畫走完了，就要先測：測試沒過的東西不值得花額度審查，審查者也才看得到結果。
      // 下一步還是寫入就不測，改到一半的狀態本來就可能是壞的。
      if (view.plan && (reportPassed || !upcoming || upcoming.mode !== 'write')) {
        const state = ws!.inspect(develop);
        // 有新 commit 就要重測。結果沒過時 plan 會被清掉，不會走到下面的驗收。
        if (state.changed.length > 0 && state.dirty.length === 0 && view.verification?.commit !== state.head) {
          if (!await verify(state.head, view)) return read().state;
          continue;
        }
        if (reportPassed && !view.acceptance) { runAcceptance(report!, view.stepResults.get(report!)!.messageFile); continue; }
      }
    }

    const step = nextStep(view);
    if (step) {
      if (view.counters.workerSteps >= budget.maxWorkerSteps) { setState('budget_exhausted', 'worker_steps', `已派滿 ${budget.maxWorkerSteps} 個 worker`); return 'budget_exhausted'; }
      if (!await dispatch(makeSpec(view, 'worker', step))) return read().state;
      continue;
    }
    if (view.counters.decides >= budget.maxDecides) { setState('budget_exhausted', 'decides', `已決策滿 ${budget.maxDecides} 次`); return 'budget_exhausted'; }
    if (!await dispatch(makeSpec(view, 'decide'))) return read().state;
  }
  } catch (error) {
    if (error instanceof SupersededError) return read().state;
    throw error;
  }
}
