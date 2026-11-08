/**
 * 重播日誌：純函式，把事件變回目前狀態。沒有 I/O，所以每一種當機位置都能便宜地驗。
 *
 * 計數和「該不該停」都從日誌算出來，不依賴兩次寫入之間沒有當機：
 * 預算不會因為 runner 重啟而歸零，人工閘也不會因為當在中間而漏掉。
 */
import { NEEDS_HUMAN_FAILURES, type ActionOutcome, type ActionSpec, type CheckpointRecord, type FailureClass, type GitSnapshot, type JobRef, type KernelEvent, type PlanStep, type RunState, type StopDecision } from './types.js';
import type { KernelReleaseEvent, KernelReleaseView } from './types.js';
import type { KernelMemory } from './memory.js';

/** 純重播：意圖後沒有結果就是 unknown，不可能再變成 available。損毀紀錄直接拒絕。 */
export function aiCliKernelReplayReleases(events: KernelReleaseEvent[]): Map<string, KernelReleaseView> {
  const releases = new Map<string, KernelReleaseView>();
  for (const event of events) {
    if (event.type === 'release_created') {
      if (releases.has(event.id)) throw new Error('放行紀錄重複建立');
      const { type: _type, at: _at, ...release } = event;
      releases.set(event.id, { release, status: 'available', attempted: false, detail: '' });
      continue;
    }
    const view = releases.get(event.id);
    if (!view) throw new Error('放行紀錄沒有建立事件');
    if (event.type === 'release_intent') {
      if (view.attempted) throw new Error('放行紀錄重複意圖');
      view.attempted = true; view.status = 'unknown'; view.detail = '意圖已記錄，結果不明，絕不自動重試';
    } else if (event.type === 'release_result') {
      if (!view.attempted || view.status !== 'unknown') throw new Error('放行結果順序不合法');
      view.status = event.status; view.detail = event.detail;
    } else throw new Error('不認識的放行事件');
  }
  return releases;
}

export interface ActionRecord { spec: ActionSpec; job?: JobRef; startedAt?: number; outcome?: ActionOutcome; abandoned?: string; processed: boolean }
export interface StepResult { stepId: string; title: string; actionId: string; passed: boolean; failureClass?: FailureClass; findings: string[]; preview: string; messageFile: string | null }

export interface RunView {
  candidateMemories: KernelMemory[];
  contextStarted: boolean;
  context: { ok: boolean; outputFile: string | null; exitCode: number | null; timedOut: boolean; detail: string } | null;
  checkpointPrepared: { commit: string; ref: string } | null;
  checkpoint: CheckpointRecord | null;
  state: RunState;
  reason?: string;
  detail?: string;
  contractDigest: string | null;
  approvedDigest: string | null;
  versionId: string | null;
  /** 最後啟動的 runner。其他 runner 看到不是自己就要退出。 */
  runnerToken: string | null;
  baselineRecorded: boolean;
  baseline: GitSnapshot | null;
  actions: Map<string, ActionRecord>;
  plan: { planId: string; steps: PlanStep[]; reportStep?: string } | null;
  planCount: number;
  stepResults: Map<string, StepResult>;
  /** 由舊到新；被放棄的計畫段也留著，decide 才看得到失敗史。 */
  stepOrder: string[];
  acceptance: { stepId: string; passed: boolean; findings: string[] } | null;
  acceptanceFailures: number;
  /** develop：worktree 開好、準備指令也跑完了。 */
  workspaceReady: boolean;
  /** develop：kernel 最後確認過的 commit。worker 的改動是相對它算的。 */
  headCommit: string | null;
  /** develop：最新一次測試。只有 commit 等於目前 HEAD 才算數。 */
  verification: { commit: string; passed: boolean; exitCode: number | null; timedOut: boolean; tail: string } | null;
  testFailures: number;
  /** kernel 自己跑的指令還沒回報結束。當掉後要先確認它停了才能動工作目錄。 */
  testLockWaiting: string | null;
  openCheck: { kind: 'setup' | 'test' | 'context'; pid: number; started: string; name: string } | null;
  /** decide 要結案，但驗收可能還沒寫（當在兩次寫入之間）。 */
  pendingFinish: string | null;
  counters: { decides: number; workerSteps: number; inputTokens: number; cachedTokens: number; outputTokens: number; unknownUsage: number; quotaUnknownDispatches: number };
  failureStreak: { failureClass: FailureClass | null; count: number; detail: string };
  rejectedDecides: number;
  lastRejection: string;
  /** decide 要求停下，但 state 事件可能還沒寫進去。 */
  pendingStop: StopDecision | null;
  /** 要等人處理的失敗，同樣可能還沒寫 state。 */
  humanStop: StopDecision | null;
  overrides: Set<string>;
  notes: string[];
  activeMs: number;
  activeSince: number | null;
  lastSeq: number;
}

export function replayJournal(events: KernelEvent[]): RunView {
  const view: RunView = {
    candidateMemories: [], contextStarted: false, context: null,
    checkpointPrepared: null, checkpoint: null,
    state: 'awaiting_approval', contractDigest: null, approvedDigest: null, versionId: null, runnerToken: null,
    baselineRecorded: false, baseline: null, actions: new Map(), plan: null, planCount: 0,
    stepResults: new Map(), stepOrder: [], acceptance: null, acceptanceFailures: 0,
    workspaceReady: false, headCommit: null, verification: null, testFailures: 0, testLockWaiting: null, openCheck: null, pendingFinish: null,
    counters: { decides: 0, workerSteps: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, unknownUsage: 0, quotaUnknownDispatches: 0 },
    failureStreak: { failureClass: null, count: 0, detail: '' }, rejectedDecides: 0, lastRejection: '', pendingStop: null, humanStop: null,
    overrides: new Set(), notes: [], activeMs: 0, activeSince: null, lastSeq: 0,
  };
  const closeActive = (at: string) => {
    if (view.activeSince !== null) { view.activeMs += Math.max(0, Date.parse(at) - view.activeSince); view.activeSince = null; }
  };
  const fail = (failureClass: FailureClass, detail: string) => {
    if (view.failureStreak.failureClass === failureClass) { view.failureStreak.count += 1; view.failureStreak.detail = detail; }
    else view.failureStreak = { failureClass, count: 1, detail };
    if (NEEDS_HUMAN_FAILURES.includes(failureClass)) view.humanStop = { state: 'waiting_human', reason: failureClass, detail };
  };
  for (const event of events) {
    view.lastSeq = event.seq;
    switch (event.type) {
      case 'created': view.contractDigest = event.contractDigest; break;
      case 'context_intent': view.contextStarted = true; break;
      case 'context_result': view.context = { ok: event.ok, outputFile: event.outputFile, exitCode: event.exitCode, timedOut: event.timedOut, detail: event.detail }; break;
      case 'approved':
        view.approvedDigest = event.contractDigest;
        if (event.note) view.notes.push(event.note);
        for (const item of event.overrides ?? []) view.overrides.add(item);
        break;
      case 'runner_started':
        closeActive(event.at); // 上一個 runner 當掉時沒有 state 事件，算到這裡為止。
        view.testLockWaiting = null;
        view.versionId = event.versionId; view.runnerToken = event.token; view.activeSince = Date.parse(event.at);
        break;
      case 'baseline': view.baselineRecorded = true; view.baseline = event.git; break;
      case 'action_intent':
        view.actions.set(event.action.actionId, { spec: event.action, processed: false });
        if (event.action.kind === 'decide') view.counters.decides += 1; else view.counters.workerSteps += 1;
        break;
      case 'action_started': {
        const a = view.actions.get(event.actionId);
        if (a) { a.job = event.job; a.startedAt = Date.parse(event.job.startedAt ?? event.at); }
        break;
      }
      case 'action_result': {
        const a = view.actions.get(event.actionId);
        if (a) {
          a.outcome = event.outcome;
          const usage = event.outcome.usage;
          if (usage) { view.counters.inputTokens += usage.input; view.counters.cachedTokens += usage.cached; view.counters.outputTokens += usage.output; }
          else view.counters.unknownUsage += 1;
        }
        break;
      }
      case 'action_abandoned': {
        const a = view.actions.get(event.actionId);
        if (a) {
          a.abandoned = event.reason; a.processed = true;
          // 只有確認沒啟動過才退名額。放棄結果不代表沒有執行，不能拿來多派一次。
          if (event.refund) { if (a.spec.kind === 'decide') view.counters.decides -= 1; else view.counters.workerSteps -= 1; }
        }
        break;
      }
      case 'decide_processed': {
        const a = view.actions.get(event.actionId); if (a) a.processed = true;
        if (event.ok) {
          if (event.memories) view.candidateMemories.push(...event.memories);
          view.rejectedDecides = 0;
          if (event.plan) { view.plan = event.plan; view.planCount += 1; view.acceptance = null; }
          if (event.stop) view.pendingStop = event.stop;
          if (event.finishStep) view.pendingFinish = event.finishStep;
        } else if (a?.outcome && !a.outcome.ok) {
          fail(a.outcome.failureClass ?? 'process_failed', event.reason ?? a.outcome.detail);
        } else {
          view.rejectedDecides += 1; view.lastRejection = event.reason ?? '';
        }
        break;
      }
      case 'step_checked': {
        const a = view.actions.get(event.actionId); if (a) a.processed = true;
        if (event.commit) view.headCommit = event.commit;
        const title = view.plan?.steps.find(s => s.id === event.stepId)?.title ?? event.stepId;
        if (!view.stepResults.has(event.stepId)) view.stepOrder.push(event.stepId);
        view.stepResults.set(event.stepId, {
          stepId: event.stepId, title, actionId: event.actionId, passed: event.passed, failureClass: event.failureClass,
          findings: event.findings, preview: a?.outcome?.messagePreview ?? '', messageFile: a?.outcome?.messageFile ?? null,
        });
        if (event.passed) view.failureStreak = { failureClass: null, count: 0, detail: '' };
        else { view.plan = null; fail(event.failureClass ?? 'check_failed', event.findings.join('；')); } // 步驟失敗，這段計畫作廢，回去問 decide。
        break;
      }
      case 'acceptance':
        view.pendingFinish = null;
        view.acceptance = { stepId: event.stepId, passed: event.passed, findings: event.findings };
        if (!event.passed) { view.plan = null; view.acceptanceFailures += 1; }
        break;
      case 'checkpoint_prepared': view.checkpointPrepared = { commit: event.commit, ref: event.ref }; break;
      case 'checkpoint': view.checkpoint = { commit: event.commit, ref: event.ref, pushed: event.pushed, remote: event.remote }; break;
      case 'workspace_ready': view.workspaceReady = true; view.headCommit = event.head; break;
      // 同一個檢查會記兩次：spawn 完先記 pid，查到身分再補。
      case 'check_started': view.openCheck = { kind: event.kind, pid: event.pid, started: event.started, name: event.name }; break;
      case 'check_finished': view.openCheck = null; break;
      case 'test_lock_wait': closeActive(event.at); view.testLockWaiting = event.heldBy; break;
      case 'test_lock_acquired':
        view.testLockWaiting = null;
        if (view.state === 'running' && view.activeSince === null) view.activeSince = Date.parse(event.at);
        break;
      case 'verification':
        view.verification = { commit: event.commit, passed: event.passed, exitCode: event.exitCode, timedOut: event.timedOut, tail: event.tail };
        // 測試沒過，這段計畫就算走完了也不算數，回去問 decide。
        if (!event.passed) { view.plan = null; view.testFailures += 1; }
        break;
      case 'quota_unknown': view.counters.quotaUnknownDispatches += 1; break;
      case 'state':
        view.state = event.state; view.reason = event.reason; view.detail = event.detail;
        view.pendingStop = null; view.humanStop = null; // 停下的決定已經落盤。
        if (event.state !== 'running') { closeActive(event.at); view.testLockWaiting = null; }
        break;
    }
  }
  return view;
}

/** 日誌裡已經有理由要停，但 state 可能還沒寫（當在兩次寫入之間）。loop 每一輪都先看這裡。 */
export function derivedStop(view: RunView): StopDecision | null {
  if (view.pendingStop) return view.pendingStop;
  if (view.humanStop) return view.humanStop;
  if (view.failureStreak.count >= 2) return { state: 'failed', reason: `repeated_failure:${view.failureStreak.failureClass}`, detail: view.failureStreak.detail };
  if (view.rejectedDecides >= 2) return { state: 'failed', reason: 'decide_invalid', detail: view.lastRejection };
  if (view.acceptanceFailures >= 2) return { state: 'failed', reason: 'repeated_acceptance_failure', detail: view.acceptance?.findings.join('；') ?? '' };
  return null;
}

export function activeMinutes(view: RunView, now: number): number {
  const open = view.activeSince === null ? 0 : Math.max(0, now - view.activeSince);
  return (view.activeMs + open) / 60000;
}

/** 有意圖、沒結果的 action：恢復時最危險的那一類。 */
export function openActions(view: RunView): ActionRecord[] {
  return [...view.actions.values()].filter(a => !a.outcome && !a.abandoned);
}

/** 有結果、但判定還沒落盤（在兩次寫入之間當掉）。 */
export function unprocessedActions(view: RunView): ActionRecord[] {
  return [...view.actions.values()].filter(a => a.outcome && !a.processed);
}

/** 計畫段裡下一個還沒通過的步驟。已確認通過的絕不重派。 */
export function nextStep(view: RunView): PlanStep | null {
  if (!view.plan) return null;
  return view.plan.steps.find(step => !view.stepResults.get(step.id)?.passed) ?? null;
}
