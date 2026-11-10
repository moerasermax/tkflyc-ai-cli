/**
 * Claude agent。也是整個 routing 的 fallback（matchesModel 永遠 true）。
 * 行為 1:1 還原 dist：cli-builder.js claude 分支 + parsers.js parseClaudeOutput。
 */

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';
import { debugLog } from '../core/debug.js';

// 'fable' 放最前＝目前最新一代。它是 claude CLI 的別名；實測派工時模型自報
// claude-fable-5-1，但「別名確切指向哪個 id」沒有實測過，所以這裡不寫死全名。
// ⚠️ 這份清單是手動維護的，而 claude 是 catch-all（見下面的 matchesModel）：
// 沒列進來的名稱照樣派得動。清單的語意見 catalog.ts 的 MODEL_LIST_CAVEAT。
const CLAUDE_MODELS = ['fable', 'sonnet', 'sonnet[1m]', 'opus', 'opusplan', 'haiku'] as const;

const CLAUDE_REASONING = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const SYSTEM_PROMPT_DIR = join(tmpdir(), 'ai-cli-system-prompts');
const SYSTEM_PROMPT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 系統提示走**檔案**，不走 args。
 *
 * 理由就寫在本檔 buildCommand 的註解裡：Windows 上 claude 是 npm 的 .CMD shim，
 * spawn 需要 shell:true，而 cmd.exe 會對含空白／換行的長參數重新切詞、並在換行處截斷。
 * prompt 因此改走 stdin。系統提示同樣是多行長文字，走 args 會踩一模一樣的坑，
 * 而且失敗的樣子很難看：指令跑得起來、系統提示卻少了半截。
 */
function writeSystemPromptFile(text: string): string {
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true });
  pruneStaleSystemPrompts();
  const path = join(
    SYSTEM_PROMPT_DIR,
    `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
  );
  writeFileSync(path, text, 'utf8');
  return path;
}

/** 每次寫入順手清過期的：沒有人會回來刪這些檔，累積起來就是一個沒人看的垃圾堆。 */
function pruneStaleSystemPrompts(): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(SYSTEM_PROMPT_DIR)) {
      if (!name.startsWith('sp_')) continue;
      const full = join(SYSTEM_PROMPT_DIR, name);
      try {
        if (now - statSync(full).mtimeMs > SYSTEM_PROMPT_TTL_MS) unlinkSync(full);
      } catch {
        /* 清不掉某一個不該擋住這次呼叫 */
      }
    }
  } catch {
    /* 目錄剛建好或被外部刪掉，都不是錯 */
  }
}

/**
 * 嚴格模式下 claude 可以擁有的唯讀工具。**這是單一來源**：`buildStrictCommand` 的
 * `--tools` 白名單由它組出，探針（判斷 stream-json init 事件的 `tools` 是否只剩唯讀工具）
 * 也 import 這一份，不要在別處再抄一份清單。
 */
export const CLAUDE_READ_ONLY_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep']);

/**
 * 能力 → 這個 vendor 的嚴格限制。
 *
 * **給不出保證就丟例外**（fail-closed）。放寬是最糟的失敗方式：
 * 呼叫端以為有限制、畫面上寫著有限制，而程序其實全開。
 */
const CLAUDE_TOOLS_BY_CAPABILITY: Record<string, readonly string[]> = {
  'fs/read': CLAUDE_READ_ONLY_TOOLS,
  'analysis/produce': [], // 產出走 stdout，不需要工具
};

/**
 * 能力 → `--tools` 白名單的內容（依能力出現順序、去重）。
 * 對不到的能力丟例外、拒絕啟動，不放寬。回傳空陣列代表「一個工具都不給」。
 */
export function claudeStrictTools(capabilities: readonly string[]): string[] {
  const tools = new Set<string>();
  for (const capability of capabilities) {
    const mapped = CLAUDE_TOOLS_BY_CAPABILITY[capability];
    if (mapped === undefined) {
      throw new Error(
        `claude 的嚴格模式無法保證能力「${capability}」——拒絕啟動（不放寬）。`
      );
    }
    for (const tool of mapped) tools.add(tool);
  }
  return [...tools];
}

/**
 * 嚴格模式一律拒絕的工具。**這是第二層**，第一層是 `--tools` 白名單
 * （見 buildStrictCommand 的註解）。
 *
 * 列舉式清單有一個明顯的弱點：新工具出現時它會過期，而過期的樣子是「悄悄放行」。
 * 這已經發生過：2026-11-09 在 Claude Code 2.1.319 實測，只靠這份黑名單時
 * stream-json init 事件的 `tools` 還列著 20 個工具（Workflow、EnterWorktree、CronCreate、
 * RemoteTrigger、WebFetch……）。所以它只留作白名單之外的保險，不再是主要防線；
 * 真正的守門是白名單，加上 `verify-strict-behaviour.mjs` 那種**真的跑一次、看 init 的
 * tools 與檔案在不在**的行為驗證。
 *
 * `Task` 要擋是因為它會派生子 agent，而子 agent 不繼承這裡的限制；
 * `Bash` 則是最明顯的繞道（`echo > file`）。
 */
const DENIED_WHEN_STRICT: readonly string[] = [
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'Task',
  'SlashCommand',
];

function buildStrictCommand(
  input: BuildCommandInput,
  capabilities: readonly string[]
): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, reasoningEffort, sessionId, systemPrompt } = input;
  const tools = claudeStrictTools(capabilities);
  /*
    與 buildCommand 的差別：**沒有 --dangerously-skip-permissions**。

    ── 三層，依可靠度排 ─────────────────────────────────────────
    1. **`--tools` 白名單是第一層。** 它決定這個 session 裡「有哪些工具存在」，
       沒列的工具根本不出現在模型面前（不是「呼叫時被拒」）。2026-11-09 實測
       （Claude Code 2.1.319、Windows）：`--tools Read,Glob,Grep` 之後 stream-json 的
       init 事件 `tools` 只剩 ["Glob","Grep","Read"]、`mcp_servers` 是 []。
    2. **`--disallowedTools` 黑名單是第二層，而且會過期。** 同一天只用黑名單時，
       init 的 `tools` 還有 20 個（Workflow、EnterWorktree、CronCreate、RemoteTrigger、
       WebFetch……）——都是黑名單寫好之後才出現的工具。它們在 -p 下能不能真的寫入
       沒有實測，是推論出的風險；但「新工具預設放行」這件事本身就是黑名單的結構性缺陷。
       留著它，是為了白名單萬一失效（vendor 改了旗標語意）時還有一層。
    3. **`--restricted`**：拿掉會跑指令或程式碼的內建工具（Bash、PowerShell 等）與
       WebFetch（除非 --tools 點名），並且**忽略使用者、專案、local 三層設定檔**
       （managed settings 與 --settings 仍生效）。

    `--restricted` 的取捨：不讀使用者設定，就不會跑使用者的 SessionStart hook，
    strict 的 claude 因此**拿不到 worker 身分鎖的注入**。這可以接受：它沒有 MCP
    （--strict-mcp-config）、沒有 Agent／Task、沒有 shell 工具，本來就沒辦法再派工，
    身分鎖要擋的事它做不到。

    ── 舊版 CLI：刻意 fail-closed ───────────────────────────────
    不認得 `--tools` 或 `--restricted` 的舊版 claude CLI 會直接報錯、job 失敗。
    **刻意不降級回只用黑名單**：降級等於在呼叫端不知情時放寬，而黑名單已知過期。
    要用 strict 就升級 CLI。

    ── variadic 旗標的值不能是空字串 ──────────────────────────
    `--tools <tools...>` 與 `--allowedTools <tools...>` 都是 variadic，值後面必須緊接
    另一個 `--` 開頭的旗標，不能讓 prompt 或其他位置參數接在它後面。更危險的是空值：
    Windows 經 cmd.exe 啟動時空字串參數會整個消失，旗標就把下一個旗標吃成自己的值。
    2026-09-16 實測過 `--allowedTools` 空值把整組 `--disallowedTools` 吃掉、寫入完全
    擋不住（capabilities 只給 analysis/produce 的時候）。所以：
      - 工具集為空時用 `--tools=`（同一個 argv 元素，不會被 cmd.exe 吃掉；依 commander
        的 `--opt=value` 解析，應等同 `--tools ""`，而 Claude Code 文件說 `""` 是停用所有
        工具——兩者都是推論）。⚠️ 這個寫法**還沒用真的 CLI 實測過**，
        `verify-strict-behaviour.mjs` 有一組純產出的案例要驗它。CLI 若不接受，job 會
        失敗（fail-closed）；就算被誤解成預設工具集，第 2、3 層仍在，不會比改版前更寬。
      - `--allowedTools` 只在有工具時才帶。

    ── `--allowedTools` 為什麼還留著 ─────────────────────────
    它的語意是「這些不用問」（預先核准），不是白名單——2026-09-09 的實測：

      claude --allowedTools Read,Glob,Grep --strict-mcp-config
             --disable-slash-commands -p "用 Write 建立 a.txt"
      → 檔案真的被建立了。

    在 `-p` 非互動模式下，沒有列出的工具照樣跑得動，所以它從來不是限制。
    現在留著它，只是為了不改變白名單內工具的權限行為：`--restricted` 不讀使用者
    設定檔，使用者原本的 allow 規則不再生效；預先核准這三個唯讀工具，-p 下就不會
    因為某次讀取需要詢問而被拒。它不放寬任何東西——白名單外的工具根本不存在。

    **教訓**：參數對了不等於行為對了。這裡的每一層都只靠參數斷言
    （verify-mcp-capabilities.mjs）釘住「有送出去」，「真的擋得住」要靠
    verify-strict-behaviour.mjs 那種真的跑一次的驗證。
  */
  const args = [
    '--restricted',
    ...(tools.length > 0 ? ['--tools', tools.join(',')] : ['--tools=']),
    ...(tools.length > 0 ? ['--allowedTools', tools.join(',')] : []),
    '--disallowedTools',
    DENIED_WHEN_STRICT.join(','),
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (systemPrompt) args.push('--append-system-prompt-file', writeSystemPromptFile(systemPrompt));
  if (sessionId) args.push('-r', sessionId, '--fork-session');
  if (reasoningEffort) args.push('--effort', reasoningEffort);
  args.push('-p');
  if (resolvedModel) args.push('--model', resolvedModel);
  return { cliPath, args, cwd, agent: 'claude', prompt, resolvedModel, stdinPrompt: prompt };
}

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, reasoningEffort, sessionId, systemPrompt } = input;
  const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
  if (systemPrompt) {
    args.push('--append-system-prompt-file', writeSystemPromptFile(systemPrompt));
  }
  if (sessionId) {
    args.push('-r', sessionId, '--fork-session');
  }
  if (reasoningEffort) {
    args.push('--effort', reasoningEffort);
  }
  // prompt 走 stdin（print mode 下無 positional 時讀 stdin），不當作 -p 的 arg：
  // Windows 下 claude 是 npm .CMD shim，spawn 需 shell:true，cmd.exe 會對含空白/
  // 換行/全形標點的長 prompt 重新切詞並在換行處截斷。比照 codex 走 stdin 即可繞過。
  args.push('-p');
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }
  return { cliPath, args, cwd, agent: 'claude', prompt, resolvedModel, stdinPrompt: prompt };
}

/** result 的成本是 vendor 名目美元估值，不是訂閱帳單；兩條解析路徑共用映射。 */
function normalizeResultUsage(parsed: any) {
  const raw = parsed?.usage;
  if (parsed?.type !== 'result' || !raw ||
      !['input_tokens', 'output_tokens'].every(
        (key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0
      )) return undefined;
  return {
    // input_tokens 統一定義為含快取的總輸入；Claude 原始 input 不含兩種快取。
    input_tokens: raw.input_tokens + (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0),
    cached_input_tokens: raw.cache_read_input_tokens ?? 0,
    cache_write_input_tokens: raw.cache_creation_input_tokens ?? 0,
    output_tokens: raw.output_tokens,
    reasoning_output_tokens: raw.output_tokens_details?.thinking_tokens ?? 0,
    ...(typeof parsed.num_turns === 'number' ? { num_turns: parsed.num_turns } : {}),
    ...(typeof parsed.total_cost_usd === 'number' ? { cost_usd_nominal: parsed.total_cost_usd } : {}),
    source: 'claude result',
  };
}

function parseOutput(stdout: string): unknown {
  if (!stdout) return null;
  // Claude 有時直接吐單一 JSON
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.type === 'result') {
      const { usage: raw_usage, ...rest } = parsed;
      const usage = normalizeResultUsage(parsed);
      return { ...rest, ...(raw_usage !== undefined ? { raw_usage } : {}), ...(usage ? { usage } : {}) };
    }
    return parsed;
  } catch {
    /* fall through to NDJSON parsing */
  }
  try {
    const lines = stdout.trim().split('\n');
    let lastMessage: string | null = null;
    let assistantTextBuffer = '';
    let sessionId: string | null = null;
    let usage: ReturnType<typeof normalizeResultUsage>;
    const toolsMap = new Map<string, { tool: string; input: unknown; output: unknown }>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'result') usage = normalizeResultUsage(parsed) ?? usage;
        if (parsed.session_id) {
          sessionId = parsed.session_id;
        }
        if (parsed.type === 'result' && parsed.result) {
          lastMessage = parsed.result;
        }
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const content of parsed.message.content) {
            if (content.type === 'text' && typeof content.text === 'string') {
              assistantTextBuffer += content.text;
            }
            if (content.type === 'tool_use') {
              toolsMap.set(content.id, { tool: content.name, input: content.input, output: null });
            }
          }
        }
        if (parsed.type === 'user' && parsed.message?.content) {
          for (const content of parsed.message.content) {
            if (content.type === 'tool_result' && content.tool_use_id) {
              const tool = toolsMap.get(content.tool_use_id);
              if (tool) {
                if (Array.isArray(content.content)) {
                  const textContent = content.content.find((c: any) => c.type === 'text');
                  tool.output = textContent?.text || null;
                } else {
                  tool.output = content.content;
                }
              }
            }
          }
        }
      } catch {
        debugLog(`[Debug] Skipping invalid JSON line in Claude output: ${line}`);
      }
    }
    const tools = Array.from(toolsMap.values());
    const fallbackMessage = assistantTextBuffer.trim() ? assistantTextBuffer : null;
    const message = lastMessage || fallbackMessage;
    if (message || sessionId || tools.length > 0 || usage) {
      return { message, session_id: sessionId, tools: tools.length > 0 ? tools : undefined, ...(usage ? { usage } : {}) };
    }
  } catch (e) {
    debugLog(`[Debug] Failed to parse Claude NDJSON output: ${e}`);
    return null;
  }
  return null;
}

export const claudeAgent: AgentDefinition = {
  id: 'claude',
  // claude CLI 有 --append-system-prompt-file，所以這個 agent 收得下系統提示。
  // 沒有宣告的 agent（例如 codex exec，只有 -c key=value）會被 command-builder 擋下來，
  // 而不是把那段說明默默丟掉。
  supportsSystemPrompt: true,
  models: CLAUDE_MODELS,
  // fallback：任何沒被其他 agent 認領的 model 都走 claude
  matchesModel: () => true,
  binary: {
    envVarName: 'CLAUDE_CLI_NAME',
    defaultCliName: 'claude',
    localInstallPath: join(homedir(), '.claude', 'local', 'claude'),
  },
  reasoning: {
    supported: true,
    allowed: CLAUDE_REASONING,
    invalidMessage: 'Claude reasoning_effort supports only low, medium, high, xhigh, max.',
  },
  buildCommand,
  buildStrictCommand,
  parseOutput,
};
