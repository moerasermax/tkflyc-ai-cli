/**
 * MCP 工具。預設不出現：要先 `ai-cli kernel enable`。名稱一律以 ai-cli_kernel_ 開頭，
 * 和原生的 run、wait 等工具分得開。
 */
import {
  aiCliKernelApprove, aiCliKernelCancel, aiCliKernelEnabled, aiCliKernelProbe, aiCliKernelResult, aiCliKernelStart, aiCliKernelStatus,
} from './api.js';

export const KERNEL_TOOL_PREFIX = 'ai-cli_kernel_';

const RUN_ID = { type: 'string', description: 'run id，例如 kr-20261106-012345-ab12。' };

const TOOLS = [
  {
    name: 'ai-cli_kernel_start',
    description: 'Create a mandate for a supervised read-only agent run. Nothing executes until ai-cli_kernel_approve. The kernel then plans with a tool-less model call, dispatches read-only workers, verifies the deliverable with deterministic checks (including that cited path:line references exist), and recovers across restarts. Tool-limited, not isolated.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '要達成什麼。' },
        workFolder: { type: 'string', description: '工作目錄的絕對路徑。' },
        template: { type: 'string', description: '範本，預設 readonly-audit。' },
        model: { type: 'string', description: 'worker 模型，預設 gpt-6.1-sol。' },
        effort: { type: 'string', description: 'worker effort，預設 medium。' },
        decideModel: { type: 'string', description: '決策模型，預設同 worker。' },
        decideEffort: { type: 'string', description: '決策 effort，預設同 worker。' },
        budget: {
          type: 'object',
          properties: {
            maxWorkerSteps: { type: 'number' }, maxDecides: { type: 'number' }, maxWallMinutes: { type: 'number' }, maxActionMinutes: { type: 'number' },
            maxInputTokens: { type: 'number' }, quotaUnknownMaxDispatches: { type: 'number' }, minQuotaRemainingPercent: { type: 'number' },
          },
        },
        allowUnverifiedBoundary: { type: 'boolean', description: '只有明確傳 true 才生效：權限探針沒過也照跑，標籤會寫未驗證。' },
      },
      required: ['goal', 'workFolder'],
    },
  },
  {
    name: 'ai-cli_kernel_approve',
    description: 'Approve the mandate of a run, or continue a paused or interrupted run. Completed steps are never re-dispatched. Show the mandate to the user before calling this: the approval is theirs.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: RUN_ID,
        note: { type: 'string', description: '給決策模型的補充或問題的答案。' },
        reconcile: { type: 'string', enum: ['abandon'], description: '狀態是 needs_reconcile 時，確認後放棄未知動作的結果。' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'ai-cli_kernel_status',
    description: 'Show one run (state, progress against budget, steps, next action), or list recent runs when runId is omitted.',
    inputSchema: { type: 'object', properties: { runId: RUN_ID } },
  },
  {
    name: 'ai-cli_kernel_result',
    description: 'Get the final report and verdict of a completed run. The report only exists when every acceptance check passed.',
    inputSchema: { type: 'object', properties: { runId: RUN_ID }, required: ['runId'] },
  },
  {
    name: 'ai-cli_kernel_cancel',
    description: 'Cancel a run and confirm its worker process is really gone. If it cannot be confirmed the state becomes stop_pending; call again to re-check.',
    inputSchema: { type: 'object', properties: { runId: RUN_ID }, required: ['runId'] },
  },
  {
    name: 'ai-cli_kernel_probe',
    description: 'Run the permission boundary probe for an agent: asks a real model to try writing files and checks the result. Consumes a small amount of quota and blocks until done. Required once per CLI version before approving a run.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', enum: ['codex', 'claude', 'grok'] } },
      required: ['agent'],
    },
  },
];

export function aiCliKernelToolDefinitions(): typeof TOOLS {
  return aiCliKernelEnabled() ? TOOLS : [];
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} 必須是非空字串`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} 必須是字串`);
  return value;
}

export async function aiCliKernelHandleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!aiCliKernelEnabled()) throw new Error('ai-cli_kernel 尚未開啟。請先執行 ai-cli kernel enable');
  switch (name) {
    case 'ai-cli_kernel_start':
      return aiCliKernelStart({
        goal: requireString(args, 'goal'), workFolder: requireString(args, 'workFolder'), template: optionalString(args, 'template'),
        model: optionalString(args, 'model'), effort: optionalString(args, 'effort'),
        decideModel: optionalString(args, 'decideModel'), decideEffort: optionalString(args, 'decideEffort'),
        ...(args.budget && typeof args.budget === 'object' ? { budget: args.budget as Record<string, number> } : {}),
        allowUnverifiedBoundary: args.allowUnverifiedBoundary === true,
      });
    case 'ai-cli_kernel_approve':
      return aiCliKernelApprove({ runId: requireString(args, 'runId'), note: optionalString(args, 'note'), reconcile: optionalString(args, 'reconcile') });
    case 'ai-cli_kernel_status':
      return aiCliKernelStatus({ runId: optionalString(args, 'runId') });
    case 'ai-cli_kernel_result':
      return aiCliKernelResult({ runId: requireString(args, 'runId') });
    case 'ai-cli_kernel_cancel':
      return aiCliKernelCancel({ runId: requireString(args, 'runId') });
    case 'ai-cli_kernel_probe':
      return aiCliKernelProbe({ agent: requireString(args, 'agent') });
    default:
      throw new Error(`不認識的工具：${name}`);
  }
}
