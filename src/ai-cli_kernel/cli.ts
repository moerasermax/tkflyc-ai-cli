/**
 * `ai-cli kernel <動作>`。預設印給人看的文字，加 --json 印原始資料。
 * 只回傳結束碼，由 bin/ai-cli.ts 的 exitAfterFlush 收尾，輸出才不會被截斷。
 */
import { readFileSync } from 'node:fs';
import {
  aiCliKernelApprove, aiCliKernelCancel, aiCliKernelCleanup, aiCliKernelEnabled, aiCliKernelProbe, aiCliKernelResult, aiCliKernelSetEnabled,
  aiCliKernelMandateSave, aiCliKernelMandateApprove, aiCliKernelMandateList, aiCliKernelMandateShow, aiCliKernelMandateRevoke,
  aiCliKernelTrigger, aiCliKernelTriggersSetEnabled, aiCliKernelSchedule,
  aiCliKernelMemory,
  aiCliKernelArchiveList, aiCliKernelArchiveShow, aiCliKernelArchiveDone,
  aiCliKernelStart, aiCliKernelStatus, aiCliKernelTemplates, aiCliKernelWait, aiCliKernelRollback, aiCliKernelReleaseCreate, aiCliKernelReleaseRun, type KernelRunStatus,
} from './api.js';
import type { KernelStartInput } from './templates.js';
import type { KernelMandateView } from './mandates.js';
import type { KernelScheduleDeps } from './schedule.js';

export const KERNEL_HELP_TEXT = `Usage: ai-cli kernel <動作> [選項]

ai-cli_kernel：給目標和委任書，它自己規劃、派 worker、驗收，做到有證據的結果。
readonly-audit（預設）只讀不改。develop 會在獨立的 worktree 和分支裡改程式、跑測試，不合併、不推交付分支；可推專用回復點。
它的 worker 權限等於你本人，也會載入你完整的 CLI 設定，沒有隔離。

第一次使用：
  ai-cli kernel probe --agent codex      確認這支 CLI 的唯讀限制真的有效（會用掉一點額度）

動作：
  start --goal <文字> --cwd <路徑>       建立委任書，先不執行
      [--goal-file <檔案>] [--template readonly-audit|develop]
      [--model <模型>] [--effort <等級>] [--decide-model <模型>] [--decide-effort <等級>]
      [--worker-models <a,b>]            另外允許 decide 挑選的 worker 模型
      [--max-steps <數>] [--max-decides <數>] [--max-minutes <數>] [--max-tokens <數>]
      [--allow-unverified]               探針沒過也照跑，標籤會寫「未驗證」
      [--context-command <唯讀指令>]     核准後開工前讀一次外部資料；以本人權限執行，不受 AI hook 限制
    develop 範本：
      [--base-ref <分支或 commit>]       建立時固定解析 commit；省略維持 HEAD 基準
      --test <指令>                      kernel 自己跑的驗收指令（必填），模型不能改
      [--setup <指令>]                   新 worktree 要先跑的準備指令，例如 npm ci
      [--allow-path <a,b>]               只能改這些路徑（相對 --cwd），不給就是整個 repo
      [--mandate-hours <數>]             委任書幾小時後失效（預設 24）
      [--max-test-failures <數>]         測試失敗幾次就停（預設 4）
      [--checkpoint push|local|off]      開工前回復點；有 origin 預設 push，否則 local
  approve <run> [--note <文字>] [--reconcile abandon] [--acknowledge-unisolated]
                                         核准委任書，或接回停住的 run。
                                         develop 第一次核准要加 --acknowledge-unisolated：
                                         worker 權限等於你本人，不是隔離環境
  wait <run> [--timeout <秒>]            等它停下來（預設 600 秒，逾時不算錯誤）
  status [run]                           看狀態；不給 run 就列出最近的
  actions <run> --json                    列出此刻可用操作與確認參數
  dashboard [--new-tab]                   全螢幕控制面板；新分頁僅支援 Windows Terminal
  archive list [--repo <路徑>] [--work-folder <路徑>] 列出待歸檔摘要（完整包用 show）
  archive show <run>                     從日誌計算歸檔包，不執行命令、不寫外部服務
  archive done <run> [--note <文字>]     主 session 完成交接後，只在本機標記
  result <run>                           看最終報告與裁決
  cancel <run>                           取消，並確認程序真的停了
  cleanup <run>                          清掉 develop 的 worktree；分支沒合併就留著
  rollback <run> [--apply]                預設印還原指令；apply 只建 restore/<run> 分支，不切換
  release create <run> --action merge|push --target <branch> --confirm <commit 前 10 碼>
       [--remote origin] [--hours 1] [--allow-default-branch]
                                         人的單次放行，只有 completed develop；推遠端預設分支可能等於部署
  release run <id>                       重新驗證後執行一次；結果不明絕不自動重試
  mandate save <name> [start 的選項] [--max-runs-per-day 1] [--max-tokens-per-day 2000000]
                                         只儲存委任範本；覆寫一律取消核准
  mandate approve <name> [--acknowledge-unisolated] [--days 30]
                                         人工核准，develop 要承認未隔離；預設 30 天到期
  mandate list | show <name> | revoke <name>
                                         列表／檢視／取消核准（保留範本）
  memory list [--cwd <repo>]             列出本機記憶與狀態
  memory add --text <文字> [--paths <a,b>] [--template <名稱>] [--cwd <repo>]
                                         新增 candidate，只是參考；promote 後才提供 decide
  memory promote|revoke <id> [--cwd <repo>]
                                         人工啟用／撤銷；worker 不可操作
  triggers on|off                        主動觸發總開關，預設關閉，獨立於 MCP 開關
  trigger <name>                         檢查核准、每日帳本與鎖；不過就記原因、不重試
  schedule <name> --daily HH:MM | --every-hours N
      [--apply]                          預設只預覽；Windows apply 登記工作，POSIX 只印 crontab
  schedule <name> --remove [--apply]      預覽移除；Windows apply 才真的移除
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

function listFlag(flags: Map<string, string | true>, name: string): string[] | undefined {
  return stringFlag(flags, name)?.split(',').map(item => item.trim()).filter(Boolean);
}

/** 沒給的欄位不能傳 undefined：readonly-audit 會把「有這個欄位」當成用錯範本。 */
function optionalFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function startInput(flags: Map<string, string | true>): KernelStartInput {
  const goalFile = stringFlag(flags, 'goal-file');
  const goal = goalFile ? readFileSync(goalFile, 'utf8') : stringFlag(flags, 'goal') ?? '';
  const budget = Object.fromEntries(Object.entries({
    maxWorkerSteps: numberFlag(flags, 'max-steps'), maxDecides: numberFlag(flags, 'max-decides'),
    maxWallMinutes: numberFlag(flags, 'max-minutes'), maxInputTokens: numberFlag(flags, 'max-tokens'),
    maxTestFailures: numberFlag(flags, 'max-test-failures'),
  }).filter(([, value]) => value !== undefined));
  return {
    goal, workFolder: stringFlag(flags, 'cwd') ?? process.cwd(), template: stringFlag(flags, 'template'),
    model: stringFlag(flags, 'model'), effort: stringFlag(flags, 'effort'),
    decideModel: stringFlag(flags, 'decide-model'), decideEffort: stringFlag(flags, 'decide-effort'),
    budget, allowUnverifiedBoundary: flags.get('allow-unverified') === true,
    ...optionalFields({
      workerModels: listFlag(flags, 'worker-models'), testCommand: stringFlag(flags, 'test'), setupCommand: stringFlag(flags, 'setup'),
      allowedPaths: listFlag(flags, 'allow-path'), mandateHours: numberFlag(flags, 'mandate-hours'),
      checkpoint: stringFlag(flags, 'checkpoint'),
      baseRef: stringFlag(flags, 'base-ref'),
      contextCommand: stringFlag(flags, 'context-command'),
    }),
  };
}

function formatMandate(mandate: KernelMandateView): string {
  return `${mandate.name}  ${mandate.status}\n${JSON.stringify(mandate, null, 2)}\n`;
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
    ...(status.origin ? [`來源     主動觸發 ${status.origin.mandate}`] : []),
    ...(status.contextCommand ? [`外部資料 ${status.contextCommand}（以本人權限執行，不受 AI hook 限制；請只接唯讀命令）`, ...(status.context ? [`讀取結果 ${status.context.ok ? '成功' : `失敗（不阻擋開工）：${status.context.detail}`}`] : [])] : []),
    `模型     決策 ${status.models.decide.model}（${status.models.decide.effort}）、worker ${status.models.worker.model}（${status.models.worker.effort}）`,
    ...(status.models.allowedWorkers.length > 1 ? [`可用模型 ${status.models.allowedWorkers.join('、')}`] : []),
    `權限     ${status.boundaryLabel}${Object.keys(status.boundary).length ? `（${Object.entries(status.boundary).map(([agent, state]) => `${agent}: ${state}`).join('、')}）` : ''}`,
    ...(status.develop ? [
      `來源     ${status.develop.repoRoot}（這裡不會被改動）`,
      `分支     ${status.develop.branch}（基準 ${status.develop.baseCommit.slice(0, 10)}）`,
      ...(status.develop.baseRef !== undefined ? [`基準輸入 ${status.develop.baseRef} → ${status.develop.baseCommit}${status.develop.dependsOnRunId ? `；依賴 ${status.develop.dependsOnRunId}` : ''}`] : []),
      ...(status.develop.checkpoint ? [`回復點   ${status.develop.checkpointMode}；遠端 ${status.develop.checkpoint.remote ?? '無'}；分支 ${status.develop.checkpoint.ref}${status.develop.checkpointResult ? ` @ ${status.develop.checkpointResult.commit}（${status.develop.checkpointResult.pushed ? '已推送' : '只留本地'}）` : status.develop.checkpointPrepared ? ` @ ${status.develop.checkpointPrepared.commit}（尚未完成）` : ''}`] : []),
      `測試     ${status.develop.testCommand}${status.develop.setupCommand ? `（先跑 ${status.develop.setupCommand}）` : ''}${status.develop.verifiedCommit ? `，${status.develop.verifiedCommit.slice(0, 10)} 已通過` : ''}${status.develop.testFailures ? `，失敗 ${status.develop.testFailures} 次` : ''}`,
      `範圍     ${status.develop.allowedPaths.length ? status.develop.allowedPaths.join('、') : '整個 repo（沒有限制路徑）'}`,
      `期限     委任書到 ${status.develop.expiresAt} 失效`,
      ...(status.develop.dirtyAtStart ? [`注意     主目錄有 ${status.develop.dirtyAtStart} 筆未提交的變更，不會帶進 worktree`] : []),
      ...status.develop.notices.map(notice => `注意     ${notice}`),
    ] : []),
    `進度     決策 ${p.decides.used}/${p.decides.max}、worker ${p.workerSteps.used}/${p.workerSteps.max}、未快取 input tokens ${p.inputTokens.used.toLocaleString('en-US')}/${p.inputTokens.max.toLocaleString('en-US')}（另有快取 ${p.cachedTokens.toLocaleString('en-US')}）${p.unknownUsage ? `（另有 ${p.unknownUsage} 個 job 量不到）` : ''}、執行 ${p.activeMinutes.used}/${p.activeMinutes.max} 分鐘`,
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

export async function runKernelCli(argv: string[], io: Io, deps: { schedule?: KernelScheduleDeps; trigger?: Parameters<typeof aiCliKernelTrigger>[1] } = {}): Promise<number> {
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
      case 'actions': {
        if (positionals.length !== 1 || [...flags.keys()].some(key => key !== 'json') || (flags.has('json') && flags.get('json') !== true)) throw new Error('用法：actions <run> [--json]');
        const { dashboardActions } = await import('./dashboard-api.js');
        const actions = await dashboardActions(needRun());
        emit(actions, actions.map(item => `${item.id}  ${item.label}：${item.summary}`).join('\n') + '\n');
        return 0;
      }
      case 'dashboard': {
        if (positionals.length || [...flags.keys()].some(key => key !== 'new-tab') || (flags.has('new-tab') && flags.get('new-tab') !== true)) throw new Error('用法：dashboard [--new-tab]');
        const terminal = await import('./dashboard-terminal.js');
        // worker 先拒絕；new-tab 的父行程可從 pipe 啟動，新分頁再檢查 TTY。
        if (flags.has('new-tab')) return terminal.launchDashboardTab(terminal.nativeLaunch(), io);
        const { dashboardEffects } = await import('./dashboard-api.js');
        return terminal.runDashboard(dashboardEffects);
      }
      case 'archive': {
        const [operation, runId] = positionals;
        if (!['list', 'show', 'done'].includes(operation) || positionals.length !== (operation === 'list' ? 1 : 2)) throw new Error('用法：archive list，或 archive show|done <run> [--note <文字>]');
        const allowed = operation === 'done' ? ['note', 'json'] : operation === 'list' ? ['repo', 'work-folder', 'json'] : ['json'];
        for (const flag of flags.keys()) if (!allowed.includes(flag)) throw new Error(`archive ${operation} 不接受 --${flag}`);
        if (flags.has('json') && flags.get('json') !== true) throw new Error('--json 不接受值');
        if (operation === 'list') {
          const packets = await aiCliKernelArchiveList(optionalFields({ repo: stringFlag(flags, 'repo'), workFolder: stringFlag(flags, 'work-folder') }));
          emit(packets, `待歸檔 ${packets.length} 筆\n${JSON.stringify(packets, null, 2)}\n`);
        } else if (operation === 'show') {
          const packet = await aiCliKernelArchiveShow({ runId });
          emit(packet, JSON.stringify(packet, null, 2) + '\n');
        } else {
          const mark = await aiCliKernelArchiveDone({ runId, note: stringFlag(flags, 'note') });
          emit(mark, `已在本機標記歸檔：${mark.runId}${mark.note ? `（${mark.note}）` : ''}\n`);
        }
        return 0;
      }
      case 'start': {
        const status = await aiCliKernelStart(startInput(flags));
        emit(status, formatStatus(status));
        return 0;
      }
      case 'memory': {
        const [operation, id] = positionals;
        if (!['list', 'add', 'promote', 'revoke'].includes(operation) || positionals.length !== (['promote', 'revoke'].includes(operation) ? 2 : 1)) throw new Error('用法：memory list|add|promote <id>|revoke <id>');
        const allowed = operation === 'add' ? ['cwd', 'text', 'paths', 'template', 'json'] : ['cwd', 'json'];
        for (const flag of flags.keys()) if (!allowed.includes(flag)) throw new Error(`memory ${operation} 不接受 --${flag}`);
        if (flags.has('json') && flags.get('json') !== true) throw new Error('--json 不接受值');
        const value = aiCliKernelMemory({ operation: operation as 'list' | 'add' | 'promote' | 'revoke', id, text: stringFlag(flags, 'text'), workFolder: stringFlag(flags, 'cwd') ?? process.cwd(), scope: optionalFields({ paths: listFlag(flags, 'paths'), template: stringFlag(flags, 'template') }) });
        emit(value, JSON.stringify(value, null, 2) + '\n');
        return 0;
      }
      case 'triggers': case 'trigger': case 'schedule': {
        const allowed = action === 'schedule' ? ['daily', 'every-hours', 'apply', 'remove', 'json'] : ['json'];
        for (const flag of flags.keys()) if (!allowed.includes(flag)) throw new Error(`${action} 不接受 --${flag}`);
        for (const flag of ['apply', 'remove', 'json']) if (flags.has(flag) && flags.get(flag) !== true) throw new Error(`--${flag} 不接受值`);
        if (positionals.length !== 1) throw new Error(`${action} 需要一個${action === 'triggers' ? ' on|off' : '範本名稱'}`);
        const name = positionals[0];
        if (action === 'triggers') {
          if (!['on', 'off'].includes(name)) throw new Error('用法：triggers on|off');
          const value = aiCliKernelTriggersSetEnabled(name === 'on');
          emit(value, `主動觸發已${value.enabled ? '開啟' : '關閉'}。\n`);
          return 0;
        }
        if (action === 'trigger') {
          const value = await aiCliKernelTrigger({ name }, deps.trigger);
          emit(value, `${value.status}：${value.reason}${value.runId ? `（${value.runId}）` : ''}${value.detail ? ` ${value.detail}` : ''}\n`);
          return value.status === 'failed' ? 1 : 0;
        }
        const value = aiCliKernelSchedule({ name, daily: stringFlag(flags, 'daily'), everyHours: numberFlag(flags, 'every-hours'), apply: flags.get('apply') === true, remove: flags.get('remove') === true }, deps.schedule);
        emit(value, `${value.applied ? '已執行' : '預覽（未執行）'}\n${value.command}\n`);
        return 0;
      }
      case 'mandate': {
        const [operation, name] = positionals;
        if (!['save', 'approve', 'list', 'show', 'revoke'].includes(operation) ||
          positionals.length !== (operation === 'list' ? 1 : 2)) throw new Error('用法：mandate save|approve|show|revoke <name>，或 mandate list');
        const startFlags = ['goal', 'goal-file', 'cwd', 'template', 'model', 'effort', 'decide-model', 'decide-effort', 'worker-models', 'test', 'setup', 'allow-path', 'mandate-hours', 'checkpoint', 'max-steps', 'max-decides', 'max-minutes', 'max-tokens', 'max-test-failures', 'allow-unverified', 'context-command'];
        const allowed = operation === 'save' ? [...startFlags, 'max-runs-per-day', 'max-tokens-per-day', 'json']
          : operation === 'approve' ? ['acknowledge-unisolated', 'days', 'json'] : ['json'];
        for (const flag of flags.keys()) if (!allowed.includes(flag)) throw new Error(`mandate ${operation} 不接受 --${flag}`);
        for (const flag of ['acknowledge-unisolated', 'allow-unverified', 'json']) {
          if (flags.has(flag) && flags.get(flag) !== true) throw new Error(`--${flag} 不接受值`);
        }
        if (operation === 'list') {
          const mandates = aiCliKernelMandateList();
          emit(mandates, mandates.length ? mandates.map(item => `${item.name}  ${item.status}`).join('\n') + '\n' : '還沒有委任範本。\n');
          return 0;
        }
        const mandate = operation === 'save' ? aiCliKernelMandateSave({ name, input: startInput(flags), maxRunsPerDay: numberFlag(flags, 'max-runs-per-day'), maxInputTokensPerDay: numberFlag(flags, 'max-tokens-per-day') })
          : operation === 'approve' ? aiCliKernelMandateApprove({ name, acknowledgeUnisolated: flags.get('acknowledge-unisolated') === true, days: numberFlag(flags, 'days') })
          : operation === 'revoke' ? aiCliKernelMandateRevoke({ name }) : aiCliKernelMandateShow({ name });
        emit(mandate, formatMandate(mandate));
        return 0;
      }
      case 'approve': {
        const status = await aiCliKernelApprove({ runId: needRun(), note: stringFlag(flags, 'note'), reconcile: stringFlag(flags, 'reconcile'), acknowledgeUnisolated: flags.get('acknowledge-unisolated') === true });
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
          const rows = status.runs.map(run => `${run.runId}  ${run.stateLabel}（${run.effectiveState}）${run.origin ? `  [觸發：${run.origin.mandate}]` : ''}  ${run.goal.replace(/\s+/g, ' ')}`);
          const active = status.activeRuns.map(run => `佔名額 ${run.runId}  ${run.repo}  ${run.models.decide}/${run.models.worker}  ${run.acquiredAt}`).join('\n');
          emit(status, `${active ? active + '\n' : ''}待歸檔 ${status.pendingArchiveCount} 筆\n` + (rows.length ? `${rows.join('\n')}\n` : '還沒有任何 run。用 ai-cli kernel start 建立。\n'));
        } else emit(status, formatStatus(status));
        return 0;
      }
      case 'result': {
        const result = await aiCliKernelResult({ runId: needRun() });
        emit(result, result.report
          ? `${result.report.trimEnd()}\n\n---\n裁決：${JSON.stringify(result.verdict)}\n`
          : `沒有最終報告。狀態：${result.state}${result.detail ? `（${result.detail}）` : ''}\n${result.context && !result.context.ok ? `contextCommand 失敗（不阻擋開工）：${result.context.detail}\n` : ''}下一步：${result.nextAction}\n`);
        return 0;
      }
      case 'cancel': {
        const status = await aiCliKernelCancel({ runId: needRun() });
        emit(status, formatStatus(status));
        return 0;
      }
      case 'cleanup': {
        const result = await aiCliKernelCleanup({ runId: needRun() });
        emit(result, `${result.detail}\n`);
        return result.worktreeRemoved ? 0 : 1;
      }
      case 'rollback': {
        const result = aiCliKernelRollback({ runId: needRun(), apply: flags.get('apply') === true });
        emit(result, result.applied ? `已建立 ${result.branch} @ ${result.commit}，目前目錄沒有切換。\n` : `${result.command}\n`);
        return 0;
      }
      case 'release': {
        const [operation, subject] = positionals;
        if (!subject || positionals.length !== 2 || !['create', 'run'].includes(operation)) throw new Error('用法：release create <run> --action merge|push --target <branch> --confirm <前10碼>，或 release run <id>');
        const allowed = operation === 'create' ? ['action', 'target', 'confirm', 'remote', 'hours', 'allow-default-branch', 'json'] : ['json'];
        for (const name of flags.keys()) if (!allowed.includes(name)) throw new Error(`release ${operation} 不接受 --${name}`);
        if (flags.has('allow-default-branch') && flags.get('allow-default-branch') !== true) throw new Error('--allow-default-branch 不接受值');
        if (operation === 'create') {
          const release = aiCliKernelReleaseCreate({
            runId: subject, action: stringFlag(flags, 'action') ?? '', target: stringFlag(flags, 'target') ?? '', confirm: stringFlag(flags, 'confirm') ?? '',
            remote: stringFlag(flags, 'remote'), hours: numberFlag(flags, 'hours'), allowDefaultBranch: flags.get('allow-default-branch') === true,
          });
          emit(release, `放行 ${release.id}\n${release.action} ${release.commit} → ${release.remote ? `${release.remote}/` : ''}${release.target}\n到期 ${release.expiresAt}\n${release.allowDefaultBranch ? '注意：推送遠端預設分支可能等於部署。\n' : ''}執行：ai-cli kernel release run ${release.id}\n`);
          return 0;
        }
        const result = aiCliKernelReleaseRun({ id: subject });
        emit(result, `放行 ${subject}：${result.status}\n${result.detail}\n`);
        return result.status === 'succeeded' ? 0 : 1;
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
