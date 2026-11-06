/**
 * 委任範本。全自動只開放給這裡列出來、成功定義已經寫死的任務類別，模型不能自己出題自己改。
 */
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { KNOWN_BAD_MODELS, isKnownModelTarget, isRemovedModel, removedModelMessage, resolveAgentIdForModel, resolveModelAlias } from '../models/catalog.js';
import { ALLOWED_REASONING_EFFORTS } from '../core/reasoning.js';
import { KERNEL_SCHEMA_VERSION, type KernelBudget, type KernelContract } from './types.js';

export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_EFFORT = 'medium';

export const DEFAULT_BUDGET: KernelBudget = {
  maxWorkerSteps: 6, maxDecides: 5, maxWallMinutes: 90, maxActionMinutes: 30,
  maxInputTokens: 1500000, quotaUnknownMaxDispatches: 2, minQuotaRemainingPercent: 25,
};

export interface KernelStartInput {
  goal: string;
  workFolder: string;
  template?: string;
  model?: string;
  effort?: string;
  decideModel?: string;
  decideEffort?: string;
  budget?: Partial<KernelBudget>;
  allowUnverifiedBoundary?: boolean;
}

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
每一項都要附至少一個引用，格式是相對於工作目錄的 路徑:行號，例如 src/app/cli.ts:42。kernel 會實際打開檔案核對，對不上就不算通過。
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
} as const;

export type KernelTemplateName = keyof typeof TEMPLATES;

export function buildContract(input: KernelStartInput, now = new Date()): KernelContract {
  const templateName = input.template ?? 'readonly-audit';
  if (!Object.hasOwn(TEMPLATES, templateName)) throw new Error(`沒有這個範本：${templateName}。目前可用：${Object.keys(TEMPLATES).join('、')}`);
  const template = TEMPLATES[templateName as KernelTemplateName];
  const goal = input.goal?.trim();
  if (!goal) throw new Error('必須提供目標（goal）');
  if (goal.length > 8000) throw new Error('目標太長，請控制在 8000 字內');
  if (!input.workFolder) throw new Error('必須提供工作目錄（workFolder）');
  const workFolder = isAbsolute(input.workFolder) ? input.workFolder : resolve(input.workFolder);
  try { if (!statSync(workFolder).isDirectory()) throw new Error('not a directory'); }
  catch { throw new Error(`工作目錄不存在：${workFolder}`); }
  const workerModel = assertDispatchableModel(input.model ?? DEFAULT_MODEL);
  const decideModel = assertDispatchableModel(input.decideModel ?? input.model ?? DEFAULT_MODEL);
  // effort 一律明確帶上：gpt-6.1-sol 的 CLI 預設是 low，省略不等於 medium。
  const workerEffort = input.effort ?? DEFAULT_EFFORT;
  const decideEffort = input.decideEffort ?? input.effort ?? DEFAULT_EFFORT;
  assertEffort(workerEffort); assertEffort(decideEffort);
  const budget = { ...DEFAULT_BUDGET, ...input.budget };
  for (const [name, value] of Object.entries(budget)) positive(name, value);
  const checks = template.build();
  return {
    schemaVersion: KERNEL_SCHEMA_VERSION, template: templateName, goal, workFolder,
    decide: { model: decideModel, effort: decideEffort }, worker: { model: workerModel, effort: workerEffort },
    allowedWorkerModels: [workerModel], budget, stepChecks: checks.stepChecks, acceptance: checks.acceptance,
    reportInstructions: template.reportInstructions,
    // 只有字面值 true 才算，比照 exec 的 authority：未知值不能當成沒寫。
    allowUnverifiedBoundary: input.allowUnverifiedBoundary === true,
    createdAt: now.toISOString(),
  };
}
