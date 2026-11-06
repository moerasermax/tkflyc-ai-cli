/**
 * Kernel 迴圈：確定性程式，模型只出現在 decide 這一格。
 *
 *   讀日誌 → 該停就停 → 恢復未結案動作 → 消化結果 → 閘 → 先記意圖 → 執行 → 記結果 → 驗收
 *
 * 所有依賴都從參數傳入，測試用假執行器就能走遍每一種當機位置，不必啟動 vendor。
 */
import { randomBytes } from 'node:crypto';
import { activeMinutes, derivedStop, nextStep, openActions, replayJournal, unprocessedActions, type ActionRecord, type RunView } from './replay.js';
import { actionMarker, buildDecidePrompt, buildWorkerPrompt, parseDecision } from './plan.js';
import { classifyJobResult, evaluateChecks, snapshotsEqual } from './verdict.js';
import type { RunStore } from './journal.js';
import type { ActionOutcome, ActionSpec, BoundaryStatus, FailureClass, GitSnapshot, JobRef, KernelContract, KernelEventBody, KernelExecutor, PlanStep, RawJobResult, RunState } from './types.js';

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
}

const PREVIEW_CHARS = 1500;

/** 別的 runner 接手了。從任何一層丟出來，迴圈最外層接住後直接退出，不再寫任何東西。 */
class SupersededError extends Error {}

export async function runKernelLoop(deps: KernelLoopDeps): Promise<RunState> {
  const { store, contract, executor } = deps;
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

  const initial = read();
  if (initial.state !== 'running') return initial.state;
  if (!initial.approvedDigest || store.contractDigest() !== initial.approvedDigest) {
    setState('failed', 'contract_mismatch', '委任書內容和核准時的 digest 不一致，拒絕執行');
    return 'failed';
  }
  const startVersion = deps.versionId();
  store.append({ type: 'runner_started', pid: deps.pid, versionId: startVersion, token });
  tokenWritten = true;
  if (!initial.baselineRecorded) commit({ type: 'baseline', git: deps.snapshot(contract.workFolder) });
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

  const runAcceptance = (stepId: string, messageFile: string | null): void => {
    const message = messageFile ? store.readOutput(messageFile) : '';
    const check = evaluateChecks(contract.acceptance, message, contract.workFolder);
    commit({ type: 'acceptance', stepId, passed: check.passed, findings: check.findings });
  };

  const digestWorker = (record: ActionRecord, view: RunView): void => {
    const stepId = record.spec.stepId!;
    const actionId = record.spec.actionId;
    const outcome = record.outcome!;
    if (!outcome.ok) {
      commit({ type: 'step_checked', actionId, stepId, passed: false, failureClass: outcome.failureClass ?? 'process_failed', findings: [outcome.detail] });
      return;
    }
    const message = outcome.messageFile ? store.readOutput(outcome.messageFile) : '';
    const check = evaluateChecks(contract.stepChecks, message, contract.workFolder);
    if (!check.passed) {
      commit({ type: 'step_checked', actionId, stepId, passed: false, failureClass: 'check_failed', findings: check.findings });
      return;
    }
    commit({ type: 'step_checked', actionId, stepId, passed: true, findings: [] });
    if (view.plan?.reportStep === stepId) runAcceptance(stepId, outcome.messageFile);
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
    switch (decision.action) {
      case 'plan':
        commit({ type: 'decide_processed', actionId, ok: true, decision: 'plan', plan: { planId: decision.planId, steps: decision.steps, ...(decision.reportStep ? { reportStep: decision.reportStep } : {}) } });
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
        commit({ type: 'decide_processed', actionId, ok: true, decision: 'finish' });
        runAcceptance(decision.reportStep, step.messageFile);
        return;
      }
    }
  };

  /** 所有檢查都過了才走到這裡。 */
  const finalize = (view: RunView): void => {
    const stepId = view.acceptance!.stepId;
    const step = view.stepResults.get(stepId)!;
    let readOnly: 'unchanged' | 'changed_accepted' | 'not_git' | 'unverifiable' = 'not_git';
    if (view.baseline) {
      const current = deps.snapshot(contract.workFolder);
      if (!current) readOnly = 'unverifiable';
      else if (snapshotsEqual(view.baseline, current)) readOnly = 'unchanged';
      else if (view.overrides.has('worktree_changed')) readOnly = 'changed_accepted';
      else {
        setState('waiting_human', 'worktree_changed', `工作目錄在 run 期間有變動（基準 ${view.baseline.head.slice(0, 8)}、${view.baseline.dirtyEntries} 筆未提交；目前 ${current.head.slice(0, 8)}、${current.dirtyEntries} 筆）。可能是其他 session，也可能是 worker，請先確認。`);
        return;
      }
    }
    const worker = view.actions.get(step.actionId)?.outcome;
    store.writeReport(store.readOutput(step.messageFile!));
    store.writeVerdict({
      authorization: { ok: true, contractDigest: view.approvedDigest },
      execution: { ok: true, jobStatus: worker?.jobStatus ?? null, exitCode: worker?.exitCode ?? null },
      delivery: { ok: true, reportStep: stepId, checks: contract.acceptance.map(check => check.type) },
      readOnly,
      boundaryLabel: contract.allowUnverifiedBoundary ? 'unverified_allowed_by_caller' : 'tool-limited-not-isolated',
      usage: view.counters,
      finishedAt: new Date(deps.now()).toISOString(),
    });
    setState('completed', 'delivered');
  };

  /** 閘：派工前最後一關。回傳 false 表示暫停。 */
  const gateDispatch = async (spec: ActionSpec): Promise<boolean> => {
    const view = read();
    const agent = deps.agentFor(spec.model);
    if (!contract.allowUnverifiedBoundary) {
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
    if (kind === 'decide') {
      return { actionId, kind, model: contract.decide.model, ...(contract.decide.effort ? { effort: contract.decide.effort } : {}), marker, prompt: buildDecidePrompt(contract, view, marker, deps.now()) };
    }
    const isReport = view.plan?.reportStep === step!.id;
    return {
      actionId, kind, stepId: step!.id, model: step!.model ?? contract.worker.model,
      ...(contract.worker.effort ? { effort: contract.worker.effort } : {}), marker, prompt: buildWorkerPrompt(contract, step!, marker, isReport),
    };
  };

  /* ---- 主迴圈 ---- */
  try {
  for (;;) {
    const view = read();
    if (superseded(view)) return view.state; // 別的 runner 接手了，這裡不再寫任何東西。
    if (view.state !== 'running') return view.state;
    if (store.cancelRequested() && openActions(view).length === 0) { setState('cancelled', 'user_cancelled'); return 'cancelled'; }

    const open = openActions(view);
    if (open.length > 0) { if (!await recoverOpen(open[0])) return read().state; continue; }

    const pending = unprocessedActions(view);
    if (pending.length > 0) {
      if (pending[0].spec.kind === 'decide') digestDecide(pending[0], view); else digestWorker(pending[0], view);
      continue;
    }

    const stop = derivedStop(view);
    if (stop) { setState(stop.state, stop.reason, stop.detail); return stop.state; }

    if (view.acceptance?.passed) { finalize(view); return read().state; }

    const { budget } = contract;
    if (activeMinutes(view, deps.now()) >= budget.maxWallMinutes) { setState('budget_exhausted', 'wall_clock', `已用滿 ${budget.maxWallMinutes} 分鐘`); return 'budget_exhausted'; }
    if (view.counters.inputTokens >= budget.maxInputTokens) { setState('budget_exhausted', 'input_tokens', `已用 ${view.counters.inputTokens} input tokens`); return 'budget_exhausted'; }
    // 更新會原地換掉 dist：停下來，不讓舊的探針結果替新程式背書。
    if (deps.versionId() !== startVersion) { setState('version_drift', 'dist_changed', '執行中偵測到 ai-cli 程式被更新'); return 'version_drift'; }

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
