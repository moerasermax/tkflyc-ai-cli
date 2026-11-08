/**
 * ai-cli_kernel 的資料形狀。
 *
 * 這個目錄是 ai-cli 的「延伸」：`core/`、`agents/`、`models/`、`plugins/` 不可以反過來
 * import 這裡（tests/verify-ai-cli_kernel.mjs 有斷言釘住）。對外看得到的名稱一律帶
 * `ai-cli_kernel` 前綴，讓人一眼分得出哪些不是原生功能。
 */

import { join } from 'node:path';
import type { KernelMemory } from './memory.js';

export const KERNEL_SCHEMA_VERSION = 1 as const;

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled', 'budget_exhausted'] as const;
export const PAUSED_STATES = ['awaiting_approval', 'waiting_human', 'needs_reconcile', 'stop_pending', 'version_drift'] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];
export type PausedState = (typeof PAUSED_STATES)[number];
export type RunState = TerminalState | PausedState | 'running';

export function isTerminalState(state: RunState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export interface ModelChoice { model: string; effort?: string }

export interface KernelBudget {
  /** 最多派幾個 worker（有開始執行才算；確定沒啟動的會退回）。 */
  maxWorkerSteps: number;
  /** 最多呼叫幾次 decide。 */
  maxDecides: number;
  /** kernel 實際執行的總時間上限；等人的時間不算。 */
  maxWallMinutes: number;
  /** 單一 job 的時間上限，超過就停掉該 job。 */
  maxActionMinutes: number;
  /**
   * 未快取的 input tokens 總和上限。用完後不再新增派工，進行中的 job 不會被中斷。
   * 不算快取：長任務每次工具呼叫都重送上下文，總量會被灌大幾十倍。實測一步 767 萬 input 裡有 742 萬是快取，
   * Codex 週額度只動了約 1%。算進去的話，真實的開發任務一步就會把預算用完。
   */
  maxInputTokens: number;
  /** 額度量不到時，最多再派幾次。未知不等於還夠，這是事先核准的保守上限。 */
  quotaUnknownMaxDispatches: number;
  /** 週額度剩不到這個百分比就停下問人。 */
  minQuotaRemainingPercent: number;
  /** develop 範本：測試失敗幾次就停。修不好的東西繼續派 worker 只是燒額度。 */
  maxTestFailures: number;
}

export type StepMode = 'read' | 'write';

export interface CheckpointSpec { mode: 'push' | 'local' | 'off'; remote: string | null; ref: string }
export interface CheckpointRecord { commit: string; ref: string; pushed: boolean; remote: string | null }

/** 人在 CLI 綁定的單次授權；額外同意和遠端 URL 也要固定，不能執行時換目的地。 */
export interface KernelRelease {
  id: string;
  action: 'merge' | 'push';
  target: string;
  remote: string | null;
  remoteUrl: string | null;
  commit: string;
  baseCommit: string;
  targetCommitAtCreate: string | null;
  expiresAt: string;
  allowDefaultBranch: boolean;
}
export type KernelReleaseEvent =
  | ({ type: 'release_created'; at: string } & KernelRelease)
  | { type: 'release_intent'; id: string; at: string }
  | { type: 'release_result'; id: string; at: string; status: 'succeeded' | 'failed' | 'unknown'; detail: string };

export interface KernelReleaseView {
  release: KernelRelease;
  status: 'available' | 'succeeded' | 'failed' | 'unknown';
  attempted: boolean;
  detail: string;
}

/** release 的 git I/O 由 loop 的 deps 注入；不需要仍存在的 worker worktree。 */
export interface ReleaseWorkspaceOps {
  releaseBranchHead(spec: DevelopSpec): string;
  releaseTarget(spec: DevelopSpec, action: KernelRelease['action'], target: string, remote: string | null): string | null;
  releaseRemoteUrl(spec: DevelopSpec, remote: string): string;
  releaseDefaultBranch(spec: DevelopSpec, remote: string): string;
  releaseMergeReady(spec: DevelopSpec, target: string): void;
  releaseExecute(spec: DevelopSpec, release: KernelRelease): { status: 'succeeded' | 'failed' | 'unknown'; detail: string };
}

/**
 * develop 範本才有。worker 拿的是全權限，所以這裡寫明的是 kernel 事後查核的範圍，不是隔離：
 * worktree 只隔開正常路徑的寫入，擋不住蓄意的操作。
 */
export interface DevelopSpec {
  /** 僅明確指定基準的新委任書有；baseCommit 永遠是建立時解析的固定 commit。 */
  baseRef?: string;
  baseRefRef?: string;
  dependsOnRunId?: string;
  /** 舊委任書沒有此欄位，接回時維持原來的行為。 */
  checkpoint?: CheckpointSpec;
  repoRoot: string;
  /** workFolder 相對 repo 根目錄的路徑，結尾有 /；就在根目錄時是空字串。 */
  prefix: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  /** kernel 自己跑、模型不能改的驗收指令。 */
  testCommand: string;
  /** 新 worktree 沒有 node_modules 這類被忽略的檔案，需要時在這裡準備。 */
  setupCommand?: string;
  /** 相對 repo 根目錄；空陣列表示不限。 */
  allowedPaths: string[];
  /** 建立委任書時主目錄有幾筆未提交的變更。這些不會帶進 worktree。 */
  dirtyAtStart: number;
  /** 超過這個時間就不再派新的 worker，要人重新同意。今天的同意不能變成長期授權。 */
  expiresAt: string;
  /** 核准前要讓人看到的事。寫在委任書裡，digest 涵蓋，核准時就算同意了。 */
  notices: string[];
}

export function workDirOf(spec: DevelopSpec): string {
  return spec.prefix ? join(spec.worktree, spec.prefix) : spec.worktree;
}

export type AcceptanceCheck =
  | { type: 'message_nonempty' }
  | { type: 'min_length'; chars: number }
  | { type: 'no_refusal' }
  | { type: 'required_sections'; patterns: string[] }
  | { type: 'citations_resolve'; minCount: number };

/** 委任書。核准後不可變：內容的 digest 記在日誌，runner 每次啟動都會重算。 */
export interface KernelContract {
  /** 人提供的唯讀資料命令；核准 digest 包含它，decide 不能設定或更換。 */
  contextCommand?: string;
  /** 觸發入口由下一階段建立；此處先守住不能略過回復點的邊界。 */
  origin?: { kind: 'trigger'; mandate: string; digest: string };
  schemaVersion: typeof KERNEL_SCHEMA_VERSION;
  template: string;
  goal: string;
  workFolder: string;
  decide: ModelChoice;
  worker: ModelChoice;
  allowedWorkerModels: string[];
  budget: KernelBudget;
  /** 每個 worker 結果都要通過。 */
  stepChecks: AcceptanceCheck[];
  /** 最終報告要通過。模型不能改動這裡。 */
  acceptance: AcceptanceCheck[];
  /** 交給 worker 的交付格式。 */
  reportInstructions: string;
  /** 呼叫端明寫才為 true：邊界探針沒通過也照跑，標籤會寫「未驗證」。 */
  allowUnverifiedBoundary: boolean;
  /** 只有 develop 範本才有。沒有這一格的 run 不可能派出能寫檔的 worker。 */
  develop?: DevelopSpec;
  createdAt: string;
}

export interface PlanStep { id: string; title: string; prompt: string; model?: string; mode?: StepMode }

export interface ActionSpec {
  actionId: string;
  kind: 'decide' | 'worker';
  stepId?: string;
  model: string;
  effort?: string;
  prompt: string;
  /** 寫在 prompt 開頭。恢復時用它到 JobStore 找「有沒有真的啟動過」。 */
  marker: string;
  /** 只有明確是 write 才會拿到寫入權；舊日誌沒有這一格，一律當唯讀。 */
  mode?: StepMode;
  /** 沒有就是委任書的 workFolder。 */
  cwd?: string;
  /** 派工當下工作目錄是乾淨的。唯讀步驟跑完才分得出是不是它改的。 */
  cleanAtStart?: boolean;
}

/** startedAt 是 job 真正啟動的時間。接回時用它算時限，不會重新起算。 */
export interface JobRef { pid: number; jobId: string; startedAt?: string }

export type FailureClass =
  | 'rate_limited' | 'quota' | 'auth' | 'model_unavailable' | 'timeout' | 'policy_refused'
  | 'empty_output' | 'process_failed' | 'lost' | 'cancelled' | 'start_failed' | 'check_failed' | 'invalid_output'
  | 'scope_violation' | 'commit_failed';

export interface UsageCount { input: number; cached: number; output: number }

export interface ActionOutcome {
  ok: boolean;
  failureClass: FailureClass | null;
  detail: string;
  jobStatus: string | null;
  exitCode: number | null;
  messageFile: string | null;
  messageChars: number;
  messagePreview: string;
  /** null 代表量不到，不是 0。 */
  usage: UsageCount | null;
}

export interface GitSnapshot { head: string; statusDigest: string; dirtyEntries: number }

/** 重試也沒用，要等人處理的失敗。 */
export const NEEDS_HUMAN_FAILURES: readonly FailureClass[] = ['rate_limited', 'quota', 'auth', 'model_unavailable'];

export interface StopDecision { state: 'waiting_human' | 'failed'; reason: string; detail: string }

export type KernelEventBody =
  | { type: 'created'; contractDigest: string }
  | { type: 'approved'; contractDigest: string; kind: 'contract' | 'continue'; note?: string; overrides?: string[] }
  | { type: 'runner_started'; pid: number; versionId: string; token: string }
  | { type: 'baseline'; git: GitSnapshot | null }
  | { type: 'action_intent'; action: ActionSpec }
  | { type: 'action_started'; actionId: string; job: JobRef }
  | { type: 'action_result'; actionId: string; outcome: ActionOutcome }
  /** refund 只有在確認沒啟動過時才是 true。 */
  | { type: 'action_abandoned'; actionId: string; reason: string; refund: boolean }
  | { type: 'decide_processed'; actionId: string; ok: boolean; decision?: string; reason?: string; plan?: { planId: string; steps: PlanStep[]; reportStep?: string }; stop?: StopDecision; finishStep?: string; memories?: KernelMemory[] }
  | { type: 'context_intent' }
  | { type: 'context_result'; ok: boolean; outputFile: string | null; exitCode: number | null; timedOut: boolean; detail: string }
  | { type: 'step_checked'; actionId: string; stepId: string; passed: boolean; failureClass?: FailureClass; findings: string[]; commit?: string }
  | { type: 'acceptance'; stepId: string; passed: boolean; findings: string[] }
  | { type: 'workspace_ready'; head: string }
  /** 歸檔依據：當時相對基準的檔案與完整 commit 清單，不依賴最後裁決檔。 */
  | { type: 'workspace_observed'; head: string; commits: string[]; changedFiles: string[]; complete: boolean }
  /** 先記 commit，再建立 ref：當在兩次寫入之間也能核對原本的快照。 */
  | { type: 'checkpoint_prepared'; commit: string; ref: string }
  | ({ type: 'checkpoint' } & CheckpointRecord)
  /** kernel 自己跑的指令。記下身分，當掉後才有辦法確認它停了。 */
  | { type: 'check_started'; kind: 'setup' | 'test' | 'context'; pid: number; started: string; name: string }
  | { type: 'check_finished'; pid: number }
  | { type: 'test_lock_wait'; heldBy: string }
  | { type: 'test_lock_acquired' }
  | { type: 'verification'; commit: string; passed: boolean; exitCode: number | null; timedOut: boolean; tail: string }
  | { type: 'quota_unknown'; agent: string }
  | { type: 'state'; state: RunState; reason?: string; detail?: string };

export type KernelEvent = KernelEventBody & { seq: number; at: string };

export interface RawJobResult {
  status: string;
  exitCode: number | null;
  message: string;
  usage: UsageCount | null;
  /** 解析不出回覆時的原始輸出結尾，失敗分類會用到。 */
  rawTail: string;
}

export type JobPoll = { state: 'running' } | { state: 'finished'; result: RawJobResult } | { state: 'missing' };

/** kernel 只透過這個介面碰 job，測試因此可以用假的，完全不啟動 vendor。 */
export interface KernelExecutor {
  start(action: ActionSpec, contract: KernelContract): Promise<JobRef>;
  poll(job: JobRef): Promise<JobPoll>;
  /** 用 marker 查有沒有啟動過。null＝查過確定沒有；'unknown'＝查不了，不能當作沒有。 */
  find(marker: string): Promise<JobRef | null | 'unknown'>;
  kill(job: JobRef): Promise<boolean>;
  /** 程序真的消失才回 true。查不了要回 false。 */
  isGone(job: JobRef): Promise<boolean>;
}

export type BoundaryStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface WorkspaceState {
  /** 目前所在分支；detached 時是 null。 */
  branch: string | null;
  head: string;
  /** 還沒 commit 的路徑。 */
  dirty: string[];
  /** 相對基準 commit 改過的所有路徑，含還沒 commit 的。 */
  changed: string[];
  /** 基準 commit 還是 HEAD 的祖先。不是的話表示歷史被改寫。 */
  ancestorOk: boolean;
}

export interface CheckHandle {
  /** spawn 完立刻就有，先落盤。身分要查作業系統，比較慢，所以分開拿。 */
  pid: number;
  /** Deferred real commands wait until their PID is durable in the global lease/journal. */
  begin?(): void;
  identify(): Promise<{ started: string; name: string }>;
  /** 等最多 ms 毫秒。還沒結束回 null。 */
  wait(ms: number): Promise<{ exitCode: number | null; tail: string; output?: string } | null>;
  /** 連同子行程一起停掉。回 true 才代表確認退出了，送出訊號不算。 */
  kill(): Promise<boolean>;
  tail(): string;
}

/** kernel 只透過這個介面碰 git 和檢查指令，loop.ts 本身沒有 I/O 細節。 */
export interface WorkspaceOps {
  checkpointSnapshot(spec: DevelopSpec): string;
  checkpointRef(spec: DevelopSpec, commit: string): void;
  checkpointValid(spec: DevelopSpec, checkpoint: Pick<CheckpointRecord, 'commit' | 'ref'>): boolean;
  checkpointSecretPaths(spec: DevelopSpec, commit: string): string[];
  pushCheckpoint(spec: DevelopSpec, commit: string): void;
  prepare(spec: DevelopSpec): void;
  inspect(spec: DevelopSpec): WorkspaceState;
  /** 舊的注入執行器可省略；歸檔包會明示清單不完整。 */
  commitHistory?(spec: DevelopSpec): string[];
  commit(spec: DevelopSpec, message: string): string;
  restore(spec: DevelopSpec): void;
  refs(spec: DevelopSpec): string[];
  diffStat(spec: DevelopSpec): string;
  /** 相對基準 commit 的 diff；超額時逐檔截斷，省略明細在 reviewEvidence.files。 */
  diffText(spec: DevelopSpec, maxChars: number): string;
  /** 每類證據各自限額；baselineTests 保留全量，最終由 kernel 附加。 */
  reviewEvidence(spec: DevelopSpec, maxChars: number): import('./evidence.js').ReviewEvidence;
  startCheck(command: string, cwd: string, logPath: string, outputChars?: number, deferStart?: boolean): CheckHandle;
  /** 回 true 表示確定不在了。 */
  stopOrphanCheck(check: { pid: number; started: string; name: string }): Promise<boolean>;
}
