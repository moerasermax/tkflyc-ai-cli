/**
 * ai-cli_kernel 的資料形狀。
 *
 * 這個目錄是 ai-cli 的「延伸」：`core/`、`agents/`、`models/`、`plugins/` 不可以反過來
 * import 這裡（tests/verify-ai-cli_kernel.mjs 有斷言釘住）。對外看得到的名稱一律帶
 * `ai-cli_kernel` 前綴，讓人一眼分得出哪些不是原生功能。
 */

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
  /** 所有 job 回報的 input tokens 總和上限（含快取）。用完後不再新增派工，進行中的 job 不會被中斷。 */
  maxInputTokens: number;
  /** 額度量不到時，最多再派幾次。未知不等於還夠，這是事先核准的保守上限。 */
  quotaUnknownMaxDispatches: number;
  /** 週額度剩不到這個百分比就停下問人。 */
  minQuotaRemainingPercent: number;
}

export type AcceptanceCheck =
  | { type: 'message_nonempty' }
  | { type: 'min_length'; chars: number }
  | { type: 'no_refusal' }
  | { type: 'required_sections'; patterns: string[] }
  | { type: 'citations_resolve'; minCount: number };

/** 委任書。核准後不可變：內容的 digest 記在日誌，runner 每次啟動都會重算。 */
export interface KernelContract {
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
  createdAt: string;
}

export interface PlanStep { id: string; title: string; prompt: string; model?: string }

export interface ActionSpec {
  actionId: string;
  kind: 'decide' | 'worker';
  stepId?: string;
  model: string;
  effort?: string;
  prompt: string;
  /** 寫在 prompt 開頭。恢復時用它到 JobStore 找「有沒有真的啟動過」。 */
  marker: string;
}

/** startedAt 是 job 真正啟動的時間。接回時用它算時限，不會重新起算。 */
export interface JobRef { pid: number; jobId: string; startedAt?: string }

export type FailureClass =
  | 'rate_limited' | 'quota' | 'auth' | 'model_unavailable' | 'timeout' | 'policy_refused'
  | 'empty_output' | 'process_failed' | 'lost' | 'cancelled' | 'start_failed' | 'check_failed' | 'invalid_output';

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
  | { type: 'decide_processed'; actionId: string; ok: boolean; decision?: string; reason?: string; plan?: { planId: string; steps: PlanStep[]; reportStep?: string }; stop?: StopDecision }
  | { type: 'step_checked'; actionId: string; stepId: string; passed: boolean; failureClass?: FailureClass; findings: string[] }
  | { type: 'acceptance'; stepId: string; passed: boolean; findings: string[] }
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
