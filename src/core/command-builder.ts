/**
 * 指令組裝協調器。對應 dist/cli-builder.js 的 buildCliCommand。
 *
 * 流程：
 *   驗證輸入 → 取得 prompt → 解析 model alias → 選 agent → reasoning 預設值與驗證
 *   → 呼叫該 agent.buildCommand()
 *
 * direct-api 的 <provider>-<model> 在這裡專門解析（先於一般 routing）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute } from 'node:path';
import type { AgentDefinition, AgentId, BuiltCommand } from '../agents/types.js';
import { selectAgentForModel, getAgent } from '../agents/registry.js';
import { resolveDirectApiModel } from '../agents/direct-api.js';
import { resolveModelAlias, isRemovedModel, removedModelMessage } from '../models/catalog.js';
import { acceptsConfiguredEffort, resolveReasoningEffort } from './reasoning.js';
import {
  loadUserConfigSnapshot,
  resolveConfiguredReasoningEffortWithSource,
  type UserConfig,
} from './user-config.js';
import { debugLog } from './debug.js';

export interface BuildCliCommandOptions {
  prompt?: string;
  prompt_file?: string;
  workFolder: string;
  model?: string;
  session_id?: string;
  reasoning_effort?: string;
  cliPaths: Partial<Record<AgentId, string>>;
  /**
   * 只給這些能力（例如 `['fs/read', 'analysis/produce']`）。
   *
   * **給了就走 agent 的 `buildStrictCommand`，沒給才是一般模式。**
   * 一般模式帶的是 `--dangerously-skip-permissions`（claude）與
   * `--dangerously-bypass-approvals-and-sandbox`（codex）——那是刻意的，
   * 因為呼叫端沒有表達任何限制。但呼叫端**一旦表達了**，就不能退回那條路：
   * agent 沒有 `buildStrictCommand` 就丟錯，不退回一般模式（fail-closed）。
   *
   * 空陣列與 `undefined` 是**不同**的意思：空陣列是「什麼能力都不給」（仍走 strict），
   * `undefined` 才是「沒有意見」。把兩者折成同一件事，等於讓一個要求限制的呼叫端
   * 拿到全開權限而不自知——那是最糟的一種說謊，因為它看起來成功了。
   */
  capabilities?: readonly string[];

  /**
   * 這一回合的系統提示（追加在 vendor 預設之後）。
   *
   * 為什麼需要它：**操作方的框架不該擠在使用者訊息的位置**。
   * 派工時常要交代「你是稽核者，只回報不改碼」「以下逐筆重播是工作台產生的，不是使用者說的」
   * 這類關於「這場對話怎麼運作」的話。寫進 prompt 內文，它就出現在使用者自己講話的位置，
   * 長相是提示注入的標準形狀——對齊良好的模型會**合理地**拒絕照做。
   * 系統提示是操作方自己的通道，那裡的文字天生就不是使用者輸入。
   *
   * ⚠ 這個參數當初是為了 TKFLYC Launcher 的續接對帳協定加的，而**那個動機事後證明不成立**：
   *   改用系統提示之後文字逐字送達，模型照樣拒絕、理由一字未改；真正的根因是
   *   「模型自己先前的拒絕訊息被重播回去」（該專案 ADR-093，後來另外修的）。
   *   保留它的理由因此不是「某個呼叫端需要」，而是**有系統提示通道的 agent 本來就該讓呼叫端用得到**。
   *   下一個讀到這裡的人：不要照著「Launcher 需要」去推論這個參數該怎麼演進。
   *
   * ★ fail-closed：給了這個欄位，而該 agent 沒有系統提示通道，就**拒絕啟動**。
   *   靜默忽略會讓呼叫端以為那段框架送到了、實際上模型什麼都沒看到——
   *   那比不支援更糟，因為它看起來成功了。
   *   目前只有 claude 有這條通道（`--append-system-prompt-file`）；
   *   codex exec 只有 `-c key=value`、agy 的 23 個旗標裡沒有對應項（2026-09-10 查 --help）。
   *   這是 vendor 的現況，不是我們挑呼叫端。
   */
  system_prompt?: string;
}

interface ModelSelection {
  agent: AgentDefinition;
  resolvedModel: string;
  providerName?: string;
  providerModel?: string;
}

function resolveModelSelection(rawModel: string, config: UserConfig): ModelSelection {
  if (rawModel) {
    const directApiModel = resolveDirectApiModel(rawModel);
    if (directApiModel) {
      return {
        agent: getAgent('direct-api'),
        resolvedModel: directApiModel.modelName,
        providerName: directApiModel.providerName,
        providerModel: directApiModel.modelName,
      };
    }
  }
  const aliasedModel = resolveModelAlias(rawModel, config);
  const directApiAliasModel = aliasedModel !== rawModel ? resolveDirectApiModel(aliasedModel) : null;
  if (directApiAliasModel) {
    return {
      agent: getAgent('direct-api'),
      resolvedModel: directApiAliasModel.modelName,
      providerName: directApiAliasModel.providerName,
      providerModel: directApiAliasModel.modelName,
    };
  }
  // 已移除的 agent 名稱要在這裡擋下來。放在 alias 解析「之後」，這樣連 kiro-ultra
  // 這種 alias 也會被抓到；放在 selectAgentForModel 「之前」，因為 claude 的
  // matchesModel 是 catch-all，晚一步就會被它靜默接走。
  if (isRemovedModel(aliasedModel) || isRemovedModel(rawModel)) {
    throw new Error(removedModelMessage(isRemovedModel(rawModel) ? rawModel : aliasedModel));
  }
  return {
    agent: selectAgentForModel(aliasedModel),
    resolvedModel: aliasedModel,
  };
}

/**
 * 呼叫端未指定 reasoning_effort 時，套用設定檔／內建預設。
 * 與明確指定不同：這裡任何「該 agent 不支援」的情況都靜默略過，不丟錯。
 */
function resolveDefaultReasoningEffort(
  agent: AgentDefinition,
  rawModel: string,
  config: UserConfig
): ReturnType<typeof resolveConfiguredReasoningEffortWithSource> {
  const resolved = resolveConfiguredReasoningEffortWithSource(rawModel, config);
  const configured = resolved.effort;
  if (!configured) return resolved;
  // 規則本體在 reasoning.ts 的 acceptsConfiguredEffort：models payload 回報時用的是同一份。
  if (!acceptsConfiguredEffort(agent.reasoning, configured)) {
    debugLog(
      `[Config] Skipping default reasoning "${configured}": ${agent.id} does not support it or it is outside its allowed set; using its CLI default`
    );
    return { ...resolved, effort: undefined };
  }
  return resolved;
}

export function buildCliCommand(options: BuildCliCommandOptions): BuiltCommand & { warnings?: string[] } {
  if (!options.workFolder || typeof options.workFolder !== 'string') {
    throw new Error('Missing or invalid required parameter: workFolder');
  }
  const hasPrompt =
    !!options.prompt && typeof options.prompt === 'string' && options.prompt.trim() !== '';
  const hasPromptFile =
    !!options.prompt_file &&
    typeof options.prompt_file === 'string' &&
    options.prompt_file.trim() !== '';
  if (!hasPrompt && !hasPromptFile) {
    throw new Error('Either prompt or prompt_file must be provided');
  }
  if (hasPrompt && hasPromptFile) {
    throw new Error('Cannot specify both prompt and prompt_file. Please use only one.');
  }

  let prompt: string;
  if (hasPrompt) {
    prompt = options.prompt as string;
  } else {
    const promptFilePath = isAbsolute(options.prompt_file as string)
      ? (options.prompt_file as string)
      : pathResolve(options.workFolder, options.prompt_file as string);
    if (!existsSync(promptFilePath)) {
      throw new Error(`Prompt file does not exist: ${promptFilePath}`);
    }
    try {
      prompt = readFileSync(promptFilePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read prompt file: ${(error as Error).message}`);
    }
  }

  const cwd = pathResolve(options.workFolder);
  if (!existsSync(cwd)) {
    throw new Error(`Working folder does not exist: ${options.workFolder}`);
  }

  const rawModel = options.model || '';
  // 這一次組指令從頭到尾只讀一次設定檔：alias 與 reasoning 必須來自同一份設定，
  // 否則中途被改動就會組出「A 版 alias + B 版 reasoning」這種兩邊都不對的指令。
  const userConfig = loadUserConfigSnapshot().config;
  const { agent, resolvedModel, providerName, providerModel } = resolveModelSelection(
    rawModel,
    userConfig
  );

  // reasoning：呼叫端明確指定 → 照舊驗證（不合法就丟錯）。
  // 未指定 → 由持久化設定 / 內建 ultra 預設補上，但只在該 agent 真的吃得下時才套用；
  // 設定檔是「全域偏好」而非該次呼叫的明確意圖，不該讓 agy 這種不支援 reasoning
  // 的 agent 因此整個 run 失敗。
  const explicitEffort = options.reasoning_effort;
  let reasoningEffort: string;
  let effortSource: 'explicit' | 'alias' | 'config';
  if (typeof explicitEffort === 'string' && explicitEffort.trim() !== '') {
    reasoningEffort = resolveReasoningEffort(agent.reasoning, explicitEffort);
    effortSource = 'explicit';
  } else {
    const resolved = resolveDefaultReasoningEffort(agent, rawModel, userConfig);
    reasoningEffort = resolved.effort ?? '';
    // 對外維持 explicit/alias/config；詳細來源由選值函式直接回傳。
    effortSource = resolved.source === 'builtin-alias' ? 'alias' : 'config';
  }
  const warningFields = ['xhigh', 'max', 'ultra'].includes(reasoningEffort)
    ? { warnings: [`High-cost effort "${reasoningEffort}" (source: ${effortSource}). Use medium for everyday dispatch; xhigh/max/ultra should be used only when explicitly requested by the user.`] }
    : {};

  const input = {
    cliPath: options.cliPaths[agent.id] || '',
    cwd,
    prompt,
    resolvedModel,
    rawModel,
    reasoningEffort,
    sessionId:
      options.session_id && typeof options.session_id === 'string'
        ? options.session_id
        : undefined,
    providerName,
    providerModel,
    systemPrompt:
      typeof options.system_prompt === 'string' && options.system_prompt.trim() !== ''
        ? options.system_prompt
        : undefined,
  };

  /*
    ★ fail-closed，與上面 capabilities 同一個形狀：呼叫端要求把協定放進系統提示，
    而這個 agent 根本沒有那條通道時，不能假裝有。
    檢查放在 buildCommand 之前，理由要是「這個 agent 沒有系統提示通道」。
  */
  if (input.systemPrompt !== undefined && agent.supportsSystemPrompt !== true) {
    throw new Error(
      `agent「${agent.id}」沒有系統提示通道（supportsSystemPrompt 不為 true），拒絕啟動。` +
        '靜默忽略會讓呼叫端以為那段說明送到了，而模型其實什麼都沒看到。'
    );
  }

  /*
    ★ fail-closed。呼叫端給了 capabilities，就不能退回帶 `--dangerously-*` 的一般模式。

    這段邏輯在 `exec.ts` 已經有一份（planExec）。搬到這裡是為了讓它成為**唯一**的一份：
    MCP `run` 也要能表達「這一回合不要動我的檔案」，而權限政策抄成兩份的下場，
    是其中一份哪天漏改而沒有人發現——兩邊看起來都還跑得動。

    檢查刻意放在呼叫 buildCommand **之前**：拒絕的理由要是「這個 agent 沒有嚴格模式」，
    而不是它在組指令時碰巧先炸掉的某個別的原因。
  */
  if (options.capabilities !== undefined) {
    const strict = agent.buildStrictCommand;
    if (typeof strict !== 'function') {
      throw new Error(
        `agent「${agent.id}」沒有嚴格模式（buildStrictCommand），拒絕啟動。` +
          '退回一般模式會帶著權限旁路執行，而呼叫端以為有限制——不做這件事。'
      );
    }
    return { ...strict(input, options.capabilities), ...warningFields };
  }

  return { ...agent.buildCommand(input), ...warningFields };
}
