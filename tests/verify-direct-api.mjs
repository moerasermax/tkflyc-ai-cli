// direct-api 基本驗證：mock fetch，不打真實 provider。
// 執行前需先 npm run build。
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessService } from '../dist/core/process-service.js';
import { WORKER_CONTEXT } from '../dist/core/worker-context.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'aicli-direct-api-'));
// 清理掛在 exit 上，不能只放在最後一行 —— assertion 中途拋錯時那行根本跑不到，
// 每次失敗都會在 %TEMP% 留一個目錄。
process.on('exit', () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了，不要蓋掉原本的失敗原因 */
  }
});
const providersPath = join(tempRoot, 'providers.json');
writeFileSync(
  providersPath,
  JSON.stringify(
    {
      providers: {
        openrouter: {
          base_url: 'https://mock.openrouter.test/api/v1',
          api_key: 'test-key',
        },
      },
    },
    null,
    2
  )
);
writeFileSync(
  join(tempRoot, 'package.json'),
  JSON.stringify({ name: 'mock-package', version: '9.9.9' }, null, 2)
);
process.env.AI_CLI_PROVIDERS_PATH = providersPath;

let capturedUrl = '';
const capturedBodies = [];
let capturedAuthorization = '';
const xmlReportPath = '.tmp/plan027_qwen_tool_test.md';
const xmlReportContent = '# Report content here\n\nGenerated through XML fallback.';
const xmlReportOutputPreview = `Wrote ${xmlReportContent.length} chars to ${join('.tmp', 'plan027_qwen_tool_test.md')}.`;

function streamResponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

globalThis.fetch = async (url, init = {}) => {
  capturedUrl = String(url);
  const requestBody = JSON.parse(String(init.body));
  capturedBodies.push(requestBody);
  capturedAuthorization = String(init.headers.authorization || init.headers.Authorization || '');
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const firstUser = messages.find((message) => message?.role === 'user');
  const firstUserContent = typeof firstUser?.content === 'string' ? firstUser.content.replace(`${WORKER_CONTEXT}\n\n`, '') : '';

  if (firstUserContent === 'Read package.json and tell me the version' && !messages.some((message) => message?.role === 'tool')) {
    return streamResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read',
                  type: 'function',
                  function: { name: 'read_file', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"path":"package.json"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]);
  }
  if (messages.some((message) => message?.tool_call_id === 'call_read')) {
    return streamResponse([
      { choices: [{ delta: { content: 'Version ' } }] },
      { choices: [{ delta: { content: '9.9.9' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ]);
  }
  if (firstUserContent === 'Write XML fallback report' && !messages.some((message) => message?.role === 'tool')) {
    return streamResponse([
      {
        choices: [
          {
            delta: {
              content: `<tool_call>
<function=write_file>
<parameter=path>${xmlReportPath}</parameter>
<parameter=content>
${xmlReportContent}
</parameter>
</function>
</tool_call>`,
            },
            finish_reason: 'stop',
          },
        ],
      },
      { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]);
  }
  if (messages.some((message) => message?.tool_call_id === 'xml_call_0')) {
    return streamResponse([
      { choices: [{ delta: { content: 'XML fallback wrote report' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } },
    ]);
  }
  // Gemini API（OpenAI-compatible）的形狀：tool call 整筆在一個 chunk、沒有 index、
  // finish_reason 是 stop，thought_signature 放在 extra_content.google；下一輪少送就 400。
  if (firstUserContent === 'Gemini signature probe' && !messages.some((message) => message?.role === 'tool')) {
    return streamResponse([
      {
        choices: [
          {
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  extra_content: { google: { thought_signature: 'SIG-abc' } },
                  function: { arguments: '{"path":"package.json"}', name: 'read_file' },
                  id: 'call_gemini',
                  type: 'function',
                },
              ],
            },
          },
        ],
        usage: { completion_tokens: 20, prompt_tokens: 90, total_tokens: 154 },
      },
      { choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop' }], usage: { completion_tokens: 26, prompt_tokens: 90, total_tokens: 160 } },
    ]);
  }
  // 預付額度用完：Gemini 回的是排版過的多行 JSON。
  if (firstUserContent === 'Payment probe') {
    return new Response(
      '[{\n  "error": {\n    "code": 402,\n    "message": "Your prepayment credits are depleted.",\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}\n]',
      { status: 402, headers: { 'content-type': 'application/json' } }
    );
  }
  // 沒有 index、同一個 id 分兩個 chunk：參數要接起來，extra_content 要兩層合併。
  if (firstUserContent === 'Chunked no-index probe' && !messages.some((message) => message?.role === 'tool')) {
    return streamResponse([
      { choices: [{ delta: { tool_calls: [{ id: 'call_ck', type: 'function', function: { name: 'read_file', arguments: '{"path":' }, extra_content: { google: { part: 1 } } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'call_ck', function: { arguments: '"package.json"}' }, extra_content: { google: { thought_signature: 'SIG-ck' } } }] }, finish_reason: 'stop' }] },
    ]);
  }
  if (messages.some((message) => message?.tool_call_id === 'call_ck')) {
    const assistant = messages.find((message) => message?.role === 'assistant' && Array.isArray(message.tool_calls));
    const call = assistant?.tool_calls?.[0];
    const good = assistant?.tool_calls?.length === 1
      && call?.function?.arguments === '{"path":"package.json"}'
      && call?.extra_content?.google?.part === 1
      && call?.extra_content?.google?.thought_signature === 'SIG-ck';
    return good
      ? streamResponse([{ choices: [{ delta: { content: 'chunk ok' }, finish_reason: 'stop' }] }])
      : new Response(JSON.stringify({ error: { message: `bad replay ${JSON.stringify(assistant?.tool_calls)}` } }), { status: 400 });
  }
  if (messages.some((message) => message?.tool_call_id === 'call_gemini')) {
    const assistant = messages.find((message) => message?.role === 'assistant' && Array.isArray(message.tool_calls));
    if (assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature !== 'SIG-abc') {
      return new Response(
        JSON.stringify({ error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    return streamResponse([{ choices: [{ delta: { content: 'signed ok' }, finish_reason: 'stop' }] }]);
  }
  return streamResponse([
    { choices: [{ delta: { content: 'Hello without tools' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
};

const service = new ProcessService({
  cliPaths: {
    claude: 'CLAUDE',
    codex: 'CODEX',
    antigravity: 'AGY',
  },
});

const started = await service.startProcess({
  workFolder: tempRoot,
  model: 'or-test/model',
  prompt: 'Read package.json and tell me the version',
});

assert.strictEqual(started.agent, 'direct-api');
assert.strictEqual(started.status, 'started');

const [result] = await service.waitForProcesses([started.pid], 5, true);
assert.strictEqual(result.status, 'completed');
assert.strictEqual(result.exitCode, 0);
assert.strictEqual(result.agentOutput.message, 'Version 9.9.9');
assert.deepStrictEqual(result.agentOutput.tokens, { input: 7, output: 3, total: 10 });
assert.deepStrictEqual(result.agentOutput.tools, [
  {
    tool: 'read_file',
    input: { path: 'package.json' },
    status: 'completed',
    output_preview: '{\n  "name": "mock-package",\n  "version": "9.9.9"\n}',
  },
]);
assert.ok(result.session_id, 'session_id should be returned');
assert.ok(existsSync(result.agentOutput.sessionPath), 'session file should be written');

assert.strictEqual(capturedUrl, 'https://mock.openrouter.test/api/v1/chat/completions');
assert.strictEqual(capturedAuthorization, 'Bearer test-key');
assert.strictEqual(capturedBodies.length, 2);
assert.strictEqual(capturedBodies[0].model, 'test/model');
assert.strictEqual(capturedBodies[0].stream, true);
assert.ok(capturedBodies[0].tools.some((tool) => tool.function?.name === 'read_file'));
assert.deepStrictEqual(capturedBodies[0].messages, [
  { role: 'user', content: `${WORKER_CONTEXT}\n\nRead package.json and tell me the version` },
]);
assert.strictEqual(capturedBodies[1].messages[1].role, 'assistant');
assert.deepStrictEqual(capturedBodies[1].messages[1].tool_calls, [
  {
    id: 'call_read',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"package.json"}' },
  },
]);
assert.strictEqual(capturedBodies[1].messages[2].role, 'tool');
assert.strictEqual(capturedBodies[1].messages[2].tool_call_id, 'call_read');
assert.ok(capturedBodies[1].messages[2].content.includes('"version": "9.9.9"'));

const savedSession = JSON.parse(readFileSync(result.agentOutput.sessionPath, 'utf-8'));
assert.deepStrictEqual(savedSession.messages.map((message) => message.role), [
  'user',
  'assistant',
  'tool',
  'assistant',
]);

const noToolsStarted = await service.startProcess({
  workFolder: tempRoot,
  model: 'or-test/model',
  prompt: '[no-tools] Say hello without tools',
});
const [noToolsResult] = await service.waitForProcesses([noToolsStarted.pid], 5, true);
assert.strictEqual(noToolsResult.status, 'completed');
assert.strictEqual(capturedBodies.length, 3);
assert.strictEqual(capturedBodies[2].tools, undefined);
assert.deepStrictEqual(capturedBodies[2].messages, [
  { role: 'user', content: `${WORKER_CONTEXT}\n\nSay hello without tools` },
]);

const xmlStarted = await service.startProcess({
  workFolder: tempRoot,
  model: 'or-test/model',
  prompt: 'Write XML fallback report',
});
const [xmlResult] = await service.waitForProcesses([xmlStarted.pid], 5, true);
assert.strictEqual(xmlResult.status, 'completed');
assert.strictEqual(xmlResult.exitCode, 0);
assert.strictEqual(xmlResult.agentOutput.message, 'XML fallback wrote report');
assert.deepStrictEqual(xmlResult.agentOutput.tools, [
  {
    tool: 'write_file',
    input: { path: xmlReportPath, content: xmlReportContent },
    status: 'completed',
    output_preview: xmlReportOutputPreview,
  },
]);
assert.strictEqual(readFileSync(join(tempRoot, xmlReportPath), 'utf-8'), xmlReportContent);
assert.strictEqual(capturedBodies.length, 5);
assert.deepStrictEqual(capturedBodies[4].messages[1], {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'xml_call_0',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: xmlReportPath, content: xmlReportContent }),
      },
    },
  ],
});
assert.strictEqual(capturedBodies[4].messages[2].role, 'tool');
assert.strictEqual(capturedBodies[4].messages[2].tool_call_id, 'xml_call_0');
assert.ok(capturedBodies[4].messages[2].content.includes(`Wrote ${xmlReportContent.length} chars`));

console.log('PASS: direct-api mock fetch route/output/session verified');

// ── catalog 的 routable 要跟著 providers.json 走（2026-09-10） ──────────────
// 舊的 matchesModel 寫死 `or-` / `ds-`，使用者自己設的 provider（例如 nv）
// 派得動、catalog 卻標 routable:false。這組斷言鎖住「標示與現實一致」。
{
  const { directApiAgent } = await import('../dist/agents/direct-api.js');
  const { selectAgentForModel } = await import('../dist/agents/registry.js');
  const NV_MODEL = 'nv-openai/gpt-oss-20b';

  // 此刻 providers.json 只有 openrouter（檔頭寫的），所以 nv- 不該被認領。
  assert.strictEqual(
    directApiAgent.matchesModel(NV_MODEL),
    false,
    '★ 沒設定的 provider 前綴不得標成可路由（會變成「列出來卻叫不動」的假承諾）'
  );

  // 把 nv 加進 providers.json，同一個名字就該翻成可路由——不必重啟。
  const withNv = JSON.parse(readFileSync(providersPath, 'utf8'));
  withNv.providers.nv = { base_url: 'https://mock.nv.test/v1', api_key: 'test-key' };
  writeFileSync(providersPath, JSON.stringify(withNv, null, 2));
  assert.strictEqual(
    directApiAgent.matchesModel(NV_MODEL),
    true,
    '★ 設定檔加了 provider 之後，同一個 model 必須變成可路由（catalog 不得停在靜態前綴表）'
  );
  assert.strictEqual(
    selectAgentForModel(NV_MODEL).id,
    'direct-api',
    '★ 標成可路由的，實際選 agent 時也要真的選到 direct-api'
  );

  // 內建前綴不受設定檔影響。
  assert.strictEqual(directApiAgent.matchesModel('or-anything'), true, '內建 or- 前綴恆可路由');
  assert.strictEqual(directApiAgent.matchesModel('ds-anything'), true, '內建 ds- 前綴恆可路由');
  // 樣板字串不是真 model，不得被認領。
  assert.strictEqual(
    directApiAgent.matchesModel('<provider>-<model>'),
    false,
    '樣板 <provider>-<model> 不是可派的名字'
  );

  // 寫壞的 direct-api 名字要由 direct-api 自己報錯，不得掉進 claude 的 catch-all。
  assert.strictEqual(
    directApiAgent.matchesModel('ds-'),
    true,
    '★ 形狀像 direct-api 但寫壞的名字要留在 direct-api 報明確錯誤，回 false 會靜默改跑 Claude'
  );
  assert.strictEqual(
    selectAgentForModel('ds-').id,
    'direct-api',
    '★ 寫壞的 direct-api 名字不得被 claude 的 catch-all 接走'
  );

  // 還原，不影響後續（或重跑）。
  delete withNv.providers.nv;
  writeFileSync(providersPath, JSON.stringify(withNv, null, 2));
  console.log('PASS: catalog routable 跟隨 providers.json，且寫壞的名字不會靜默改跑 Claude');
}

// provider key 不可蓋住其他 agent 的 model 命名空間；Gemini API 用內建的 google 端點。
{
  const { directApiAgent, loadProvidersConfig } = await import('../dist/agents/direct-api.js');
  const { selectAgentForModel } = await import('../dist/agents/registry.js');
  const original = readFileSync(providersPath, 'utf8');

  // google 省略 base_url 時要拿到 Gemini API 的 OpenAI-compatible 端點，且走 chat_completions。
  const withGoogle = JSON.parse(original);
  withGoogle.providers.google = { api_key: 'test-key' };
  writeFileSync(providersPath, JSON.stringify(withGoogle, null, 2));
  let google;
  try {
    google = loadProvidersConfig().providers.google;
  } catch (error) {
    assert.fail(`★ google provider 省略 base_url 時要用 Gemini API 的內建端點（載入失敗：${error.message}）`);
  }
  assert.strictEqual(
    google?.base_url,
    'https://generativelanguage.googleapis.com/v1beta/openai',
    '★ google provider 省略 base_url 時要用 Gemini API 的內建端點'
  );
  assert.strictEqual(google?.api_format, undefined, 'google 內建端點走 chat_completions（不設 api_format）');
  assert.strictEqual(selectAgentForModel('google-gemini-x').id, 'direct-api', 'google-<model> 由 direct-api 接');
  assert.strictEqual(selectAgentForModel('gemini-4-neon-high').id, 'antigravity', '設了 google 後 gemini-* 仍歸 agy');

  // providers.gemini 會讓 gemini-* 的 agy 模型被 direct-api 搶走：只略過那一項並點名，
  // 不讓整份設定失敗（同檔的其他 provider 照常可派）。
  const { describeConfiguredProviders } = await import('../dist/agents/direct-api.js');
  const withGemini = JSON.parse(original);
  withGemini.providers.gemini = { base_url: 'https://mock.gemini.test/v1', api_key: 'test-key' };
  withGemini.providers.Gemini = { base_url: 'https://mock.gemini.test/v1', api_key: 'test-key' };
  withGemini.providers.nv = { base_url: 'https://mock.nv.test/v1', api_key: 'test-key' };
  writeFileSync(providersPath, JSON.stringify(withGemini, null, 2));
  let loaded;
  try {
    loaded = loadProvidersConfig();
  } catch (error) {
    assert.fail(`★ 保留的 provider key 只略過那一項，不得讓整份設定失敗（實得：${error.message}）`);
  }
  assert.ok(!loaded.providers.gemini, '★ 保留的 provider key 要被略過，不得進入可派工的 provider');
  assert.deepStrictEqual(loaded.ignoredReservedKeys, ['gemini'], '略過的保留 key 要被記下（大小寫與前綴比對一致，Gemini 不算）');
  assert.ok(loaded.providers.Gemini, '大寫的 Gemini 蓋不住 gemini-*（前綴比對區分大小寫），照常載入');
  assert.strictEqual(
    selectAgentForModel('gemini-4-neon-high').id,
    'antigravity',
    '★ 保留的 provider key 不得把 gemini-* 從 agy 搶走'
  );
  assert.strictEqual(selectAgentForModel('nv-openai/gpt-oss-20b').id, 'direct-api', '★ 同檔其他 provider 照常可派');
  assert.strictEqual(selectAgentForModel('gpt-6.2-sol').id, 'codex', '保留 key 不影響其他 agent 的路由');
  assert.match(describeConfiguredProviders().note ?? '', /"gemini".*保留名稱/, 'models 的 note 要點名被略過的保留 key');

  writeFileSync(providersPath, original);
  console.log('PASS: 保留 provider key 只略過該項並點名，google 內建 Gemini API 端點且不搶 agy 的 gemini-*');
}

// 失敗 job 要帶出錯誤原文：stdout 有 session_id 時上層不附 stderr，只剩 message ""。
{
  const { directApiAgent } = await import('../dist/agents/direct-api.js');
  const stdout = `${JSON.stringify({ type: 'system', session_id: 's-402' })}\n`;
  const stderr = [
    'some other tool noise secret-ish',
    '[direct-api] HTTP 402: {"error":{"code":402,"message":"Your prepayment credits are depleted."}}',
    '',
    'Direct API error: direct-api request failed with HTTP 402',
  ].join('\n');
  const failed = directApiAgent.parseOutput(stdout, stderr, 1);
  assert.ok(
    typeof failed?.error === 'string' && failed.error.includes('HTTP 402') && failed.error.includes('prepayment credits'),
    '★ 失敗的 direct-api job 要在 agentOutput.error 帶出 HTTP 錯誤原文'
  );
  assert.ok(!failed.error.includes('secret-ish'), 'error 只收 direct-api 自己寫的錯誤行');
  const noStdout = directApiAgent.parseOutput('', stderr, 1);
  assert.ok(noStdout?.error?.includes('HTTP 402'), '★ 連 stdout 都沒有時也要帶出錯誤原文');
  const ok = directApiAgent.parseOutput(stdout, stderr, 0);
  assert.strictEqual(ok?.error, undefined, '成功的 job 不附 error');
  const cancelled = directApiAgent.parseOutput(stdout, stderr, 143);
  assert.strictEqual(cancelled?.error, undefined, '取消（143）不是失敗，不附 error');
  const leaky = directApiAgent.parseOutput(
    stdout,
    'Direct API error: Headers.append: "Bearer sk-LEAKY-1234567890 x" is an invalid header value.',
    1
  );
  assert.ok(
    leaky?.error && !leaky.error.includes('sk-LEAKY-1234567890') && leaky.error.includes('Bearer [redacted]'),
    '★ agentOutput.error 不得夾帶 Bearer 金鑰'
  );
  console.log('PASS: 失敗的 direct-api job 帶出錯誤原文（只收 direct-api 錯誤行）');
}

// Gemini 的 thought_signature：tool call 的 extra_content 要原樣送回下一輪，少送就 400。
{
  const geminiStarted = await service.startProcess({
    workFolder: tempRoot,
    model: 'or-test/model',
    prompt: 'Gemini signature probe',
  });
  const [gemini] = await service.waitForProcesses([geminiStarted.pid], 5, true);
  assert.strictEqual(
    gemini.agentOutput?.message,
    'signed ok',
    `★ tool call 的 extra_content（Gemini thought_signature）要原樣送回下一輪（實得 ${gemini.status}／${JSON.stringify(gemini.agentOutput?.error ?? gemini.agentOutput?.message)}）`
  );
  const saved = JSON.parse(readFileSync(gemini.agentOutput.sessionPath, 'utf-8'));
  const savedCall = saved.messages.find((message) => message.role === 'assistant' && message.tool_calls)?.tool_calls?.[0];
  assert.deepStrictEqual(
    savedCall?.extra_content,
    { google: { thought_signature: 'SIG-abc' } },
    'session 檔也要保存 extra_content，續跑時才送得回去'
  );
  console.log('PASS: Gemini thought_signature 隨 tool call 原樣送回並存進 session');
}

// 工作層級：402 的錯誤原文要出現在 job 結果；沒有 index 的分段 tool call 要正確歸併。
{
  const payStarted = await service.startProcess({ workFolder: tempRoot, model: 'or-test/model', prompt: 'Payment probe' });
  const [pay] = await service.waitForProcesses([payStarted.pid], 5, true);
  assert.ok(
    pay.status === 'failed' && pay.agentOutput?.error?.includes('HTTP 402') && pay.agentOutput.error.includes('prepayment credits are depleted'),
    `★ job 結果要帶出 402 的完整錯誤原文（實得 ${JSON.stringify(pay.agentOutput)}）`
  );
  const ckStarted = await service.startProcess({ workFolder: tempRoot, model: 'or-test/model', prompt: 'Chunked no-index probe' });
  const [ck] = await service.waitForProcesses([ckStarted.pid], 5, true);
  assert.strictEqual(
    ck.agentOutput?.message,
    'chunk ok',
    `★ 沒有 index 的分段 tool call 要依 id 歸併、extra_content 兩層合併（實得 ${JSON.stringify(ck.agentOutput?.error ?? ck.agentOutput?.message)}）`
  );
  console.log('PASS: 402 原文出現在 job 結果；沒有 index 的分段 tool call 正確歸併');
}
