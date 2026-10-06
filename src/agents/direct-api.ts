/**
 * Direct OpenAI-compatible API agent.
 *
 * This agent does not start a CLI process. process-service calls runDirect()
 * in the current Node.js process and tracks it with the same PID/result API.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative as pathRelative, resolve as pathResolve } from 'node:path';
import type {
  AgentDefinition,
  BuildCommandInput,
  BuiltCommand,
  DirectRunIO,
} from './types.js';
import { debugLog } from '../core/debug.js';

const DIRECT_API_MODELS = [
  'or-<model>',
  'ds-<model>',
  '<provider>-<model>',
  'or-qwen/qwen3.7-plus',
] as const;

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
const IMAGE_MARKER = /\[image:([^\]\r\n]+)\]/g;
const NO_TOOLS_MARKER = /^\s*\[no-tools\]\s*/i;
const MAX_TOOL_LOOP_ITERATIONS = 30;
const MAX_API_CALLS = 30;
const MAX_TOOL_OUTPUT_CHARS = 10000;
const TOOL_OUTPUT_PREVIEW_CHARS = 200;
const BASH_TIMEOUT_MS = 30000;
const XML_TOOL_CALL_RE = /<function=(\w+)>\s*([\s\S]*?)<\/function>/g;
const XML_PARAM_RE = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
const XML_WRAPPED_TOOL_CALL_RE = /<tool_call>\s*<function=\w+>\s*[\s\S]*?<\/function>\s*<\/tool_call>/g;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace. Supports line offset and limit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to read, relative to the workspace.' },
          offset: { type: 'number', description: 'Optional zero-based line offset.' },
          limit: { type: 'number', description: 'Optional maximum number of lines to return.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file in the workspace, creating parent directories automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to write, relative to the workspace.' },
          content: { type: 'string', description: 'Complete file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents in the workspace using ripgrep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to search for.' },
          path: { type: 'string', description: 'Directory or file path to search under.' },
          glob: { type: 'string', description: 'Optional ripgrep glob filter.' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find file names in the workspace using ripgrep file listing.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Ripgrep glob pattern.' },
          path: { type: 'string', description: 'Optional directory path to list under.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a directory in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list, relative to the workspace.' },
        },
        required: ['path'],
      },
    },
  },
] as const;

const PROVIDER_PREFIX_ALIASES: Record<string, string> = {
  or: 'openrouter',
  ds: 'dashscope',
};

const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * 這些欄位由框架自己組，**不接受** extra_body 覆蓋。
 *
 * 不是潔癖：`stream` 被改成 false 會讓 consumeResponse 的 SSE 解析器收到
 * 一整包 JSON 而解不出任何東西；`tools` 被覆蓋會讓 executeTool 收到自己
 * 不認識的工具名；`messages` 被覆蓋則整段對話歷史消失。三種都是「設定看起來
 * 生效了，實際上壞在很遠的地方」。
 */
const RESERVED_EXTRA_BODY_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
]);

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
}

/**
 * 預設重試 2 次、首次退避 1 秒（第二次 2 秒）。
 *
 * 為什麼預設就開：NVIDIA 的免費共享端點在尖峰會回 429/503，官方文件本身就建議
 * 「短暫等待後重試、降低並發」。2026-09-09 實測 `nemotron-3-super-120b-a12b`，
 * 同樣的請求間隔下不重試 8/10、退避重試 10/10（觸發 7 次、救回 5 次）。
 * 放慢速率沒有讓它到 100%，重試有。
 *
 * 上限刻意低：重試是為了熬過幾秒的尖峰，不是為了硬撐一個已經壞掉的服務。
 * 真的持續失敗時，讓呼叫端早點知道比讓它等下去有用。
 */
const DEFAULT_RETRY: RetryConfig = { maxRetries: 2, initialDelayMs: 1000 };
const MAX_ALLOWED_RETRIES = 8;
const MAX_INITIAL_DELAY_MS = 30_000;

interface ProviderConfig {
  base_url: string;
  api_key: string;
  /** 429/5xx 的重試設定；省略時用 DEFAULT_RETRY。 */
  retry?: RetryConfig;
  /**
   * 哪些 model 需要把上一輪的 `reasoning_content` 回送。
   * `true` = 這個 provider 的所有 model；陣列 = 只有列出的那幾個。省略 = 都不送。
   */
  replay_reasoning?: true | string[];
  /** 併進 /chat/completions request body 的額外欄位（provider 層預設）。 */
  extra_body?: Record<string, unknown>;
  /** 同上，但只套用在特定 model 上；與 provider 層合併時以這裡為準。 */
  model_extra_body?: Record<string, Record<string, unknown>>;
}

interface ProvidersFile {
  providers: Record<string, ProviderConfig>;
}

interface DirectApiModelSelection {
  providerName: string;
  modelName: string;
}

interface TextContentPart {
  type: 'text';
  text: string;
}

interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

type ChatContentPart = TextContentPart | ImageContentPart;
type ChatContent = string | ChatContentPart[];

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: ChatContent | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  /**
   * 上一輪 assistant 的推理內容，回送給要求保留它的模型。
   *
   * **不是 OpenAI Chat Completions 的標準欄位**，所以只在明確設定過的 model 上送——
   * 詳見 `resolveReplayReasoning`。
   */
  reasoning_content?: string;
}

interface SessionFile {
  id: string;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  tokens?: Record<string, number>;
  cost?: unknown;
}

interface CompletionUsage {
  [key: string]: unknown;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface StreamState {
  sessionId: string;
  providerName: string;
  modelName: string;
  assistantText: string;
  reasoningText: string;
  usage?: CompletionUsage;
  jobUsage?: ReturnType<typeof normalizeJobUsage>;
  incompleteUsage?: boolean;
  cost?: unknown;
  finishReason?: string;
}

interface StreamToolCallAccumulator {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface CompletionTurn {
  assistantText: string;
  reasoningText: string;
  toolCallAccumulators: StreamToolCallAccumulator[];
  toolCalls: ChatToolCall[];
  finishReason?: string;
}

interface ToolExecutionResult {
  status: 'completed' | 'failed';
  output: string;
}

function providersPath(): string {
  return process.env.AI_CLI_PROVIDERS_PATH ||
    join(homedir(), '.local', 'share', 'ai-cli', 'providers.json');
}

function openCodeAuthPath(): string {
  return process.env.AI_CLI_OPENCODE_AUTH_PATH ||
    join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 解析一份 extra_body。**不合法就丟錯，不靜默丟棄。**
 *
 * 這與 config.json 的「設定檔推導值靜默降級」刻意相反：那邊丟掉一個 reasoning
 * 偏好，最壞是慢一點；這邊丟掉 `reasoning_effort: "none"`，模型會照預設跑滿
 * 16384 token 的思考，使用者只會看到「設定寫了但沒用」。錯誤訊息點名 provider
 * 與欄位，讓人知道要去改哪一行。
 */
function normalizeExtraBody(
  providerName: string,
  label: string,
  value: unknown,
  targetPath: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `Invalid providers.json at ${targetPath}: provider "${providerName}" ${label} must be an object.`
    );
  }
  for (const key of Object.keys(record)) {
    if (RESERVED_EXTRA_BODY_KEYS.has(key)) {
      throw new Error(
        `Invalid providers.json at ${targetPath}: provider "${providerName}" ${label} may not set "${key}" — ` +
          'that field is built by ai-cli itself and overriding it breaks the streaming/tool loop.'
      );
    }
  }
  return { ...record };
}

/**
 * 解析 `retry`。不合法就丟錯——與 extra_body 同一個理由：
 * 靜默退回預設值會讓「我設了 5 次重試」跟「我根本沒設」長得一模一樣。
 *
 * `max_retries: 0` 是合法的（明確要求關掉重試），所以判斷要用「有沒有這個欄位」
 * 而不是值的真假——`0` 是 falsy。
 */
function normalizeRetryConfig(
  providerName: string,
  value: unknown,
  targetPath: string
): RetryConfig | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `Invalid providers.json at ${targetPath}: provider "${providerName}" retry must be an object.`
    );
  }
  const num = (key: string, fallback: number, max: number): number => {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return fallback;
    const raw = record[key];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) {
      throw new Error(
        `Invalid providers.json at ${targetPath}: provider "${providerName}" retry.${key} ` +
          `must be an integer between 0 and ${max}.`
      );
    }
    return raw;
  };
  return {
    maxRetries: num('max_retries', DEFAULT_RETRY.maxRetries, MAX_ALLOWED_RETRIES),
    initialDelayMs: num('initial_delay_ms', DEFAULT_RETRY.initialDelayMs, MAX_INITIAL_DELAY_MS),
  };
}

/**
 * 解析 `replay_reasoning`。接受 `true`（整個 provider）或 model 名稱陣列。
 */
function normalizeReplayReasoning(
  providerName: string,
  value: unknown,
  targetPath: string
): true | string[] | undefined {
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (Array.isArray(value) && value.every((m) => typeof m === 'string' && m.trim())) {
    return [...(value as string[])];
  }
  throw new Error(
    `Invalid providers.json at ${targetPath}: provider "${providerName}" replay_reasoning ` +
      'must be true or an array of model names.'
  );
}

/**
 * 這次要不要把上一輪的 `reasoning_content` 回送？
 *
 * **預設不送。** `reasoning_content` 不在 OpenAI Chat Completions 的 assistant schema 裡，
 * 而「OpenAI-compatible」不等於「未知欄位一定被忽略」——Azure AI Model Inference 的
 * `extra-parameters` 預設就是 `error`。所以這是 opt-in，不是猜出來的。
 *
 * 為什麼不寫成內建的 model 白名單：今天才學到硬編清單會過期（codex 的靜態清單裡還躺著
 * 三個帳號用不了的 model，`/v1/models` 回的 nano id 甚至是打不通的舊寫法）。
 * 再加一份會過期的表，只是把同一個錯誤換個地方犯。
 *
 * 已知要求回送的（2026-09-09 查證，寫在文件裡供設定時參考）：
 * - `moonshotai/kimi-k3` —— model card：“clients must pass back the complete assistant
 *   message, including `reasoning_content` and `tool_calls`”。不送會怎樣官方沒寫，
 *   而實測三輪工具鏈不送也能正確完成，所以這是照契約做，不是修一個看得見的當機。
 * - DeepSeek V4 帶 `tools` 時 —— 官方文件說少送會 **400**，這個是硬的。
 */
export function resolveReplayReasoning(
  provider: Pick<ProviderConfig, 'replay_reasoning'>,
  modelName: string
): boolean {
  const setting = provider.replay_reasoning;
  if (setting === true) return true;
  return Array.isArray(setting) && setting.includes(modelName);
}

function normalizeProviderConfig(
  providerName: string,
  value: unknown,
  targetPath: string
): ProviderConfig | null {
  const record = asRecord(value);
  if (!record) return null;
  const apiKey = record.api_key || record.key || record.token;
  const baseUrl = record.base_url || record.baseURL || DEFAULT_PROVIDER_BASE_URLS[providerName];
  if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;

  const extraBody = normalizeExtraBody(providerName, 'extra_body', record.extra_body, targetPath);
  const retry = normalizeRetryConfig(providerName, record.retry, targetPath);
  const replayReasoning = normalizeReplayReasoning(providerName, record.replay_reasoning, targetPath);

  let modelExtraBody: Record<string, Record<string, unknown>> | undefined;
  if (record.model_extra_body !== undefined) {
    const byModel = asRecord(record.model_extra_body);
    if (!byModel) {
      throw new Error(
        `Invalid providers.json at ${targetPath}: provider "${providerName}" model_extra_body must be an object.`
      );
    }
    modelExtraBody = {};
    for (const [modelName, raw] of Object.entries(byModel)) {
      const parsed = normalizeExtraBody(
        providerName,
        `model_extra_body["${modelName}"]`,
        raw,
        targetPath
      );
      if (parsed) modelExtraBody[modelName] = parsed;
    }
  }

  const config: ProviderConfig = {
    base_url: baseUrl.trim().replace(/\/+$/, ''),
    api_key: apiKey.trim(),
  };
  if (retry) config.retry = retry;
  if (replayReasoning !== undefined) config.replay_reasoning = replayReasoning;
  if (extraBody) config.extra_body = extraBody;
  if (modelExtraBody) config.model_extra_body = modelExtraBody;
  return config;
}

/**
 * provider 層的 extra_body 疊上 model 專屬的那層，model 覆蓋 provider。
 *
 * 查表一律走 hasOwnProperty：`JSON.parse` 出來的物件在 `model_extra_body`
 * 這種 map 上，`'constructor' in map` 為 true 且取值會拿到函式而不是 undefined。
 */
export function resolveExtraBody(
  provider: Pick<ProviderConfig, 'extra_body' | 'model_extra_body'>,
  modelName: string
): Record<string, unknown> | undefined {
  const base = provider.extra_body;
  const byModel = provider.model_extra_body;
  const perModel =
    byModel && Object.prototype.hasOwnProperty.call(byModel, modelName)
      ? byModel[modelName]
      : undefined;
  if (!base && !perModel) return undefined;
  return { ...(base ?? {}), ...(perModel ?? {}) };
}

function migrateOpenCodeAuth(rawAuth: unknown, sourcePath: string): ProvidersFile {
  const auth = asRecord(rawAuth);
  const providers: Record<string, ProviderConfig> = {};
  if (!auth) return { providers };
  for (const [providerName, rawProvider] of Object.entries(auth)) {
    const normalized = normalizeProviderConfig(providerName, rawProvider, sourcePath);
    if (normalized) {
      providers[providerName] = normalized;
    }
  }
  return { providers };
}

function ensureProvidersConfigMigrated(): void {
  const targetPath = providersPath();
  if (existsSync(targetPath)) return;
  const sourcePath = openCodeAuthPath();
  if (!existsSync(sourcePath)) return;

  let migrated: ProvidersFile;
  try {
    migrated = migrateOpenCodeAuth(JSON.parse(readFileSync(sourcePath, 'utf-8')), sourcePath);
  } catch (error) {
    throw new Error(`Failed to migrate OpenCode auth.json: ${(error as Error).message}`);
  }
  if (Object.keys(migrated.providers).length === 0) return;

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf-8');
  console.error(`[direct-api] Migrated OpenCode auth to ${targetPath}.`);
}

export function loadProvidersConfig(): ProvidersFile {
  ensureProvidersConfigMigrated();
  const targetPath = providersPath();
  if (!existsSync(targetPath)) {
    return { providers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(targetPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to read providers.json at ${targetPath}: ${(error as Error).message}`);
  }
  const root = asRecord(parsed);
  const rawProviders = asRecord(root?.providers);
  if (!rawProviders) {
    throw new Error(`Invalid providers.json at ${targetPath}: missing "providers" object.`);
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [providerName, rawProvider] of Object.entries(rawProviders)) {
    const normalized = normalizeProviderConfig(providerName, rawProvider, targetPath);
    if (!normalized) {
      throw new Error(
        `Invalid providers.json at ${targetPath}: provider "${providerName}" requires base_url and api_key.`
      );
    }
    providers[providerName] = normalized;
  }
  return { providers };
}

export function listConfiguredProviderKeys(): string[] {
  return Object.keys(loadProvidersConfig().providers);
}

export interface ConfiguredProviderSummary {
  /** 可以用來派工的前綴（provider key 本身，加上指向它的內建簡寫）。 */
  prefixes: string[];
  baseUrl: string;
  /**
   * **設定檔裡點名過的 model**，不是這個 provider 的完整目錄。
   * 來源是 `model_extra_body` 的 key——會被特別設定的通常就是實際在用的那幾顆。
   */
  knownModels: string[];
  /** 直接可以複製去用的 model 參數。 */
  example: string;
}

/**
 * 這台機器上有哪些 direct-api provider 可以派工。
 *
 * 為什麼需要：`DIRECT_API_MODELS` 只有四個佔位字串（`or-<model>` 之類），
 * 所以 `models` 的回傳**看不出這台機器實際設了什麼**——2026-09-09 有人在另一個專案問
 * 「NVIDIA 的模型呢」，答案是工具根本沒告訴他。已設定的 provider 是本機狀態，
 * 只有讀 providers.json 才知道。
 *
 * 三條硬性規則：
 * 1. **永不回傳 api_key。** 這個結構會被原樣送進工具回傳。
 * 2. **永不丟錯。** providers.json 壞掉不該讓整個 `models` 陣亡——回 `note` 說明讀不到，
 *    讓呼叫端看得出是「讀不到」而不是「沒有設定」。誠實的降級標示比空陣列有用。
 * 3. **不查網路。** 只讀本機設定檔；列舉 provider 的完整目錄要打 API，那是 `models`
 *    的同步路徑不能做的事（2026-09-05 agy 那次的教訓）。
 */
export function describeConfiguredProviders(): {
  configured: Record<string, ConfiguredProviderSummary>;
  note: string | null;
} {
  let providers: Record<string, ProviderConfig>;
  try {
    providers = loadProvidersConfig().providers;
  } catch (error) {
    return { configured: {}, note: `讀不到 ${providersPath()}：${(error as Error).message}` };
  }
  const configured: Record<string, ConfiguredProviderSummary> = {};
  for (const [name, provider] of Object.entries(providers)) {
    const prefixes = [
      name,
      ...Object.entries(PROVIDER_PREFIX_ALIASES)
        .filter(([, target]) => target === name)
        .map(([alias]) => alias),
    ];
    const knownModels = Object.keys(provider.model_extra_body ?? {});
    configured[name] = {
      prefixes,
      baseUrl: provider.base_url,
      knownModels,
      example: `${prefixes[prefixes.length - 1]}-${knownModels[0] ?? '<model>'}`,
    };
  }
  return { configured, note: null };
}

function getProviderConfig(providerName: string): ProviderConfig {
  const config = loadProvidersConfig();
  const provider = config.providers[providerName];
  if (!provider) {
    throw new Error(
      `Provider "${providerName}" not found in ${providersPath()}. Add it under providers.${providerName}.`
    );
  }
  return provider;
}

function tryKnownProviderAlias(rawModel: string): DirectApiModelSelection | null {
  for (const [prefix, providerName] of Object.entries(PROVIDER_PREFIX_ALIASES)) {
    const marker = `${prefix}-`;
    if (!rawModel.startsWith(marker)) continue;
    const modelName = rawModel.slice(marker.length);
    if (!modelName) {
      throw new Error(`Invalid direct-api model. Expected ${prefix}-<model>.`);
    }
    return { providerName, modelName };
  }
  return null;
}

function tryConfiguredProviderPrefix(rawModel: string): DirectApiModelSelection | null {
  if (!existsSync(providersPath())) {
    return null;
  }
  let providerKeys: string[];
  try {
    providerKeys = listConfiguredProviderKeys();
  } catch (error) {
    debugLog(`[Debug] Skipping configured provider prefix routing: ${(error as Error).message}`);
    return null;
  }
  const sortedKeys = providerKeys.sort((a, b) => b.length - a.length);
  for (const providerName of sortedKeys) {
    const marker = `${providerName}-`;
    if (!rawModel.startsWith(marker)) continue;
    const modelName = rawModel.slice(marker.length);
    if (!modelName) {
      throw new Error(`Invalid direct-api model. Expected ${providerName}-<model>.`);
    }
    return { providerName, modelName };
  }
  return null;
}

export function resolveDirectApiModel(rawModel: string): DirectApiModelSelection | null {
  const trimmed = rawModel.trim();
  if (rawModel !== trimmed) {
    const knownPrefix = Object.keys(PROVIDER_PREFIX_ALIASES).some((prefix) =>
      trimmed.startsWith(`${prefix}-`)
    );
    if (knownPrefix) {
      throw new Error('Invalid direct-api model. Do not include leading or trailing whitespace.');
    }
  }
  const known = tryKnownProviderAlias(rawModel);
  if (known) return known;
  return tryConfiguredProviderPrefix(rawModel);
}

function buildCommand(input: BuildCommandInput): BuiltCommand {
  if (!input.providerName || !input.providerModel) {
    throw new Error('direct-api requires a provider-prefixed model such as or-qwen/qwen3.7-plus.');
  }
  // 呼叫端直接給了 base_url/api_key 時就不碰 providers.json，因此也沒有
  // extra_body 可解析——那條路徑等於「完全不使用設定檔」。
  const provider =
    input.providerBaseUrl && input.providerApiKey
      ? { base_url: input.providerBaseUrl, api_key: input.providerApiKey }
      : getProviderConfig(input.providerName);
  const extraBody = resolveExtraBody(provider, input.providerModel);
  return {
    cliPath: '',
    args: [],
    cwd: input.cwd,
    agent: 'direct-api',
    prompt: input.prompt,
    resolvedModel: input.providerModel,
    sessionId: input.sessionId,
    directApi: {
      providerName: input.providerName,
      modelName: input.providerModel,
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
      ...(extraBody ? { extraBody } : {}),
      ...(provider.retry ? { retry: provider.retry } : {}),
      ...(resolveReplayReasoning(provider, input.providerModel) ? { replayReasoning: true } : {}),
    },
  };
}

function parseOutput(stdout: string): unknown {
  if (!stdout.trim()) return null;
  let sessionId: string | null = null;
  let message = '';
  let tokens: unknown;
  let usage: ReturnType<typeof normalizeJobUsage>;
  let cost: unknown;
  let sessionPath: string | undefined;
  let finishReason: string | undefined;
  let reasoning: string | undefined;
  const toolsMap = new Map<string, { tool: string; input: unknown; status?: string; output_preview?: string }>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed.session_id === 'string') {
      sessionId = parsed.session_id;
    }
    if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      for (const content of parsed.message.content) {
        if (content?.type === 'text' && typeof content.text === 'string') {
          message += content.text;
        }
      }
    }
    if (parsed.type === 'reasoning' && typeof parsed.delta === 'string') {
      reasoning = `${reasoning || ''}${parsed.delta}`;
    }
    if (parsed.type === 'message' && typeof parsed.content === 'string') {
      message = parsed.content;
    }
    if (parsed.type === 'tool_use' && typeof parsed.tool === 'string') {
      const key = typeof parsed.id === 'string' ? parsed.id : `${parsed.tool}:${toolsMap.size}`;
      toolsMap.set(key, {
        tool: parsed.tool,
        input: parsed.input,
        status: typeof parsed.status === 'string' ? parsed.status : undefined,
        output_preview: typeof parsed.output_preview === 'string' ? parsed.output_preview : undefined,
      });
    }
    if (parsed.type === 'result') {
      if (typeof parsed.result === 'string') {
        message = parsed.result;
      }
      tokens = parsed.tokens;
      usage = parsed.usage ?? usage;
      cost = parsed.cost;
      sessionPath = typeof parsed.session_path === 'string' ? parsed.session_path : undefined;
      finishReason = typeof parsed.finish_reason === 'string' ? parsed.finish_reason : undefined;
    }
  }

  const tools = Array.from(toolsMap.values());
  if (!message && !sessionId && !tokens && !usage && cost === undefined && tools.length === 0) {
    return null;
  }
  return {
    message,
    tokens,
    ...(usage ? { usage } : {}),
    cost,
    session_id: sessionId,
    sessionPath,
    finish_reason: finishReason,
    reasoning,
    tools: tools.length > 0 ? tools : undefined,
  };
}

function emitJsonLine(write: (chunk: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

function truncateText(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const suffix = '\n[truncated]';
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function toolOutputPreview(output: string): string {
  return truncateText(output, TOOL_OUTPUT_PREVIEW_CHARS);
}

function requireObject(value: unknown, toolName: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${toolName} arguments must be an object.`);
  }
  return record;
}

function requireStringArg(args: Record<string, unknown>, key: string, toolName: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`${toolName}.${key} must be a string.`);
  }
  return value;
}

function optionalLineNumberArg(args: Record<string, unknown>, key: string, toolName: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${toolName}.${key} must be a non-negative integer.`);
  }
  return value;
}

function resolveSandboxPath(workFolder: string, toolPath = '.'): string {
  const root = pathResolve(workFolder);
  const target = pathResolve(root, toolPath);
  const relative = pathRelative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !isAbsolute(relative))) {
    return target;
  }
  throw new Error(`Path is outside the workspace: ${toolPath}`);
}

function sandboxRelativePath(workFolder: string, toolPath = '.'): string {
  const root = pathResolve(workFolder);
  const target = resolveSandboxPath(root, toolPath);
  const relative = pathRelative(root, target);
  return relative || '.';
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/(["^&|<>%])/g, '^$1')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stringifyExecOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return typeof value === 'string' ? value : '';
}

function formatExecError(error: unknown): string {
  const err = error as Error & {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number;
    signal?: NodeJS.Signals | string;
  };
  const parts: string[] = [];
  if (typeof err.status === 'number') parts.push(`Exit code: ${err.status}`);
  if (err.signal) parts.push(`Signal: ${err.signal}`);
  const stdout = stringifyExecOutput(err.stdout).trim();
  const stderr = stringifyExecOutput(err.stderr).trim();
  if (stdout) parts.push(`STDOUT:\n${stdout}`);
  if (stderr) parts.push(`STDERR:\n${stderr}`);
  if (parts.length === 0 && err.message) parts.push(err.message);
  return parts.join('\n\n') || 'Command failed.';
}

function execRg(command: string, workFolder: string, noMatchOk = true): string {
  try {
    return execSync(command, {
      cwd: pathResolve(workFolder),
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as Error & { stdout?: Buffer | string; status?: number };
    const stdout = stringifyExecOutput(err.stdout);
    if (noMatchOk && err.status === 1) return stdout;
    throw error;
  }
}

function executeTool(name: string, rawArgs: unknown, workFolder: string): ToolExecutionResult {
  try {
    const args = requireObject(rawArgs, name);
    if (name === 'read_file') {
      const targetPath = resolveSandboxPath(workFolder, requireStringArg(args, 'path', name));
      const offset = optionalLineNumberArg(args, 'offset', name);
      const limit = optionalLineNumberArg(args, 'limit', name);
      const content = readFileSync(targetPath, 'utf-8');
      if (offset === undefined && limit === undefined) {
        return { status: 'completed', output: truncateText(content) };
      }
      const lines = content.split(/\r?\n/);
      const start = offset ?? 0;
      const end = limit === undefined ? undefined : start + limit;
      return { status: 'completed', output: truncateText(lines.slice(start, end).join('\n')) };
    }
    if (name === 'write_file') {
      const targetPath = resolveSandboxPath(workFolder, requireStringArg(args, 'path', name));
      const content = requireStringArg(args, 'content', name);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content, 'utf-8');
      return { status: 'completed', output: `Wrote ${content.length} chars to ${sandboxRelativePath(workFolder, targetPath)}.` };
    }
    if (name === 'grep') {
      const pattern = requireStringArg(args, 'pattern', name);
      const searchPath = sandboxRelativePath(workFolder, requireStringArg(args, 'path', name));
      const glob = args.glob === undefined ? undefined : requireStringArg(args, 'glob', name);
      const globPart = glob ? ` --glob ${shellQuote(glob)}` : '';
      const command = `rg --line-number --color never${globPart} -- ${shellQuote(pattern)} ${shellQuote(searchPath)}`;
      const output = execRg(command, workFolder, true);
      return { status: 'completed', output: truncateText(output) };
    }
    if (name === 'glob') {
      const pattern = requireStringArg(args, 'pattern', name);
      const searchPath = sandboxRelativePath(workFolder, typeof args.path === 'string' ? args.path : '.');
      const command = `rg --files --glob ${shellQuote(pattern)} ${shellQuote(searchPath)}`;
      const output = execRg(command, workFolder, true);
      return { status: 'completed', output: truncateText(output) };
    }
    if (name === 'bash') {
      const command = requireStringArg(args, 'command', name);
      try {
        const output = execSync(command, {
          cwd: pathResolve(workFolder),
          encoding: 'utf-8',
          timeout: BASH_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { status: 'completed', output: truncateText(output) };
      } catch (error) {
        return { status: 'failed', output: truncateText(formatExecError(error)) };
      }
    }
    if (name === 'list_dir') {
      const targetPath = resolveSandboxPath(workFolder, requireStringArg(args, 'path', name));
      const entries = readdirSync(targetPath, { withFileTypes: true })
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
        .sort((a, b) => a.localeCompare(b));
      return { status: 'completed', output: truncateText(entries.join('\n')) };
    }
    return { status: 'failed', output: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      status: 'failed',
      output: truncateText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function resolveSessionId(sessionId: string | undefined): string {
  if (sessionId) {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new Error(`Invalid direct-api session_id: ${sessionId}`);
    }
    return sessionId;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}_${random}`;
}

function resolveSessionPath(workFolder: string, sessionId: string): string {
  return join(workFolder, '.tmp', 'api_sessions', `ses_${sessionId}.json`);
}

function readSession(sessionPath: string): SessionFile | null {
  if (!existsSync(sessionPath)) return null;
  const parsed = JSON.parse(readFileSync(sessionPath, 'utf-8')) as SessionFile;
  if (!Array.isArray(parsed.messages)) {
    throw new Error(`Invalid direct-api session file: ${sessionPath}`);
  }
  return parsed;
}

function saveSession(params: {
  sessionPath: string;
  existing: SessionFile | null;
  sessionId: string;
  providerName: string;
  modelName: string;
  messages: ChatMessage[];
  tokens?: Record<string, number>;
  cost?: unknown;
}): void {
  const now = new Date().toISOString();
  const session: SessionFile = {
    id: params.sessionId,
    provider: params.providerName,
    model: params.modelName,
    created_at: params.existing?.created_at || now,
    updated_at: now,
    messages: params.messages,
    tokens: params.tokens,
    cost: params.cost,
  };
  mkdirSync(dirname(params.sessionPath), { recursive: true });
  writeFileSync(params.sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
}

function stripImageMarkers(prompt: string, imagePaths: string[]): string {
  return prompt.replace(IMAGE_MARKER, (_match, rawPath: string) => {
    const imagePath = rawPath.trim();
    if (imagePath) imagePaths.push(imagePath);
    return '';
  });
}

function normalizeImagePath(rawPath: string, cwd: string): string {
  const unquoted = rawPath.replace(/^['"]|['"]$/g, '');
  if (unquoted === '~') return homedir();
  if (unquoted.startsWith('~/') || unquoted.startsWith('~\\')) {
    return join(homedir(), unquoted.slice(2));
  }
  return isAbsolute(unquoted) ? unquoted : pathResolve(cwd, unquoted);
}

async function buildImagePart(rawPath: string, cwd: string): Promise<ImageContentPart> {
  const filePath = normalizeImagePath(rawPath, cwd);
  const ext = extname(filePath).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`Unsupported image type for ${filePath}. Supported: png, jpg, jpeg, webp, gif.`);
  }
  const data = await readFile(filePath);
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${data.toString('base64')}` },
  };
}

async function buildUserMessage(prompt: string, cwd: string): Promise<ChatMessage> {
  const imagePaths: string[] = [];
  const text = stripImageMarkers(prompt, imagePaths).trim();
  if (imagePaths.length === 0) {
    return { role: 'user', content: prompt };
  }
  const content: ChatContentPart[] = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const imagePath of imagePaths) {
    content.push(await buildImagePart(imagePath, cwd));
  }
  return { role: 'user', content };
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const part = asRecord(item);
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  const record = asRecord(value);
  return typeof record?.text === 'string' ? record.text : '';
}

function extractReasoning(delta: Record<string, unknown>): string {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const value = delta[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** 與既有 tokens/cost 分開累計，壞 chunk 不得污染有效 job 用量。 */
function normalizeJobUsage(raw: CompletionUsage) {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const input = raw.prompt_tokens ?? raw.input_tokens;
  const output = raw.completion_tokens ?? raw.output_tokens;
  if (!valid(input) || !valid(output)) return undefined;
  const cached = raw.prompt_tokens_details?.cached_tokens;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens;
  return {
    // OpenAI prompt_tokens 已含快取，不能再加 cached。
    input_tokens: input,
    output_tokens: output,
    ...(valid(cached) ? { cached_input_tokens: cached } : {}),
    ...(valid(reasoning) ? { reasoning_output_tokens: reasoning } : {}),
    ...([cached, reasoning].some((value) => value !== undefined && !valid(value)) ? { incomplete: true } : {}),
    source: 'direct-api usage',
  };
}

function normalizeTokens(usage: CompletionUsage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const tokens: Record<string, number> = {};
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof input === 'number') tokens.input = input;
  if (typeof output === 'number') tokens.output = output;
  if (typeof reasoning === 'number') tokens.reasoning = reasoning;
  if (typeof cached === 'number') tokens.cached = cached;
  if (typeof usage.total_tokens === 'number') tokens.total = usage.total_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function normalizeCost(value: unknown): unknown {
  const record = asRecord(value);
  const direct = record?.cost ?? record?.total_cost ?? record?.totalCost;
  if (typeof direct === 'number' || typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') return direct;
  return undefined;
}

function redactApiKey(text: string, apiKey: string): string {
  return text.includes(apiKey) ? text.split(apiKey).join('[redacted]') : text;
}

function createEmptyTurn(): CompletionTurn {
  return {
    assistantText: '',
    reasoningText: '',
    toolCallAccumulators: [],
    toolCalls: [],
  };
}

function mergeCompletionUsage(
  current: CompletionUsage | undefined,
  next: CompletionUsage
): CompletionUsage {
  const merged: CompletionUsage = { ...(current || {}) };
  const numericKeys = [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'input_tokens',
    'output_tokens',
    'reasoning_tokens',
  ] as const;
  for (const key of numericKeys) {
    const value = next[key];
    if (typeof value === 'number') {
      const existing = typeof merged[key] === 'number' ? merged[key] as number : 0;
      merged[key] = existing + value;
    }
  }
  const cached = next.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number') {
    const existing = merged.prompt_tokens_details?.cached_tokens || 0;
    merged.prompt_tokens_details = {
      ...(merged.prompt_tokens_details || {}),
      cached_tokens: existing + cached,
    };
  }
  const reasoning = next.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number') {
    const existing = merged.completion_tokens_details?.reasoning_tokens || 0;
    merged.completion_tokens_details = {
      ...(merged.completion_tokens_details || {}),
      reasoning_tokens: existing + reasoning,
    };
  }
  return merged;
}

function mergeCost(current: unknown, next: unknown): unknown {
  if (next === undefined) return current;
  if (typeof current === 'number' && typeof next === 'number') return current + next;
  return next;
}

function captureUsageAndCost(parsed: any, state: StreamState): void {
  // OpenAI 的一般串流 chunk 會帶 usage:null；只有實際回報才參與累計。
  if (parsed?.usage !== undefined && parsed?.usage !== null) {
    const next = parsed.usage && normalizeJobUsage(parsed.usage);
    if (!next) state.incompleteUsage = true;
    else if (!state.jobUsage) state.jobUsage = next;
    else {
      const current = state.jobUsage;
      current.input_tokens += next.input_tokens;
      current.output_tokens += next.output_tokens;
      for (const key of ['cached_input_tokens', 'reasoning_output_tokens'] as const) {
        if (next[key] !== undefined) current[key] = (current[key] ?? 0) + next[key]!;
      }
      if (next.incomplete) current.incomplete = true;
    }
  }
  if (parsed?.usage) {
    state.usage = mergeCompletionUsage(state.usage, parsed.usage as CompletionUsage);
    state.cost = mergeCost(state.cost, normalizeCost(parsed.usage));
  }
  state.cost = mergeCost(state.cost, normalizeCost(parsed));
}

function appendToolCallDeltas(delta: Record<string, unknown>, turn: CompletionTurn): void {
  if (!Array.isArray(delta.tool_calls)) return;
  for (const rawCall of delta.tool_calls) {
    const call = asRecord(rawCall);
    if (!call) continue;
    const index = typeof call.index === 'number' ? call.index : turn.toolCallAccumulators.length;
    const accumulator = turn.toolCallAccumulators[index] || {};
    if (typeof call.id === 'string') accumulator.id = call.id;
    if (typeof call.type === 'string') accumulator.type = call.type;
    const fn = asRecord(call.function);
    if (fn) {
      accumulator.function = accumulator.function || {};
      if (typeof fn.name === 'string') accumulator.function.name = fn.name;
      if (typeof fn.arguments === 'string') {
        accumulator.function.arguments = `${accumulator.function.arguments || ''}${fn.arguments}`;
      }
    }
    turn.toolCallAccumulators[index] = accumulator;
  }
}

function normalizeToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  for (const rawCall of value) {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (!call || !name) continue;
    calls.push({
      id: typeof call.id === 'string' ? call.id : `call_${calls.length}`,
      type: 'function',
      function: {
        name,
        arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
      },
    });
  }
  return calls;
}

function parseXmlToolCalls(text: string): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  XML_TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = XML_TOOL_CALL_RE.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    const args: Record<string, string> = {};
    const paramRe = new RegExp(XML_PARAM_RE.source, XML_PARAM_RE.flags);
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRe.exec(body)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim();
    }
    calls.push({
      id: `xml_call_${calls.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return calls;
}

function stripXmlToolCallText(text: string): string {
  return text
    .replace(XML_WRAPPED_TOOL_CALL_RE, '')
    .replace(new RegExp(XML_TOOL_CALL_RE.source, XML_TOOL_CALL_RE.flags), '')
    .trim();
}

function finalizeStreamToolCalls(turn: CompletionTurn): void {
  if (turn.toolCalls.length > 0) return;
  turn.toolCalls = normalizeToolCalls(
    turn.toolCallAccumulators.map((call, index) => ({
      id: call.id || `call_${index}`,
      type: call.type || 'function',
      function: {
        name: call.function?.name || '',
        arguments: call.function?.arguments || '',
      },
    }))
  );
}

function handleCompletionChunk(parsed: any, state: StreamState, turn: CompletionTurn, io: DirectRunIO): void {
  captureUsageAndCost(parsed, state);
  if (!Array.isArray(parsed?.choices)) return;
  for (const choice of parsed.choices) {
    const delta = asRecord(choice?.delta);
    if (delta) {
      const textDelta = extractText(delta.content);
      if (textDelta) {
        state.assistantText += textDelta;
        turn.assistantText += textDelta;
        emitJsonLine(io.stdout, {
          type: 'assistant',
          session_id: state.sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: textDelta }] },
        });
      }
      const reasoningDelta = extractReasoning(delta);
      if (reasoningDelta) {
        state.reasoningText += reasoningDelta;
        turn.reasoningText += reasoningDelta;
        emitJsonLine(io.stdout, {
          type: 'reasoning',
          session_id: state.sessionId,
          delta: reasoningDelta,
        });
      }
      appendToolCallDeltas(delta, turn);
    }
    if (typeof choice?.finish_reason === 'string') {
      state.finishReason = choice.finish_reason;
      turn.finishReason = choice.finish_reason;
    }
  }
}

function handleCompletionObject(parsed: any, state: StreamState, turn: CompletionTurn, io: DirectRunIO): void {
  captureUsageAndCost(parsed, state);
  if (!Array.isArray(parsed?.choices)) return;
  const textParts: string[] = [];
  for (const choice of parsed.choices) {
    const message = asRecord(choice?.message);
    if (message) {
      const text = extractText(message.content);
      if (text) textParts.push(text);
      const reasoning = extractReasoning(message);
      if (reasoning) {
        state.reasoningText += reasoning;
        turn.reasoningText += reasoning;
      }
      turn.toolCalls.push(...normalizeToolCalls(message.tool_calls));
    }
    if (typeof choice?.finish_reason === 'string') {
      state.finishReason = choice.finish_reason;
      turn.finishReason = choice.finish_reason;
    }
  }
  const text = textParts.join('');
  if (text) {
    state.assistantText += text;
    turn.assistantText += text;
    emitJsonLine(io.stdout, {
      type: 'assistant',
      session_id: state.sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  }
}

async function consumeResponse(response: Response, state: StreamState, io: DirectRunIO): Promise<CompletionTurn> {
  const turn = createEmptyTurn();
  const reader = response.body?.getReader();
  if (!reader) {
    const parsed = await response.json();
    handleCompletionObject(parsed, state, turn, io);
    finalizeStreamToolCalls(turn);
    return turn;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let rawBody = '';
  let sawSseData = false;
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    sawSseData = true;
    try {
      handleCompletionChunk(JSON.parse(data), state, turn, io);
    } catch (error) {
      debugLog(`[Debug] Skipping invalid direct-api stream chunk: ${(error as Error).message}`);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawBody += chunk;
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  }
  const finalChunk = decoder.decode();
  if (finalChunk) {
    rawBody += finalChunk;
    buffer += finalChunk;
  }
  if (buffer) {
    for (const line of buffer.split(/\r?\n/)) {
      processLine(line);
    }
  }
  if (!sawSseData && rawBody.trim()) {
    handleCompletionObject(JSON.parse(rawBody), state, turn, io);
  }
  finalizeStreamToolCalls(turn);
  return turn;
}

function buildAssistantMessage(turn: CompletionTurn, replayReasoning: boolean): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: turn.assistantText || (turn.toolCalls.length > 0 ? null : ''),
  };
  if (turn.toolCalls.length > 0) {
    message.tool_calls = turn.toolCalls;
  }
  /*
    用 `turn.reasoningText`（這一輪）而不是 `state.reasoningText`（整次 run 的累積）——
    後者會讓第二輪把第一輪的推理再附一次，越滾越長。

    **每一個 assistant turn 都保存，不是只有帶 tool_calls 的那些。** 最後一輪沒有
    tool call 的回覆會寫進 session，下次用同一個 session_id 續聊時它就是歷史 assistant turn。
  */
  if (replayReasoning && turn.reasoningText) {
    message.reasoning_content = turn.reasoningText;
  }
  return message;
}

function parseToolArguments(toolCall: ChatToolCall): { ok: true; value: unknown } | { ok: false; message: string } {
  const raw = toolCall.function.arguments.trim();
  if (!raw) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      message: `Invalid JSON arguments for ${toolCall.function.name}: ${(error as Error).message}`,
    };
  }
}

/**
 * 值得重試的失敗：**服務端說「現在不行」，不是「你錯了」**。
 *
 * 429 是速率限制、5xx 是服務端問題（NVIDIA 的共享免費端點在尖峰會回
 * 503 `Service temporarily overloaded`，也出現過 500）。這兩類重試才有意義。
 *
 * 其餘 4xx 是我們送錯了——model 名打錯、金鑰無效、參數不合法。重試只是把同一個
 * 錯誤再送一次，白等而且多燒一次額度。
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * 服務端說什麼時候可以再來，就聽它的。
 *
 * `Retry-After` 有兩種格式：秒數，或 HTTP-date。NVIDIA 目前**不送這個 header**
 * （實測掃過 response headers，`Retry-After` 與 `X-RateLimit-*` 都沒有），
 * 但 OpenRouter 之類的供應商會送，聽它的比自己猜準。
 * 上限 60 秒：服務端叫我們等一小時的話，那該讓呼叫端知道，不是默默睡著。
 */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, 60_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // 等待中被取消要立刻醒來——否則 kill 一個 job 之後還要等退避睡完。
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 送出請求，遇到「服務端現在不行」時退避重試。
 *
 * **重試只包住建立請求這一段。** 一旦回了 200 開始讀串流，就不能重試了——
 * 那時候已經有內容經 `io.stdout` 送給呼叫端，重來會讓同一段回答出現兩次。
 * 串流中斷仍然是失敗，這是刻意的範圍限制。
 *
 * 每次重試都發一個 `retry` 事件到 stdout：靜默重試會讓「這個 job 很慢」
 * 跟「這個 job 卡住了」長得一模一樣，而呼叫端是 AI，它只看得到工具回傳。
 */
async function fetchWithRetry(
  params: { url: string; apiKey: string; io: DirectRunIO; retry?: RetryConfig },
  requestBody: Record<string, unknown>
): Promise<Response> {
  const { maxRetries, initialDelayMs } = params.retry ?? DEFAULT_RETRY;
  let lastStatus = 0;
  let lastErrorText = '';

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(params.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: params.io.signal,
      });
    } catch (error) {
      // 呼叫端取消不是失敗，別把它重試成四次。
      if ((error as Error).name === 'AbortError') throw error;
      if (attempt >= maxRetries) throw error;
      lastStatus = 0;
      lastErrorText = (error as Error).message;
      await backoff(params, attempt, initialDelayMs, null, lastStatus, lastErrorText);
      continue;
    }

    if (response.ok) return response;

    const errorText = redactApiKey(await response.text(), params.apiKey);
    if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
      params.io.stderr(`[direct-api] HTTP ${response.status}: ${errorText}\n`);
      throw new Error(`direct-api request failed with HTTP ${response.status}`);
    }
    lastStatus = response.status;
    lastErrorText = errorText;
    await backoff(params, attempt, initialDelayMs, retryAfterMs(response), lastStatus, lastErrorText);
  }
}

async function backoff(
  params: { io: DirectRunIO },
  attempt: number,
  initialDelayMs: number,
  serverHintMs: number | null,
  status: number,
  errorText: string
): Promise<void> {
  // 指數退避加抖動。抖動是為了避免多個並行 job 撞在同一次重試上，
  // 一起退避、一起回來，把剛恢復的服務再打掛一次。
  const backoffMs = initialDelayMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * initialDelayMs);
  const delayMs = serverHintMs ?? backoffMs + jitter;
  emitJsonLine(params.io.stdout, {
    type: 'retry',
    attempt: attempt + 1,
    status: status || null,
    delay_ms: delayMs,
    from_retry_after: serverHintMs !== null,
    error: errorText.slice(0, 200),
  });
  debugLog(`[Debug][direct-api] HTTP ${status || 'network'}，${delayMs}ms 後重試（第 ${attempt + 1} 次）`);
  await sleep(delayMs, params.io.signal);
}

async function requestCompletion(params: {
  url: string;
  apiKey: string;
  modelName: string;
  messages: ChatMessage[];
  toolsEnabled: boolean;
  state: StreamState;
  io: DirectRunIO;
  extraBody?: Record<string, unknown>;
  retry?: RetryConfig;
}): Promise<CompletionTurn> {
  /*
    extra_body 先展開，框架自己的欄位**後**寫 —— 順序就是保護。

    ★ 這是第二層防護，不是主要防線：保留欄位在 normalizeExtraBody() 載入設定時
      就被擋掉了（見 RESERVED_EXTRA_BODY_KEYS），正常路徑上這裡永遠沒有東西可覆蓋。
      留著它是因為「誰先寫誰輸」這件事一旦被人重構成 Object.assign(requestBody, extraBody)，
      壞掉的方式會非常安靜。要修這類問題請去改載入端的驗證，不要只改這裡。
  */
  const requestBody: Record<string, unknown> = {
    ...(params.extraBody ?? {}),
    model: params.modelName,
    messages: params.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.toolsEnabled) {
    requestBody.tools = TOOL_DEFINITIONS;
  }

  const response = await fetchWithRetry(params, requestBody);
  return consumeResponse(response, params.state, params.io);
}

async function runDirect(cmd: BuiltCommand, io: DirectRunIO): Promise<void> {
  const config = cmd.directApi;
  if (!config) {
    throw new Error('Missing direct-api command configuration.');
  }

  const sessionId = resolveSessionId(cmd.sessionId);
  const sessionPath = resolveSessionPath(cmd.cwd, sessionId);
  const existing = readSession(sessionPath);
  const toolsEnabled = !NO_TOOLS_MARKER.test(cmd.prompt);
  const prompt = toolsEnabled ? cmd.prompt : cmd.prompt.replace(NO_TOOLS_MARKER, '');
  const userMessage = await buildUserMessage(prompt, cmd.cwd);
  const messages = [...(existing?.messages || []), userMessage];
  const state: StreamState = {
    sessionId,
    providerName: config.providerName,
    modelName: config.modelName,
    assistantText: '',
    reasoningText: '',
  };

  emitJsonLine(io.stdout, {
    type: 'session.started',
    session_id: sessionId,
    provider: config.providerName,
    model: config.modelName,
    tools_enabled: toolsEnabled,
  });

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let reachedLimit = true;
  let apiCalls = 0;
  for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS && apiCalls < MAX_API_CALLS; iteration++) {
    apiCalls += 1;
    const turn = await requestCompletion({
      url,
      apiKey: config.apiKey,
      modelName: config.modelName,
      messages,
      toolsEnabled,
      state,
      io,
      extraBody: config.extraBody,
      retry: config.retry,
    });
    if (toolsEnabled && turn.finishReason !== 'tool_calls' && turn.toolCalls.length === 0 && turn.assistantText) {
      const xmlToolCalls = parseXmlToolCalls(turn.assistantText);
      if (xmlToolCalls.length > 0) {
        debugLog(`[Debug][xml-fallback] Parsed ${xmlToolCalls.length} XML tool call(s).`);
        turn.toolCalls = xmlToolCalls;
        const strippedAssistantText = stripXmlToolCallText(turn.assistantText);
        state.assistantText = `${state.assistantText.slice(0, -turn.assistantText.length)}${strippedAssistantText}`;
        turn.assistantText = strippedAssistantText;
      }
    }
    messages.push(buildAssistantMessage(turn, config.replayReasoning === true));
    if (!toolsEnabled || turn.toolCalls.length === 0) {
      reachedLimit = false;
      break;
    }
    for (const toolCall of turn.toolCalls) {
      const parsedArgs = parseToolArguments(toolCall);
      const result = parsedArgs.ok
        ? executeTool(toolCall.function.name, parsedArgs.value, cmd.cwd)
        : { status: 'failed' as const, output: truncateText(parsedArgs.message) };
      emitJsonLine(io.stdout, {
        type: 'tool_use',
        session_id: sessionId,
        id: toolCall.id,
        tool: toolCall.function.name,
        input: parsedArgs.ok ? parsedArgs.value : { arguments: toolCall.function.arguments },
        status: result.status,
        output_preview: toolOutputPreview(result.output),
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.output,
      });
    }
  }

  if (reachedLimit) {
    state.finishReason = 'tool_loop_limit';
    io.stderr(`[direct-api] Reached maximum tool/API calls (${MAX_TOOL_LOOP_ITERATIONS}).\n`);
  }

  const tokens = normalizeTokens(state.usage);
  saveSession({
    sessionPath,
    existing,
    sessionId,
    providerName: config.providerName,
    modelName: config.modelName,
    messages,
    tokens,
    cost: state.cost,
  });

  emitJsonLine(io.stdout, {
    type: 'result',
    session_id: sessionId,
    provider: config.providerName,
    model: config.modelName,
    result: state.assistantText,
    ...(state.jobUsage ? { usage: { ...state.jobUsage, ...(state.incompleteUsage ? { incomplete: true } : {}) } } : {}),
    tokens,
    cost: state.cost,
    finish_reason: state.finishReason,
    session_path: sessionPath,
  });
}

export const directApiAgent: AgentDefinition = {
  id: 'direct-api',
  models: DIRECT_API_MODELS,
  /*
    ★ 這條路徑走 ~/.local/share/ai-cli/providers.json 的 API 金鑰，
      是**按量計費**——與 claude/codex/agy 走各自 CLI 登入的訂閱額度
      是不同的錢。消費端必須看得出差別，不能混在同一組選項裡。
  */
  billingRoute: 'metered-api',
  matchesModel: (model) => model.startsWith('or-') || model.startsWith('ds-'),
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for direct-api.',
  },
  buildCommand,
  parseOutput,
  spawnMode: 'direct',
  runDirect,
};
