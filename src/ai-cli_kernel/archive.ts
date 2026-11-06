/**
 * 歸檔包的純計算。store 是已讀取的資料快照，不是檔案系統物件。
 * 不讀報告、裁決或目前 git，不執行命令，也不連外；當機時仍保留已落盤的證據。
 */
import { aiCliKernelReplayReleases, derivedStop, replayJournal } from './replay.js';
import type { KernelContract, KernelEvent, KernelReleaseEvent, PlanStep, RunState } from './types.js';

export interface KernelArchiveMark {
  runId: string;
  archivedAt: string;
  note: string;
  journalSeq: number;
  releaseEvents: number;
}

export interface KernelArchiveSnapshot {
  runId: string;
  contract: KernelContract;
  events: KernelEvent[];
  releases: KernelReleaseEvent[];
  archived: KernelArchiveMark | null;
  /** 由 I/O 層查證；未知不能冒稱 runner 已死。 */
  runnerAlive?: boolean | null;
}

function nextAction(state: RunState | 'interrupted', runId: string): string {
  switch (state) {
    case 'running': return `等待執行停止：ai-cli kernel wait ${runId}`;
    case 'awaiting_approval': return `讀完委任書再決定是否 ai-cli kernel approve ${runId}；歸檔標記不代表核准。`;
    case 'interrupted': return `確認未結案動作，再用 ai-cli kernel approve ${runId} 接回；歸檔不重派工作。`;
    case 'needs_reconcile': return `先人工對帳未知動作；確認後才能 ai-cli kernel approve ${runId} --reconcile abandon。`;
    case 'stop_pending': return `先確認舊程序已停止：ai-cli kernel cancel ${runId}。`;
    case 'waiting_human': case 'version_drift': return `檢查原因和委任書，人工決定是否 ai-cli kernel approve ${runId}。`;
    case 'completed': return `檢視交付：ai-cli kernel result ${runId}；merge／push 仍須人另行決定。`;
    case 'failed': case 'cancelled': case 'budget_exhausted': return '檢查失敗或停止的證據，需要時調整目標／預算後建立新的 run。';
  }
}

/** 規格 buildArchivePacket(store)；對外依共通命名規則加 aiCliKernel 前綴。 */
export function aiCliKernelBuildArchivePacket(store: KernelArchiveSnapshot) {
  const { runId, contract, events, releases, archived } = store;
  const view = replayJournal(events);
  const stop = view.state === 'running' ? derivedStop(view) : null;
  const effectiveState = stop?.state ?? (view.state === 'running' && store.runnerAlive === false ? 'interrupted' : view.state);
  const reason = stop?.reason ?? (effectiveState === 'interrupted' ? 'runner_interrupted' : view.reason ?? null);
  const detail = stop?.detail ?? view.detail ?? null;
  const marked = archived?.runId === runId && archived.journalSeq === view.lastSeq && archived.releaseEvents === releases.length;
  const plans = new Map<string, PlanStep>();
  const commits: string[] = [];
  let observation: Extract<KernelEvent, { type: 'workspace_observed' }> | null = null;
  for (const event of events) {
    if (event.type === 'decide_processed' && event.ok && event.plan) for (const step of event.plan.steps) plans.set(step.id, step);
    if (event.type === 'workspace_observed') { observation = event; commits.push(...event.commits); }
    if (event.type === 'step_checked' && event.commit) commits.push(event.commit);
    if (event.type === 'verification') commits.push(event.commit);
  }
  const steps = [...plans].map(([id, step]) => {
    const attempts = events.filter((event): event is Extract<KernelEvent, { type: 'step_checked' }> => event.type === 'step_checked' && event.stepId === id)
      .map(event => ({ actionId: event.actionId, passed: event.passed, findings: event.findings, failureClass: event.failureClass ?? null, commit: event.commit ?? null }));
    const actions = [...view.actions.values()].filter(action => action.spec.stepId === id);
    const last = actions.at(-1);
    const result = attempts.at(-1);
    return { id, title: step.title, status: result ? result.passed ? 'passed' : 'failed' : last?.outcome ? 'unchecked' : last?.abandoned ? 'abandoned' : last ? 'unknown' : 'pending',
      attempts, results: actions.map(action => ({ actionId: action.spec.actionId, model: action.spec.model, outcome: action.outcome ?? null, abandoned: action.abandoned ?? null })) };
  });
  // 舊日誌／fixture 可能沒有 plan，但已確認的步驟不能消失。
  for (const id of view.stepOrder) if (!plans.has(id)) {
    const step = view.stepResults.get(id)!;
    steps.push({ id, title: step.title, status: step.passed ? 'passed' : 'failed', attempts: events.filter((event): event is Extract<KernelEvent, { type: 'step_checked' }> => event.type === 'step_checked' && event.stepId === id)
      .map(event => ({ actionId: event.actionId, passed: event.passed, findings: event.findings, failureClass: event.failureClass ?? null, commit: event.commit ?? null })), results: [] });
  }
  const baseCommit = contract.develop?.baseCommit ?? view.baseline?.head ?? null;
  const latestCommit = observation?.head ?? view.headCommit ?? baseCommit;
  const pending = effectiveState !== 'running' && !marked;
  return structuredClone({
    runId, state: view.state, effectiveState, reason, detail, goal: contract.goal, template: contract.template,
    origin: contract.origin ?? null, repo: contract.develop?.repoRoot ?? contract.workFolder,
    branch: contract.develop?.branch ?? null, baseCommit, latestCommit,
    commits: [...new Set(commits)].filter(commit => commit !== baseCommit),
    changedFiles: observation?.changedFiles ?? [],
    evidence: { journalSeq: view.lastSeq, releaseEvents: releases.length, workspaceObservedAt: observation?.at ?? null,
      completeCommitList: observation?.complete ?? false, changedFilesKnown: observation !== null,
      note: '只包含已落盤的觀察；當機後未記錄的 git／檔案變動不會猜測。舊日誌缺少欄位時以未知標示。' },
    tests: { command: contract.develop?.testCommand ?? null, results: events.filter(event => event.type === 'verification'), openCheck: view.openCheck },
    failures: { actions: events.filter(event => event.type === 'action_result' && !event.outcome.ok).length,
      steps: events.filter(event => event.type === 'step_checked' && !event.passed).length,
      tests: view.testFailures, acceptance: view.acceptanceFailures,
      decisions: events.filter(event => event.type === 'decide_processed' && !event.ok).length },
    usage: { ...view.counters, uncachedInputTokens: view.counters.inputTokens - view.counters.cachedTokens },
    models: { decide: contract.decide, worker: contract.worker, allowedWorkers: contract.allowedWorkerModels,
      used: [...new Set([...view.actions.values()].map(action => action.spec.model))] },
    steps, checkpoint: view.checkpoint, checkpointPrepared: view.checkpointPrepared,
    checkpointSpec: contract.develop?.checkpoint ?? null,
    releases: [...aiCliKernelReplayReleases(releases).values()],
    candidateMemories: view.candidateMemories, contextCommand: contract.contextCommand ?? null, context: view.context,
    acceptance: view.acceptance,
    unclosedActions: [...view.actions.values()].filter(action => !action.processed).map(action => ({ actionId: action.spec.actionId, kind: action.spec.kind, job: action.job ?? null, hasResult: !!action.outcome })),
    archived: marked ? archived : null, pendingArchive: pending,
    nextActions: [nextAction(effectiveState, runId), ...(pending ? [`由主 session 檢視歸檔包並自行完成外部交接後，用 ai-cli kernel archive done ${runId} 標記；kernel 不寫 Planner 或 Knowledge。`] : [])],
  });
}

export type KernelArchivePacket = ReturnType<typeof aiCliKernelBuildArchivePacket>;
