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
 * 能力 → 這個 vendor 的嚴格限制。
 *
 * **給不出保證就丟例外**（fail-closed）。放寬是最糟的失敗方式：
 * 呼叫端以為有限制、畫面上寫著有限制，而程序其實全開。
 */
const CLAUDE_TOOLS_BY_CAPABILITY: Record<string, readonly string[]> = {
  'fs/read': ['Read', 'Glob', 'Grep'],
  'analysis/produce': [], // 產出走 stdout，不需要工具
};

/**
 * 嚴格模式一律拒絕的工具。**這是唯一真的擋得住的那一半**（見 buildStrictCommand 的註解）。
 *
 * 列舉式清單有一個明顯的弱點：新工具出現時它會過期，而過期的樣子是「悄悄放行」。
 * 所以真正的守門不是這份清單完不完整，是
 * `verify-mcp-capabilities.mjs` 裡那條**真的叫模型寫檔、再檢查檔案在不在**的斷言——
 * 清單漏了什麼，那條會紅。清單是手段，行為驗證才是保證。
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
  /*
    與 buildCommand 的差別：**沒有 --dangerously-skip-permissions**。

    ⚠️ **`--allowedTools` 不是白名單。** 這一行原本的註解寫著「是白名單」，
    而 2026-09-09 的實測推翻了它：

      claude --allowedTools Read,Glob,Grep --strict-mcp-config
             --disable-slash-commands -p "用 Write 建立 a.txt"
      → 檔案真的被建立了。

    `--allowedTools` 的語意是「**這些不用問**」（預先核准），不是「只能用這些」。
    在 `-p` 非互動模式下，沒有列出的工具照樣跑得動。同一輪也試過
    `--permission-prompts none`——**一樣擋不住**。

    真正擋得住的只有 `--disallowedTools`（同一輪實測：加了就寫不進去，
    而且一般問答不受影響）。`--permission-mode plan` 也擋得住，但它會把模型
    推進「規劃」心態、不直接回答問題，不適合「我只想問一句話」的唯讀回合。

    **這個缺陷從 exec 的嚴格模式上線那天就在**：畫面說唯讀、程序其實能寫檔。
    它沒有被發現，是因為既有的斷言只驗「參數有沒有送出去」，沒有驗
    「它真的擋得住」——參數對了不等於行為對了。verify-mcp-capabilities.mjs
    現在有一條**真的叫模型寫檔、再檢查檔案在不在**的行為斷言。
  */
  const args = [
    '--allowedTools',
    [...tools].join(','),
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
    input_tokens: raw.input_tokens,
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
      const { usage: _rawUsage, ...rest } = parsed;
      const usage = normalizeResultUsage(parsed);
      return { ...rest, ...(usage ? { usage } : {}) };
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
        if (parsed.type === 'result') usage = normalizeResultUsage(parsed);
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
