/**
 * 使用者持久化設定。放在 providers.json 同一層目錄：
 *   ~/.local/share/ai-cli/config.json
 *
 * 目前支援：
 *   {
 *     "defaultReasoningEffort": "medium",
 *     "aliasReasoningEffort": { "claude-ultra": "medium", "codex-ultra": "medium" },
 *     "aliasModel": { "codex-ultra": "gpt-5.6-terra" }
 *   }
 *
 * 設計原則：
 * - 設定檔不存在／壞掉 → 靜默退回內建預設，永遠不讓 run 因為設定檔而失敗。
 * - 每次讀檔、以「檔案內容」當快取鍵，改檔後不必重啟 MCP server（見 cache 的註解）。
 * - 環境變數 AI_CLI_DEFAULT_REASONING_EFFORT 優先於設定檔（方便臨時覆蓋／測試）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_REASONING_EFFORTS } from './reasoning.js';
import { debugLog } from './debug.js';

export interface UserConfig {
  /** 所有支援 reasoning 的 agent 在未指定時套用的預設值。 */
  defaultReasoningEffort?: string;
  /** 針對特定 model/alias 的覆蓋值，優先於 defaultReasoningEffort。 */
  aliasReasoningEffort?: Record<string, string>;
  /** alias → 實際 model 的覆寫，優先於 catalog 的內建 MODEL_ALIASES。 */
  aliasModel?: Record<string, string>;
}

export const CONFIG_DIR = process.env.AI_CLI_CONFIG_DIR || join(homedir(), '.local', 'share', 'ai-cli');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** 設定檔不存在時的內建行為（1:1 沿用原本 dist 的 ultra alias 預設）。 */
export const BUILTIN_ALIAS_REASONING: Record<string, string> = {
  'claude-ultra': 'max',
  'codex-ultra': 'max',
  // codex-ultracode：同一顆旗艦，effort 到 codex 的最高一級 ultra。
  // 這份表是**執行期真正會送出的值**；catalog.ts 的 MODEL_ALIAS_DETAILS 只進 payload 顯示。
  // 兩份必須一致，verify-alias-config.mjs 有斷言在守。
  'codex-ultracode': 'ultra',
};

/**
 * 快取鍵是「檔案原始內容」而不是 mtime。
 *
 * 原本用 mtime 當鍵，但 mtime 的解析度不足以區分同一毫秒內的兩次寫入：
 * 先讀一次（快取住 mtime M）→ 同一毫秒內別的 process（或使用者）改寫檔案，
 * 新檔的 mtime 仍是 M → 我們會一路回傳過期設定，直到下次有人再動這個檔。
 * 這在 `verify-alias-config.mjs` 被實際重現過（同一 process 內連續兩次寫入 + 讀取）。
 *
 * 設定檔只有幾百 bytes，每次讀進來比較字串的成本遠低於「靜默用錯設定」的代價，
 * 快取存在的意義只剩省下 JSON.parse 與正規化。
 */
let cache: { raw: string; config: UserConfig } | null = null;

/** 目前這份設定是怎麼來的。給 describeUserConfig() 誠實回報用。 */
export type ConfigStatus =
  /** 剛從檔案讀到、解析成功 */
  | { state: 'fresh' }
  /** 檔案不存在（或路徑結構決定它不可能存在）→ 用內建預設 */
  | { state: 'missing' }
  /** 讀檔失敗，正在沿用上一次成功的設定 */
  | { state: 'stale'; errorCode?: string }
  /** 讀檔失敗且沒有 last-good，或檔案內容不是合法 JSON 物件 → 用內建預設 */
  | { state: 'error'; errorCode?: string; reason: 'read' | 'parse' };

let lastStatus: ConfigStatus = { state: 'missing' };

/**
 * 這些 error code 代表「這個路徑上結構性地拿不到設定檔」，不是暫時性故障：
 * - ENOENT：檔案或中間目錄不存在（Windows 幾乎所有路徑類錯誤都被 libuv 折成這個）
 * - ENOTDIR：POSIX 上中間層是普通檔案 —— 結構上就放不了這個檔
 * - EISDIR：這個路徑被同名目錄佔住了
 * - ELOOP / ENAMETOOLONG：symlink 迴圈、路徑過長
 *
 * 這些都不會自己好，沿用 last-good 只會讓一份早就讀不到的設定無限期存活；
 * 退回內建預設才是誠實的。
 *
 * 其餘（EBUSY / EPERM / EACCES / EMFILE / 網路類…）視為暫時性 → 沿用 last-good。
 * 分界點是「再試一次有沒有可能成功」，不是「錯誤嚴不嚴重」。
 */
const STRUCTURAL_ERROR_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ELOOP',
  'ENAMETOOLONG',
]);

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && STRUCTURAL_ERROR_CODES.has(code);
}

/**
 * 讀出設定檔文字。BOM 必須剝掉 —— Windows 的記事本與 PowerShell 5.1 的
 * Set-Content/Out-File 都會寫出帶 UTF-8 BOM 的檔案，而 JSON.parse 看到開頭的
 * ﻿ 會直接丟 SyntaxError。那會讓使用者手動編輯過的設定「整份靜默失效、
 * 悄悄退回內建 model」——正是這個檔案最該避免的失敗模式。
 */
function readConfigText(): string {
  const text = readFileSync(CONFIG_PATH, 'utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeEffort(value: unknown, source: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!ALLOWED_REASONING_EFFORTS.has(normalized)) {
    debugLog(`[Config] Ignoring invalid reasoning effort "${value}" from ${source}`);
    return undefined;
  }
  return normalized;
}

/**
 * model 名稱只 trim，不 lowercase：'Gemini 3.1 Pro (High)' 的大小寫有意義，
 * antigravity 的路由靠 startsWith('Gemini ') 判斷。
 */
function normalizeModelName(value: unknown, source: string): string | undefined {
  if (typeof value !== 'string') {
    debugLog(`[Config] Ignoring non-string model from ${source}`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized;
}

/**
 * 只取自有屬性。設定檔的 map 來自 JSON.parse，原型是 Object.prototype，
 * 直接用 map[key] 取 'constructor' / 'toString' 會拿到函式而不是 undefined。
 */
function ownValue(map: Record<string, string> | undefined, key: string): string | undefined {
  if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 讀取（並快取）設定檔。
 *
 * 錯誤處理刻意分成兩種，因為它們的意思完全不同：
 * - **檔案不存在（ENOENT）**：使用者就是沒有設定檔（或剛把它刪掉）→ 退回內建預設，清掉快取。
 * - **其他讀取錯誤**（EBUSY / EPERM / EACCES / EISDIR，Windows 上另一個 process 正在
 *   tmp + rename、或防毒掃描鎖檔的瞬間）：這是**暫時性**的，不代表使用者改了設定。
 *   此時不能退回內建值 —— 那會讓這一次 run 悄悄用到跟使用者設定不同的 model 或 reasoning，
 *   而且完全不會有人察覺。改為沿用上一次成功讀到的設定（last-good）。
 *
 * 這個分支之所以必要，是因為快取改成「每次讀檔比對內容」之後，開檔次數大幅增加
 * （一次 buildCliCommand 讀 2 次、一次 models 讀 8 次），撞上鎖檔的機會跟著變大。
 *
 * 註：這裡不先 existsSync 再 readFileSync —— 那中間有 TOCTOU 空窗，
 * 而且 readFileSync 本來就會用 ENOENT 告訴我們檔案不存在。
 */
export function loadUserConfig(): UserConfig {
  let rawText: string;
  try {
    rawText = readConfigText();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (isMissingError(error)) {
      cache = null;
      lastStatus = { state: 'missing' };
      return {};
    }
    if (cache) {
      debugLog(
        `[Config] Failed to read ${CONFIG_PATH} (${code}); keeping last-good config: ${
          (error as Error).message
        }`
      );
      lastStatus = { state: 'stale', errorCode: code };
      return cache.config;
    }
    debugLog(`[Config] Failed to read ${CONFIG_PATH}: ${(error as Error).message}`);
    lastStatus = { state: 'error', errorCode: code, reason: 'read' };
    return {};
  }

  if (cache && cache.raw === rawText) {
    lastStatus = { state: 'fresh' };
    return cache.config;
  }

  return parseAndCache(rawText);
}

/** 解析設定檔文字、正規化、凍結後放進快取。文字來源可以是讀檔，也可以是剛寫出去的內容。 */
function parseAndCache(rawText: string): UserConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    debugLog(`[Config] Failed to parse ${CONFIG_PATH}: ${(error as Error).message}`);
    // 必須清掉 cache：留著的話，之後一次暫時性讀檔失敗會把這份「已經被使用者改壞、
    // 語意上已作廢」的舊設定當成 last-good 復活。
    cache = null;
    lastStatus = { state: 'error', reason: 'parse' };
    return {};
  }
  // 陣列的 typeof 也是 'object'：`"aliasModel": ["a","b"]` 會被 Object.entries
  // 解成 { "0": "a", "1": "b" } 這種垃圾 alias，這裡與下面兩處都要擋掉。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    debugLog(`[Config] ${CONFIG_PATH} is not a JSON object; ignoring`);
    cache = null;
    lastStatus = { state: 'error', reason: 'parse' };
    return {};
  }

  const raw = parsed as Record<string, unknown>;
  const config: UserConfig = {};

  const defaultEffort = normalizeEffort(raw.defaultReasoningEffort, 'defaultReasoningEffort');
  if (defaultEffort) {
    config.defaultReasoningEffort = defaultEffort;
  }

  if (
    raw.aliasReasoningEffort &&
    typeof raw.aliasReasoningEffort === 'object' &&
    !Array.isArray(raw.aliasReasoningEffort)
  ) {
    const overrides: Record<string, string> = {};
    for (const [model, value] of Object.entries(raw.aliasReasoningEffort as object)) {
      const effort = normalizeEffort(value, `aliasReasoningEffort.${model}`);
      if (effort) {
        overrides[model] = effort;
      }
    }
    if (Object.keys(overrides).length > 0) {
      config.aliasReasoningEffort = overrides;
    }
  }

  if (raw.aliasModel && typeof raw.aliasModel === 'object' && !Array.isArray(raw.aliasModel)) {
    const overrides: Record<string, string> = {};
    for (const [alias, value] of Object.entries(raw.aliasModel as object)) {
      const target = normalizeModelName(value, `aliasModel.${alias}`);
      if (target) {
        overrides[alias] = target;
      }
    }
    if (Object.keys(overrides).length > 0) {
      config.aliasModel = overrides;
    }
  }

  // 凍結後才進快取：回傳的是共用參照，呼叫端如果改到它會污染所有後續讀取。
  // 目前所有呼叫端都是唯讀（已逐一確認），凍結是為了讓將來的誤用當場丟錯而不是靜默生效。
  if (config.aliasModel) Object.freeze(config.aliasModel);
  if (config.aliasReasoningEffort) Object.freeze(config.aliasReasoningEffort);
  Object.freeze(config);

  cache = { raw: rawText, config };
  lastStatus = { state: 'fresh' };
  return config;
}

/**
 * 讀出設定檔的原始物件（未正規化）。寫入時必須以此為基底，才不會吃掉未知欄位。
 *
 * **只有 `ENOENT`（檔案真的不存在）才能回空物件。**
 * 其他讀取／解析錯誤一律往上丟：原本的寫法是任何錯誤都回 `{}`，於是鎖檔或半份 JSON 的
 * 瞬間，`set_config` 會拿空基底套上 patch 再寫回去 —— 使用者原有的設定與所有未知欄位
 * 就被整份吃掉了。寧可讓 `set_config` 明確失敗，也不能靜默覆寫。
 *
 * **注意這裡刻意不用 `isMissingError()`**：那個判斷是給**讀取端**用的，
 * 它把 `EISDIR` / `ELOOP` / `ENAMETOOLONG` 也算成「結構性地拿不到」→ 退回內建值，
 * 對讀取而言是對的。但對**寫入端**，那些情況代表「路徑上有東西、只是我讀不到」，
 * 拿空基底寫下去就可能覆蓋掉還在的資料。兩端的判準必須分開
 * （這個回歸就是把讀取端的集合擴大時一起帶壞寫入端的 —— 由最終稽核 @codex 抓到）。
 */
function readRawConfig(): Record<string, unknown> {
  let text: string;
  try {
    text = readConfigText();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `Refusing to update ${CONFIG_PATH}: cannot read the existing file ` +
        `(${(error as NodeJS.ErrnoException).code ?? 'unknown'}). ` +
        `Writing now would overwrite settings that are still there.`,
      { cause: error }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Refusing to update ${CONFIG_PATH}: the existing file is not valid JSON. ` +
        `Fix or remove it first — otherwise this write would discard its contents.`,
      { cause: error }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Refusing to update ${CONFIG_PATH}: the existing file is not a JSON object.`
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * 以「read → patch → 原子寫回」的方式更新設定檔，回傳寫入後生效的設定。
 *
 * patch 收到的是原始 JSON 物件（不是正規化後的 UserConfig），所以使用者手寫的
 * 未知欄位會原封不動保留下來。
 */
export function updateUserConfig(
  patch: (raw: Record<string, unknown>) => void
): ConfigSnapshot {
  const raw = readRawConfig();
  patch(raw);

  mkdirSync(CONFIG_DIR, { recursive: true });
  // tmp 檔名帶 pid：固定檔名的話，兩個 MCP server process 同時寫入會互相覆蓋
  // 對方的 tmp，其中一方的 rename 會拿到 ENOENT。
  const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  const written = `${JSON.stringify(raw, null, 2)}\n`;
  try {
    writeFileSync(tmpPath, written, 'utf-8');
    renameSync(tmpPath, CONFIG_PATH);
  } catch (error) {
    // 寫入或 rename 失敗時不要留下半個 tmp 檔。
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* 清理失敗就算了，別蓋掉原始錯誤 */
    }
    throw error;
  }

  // 不要「清掉 cache 再重讀」：那中間如果撞上鎖檔，last-good 是空的，
  // 就會退回內建值 —— 明明才剛寫入成功，卻回報一份跟磁碟上不一樣的設定。
  // 我們手上已經有剛寫出去的完整文字，直接拿它建立快取即可，也省掉一次讀檔。
  cache = null;
  const config = parseAndCache(written);
  lastStatus = { state: 'fresh' };
  return { config, status: lastStatus };
}

/**
 * 一次操作只載入一份設定用的入口。
 *
 * 為什麼需要：`buildCliCommand()` 原本會讀兩次設定檔（一次解析 alias、一次取 reasoning），
 * `getModelsPayload()` 會讀八次。中間只要檔案被改過，就會組出「A 版的 alias + B 版的
 * reasoning」這種**兩邊都不對**的結果。把 snapshot 在操作入口載入一次、往下傳，
 * 同一次操作內就保證看到同一份設定；順帶把讀檔次數降到 1 次。
 *
 * 下面幾個 resolver 的 config 參數都有預設值，所以既有呼叫端（含驗證腳本）不需要改。
 */
export interface ConfigSnapshot {
  config: UserConfig;
  status: ConfigStatus;
}

export function loadUserConfigSnapshot(): ConfigSnapshot {
  const config = loadUserConfig();
  // status 必須跟 config 一起帶走。之前 describeUserConfig() 讀模組層級的 lastStatus，
  // 但它可以吃外部傳進來的 config —— 只要中間有人再 load 一次，就會回報出
  // 「A 版的設定值配上 B 版的狀態」。綁成一包就沒有這個縫。
  return { config, status: lastStatus };
}

/**
 * 決定某次 run 在「呼叫端沒指定 reasoning_effort」時該套用的預設值。
 *
 * 優先序（高 → 低）：
 *   1. 環境變數 AI_CLI_DEFAULT_REASONING_EFFORT
 *   2. config.json 的 aliasReasoningEffort[rawModel]
 *   3. config.json 的 defaultReasoningEffort
 *   4. 內建 ultra alias 預設（claude-ultra=max / codex-ultra=max / codex-ultracode=ultra）
 *
 * 注意：這裡只回傳「想要的值」，是否真的套用由 caller 依 agent 能力決定。
 */
export function resolveConfiguredReasoningEffort(
  rawModel: string,
  config: UserConfig = loadUserConfig()
): string | undefined {
  const fromEnv = normalizeEffort(
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT,
    'AI_CLI_DEFAULT_REASONING_EFFORT'
  );
  if (fromEnv) return fromEnv;

  const aliasOverride = ownValue(config.aliasReasoningEffort, rawModel);
  if (aliasOverride) return aliasOverride;
  if (config.defaultReasoningEffort) return config.defaultReasoningEffort;

  return ownValue(BUILTIN_ALIAS_REASONING, rawModel);
}

/**
 * 取得設定檔對某個 alias 指定的 model 覆寫。
 * 沒設定就回 undefined，由 caller 退回 catalog 的內建 alias 表。
 */
export function resolveConfiguredAliasModel(
  alias: string,
  config: UserConfig = loadUserConfig()
): string | undefined {
  return ownValue(config.aliasModel, alias);
}

/**
 * 給 models / doctor 工具回報目前生效的設定。
 *
 * `exists` 與 `status` 都由**同一次** loadUserConfig() 推導，不再另外 existsSync ——
 * 否則會出現「exists: true 但回報的其實是 last-good 舊值」這種互相矛盾的診斷，
 * 而那正是外部工具最需要分辨的情況。
 */
export function describeUserConfig(snapshot: ConfigSnapshot = loadUserConfigSnapshot()) {
  const { config, status } = snapshot;
  return {
    path: CONFIG_PATH,
    exists: status.state !== 'missing',
    /** fresh = 剛讀到；stale = 讀檔失敗、正在沿用上一次成功的設定；error = 讀不到或壞掉，用內建值 */
    status,
    aliasModel: config.aliasModel,
    envOverride: normalizeEffort(
      process.env.AI_CLI_DEFAULT_REASONING_EFFORT,
      'AI_CLI_DEFAULT_REASONING_EFFORT'
    ),
    defaultReasoningEffort: config.defaultReasoningEffort,
    aliasReasoningEffort: config.aliasReasoningEffort,
    builtinAliasReasoningEffort: BUILTIN_ALIAS_REASONING,
  };
}
