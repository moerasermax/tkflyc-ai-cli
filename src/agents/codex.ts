/**
 * Codex agent。prompt 透過 stdin（positional `-`）送入，避免 Windows
 * shell:true 下 cmd.exe 重新切詞。行為 1:1 還原 dist。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';
import { debugLog } from '../core/debug.js';

/**
 * codex 的候選 model 名稱，依 vendor 目錄的 `priority` 排序。
 *
 * ★ 2026-10-03 依 codex-cli 0.160.0 所用的 `~/.codex/models_cache.json` 對過。
 *   不寫死 `fetched_at`：那個欄位每隔幾分鐘就被重抓一次，寫到「分」只會自我作廢。
 *   同日讀了三次（01:01Z / 02:04Z / 02:13Z，中間一次是稽核者讀的），**10 筆內容
 *   完全相同**（slug、priority、visibility、effort 清單、upgrade 都一樣），所以
 *   下面講的是目錄內容而不是某一次快照。
 *   ⚠️ **這份快取是機器上所有 codex 執行檔共用的，最後跑的那個覆寫它。**
 *   PATH 上 npm 裝的 CLI 與 Codex 桌面版自帶的核心（各自版本不同）寫的是同一個檔，
 *   所以 `client_version` 不等於你要派工的那支 CLI 時，**你讀到的是另一支的視角**，
 *   而不只是「版本舊一號」。這不是理論：2026-10-03 同一天的多次讀取裡，
 *   0.159.0／0.160.0 寫入的視角都是 10 筆且內容一致，而另一次讀到 0.155.0 寫入的
 *   視角只有 9 筆、**沒有 gpt-6.1-sol**（那一次不是我自己讀到的，但 `client_version`
 *   與 `fetched_at` 在同日反覆變動已證實多個寫入者存在）。
 *   所以查這個檔之前先 `codex --version`，兩者不符就重派一個 trivial job 讓目標 CLI
 *   自己重抓，再讀。拿別支寫入的視角去改清單，等於照著一份不是你要用的目錄改。
 *   - 補 `gpt-6.1-sol`（priority 1，"Latest workhorse model for coding and
 *     everyday work"）。它不是旗艦——vendor 自己的推薦文案寫 "near-Astra
 *     performance at a lower cost"，所以最強仍是 `gpt-6-astra`
 *     （priority 2，"Frontier intelligence for the most demanding work"）。
 *   - 移除 `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` / `gpt-5.3-codex-spark`
 *     / `gpt-5.2`：這五個已經不在 vendor 目錄裡。**移除只是停止把它們當候選
 *     廣告出去，不等於擋下來**——`matchesModel` 是 `startsWith('gpt-')`，
 *     明確指定這些名稱仍然會被路由到 codex。2026-10-03 五顆各派一個 trivial
 *     job 實測：全部 exitCode 1，CLI 先印 `Model metadata for <name> not found.
 *     Defaulting to fallback metadata`，接著 API 回 HTTP 400
 *     `The '<name>' model is not supported when using Codex with a ChatGPT
 *     account.`——與 2026-09-05 的錯誤原文一字不差。也就是說「不在目錄」與
 *     「帳號層級擋下」是同一件事的兩面（這份目錄是依帳號給的），2026-09-11
 *     知識庫記的「舊歸因存疑」到此可以結案。
 *     要真的擋，得另建帶原因與證據日期的 tombstone，不可塞進 REMOVED_MODELS
 *     （`removedModelMessage()` 的文案固定指向 Kiro／Forge）。
 *   - 不收 `gpt-reserve` 與 `codex-auto-review`：vendor 標 `visibility: "hide"`，
 *     也就是**它自己就不對外列出**，所以我們的候選清單也不列。
 *     （`hide` 只證明不列出；這兩顆實際用途沒有實測，不要寫成「只供 CLI 內部使用」。）
 *   - `gpt-5.5` 留著，但 vendor 的 `upgrade` 欄位標明 2026-10-14T19:00Z 退役、
 *     建議改用 `gpt-6.1-sol`（見 catalog.ts 的 KNOWN_BAD_MODELS）。
 */
const CODEX_MODELS = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
] as const;

/**
 * codex 的 reasoning 級別。
 *
 * ★ 2026-09-05 依 codex-cli 0.151.0 的 `~/.codex/models_cache.json` 對照：
 *   gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra 提供 low…ultra 六級，gpt-5.6-luna
 *   到 max，gpt-5.5 / gpt-5.4-mini / gpt-5.3-codex-spark 仍只到 xhigh。
 *   2026-09-26 依 codex-cli 0.155.1 的同一份快取補：gpt-6-sol 到 ultra、gpt-6-luna
 *   到 max（聯集不變，所以這個 Set 不用動）。
 *   2026-10-03 依 codex-cli 0.160.0 所用的同一份快取補：gpt-6.1-sol 到 ultra、
 *   CLI 端預設 low（聯集仍不變）。同日移出清單的五個舊名稱裡，gpt-5.4-mini 與
 *   gpt-5.3-codex-spark 都曾是上面那行 xhigh 上限的依據，但 Set 收的是聯集、
 *   gpt-5.5 仍在清單裡也仍只到 xhigh，所以這個 Set 一樣不用動。
 *
 *   這裡收的是**聯集**，不按模型細分：這份清單是靜態後備值（見 types.ts 的
 *   ModelListSource），逐模型寫死只會多一份更容易過時的表。
 *
 *   ⚠️ 不要把「不支援的級別由 codex CLI 自己拒絕」寫回來——這句 2026-09-26 已被
 *   實測推翻兩次，但當時只改了 mcp.ts 的工具描述，漏了這段註解：
 *   gpt-5.5 + max 是**建完 thread 與 turn 之後**才收到 API HTTP 400（不是 CLI
 *   本地拒絕），而 gpt-6-luna + ultra（vendor 目錄說它只到 max）**exit 0、正常
 *   回答，完全不報錯**。所以 exit 0 不證明那個等級生效，要驗只能看行為。
 */
const CODEX_REASONING = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * 能力 → 這個 vendor 的嚴格限制。
 *
 * **給不出保證就丟例外**（fail-closed）。放寬是最糟的失敗方式：
 * 呼叫端以為有限制、畫面上寫著有限制，而程序其實全開。
 */
const CODEX_SAFE_CAPABILITIES = new Set(['fs/read', 'analysis/produce']);

function buildStrictCommand(
  input: BuildCommandInput,
  capabilities: readonly string[]
): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, reasoningEffort, sessionId } = input;
  for (const capability of capabilities) {
    if (!CODEX_SAFE_CAPABILITIES.has(capability)) {
      throw new Error(
        `codex 的嚴格模式無法保證能力「${capability}」——拒絕啟動（不放寬）。`
      );
    }
  }
  /*
    與 buildCommand 的差別：**沒有 --dangerously-bypass-approvals-and-sandbox**。
      -s read-only          模型產生的指令只能讀
      --ignore-user-config  不載使用者的全域設定
      --ephemeral           不留 session 殘骸
  */
  const args: string[] = sessionId ? ['exec', 'resume', sessionId] : ['exec'];
  if (reasoningEffort) args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
  if (resolvedModel) args.push('--model', resolvedModel);
  args.push(
    '--sandbox',
    'read-only',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '-'
  );
  return { cliPath, args, cwd, agent: 'codex', prompt, resolvedModel, stdinPrompt: prompt };
}

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, reasoningEffort, sessionId } = input;
  let args: string[];
  if (sessionId) {
    args = ['exec', 'resume', sessionId];
  } else {
    args = ['exec'];
  }
  if (reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
  }
  if (resolvedModel && resolvedModel !== 'codex') {
    args.push('--model', resolvedModel);
  }
  // prompt 走 stdin（positional `-`）：Windows 下 shell:true，Node 不會跳脫 args，
  // cmd.exe 會對含空白/換行/數字的 prompt 重新切詞。Codex 文件：用 `-` 從 stdin 讀。
  args.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', '-');
  return { cliPath, args, cwd, agent: 'codex', prompt, resolvedModel, stdinPrompt: prompt };
}

function parseOutput(stdout: string, stderr: string): unknown {
  // Codex 把 stdout 與 stderr 合併解析（1:1 dist）
  const combined = `${stdout || ''}\n${stderr || ''}`;
  if (!combined.trim()) return null;
  try {
    const lines = combined.trim().split('\n');
    let lastMessage: string | null = null;
    let tokenCount: unknown = null;
    let usage: { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; source: string; incomplete?: boolean } | undefined;
    let incompleteUsage = false;
    let threadId: string | null = null;
    const tools: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // 每個 turn 都回報自己的用量；只累加量到的值，缺事件不代表零用量。
        if (parsed.type === 'turn.completed') {
          if (parsed.usage && ['input_tokens', 'output_tokens'].every(
              (key) => typeof parsed.usage[key] === 'number' && Number.isFinite(parsed.usage[key]) && parsed.usage[key] >= 0
            )) {
            // input_tokens 統一定義為含快取的總輸入；Codex 原始計數已包含快取。
            usage ??= { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, source: 'codex turn.completed' };
            for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'] as const) {
              const value = parsed.usage[key];
              if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[key] += value;
            }
          } else {
            incompleteUsage = true;
          }
        }
        if (parsed.type === 'thread.started' && parsed.thread_id) {
          threadId = parsed.thread_id;
        } else if (parsed.item?.type === 'agent_message') {
          lastMessage = parsed.item.text;
        } else if (parsed.msg?.type === 'agent_message') {
          lastMessage = parsed.msg.message;
        } else if (parsed.item?.type === 'reasoning') {
          /* skip reasoning */
        } else if (parsed.msg?.type === 'token_count') {
          tokenCount = parsed.msg;
        } else if (parsed.type === 'item.completed' && parsed.item?.type === 'mcp_tool_call') {
          tools.push({
            server: parsed.item.server,
            tool: parsed.item.tool,
            input: parsed.item.arguments,
            output: parsed.item.result,
          });
        } else if (parsed.type === 'item.completed' && parsed.item?.type === 'command_execution') {
          tools.push({
            tool: 'command_execution',
            input: { command: parsed.item.command },
            output: parsed.item.aggregated_output,
            exit_code: parsed.item.exit_code,
          });
        } else if (parsed.type === 'item.completed' && parsed.item?.type === 'file_change') {
          /*
            codex 改檔走 `file_change`，不是 shell。2026-09-08 端到端實測抓到：
            只收 command_execution 與 mcp_tool_call 的話，codex 子 agent 改了程式碼
            也完全看不到，驗證狀態會永遠停在 not_applicable——第 1 層等於對 codex 失效。

            一筆 file_change 可帶多個 changes，這裡展開成每檔一筆，讓判定端
            （core/verification.ts）沿用既有的 file_path 形狀，不必為 codex 特例。
            kind 有 update / add / delete，刪掉程式碼一樣需要驗證，所以都收。
          */
          for (const change of parsed.item.changes ?? []) {
            tools.push({
              tool: 'file_change',
              input: { file_path: change?.path, kind: change?.kind },
              output: null,
            });
          }
        }
      } catch {
        debugLog(`[Debug] Skipping invalid JSON line: ${line}`);
      }
    }
    if (usage && incompleteUsage) usage.incomplete = true;
    if (lastMessage || tokenCount || threadId || tools.length > 0 || usage) {
      return {
        message: lastMessage,
        token_count: tokenCount,
        ...(usage ? { usage } : {}),
        session_id: threadId,
        tools: tools.length > 0 ? tools : undefined,
      };
    }
  } catch (e) {
    debugLog(`[Debug] Failed to parse Codex NDJSON output: ${e}`);
  }
  return null;
}

export const codexAgent: AgentDefinition = {
  id: 'codex',
  models: CODEX_MODELS,
  matchesModel: (model) => model === 'codex' || model.startsWith('gpt-'),
  binary: {
    envVarName: 'CODEX_CLI_NAME',
    defaultCliName: 'codex',
    localInstallPath: join(homedir(), '.codex', 'local', 'codex'),
  },
  reasoning: {
    supported: true,
    allowed: CODEX_REASONING,
    invalidMessage: 'Codex reasoning_effort supports only low, medium, high, xhigh, max, ultra.',
  },
  buildCommand,
  buildStrictCommand,
  parseOutput,
};
