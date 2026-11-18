/**
 * direct-api 的原生協定轉接層：Anthropic Messages API 與 OpenAI Responses API。
 *
 * ── 為什麼是「轉接層」而不是兩支新 agent ──
 * agent loop、工具執行、session 儲存、重試、金鑰遮蔽都已在 direct-api.ts 裡，而且各自
 * 有踩過坑才長出來的細節（重試只包建立請求、身分鎖、XML fallback……）。複製一份 loop
 * 等於把那些細節分叉成三份。所以這裡只做協定差異的兩件事：
 *   1. 把 direct-api 內部的對話歷史（Chat Completions 形狀，session 檔也是這個形狀）
 *      轉成該協定的 request body；
 *   2. 把該協定的 SSE 串流解析成「這一輪的文字／推理／工具呼叫／用量」。
 * 選哪個協定由 providers.json 的 `api_format` 決定，見 direct-api.ts 的 normalizeProviderConfig。
 *
 * ── 原生回覆的保存（native） ──
 * 兩個協定都有「必須原樣回送」的內容：Anthropic 開 extended thinking 時，工具迴圈裡上一輪的
 * thinking block（含 signature）要原樣送回；Responses API 的推理模型則建議把上一輪的
 * output items（含 reasoning item）整包放回 input。Chat Completions 形狀裝不下這些，所以每個
 * assistant turn 另存一份 `native`（協定名＋原始 items），下一輪若協定相同就原樣重播，
 * 不同（例如中途改了 api_format）就退回用通用欄位重建。
 */

import { debugLog } from '../core/debug.js';

export const API_FORMATS = ['chat_completions', 'anthropic_messages', 'openai_responses'] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

export function isApiFormat(value: unknown): value is ApiFormat {
  return typeof value === 'string' && (API_FORMATS as readonly string[]).includes(value);
}

/**
 * 各協定**額外**由框架自組、不准 extra_body 覆蓋的欄位（通用的 model/messages/stream/
 * stream_options/tools 在 direct-api.ts 的 RESERVED_EXTRA_BODY_KEYS）。
 * - anthropic：`system` 由對話歷史的 system 訊息組成。
 * - responses：`input`／`instructions` 同理；`previous_response_id` 會讓伺服器端再接一段歷史，
 *   與我們每輪送完整 input 的做法重疊，對話會被重複餵一次。
 */
export const FORMAT_RESERVED_EXTRA_BODY_KEYS: Record<ApiFormat, readonly string[]> = {
  chat_completions: [],
  anthropic_messages: ['system'],
  openai_responses: ['input', 'instructions', 'previous_response_id'],
};

/** Anthropic 的 `max_tokens` 必填；沒在 extra_body 設定時用這個值。 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
export const ANTHROPIC_VERSION = '2023-06-01';

// ---------------------------------------------------------------- 共用型別（與 direct-api.ts 的 ChatMessage 結構相容）

export interface ProtocolToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ProtocolNative {
  format: ApiFormat;
  items: unknown[];
}

type ProtocolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ProtocolMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | ProtocolContentPart[] | null;
  tool_calls?: ProtocolToolCall[];
  tool_call_id?: string;
  native?: ProtocolNative;
}

export interface ProtocolToolDefinition {
  type: string;
  function: { name: string; description: string; parameters: unknown };
}

/** 正規化成 OpenAI Chat Completions 的 usage 形狀，好讓 direct-api 既有的累計與回報直接沿用。 */
export interface ProtocolUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ProtocolTurn {
  toolCalls: ProtocolToolCall[];
  /** 對齊 Chat Completions 的用語：stop／tool_calls／length，其餘原樣。 */
  finishReason?: string;
  /** 這一個請求的最終用量（已處理串流裡的累計值，不會重複加）。沒拿到就是 undefined。 */
  usage?: ProtocolUsage;
  /** 要原樣重播的原生 items；空的就不存。 */
  native?: unknown[];
}

export interface ProtocolSink {
  onText(delta: string): void;
  onReasoning(delta: string): void;
  /** 把 api_key 換成 [redacted]；所有要往外丟的錯誤文字都要先過這裡。 */
  redact(text: string): string;
}

export interface ProtocolAdapter {
  format: ApiFormat;
  endpoint(baseUrl: string): string;
  headers(apiKey: string): Record<string, string>;
  buildBody(params: {
    modelName: string;
    messages: readonly ProtocolMessage[];
    tools?: readonly ProtocolToolDefinition[];
    extraBody?: Record<string, unknown>;
  }): Record<string, unknown>;
  consume(response: Response, sink: ProtocolSink): Promise<ProtocolTurn>;
}

// ---------------------------------------------------------------- 小工具

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function textOf(content: ProtocolMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * 讀完一個 SSE 回應，每個 `data:` 的 JSON 交給 onEvent。
 *
 * JSON 壞掉的那一行跳過（與 chat completions 的解析器同一個政策），但 **onEvent 自己丟的錯
 * 要往上傳**——那是串流裡的 error 事件，吞掉就變成「回了一個空答案」。
 * 回傳原始內容，給「其實不是 SSE、是一整包 JSON」的回應用。
 */
async function readSse(response: Response, onEvent: (event: any) => void): Promise<{ sawData: boolean; raw: string }> {
  let raw = '';
  let sawData = false;
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return; // event:/id:/註解行：type 已在 data 裡，不需要
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    sawData = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      /*
        只記長度，不記 error.message：V8 的訊息會引用 chunk 開頭（例如 `"sk-test-SU"... is not
        valid JSON`），而且是**截斷過**的——金鑰只剩前綴時 redact 比對不到，片段照樣進 stderr。
      */
      debugLog(`[Debug] Skipping invalid direct-api stream chunk (${data.length} chars, not valid JSON)`);
      return;
    }
    onEvent(parsed);
  };

  const reader = response.body?.getReader();
  if (!reader) {
    raw = await response.text();
    for (const line of raw.split(/\r?\n/)) processLine(line);
    return { sawData, raw };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  }
  const tail = decoder.decode();
  raw += tail;
  buffer += tail;
  if (buffer) for (const line of buffer.split(/\r?\n/)) processLine(line);
  return { sawData, raw };
}

function streamError(sink: ProtocolSink, label: string, detail: unknown): Error {
  const record = asRecord(detail);
  const inner = asRecord(record?.error) ?? record;
  const type = typeof inner?.type === 'string' ? inner.type : typeof inner?.code === 'string' ? inner.code : 'error';
  const message = typeof inner?.message === 'string' ? inner.message : JSON.stringify(detail ?? null);
  // 先 redact 再截斷：反過來的話，金鑰跨過截斷點時只剩前綴，redact 比對不到，片段會殘留。
  return new Error(sink.redact(`direct-api ${label} stream error (${type}): ${message}`).slice(0, 2000));
}

/** 回應本文的前 limit 個字元，先 redact 再截斷（理由同 streamError）。 */
function redactedPreview(sink: ProtocolSink, raw: string, limit = 500): string {
  return sink.redact(raw).slice(0, limit);
}

/**
 * 串流在終止事件之前就結束（連線被切、代理逾時、伺服器中途掛掉）。
 *
 * 這時手上的文字與工具呼叫都是**半截的**：文字可能停在句子中間，工具呼叫的參數可能還沒送完，
 * 就算參數剛好是合法 JSON，也不代表模型打算在這裡停下來。所以不回傳 toolCalls、不當成完整結果，
 * 直接丟錯——與串流 error 事件、HTTP 錯誤走同一條路（runDirect 往上拋，job 以錯誤結束），
 * 不在這裡重試：重試只包建立請求（fetchWithRetry），串流已經送出的文字無法收回。
 */
function truncatedStreamError(sink: ProtocolSink, label: string, terminal: string): Error {
  return new Error(sink.redact(`direct-api ${label}: stream ended before ${terminal}; refusing to use a partial response`));
}

// ---------------------------------------------------------------- Anthropic Messages API

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown[] };

function anthropicUserBlocks(content: ProtocolMessage['content']): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: unknown[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const url = part.image_url?.url ?? '';
    const inline = parseDataUrl(url);
    blocks.push(
      inline
        ? { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } }
        : { type: 'image', source: { type: 'url', url } }
    );
  }
  return blocks;
}

function anthropicAssistantBlocks(message: ProtocolMessage): unknown[] {
  if (message.native?.format === 'anthropic_messages' && Array.isArray(message.native.items) && message.native.items.length > 0) {
    return message.native.items;
  }
  const blocks: unknown[] = [];
  const text = textOf(message.content);
  if (text) blocks.push({ type: 'text', text });
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseJsonObject(call.function.arguments) ?? {},
    });
  }
  return blocks;
}

/**
 * 內部歷史 → Anthropic messages。
 *
 * - system 訊息抽到頂層 `system`。
 * - 連續的 tool 訊息合併成**一則** user 訊息、裡面是多個 tool_result block——Anthropic 要求
 *   對上一輪所有 tool_use 的結果都放在緊接著的那一則 user 訊息裡。
 * - 相鄰同 role 的訊息合併（例如 session 停在 tool_loop_limit、下一次 run 又接一則 user），
 *   tool_result 本來就排在前面，合併後仍在 content 開頭。
 * - 空的 assistant 訊息（沒文字也沒工具）直接略過：Anthropic 拒收空的 text block。
 */
export function toAnthropicMessages(messages: readonly ProtocolMessage[]): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage['role'], blocks: unknown[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const text = textOf(message.content);
        if (text) systemParts.push(text);
        break;
      }
      case 'user':
        push('user', anthropicUserBlocks(message.content));
        break;
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: textOf(message.content) }]);
        break;
      case 'assistant':
        push('assistant', anthropicAssistantBlocks(message));
        break;
    }
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

const ANTHROPIC_USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

/**
 * 把一個 usage 物件**覆寫**進目前這個請求的用量。
 *
 * 不是加總：message_start 給起始值，message_delta 的 usage 官方定義為**累計值**
 * （output_tokens 是到目前為止的總數；較新的 API 連 input/cache 也會在這裡再給一次）。
 * 加總就會把 input 算兩次、output 多算 message_start 那 1 個 token。
 */
function overwriteAnthropicUsage(target: Partial<Record<(typeof ANTHROPIC_USAGE_KEYS)[number], number>>, usage: unknown): void {
  const record = asRecord(usage);
  if (!record) return;
  for (const key of ANTHROPIC_USAGE_KEYS) {
    if (isCount(record[key])) target[key] = record[key];
  }
}

/**
 * Anthropic 的 input_tokens **不含**快取讀寫；OpenAI 的 prompt_tokens 含快取。
 * 正規化成 OpenAI 語意：prompt = input + cache_read + cache_creation，cached = cache_read。
 */
export function normalizeAnthropicUsage(
  usage: Partial<Record<(typeof ANTHROPIC_USAGE_KEYS)[number], number>>
): ProtocolUsage | undefined {
  if (!isCount(usage.input_tokens) || !isCount(usage.output_tokens)) return undefined;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheCreation = usage.cache_creation_input_tokens;
  const prompt = usage.input_tokens + (cacheRead ?? 0) + (cacheCreation ?? 0);
  const details: NonNullable<ProtocolUsage['prompt_tokens_details']> = {};
  if (isCount(cacheRead)) details.cached_tokens = cacheRead;
  if (isCount(cacheCreation)) details.cache_creation_tokens = cacheCreation;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output_tokens,
    total_tokens: prompt + usage.output_tokens,
    ...(Object.keys(details).length > 0 ? { prompt_tokens_details: details } : {}),
  };
}

function mapAnthropicStopReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    default:
      return reason;
  }
}

interface AnthropicBlockState {
  [key: string]: unknown;
  type: string;
  _json?: string;
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  format: 'anthropic_messages',

  /** 依規格是 `{base}/v1/messages`；base 已經以 `/v1` 結尾時不再重複加。 */
  endpoint(baseUrl) {
    const base = trimBase(baseUrl);
    return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  },

  headers(apiKey) {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    };
  },

  buildBody({ modelName, messages, tools, extraBody }) {
    const converted = toAnthropicMessages(messages);
    // max_tokens 必填，但允許 extra_body 覆蓋——所以它排在 extra_body 前面；框架欄位排在後面。
    const body: Record<string, unknown> = {
      max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
      ...(extraBody ?? {}),
      model: modelName,
      messages: converted.messages,
      stream: true,
    };
    if (converted.system) body.system = converted.system;
    if (tools && tools.length > 0) {
      body.tools = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
    }
    return body;
  },

  async consume(response, sink) {
    const blocks: AnthropicBlockState[] = [];
    const usage: Partial<Record<(typeof ANTHROPIC_USAGE_KEYS)[number], number>> = {};
    let stopReason: string | undefined;
    // 收到 message_stop，或 message_delta 已帶 stop_reason（之後只剩 message_stop，內容已完整）。
    let terminated = false;

    const blockAt = (index: unknown, fallbackType: string): AnthropicBlockState => {
      const i = typeof index === 'number' ? index : blocks.length;
      if (!blocks[i]) blocks[i] = { type: fallbackType };
      return blocks[i];
    };

    const onEvent = (event: any): void => {
      switch (event?.type) {
        case 'message_start':
          overwriteAnthropicUsage(usage, event.message?.usage);
          break;
        case 'content_block_start': {
          const start = asRecord(event.content_block);
          if (!start || typeof start.type !== 'string') break;
          const i = typeof event.index === 'number' ? event.index : blocks.length;
          const block: AnthropicBlockState = { ...start, type: start.type };
          if (block.type === 'tool_use') block._json = '';
          blocks[i] = block;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) sink.onText(block.text);
          break;
        }
        case 'content_block_delta': {
          const delta = asRecord(event.delta);
          if (!delta) break;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            const block = blockAt(event.index, 'text');
            block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
            sink.onText(delta.text);
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const block = blockAt(event.index, 'tool_use');
            block._json = `${block._json ?? ''}${delta.partial_json}`;
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            const block = blockAt(event.index, 'thinking');
            block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
            sink.onReasoning(delta.thinking);
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            const block = blockAt(event.index, 'thinking');
            block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
          }
          break;
        }
        case 'message_delta':
          if (typeof event.delta?.stop_reason === 'string') {
            stopReason = event.delta.stop_reason;
            terminated = true;
          }
          overwriteAnthropicUsage(usage, event.usage);
          break;
        case 'message_stop':
          terminated = true;
          break;
        case 'error':
          throw streamError(sink, 'anthropic_messages', event);
        default:
          // ping、content_block_stop：沒有要累計的內容。
          break;
      }
    };

    const { sawData, raw } = await readSse(response, onEvent);
    if (!sawData && raw.trim()) {
      // 不是 SSE（例如中間的代理把 stream 關掉了）：當成一整包 Message 物件處理。
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`direct-api anthropic_messages: unparseable response body: ${redactedPreview(sink, raw)}`);
      }
      if (parsed?.type === 'error') throw streamError(sink, 'anthropic_messages', parsed);
      overwriteAnthropicUsage(usage, parsed?.usage);
      stopReason = typeof parsed?.stop_reason === 'string' ? parsed.stop_reason : stopReason;
      for (const rawBlock of Array.isArray(parsed?.content) ? parsed.content : []) {
        const block = asRecord(rawBlock);
        if (!block || typeof block.type !== 'string') continue;
        blocks.push({ ...block, type: block.type });
        if (block.type === 'text' && typeof block.text === 'string' && block.text) sink.onText(block.text);
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) sink.onReasoning(block.thinking);
      }
      // 非串流的整包 Message 本身就是完整回應。
      terminated = true;
    }
    if (!terminated) throw truncatedStreamError(sink, 'anthropic_messages', 'message_stop');

    const toolCalls: ProtocolToolCall[] = [];
    const native: unknown[] = [];
    for (const block of blocks) {
      if (!block) continue;
      const { _json, ...clean } = block;
      if (clean.type === 'tool_use') {
        let input: Record<string, unknown> | null = asRecord(clean.input) ?? {};
        let args = JSON.stringify(input);
        if (typeof _json === 'string' && _json.trim()) {
          input = parseJsonObject(_json);
          // 參數 JSON 壞掉：保留原字串，讓工具迴圈回報「參數不是合法 JSON」給模型，而不是默默當成 {}。
          args = input ? JSON.stringify(input) : _json;
        }
        clean.input = input ?? {};
        toolCalls.push({
          id: typeof clean.id === 'string' ? clean.id : `toolu_${toolCalls.length}`,
          type: 'function',
          function: { name: typeof clean.name === 'string' ? clean.name : '', arguments: args },
        });
      }
      // Anthropic 拒收空的 text block；沒有任何 delta 的 text block 不要存進重播內容。
      if (clean.type === 'text' && !clean.text) continue;
      native.push(clean);
    }

    return {
      toolCalls: toolCalls.filter((call) => call.function.name),
      finishReason: mapAnthropicStopReason(stopReason),
      usage: normalizeAnthropicUsage(usage),
      ...(native.length > 0 ? { native } : {}),
    };
  },
};

// ---------------------------------------------------------------- OpenAI Responses API

/**
 * 內部歷史 → Responses API 的 input items。
 *
 * - system 訊息抽到 `instructions`。
 * - assistant 的 tool_calls → `function_call` items；tool 訊息 → `function_call_output`，
 *   兩者以 `call_id` 對應（內部的 tool_call id 就是 call_id）。
 * - 同協定產生的 assistant turn 有 native output items 時原樣放回（含 reasoning item）。
 */
export function toResponsesInput(messages: readonly ProtocolMessage[]): { instructions: string; input: unknown[] } {
  const instructionParts: string[] = [];
  const input: unknown[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const text = textOf(message.content);
        if (text) instructionParts.push(text);
        break;
      }
      case 'user': {
        if (typeof message.content === 'string' || !Array.isArray(message.content)) {
          input.push({ role: 'user', content: textOf(message.content) });
          break;
        }
        input.push({
          role: 'user',
          content: message.content.map((part) =>
            part.type === 'text'
              ? { type: 'input_text', text: part.text }
              : { type: 'input_image', image_url: part.image_url?.url ?? '' }
          ),
        });
        break;
      }
      case 'tool':
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id ?? '',
          output: textOf(message.content),
        });
        break;
      case 'assistant': {
        if (message.native?.format === 'openai_responses' && Array.isArray(message.native.items) && message.native.items.length > 0) {
          input.push(...message.native.items);
          break;
        }
        const text = textOf(message.content);
        if (text) input.push({ role: 'assistant', content: text });
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      }
    }
  }
  return { instructions: instructionParts.join('\n\n'), input };
}

/** Responses 的 usage 已是 OpenAI 語意（input_tokens 含快取），只換欄位名。 */
export function normalizeResponsesUsage(raw: unknown): ProtocolUsage | undefined {
  const usage = asRecord(raw);
  if (!usage || !isCount(usage.input_tokens) || !isCount(usage.output_tokens)) return undefined;
  const cached = asRecord(usage.input_tokens_details)?.cached_tokens;
  const reasoning = asRecord(usage.output_tokens_details)?.reasoning_tokens;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: isCount(usage.total_tokens) ? usage.total_tokens : usage.input_tokens + usage.output_tokens,
    ...(isCount(cached) ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(isCount(reasoning) ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

function responsesToolCall(item: Record<string, any>, index: number): ProtocolToolCall | null {
  if (item.type !== 'function_call' || typeof item.name !== 'string' || !item.name) return null;
  const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${index}`;
  return {
    id: callId,
    type: 'function',
    function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '' },
  };
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  format: 'openai_responses',

  endpoint(baseUrl) {
    return `${trimBase(baseUrl)}/responses`;
  },

  headers(apiKey) {
    return {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
  },

  buildBody({ modelName, messages, tools, extraBody }) {
    const converted = toResponsesInput(messages);
    const body: Record<string, unknown> = {
      ...(extraBody ?? {}),
      model: modelName,
      input: converted.input,
      stream: true,
    };
    if (converted.instructions) body.instructions = converted.instructions;
    if (tools && tools.length > 0) {
      /*
        `strict: false` 要明寫：Responses API 的 function tool 不寫 strict 時依文件會走嚴格模式，
        嚴格模式要求每個 property 都列進 required 且 additionalProperties:false——
        read_file 的 offset/limit 是選填，會被整包拒絕。
      */
      body.tools = tools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: false,
      }));
    }
    return body;
  },

  async consume(response, sink) {
    const pending = new Map<number, Record<string, any>>();
    let final: Record<string, any> | null = null;
    let sawTextDelta = false;

    const pendingFor = (event: any): Record<string, any> | undefined => {
      if (typeof event.output_index === 'number' && pending.has(event.output_index)) return pending.get(event.output_index);
      for (const item of pending.values()) if (item.id === event.item_id) return item;
      return undefined;
    };

    const onEvent = (event: any): void => {
      switch (event?.type) {
        case 'response.output_text.delta':
          if (typeof event.delta === 'string' && event.delta) {
            sawTextDelta = true;
            sink.onText(event.delta);
          }
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (typeof event.delta === 'string' && event.delta) sink.onReasoning(event.delta);
          break;
        case 'response.output_item.added':
        case 'response.output_item.done': {
          const item = asRecord(event.item);
          if (item?.type === 'function_call' && typeof event.output_index === 'number') {
            const previous = pending.get(event.output_index);
            pending.set(event.output_index, {
              ...item,
              arguments: typeof item.arguments === 'string' && item.arguments ? item.arguments : previous?.arguments ?? '',
            });
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          const item = pendingFor(event);
          if (item && typeof event.delta === 'string') item.arguments = `${item.arguments ?? ''}${event.delta}`;
          break;
        }
        case 'response.function_call_arguments.done': {
          const item = pendingFor(event);
          if (item && typeof event.arguments === 'string') item.arguments = event.arguments;
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          final = asRecord(event.response);
          break;
        case 'response.failed':
          throw streamError(sink, 'openai_responses', asRecord(event.response)?.error ?? event);
        case 'error':
          throw streamError(sink, 'openai_responses', event);
        default:
          break;
      }
    };

    const { sawData, raw } = await readSse(response, onEvent);
    if (!sawData && raw.trim()) {
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`direct-api openai_responses: unparseable response body: ${redactedPreview(sink, raw)}`);
      }
      if (parsed?.error) throw streamError(sink, 'openai_responses', parsed.error);
      final = asRecord(parsed);
    }

    const finalResponse = final as Record<string, any> | null;
    // 沒有 response.completed／response.incomplete（非 SSE 時是整包 Response 物件）：串流半途斷了。
    if (!finalResponse) throw truncatedStreamError(sink, 'openai_responses', 'response.completed');
    const incomplete = finalResponse.status === 'incomplete';
    const output: unknown[] = Array.isArray(finalResponse.output) ? finalResponse.output : [];

    // 串流沒送 text delta（例如非串流回應）時，從最終 output 補出文字。
    if (!sawTextDelta) {
      for (const rawItem of output) {
        const item = asRecord(rawItem);
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          const p = asRecord(part);
          if (p?.type === 'output_text' && typeof p.text === 'string' && p.text) sink.onText(p.text);
        }
      }
    }

    /*
      incomplete 優先於工具呼叫：回應被截斷（max_output_tokens、content_filter…）時，裡面的
      function_call 可能參數沒送完，就算送完了也不是模型完整的這一輪——一律不執行，
      finish_reason 照實回報截斷原因。completed 的回應裡個別標 incomplete 的 function_call 也不執行。
      工具呼叫以最終 output 為準（權威版本）；completed 但 output 是空的才用逐段累計的。
    */
    const sourceItems = output.length > 0 ? output : [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    const toolCalls: ProtocolToolCall[] = [];
    if (!incomplete) {
      for (const rawItem of sourceItems) {
        const item = asRecord(rawItem);
        if (!item || item.status === 'incomplete') continue;
        const call = responsesToolCall(item, toolCalls.length);
        if (call) toolCalls.push(call);
      }
    }

    let finishReason: string;
    if (incomplete) {
      const reason = asRecord(finalResponse.incomplete_details)?.reason;
      finishReason = reason === 'max_output_tokens' ? 'length' : typeof reason === 'string' ? reason : 'incomplete';
    } else if (toolCalls.length > 0) finishReason = 'tool_calls';
    else finishReason = 'stop';

    /*
      原生重播：incomplete 回應裡的 function_call 沒有執行、不會有對應的 function_call_output，
      原樣放回 input 會讓下一次續跑被 API 以「找不到 tool output」拒絕——這種情況不存 native，
      改由通用欄位（文字）重建。
    */
    const replayable = !(incomplete && output.some((item) => asRecord(item)?.type === 'function_call'));

    return {
      toolCalls,
      finishReason,
      // response.incomplete 的 usage 仍是這個請求實際消耗（已計費）的 token，照實計入；
      // 它只影響用量統計，finish_reason 已標為截斷原因，不會被當成 completed。
      usage: normalizeResponsesUsage(finalResponse.usage),
      ...(output.length > 0 && replayable ? { native: output } : {}),
    };
  },
};

export function adapterForFormat(format: ApiFormat | undefined): ProtocolAdapter | null {
  switch (format) {
    case 'anthropic_messages':
      return anthropicMessagesAdapter;
    case 'openai_responses':
      return openaiResponsesAdapter;
    default:
      return null;
  }
}
