/**
 * `ai-cli kernel <動作>`。預設印給人看的文字，加 --json 印原始資料。
 * 只回傳結束碼，由 bin/ai-cli.ts 的 exitAfterFlush 收尾，輸出才不會被截斷。
 */
import { readFileSync } from 'node:fs';
import {
  aiCliKernelApprove, aiCliKernelCancel, aiCliKernelEnabled, aiCliKernelProbe, aiCliKernelResult, aiCliKernelSetEnabled,
  aiCliKernelStart, aiCliKernelStatus, aiCliKernelTemplates, aiCliKernelWait, type KernelRunStatus,
} from './api.js';

export const KERNEL_HELP_TEXT = `Usage: ai-cli kernel <動作> [選項]

ai-cli_kernel：給目標和委任書，它自己規劃、派唯讀 worker、驗收，做到有證據的結果。
第一版只跑唯讀任務，不會改你的檔案。

第一次使用：
  ai-cli kernel probe --agent codex      確認這支 CLI 的唯讀限制真的有效（會用掉一點額度）

動作：
  start --goal <文字> --cwd <路徑>       建立委任書，先不執行
      [--goal-file <檔案>] [--template readonly-audit]
      [--model <模型>] [--effort <等級>] [--decide-model <模型>] [--decide-effort <等級>]
      [--max-steps <數>] [--max-decides <數>] [--max-minutes <數>] [--max-tokens <數>]
      [--allow-unverified]               探針沒過也照跑，標籤會寫「未驗證」
  approve <run> [--note <文字>] [--reconcile abandon]
                                         核准委任書，或接回停住的 run
  wait <run> [--timeout <秒>]            等它停下來（預設 600 秒，逾時不算錯誤）
  status [run]                           看狀態；不給 run 就列出最近的
  result <run>                           看最終報告與裁決
  cancel <run>                           取消，並確認程序真的停了
  probe --agent <codex|claude|grok>      跑權限邊界探針
  templates                              列出可用範本
  enable | disable                       開關 MCP 的 ai-cli_kernel_* 工具（CLI 不受影響）

共用選項：
  --json                                 印原始 JSON
`;

interface Io { stdout(text: string): void; stderr(text: string): void }

function parse(argv: string[]): { positionals: string[]; flags: Map<string, string | true> } {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(name, argv[++i]);
    else flags.set(name, true);
  }
  return { positionals, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} 需要一個值`);
  return value;
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} 必須是非負數字`);
  return parsed;
}

const STEP_LABEL = { passed: '通過', failed: '未通過', running: '執行中', pending: '等待' } as const;

export function formatStatus(status: KernelRunStatus): string {
  const p = status.progress;
  const lines = [
    `run      ${status.runId}`,
    `狀態     ${status.stateLabel}（${status.effectiveState}）${status.reason ? `，原因：${status.reason}` : ''}`,
    ...(status.detail ? [`說明     ${status.detail}`] : []),
    `目標     ${status.goal}`,
    `目錄     ${status.workFolder}`,
    `範本     ${status.template}`,
    `模型     決策 ${status.models.decide.model}（${status.models.decide.effort}）、worker ${status.models.worker.model}（${status.models.worker.effort}）`,
    `權限     ${status.boundaryLabel}${Object.keys(status.boundary).length ? `（${Object.entries(status.boundary).map(([agent, state]) => `${agent}: ${state}`).join('、')}）` : ''}`,
    `進度     決策 ${p.decides.used}/${p.decides.max}、worker ${p.workerSteps.used}/${p.workerSteps.max}、input tokens ${p.inputTokens.used.toLocaleString('en-US')}/${p.inputTokens.max.toLocaleString('en-US')}${p.unknownUsage ? `（另有 ${p.unknownUsage} 個 job 量不到）` : ''}、執行 ${p.activeMinutes.used}/${p.activeMinutes.max} 分鐘`,
  ];
  if (status.steps.length > 0) {
    lines.push('步驟');
    for (const step of status.steps) {
      lines.push(`  [${STEP_LABEL[step.status]}] ${step.id} ${step.title}`);
      for (const finding of step.findings) lines.push(`      ${finding}`);
    }
  }
  if (status.acceptance) lines.push(`驗收     ${status.acceptance.passed ? '通過' : `未通過：${status.acceptance.findings.join('；')}`}`);
  if (status.reportPath) lines.push(`報告     ${status.reportPath}`);
  lines.push(`下一步   ${status.nextAction}`);
  return lines.join('\n') + '\n';
}

export async function runKernelCli(argv: string[], io: Io): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === 'help' || action === '--help' || action === '-h') { io.stdout(KERNEL_HELP_TEXT); return 0; }
  const { positionals, flags } = parse(rest);
  const json = flags.has('json');
  const emit = (value: unknown, text: string) => io.stdout(json ? JSON.stringify(value, null, 2) + '\n' : text);
  const needRun = (): string => {
    if (!positionals[0]) throw new Error(`${action} 需要 run id。用 ai-cli kernel status 查。`);
    return positionals[0];
  };
  try {
    switch (action) {
      case 'start': {
        const goalFile = stringFlag(flags, 'goal-file');
        const goal = goalFile ? readFileSync(goalFile, 'utf8') : stringFlag(flags, 'goal') ?? '';
        const budget = Object.fromEntries(Object.entries({
          maxWorkerSteps: numberFlag(flags, 'max-steps'), maxDecides: numberFlag(flags, 'max-decides'),
          maxWallMinutes: numberFlag(flags, 'max-minutes'), maxInputTokens: numberFlag(flags, 'max-tokens'),
        }).filter(([, value]) => value !== undefined));
        const status = await aiCliKernelStart({
          goal, workFolder: stringFlag(flags, 'cwd') ?? process.cwd(), template: stringFlag(flags, 'template'),
          model: stringFlag(flags, 'model'), effort: stringFlag(flags, 'effort'),
          decideModel: stringFlag(flags, 'decide-model'), decideEffort: stringFlag(flags, 'decide-effort'),
          budget, allowUnverifiedBoundary: flags.get('allow-unverified') === true,
        });
        emit(status, formatStatus(status));
        return 0;
      }
      case 'approve': {
        const status = await aiCliKernelApprove({ runId: needRun(), note: stringFlag(flags, 'note'), reconcile: stringFlag(flags, 'reconcile') });
        emit(status, formatStatus(status));
        return 0;
      }
      case 'wait': {
        const status = await aiCliKernelWait({ runId: needRun(), timeoutSec: numberFlag(flags, 'timeout') });
        emit(status, (status.timedOut ? '還在執行中，等待逾時（不算錯誤，可以再等一次）。\n' : '') + formatStatus(status));
        return 0;
      }
      case 'status': {
        const status = await aiCliKernelStatus({ runId: positionals[0] });
        if ('runs' in status) {
          const rows = status.runs.map(run => `${run.runId}  ${run.stateLabel}（${run.effectiveState}）  ${run.goal.replace(/\s+/g, ' ')}`);
          emit(status, rows.length ? `${rows.join('\n')}\n` : '還沒有任何 run。用 ai-cli kernel start 建立。\n');
        } else emit(status, formatStatus(status));
        return 0;
      }
      case 'result': {
        const result = await aiCliKernelResult({ runId: needRun() });
        emit(result, result.report
          ? `${result.report.trimEnd()}\n\n---\n裁決：${JSON.stringify(result.verdict)}\n`
          : `沒有最終報告。狀態：${result.state}${result.detail ? `（${result.detail}）` : ''}\n下一步：${result.nextAction}\n`);
        return 0;
      }
      case 'cancel': {
        const status = await aiCliKernelCancel({ runId: needRun() });
        emit(status, formatStatus(status));
        return 0;
      }
      case 'probe': {
        const agent = stringFlag(flags, 'agent');
        if (!agent) throw new Error('請指定 --agent，例如 --agent codex');
        const record = await aiCliKernelProbe({ agent, timeoutSec: numberFlag(flags, 'timeout') });
        emit(record, `探針結果：${record.status}\n${record.detail}\n${record.parts.version ? `CLI 版本：${record.parts.version}\n` : ''}`);
        return record.status === 'FAIL' ? 2 : 0;
      }
      case 'templates': {
        const list = aiCliKernelTemplates();
        emit(list, list.map(item => `${item.name}\n  ${item.description}`).join('\n') + '\n');
        return 0;
      }
      case 'enable': case 'disable': {
        const result = aiCliKernelSetEnabled(action === 'enable');
        emit(result, `MCP 工具已${result.enabled ? '開啟' : '關閉'}（設定檔 ${result.path}）。需要重新連線 MCP 才會生效，例如在 Claude Code 裡執行 /mcp。\n`);
        return 0;
      }
      case 'enabled': { emit({ enabled: aiCliKernelEnabled() }, `${aiCliKernelEnabled() ? '已開啟' : '未開啟'}\n`); return 0; }
      default:
        io.stderr(`不認識的動作：${action}\n`);
        io.stdout(KERNEL_HELP_TEXT);
        return 1;
    }
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 1;
  }
}
