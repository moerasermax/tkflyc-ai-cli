/**
 * 對外入口。CLI 與 MCP 都只呼叫這裡，行為才不會兩邊各一套。
 * 匯出函式一律以 aiCliKernel 開頭，讓原生程式碼裡一眼看得出這是延伸功能。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { aiCliKernelCreateRelease, aiCliKernelRunRelease, aiCliKernelRunTrigger, type KernelTriggerDeps, type KernelReleaseCreateInput, type KernelReleaseDeps } from './loop.js';
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from '../core/user-config.js';
import { lookupIdentities } from '../core/live-jobs.js';
import { mayBeAlive, sameIdentity } from '../core/job-store.js';
import { assertCanStartJob } from '../core/worker-env.js';
import { FileJobExecutor } from './executor.js';
import { admitRun, readActiveRuns, type ActiveRun, type AdmissionDeps } from './admission.js';
import { releaseStoppedTestLock } from './test-lock.js';
import type { MutexRetryDeps } from './process-mutex.js';
import { atomicWrite, kernelRunDir, listRunIds, newRunId, recordSlotReleaseFailed, releaseActiveLock, RunStore, SLOT_RELEASE_DEFERRED_NOTE, SLOT_RELEASE_MARKER_NOTE } from './journal.js';
import { boundaryKey, boundaryStatus, hasProbeEvidenceFormat, probeResultLabel, runBoundaryProbe, type ProbeRecord } from './probe.js';
import { activeMinutes, nextStep, openActions, replayJournal, unprocessedActions, type RunView } from './replay.js';
import { agentForModel } from './runtime.js';
import { buildContract, TEMPLATES, type KernelStartInput } from './templates.js';
import { isTerminalState, workDirOf, type ActionOutcome, type BoundaryStatus, type DevelopSpec, type KernelContract, type KernelExecutor, type RunState } from './types.js';
import { aiCliKernelRepoIdentity, aiCliKernelResolveBaseRef, aiCliKernelRestoreCheckpointBranch, cleanupWorkspace, describeRepo, realWorkspace } from './workspace.js';
import { AiCliKernelMemoryStore, aiCliKernelMemoryRepo, type KernelMemory } from './memory.js';
import { aiCliKernelArchiveSummary, aiCliKernelBuildArchivePacket, type KernelArchiveMark, type KernelArchivePacket, type KernelArchiveSummary } from './archive.js';

export type { KernelStartInput } from './templates.js';

/** 只有本機人工 CLI 有記憶變更入口；沒有遠端服務或任意 tool 分派。 */
export function aiCliKernelMemory(input: { operation: 'list' | 'add' | 'promote' | 'revoke'; workFolder: string; id?: string; text?: string; scope?: KernelMemory['scope'] }): KernelMemory[] | KernelMemory {
  if (!['list', 'add', 'promote', 'revoke'].includes(input.operation)) throw new Error('不認識的 memory 操作');
  const repo = aiCliKernelMemoryRepo(input.workFolder);
  if (!repo) throw new Error('記憶需要至少有一個 commit 的 git repo');
  const store = new AiCliKernelMemoryStore(repo.repoKey);
  if (input.operation === 'list') return store.read();
  if (input.operation === 'add') return store.add(input.text ?? '', input.scope);
  return store.status(input.id ?? '', input.operation === 'promote' ? 'active' : 'revoked');
}

function releaseDeps(store: RunStore): KernelReleaseDeps {
  return {
    store, workspace: realWorkspace, now: Date.now,
    newId: () => `${store.runId}-rel-${randomBytes(8).toString('hex')}`,
    assertHuman: () => {
      if (process.env.AI_CLI_WORKER === '1') throw new Error('worker 不能建立或執行放行；放行只能由人使用 CLI 決定');
    },
  };
}

/** 僅供 CLI 呼叫，不註冊 MCP 工具。 */
export function aiCliKernelReleaseCreate(input: KernelReleaseCreateInput & { runId: string }) {
  return aiCliKernelCreateRelease(releaseDeps(storeFor(input.runId)), input);
}

export function aiCliKernelReleaseRun(input: { id: string }) {
  const runId = input.id.match(/^(kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4})-rel-[0-9a-f]{16}$/)?.[1];
  if (!runId) throw new Error('不是有效的放行 id');
  return aiCliKernelRunRelease(releaseDeps(storeFor(runId)), input.id);
}

const OVERRIDABLE_REASONS = new Set(['quota_low', 'quota_unknown', 'worktree_changed', 'repo_refs_changed', 'mandate_expired', 'checkpoint_push_failed']);

/* ---- 開關：預設關閉，開了 MCP 才會多出 ai-cli_kernel_* 工具 ---- */
function enablePath(): string { return join(CONFIG_DIR, 'kernel.json'); }

export function aiCliKernelEnabled(): boolean {
  const env = process.env.AI_CLI_KERNEL;
  if (env === 'on') return true;
  if (env === 'off') return false;
  try { return (JSON.parse(readFileSync(enablePath(), 'utf8')) as { enabled?: unknown }).enabled === true; }
  catch { return false; }
}

export function aiCliKernelSetEnabled(enabled: boolean): { enabled: boolean; path: string } {
  atomicWrite(enablePath(), JSON.stringify({ enabled }, null, 2) + '\n');
  return { enabled, path: enablePath() };
}

/* ---- 狀態 ---- */
export type EffectiveState = RunState | 'interrupted';

export interface KernelRunStatus {
  origin: KernelContract['origin'] | null;
  contextCommand: string | null;
  context: RunView['context'];
  runId: string;
  state: RunState;
  effectiveState: EffectiveState;
  stateLabel: string;
  reason: string | null;
  detail: string | null;
  goal: string;
  workFolder: string;
  template: string;
  models: { decide: KernelContract['decide']; worker: KernelContract['worker']; allowedWorkers: string[] };
  /** develop 範本才有。委任書要讓人看清楚的東西都在這裡。 */
  develop: (Pick<DevelopSpec, 'repoRoot' | 'branch' | 'baseCommit' | 'baseRef' | 'baseRefRef' | 'dependsOnRunId' | 'worktree' | 'testCommand' | 'setupCommand' | 'allowedPaths' | 'dirtyAtStart' | 'expiresAt' | 'notices' | 'checkpoint'> & { testFailures: number; verifiedCommit: string | null; checkpointResult: RunView['checkpoint']; checkpointPrepared: RunView['checkpointPrepared']; checkpointMode: string | null }) | null;
  contractDigest: string | null;
  boundary: Record<string, BoundaryStatus>;
  boundaryLabel: string;
  progress: {
    decides: { used: number; max: number }; workerSteps: { used: number; max: number };
    inputTokens: { used: number; max: number }; cachedTokens: number; outputTokens: number; unknownUsage: number;
    activeMinutes: { used: number; max: number }; quotaUnknownDispatches: number;
  };
  steps: Array<{ id: string; title: string; status: 'passed' | 'failed' | 'running' | 'pending'; findings: string[] }>;
  currentAction: { actionId: string; kind: string; stepId: string | null; job: { pid: number; jobId: string } | null } | null;
  acceptance: { stepId: string; passed: boolean; findings: string[] } | null;
  nextAction: string;
  reportPath: string | null;
  runDir: string;
}

const STATE_LABELS: Record<EffectiveState, string> = {
  awaiting_approval: '等你核准委任書', running: '執行中', waiting_human: '停下來等你', needs_reconcile: '要對帳：分不出動作做了沒',
  stop_pending: '正在等舊程序消失', version_drift: 'ai-cli 被更新，已暫停', interrupted: 'runner 中斷了，可以接回',
  completed: '完成，已通過驗收', failed: '失敗', cancelled: '已取消', budget_exhausted: '預算用完，已停止',
};

function nextActionFor(state: EffectiveState, runId: string, reason?: string): string {
  switch (state) {
    case 'awaiting_approval': return `讀完委任書後，同意就執行 ai-cli kernel approve ${runId}，不要就執行 ai-cli kernel cancel ${runId}`;
    case 'running': return `不用做事。可用 ai-cli kernel wait ${runId} 等它停下來。`;
    case 'waiting_human':
      if (reason === 'checkpoint_push_failed') return `回復點沒有推成功。人手動建立的 run 可用 ai-cli kernel approve ${runId} 同意只留本地；觸發的 run 必須先排除遠端問題。`;
      if (reason === 'checkpoint_secret_risk') return `回復點含疑似秘密，不會推送或派工。請取消此 run，處理秘密後重新建立委任書。`;
      if (reason === 'boundary_unverified') return `先跑 ai-cli kernel probe --agent <agent>，通過後再 ai-cli kernel approve ${runId}`;
      if (reason === 'decide_question') return `回答問題：ai-cli kernel approve ${runId} --note "你的回答"`;
      return `確認上面的原因後，要繼續就執行 ai-cli kernel approve ${runId}，不要就執行 ai-cli kernel cancel ${runId}`;
    case 'needs_reconcile': return `先用 ai-cli jobs 和 git status 確認實際情況。確定要放棄這個動作的結果就執行 ai-cli kernel approve ${runId} --reconcile abandon`;
    case 'stop_pending': return `舊程序還沒確認停止。稍後再執行一次 ai-cli kernel cancel ${runId} 重新檢查。`;
    case 'version_drift': return `ai-cli 更新過了。確認沒問題後執行 ai-cli kernel approve ${runId} 接回。`;
    case 'interrupted': return `runner 不在了。執行 ai-cli kernel approve ${runId} 接回，已完成的步驟不會重做。`;
    case 'completed': return `看報告：ai-cli kernel result ${runId}`;
    case 'failed': case 'budget_exhausted': case 'cancelled': return `這個 run 已結束。需要的話調整目標或預算後重新 ai-cli kernel start。`;
  }
}

/** develop 有兩個狀態要多交代：核准要明確承認未隔離，完成後要自己決定合不合併。 */
function developNextAction(contract: KernelContract, state: EffectiveState, runId: string): string | null {
  if (!contract.develop) return null;
  if (state === 'awaiting_approval') return `worker 會拿到等於你本人的權限，只靠 worktree 隔開正常路徑的寫入。讀完委任書後，同意就執行 ai-cli kernel approve ${runId} --acknowledge-unisolated，不要就執行 ai-cli kernel cancel ${runId}`;
  if (state === 'completed') return `看報告：ai-cli kernel result ${runId}。確認交付版本後，用 ai-cli kernel release create ${runId} --action merge|push --target <branch> --confirm <commit 前 10 碼> 建立單次放行，再用 release run <id> 執行；之後用 cleanup 清掉 worktree。`;
  return null;
}

/** true＝活著；false＝確定不在；null＝查不出來。只有 false 才能當成中斷，否則機器忙的時候會多開一個 runner。 */
export async function aiCliKernelRunnerAlive(store: RunStore, lookup: typeof lookupIdentities = lookupIdentities): Promise<boolean | null> {
  if (!existsSync(store.runnerPath)) return false;
  let holder: { pid: number; started: string; name: string };
  try { holder = JSON.parse(readFileSync(store.runnerPath, 'utf8')); } catch { return null; }
  const live = (await lookup([holder.pid])).get(holder.pid);
  // 身分查詢有逾時，失敗時也是查不到。pid 還在就不能說它死了。
  if (!live) return mayBeAlive(holder.pid) ? null : false;
  return holder.started ? sameIdentity(holder, live) : true;
}

function describeSteps(view: RunView): KernelRunStatus['steps'] {
  const rows: KernelRunStatus['steps'] = view.stepOrder.map(id => {
    const step = view.stepResults.get(id)!;
    return { id, title: step.title, status: step.passed ? 'passed' : 'failed', findings: step.findings };
  });
  const open = new Set(openActions(view).map(action => action.spec.stepId).filter(Boolean));
  for (const step of view.plan?.steps ?? []) {
    if (view.stepResults.has(step.id)) continue;
    rows.push({ id: step.id, title: step.title, status: open.has(step.id) ? 'running' : 'pending', findings: [] });
  }
  return rows;
}

function boundaries(contract: KernelContract): Record<string, BoundaryStatus> {
  const result: Record<string, BoundaryStatus> = {};
  if (contract.develop) return result; // 已經明示未隔離，探針證明的東西在這裡不成立。
  for (const model of [contract.decide.model, ...contract.allowedWorkerModels]) {
    const agent = agentForModel(model);
    result[agent] ??= boundaryStatus(agent);
  }
  return result;
}

async function statusOf(store: RunStore, withBoundary = true): Promise<KernelRunStatus> {
  const contract = store.readContract();
  const view = replayJournal(store.read());
  const alive = view.state === 'running' ? await aiCliKernelRunnerAlive(store) : null;
  const effectiveState: EffectiveState = view.state === 'running' && alive === false ? 'interrupted' : view.state;
  const open = openActions(view)[0];
  const boundary = withBoundary ? boundaries(contract) : {};
  const probeLabels = [...new Set([contract.decide.model, ...contract.allowedWorkerModels].map(agentForModel))]
    .filter(agent => !contract.develop || !hasProbeEvidenceFormat(agent))
    .map(agent => probeResultLabel(agent, boundary[agent] ?? 'UNKNOWN')).join('；');
  return {
    origin: contract.origin ?? null,
    contextCommand: contract.contextCommand ?? null, context: view.context,
    runId: store.runId, state: view.state, effectiveState, stateLabel: view.testLockWaiting ? `等測試鎖（被 ${view.testLockWaiting} 佔用）` : STATE_LABELS[effectiveState],
    reason: view.reason ?? null, detail: view.detail ?? null, goal: contract.goal, workFolder: contract.develop ? workDirOf(contract.develop) : contract.workFolder, template: contract.template,
    models: { decide: contract.decide, worker: contract.worker, allowedWorkers: contract.allowedWorkerModels }, contractDigest: view.contractDigest, boundary,
    develop: contract.develop ? {
      repoRoot: contract.develop.repoRoot, branch: contract.develop.branch, baseCommit: contract.develop.baseCommit, worktree: contract.develop.worktree, testCommand: contract.develop.testCommand,
      ...(contract.develop.baseRef !== undefined ? { baseRef: contract.develop.baseRef, baseRefRef: contract.develop.baseRefRef, dependsOnRunId: contract.develop.dependsOnRunId } : {}),
      ...(contract.develop.setupCommand ? { setupCommand: contract.develop.setupCommand } : {}), allowedPaths: contract.develop.allowedPaths,
      dirtyAtStart: contract.develop.dirtyAtStart, expiresAt: contract.develop.expiresAt, notices: contract.develop.notices ?? [], testFailures: view.testFailures,
      verifiedCommit: view.verification?.passed ? view.verification.commit : null,
      checkpoint: contract.develop.checkpoint, checkpointResult: view.checkpoint, checkpointPrepared: view.checkpointPrepared,
      checkpointMode: contract.develop.checkpoint?.mode === 'push' && view.overrides.has('checkpoint_push_failed') && contract.origin?.kind !== 'trigger' ? 'local' : contract.develop.checkpoint?.mode ?? null,
    } : null,
    boundaryLabel: contract.develop ? `未隔離：worker 權限等於你本人，worktree 只隔開正常路徑的寫入${probeLabels ? `；${probeLabels}` : ''}` : `${contract.allowUnverifiedBoundary ? '未驗證（呼叫端明確允許）；' : ''}${probeLabels}`,
    progress: {
      decides: { used: view.counters.decides, max: contract.budget.maxDecides },
      workerSteps: { used: view.counters.workerSteps, max: contract.budget.maxWorkerSteps },
      inputTokens: { used: view.counters.inputTokens - view.counters.cachedTokens, max: contract.budget.maxInputTokens },
      cachedTokens: view.counters.cachedTokens, outputTokens: view.counters.outputTokens, unknownUsage: view.counters.unknownUsage,
      activeMinutes: { used: Math.round(activeMinutes(view, Date.now()) * 10) / 10, max: contract.budget.maxWallMinutes },
      quotaUnknownDispatches: view.counters.quotaUnknownDispatches,
    },
    steps: describeSteps(view),
    currentAction: open ? { actionId: open.spec.actionId, kind: open.spec.kind, stepId: open.spec.stepId ?? null, job: open.job ?? null } : null,
    acceptance: view.acceptance, nextAction: developNextAction(contract, effectiveState, store.runId) ?? nextActionFor(effectiveState, store.runId, view.reason),
    reportPath: existsSync(store.reportPath) ? store.reportPath : null, runDir: store.dir,
  };
}

function storeFor(runId: string): RunStore {
  const dir = kernelRunDir(runId);
  if (!existsSync(join(dir, 'contract.json'))) throw new Error(`找不到 run：${runId}`);
  return new RunStore(dir);
}

/* ---- 啟動 runner ---- */
async function spawnRunner(store: RunStore): Promise<void> {
  const readHolder = (): string | null => { try { return readFileSync(store.runnerPath, 'utf8'); } catch { return null; } };
  // 被殺的 runner 會留下 runner.json。不記下來比對的話，它會被當成新 runner 已經起來，
  // 呼叫端馬上就去看狀態，看到的是「runner 中斷了」。兩個基準都要在 spawn 之前取，否則新 runner 搶先寫入時會等滿時限。
  const staleHolder = readHolder();
  const startSeq = replayJournal(store.read()).lastSeq;
  const viaLauncher = process.platform === 'win32';
  rmSync(join(store.dir, 'launcher.json'), { force: true });
  const script = fileURLToPath(new URL(viaLauncher ? './launcher.js' : './runner.js', import.meta.url));
  const child = spawn(process.execPath, [script, store.dir], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env, detached: true, stdio: 'ignore', windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    if (viaLauncher) child.once('close', code => code === 0 ? resolve() : reject(new Error(`launcher 結束碼 ${code}`)));
    else child.once('spawn', () => { child.unref(); resolve(); });
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const holder = readHolder();
    if ((holder !== null && holder !== staleHolder) || replayJournal(store.read()).lastSeq > startSeq) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`runner 沒有在時限內啟動，請看 ${store.dir}`);
}

/* ---- 對外動作 ---- */
export async function aiCliKernelStart(input: KernelStartInput): Promise<KernelRunStatus> {
  assertCanStartJob(); // worker 不能再開 run，防止遞迴。
  const runId = newRunId();
  const contract = buildContract(input, new Date(), { runId, worktree: join(kernelRunDir(runId), 'wt') });
  const spec = contract.develop;
  const dependencyId = spec?.baseRefRef?.match(/^refs\/heads\/ai-cli_kernel\/(kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4})$/)?.[1];
  let dependency: RunStore | null = null;
  if (spec && dependencyId && existsSync(join(kernelRunDir(dependencyId), 'contract.json'))) {
    const sourceStore = storeFor(dependencyId);
    const source = sourceStore.readContract().develop;
    if (source && spec.baseRefRef === `refs/heads/${source.branch}` && aiCliKernelRepoIdentity(spec.repoRoot) === aiCliKernelRepoIdentity(source.repoRoot)) {
      spec.dependsOnRunId = dependencyId;
      dependency = sourceStore;
    }
  }
  const create = () => {
    if (dependency && spec) {
      const current = aiCliKernelResolveBaseRef(spec.repoRoot, spec.baseRef!);
      if (current.commit !== spec.baseCommit || current.ref !== spec.baseRefRef) throw new Error('依賴分支在建立委任書前已變動，請重新 start');
    }
    const store = new RunStore(kernelRunDir(runId));
    store.create(contract);
    return store;
  };
  // 與來源 run 的 cleanup／放行共用既有短鎖，避免檢查依賴和建立契約交錯；不涉及 runner 並行政策。
  const store = dependency ? dependency.withReleaseLock(create) : create();
  return statusOf(store);
}

/** 預設只印還原方式；apply 也只建分支，絕不移動 HEAD 或工作樹。 */
export function aiCliKernelRollback(input: { runId: string; apply?: boolean }): ReturnType<typeof aiCliKernelRestoreCheckpointBranch> {
  const store = storeFor(input.runId);
  const contract = store.readContract();
  const view = replayJournal(store.read());
  const checkpoint = view.checkpoint ?? (view.checkpointPrepared ? { ...view.checkpointPrepared, pushed: false, remote: contract.develop?.checkpoint?.remote ?? null } : null);
  if (!contract.develop || !checkpoint) throw new Error('這個 run 沒有回復點，不能 rollback');
  if (store.contractDigest() !== view.contractDigest) throw new Error('委任書內容已變動，拒絕 rollback');
  return aiCliKernelRestoreCheckpointBranch(contract.develop, checkpoint, store.runId, input.apply === true);
}

export interface KernelApproveInput { runId: string; note?: string; reconcile?: string; acknowledgeUnisolated?: boolean }

export async function aiCliKernelApprove(input: KernelApproveInput, deps: AdmissionDeps & { launch?: (store: RunStore) => Promise<void>; beforeStart?: () => void; release?: Partial<MutexRetryDeps> } = {}): Promise<KernelRunStatus> {
  assertCanStartJob();
  const store = storeFor(input.runId);
  const contract = store.readContract();
  const view = replayJournal(store.read());
  const digest = store.contractDigest();
  if (digest !== view.contractDigest) throw new Error('委任書內容和建立時不一致，拒絕核准');
  if (isTerminalState(view.state)) throw new Error(`這個 run 已經結束（${view.state}），不能再核准`);
  if (view.state === 'stop_pending') throw new Error(`舊程序還沒確認停止，不能接回。請執行 ai-cli kernel cancel ${input.runId} 重新檢查`);
  if (view.state === 'running' && await aiCliKernelRunnerAlive(store) !== false) throw new Error('這個 run 已經在執行中');

  if (view.state === 'needs_reconcile' && input.reconcile !== 'abandon') throw new Error('結果不明，確認後使用 --reconcile abandon');
  if (view.state !== 'needs_reconcile' && input.reconcile !== undefined) throw new Error('這個狀態不需要 --reconcile');
  if (view.state === 'awaiting_approval') {
    if (contract.develop) {
      if (input.acknowledgeUnisolated !== true) throw new Error('worker 未隔離；讀完委任書後加 --acknowledge-unisolated 明確承認');
      if (Date.now() > Date.parse(contract.develop.expiresAt)) throw new Error(`委任書在 ${contract.develop.expiresAt} 失效了，請重新 ai-cli kernel start`);
    }
    if (!contract.allowUnverifiedBoundary) {
      for (const [agent, status] of Object.entries(boundaries(contract))) {
        if (status !== 'PASS') throw new Error(`${agent} 的權限邊界探針結果是 ${status}。請先執行 ai-cli kernel probe --agent ${agent}`);
      }
    }
  }
  await admitRun(store, () => {
    // The preflight above can overlap another approval or cancellation while querying usage.
    if (replayJournal(store.read()).lastSeq !== view.lastSeq || store.contractDigest() !== digest || store.cancelRequested()) throw new Error('run 在取得名額前已變動，請重新檢查狀態');
    if (contract.develop && view.state === 'awaiting_approval' && Date.now() > Date.parse(contract.develop.expiresAt)) throw new Error('委任書已失效');
    deps.beforeStart?.();
    if (view.state === 'needs_reconcile') {
      for (const action of openActions(view)) store.append({ type: 'action_abandoned', actionId: action.spec.actionId, reason: '使用者確認後放棄', refund: false });
      if (view.openCheck) store.append({ type: 'check_finished', pid: view.openCheck.pid });
    }
    const overrides = view.reason && OVERRIDABLE_REASONS.has(view.reason) && view.state === 'waiting_human' && !(view.reason === 'checkpoint_push_failed' && contract.origin?.kind === 'trigger') ? [view.reason] : [];
    store.append({ type: 'approved', contractDigest: digest, kind: view.state === 'awaiting_approval' ? 'contract' : 'continue', ...(input.note ? { note: input.note } : {}), ...(overrides.length ? { overrides } : {}) });
    store.append({ type: 'state', state: 'running' });
  }, deps);
  try { await (deps.launch ?? spawnRunner)(store); }
  catch (error) {
    // runner 沒起來時名額的 owner 是仍活著的這個行程，不會被當成 abandoned 回收，只能等人 cancel。
    // 先釋放：run 停在 running 又沒有 runner，就是 interrupted，可以再 approve 接回。
    // keep 在 admission 互斥區內判斷：晚到的 runner 已經認領就保留它的名額；之後才到的由 claimRunnerSlot 擋下。
    // 釋放出錯只記錄，不能蓋掉原本的啟動錯誤。
    await releaseActiveLock(store.runId, { deps: deps.release, keep: async () => await aiCliKernelRunnerAlive(store) !== false })
      .catch(releaseError => recordSlotReleaseFailed(store.runId, `runner 啟動失敗後釋放名額出錯：${(releaseError as Error).message}`));
    throw error;
  }
  return statusOf(store);
}

export async function aiCliKernelStatus(input: { runId?: string } = {}): Promise<KernelRunStatus | { active: string | null; activeRuns: ActiveRun[]; pendingArchiveCount: number; runs: Array<Pick<KernelRunStatus, 'runId' | 'effectiveState' | 'stateLabel' | 'goal' | 'nextAction' | 'origin'>> }> {
  if (input.runId) return statusOf(storeFor(input.runId));
  const activeRuns = readActiveRuns();
  const runs = [];
  for (const runId of new Set([...activeRuns.map(run => run.runId), ...listRunIds().slice(0, 20)])) {
    const status = await statusOf(new RunStore(kernelRunDir(runId)), false);
    runs.push({ runId, effectiveState: status.effectiveState, stateLabel: status.stateLabel, goal: status.goal.slice(0, 80), nextAction: status.nextAction, origin: status.origin });
  }
  return { active: activeRuns[0]?.runId ?? null, activeRuns, pendingArchiveCount: (await aiCliKernelArchiveList()).length, runs };
}

/* ---- 本機歸檔標記。沒有 callback、目的地、工具名稱或外部服務參數。 ---- */
function archiveInput(input: object, allowed: string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`archive 不接受 ${key}`);
}

async function archivePacket(store: RunStore): Promise<KernelArchivePacket> {
  let archived: KernelArchiveMark | null = null;
  try {
    archived = JSON.parse(readFileSync(join(store.dir, 'archived.json'), 'utf8')) as KernelArchiveMark;
    if (!archived || archived.runId !== store.runId || !Number.isFinite(Date.parse(archived.archivedAt)) || typeof archived.note !== 'string' ||
      !Number.isInteger(archived.journalSeq) || archived.journalSeq < 0 || !Number.isInteger(archived.releaseEvents) || archived.releaseEvents < 0) throw new Error('歸檔標記損毀，請人工核對');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events = store.read();
  const runnerAlive = replayJournal(events).state === 'running' ? await aiCliKernelRunnerAlive(store) : null;
  return aiCliKernelBuildArchivePacket({ runId: store.runId, contract: store.readContract(), events, releases: store.readReleases(), archived, runnerAlive });
}

export async function aiCliKernelArchiveShow(input: { runId: string }): Promise<KernelArchivePacket> {
  archiveInput(input, ['runId']);
  return archivePacket(storeFor(input.runId));
}

export interface KernelArchiveListInput { repo?: string; workFolder?: string }

function archiveFilterPath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value)) throw new Error(`${name} 必須是非空的絕對路徑`);
  if (existsSync(value) && !statSync(value).isDirectory()) throw new Error(`${name} 必須是目錄路徑`);
  const path = existsSync(value) ? realpathSync.native(value) : resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** 不限最近二十筆；只傳摘要，不在 list 帶回完整包。兩種篩選同給時取交集。 */
export async function aiCliKernelArchiveList(input: KernelArchiveListInput = {}): Promise<KernelArchiveSummary[]> {
  archiveInput(input, ['repo', 'workFolder']);
  const repoPath = archiveFilterPath(input.repo, 'repo');
  const repo = repoPath === undefined ? undefined : aiCliKernelRepoIdentity(repoPath);
  const workFolder = archiveFilterPath(input.workFolder, 'workFolder');
  const packets: KernelArchiveSummary[] = [];
  for (const runId of listRunIds()) {
    // 一筆壞掉不能讓整份清單出不來，否則其他任務也歸不了檔。壞掉的那筆要留在清單上，不能悄悄消失。
    try {
      const store = storeFor(runId);
      const contract = store.readContract();
      if (workFolder !== undefined && archiveFilterPath(contract.workFolder, 'workFolder') !== workFolder) continue;
      // readonly-audit 可以是正常的非 git 目錄；已確認非 repo 的紀錄不屬於 repo 篩選結果。
      if (repo !== undefined && !contract.develop && existsSync(contract.workFolder) && !describeRepo(contract.workFolder)) continue;
      if (repo !== undefined && aiCliKernelRepoIdentity(contract.develop?.repoRoot ?? contract.workFolder) !== repo) continue;
      const packet = await archivePacket(store);
      if (packet.pendingArchive) packets.push(aiCliKernelArchiveSummary(packet));
    } catch (error) {
      packets.push({ runId, state: 'unreadable', reason: 'archive_unreadable', goal: Array.from(`紀錄或篩選身分無法讀取：${(error as Error).message}`).slice(0, 80).join(''), repo: null, branch: null, latestCommit: null, evidence: { journalSeq: null, releaseEvents: null }, candidateMemories: 0 });
    }
  }
  return packets;
}

/** 主 session 完成交接後標記；模型 worker 不可替自己勾掉收尾。只寫 run/archived.json。 */
export async function aiCliKernelArchiveDone(input: { runId: string; note?: string; seen?: { journalSeq: number; releaseEvents: number } }): Promise<KernelArchiveMark> {
  archiveInput(input, ['runId', 'note', 'seen']);
  if (process.env.AI_CLI_WORKER === '1') throw new Error('worker 不能標記歸檔完成，請交給主 session');
  if (input.note !== undefined && typeof input.note !== 'string') throw new Error('note 必須是字串');
  const store = storeFor(input.runId);
  const packet = await archivePacket(store);
  if (packet.effectiveState === 'running') throw new Error('執行中的 run 不可標記歸檔，請先等它停止');
  if (packet.archived) return packet.archived;
  // 主 session 看歸檔包和標記之間可能又多了事件。不比對的話，沒看過的東西會跟著從清單消失。
  if (input.seen && (input.seen.journalSeq !== packet.evidence.journalSeq || input.seen.releaseEvents !== packet.evidence.releaseEvents)) {
    throw new Error(`歸檔包在你看過之後有新事件（看過 ${input.seen.journalSeq}／${input.seen.releaseEvents}，現在 ${packet.evidence.journalSeq}／${packet.evidence.releaseEvents}），請重新 archive show`);
  }
  const mark: KernelArchiveMark = { runId: store.runId, archivedAt: new Date().toISOString(), note: input.note ?? '',
    journalSeq: packet.evidence.journalSeq, releaseEvents: packet.evidence.releaseEvents };
  atomicWrite(join(store.dir, 'archived.json'), JSON.stringify(mark, null, 2) + '\n');
  return mark;
}

/** 等到 run 不是執行中，或逾時。逾時不是錯誤。 */
export async function aiCliKernelWait(input: { runId: string; timeoutSec?: number }): Promise<KernelRunStatus & { timedOut: boolean }> {
  const store = storeFor(input.runId);
  const deadline = Date.now() + (input.timeoutSec ?? 600) * 1000;
  for (;;) {
    const status = await statusOf(store, false);
    if (status.effectiveState !== 'running') return { ...(await statusOf(store)), timedOut: false };
    if (Date.now() >= deadline) return { ...status, timedOut: true };
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

const cancelledOutcome: ActionOutcome = { ok: false, failureClass: 'cancelled', detail: '使用者取消', jobStatus: null, exitCode: null, messageFile: null, messageChars: 0, messagePreview: '', usage: null };

/** runner 不在時由這裡收尾。回報 terminated 不算數，要確認程序真的消失。 */
export async function cancelWithoutRunner(store: RunStore, executor: KernelExecutor, confirmMs = 20000, stopCheck: typeof realWorkspace.stopOrphanCheck = realWorkspace.stopOrphanCheck, releaseDeps: Partial<MutexRetryDeps> = {}): Promise<void> {
  const before = replayJournal(store.read());
  if (before.openCheck) {
    if (!await stopCheck(before.openCheck).catch(() => false)) {
      if (before.openCheck.started) store.append({ type: 'state', state: 'stop_pending', reason: 'check_still_alive', detail: `檢查指令（pid ${before.openCheck.pid}）還沒確認停止` });
      else store.append({ type: 'state', state: 'needs_reconcile', reason: 'check_identity_unknown', detail: `檢查指令 pid ${before.openCheck.pid} 還在，但認不出是不是當初那個。確認後執行 ai-cli kernel approve ${store.runId} --reconcile abandon` });
      return;
    }
    store.append({ type: 'check_finished', pid: before.openCheck.pid });
    await releaseStoppedTestLock(store.runId);
  }
  // 回報結束但還沒判定的寫入 job：它可能就是 stop_pending 的原因，不能略過。
  for (const action of unprocessedActions(before)) {
    if (action.spec.mode !== 'write' || !action.job) continue;
    await executor.kill(action.job).catch(() => false);
    const deadline = Date.now() + confirmMs;
    let gone = await executor.isGone(action.job).catch(() => false);
    while (!gone && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      gone = await executor.isGone(action.job).catch(() => false);
    }
    if (!gone) {
      store.append({ type: 'state', state: 'stop_pending', reason: 'worker_still_alive', detail: `job ${action.job.jobId} 還沒確認停止` });
      return;
    }
  }
  for (const action of openActions(replayJournal(store.read()))) {
    if (action.job) {
      await executor.kill(action.job).catch(() => false);
      const deadline = Date.now() + confirmMs;
      let gone = await executor.isGone(action.job).catch(() => false);
      while (!gone && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        gone = await executor.isGone(action.job).catch(() => false);
      }
      if (!gone) {
        store.append({ type: 'state', state: 'stop_pending', reason: 'worker_still_alive', detail: `job ${action.job.jobId} 還沒確認停止` });
        return;
      }
      store.append({ type: 'action_result', actionId: action.spec.actionId, outcome: cancelledOutcome });
    } else {
      const found = await executor.find(action.spec.marker);
      if (found === 'unknown' || found !== null) {
        const job = found === 'unknown' ? null : found;
        if (job) {
          store.append({ type: 'action_started', actionId: action.spec.actionId, job });
          return cancelWithoutRunner(store, executor, confirmMs, stopCheck, releaseDeps);
        }
        store.append({ type: 'state', state: 'stop_pending', reason: 'cannot_verify_start', detail: `查不了動作 ${action.spec.actionId} 是否啟動過` });
        return;
      }
      store.append({ type: 'action_abandoned', actionId: action.spec.actionId, reason: '取消時確認沒有啟動', refund: true });
    }
  }
  store.append({ type: 'state', state: 'cancelled', reason: 'user_cancelled' });
  await releaseActiveLock(store.runId, { deps: releaseDeps });
}

/** run 已經寫成終止狀態後，釋放名額忙碌不算取消失敗：照常回報狀態，detail 附上說明。 */
async function cancelStatus(store: RunStore, sinceSeq: number): Promise<KernelRunStatus> {
  const status = await statusOf(store);
  const failed = store.read().filter(event => event.seq > sinceSeq && event.type === 'slot_release_failed').at(-1);
  if (failed?.type !== 'slot_release_failed') return status;
  const note = failed.detail.startsWith(SLOT_RELEASE_MARKER_NOTE) ? SLOT_RELEASE_MARKER_NOTE : SLOT_RELEASE_DEFERRED_NOTE;
  return { ...status, detail: status.detail ? `${status.detail}；${note}` : note };
}

/** deps 只供測試注入釋放名額時的協調；MCP／CLI 只傳 input。 */
export async function aiCliKernelCancel(input: { runId: string; timeoutSec?: number }, deps: { release?: Partial<MutexRetryDeps> } = {}): Promise<KernelRunStatus> {
  const store = storeFor(input.runId);
  const view = replayJournal(store.read());
  if (isTerminalState(view.state)) { await releaseActiveLock(input.runId, { deps: deps.release }); return cancelStatus(store, view.lastSeq); }
  store.requestCancel();
  if (view.state === 'running' && await aiCliKernelRunnerAlive(store) !== false) {
    // runner 活著就交給它：只有一個程序寫日誌，比較不會打架。
    const deadline = Date.now() + (input.timeoutSec ?? 45) * 1000;
    while (Date.now() < deadline) {
      const now = replayJournal(store.read());
      if (now.state !== 'running') { if (isTerminalState(now.state)) await releaseActiveLock(input.runId, { deps: deps.release }); return cancelStatus(store, view.lastSeq); }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return statusOf(store);
  }
  await cancelWithoutRunner(store, new FileJobExecutor(), undefined, undefined, deps.release);
  return cancelStatus(store, view.lastSeq);
}

export async function aiCliKernelResult(input: { runId: string }): Promise<{ runId: string; state: RunState; report: string | null; verdict: unknown; nextAction: string; detail: string | null; reportPath: string | null; context: RunView['context'] }> {
  const store = storeFor(input.runId);
  const status = await statusOf(store, false);
  const report = existsSync(store.reportPath) ? readFileSync(store.reportPath, 'utf8') : null;
  const verdict = existsSync(store.verdictPath) ? JSON.parse(readFileSync(store.verdictPath, 'utf8')) : null;
  return { runId: input.runId, state: status.state, report, verdict, nextAction: status.nextAction, detail: status.detail, reportPath: status.reportPath, context: status.context };
}

export async function aiCliKernelProbe(input: { agent: string; timeoutSec?: number }): Promise<ProbeRecord> {
  assertCanStartJob();
  return runBoundaryProbe(input.agent, input.timeoutSec ? { timeoutMs: input.timeoutSec * 1000 } : {});
}

/** 使用者決定不要了，或合併完了才呼叫。分支沒合併不會被刪。 */
export async function aiCliKernelCleanup(input: { runId: string }): Promise<{ runId: string; worktreeRemoved: boolean; branchRemoved: boolean; detail: string }> {
  const store = storeFor(input.runId);
  const contract = store.readContract();
  if (!contract.develop) throw new Error('只有 develop 範本的 run 有 worktree 要清');
  const view = replayJournal(store.read());
  if (!isTerminalState(view.state)) throw new Error(`這個 run 還沒結束（${view.state}），請先完成或 ai-cli kernel cancel ${input.runId}`);
  return store.withReleaseLock(() => {
    for (const runId of listRunIds()) {
      if (runId === input.runId) continue;
      const dependent = storeFor(runId);
      let spec: DevelopSpec | undefined;
      try { spec = dependent.readContract().develop; }
      catch { throw new Error(`拒絕 cleanup：無法讀取 run ${runId} 的委任書，不能確認是否仍有依賴`); }
      if (spec?.dependsOnRunId === input.runId && !isTerminalState(replayJournal(dependent.read()).state)) throw new Error(`拒絕 cleanup：尚未結束的 run ${runId} 依賴 ${input.runId} 的交付分支（baseRef ${spec.baseRef} @ ${spec.baseCommit}）`);
    }
    return { runId: input.runId, ...cleanupWorkspace(contract.develop!) };
  });
}

export function aiCliKernelTemplates(): Array<{ name: string; description: string }> {
  return Object.entries(TEMPLATES).map(([name, template]) => ({ name, description: template.description }));
}

export function aiCliKernelBoundaryKey(agent: string) { return boundaryKey(agent); }
export { nextStep };

// 委任範本由 CLI 共用；核准不註冊 MCP。
export { aiCliKernelMandateSave, aiCliKernelMandateApprove, aiCliKernelMandateList, aiCliKernelMandateShow, aiCliKernelMandateRevoke } from './mandates.js';

/** 一次性觸發；測試可注入前景 runner，絕不啟動真正模型。 */
export function aiCliKernelTrigger(input: { name: string }, deps: AdmissionDeps & { now?: KernelTriggerDeps['now']; launch?: (store: RunStore) => Promise<void>; beforeStart?: () => void } = {}) {
  return aiCliKernelRunTrigger(input.name, {
    now: deps.now ?? Date.now,
    ...(deps.beforeStart ? { beforeStart: deps.beforeStart } : {}),
    approveAndStart: (store, note, beforeStart) => aiCliKernelApprove({ runId: store.runId, acknowledgeUnisolated: true, note }, { launch: deps.launch, quota: deps.quota, agentFor: deps.agentFor, beforeStart }),
  });
}
export { aiCliKernelTriggersEnabled, aiCliKernelTriggersSetEnabled, aiCliKernelTriggerDay } from './triggers.js';
export { aiCliKernelSchedule } from './schedule.js';
