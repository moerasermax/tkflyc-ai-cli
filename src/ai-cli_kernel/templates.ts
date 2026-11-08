/**
 * 委任範本。全自動只開放給這裡列出來、成功定義已經寫死的任務類別，模型不能自己出題自己改。
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { KNOWN_BAD_MODELS, isKnownModelTarget, isRemovedModel, removedModelMessage, resolveAgentIdForModel, resolveModelAlias } from '../models/catalog.js';
import { ALLOWED_REASONING_EFFORTS } from '../core/reasoning.js';
import { KERNEL_SCHEMA_VERSION, type DevelopSpec, type KernelBudget, type KernelContract } from './types.js';
import { aiCliKernelCheckpointSpec, aiCliKernelResolveBaseRef, describeRepo, normalizeAllowedPaths } from './workspace.js';
import { hasProbeEvidenceFormat, probeResultLabel } from './probe.js';

export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_EFFORT = 'medium';

export const DEFAULT_BUDGET: KernelBudget = {
  maxWorkerSteps: 6, maxDecides: 5, maxWallMinutes: 90, maxActionMinutes: 30,
  maxInputTokens: 1500000, quotaUnknownMaxDispatches: 2, minQuotaRemainingPercent: 25, maxTestFailures: 4,
};

/** 開發任務要改、要測、可能要重來，預設放寬；但額度門檻和額度未知的上限不放寬。 */
const DEVELOP_BUDGET: Partial<KernelBudget> = { maxWorkerSteps: 10, maxDecides: 8, maxWallMinutes: 180, maxActionMinutes: 45, maxInputTokens: 2000000 };
const DEFAULT_MANDATE_HOURS = 24;

export interface KernelStartInput {
  baseRef?: string;
  contextCommand?: string;
  checkpoint?: string;
  goal: string;
  workFolder: string;
  template?: string;
  model?: string;
  effort?: string;
  decideModel?: string;
  decideEffort?: string;
  budget?: Partial<KernelBudget>;
  allowUnverifiedBoundary?: boolean;
  /** 另外允許 decide 挑選的 worker 模型。model 那個一定在裡面。 */
  workerModels?: string[];
  /** develop 範本必填：kernel 自己跑的驗收指令。 */
  testCommand?: string;
  /** develop 範本：新 worktree 要先跑的準備指令，例如 npm ci。 */
  setupCommand?: string;
  /** develop 範本：允許改動的路徑，相對 workFolder。不給就是整個 repo。 */
  allowedPaths?: string[];
  /** develop 範本：委任書幾小時後失效，預設 24。 */
  mandateHours?: number;
}

/** develop 的分支和 worktree 跟著 run 走，所以要先有 run id 才能建委任書。 */
export interface BuildContractContext { runId: string; worktree: string }

/** 名稱能跑不代表該派：未知名稱會被 claude catch-all 接走，所以這裡比 run 更嚴。 */
export function assertDispatchableModel(model: string): string {
  const resolved = resolveModelAlias(model);
  if (isRemovedModel(resolved)) throw new Error(removedModelMessage(resolved));
  const bad = KNOWN_BAD_MODELS.find(entry => entry.model.split(/\s*\/\s*/).includes(resolved));
  if (bad) throw new Error(`模型 ${resolved} 在 knownBadModels 裡：${bad.reason}`);
  const agent = resolveAgentIdForModel(resolved);
  if (agent === 'direct-api') throw new Error(`模型 ${resolved} 走 direct-api，它沒有唯讀模式，kernel 目前不能使用`);
  if (!isKnownModelTarget(resolved)) throw new Error(`模型 ${resolved} 不在候選清單內，為了避免被 claude catch-all 接走，kernel 不接受`);
  return resolved;
}

function assertEffort(effort: string): void {
  if (!ALLOWED_REASONING_EFFORTS.has(effort)) throw new Error(`不支援的 effort：${effort}`);
}

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`預算 ${name} 必須是非負數`);
}

export const TEMPLATES = {
  'readonly-audit': {
    description: '唯讀稽核：讀程式碼、列出發現，每項都要附可驗證的 路徑:行號。不改任何檔案。',
    reportInstructions: `用繁體中文，依序包含這三個段落，標題照寫：
## 結論
## 發現
每一項都要附至少一個引用，格式是「從 repo 根目錄算起的完整相對路徑:行號」，例如 src/app/cli.ts:42（不是只寫 cli.ts:42）。非 git 工作目錄則從工作目錄算起。kernel 會實際打開檔案核對，對不上就不算通過。
## 尚待確認
沒讀到、沒驗證的部分寫在這裡。沒有就寫「無」。`,
    build: () => ({
      stepChecks: [{ type: 'message_nonempty' as const }, { type: 'no_refusal' as const }],
      acceptance: [
        { type: 'message_nonempty' as const }, { type: 'no_refusal' as const }, { type: 'min_length' as const, chars: 80 },
        { type: 'required_sections' as const, patterns: ['^#{1,4}\\s*結論', '^#{1,4}\\s*發現', '^#{1,4}\\s*尚待確認'] },
        { type: 'citations_resolve' as const, minCount: 1 },
      ],
    }),
  },
  develop: {
    description: '開發：在獨立的 worktree 和分支裡改程式、跑測試，做到測試通過。不合併、不推交付分支；可推專用回復點。worker 權限等於你本人，未隔離。',
    reportInstructions: `用繁體中文，依序包含以下段落，標題照寫：
## 結論
做完了什麼，一兩句。
## 改動
改了哪些東西、為什麼這樣改。提到程式位置時用「從 repo 根目錄算起的完整相對路徑:行號」（例如 src/app/cli.ts:42，不是 cli.ts:42），kernel 會實際打開檔案核對，對不上就不算通過。
## 為了讓既有測試通過而改動的斷言
參照 kernel 提供的基準測試變更清單，逐檔說明為何改動或刪除既有斷言；未改動斷言的檔案也逐檔說明。無則寫「無」。清單只代表檔案變更，不代表已查明動機；未確認的部分要明講。
## 尚待確認
沒做完、沒驗證、需要人判斷的部分寫在這裡。沒有就寫「無」。`,
    build: () => ({
      stepChecks: [{ type: 'message_nonempty' as const }, { type: 'no_refusal' as const }],
      acceptance: [
        { type: 'message_nonempty' as const }, { type: 'no_refusal' as const }, { type: 'min_length' as const, chars: 40 },
        { type: 'required_sections' as const, patterns: ['^#{1,4}\\s*結論', '^#{1,4}\\s*改動', '^#{1,4}\\s*尚待確認'] },
        { type: 'citations_resolve' as const, minCount: 0 },
      ],
    }),
  },
} as const;

export type KernelTemplateName = keyof typeof TEMPLATES;

/**
 * kernel 自己跑的指令不經過 AI 工具，使用者的 PreToolUse hook 管不到，所以要在核准前講清楚。
 * 專案層 Codex hook 的信任紀錄綁絕對路徑，每個 run 的 worktree 都是新路徑，codex exec 會跳過沒信任的 hook。
 */
function developNotices(repoRoot: string, models: readonly string[]): string[] {
  const notices = ['測試跑完後，kernel 會在這個 run 的 worktree 執行 git reset --hard 和 git clean -fd 清掉副產物。此時改動都已 commit，也不碰主目錄。這是 kernel 自己跑的，你的 hook 不會擋。'];
  if (existsSync(join(repoRoot, '.codex', 'hooks.json')) && models.some(model => resolveAgentIdForModel(model) === 'codex')) {
    notices.push('這個 repo 有專案層的 .codex/hooks.json，但 Codex 的 hook 信任綁絕對路徑，在 worktree 裡很可能不會觸發。依賴這些 hook 把關的話，請改用其他模型，或自己盯著。');
  }
  if (models.length === 1) notices.push('驗收只代表 worker 寫的測試和既有測試通過，沒有第二個模型檢查');
  for (const agent of new Set(models.map(resolveAgentIdForModel))) {
    if (!hasProbeEvidenceFormat(agent)) notices.push(probeResultLabel(agent, 'UNKNOWN'));
  }
  return notices;
}

function buildDevelopSpec(input: KernelStartInput, workFolder: string, now: Date, models: readonly string[], context?: BuildContractContext): DevelopSpec {
  if (!context) throw new Error('develop 範本需要 run id 才能決定分支和 worktree');
  const testCommand = input.testCommand?.trim();
  if (!testCommand) throw new Error('develop 範本一定要給測試指令（testCommand）：kernel 靠它驗收，模型說測過了不算數');
  const repo = describeRepo(workFolder);
  if (!repo) throw new Error(`develop 範本需要 git repo，而且至少有一個 commit：${workFolder}`);
  const hours = input.mandateHours ?? DEFAULT_MANDATE_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('mandateHours 必須是正數');
  const base = input.baseRef === undefined ? null : aiCliKernelResolveBaseRef(repo.root, input.baseRef);
  return {
    checkpoint: aiCliKernelCheckpointSpec(repo.root, context.runId, input.checkpoint),
    repoRoot: repo.root, prefix: repo.prefix, baseCommit: base?.commit ?? repo.head, branch: `ai-cli_kernel/${context.runId}`, worktree: context.worktree, testCommand,
    ...(base ? { baseRef: input.baseRef!, ...(base.ref ? { baseRefRef: base.ref } : {}) } : {}),
    ...(input.setupCommand?.trim() ? { setupCommand: input.setupCommand.trim() } : {}),
    allowedPaths: normalizeAllowedPaths(input.allowedPaths ?? [], repo.prefix), dirtyAtStart: repo.dirty,
    expiresAt: new Date(now.getTime() + hours * 3600000).toISOString(),
    notices: developNotices(repo.root, models),
  };
}

export function buildContract(input: KernelStartInput, now = new Date(), context?: BuildContractContext): KernelContract {
  const templateName = input.template ?? 'readonly-audit';
  if (!Object.hasOwn(TEMPLATES, templateName)) throw new Error(`沒有這個範本：${templateName}。目前可用：${Object.keys(TEMPLATES).join('、')}`);
  const template = TEMPLATES[templateName as KernelTemplateName];
  const goal = input.goal?.trim();
  if (input.contextCommand !== undefined && (typeof input.contextCommand !== 'string' || !input.contextCommand.trim() || input.contextCommand.length > 8000 || input.contextCommand.includes('\0'))) throw new Error('contextCommand 必須是 1–8000 字元的命令，不能含 NUL');
  if (!goal) throw new Error('必須提供目標（goal）');
  if (goal.length > 8000) throw new Error('目標太長，請控制在 8000 字內');
  if (!input.workFolder) throw new Error('必須提供工作目錄（workFolder）');
  const workFolder = isAbsolute(input.workFolder) ? input.workFolder : resolve(input.workFolder);
  try { if (!statSync(workFolder).isDirectory()) throw new Error('not a directory'); }
  catch { throw new Error(`工作目錄不存在：${workFolder}`); }
  const isDevelop = templateName === 'develop';
  if (!isDevelop && (input.baseRef !== undefined || input.checkpoint !== undefined || input.testCommand !== undefined || input.setupCommand !== undefined || input.allowedPaths !== undefined || input.mandateHours !== undefined)) {
    throw new Error(`baseRef、testCommand、setupCommand、allowedPaths、mandateHours 只有 develop 範本能用，${templateName} 不會改檔`);
  }
  const workerModel = assertDispatchableModel(input.model ?? DEFAULT_MODEL);
  const decideModel = assertDispatchableModel(input.decideModel ?? input.model ?? DEFAULT_MODEL);
  // effort 一律明確帶上：gpt-6.1-sol 的 CLI 預設是 low，省略不等於 medium。
  const workerEffort = input.effort ?? DEFAULT_EFFORT;
  const decideEffort = input.decideEffort ?? input.effort ?? DEFAULT_EFFORT;
  assertEffort(workerEffort); assertEffort(decideEffort);
  const budget = { ...DEFAULT_BUDGET, ...(isDevelop ? DEVELOP_BUDGET : {}), ...input.budget };
  for (const [name, value] of Object.entries(budget)) positive(name, value);
  const checks = template.build();
  const allowedWorkerModels = [...new Set([workerModel, ...(input.workerModels ?? []).map(assertDispatchableModel)])];
  return {
    schemaVersion: KERNEL_SCHEMA_VERSION, template: templateName, goal, workFolder,
    ...(input.contextCommand !== undefined ? { contextCommand: input.contextCommand.trim() } : {}),
    decide: { model: decideModel, effort: decideEffort }, worker: { model: workerModel, effort: workerEffort },
    allowedWorkerModels, budget, stepChecks: checks.stepChecks, acceptance: checks.acceptance,
    reportInstructions: template.reportInstructions,
    // 只有字面值 true 才算，比照 exec 的 authority：未知值不能當成沒寫。
    allowUnverifiedBoundary: input.allowUnverifiedBoundary === true,
    ...(isDevelop ? { develop: buildDevelopSpec(input, workFolder, now, allowedWorkerModels, context) } : {}),
    createdAt: now.toISOString(),
  };
}
