/**
 * Model 目錄與 alias 表。
 * 支援 claude / codex / grok / antigravity / direct-api（kiro 與 forge 已移除）。
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
  'codex-ultra': 'gpt-6.2-astra',
  /*
    codex-ultracode：和 codex-ultra 同一顆旗艦，差別只在 effort 到 `ultra`。

    為什麼要另立一個名稱而不是把 codex-ultra 改成 ultra：`ultra` 是 codex 的
    **effort 級別名**（low…max 之上還有一級 ultra），不是 model。把 effort 詞當成
    alias 名稱用，已經讓 codex-ultra 這個名字名實不符——它叫 ultra、送的卻是 max。
    改它的語意是破壞性變更，所以這裡用純加法補上真正的最強組合：
    gpt-6-astra + ultra 在此之前**沒有任何 alias**，要用得每次手動帶 reasoning_effort。
    2026-11-18 旗艦換代：vendor 目錄把 gpt-6-astra 改標 "Previous generation"，
    兩個 alias 一起改指 gpt-6.2-astra（effort 不動：codex-ultra 仍是 max、這裡仍是 ultra）。

    claude 側刻意不加對應的名稱：claude 的 effort 只到 max（沒有 ultra），
    claude-ultracode 會和 claude-ultra 完全同義——兩個名字做同一件事是新的混淆源。
  */
  'codex-ultracode': 'gpt-6.2-astra',
  'agy-ultra': 'gemini-4-neon-xhigh',
  'antigravity-ultra': 'gemini-4-neon-xhigh',
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
    situation: '換一家視角的審查、知識萃取與文件查證（xAI Grok CLI）',
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    note:
      '2026-10-10 依使用者工作流六項 × 兩輪評測（派工紀律、實作、審查、知識萃取、協定逆向、長文件），'
      + '以隱藏測試或事先備好的答案判分：grok-4.7、grok-4.7-build-fast、gpt-6.1-sol 客觀項目全過、正確率平手，'
      + '差別只在速度與成本。grok-4.7 審查約 195–273 秒、封包解析約 269–319 秒，固定偏慢；'
      + '知識萃取／文件查證每次名目約 $0.02–0.05。build-fast 名目成本約 2 倍，只在要快時值得。'
      + '日常 coding 沒有理由換掉 gpt-6.1-sol。'
      + '⚠️ Grok 會讀使用者的全域 CLAUDE.md 與 MCP 設定：同日曾自行呼叫知識庫，把約 19.5 KB 條目當工具輸出送進 xAI；'
      + '不希望內容外送時，prompt 要寫明「不要使用知識庫或任何 MCP 工具」（寫明後 24 個 job 全部遵守）。'
      + '那批題目對三者都太簡單，只證明穩定、測不出上限；跨多檔重構、長時間 agentic 作業、上網查證未測。'
      + '獨立 Grok CLI pipe 後端、用 Grok CLI 自己的登入（不是 direct-api provider），'
      + 'low/medium/high/xhigh effort 已實測（grok 1.0.50）。',
  },
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
    model: 'gpt-6.2-sol',
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
      + '省略不等於拿到這裡建議的強度。'
      + '2026-11-18 再換代成 gpt-6.2-sol：vendor 目錄的 priority 1 換成它（"Fast, go-to model for coding and everyday work."），'
      + 'gpt-6.1-sol 改標 "Previous generation"。gpt-6.2-sol 的 CLI 端預設 effort 同樣是 low，一樣要明確傳。',
  },
  {
    situation: '同一個問題卡超過 5 次',
    model: 'gpt-6.2-astra',
    reasoningEffort: 'high',
    note: '升級時要寫明「第幾次、前幾次卡在哪」，不要靜默換模型。',
  },
  {
    situation: '稽核／第二意見',
    model: 'claude-ultra、grok-4.7 或 gemini-4-neon-xhigh',
    note:
      '要換一家的視角才有意義；同一家的模型會犯同一種錯。結果要逐條驗證，不要照單全收。'
      + 'grok-4.7 在 2026-10-10 的審查題（4 個真 bug＋3 個誘餌）兩輪零誤報、不確定的會標存疑，但每次要 3–5 分鐘。'
      + '前代 gemini-3.1-pro-high（2026-11 已下架）曾在 2026-09-09 通讀長文件時撞到 agy 的 5 分鐘 print timeout，'
      + '2026-10-03 派同一份稽核，430 秒後 stdout 累計只有 177 bytes（就是那一行 agy warning），'
      + '之後 ai-cli MCP 連線中斷、結果再也取不回來。'
      + 'gemini-4-neon-xhigh 在 2026-11-20 只驗過一個簡單 job，稽核級長任務的交付尚待驗證。',
  },
  {
    situation: 'Gemini 視角但不吃 agy 額度，或要用 agy 沒有的 Gemini 4 Carbon（Gemini API，按量計費）',
    model: 'google-gemini-3.8-flash；要強一點用 google-gemini-4-neon；Google 稱最強的是 google-gemini-4-carbon（本專案未比較過）',
    note:
      '需要 providers.json 設了 google provider（只寫 api_key 即可）。這條走 Gemini API 的預付額度、按 token 計費，'
      + '不是 agy 的訂閱額度，所以適合 agy 額度用完時的備援，或要 Carbon（2026-11-20 agy 清單沒有它，API 有）。'
      + '2026-11-20 以真實金鑰實測：google-gemini-3.8-flash、google-gemini-4-neon 讀檔工具＋第二輪作答都正確（需要本版修正的 thought_signature 回送），'
      + 'google-gemini-4-carbon 純文字正確；長任務與稽核級工作都還沒測。預付額度用完時回 HTTP 402「prepayment credits are depleted」，'
      + '錯誤原文在 agentOutput.error。不吃 reasoning_effort。額度有限，日常量大的工作仍優先用免費的 nv-*。',
  },
  {
    situation: '大量低價值工作（分類、摘要、格式轉換、批次改寫）',
    model: 'nv-openai/gpt-oss-20b',
    note: '走 NVIDIA 免費 API，不吃訂閱額度。2026-09-10 兩輪全過（4.5–6.6s）。不吃 reasoning_effort。',
  },
  {
    situation: '要快',
    model: 'nv-poolside/laguna-xs-2.1',
    note: '2026-09-10 實測最快且延遲最穩（2.5–2.7s，兩輪只差 5ms）。免費。無 reasoning，輸出精簡。',
  },
  {
    situation: '長脈絡',
    model: 'nv-nvidia/nemotron-3.5-lightning-30b-a3b',
    note: '免費。設定檔已配 reasoning_effort=none（不設會把思考當正文吐出來、直接撞 max_tokens）。'
      + '延遲很不穩：2026-09-10 兩輪是 2.9s 與 20.1s。1M context 是 vendor 宣稱，本專案未實測。',
  },
  {
    situation: '較難的 coding／agentic，但不想動用訂閱額度',
    model: 'nv-meta/muse-glimmer-30b',
    note: '2026-09-10 兩輪全過（2.9–3.4s）。hosted 預設 max_tokens 只有 2048 且與推理共用，設定檔已改成 16384。',
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
    model: 'nv-meta/llama-3.2-11b-vision-instruct',
    reason: '直接打 API 正常（440ms），但走 ai-cli 一定壞：帶 tools 就回 content:null 去叫工具，'
      + '進工具迴圈卡死。direct-api 每次都附工具定義且關不掉，所以這顆在 ai-cli 裡沒救。',
  },
  {
    model: 'nv-nvidia/riva-translate-4b-instruct-v1.1 / -v2',
    reason: '帶 tools 直接 400：「"auto" tool choice requires --enable-auto-tool-choice」——'
      + '那個部署沒開工具呼叫。而且它是翻譯模型，會把指令翻成外語而不是照做。',
  },
  {
    model: 'nv-nvidia/nemotron-3-nano-30b-a3b',
    reason: '410 Gone，已終止服務。/v1/models 上還有個長得很像的 nemotron-nano-3-30b-a3b'
      + '（nano-3 與 3-nano 顛倒），2026-09-10 實測那個也是 404，別派。',
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
      '已退役（vendor 目錄的 upgrade 欄位原本標明 2026-10-14T19:00Z，替代是 gpt-6.1-sol），'
      + '2026-10-15 也從 codex 候選清單移除。退役後 codex-cli 0.162.1 實測一個 trivial job：exitCode 1，'
      + 'CLI 先印 Model metadata for gpt-5.5 not found（退回 fallback metadata），接著 API 回 HTTP 400 '
      + "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
      + '——與 2026-10-03 那五顆下架模型的失敗方式相同。改派 gpt-6.1-sol。',
  },
];

/**
 * 前一版把 nv-moonshotai/kimi-k3（429 打不穿，3/10）與 nv-google/gemma-4-31b-it
 * （工具迴圈 91 秒）列為 KNOWN_BAD。2026-09-10 重測兩顆都兩輪全過——
 * kimi-k3 7.8–22.2s、gemma-4-31b-it 8.0–25.8s，慢但可用，所以移出這份清單。
 *
 * 留這段註解而不是靜默刪掉：兩顆的問題本質是**免費共享端點的負載**，不是模型壞掉。
 * 尖峰時可能再度變成 3/10。看到它們變慢或撞 429 時，那是舊病復發，不是新問題。
 */

/**
 * 免費層的操作限制。這些不是模型個別的毛病，是整條 NVIDIA 免費路徑的性質。
 */
export const NVIDIA_FREE_TIER_CAVEATS: ReadonlyArray<string> = [
  '端點列出的 ≠ 你的帳號能用的：/v1/models 回 80 顆，實測只有 16 顆打得通，'
    + '其餘 55 顆回 404「Not found for account」。可用性綁帳號，別照抄任何清單。',
  '要序列化。並行 4 條掃描時，連已知正常的 nemotron-3.5-lightning 都被判 30 秒逾時；'
    + '序列化重測 384ms 就回。並行造成的假陰性會讓你以為模型壞了。',
  'HTTP 200 不等於內容是對的。2026-09-09 有一次 nemotron-3.5-lightning 回 exit 0 / '
    + 'finish_reason stop，內容卻是亂碼。retry 只認 429/5xx，攔不到這種——結果要自己看過。',
  'capabilities 參數對 direct-api 無效（沒有 buildStrictCommand，會被明確拒絕）。'
    + '這條路徑沒有唯讀沙箱，派會動檔案的工作前先確認 workFolder。',
  'ai-cli exec 完全跑不了 direct-api——exec 是 spawn vendor CLI 的，direct-api 沒有二進位檔。要用 run。',
  'NVIDIA API Trial Terms 明文禁止送入機密資訊與個資。這是使用條件，不是隱私偏好。',
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
    '頂層 claude / codex / grok / antigravity / direct-api 五個陣列是候選建議，不是可派工模型的全集。'
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
    + 'agy models、grok models），不是這份 payload。五個陣列的新鮮度並不一致：claude 與 codex 是原始碼裡的'
    + '手動清單，vendor 出新模型不會自動進來（fable 就是這樣漏掉的）；antigravity 與 grok 則會把實查到'
    + '且可路由的模型併進來，所以它跟得上 agy 的新模型；direct-api 那幾筆是前綴佔位字串，'
    + '本機實際設了哪些 provider 要看 directApiProviders。逐筆的出處看 catalogV2 的 source 欄位'
    + '（vendor-cli＝問過 vendor、builtin-fallback＝原始碼靜態值）。',
} as const;

export const MODEL_ALIAS_DETAILS: ModelAliasDetail[] = [
  { name: 'claude-ultra', resolvesTo: 'opus', agent: 'claude', defaultReasoningEffort: 'max' },
  { name: 'codex-ultra', resolvesTo: 'gpt-6.2-astra', agent: 'codex', defaultReasoningEffort: 'max' },
  // ⚠️ 這裡的 defaultReasoningEffort 只進 models payload 顯示；真正決定送出值的是
  //    user-config.ts 的 BUILTIN_ALIAS_REASONING。兩份必須一致，
  //    verify-alias-config.mjs 有一條斷言在守這件事（兩份寫死的表最容易悄悄漂移）。
  { name: 'codex-ultracode', resolvesTo: 'gpt-6.2-astra', agent: 'codex', defaultReasoningEffort: 'ultra' },
  { name: 'agy-ultra', resolvesTo: 'gemini-4-neon-xhigh', agent: 'antigravity' },
  { name: 'antigravity-ultra', resolvesTo: 'gemini-4-neon-xhigh', agent: 'antigravity' },
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

/**
 * 對外候選清單只收可路由的 vendor 模型。
 * antigravity 有成功查詢／快取時，以 vendor 清單加 agy／agy-default alias 為準，
 * 避免把已退役的後備模型混回去；尚無可用結果才用靜態後備清單。
 * 其他 agent 維持靜態清單與可路由實查結果的聯集。這裡不參與 routing／alias 驗證。
 */
function modelsByAgent(): Record<AgentId, readonly string[]> {
  const catalog = buildCatalogV2();
  const discovered = new Map<AgentId, string[]>();
  for (const entry of catalog.entries) {
    if (!entry.routable) continue;
    const list = discovered.get(entry.agent);
    if (list) list.push(entry.model);
    else discovered.set(entry.agent, [entry.model]);
  }

  const out = {} as Record<AgentId, readonly string[]>;
  for (const agent of listAgents()) {
    const source = catalog.agents.find((row) => row.agent === agent.id)?.source;
    if (agent.id === 'antigravity' && (source === 'vendor-cli' || source === 'vendor-cli-cached')) {
      out[agent.id] = [...new Set(['agy', 'agy-default', ...(discovered.get(agent.id) ?? [])])];
      continue;
    }
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
    ...byAgent.grok.map((m) => `"${m}"`),
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
    ...byAgent.grok,
    ...byAgent.antigravity,
    ...byAgent['direct-api'],
  ];
  return `The model to use. The list below is NOT an allowlist: claude is the routing catch-all, so a name absent from it may still run — check the models tool's "modelListCaveat" before concluding a model is unsupported. Aliases: "claude-ultra" (auto max effort), "codex-ultra" (auto max reasoning), "codex-ultracode" (same flagship as codex-ultra but auto "ultra" reasoning — the strongest combination; note "ultra" is an effort level, not a model, which is why this is a separate alias rather than a change to codex-ultra), "agy-ultra" (Antigravity CLI). Standard: ${all
    .map((m) => `"${m}"`)
    .join(
      ', '
    )}. "gpt-6-astra" needs codex-cli 0.153 or newer (the "codex-ultra" alias pointed at it until 2026-11-18); 0.151 is rejected by the API with "requires a newer version of Codex". "gpt-6-sol" and "gpt-6-luna" were verified on codex-cli 0.155.1; older CLIs are untested. "gpt-6.1-sol" was verified on codex-cli 0.160.0. On 2026-11-18 (codex-cli 0.170.0) the vendor catalog added a new generation: "gpt-6.2-sol" (priority 1, "Fast, go-to model for coding and everyday work"), "gpt-6.2-astra" (priority 2, "Our most capable model for complex coding and professional work" — the flagship, so "codex-ultra" and "codex-ultracode" now resolve to it) and "gpt-6.1-terra" (priority 3, "Efficient model that excels at visual understanding and computer use"); "gpt-6.1-sol" and "gpt-6-astra" are now labelled "Previous generation" and still run. All three new models were verified that day and default to "low" effort on the CLI side. Catalog priority is not a capability ranking: the "sol" models are the everyday workhorses, the "astra" models the flagships. "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark" and "gpt-5.2" were dropped from the candidate list on 2026-10-03 because they are no longer in the vendor catalog; a probe of all five on that date returned HTTP 400 "The '<name>' model is not supported when using Codex with a ChatGPT account", the same wording as in 2026-09-05. "gpt-5.5" was dropped the same way on 2026-10-15, after the vendor retired it on 2026-10-14 (replacement: "gpt-6.1-sol"); a probe that day returned the same HTTP 400. Dropping a name only stops advertising it and does NOT block it, since the "gpt-" prefix still routes an explicitly named model to codex — where it then hits that 400. direct-api accepts provider-prefixed models using "or-<model>" for OpenRouter, "ds-<model>" for DashScope, or "<provider>-<model>" for any provider key configured in ~/.local/share/ai-cli/providers.json — this is how you connect a third-party OpenAI-compatible API yourself. A name like "forge-<model>" is therefore read as provider "forge" plus a model, not as the removed Forge CLI. Antigravity (agy) accepts model selection: the name is normalized to an agy model id and passed as --model, while "agy" and "agy-default" pass nothing and fall back to the agy CLI's own default. agy carries the reasoning level in the model id itself (-high / -medium / -low), which is why reasoning_effort is not accepted for it. The Kiro and Forge agents were removed in 5.0.0 — their model names are now rejected with an explicit error rather than silently falling back to Claude.`;
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
    grok: byAgent.grok,
    antigravity: byAgent.antigravity,
    'direct-api': byAgent['direct-api'],
    /*
      ★ v2 目錄：**每一筆都說得出自己的出處與時間**。

        上面各 agent 陣列保留既有形狀，Grok 以新增欄位加入。但它們沒有
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
      免費層的操作限制。與 knownBadModels 分開，因為那份講「哪一顆不要派」，
      這份講「整條路徑的性質」——踩到的人會以為是模型壞了而去換模型，
      實際上換哪顆都一樣。
    */
    nvidiaFreeTierCaveats: NVIDIA_FREE_TIER_CAVEATS,
    /*
      ★ 上面各 agent 陣列該怎麼讀。呼叫端是 AI，它只看得到 payload——
      清單沒說自己不是全集，讀的人就會把它當全集。見 MODEL_LIST_CAVEAT 上方註解。
    */
    modelListCaveat: MODEL_LIST_CAVEAT,
    userConfig: {
      ...describeUserConfig(snapshot),
      builtinAliasModel: MODEL_ALIASES,
    },
  };
}
