/**
 * Model 目錄與 alias 表。
 * 5.0.0 起只剩 claude / codex / antigravity / direct-api（kiro 與 forge 已移除）。
 *
 * 各 agent 的 model 清單其實也定義在各自的 agents/<name>.ts，
 * 這裡彙整出對外的 models payload 與描述字串。
 */

import { listAgents, getAgent, selectAgentForModel } from '../agents/registry.js';
import { describeConfiguredProviders, resolveDirectApiModel } from '../agents/direct-api.js';
import { buildCatalogV2 } from './catalog-v2.js';
import type { AgentId } from '../agents/types.js';
import { acceptsConfiguredEffort } from '../core/reasoning.js';
import { consumeNotice } from '../core/updater.js';
import { getServerIdentity } from '../core/identity.js';
import {
  describeUserConfig,
  loadUserConfigSnapshot,
  resolveConfiguredAliasModel,
  resolveConfiguredReasoningEffort,
  type ConfigSnapshot,
  type UserConfig,
} from '../core/user-config.js';

export interface ModelAliasDetail {
  name: string;
  resolvesTo: string;
  agent: AgentId;
  defaultReasoningEffort?: string;
}

/** alias 的實際生效狀態：可能被 config.json 的 aliasModel 重新指向。 */
export interface EffectiveModelAliasDetail extends ModelAliasDetail {
  /** 這個 alias 目前是走內建表還是使用者設定。 */
  source: 'builtin' | 'config';
  /** source 為 config 時，內建表原本指向的 model。 */
  builtinResolvesTo?: string;
}

/** alias → 實際 model。1:1 還原 dist。 */
export const MODEL_ALIASES: Record<string, string> = {
  'claude-ultra': 'opus',
  'codex-ultra': 'gpt-6-astra',
  /*
    codex-ultracode：和 codex-ultra 同一顆旗艦，差別只在 effort 到 `ultra`。

    為什麼要另立一個名稱而不是把 codex-ultra 改成 ultra：`ultra` 是 codex 的
    **effort 級別名**（low…max 之上還有一級 ultra），不是 model。把 effort 詞當成
    alias 名稱用，已經讓 codex-ultra 這個名字名實不符——它叫 ultra、送的卻是 max。
    改它的語意是破壞性變更，所以這裡用純加法補上真正的最強組合：
    gpt-6-astra + ultra 在此之前**沒有任何 alias**，要用得每次手動帶 reasoning_effort。

    claude 側刻意不加對應的名稱：claude 的 effort 只到 max（沒有 ultra），
    claude-ultracode 會和 claude-ultra 完全同義——兩個名字做同一件事是新的混淆源。
  */
  'codex-ultracode': 'gpt-6-astra',
  'agy-ultra': 'Gemini 3.1 Pro (High)',
  'antigravity-ultra': 'Gemini 3.1 Pro (High)',
};

/**
 * 5.0.0 移除的 agent 所帶走的 model 名稱。
 *
 * 為什麼要留這份清單而不是直接讓它們變成「未知 model」：claude 的 matchesModel 是
 * catch-all 永遠回 true，不特別攔的話這些名稱會**靜默跑去 claude** —— 呼叫端以為在跑
 * Kiro，實際上拿到的是 Claude 的回答。這個 repo 已經為同類的靜默路由吃過虧，
 * 所以寧可多一份清單，也要讓錯誤明確。
 *
 * 注意：這裡只擋「裸名稱」。`forge-<model>` 這種 provider-prefixed 形式仍然有效，
 * 因為 forge 也可以是 providers.json 裡的 provider key，且那條路在
 * command-builder 的 resolveDirectApiModel() 就先被解析走了。
 */
export const REMOVED_MODELS: Record<string, string> = {
  kiro: 'Kiro',
  'kiro-default': 'Kiro',
  'kiro-ultra': 'Kiro',
  'kiro-deepseek-3.2': 'Kiro',
  'kiro-minimax-m2.5': 'Kiro',
  'kiro-minimax-m2.1': 'Kiro',
  'kiro-glm-5': 'Kiro',
  'kiro-qwen3-coder-next': 'Kiro',
  forge: 'Forge',
};

/** 這個 model 名稱是否屬於已移除的 agent。用 hasOwnProperty 避免打到 Object.prototype。 */
export function isRemovedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(REMOVED_MODELS, model);
}

/** 已移除 model 的統一錯誤訊息。 */
export function removedModelMessage(model: string): string {
  const agent = REMOVED_MODELS[model];
  return (
    `Model "${model}" was removed in 5.0.0 along with the ${agent} agent ` +
    `(Kiro: out of quota / not logged in; Forge: CLI never installed). ` +
    `Use claude, codex, or antigravity instead, or connect any third-party ` +
    `OpenAI-compatible API yourself via direct-api ("<provider>-<model>", ` +
    `configured in ~/.local/share/ai-cli/providers.json).`
  );
}

/** alias 詳細資訊的內建定義。實際生效值請用 getEffectiveAliasDetails()。 */
/**
 * 依情境該派哪一顆——**這是建議，不是規則**，呼叫端可以有自己的判斷。
 *
 * 為什麼放進工具回傳而不是只寫在 README：呼叫端是 AI，它讀的是工具回傳。
 * 一份只存在文件裡的建議表，等於只有人看得到；而真正在挑模型的是它。
 *
 * 2026-09-09 加上的直接理由：NVIDIA 免費 API 接上之後，「量大但不難」的工作
 * 有了不吃訂閱額度的選項——但那要指名才會用到。沒有這張表，預設仍然會拿
 * 訂閱額度去做不需要它的事。
 *
 * `note` 一律寫「為什麼」而不只是「用哪個」：沒有理由的建議會在情況變了之後
 * 被照抄，而讀的人不知道它已經不成立。
 */
export const DISPATCH_GUIDANCE: ReadonlyArray<{
  situation: string;
  model: string;
  reasoningEffort?: string;
  note: string;
}> = [
  {
    situation: '合併零碎小任務',
    model: 'codex / claude',
    note: '2026-10-06 實測最小 codex job input 約 2 萬 tokens、最小 claude job context 約 3 萬 tokens；每個 job 有固定開銷，零碎小任務應合併成一個 job。這是當時環境的觀察，不是所有 job 的保證下限。',
  },
  {
    situation: '避免重複派工',
    model: '所有模型',
    note: '不要對同一件事重複派兩個 job，除非是刻意的交叉驗證；重複派工會再次支付 context 與啟動開銷。',
  },
  {
    situation: '減少輪詢成本',
    model: '所有模型',
    note: '呼叫端每次 wait/peek 都是自己 session 的一個回合，大 context 的 session 輪詢很貴；用 wait 且 timeout 接近 90 秒，少用 peek，不要用 5~10 秒的短輪詢。',
  },
  {
    situation: '記錄每個 job 用量',
    model: 'codex / claude',
    note: 'job 結束後讀 agentOutput.usage 記錄成本；缺欄位代表 unknown，不是 0。Claude cost_usd_nominal 是名目成本，不是訂閱帳單。',
  },
  {
    situation: '日常派工',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
    note:
      '這張表是維護者的派工政策，不是從 vendor 目錄推出來的。日常用 medium；'
      + 'high 留給跨模組、架構、高風險修改、逆向歧義，或一次 medium 明顯不足的情況。'
      + '不要一開始就用 astra——它是旗艦也最貴（「最貴」同樣來自政策，vendor 目錄沒有價格欄位）。'
      + '2026-10-03 從 gpt-5.6-sol 換過來：vendor 已把 gpt-5.6-sol 標成 '
      + '"Older generation workhorse model"，現行的是 gpt-6.1-sol（priority 1、'
      + '"Latest workhorse model for coding and everyday work"），而且 vendor 自己的文案說它 '
      + '"near-Astra performance at a lower cost"。'
      + '⚠️ gpt-6.1-sol 的 CLI 端預設 effort 是 low（不是 medium），所以 effort 一定要明確傳，'
      + '省略不等於拿到這裡建議的強度。',
  },
  {
    situation: '同一個問題卡超過 5 次',
    model: 'gpt-6-astra',
    reasoningEffort: 'high',
    note: '升級時要寫明「第幾次、前幾次卡在哪」，不要靜默換模型。',
  },
  {
    situation: '稽核／第二意見',
    model: 'claude-ultra 或 gemini-3.1-pro-high',
    note:
      '要換一家的視角才有意義；同一家的模型會犯同一種錯。結果要逐條驗證，不要照單全收。'
      + '⚠️ gemini-3.1-pro-high 的交付率不穩：2026-09-09 通讀長文件撞過 agy 的 5 分鐘 print timeout，'
      + '2026-10-03 派同一份稽核，430 秒後 stdout 累計只有 177 bytes（就是那一行 agy warning），'
      + '之後 ai-cli MCP 連線中斷、結果再也取不回來。'
      + '要兩路稽核就別把它當其中唯一一路，或先用一個小 job 確認它會回話。',
  },
  {
    situation: '大量低價值工作（分類、摘要、格式轉換、批次改寫）',
    model: 'nv-openai/gpt-oss-20b',
    note: '走 NVIDIA 免費 API，不吃訂閱額度。實測 10/10、最快（5.1s）。不吃 reasoning_effort。',
  },
  {
    situation: '長脈絡',
    model: 'nv-nvidia/nemotron-3.5-lightning-30b-a3b',
    note: '1M context、免費、實測 10/10。設定檔已配 reasoning_effort=none（28.0s → 6.1s）。',
  },
  {
    situation: '較難的 coding／agentic，但不想動用訂閱額度',
    model: 'nv-meta/muse-glimmer-30b',
    note: '實測 10/10。hosted 預設 max_tokens 只有 2048 且與推理共用，設定檔已改成 16384。',
  },
];

/**
 * 已知不要派的，以及為什麼。
 *
 * 這一份跟 catalog 的 `routable: false` 不同：那個講的是「框架路由不到」，
 * 這個講的是「路由得到但實測不能用」。清單列得出來 ≠ 能用——2026-09-09
 * 在 NVIDIA 那批上學到的，`/v1/models` 回的 id 甚至可能是打不通的舊寫法。
 */
export const KNOWN_BAD_MODELS: ReadonlyArray<{ model: string; reason: string }> = [
  {
    model: 'nv-moonshotai/kimi-k3',
    reason: '429 額度爭用，實測 3/10；連 8 次指數退避都打不穿。不是尖峰抖動，重試救不了。',
  },
  {
    model: 'nv-nvidia/nemotron-3-nano-30b-a3b',
    reason: '410 Gone，已終止服務。/v1/models 仍會列出一個打不通的舊 id（nemotron-nano-3-…）。',
  },
  {
    model: 'nv-google/gemma-4-31b-it',
    reason: '工具迴圈要 91 秒。純文字（prompt 開頭加 [no-tools]）14 秒還可以。',
  },
  {
    model: 'gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.3-codex-spark / gpt-5.2',
    reason:
      '2026-10-03 已不在 vendor 目錄（~/.codex/models_cache.json），同日也從 codex 候選清單移除。'
      + '同日五顆各實測一個 trivial job：全部 exitCode 1，CLI 先印 Model metadata for <name> '
      + 'not found（退回 fallback metadata），接著 API 回 HTTP 400 '
      + "The '<name>' model is not supported when using Codex with a ChatGPT account"
      + '——與 2026-09-05 的錯誤原文相同，所以「帳號層級擋下」這個歸因仍然成立，'
      + '「不在目錄」只是同一件事的另一面（目錄是依帳號給的）。'
      + "移出清單不等於擋下：matchesModel 是 startsWith('gpt-')，明確指定仍會送到 codex 然後收到上面那個 400。",
  },
  {
    model: 'gpt-5.5',
    reason:
      'vendor 目錄的 upgrade 欄位標明 2026-10-14T19:00Z 退役，建議改用 gpt-6.1-sol；'
      + '退役前仍可派，但 effort 只到 xhigh（傳 max 會收到 API HTTP 400——沿用 2026-09-09 的實測，本次未重測）。',
  },
];


/*
  這份目錄的語意——**兩個方向都不是保證**。

  `knownBadModels` 已經在處理「清單有但不能用」那一半；這裡補的是另一半，
  也是實際踩過的那一半：2026-09-11 有呼叫端因為 `fable` 不在 claude 陣列裡
  就判定「不支援」，繞去找替代方案——而正確答案是直接派就好。

  誤判的根源不是少一筆，是**清單的呈現方式看起來像權威來源**，而它不是。
  少一筆可以補；「讀的人以為它是全集」要靠工具自己講出來才會停。
*/
export const MODEL_LIST_CAVEAT = {
  notAnAllowlist:
    '頂層 claude / codex / antigravity / direct-api 四個陣列是候選建議，不是可派工模型的全集。'
    + 'claude agent 是整個 routing 的 fallback（matchesModel 永遠回 true）：一個名稱會先經過 '
    + 'direct-api 前綴解析、alias 展開、已移除模型（REMOVED_MODELS）攔截，走完這三關仍沒被'
    + '其他 agent 認領的，就原樣交給 claude CLI 的 --model——只要 vendor CLI 認得那個名字'
    + '就跑得起來，清單有沒有列它無關。查不到某個名稱時，先直接派派看，不要當成「不支援」'
    + '（已移除的 kiro / forge 例外，那幾個會明確報錯，不是靜默落到 claude）。'
    + '⚠️ set_config 設定 alias target 走的是另一條路 isKnownModelTarget()，但它**不是純白名單**：'
    + '清單命中算，而「非 claude 的 agent 的 pattern 命中」也算。所以任何 gpt-* 即使不在清單裡'
    + '也設得成 alias；真正被擋的是「只靠 claude catch-all 才跑得起來」的名稱'
    + '（例如 claude-sonnet-4-6）、alias 名稱本身，以及已移除模型。'
    + '所以兩個介面的差別不是「整體語意相反」：未知名稱的差異集中在 claude catch-all 那一段，'
    + '而 alias 名稱本身是另一個獨立差異——run 會展開 alias，isKnownModelTarget() 卻一律拒絕，'
    + '所以連 codex-ultra 這種非 claude 的 alias 也不能當 alias target（避免只解析一層造成'
    + '名稱被原樣送進 CLI）。',
  notAGuarantee:
    '反方向同樣不成立：列在清單裡不代表此刻能用。vendor 會下架模型，帳號層級也可能擋下。'
    + '已知的例子見 knownBadModels，但那份清單同樣是人工維護的，不會自動跟上。',
  authority:
    '要確定某個名稱現在能不能用，權威是 vendor CLI 自己（claude --help、~/.codex/models_cache.json、'
    + 'agy models），不是這份 payload。四個陣列的新鮮度並不一致：claude 與 codex 是原始碼裡的'
    + '手動清單，vendor 出新模型不會自動進來（fable 就是這樣漏掉的）；antigravity 則會把實查到'
    + '且可路由的模型併進來，所以它跟得上 agy 的新模型；direct-api 那幾筆是前綴佔位字串，'
    + '本機實際設了哪些 provider 要看 directApiProviders。逐筆的出處看 catalogV2 的 source 欄位'
    + '（vendor-cli＝問過 vendor、builtin-fallback＝原始碼靜態值）。',
} as const;

export const MODEL_ALIAS_DETAILS: ModelAliasDetail[] = [
  { name: 'claude-ultra', resolvesTo: 'opus', agent: 'claude', defaultReasoningEffort: 'max' },
  { name: 'codex-ultra', resolvesTo: 'gpt-6-astra', agent: 'codex', defaultReasoningEffort: 'max' },
  // ⚠️ 這裡的 defaultReasoningEffort 只進 models payload 顯示；真正決定送出值的是
  //    user-config.ts 的 BUILTIN_ALIAS_REASONING。兩份必須一致，
  //    verify-alias-config.mjs 有一條斷言在守這件事（兩份寫死的表最容易悄悄漂移）。
  { name: 'codex-ultracode', resolvesTo: 'gpt-6-astra', agent: 'codex', defaultReasoningEffort: 'ultra' },
  { name: 'agy-ultra', resolvesTo: 'Gemini 3.1 Pro (High)', agent: 'antigravity' },
  { name: 'antigravity-ultra', resolvesTo: 'Gemini 3.1 Pro (High)', agent: 'antigravity' },
];

/** direct-api 動態 model 後端提示。 */
export const DIRECT_API_DYNAMIC_BACKEND = {
  explicitPrefixes: {
    or: 'openrouter',
    ds: 'dashscope',
  },
  explicitPattern: '<provider>-<model>',
  providersConfig: '~/.local/share/ai-cli/providers.json',
  modelsAreDynamic: true,
} as const;

/**
 * alias → 實際 model。優先序：config.json 的 aliasModel → 內建 MODEL_ALIASES → 原樣回傳。
 *
 * 這個函式是在每次 run 組指令時才呼叫（見 core/command-builder.ts），
 * 而 loadUserConfig() 每次都重讀設定檔，所以改設定檔後不必重啟 MCP server。
 */
export function isBuiltinAlias(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name);
}

export function resolveModelAlias(model: string, config?: UserConfig): string {
  const configured = resolveConfiguredAliasModel(model, config ?? loadUserConfigSnapshot().config);
  if (configured) return configured;
  // 必須用 hasOwnProperty：'constructor' / 'toString' 這類 prototype 上的 key
  // 用 MODEL_ALIASES[model] 取會拿到函式而不是 undefined，resolvedModel 就不是字串了。
  return isBuiltinAlias(model) ? MODEL_ALIASES[model] : model;
}

/**
 * 決定某個（已解析 alias 後的）model 由哪個 agent 負責。
 * 與 command-builder.resolveModelSelection 的路由順序一致：direct-api 的
 * provider prefix 先解析，其餘交給 registry 的 matchesModel 依序比對。
 */
export function resolveAgentIdForModel(resolvedModel: string): AgentId {
  try {
    if (resolveDirectApiModel(resolvedModel)) return 'direct-api';
  } catch {
    // resolveDirectApiModel 對「像 provider prefix 但格式錯」的輸入會丟錯；
    // 這裡只是要判斷歸屬，交給一般路由即可。
  }
  return selectAgentForModel(resolvedModel).id;
}

/**
 * 目前實際生效的 alias 清單。alias 被 config 重新指向時，agent 欄位會跟著重算 —
 * 不能沿用 MODEL_ALIAS_DETAILS 裡寫死的 agent，否則 codex-ultra 被改指到 opus 時
 * 會用錯的 agent 去判斷 reasoning 能力。
 */
export function getEffectiveAliasDetails(
  config: UserConfig = loadUserConfigSnapshot().config
): EffectiveModelAliasDetail[] {
  return MODEL_ALIAS_DETAILS.map((builtin) => {
    const override = resolveConfiguredAliasModel(builtin.name, config);
    const resolvesTo = override ?? builtin.resolvesTo;
    const detail: EffectiveModelAliasDetail = {
      ...builtin,
      resolvesTo,
      agent: resolveAgentIdForModel(resolvesTo),
      source: override ? 'config' : 'builtin',
    };
    if (override) {
      detail.builtinResolvesTo = builtin.resolvesTo;
    }
    return detail;
  });
}

/** 依固定顯示順序取得各 agent 的 model 清單。 */
/**
 * 對外的各 agent model 清單。
 *
 * ★ 2026-08-22：以前這裡只回**靜態**的 `agent.models`，於是 agy 的動態查詢修好之後，
 *   catalogV2 誠實地列出 11 個實查模型，而這裡（也就是 `run` 的候選名單與工具描述）
 *   還停在寫死的 4 個——查得到、跑得動、卻沒被列在使用者真正會看的地方。
 *
 *   現在改成「靜態清單 ∪ 實查到且可路由的」：
 *   - **只增不減**。靜態清單是策展過的（含 `agy` / `agy-default` 這種框架 alias，
 *     它們不是 vendor 的模型 id，查詢永遠不會回報它們），砍掉會弄丟有效用法。
 *   - 實查來的只收 `routable` 的。vendor 回報但本框架路由不到的名字（agy 代理的
 *     `claude-sonnet-4-6` 之類）**不進候選名單**——列出來就要叫得動。
 *     它們仍完整出現在 `catalogV2`，標著 `routable: false`。
 */
function modelsByAgent(): Record<AgentId, readonly string[]> {
  const discovered = new Map<AgentId, string[]>();
  for (const entry of buildCatalogV2().entries) {
    if (!entry.routable) continue;
    const list = discovered.get(entry.agent);
    if (list) list.push(entry.model);
    else discovered.set(entry.agent, [entry.model]);
  }

  const out = {} as Record<AgentId, readonly string[]>;
  for (const agent of listAgents()) {
    const known = new Set(agent.models);
    const extra = (discovered.get(agent.id) ?? []).filter((model) => !known.has(model));
    out[agent.id] = extra.length > 0 ? [...agent.models, ...extra] : agent.models;
  }
  return out;
}

/** run 工具描述用的「Supported models」一行字串。1:1 對齊 dist 順序。 */
export function getSupportedModelsDescription(): string {
  const byAgent = modelsByAgent();
  return [
    '"claude-ultra", "codex-ultra", "codex-ultracode", "agy-ultra"',
    ...byAgent.claude.map((m) => `"${m}"`),
    ...byAgent.codex.map((m) => `"${m}"`),
    ...byAgent.antigravity.map((m) => `"${m}"`),
    ...byAgent['direct-api'].map((m) => `"${m}"`),
  ].join(', ');
}

/** model 參數的長描述。1:1 還原 dist。 */
export function getModelParameterDescription(): string {
  const byAgent = modelsByAgent();
  const all = [
    ...byAgent.claude,
    ...byAgent.codex,
    ...byAgent.antigravity,
    ...byAgent['direct-api'],
  ];
  return `The model to use. The list below is NOT an allowlist: claude is the routing catch-all, so a name absent from it may still run — check the models tool's "modelListCaveat" before concluding a model is unsupported. Aliases: "claude-ultra" (auto max effort), "codex-ultra" (auto max reasoning), "codex-ultracode" (same flagship as codex-ultra but auto "ultra" reasoning — the strongest combination; note "ultra" is an effort level, not a model, which is why this is a separate alias rather than a change to codex-ultra), "agy-ultra" (Antigravity CLI). Standard: ${all
    .map((m) => `"${m}"`)
    .join(
      ', '
    )}. "gpt-6-astra" (and therefore "codex-ultra") needs codex-cli 0.153 or newer; 0.151 is rejected by the API with "requires a newer version of Codex". "gpt-6-sol" and "gpt-6-luna" were verified on codex-cli 0.155.1; older CLIs are untested. "gpt-6.1-sol" is the vendor catalog's current priority-1 entry ("Latest workhorse model for coding and everyday work") and was verified on codex-cli 0.160.0; it is NOT the flagship — the vendor's own copy calls it "near-Astra performance at a lower cost", so "gpt-6-astra" ("Frontier intelligence for the most demanding work") remains the strongest. "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark" and "gpt-5.2" were dropped from the candidate list on 2026-10-03 because they are no longer in the vendor catalog; a probe of all five on that date returned HTTP 400 "The '<name>' model is not supported when using Codex with a ChatGPT account", the same wording as in 2026-09-05. Dropping a name only stops advertising it and does NOT block it, since the "gpt-" prefix still routes an explicitly named model to codex — where it then hits that 400. direct-api accepts provider-prefixed models using "or-<model>" for OpenRouter, "ds-<model>" for DashScope, or "<provider>-<model>" for any provider key configured in ~/.local/share/ai-cli/providers.json — this is how you connect a third-party OpenAI-compatible API yourself. A name like "forge-<model>" is therefore read as provider "forge" plus a model, not as the removed Forge CLI. Antigravity (agy) accepts model selection: the name is normalized to an agy model id and passed as --model, while "agy" and "agy-default" pass nothing and fall back to the agy CLI's own default. agy carries the reasoning level in the model id itself (-high / -medium / -low), which is why reasoning_effort is not accepted for it. The Kiro and Forge agents were removed in 5.0.0 — their model names are now rejected with an explicit error rather than silently falling back to Claude.`;
}

/** 所有 agent 宣告的 model 名稱（不含 direct-api 的動態 provider-prefixed 名稱）。 */
export function listKnownModels(): string[] {
  return listAgents().flatMap((agent) => [...agent.models]);
}

/**
 * 判斷一個 model 名稱是否「真的被認得」。
 *
 * 之所以需要這個：claude agent 的 matchesModel 永遠回 true（registry 的 fallback），
 * 所以打錯字的 model 不會報錯，而是被靜默送去 claude。設定 alias 時必須主動擋掉。
 */
export function isKnownModelTarget(model: string): boolean {
  // alias 名稱不是 model。alias 解析只做一層，把 alias 當 target 會直接把該名稱
  // 原樣送進 CLI（例如 agy-ultra 會被當成 model 名稱送出去）。
  if (isBuiltinAlias(model)) return false;

  // 已移除的 agent 名稱不能當 alias target，否則會在 run 時才炸。
  if (isRemovedModel(model)) return false;

  // direct-api 的 provider prefix 必須真的解析得出來。只看 matchesModel 不夠：
  // 它是 startsWith('or-')/startsWith('ds-')，'or-' 這種空 model 也會過，
  // 但 run 的時候 resolveDirectApiModel 會丟錯 → 設定成功卻每次 run 都爆。
  const looksLikeDirectApi = listAgents().some(
    (agent) => agent.id === 'direct-api' && agent.matchesModel(model)
  );
  if (looksLikeDirectApi) {
    try {
      return resolveDirectApiModel(model) !== null;
    } catch {
      return false;
    }
  }
  try {
    if (resolveDirectApiModel(model)) return true;
  } catch {
    return false;
  }

  if (listKnownModels().includes(model)) return true;
  // 非 fallback agent 的 pattern 命中也算（例如任意 gpt-* 交給 codex）。
  return listAgents().some((agent) => agent.id !== 'claude' && agent.matchesModel(model));
}

/** models 工具的完整 payload。1:1 還原 dist。 */
export function getModelsPayload(snapshot: ConfigSnapshot = loadUserConfigSnapshot()) {
  const byAgent = modelsByAgent();
  // 整個 payload 共用同一份 snapshot：否則每個 alias 各讀一次設定檔，
  // 中途被改動就會回報出「不同 alias 來自不同版本設定」的畫面。
  // set_config 會把「剛寫入的那一份」直接傳進來，連寫完再讀一次都省掉。
  const { config } = snapshot;
  return {
    updateNotice: consumeNotice(),
    /*
      這個 server 自己的身分（npm 套件名、版本、repo）。

      呼叫端多半是另一個 AI，而它從 MCP 註冊只看得到一行
      `node <path>/dist/server.js` —— 認得出「有 ai-cli 這組工具」，
      認不出對應哪個 repo。2026-09-09 改名後，去查外部紀錄拿到的是舊答案。
      身分由工具自己講，才不會依賴外部紀錄有沒有跟上。見 core/identity.ts。
    */
    server: getServerIdentity(),
    aliases: getEffectiveAliasDetails(config).map((alias) => {
      // 只回報「真的會被送進 CLI」的 effort，規則與 command-builder 送出時共用同一個
      // acceptsConfiguredEffort：agent 不支援 reasoning（agy / direct-api），或值不在該 agent
      // 的允許集合（codex-ultra 被重指到 opus 後，內建的 ultra 對 claude 不成立），都不回報，
      // 否則會回報一個指令裡根本沒有的值。後者是獨立稽核 @codex-gpt-6-astra 抓到的：
      // 舊寫法只看 supported、不看 allowed。
      const support = getAgent(alias.agent).reasoning;
      const { defaultReasoningEffort: _builtin, ...rest } = alias;
      if (!support.supported) return rest;
      const effective = resolveConfiguredReasoningEffort(alias.name, config);
      if (effective && !acceptsConfiguredEffort(support, effective)) return rest;
      return { ...rest, defaultReasoningEffort: effective };
    }),
    claude: byAgent.claude,
    codex: byAgent.codex,
    antigravity: byAgent.antigravity,
    'direct-api': byAgent['direct-api'],
    /*
      ★ v2 目錄：**每一筆都說得出自己的出處與時間**。

        上面那四個陣列是既有形狀、有現成消費者，所以不動。但它們沒有
        任何欄位能讓讀的人分辨「這是問過 vendor 的」還是「這是原始碼裡
        的靜態值」——2026-07-31 就因此發生過一次把過時硬編當成事實
        轉述的誤導（agy 的模型清單與 --model 支援度都早已改變）。

        新的消費端請一律讀 `catalogV2`。
    */
    catalogV2: buildCatalogV2(),
    dynamicModelBackends: {
      'direct-api': DIRECT_API_DYNAMIC_BACKEND,
    },
    /*
      這台機器實際設定了哪些 direct-api provider。

      上面的 `direct-api` 陣列只有四個佔位字串（`or-<model>` 之類），看不出本機
      設了什麼——2026-09-09 有人在另一個專案問「NVIDIA 的模型呢」，而工具根本沒說。
      已設定的 provider 是**本機狀態**，不在版控也不在靜態清單裡，只有讀
      providers.json 才知道。不含 api_key；讀不到時回 note 而不是丟錯。
    */
    directApiProviders: describeConfiguredProviders(),
    /*
      依情境該派哪一顆。呼叫端是 AI，它讀的是工具回傳——一份只寫在 README 的
      建議表等於只有人看得到，而真正在挑模型的是它。
    */
    dispatchGuidance: DISPATCH_GUIDANCE,
    knownBadModels: KNOWN_BAD_MODELS,
    /*
      ★ 上面那四個陣列該怎麼讀。呼叫端是 AI，它只看得到 payload——
      清單沒說自己不是全集，讀的人就會把它當全集。見 MODEL_LIST_CAVEAT 上方註解。
    */
    modelListCaveat: MODEL_LIST_CAVEAT,
    userConfig: {
      ...describeUserConfig(snapshot),
      builtinAliasModel: MODEL_ALIASES,
    },
  };
}
