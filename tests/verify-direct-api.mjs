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
const toolProbeArgs = '{"path":"package.json"}';

function toolDelta(call, finishReason) {
  return { choices: [{ delta: { tool_calls: [call] }, finish_reason: finishReason }] };
}

const toolProbes = {
  'Empty tool fields probe': [
    toolDelta({ index: 0, id: 'call_empty', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }),
    toolDelta({ index: 0, id: '', type: '', function: { name: '' } }),
    toolDelta({ id: '', function: { name: '', arguments: '"package.json"}' } }, 'tool_calls'),
  ],
  'Invalid tool indices probe': [
    toolDelta({ id: 'call_indices', function: { name: 'read_file', arguments: '{' } }),
    toolDelta({ index: -1, id: 'call_indices', function: { arguments: '"path"' } }),
    toolDelta({ index: 0.5, function: { arguments: ':' } }),
    // 1e400 是合法 JSON 數字，JSON.parse 會讀成 Infinity。
    '{"choices":[{"delta":{"tool_calls":[{"index":1e400,"function":{"arguments":"\\"package.json\\"}"}}]},"finish_reason":"tool_calls"}]}',
  ],
  'Reused tool index probe': [
    toolDelta({ index: 0, id: 'call_before', function: { name: 'read_file', arguments: toolProbeArgs } }),
    toolDelta({ index: 0, id: 'call_after', function: { name: 'read_file', arguments: '' } }),
    toolDelta({ index: 0, function: { arguments: toolProbeArgs } }, 'tool_calls'),
  ],
  'Returning tool id probe': [
    toolDelta({ index: 0, id: 'call_A', function: { name: 'read_file', arguments: '{"path":' } }),
    toolDelta({ index: 0, id: 'call_B', function: { name: 'list_dir', arguments: '{"path":' } }),
    toolDelta({ index: 0, function: { arguments: '"."}' } }),
    toolDelta({ index: 0, id: 'call_A', function: { arguments: '"package.json"' } }),
    toolDelta({ index: 0, function: { arguments: '}' } }, 'tool_calls'),
  ],
  'Repeated tool id with same name probe': [
    toolDelta({ index: 0, id: 'call_same', function: { name: 'read_file', arguments: '{"a":1}' } }),
    toolDelta({ index: 0, id: 'call_same', function: { name: 'read_file', arguments: ',"b":2}' } }, 'tool_calls'),
  ],
  'Repeated tool id with different name probe': [
    toolDelta({ index: 0, id: 'call_rename', function: { name: 'read_file', arguments: '{"path":' } }),
    toolDelta({ index: 0, id: 'call_rename', function: { name: 'list_dir', arguments: '"."}' } }, 'tool_calls'),
  ],
  'Parallel indexed tools probe': [
    toolDelta({ index: 0, id: 'call_read_parallel', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }),
    toolDelta({ index: 1, id: 'call_list_parallel', type: 'function', function: { name: 'list_dir', arguments: '{"path":' } }),
    toolDelta({ index: 0, function: { arguments: '"package.json"}' } }),
    toolDelta({ index: 1, function: { arguments: '"."}' } }, 'tool_calls'),
  ],
  'Anonymous reused index probe': [
    toolDelta({ index: 0, id: '', function: { name: 'read_file', arguments: toolProbeArgs } }),
    toolDelta({ index: 0, function: { name: 'list_dir', arguments: '{"path":"."}' } }),
    toolDelta({ index: 0, function: { name: 'list_dir', arguments: '{"path":"."' } }),
    toolDelta({ index: 0, id: 'call_same_name', function: { name: 'list_dir', arguments: '}' } }),
    toolDelta({ index: 0, function: { name: 'list_dir', arguments: '' } }, 'tool_calls'),
  ],
  'Sparse and reordered indices probe': [
    toolDelta({ index: 0, id: 'call_first_zero', function: { name: 'read_file', arguments: toolProbeArgs } }),
    toolDelta({ index: 0, id: 'call_second_zero', function: { name: 'read_file', arguments: '{"path":' } }),
    toolDelta({ index: 1, function: { name: 'read_file', arguments: toolProbeArgs } }),
    toolDelta({ index: 4294967296, id: 'call_huge', function: { name: 'read_file', arguments: toolProbeArgs } }),
    toolDelta({ index: 100000000, id: 'call_sparse', function: { name: 'read_file', arguments: toolProbeArgs } }),
    toolDelta({ index: 2, id: 'call_two', function: { name: 'read_file', arguments: toolProbeArgs } }),
    toolDelta({ index: 0, function: { arguments: '"package.json"}' } }, 'tool_calls'),
  ],
  'Empty metadata probe': [
    toolDelta({
      index: 0, id: 'call_metadata_scalar', function: { name: 'read_file', arguments: toolProbeArgs },
      extra_content: { google: 'keep', empty: { nested: { missing: '' } } },
    }),
    toolDelta({
      index: 0, extra_content: { google: { empty: { missing: null } } },
    }),
    toolDelta({
      index: 1, id: 'call_metadata_empty', function: { name: 'read_file', arguments: toolProbeArgs },
      extra_content: { google: { signature: '' } },
    }, 'tool_calls'),
  ],
  'Nested tool metadata probe': [
    toolDelta({
      id: 'call_metadata',
      function: { name: 'read_file', arguments: toolProbeArgs },
      extra_content: {
        constructor: { sample: true },
        google: { signature: { keep: 1, emptyString: 'keep', nullValue: 'keep', zero: 1, flag: true } },
      },
    }),
    toolDelta({
      id: 'call_metadata',
      extra_content: {
        google: {
          signature: {
            added: 2, emptyString: '', nullValue: null, zero: 0, flag: false,
            ['__proto__']: { sample: true }, prototype: { sample: true },
          },
        },
      },
    }, 'tool_calls'),
  ],
};

const usageProbes = {
  'Partial usage probe': [
    [{ usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }],
    [{ usage: { prompt_tokens: 4 } }],
  ],
  'Invalid usage only probe': [
    [{ usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 } }],
  ],
  'Recovered usage probe': [
    [{ usage: { prompt_tokens: 4 } }, { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }],
  ],
  'Null optional usage probe': [
    [{ usage: {
      prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, reasoning_tokens: null,
      prompt_tokens_details: { cached_tokens: null, cache_creation_tokens: null },
      completion_tokens_details: { reasoning_tokens: null },
    } }],
  ],
  'Optional usage probe': [
    [{ usage: {
      prompt_tokens: 10, completion_tokens: 4, total_tokens: -1,
      prompt_tokens_details: { cached_tokens: -1, cache_creation_tokens: -2 },
      completion_tokens_details: { reasoning_tokens: -3 },
    } }],
    [{ usage: {
      prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 5, cache_creation_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 3 },
    } }],
  ],
};

const costProbes = {
  'Trailing zero cost probe': { cost: 0 },
  'Negative cost probe': { cost: -2 },
  'Nonfinite cost probe': '{"cost":1e400}',
  'Empty string cost probe': { cost: '' },
};

function streamResponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const body = `${events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
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

  if (Object.hasOwn(costProbes, firstUserContent)) {
    return streamResponse([
      { choices: [{ delta: { content: 'cost probe ok' }, finish_reason: 'stop' }], cost: 2 },
      costProbes[firstUserContent],
    ]);
  }
  if (firstUserContent === 'Message metadata stream probe') {
    return streamResponse([
      { choices: [{ delta: { content: 'stream metadata', extra_content: { google: { thought_signature: 'SIG-message' } } }, finish_reason: 'stop' }] },
      { choices: [{ delta: { extra_content: { google: { other: 2, thought_signature: '' } } }, finish_reason: '' }] },
    ]);
  }
  if (firstUserContent === 'Message metadata JSON probe') {
    if (messages.some((message) => message.role === 'tool')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'JSON replay ok' } }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [
        { finish_reason: 'tool_calls', message: {
          extra_content: { google: { thought_signature: 'SIG-json' }, empty: { missing: '' } },
          tool_calls: [{
            id: '', type: 'function', function: { name: 'read_file', arguments: toolProbeArgs },
            extra_content: { google: { part: 1, missing: null }, ['__proto__']: { sample: true } },
          }],
        } },
        { finish_reason: '' },
      ],
    }), { headers: { 'content-type': 'application/json' } });
  }

  if (Object.hasOwn(toolProbes, firstUserContent)) {
    return streamResponse(messages.some((message) => message?.role === 'tool')
      ? [{ choices: [{ delta: { content: 'probe ok' }, finish_reason: 'stop' }] }]
      : toolProbes[firstUserContent]);
  }
  if (Object.hasOwn(usageProbes, firstUserContent)) {
    const rounds = usageProbes[firstUserContent];
    if (rounds.length > 1 && !messages.some((message) => message?.role === 'tool')) {
      return streamResponse([
        toolDelta({ index: 0, id: 'call_usage', function: { name: 'read_file', arguments: toolProbeArgs } }, 'tool_calls'),
        ...rounds[0],
      ]);
    }
    return streamResponse([
      { choices: [{ delta: { content: 'usage probe ok' }, finish_reason: 'stop' }] },
      ...rounds.at(-1),
    ]);
  }

  if (firstUserContent === 'Read package.json and tell me the version' && !messages.some((message) => message?.role === 'tool')) {
    return streamResponse([
      {
        usage: null,
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
        usage: null,
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
      { choices: [{ delta: { content: 'Version ' } }], usage: null },
      { choices: [{ delta: { content: '9.9.9' }, finish_reason: 'stop' }], usage: null },
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
        usage: { completion_tokens: 20, prompt_tokens: 90, total_tokens: 154, cost: 1 },
      },
      { choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop' }], usage: { completion_tokens: 26, prompt_tokens: 90, total_tokens: 160, cost: 2 }, cost: 0 },
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
      { choices: [{ delta: { tool_calls: [{ id: 'call_ck', function: { arguments: '"package.json"}' }, extra_content: { google: { thought_signature: 'SIG-ck' } } }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } },
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
    return streamResponse([
      { choices: [{ delta: { content: 'signed ok' }, finish_reason: 'stop' }] },
      { choices: [], usage: { input_tokens: 110, output_tokens: 10, total_tokens: 120 }, cost: 3 },
    ]);
  }
  return streamResponse([
    { choices: [{ delta: { content: 'Hello without tools' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 1.5 } },
    { usage: { prompt_tokens: -1, completion_tokens: 2 }, cost: 99 },
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
assert.deepStrictEqual(result.agentOutput.tokens, { input: 7, output: 3, total: 10 }, '尾端單筆用量的 tokens 要跨請求加總');
assert.deepStrictEqual(result.agentOutput.usage, {
  input_tokens: 7, output_tokens: 3, source: 'direct-api usage',
}, '尾端單筆用量的 usage 要跨請求加總');
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
assert.deepStrictEqual(noToolsResult.agentOutput.usage, {
  input_tokens: 1, output_tokens: 1, incomplete: true, source: 'direct-api usage',
}, '無效的尾端用量要保留前一筆有效用量並標 incomplete');
assert.deepStrictEqual(noToolsResult.agentOutput.tokens, {
  input: 1, output: 1, total: 2,
}, '無效的尾端用量也不得蓋掉有效 tokens');
assert.strictEqual(noToolsResult.agentOutput.cost, 1.5, '壞用量 chunk 的成本不得覆蓋有效成本');
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
  assert.deepStrictEqual(gemini.agentOutput.usage, {
    input_tokens: 200, output_tokens: 36, source: 'direct-api usage',
  }, '累計串流的 usage 要取每個請求最後一筆再相加');
  assert.deepStrictEqual(gemini.agentOutput.tokens, {
    input: 200, output: 36, total: 280,
  }, '累計串流的 tokens 要取每個請求最後一筆再相加');
  assert.strictEqual(gemini.agentOutput.cost, 5, '累計串流的 cost 要取每個請求最後一筆再相加');
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
  assert.deepStrictEqual(ck.agentOutput.usage, {
    input_tokens: 8, output_tokens: 2, incomplete: true, source: 'direct-api usage',
  }, '有請求未回用量時要保留已知用量並標 incomplete');
  console.log('PASS: 402 原文出現在 job 結果；沒有 index 的分段 tool call 正確歸併');
}

async function runProbe(prompt, verbose = true, sessionId) {
  const job = await service.startProcess({ workFolder: tempRoot, model: 'or-test/model', prompt, session_id: sessionId });
  const [completed] = await service.waitForProcesses([job.pid], 5, verbose);
  assert.strictEqual(completed.status, 'completed', '串流回歸測試工作應完成');
  return completed.agentOutput;
}

async function replayedToolCalls(prompt) {
  const requestStart = capturedBodies.length;
  await runProbe(prompt);
  return capturedBodies[requestStart + 1]?.messages.find((message) => message.role === 'assistant')?.tool_calls;
}

{
  const source = 'direct-api usage';
  const partial = await runProbe('Partial usage probe');
  assert.deepStrictEqual(partial.tokens, { input: 3, output: 1, total: 4 }, '缺少必要用量欄位的請求不得加入 tokens');
  assert.deepStrictEqual(partial.usage, { input_tokens: 3, output_tokens: 1, source, incomplete: true });

  const invalid = await runProbe('Invalid usage only probe', false);
  assert.strictEqual(invalid.tokens, undefined, '整次用量無效時不得輸出 tokens');
  assert.strictEqual(invalid.usage, undefined);
  assert.strictEqual(invalid.usage_incomplete, true, '整次用量無效時須有可見的 usage_incomplete');

  const recovered = await runProbe('Recovered usage probe');
  assert.deepStrictEqual(recovered.usage, { input_tokens: 10, output_tokens: 4, source }, '同一請求之後收到有效用量應清除 incomplete');
  assert.strictEqual(recovered.usage_incomplete, undefined);
  const nullOptional = await runProbe('Null optional usage probe');
  assert.deepStrictEqual(nullOptional.usage, {
    input_tokens: 10, output_tokens: 4, source,
  }, 'null 選填計數視為未提供且不得標 incomplete');
  assert.deepStrictEqual(nullOptional.tokens, { input: 10, output: 4, total: 14 }, 'null 選填計數不得寫入 tokens');

  const optional = await runProbe('Optional usage probe');
  assert.deepStrictEqual(optional.tokens, {
    input: 20, output: 8, total: 14, cached: 5, cache_creation: 2, reasoning: 3,
  }, '非法的 cached、reasoning、total、cache_creation 不得污染 tokens');
  assert.deepStrictEqual(optional.usage, {
    input_tokens: 20, output_tokens: 8, cached_input_tokens: 5, reasoning_output_tokens: 3, source, incomplete: true,
  });
  console.log('PASS: 缺漏、無效與恢復的用量回報，及非法選用計數的處理');
}

{
  const expectedFunction = { name: 'read_file', arguments: toolProbeArgs };
  const expectedList = { name: 'list_dir', arguments: '{"path":"."}' };
  assert.deepStrictEqual(await replayedToolCalls('Empty tool fields probe'), [
    { id: 'call_empty', type: 'function', function: expectedFunction },
  ], '空字串 id、type、name 要視為未提供並保持同一筆 tool call');
  assert.deepStrictEqual(await replayedToolCalls('Invalid tool indices probe'), [
    { id: 'call_indices', type: 'function', function: expectedFunction },
  ], '無效 index 要改走無 index 的 tool call 歸併');
  assert.deepStrictEqual(await replayedToolCalls('Reused tool index probe'), [
    { id: 'call_before', type: 'function', function: expectedFunction },
    { id: 'call_after', type: 'function', function: expectedFunction },
  ], '同一 index 的不同 id 要分槽且續段歸到新槽');
  assert.deepStrictEqual(await replayedToolCalls('Returning tool id probe'), [
    { id: 'call_A', type: 'function', function: expectedFunction },
    { id: 'call_B', type: 'function', function: expectedList },
  ], '重用 index 時重現的 id 要回原槽且接住後續片段');
  assert.deepStrictEqual(await replayedToolCalls('Repeated tool id with same name probe'), [
    { id: 'call_same', type: 'function', function: { name: 'read_file', arguments: '{"a":1},"b":2}' } },
  ], '同 index 同 id 的同名續段要串接參數且只重播一筆');
  assert.deepStrictEqual(await replayedToolCalls('Repeated tool id with different name probe'), [
    { id: 'call_rename', type: 'function', function: expectedList },
  ], '同 index 同 id 的名稱改變仍要串接參數且只重播一筆');
  assert.deepStrictEqual(await replayedToolCalls('Parallel indexed tools probe'), [
    { id: 'call_read_parallel', type: 'function', function: expectedFunction },
    { id: 'call_list_parallel', type: 'function', function: expectedList },
  ], '平行 tool call 只帶 index 的交錯續段要各自歸槽');
  assert.deepStrictEqual(await replayedToolCalls('Anonymous reused index probe'), [
    { id: 'call_0', type: 'function', function: expectedFunction },
    { id: 'call_1', type: 'function', function: expectedList },
    { id: 'call_same_name', type: 'function', function: expectedList },
  ], '無 id 的 index 重用只在名稱改變或同名且舊參數完整時分槽');
  const orderedCalls = await replayedToolCalls('Sparse and reordered indices probe');
  assert.deepStrictEqual(orderedCalls?.map((call) => [call.id, call.function.arguments]), [
    ['call_first_zero', toolProbeArgs], ['call_second_zero', toolProbeArgs], ['call_2', toolProbeArgs],
    ['call_two', toolProbeArgs], ['call_sparse', toolProbeArgs], ['call_huge', toolProbeArgs],
  ], 'wire index 要與槽位分離並原序輸出亂序及超大 index');
  const emptyMetadataCalls = await replayedToolCalls('Empty metadata probe');
  assert.deepStrictEqual(emptyMetadataCalls?.map((call) => call.extra_content), [
    { google: 'keep' }, undefined,
  ], '過濾後的空 extra_content 不得覆蓋純量或寫入空物件');

  const stringify = JSON.stringify;
  let liveSignature;
  let calls;
  // JSON 序列化會丟掉原型。要在 request body 轉成字串之前檢查實際物件。
  JSON.stringify = (value, ...args) => {
    if (value?.stream === true && Array.isArray(value.messages)) {
      const call = value.messages.find((message) => message.role === 'assistant')?.tool_calls?.[0];
      if (call?.id === 'call_metadata') liveSignature = call.extra_content?.google?.signature;
    }
    return stringify(value, ...args);
  };
  try {
    calls = await replayedToolCalls('Nested tool metadata probe');
  } finally {
    JSON.stringify = stringify;
  }
  const metadata = calls?.[0]?.extra_content;
  const signature = metadata?.google?.signature;
  assert.deepStrictEqual([signature?.keep, signature?.added], [1, 2], 'extra_content 深層物件要遞迴合併');
  assert.deepStrictEqual(
    [signature?.emptyString, signature?.nullValue, signature?.zero, signature?.flag],
    ['keep', 'keep', 0, false],
    'extra_content 空值要略過且仍接受 0 和 false'
  );
  assert.ok(
    liveSignature && Object.getPrototypeOf(liveSignature) === Object.prototype && !('sample' in liveSignature),
    'extra_content 的 __proto__ 不得改變序列化前物件的原型'
  );
  assert.ok(
    !Object.hasOwn(metadata, 'constructor') &&
    !Object.hasOwn(signature, '__proto__') &&
    !Object.hasOwn(signature, 'prototype'),
    'extra_content 要略過各層原型相關鍵'
  );
  console.log('PASS: tool call 空欄位、無效 index、index 衝突和 extra_content 合併');
}

{
  for (const prompt of Object.keys(costProbes)) {
    assert.strictEqual((await runProbe(prompt)).cost, 2, `尾端零值或非法成本不得覆蓋有效成本（${prompt}）`);
  }
  const { directApiAgent } = await import('../dist/agents/direct-api.js');
  const flagOnly = directApiAgent.parseOutput('{"type":"result","usage_incomplete":true}', '');
  assert.strictEqual(flagOnly?.usage_incomplete, true, '只有 usage_incomplete 的結果也要保留旗標');

  const streamed = await runProbe('Message metadata stream probe');
  assert.strictEqual(streamed.finish_reason, 'stop', '串流空 finish_reason 不得覆蓋已知結束原因');
  const streamExtra = { google: { thought_signature: 'SIG-message', other: 2 } };
  const saved = JSON.parse(readFileSync(streamed.sessionPath, 'utf8'));
  assert.deepStrictEqual(saved.messages.at(-1).extra_content, streamExtra, '串流 message 層 extra_content 要合併並保存');
  const resumeRequest = capturedBodies.length;
  await runProbe('Resume message metadata', true, streamed.session_id);
  assert.deepStrictEqual(
    capturedBodies[resumeRequest].messages.find((message) => message.role === 'assistant')?.extra_content,
    streamExtra, 'session 續接要重播 message 層 extra_content'
  );

  const jsonRequest = capturedBodies.length;
  const jsonResult = await runProbe('Message metadata JSON probe');
  assert.strictEqual(jsonResult.finish_reason, 'tool_calls', '非串流空 finish_reason 不得覆蓋已知結束原因');
  const assistant = capturedBodies[jsonRequest + 1]?.messages.find((message) => message.role === 'assistant');
  assert.deepStrictEqual(assistant?.extra_content, {
    google: { thought_signature: 'SIG-json' },
  }, '非串流 message 層 extra_content 要過濾並重播');
  assert.strictEqual(assistant?.tool_calls?.[0]?.id, 'call_0', '非串流 tool call 的空 id 要改用後備 id');
  assert.deepStrictEqual(assistant?.tool_calls?.[0]?.extra_content, {
    google: { part: 1 },
  }, '非串流 tool call extra_content 要過濾後重播');
  assert.strictEqual(capturedBodies[jsonRequest + 1].messages.find((message) => message.role === 'tool')?.tool_call_id, 'call_0');
  console.log('PASS: 成本防護、message extra_content 續接、非串流工具與結果旗標');
}
