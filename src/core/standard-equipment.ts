/**
 * MCP 開場的標配檢查。只讀本機安裝資料，不呼叫 CLI、git 或網路。
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEquipmentFile, standardClaudeActions } from './updater.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INSTALLER = 'plugins/ai-cli_project-flow/install/codex-install.mjs';
const MARKER = '--ai-cli-project-flow';
const HOOK_EVENTS = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
} as const;

type HookStatus = 'missing' | 'stale' | 'untrusted' | 'changed' | 'disabled';
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

type Approval = { hash?: string; disabled?: boolean };
const approvalIndex = (id: string): string => process.platform === 'win32' ? id.replaceAll('\\', '/').toLowerCase() : id;

/**
 * /hooks 把使用者核准寫成 [hooks.state.'<檔案>:<事件>:<群組>:<項目>']。
 * 讀這種區塊或等價的雙引號區塊，避開註解與多行字串。只接受完整雜湊。
 * https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/config/src/hook_config.rs
 */
function approvals(config: string): Map<string, Approval> {
  const visible = config.replace(/#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:(?!''')[\s\S])*'''|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'/g,
    (token) => /^(?:#|"""|''')/.test(token) ? token.replace(/[^\r\n]/g, ' ') : token);
  const states = new Map<string, Approval>();
  let state: Approval | undefined;
  for (const line of visible.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      state = undefined;
      const key = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*]\s*$/.exec(line);
      if (!key) continue;
      const id = approvalIndex(key[2] ?? JSON.parse('"' + key[1] + '"') as string);
      if (states.has(id)) throw new Error('重複的 Codex hook 核准紀錄');
      state = {};
      states.set(id, state);
    } else if (state) {
      const hash = /^\s*trusted_hash\s*=\s*(?:"(sha256:[0-9a-f]{64})"|'(sha256:[0-9a-f]{64})')\s*$/.exec(line);
      if (hash) state.hash = hash[1] ?? hash[2];
      if (/^\s*enabled\s*=\s*false\s*$/.test(line)) state.disabled = true;
    }
  }
  return states;
}

type HookEventKey = typeof HOOK_EVENTS[keyof typeof HOOK_EVENTS] | 'pre_tool_use' | 'session_end';
interface CommandHookDeclaration {
  command: string;
  commandWindows?: string;
  command_windows?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
  additionalContextLimit?: number;
}

/**
 * Codex 0.172 的 hook_hash / version_for_toml：每個 handler 各算一次，TOML 省略未設欄位，
 * 再遞迴排序 JSON 的 key 後算 SHA-256。hooks.json 路徑只出現在核准索引。
 * https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/hooks/src/engine/discovery.rs
 */
export function declarationHash(event: HookEventKey, handler: CommandHookDeclaration,
  matcher?: string, platform = process.platform): string {
  const sessionEnd = event === 'session_end';
  const timeout = Math.max(1, handler.timeout ?? (sessionEnd ? 1 : 600));
  const limit = handler.additionalContextLimit;
  const supportsContext = !sessionEnd && event !== 'stop';
  const supportsMatcher = event !== 'user_prompt_submit' && event !== 'stop';
  const identity = {
    event_name: event,
    hooks: [{
      additionalContextLimit: supportsContext && limit !== 2500 ? limit ?? undefined : undefined,
      async: handler.async ?? false,
      command: (platform === 'win32' ? handler.commandWindows ?? handler.command_windows : undefined) ?? handler.command,
      statusMessage: handler.statusMessage ?? undefined,
      timeout: sessionEnd ? Math.min(3, timeout) : timeout,
      type: 'command',
    }],
    matcher: supportsMatcher ? matcher ?? undefined : undefined,
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function codexHookIssues(codexDir: string): string | null {
  try {
    const path = join(codexDir, 'hooks.json');
    const contents = readEquipmentFile(path);
    if (contents === undefined) return null;
    const declared = contents === null ? {} : record(JSON.parse(contents));
    const hooks = declared?.hooks === undefined ? {} : record(declared.hooks);
    if (!declared || !hooks) return null;

    const config = readEquipmentFile(join(codexDir, 'config.toml'));
    if (config === undefined) return null;
    const states = approvals(config ?? '');
    const issues: Record<HookStatus, string[]> = { missing: [], stale: [], untrusted: [], changed: [], disabled: [] };
    for (const [event, key] of Object.entries(HOOK_EVENTS)) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups)) return null;
      let status: HookStatus | 'ok' = 'missing';
      for (const [groupIndex, group] of groups.entries()) {
        if (!record(group) || (group.hooks !== undefined && !Array.isArray(group.hooks))) return null;
        for (const [handlerIndex, handler] of (group.hooks ?? []).entries()) {
          if (!record(handler)) return null;
          const command = handler.command;
          const suffix = ' ' + event + ' ' + MARKER;
          if (typeof command !== 'string' || !command.endsWith(suffix)) continue;
          if (status === 'missing') status = 'stale';
          // hooks 隨 repo 更新。這裡的「過舊」表示宣告已和安裝器目前產生的規格不同。
          const invocation = command.slice(0, -suffix.length);
          if (handler.type !== 'command' || handler.timeout !== 15 || handler.async === true
            || group.matcher != null || handler.commandWindows != null || handler.command_windows != null
            || handler.statusMessage != null || handler.additionalContextLimit != null
            || !/^node "[^"\r\n]+\/adapters\/codex\.mjs"$/.test(invocation)) continue;
          const approval = states.get(approvalIndex(path + ':' + key + ':' + groupIndex + ':' + handlerIndex));
          if (approval?.hash === declarationHash(key, handler, group.matcher) && !approval.disabled) {
            status = 'ok';
            break;
          }
          status = approval?.disabled ? 'disabled' : approval ? 'changed' : 'untrusted';
        }
        if (status === 'ok') break;
      }
      if (status !== 'ok') issues[status].push(event);
    }
    return [
      issues.missing.length && '尚未安裝 ' + issues.missing.join('、'),
      issues.stale.length && 'hook 宣告過舊或與安裝器不同 ' + issues.stale.join('、'),
      issues.untrusted.length && '尚未信任 ' + issues.untrusted.join('、'),
      issues.changed.length && '無法判斷，可能需要重新信任（/hooks 審查） ' + issues.changed.join('、'),
      issues.disabled.length && '已停用 ' + issues.disabled.join('、'),
    ].filter(Boolean).join('；');
  } catch { return null; }
}

function codexAction(root: string): string[] {
  const defaultDir = join(homedir(), '.codex');
  const codexDir = resolve(process.env.CODEX_HOME || defaultDir);
  const issues = codexHookIssues(codexDir);
  if (issues === '') return [];
  const installerPath = join(root, INSTALLER);
  const installer = (readEquipmentFile(installerPath) === null ? '<repo>/' + INSTALLER : installerPath).replaceAll('\\', '/');
  const source = installer.startsWith('<repo>') ? '\n  請先將 <repo> 換成 moerasermax/tkflyc-ai-cli 原始碼 checkout 路徑。' : '';
  const home = codexDir === defaultDir ? '' : '\n  安裝器寫入 ~/.codex。這個 session 有自訂 CODEX_HOME，請先與使用者確認要使用的設定目錄。';
  return ['【要問使用者】ai-cli_project-flow 的 Codex hook' +
    (issues === null ? '讀不到設定或信任紀錄，無法判斷是否已安裝。' : '：' + issues + '。') +
    '\n  安裝或更新前先預覽：node "' + installer + '" --dry-run' + source + home +
    '\n  經使用者同意後，移除 --dry-run 正式執行。重開 Codex，使用 /hooks 信任三個 hook。' +
    '\n  已安裝時，請使用 /hooks 審查信任或停用狀態。'];
}

export function getStandardEquipment(root = ROOT): { claude: string[]; codex: string[] } {
  if (process.env.AI_CLI_WORKER === '1') return { claude: [], codex: [] };
  let claude: string[];
  let codex: string[];
  try {
    claude = standardClaudeActions(root);
  } catch {
    claude = ['Claude Code 標配外掛無法判斷是否已安裝。'];
  }
  try {
    codex = codexAction(root);
  } catch {
    codex = ['ai-cli_project-flow 的 Codex hook 無法判斷是否已安裝或信任。'];
  }
  return { claude, codex };
}
