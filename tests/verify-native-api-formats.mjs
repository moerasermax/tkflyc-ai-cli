/**
 * direct-api 的原生協定：providers.json `api_format` 的
 * `anthropic_messages`（POST {base}/v1/messages）與 `openai_responses`（POST {base}/responses）。
 *
 * **不打任何真實 API**（沒有金鑰，也會燒錢）：一律替換 globalThis.fetch，回傳依官方文件
 * 形狀手寫的 SSE 串流。所以這支測試證明的是「ai-cli 依文件組出的請求與解析邏輯」，
 * 不是「真實服務接受這些請求」——後者尚未實測，見 CHANGELOG。
 *
 * 守的東西：
 * - 未設 api_format 的既有 provider 仍走 /chat/completions，請求形狀不變。
 * - 未知 api_format fail-closed（丟錯），不默默退回 chat_completions。
 * - anthropic／openai 兩個 provider key 只寫 api_key 時的預設端點與協定；
 *   寫了 base_url 的同名既有設定維持 chat_completions。
 * - 純文字、一輪工具呼叫後續跑（tool_result／function_call_output 以 id 對應）、
 *   thinking／reasoning item 原樣重播。
 * - usage：串流內的累計值不重複加，跨請求才相加。
 * - HTTP 4xx 與串流 error 事件的訊息裡，金鑰被遮蔽；session 檔不含金鑰。
 *
 * 執行：npm run build && node tests/verify-native-api-formats.mjs
 */
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'aicli-native-api-'));
const realFetch = globalThis.fetch;
process.on('exit', () => {
  globalThis.fetch = realFetch;
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了，不要蓋掉原本的失敗原因 */
  }
});

const providersPath = join(tempRoot, 'providers.json');
process.env.AI_CLI_PROVIDERS_PATH = providersPath;
// 不讓測試機上真的 OpenCode auth.json 觸發自動遷移。
process.env.AI_CLI_OPENCODE_AUTH_PATH = join(tempRoot, 'no-such-opencode-auth.json');

function writeProviders(providers) {
  writeFileSync(providersPath, `${JSON.stringify({ providers }, null, 2)}\n`, 'utf-8');
}

// 動態 import 提到頂層：ok() 只吃同步函式（2026-09-08 假綠燈教訓）。
const { loadProvidersConfig, directApiAgent, resolveDirectApiModel } = await import('../dist/agents/direct-api.js');

let failures = 0;
let passes = 0;
function ok(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('ok() 只接受同步函式；async 會讓斷言錯誤被吞掉而永遠通過');
    }
    passes++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

const SECRET = 'sk-test-SUPER-SECRET-9f8e7d';

// ---------------------------------------------------------------- 假伺服器

function sse(events) {
  // 依官方串流格式：每個事件一個 `event:` 行＋一個 `data:` 行，空行分隔。
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function streamResponse(text, status = 200) {
  const encoder = new TextEncoder();
  // 刻意切成小塊送，驗證跨 chunk 的行緩衝。
  const bytes = encoder.encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37));
        c.close();
      },
    }),
    { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } }
  );
}

/** 依序回應 replies 裡的每一筆；記下每次請求的 url、headers、body。 */
function installFetch(replies) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) }, body: JSON.parse(String(init.body)) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof reply === 'function' ? reply() : streamResponse(reply.body, reply.status ?? 200);
  };
  return calls;
}

let sessionCounter = 0;
async function runModel({ providerName, providerModel, prompt = 'hi', replies }) {
  const calls = installFetch(replies);
  const cmd = directApiAgent.buildCommand({
    cliPath: '',
    cwd: tempRoot,
    prompt,
    resolvedModel: providerModel,
    rawModel: `${providerName}-${providerModel}`,
    reasoningEffort: '',
    providerName,
    providerModel,
    sessionId: `native${++sessionCounter}`,
  });
  let stdout = '';
  let stderr = '';
  let threw = null;
  try {
    await directApiAgent.runDirect(cmd, {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      signal: undefined,
    });
  } catch (err) {
    threw = err;
  }
  const events = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const result = events.find((e) => e.type === 'result');
  return { calls, stdout, stderr, threw, events, result, cmd };
}

// ---------------------------------------------------------------- 設定：api_format 解析
console.log('\n[providers.json api_format]');

ok('未設 api_format 的既有 provider：設定物件不長出 api_format（＝chat_completions）', () => {
  writeProviders({ nv: { base_url: 'https://mock.nv.test/v1', api_key: 'k' } });
  assert.strictEqual(loadProvidersConfig().providers.nv.api_format, undefined);
});

ok('★ 未知 api_format → 丟錯並點名 provider 與值（不退回 chat_completions）', () => {
  writeProviders({ nv: { base_url: 'https://mock.nv.test/v1', api_key: 'k', api_format: 'anthropic_mesages' } });
  assert.throws(() => loadProvidersConfig(), (err) => {
    assert.match(err.message, /provider "nv" api_format must be one of/);
    assert.ok(err.message.includes('anthropic_mesages'), `訊息要帶出錯的值：${err.message}`);
    return true;
  });
});

ok('★ 未知 api_format 的 provider 被點名派工時，路由也丟錯（不被 claude catch-all 接走）', () => {
  writeProviders({ nv: { base_url: 'https://mock.nv.test/v1', api_key: 'k', api_format: 'responses' } });
  assert.throws(() => resolveDirectApiModel('nv-some/model'), /api_format must be one of/);
  assert.strictEqual(directApiAgent.matchesModel('nv-some/model'), true, '要由 direct-api 報錯，不能掉進 claude');
});

ok('api_format 不是字串 → 丟錯', () => {
  writeProviders({ nv: { base_url: 'https://mock.nv.test/v1', api_key: 'k', api_format: 1 } });
  assert.throws(() => loadProvidersConfig(), /api_format must be one of/);
});

ok('明確寫 chat_completions 等同沒寫', () => {
  writeProviders({ nv: { base_url: 'https://mock.nv.test/v1', api_key: 'k', api_format: 'chat_completions' } });
  assert.strictEqual(loadProvidersConfig().providers.nv.api_format, undefined);
});

ok('anthropic 只寫 api_key → 預設端點 api.anthropic.com、預設 anthropic_messages', () => {
  writeProviders({ anthropic: { api_key: 'k' } });
  const cfg = loadProvidersConfig().providers.anthropic;
  assert.strictEqual(cfg.base_url, 'https://api.anthropic.com');
  assert.strictEqual(cfg.api_format, 'anthropic_messages');
});

ok('openai 只寫 api_key → 預設端點 api.openai.com/v1、預設 openai_responses', () => {
  writeProviders({ openai: { api_key: 'k' } });
  const cfg = loadProvidersConfig().providers.openai;
  assert.strictEqual(cfg.base_url, 'https://api.openai.com/v1');
  assert.strictEqual(cfg.api_format, 'openai_responses');
});

ok('★ 既有的 openai／anthropic 設定（自己寫了 base_url、沒寫 api_format）維持 chat_completions', () => {
  // 改動前這兩個名字沒有內建端點，能載入的既有設定一定寫了 base_url，而且只能走 /chat/completions。
  writeProviders({
    openai: { base_url: 'https://proxy.example.test/v1', api_key: 'k' },
    anthropic: { base_url: 'https://proxy.example.test/v1', api_key: 'k' },
  });
  const { providers } = loadProvidersConfig();
  assert.strictEqual(providers.openai.api_format, undefined);
  assert.strictEqual(providers.anthropic.api_format, undefined);
});

ok('自訂名稱可以明確選原生協定', () => {
  writeProviders({ gateway: { base_url: 'https://gw.example.test', api_key: 'k', api_format: 'anthropic_messages' } });
  assert.strictEqual(loadProvidersConfig().providers.gateway.api_format, 'anthropic_messages');
});

for (const [format, key] of [
  ['anthropic_messages', 'system'],
  ['openai_responses', 'instructions'],
  ['openai_responses', 'input'],
  ['openai_responses', 'previous_response_id'],
]) {
  ok(`${format} 的框架欄位 "${key}" 不准由 extra_body／model_extra_body 設定`, () => {
    writeProviders({ p: { base_url: 'https://x.test', api_key: 'k', api_format: format, extra_body: { [key]: 'x' } } });
    assert.throws(() => loadProvidersConfig(), new RegExp(`may not set "${key}"`));
    writeProviders({
      p: { base_url: 'https://x.test', api_key: 'k', api_format: format, model_extra_body: { m: { [key]: 'x' } } },
    });
    assert.throws(() => loadProvidersConfig(), new RegExp(`may not set "${key}"`));
  });
}

ok('chat_completions 的 extra_body 規則不變（system 之類仍可設）', () => {
  writeProviders({ nv: { base_url: 'https://mock.nv.test/v1', api_key: 'k', extra_body: { system: 'x', input: 1 } } });
  assert.deepStrictEqual(loadProvidersConfig().providers.nv.extra_body, { system: 'x', input: 1 });
});

ok('★ OpenCode 自動遷移不因新預設端點多搬 anthropic／openai 金鑰', () => {
  const sub = mkdtempSync(join(tempRoot, 'migrate-'));
  const authPath = join(sub, 'auth.json');
  const target = join(sub, 'providers.json');
  writeFileSync(
    authPath,
    JSON.stringify({
      openrouter: { type: 'api', key: 'or-key' },
      anthropic: { type: 'api', key: 'anthropic-key' },
      openai: { type: 'api', key: 'openai-key' },
    }),
    'utf-8'
  );
  const prevAuth = process.env.AI_CLI_OPENCODE_AUTH_PATH;
  process.env.AI_CLI_OPENCODE_AUTH_PATH = authPath;
  process.env.AI_CLI_PROVIDERS_PATH = target;
  try {
    loadProvidersConfig();
    const written = JSON.parse(readFileSync(target, 'utf-8'));
    assert.deepStrictEqual(Object.keys(written.providers), ['openrouter']);
    assert.ok(!JSON.stringify(written).includes('api_format'), '遷移輸出不該多出欄位');
  } finally {
    process.env.AI_CLI_OPENCODE_AUTH_PATH = prevAuth;
    process.env.AI_CLI_PROVIDERS_PATH = providersPath;
  }
});

ok('provider 前綴路由：anthropic-<model>／openai-<model>', () => {
  writeProviders({ anthropic: { api_key: 'k' }, openai: { api_key: 'k' } });
  assert.deepStrictEqual(resolveDirectApiModel('anthropic-claude-x'), { providerName: 'anthropic', modelName: 'claude-x' });
  assert.deepStrictEqual(resolveDirectApiModel('openai-gpt-x-codex'), { providerName: 'openai', modelName: 'gpt-x-codex' });
});

// ---------------------------------------------------------------- 既有 chat_completions 不變
console.log('\n[未設 api_format → /chat/completions]');

writeProviders({ nv: { base_url: 'https://mock.nv.test/v1/', api_key: SECRET } });
const chat = await runModel({
  providerName: 'nv',
  providerModel: 'nvidia/x',
  replies: [
    {
      body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n` +
        'data: [DONE]\n\n',
    },
  ],
});
ok('★ 打 {base}/chat/completions、Bearer、stream_options 照舊', () => {
  assert.strictEqual(chat.threw, null);
  assert.strictEqual(chat.calls.length, 1);
  assert.strictEqual(chat.calls[0].url, 'https://mock.nv.test/v1/chat/completions');
  assert.strictEqual(chat.calls[0].headers.authorization, `Bearer ${SECRET}`);
  assert.strictEqual(chat.calls[0].headers['x-api-key'], undefined);
  assert.deepStrictEqual(Object.keys(chat.calls[0].body).sort(), ['messages', 'model', 'stream', 'stream_options', 'tools']);
  assert.strictEqual(chat.result.result, 'pong');
  assert.strictEqual(chat.result.usage.input_tokens, 3);
});
ok('chat_completions 的 session 不帶 native 欄位', () => {
  const session = JSON.parse(readFileSync(chat.result.session_path, 'utf-8'));
  assert.ok(!JSON.stringify(session).includes('"native"'));
});

// ---------------------------------------------------------------- Anthropic Messages
console.log('\n[anthropic_messages]');

function anthropicText(text, usageStart, usageDelta, stop = 'end_turn') {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: usageStart } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(3) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: usageDelta },
    { type: 'message_stop' },
  ]);
}

writeProviders({ anthropic: { api_key: SECRET } });
const aText = await runModel({
  providerName: 'anthropic',
  providerModel: 'claude-test',
  prompt: '[no-tools] say hello',
  replies: [{ body: anthropicText('hello world', { input_tokens: 12, output_tokens: 1 }, { output_tokens: 5 }) }],
});
ok('純文字：端點、header、body 形狀', () => {
  assert.strictEqual(aText.threw, null, String(aText.threw));
  const call = aText.calls[0];
  assert.strictEqual(call.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(call.headers['x-api-key'], SECRET);
  assert.strictEqual(call.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(call.headers.authorization, undefined, 'Anthropic 不送 Bearer');
  assert.strictEqual(call.body.model, 'claude-test');
  assert.strictEqual(call.body.max_tokens, 8192, 'max_tokens 必填，要有預設');
  assert.strictEqual(call.body.stream, true);
  assert.strictEqual(call.body.stream_options, undefined);
  assert.strictEqual(call.body.tools, undefined, '[no-tools] 不送 tools');
  assert.strictEqual(call.body.messages.length, 1);
  assert.strictEqual(call.body.messages[0].role, 'user');
  assert.strictEqual(call.body.messages[0].content[0].type, 'text');
});
ok('純文字：result、finish_reason、usage（output 取 message_delta 的累計值，不加 message_start 的 1）', () => {
  assert.strictEqual(aText.result.result, 'hello world');
  assert.strictEqual(aText.result.finish_reason, 'stop');
  assert.strictEqual(aText.result.usage.input_tokens, 12);
  assert.strictEqual(aText.result.usage.output_tokens, 5);
  assert.deepStrictEqual(aText.result.tokens, { input: 12, output: 5, total: 17 });
});

writeProviders({ gw: { base_url: 'https://gw.example.test/v1/', api_key: 'k', api_format: 'anthropic_messages' } });
const aGw = await runModel({
  providerName: 'gw',
  providerModel: 'm',
  prompt: '[no-tools] x',
  replies: [{ body: anthropicText('ok!', { input_tokens: 1, output_tokens: 1 }, { output_tokens: 1 }) }],
});
ok('base_url 已以 /v1 結尾時不重複加 /v1', () => {
  assert.strictEqual(aGw.threw, null, String(aGw.threw));
  assert.strictEqual(aGw.calls[0].url, 'https://gw.example.test/v1/messages');
});

// 一輪工具呼叫：thinking（含 signature）＋ tool_use（input 分兩段送），再跑一輪拿最終文字。
writeProviders({ anthropic: { api_key: SECRET, extra_body: { max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 } } } });
const aTool = await runModel({
  providerName: 'anthropic',
  providerModel: 'claude-test',
  prompt: 'list the dir',
  replies: [
    {
      body: sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_a', type: 'message', role: 'assistant', content: [],
            usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 1 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should list.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'list_dir', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th": "."}' } },
        { type: 'content_block_stop', index: 1 },
        // 較新的 API 會在 message_delta 再給一次 input／cache 的累計值——不可再加一次。
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 25 },
        },
        { type: 'message_stop' },
      ]),
    },
    { body: anthropicText('done listing', { input_tokens: 200, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 1 }, { output_tokens: 7 }) },
  ],
});
ok('工具迴圈：送兩次請求、工具真的執行', () => {
  assert.strictEqual(aTool.threw, null, String(aTool.threw));
  assert.strictEqual(aTool.calls.length, 2);
  const toolEvent = aTool.events.find((e) => e.type === 'tool_use');
  assert.ok(toolEvent, '要有 tool_use 事件');
  assert.strictEqual(toolEvent.tool, 'list_dir');
  assert.deepStrictEqual(toolEvent.input, { path: '.' }, 'input_json_delta 要拼起來');
  assert.strictEqual(toolEvent.status, 'completed');
  assert.strictEqual(aTool.result.result, 'done listing');
});
ok('第一輪 body：tools 用 input_schema、extra_body 覆蓋 max_tokens', () => {
  const body = aTool.calls[0].body;
  assert.strictEqual(body.max_tokens, 2048);
  assert.deepStrictEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
  const listDir = body.tools.find((t) => t.name === 'list_dir');
  assert.ok(listDir && listDir.input_schema && listDir.input_schema.type === 'object');
  assert.strictEqual(listDir.parameters, undefined);
  assert.strictEqual(listDir.type, undefined);
});
ok('★ 第二輪 body：assistant 原樣重播 thinking（含 signature）＋tool_use，tool_result 以 id 對應、role:user', () => {
  const msgs = aTool.calls[1].body.messages;
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  const [thinking, toolUse] = msgs[1].content;
  assert.deepStrictEqual(thinking, { type: 'thinking', thinking: 'I should list.', signature: 'SIG123' });
  assert.deepStrictEqual(toolUse, { type: 'tool_use', id: 'toolu_01', name: 'list_dir', input: { path: '.' } });
  assert.strictEqual(msgs[2].content.length, 1);
  assert.strictEqual(msgs[2].content[0].type, 'tool_result');
  assert.strictEqual(msgs[2].content[0].tool_use_id, 'toolu_01');
  assert.strictEqual(typeof msgs[2].content[0].content, 'string');
});
ok('★ usage：同一請求內取累計值、跨請求相加；input 含快取讀寫（OpenAI 語意）', () => {
  // 請求 1：100 + 40 + 10 = 150 in、25 out；請求 2：200 + 40 + 0 = 240 in、7 out。
  assert.strictEqual(aTool.result.usage.input_tokens, 390);
  assert.strictEqual(aTool.result.usage.output_tokens, 32);
  assert.strictEqual(aTool.result.usage.cached_input_tokens, 80);
  assert.strictEqual(aTool.result.usage.incomplete, undefined);
  assert.deepStrictEqual(aTool.result.tokens, { input: 390, output: 32, cached: 80, cache_creation: 10, total: 422 });
});
ok('thinking 以 reasoning 事件輸出', () => {
  assert.ok(aTool.events.some((e) => e.type === 'reasoning' && e.delta === 'I should list.'));
});

// session 續跑：同一 session 再跑一次，歷史（含原生內容）要被重播。
const resumeCalls = installFetch([{ body: anthropicText('again', { input_tokens: 1, output_tokens: 1 }, { output_tokens: 1 }) }]);
{
  const cmd = directApiAgent.buildCommand({
    cliPath: '', cwd: tempRoot, prompt: 'continue', resolvedModel: 'claude-test', rawModel: 'anthropic-claude-test',
    reasoningEffort: '', providerName: 'anthropic', providerModel: 'claude-test', sessionId: aTool.result.session_id,
  });
  await directApiAgent.runDirect(cmd, { stdout: () => {}, stderr: () => {}, signal: undefined });
}
ok('session 續跑：歷史完整重播、角色交替', () => {
  const msgs = resumeCalls[0].body.messages;
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.strictEqual(msgs[1].content[0].signature, 'SIG123');
  assert.strictEqual(msgs[3].content[0].text, 'done listing');
});

writeProviders({ anthropic: { api_key: SECRET, retry: { max_retries: 0 } } });
const a401 = await runModel({
  providerName: 'anthropic',
  providerModel: 'claude-test',
  replies: [{ status: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${SECRET}` } }) }],
});
ok('★ HTTP 401：丟錯、stderr 有狀態碼，金鑰被遮蔽', () => {
  assert.ok(a401.threw, '要丟錯');
  assert.match(a401.stderr, /HTTP 401/);
  assert.ok(a401.stderr.includes('[redacted]'));
  assert.ok(!a401.stderr.includes(SECRET), `stderr 洩漏金鑰：${a401.stderr}`);
  assert.ok(!String(a401.threw.message).includes(SECRET));
  assert.strictEqual(a401.calls.length, 1, '4xx 不重試');
});

const aStreamErr = await runModel({
  providerName: 'anthropic',
  providerModel: 'claude-test',
  replies: [
    {
      body: sse([
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'error', error: { type: 'overloaded_error', message: `Overloaded (key ${SECRET})` } },
      ]),
    },
  ],
});
ok('★ 串流 error 事件：丟錯、帶錯誤類型、金鑰被遮蔽', () => {
  assert.ok(aStreamErr.threw, '串流 error 不能被當成空答案');
  assert.match(aStreamErr.threw.message, /overloaded_error/);
  assert.ok(!aStreamErr.threw.message.includes(SECRET));
  assert.ok(aStreamErr.threw.message.includes('[redacted]'));
});

// ---------------------------------------------------------------- OpenAI Responses
console.log('\n[openai_responses]');

function responsesText(text, usage, id = 'resp_1') {
  return sse([
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text.slice(0, 2) },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text.slice(2) },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
        usage,
      },
    },
  ]);
}

writeProviders({ openai: { api_key: SECRET } });
const rText = await runModel({
  providerName: 'openai',
  providerModel: 'gpt-test-codex',
  replies: [
    {
      body: responsesText('pong!', {
        input_tokens: 50, input_tokens_details: { cached_tokens: 10 },
        output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 70,
      }),
    },
  ],
});
ok('純文字：端點、Bearer、body 用 input（不是 messages）、tools 為扁平 function 且 strict:false', () => {
  assert.strictEqual(rText.threw, null, String(rText.threw));
  const call = rText.calls[0];
  assert.strictEqual(call.url, 'https://api.openai.com/v1/responses');
  assert.strictEqual(call.headers.authorization, `Bearer ${SECRET}`);
  assert.strictEqual(call.body.model, 'gpt-test-codex');
  assert.strictEqual(call.body.stream, true);
  assert.strictEqual(call.body.messages, undefined);
  assert.strictEqual(call.body.stream_options, undefined);
  assert.deepStrictEqual(call.body.input.map((i) => i.role), ['user']);
  const readFile = call.body.tools.find((t) => t.name === 'read_file');
  assert.strictEqual(readFile.type, 'function');
  assert.strictEqual(readFile.strict, false);
  assert.ok(readFile.parameters && readFile.parameters.type === 'object');
});
ok('純文字：result、usage（usage 只在 response.completed）', () => {
  assert.strictEqual(rText.result.result, 'pong!');
  assert.strictEqual(rText.result.finish_reason, 'stop');
  assert.deepStrictEqual(
    { ...rText.result.usage, source: undefined },
    { input_tokens: 50, output_tokens: 20, cached_input_tokens: 10, reasoning_output_tokens: 5, source: undefined }
  );
});

const rTool = await runModel({
  providerName: 'openai',
  providerModel: 'gpt-test-codex',
  prompt: 'list it',
  replies: [
    {
      body: sse([
        { type: 'response.created', response: { id: 'resp_a', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
        {
          type: 'response.output_item.added', output_index: 1,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'list_dir', arguments: '', status: 'in_progress' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path"' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: ':"."}' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: '{"path":"."}' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_a',
            status: 'completed',
            output: [
              { type: 'reasoning', id: 'rs_1', summary: [] },
              { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'list_dir', arguments: '{"path":"."}', status: 'completed' },
            ],
            usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 8 }, total_tokens: 42 },
          },
        },
      ]),
    },
    { body: responsesText('listed', { input_tokens: 70, input_tokens_details: { cached_tokens: 30 }, output_tokens: 4, total_tokens: 74 }, 'resp_b') },
  ],
});
ok('工具迴圈：function_call 被執行、續跑拿到最終文字', () => {
  assert.strictEqual(rTool.threw, null, String(rTool.threw));
  assert.strictEqual(rTool.calls.length, 2);
  const toolEvent = rTool.events.find((e) => e.type === 'tool_use');
  assert.strictEqual(toolEvent.id, 'call_abc', '內部 tool call id 要用 call_id');
  assert.deepStrictEqual(toolEvent.input, { path: '.' });
  assert.strictEqual(rTool.result.result, 'listed');
});
ok('★ 第二輪 input：reasoning item 與 function_call 原樣放回，function_call_output 以 call_id 對應', () => {
  const input = rTool.calls[1].body.input;
  assert.deepStrictEqual(input.map((i) => i.type ?? `role:${i.role}`), ['role:user', 'reasoning', 'function_call', 'function_call_output']);
  assert.strictEqual(input[2].call_id, 'call_abc');
  assert.strictEqual(input[3].call_id, 'call_abc');
  assert.strictEqual(typeof input[3].output, 'string');
  assert.strictEqual(rTool.calls[1].body.previous_response_id, undefined, '每輪送完整 input，不靠伺服器端串接');
});
ok('★ usage：跨請求相加（30+70 in、12+4 out、cached 0+30、reasoning 8）', () => {
  assert.strictEqual(rTool.result.usage.input_tokens, 100);
  assert.strictEqual(rTool.result.usage.output_tokens, 16);
  assert.strictEqual(rTool.result.usage.cached_input_tokens, 30);
  assert.strictEqual(rTool.result.usage.reasoning_output_tokens, 8);
});

writeProviders({ openai: { api_key: SECRET, retry: { max_retries: 0 } } });
const r400 = await runModel({
  providerName: 'openai',
  providerModel: 'gpt-test-codex',
  replies: [{ status: 400, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${SECRET}`, type: 'invalid_request_error' } }) }],
});
ok('★ HTTP 400：丟錯、不重試、金鑰被遮蔽', () => {
  assert.ok(r400.threw);
  assert.strictEqual(r400.calls.length, 1);
  assert.match(r400.stderr, /HTTP 400/);
  assert.ok(!r400.stderr.includes(SECRET), `stderr 洩漏金鑰：${r400.stderr}`);
  assert.ok(r400.stderr.includes('[redacted]'));
});

const rFailed = await runModel({
  providerName: 'openai',
  providerModel: 'gpt-test-codex',
  replies: [
    {
      body: sse([
        { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
        { type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'server_error', message: `boom ${SECRET}` } } },
      ]),
    },
  ],
});
ok('★ response.failed：丟錯、帶錯誤碼、金鑰被遮蔽', () => {
  assert.ok(rFailed.threw);
  assert.match(rFailed.threw.message, /server_error/);
  assert.ok(!rFailed.threw.message.includes(SECRET));
});

// ---------------------------------------------------------------- 串流提前結束／incomplete／遮蔽順序（2026-11-18 稽核回歸）
console.log('\n[串流提前結束與遮蔽順序]');

// Responses：function_call 已逐段送完參數，但連線在 response.completed 之前斷掉。
const rEof = await runModel({
  providerName: 'openai',
  providerModel: 'gpt-test-codex',
  prompt: 'list',
  replies: [
    {
      body: sse([
        { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'function_call', id: 'fc_eof', call_id: 'call_eof', name: 'list_dir', arguments: '', status: 'in_progress' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_eof', output_index: 0, delta: '{"path":"."}' },
      ]),
    },
    { body: responsesText('should not be reached', { input_tokens: 1, output_tokens: 1, total_tokens: 2 }) },
  ],
});
ok('★ Responses 串流在 response.completed 前 EOF：丟錯、工具未執行、不再送第二輪', () => {
  assert.ok(rEof.threw, '提前結束的串流不能被當成完整回應');
  assert.match(String(rEof.threw.message), /ended before response\.completed/);
  assert.ok(!rEof.events.some((e) => e.type === 'tool_use'), '不得執行未完成回應裡的工具');
  assert.strictEqual(rEof.calls.length, 1);
});

// Anthropic：tool_use block 已開始、參數送了一段，沒有 message_delta(stop_reason)／message_stop 就 EOF。
writeProviders({ anthropic: { api_key: SECRET, retry: { max_retries: 0 } } });
const aEof = await runModel({
  providerName: 'anthropic',
  providerModel: 'claude-test-model',
  prompt: 'list',
  replies: [
    {
      body: sse([
        { type: 'message_start', message: { id: 'msg_eof', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial answer' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_eof', name: 'list_dir', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"."}' } },
      ]),
    },
    { body: anthropicText('should not be reached', { input_tokens: 1, output_tokens: 1 }, { output_tokens: 1 }) },
  ],
});
ok('★ Anthropic 串流沒有 message_stop 就 EOF：丟錯、工具未執行、部分文字不當成完整結果', () => {
  assert.ok(aEof.threw, '提前結束的串流不能被當成完整回應');
  assert.match(String(aEof.threw.message), /ended before message_stop/);
  assert.ok(!aEof.events.some((e) => e.type === 'tool_use'), '不得執行未完成回應裡的 tool_use');
  assert.strictEqual(aEof.calls.length, 1);
  assert.strictEqual(aEof.result, undefined, '不該產生 result 事件');
});

// Responses：response.incomplete（max_output_tokens），output 裡的 function_call 本身也是 incomplete。
writeProviders({ openai: { api_key: SECRET, retry: { max_retries: 0 } } });
const rIncomplete = await runModel({
  providerName: 'openai',
  providerModel: 'gpt-test-codex',
  prompt: 'list',
  replies: [
    {
      body: sse([
        { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'function_call', id: 'fc_inc', call_id: 'call_inc', name: 'list_dir', arguments: '', status: 'in_progress' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_inc', output_index: 0, delta: '{"pa' },
        {
          type: 'response.incomplete',
          response: {
            id: 'r',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'function_call', id: 'fc_inc', call_id: 'call_inc', name: 'list_dir', arguments: '{"pa', status: 'incomplete' }],
            usage: { input_tokens: 9, output_tokens: 16, total_tokens: 25 },
          },
        },
      ]),
    },
    { body: responsesText('should not be reached', { input_tokens: 1, output_tokens: 1, total_tokens: 2 }) },
  ],
});
ok('★ response.incomplete＋incomplete function_call：finish_reason=length、工具未執行', () => {
  assert.strictEqual(rIncomplete.threw, null, String(rIncomplete.threw));
  assert.strictEqual(rIncomplete.calls.length, 1, '不得執行工具後續跑');
  assert.ok(!rIncomplete.events.some((e) => e.type === 'tool_use'), '不得執行 incomplete 的 function_call');
  assert.strictEqual(rIncomplete.result.finish_reason, 'length');
});
ok('response.incomplete 的 usage 照實計入（該請求實際消耗）', () => {
  assert.strictEqual(rIncomplete.result.usage.input_tokens, 9);
  assert.strictEqual(rIncomplete.result.usage.output_tokens, 16);
});

// debug 開啟時，壞掉的 chunk 內容不可原樣進 stderr。debugMode 在模組載入時讀 env，所以開子行程。
{
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const protocolsUrl = pathToFileURL(join(process.cwd(), 'dist', 'agents', 'direct-api-protocols.js')).href;
  const childCode = `
    const { anthropicMessagesAdapter } = await import(${JSON.stringify(protocolsUrl)});
    const secret = ${JSON.stringify(SECRET)};
    const lines = [
      'data: ' + secret,
      'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      'data: ' + JSON.stringify({ type: 'message_stop' }),
    ];
    const response = new Response(lines.join('\\n\\n') + '\\n\\n');
    await anthropicMessagesAdapter.consume(response, {
      onText() {}, onReasoning() {}, redact: (t) => t.split(secret).join('[redacted]'),
    });
    console.log('CHILD_DONE');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    env: { ...process.env, MCP_CLAUDE_DEBUG: 'true' },
    encoding: 'utf-8',
  });
  ok('★ debug 開啟：無效 JSON chunk 等於金鑰時，stderr 不含金鑰也不含金鑰片段', () => {
    assert.strictEqual(child.status, 0, `子行程失敗：${child.stderr}`);
    assert.ok(child.stdout.includes('CHILD_DONE'));
    assert.ok(child.stderr.includes('Skipping invalid direct-api stream chunk'), `debug 訊息要有輸出：${child.stderr}`);
    assert.ok(!child.stderr.includes(SECRET.slice(0, 8)), `stderr 洩漏金鑰：${child.stderr}`);
  });
}

// streamError：先 redact 再截斷。讓金鑰剛好跨過 2000 字元的截斷點。
{
  const prefix = 'direct-api anthropic_messages stream error (overloaded_error): ';
  const pad = 'x'.repeat(1990 - prefix.length);
  writeProviders({ anthropic: { api_key: SECRET, retry: { max_retries: 0 } } });
  const aLong = await runModel({
    providerName: 'anthropic',
    providerModel: 'claude-test-model',
    replies: [{ body: sse([{ type: 'error', error: { type: 'overloaded_error', message: `${pad}${SECRET} tail` } }]) }],
  });
  ok('★ 長錯誤訊息：金鑰跨 2000 字元截斷點時不殘留片段', () => {
    assert.ok(aLong.threw);
    const message = String(aLong.threw.message);
    assert.ok(message.length <= 2000, `訊息仍要截斷：${message.length}`);
    assert.ok(!message.includes(SECRET.slice(0, 6)), `殘留金鑰片段：…${message.slice(-30)}`);
  });

  // 不是 SSE、也不是 JSON 的回應：raw.slice(0, 500) 同樣要先 redact。
  const aGarbage = await runModel({
    providerName: 'anthropic',
    providerModel: 'claude-test-model',
    replies: [() => new Response(`${'y'.repeat(495)}${SECRET}`, { status: 200 })],
  });
  ok('★ 無法解析的回應本文：金鑰跨 500 字元截斷點時不殘留片段', () => {
    assert.ok(aGarbage.threw);
    const message = String(aGarbage.threw.message);
    assert.match(message, /unparseable response body/);
    assert.ok(!message.includes(SECRET.slice(0, 5)), `殘留金鑰片段：…${message.slice(-30)}`);
  });
}

// ---------------------------------------------------------------- 金鑰不進 session 檔
ok('★ 所有 session 檔都不含金鑰', () => {
  const dir = join(tempRoot, '.tmp', 'api_sessions');
  assert.ok(existsSync(dir));
  const files = readdirSync(dir);
  assert.ok(files.length >= 4, `預期至少 4 個 session 檔，實際 ${files.length}`);
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf-8');
    assert.ok(!text.includes(SECRET), `${file} 含金鑰`);
  }
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
