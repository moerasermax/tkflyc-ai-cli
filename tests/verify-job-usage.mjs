/** job 用量、effort 警告與成本派工建議；spawn 完全替換，不啟動 vendor CLI。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const cp = createRequire(import.meta.url)('node:child_process');
const originalSpawn = cp.spawn;
let nextPid = 100000;
let spawnCount = 0;
cp.spawn = (_command, args = []) => {
  spawnCount++;
  const pid = nextPid++;
  if (args[0]?.endsWith('job-runner.js')) {
    // runner 現在有 meta handshake；假 spawn 同步模擬握手，仍不啟動 vendor。
    const dir = args[1], spec = JSON.parse(readFileSync(join(dir, 'launch.tmp'), 'utf8'));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...spec.meta, pid, runner: { pid, started: 'stub', name: 'stub' }, worker: null }));
    writeFileSync(join(dir, 'stdout.log'), ''); writeFileSync(join(dir, 'stderr.log'), '');
    writeFileSync(join(dir, 'exit.json'), JSON.stringify({ exitCode: 0, signal: null, endTime: new Date().toISOString(), killed: false, timedOut: false }));
  }
  return Object.assign(new EventEmitter(), {
    pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {},
  });
};
syncBuiltinESMExports();
delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT;
const { codexAgent } = await load('dist/agents/codex.js');
const { claudeAgent } = await load('dist/agents/claude.js');
const { antigravityAgent } = await load('dist/agents/antigravity.js');
const { directApiAgent } = await load('dist/agents/direct-api.js');
const { FileProcessService } = await load('dist/core/file-process-service.js');
const { runCli } = await load('dist/app/cli.js');
const { resolveConfiguredReasoningEffort, resolveConfiguredReasoningEffortWithSource } = await load('dist/core/user-config.js');
const { buildCliCommand } = await load('dist/core/command-builder.js');
const { ProcessService } = await load('dist/core/process-service.js');
const { buildProcessResult } = await load('dist/core/process-result.js');
const { getModelsPayload } = await load('dist/models/catalog.js');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.message}`); }
}
const line = (value) => JSON.stringify(value);
const turn = { type: 'turn.completed', usage: {
  input_tokens: 19842, cached_input_tokens: 7296, cache_write_input_tokens: 0,
  output_tokens: 5, reasoning_output_tokens: 0,
} };
const expectedCodex = { ...turn.usage, source: 'codex turn.completed' };
const result = { type: 'result', num_turns: 1, total_cost_usd: 0.0279234,
  usage: { input_tokens: 9, cache_creation_input_tokens: 12528, cache_read_input_tokens: 17734,
    output_tokens: 217, output_tokens_details: { thinking_tokens: 211 } },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 9, outputTokens: 217,
    cacheReadInputTokens: 17734, cacheCreationInputTokens: 12528, costUSD: 0.0279234 } },
};
const expectedClaude = { input_tokens: 30271, cached_input_tokens: 17734, cache_write_input_tokens: 12528,
  output_tokens: 217, reasoning_output_tokens: 211, num_turns: 1,
  cost_usd_nominal: 0.0279234, source: 'claude result' };
const options = { prompt: 'usage verification', workFolder: ROOT, model: 'codex',
  cliPaths: { codex: 'never-run-codex', claude: 'never-run-claude', antigravity: 'never-run-agy' } };
const configPath = join(process.env.AI_CLI_CONFIG_DIR, 'config.json');
function config(value) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, line(value));
}
const warning = (cmd, effort, source) => {
  assert.equal(cmd.warnings?.length, 1);
  assert.ok(cmd.warnings[0].includes(`"${effort}"`));
  assert.ok(cmd.warnings[0].includes(`source: ${source}`));
  assert.ok(cmd.warnings[0].includes('High-cost'));
  assert.ok(cmd.warnings[0].includes('medium'));
  assert.ok(cmd.warnings[0].includes('explicitly requested by the user'));
};
try {
  config({});
  check('Agy job usage shape and raw tokens preserved', () => {
    const raw = { input_tokens: 31227, output_tokens: 545, thinking_tokens: 523, total_tokens: 31772 };
    const parsed = antigravityAgent.parseOutput(line({ response: 'done', usage: raw }), '');
    assert.deepEqual(parsed.tokens, raw);
    assert.deepEqual(parsed.usage, { input_tokens: 31227, output_tokens: 545, reasoning_output_tokens: 523, source: 'agy json' });
    assert.equal(Object.hasOwn(parsed.usage, 'cached_input_tokens'), false);
    assert.equal(Object.hasOwn(parsed.usage, 'cache_write_input_tokens'), false);
  });
  check('Agy unavailable usage omitted and invalid thinking incomplete', () => {
    for (const raw of [undefined, {}, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1, output_tokens: '2' }])
      assert.equal(Object.hasOwn(antigravityAgent.parseOutput(line({ response: 'done', usage: raw }), ''), 'usage'), false);
    assert.equal(Object.hasOwn(antigravityAgent.parseOutput('text answer', ''), 'usage'), false);
    const usage = antigravityAgent.parseOutput(line({ response: 'done', usage: { input_tokens: 1, output_tokens: 2, thinking_tokens: -1 } }), '').usage;
    assert.equal(usage.incomplete, true);
    assert.equal(Object.hasOwn(usage, 'reasoning_output_tokens'), false);
  });
  await checkAsync('Direct-api stream and JSON usage shape preserves tokens and cost', async () => {
    const originalFetch = globalThis.fetch;
    // session/state 均使用測試隔離目錄，不會在 repo 產生檔案。
    const cwd = process.env.AI_CLI_STATE_DIR;
    mkdirSync(cwd, { recursive: true });
    const cmd = { agent: 'direct-api', cwd, prompt: '[no-tools]usage', cliPath: '', args: [],
      directApi: { providerName: 'mock', modelName: 'mock', baseUrl: 'https://mock.test/v1', apiKey: 'test-key' } };
    const raw = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 7 }, cost: 0.12 };
    const expected = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30, reasoning_output_tokens: 7, source: 'direct-api usage' };
    async function run(events, streaming) {
      globalThis.fetch = async () => streaming
        ? new Response(events.map((event) => `data: ${line(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : new Response(line(events[0]), { headers: { 'content-type': 'application/json' } });
      let stdout = '';
      await directApiAgent.runDirect(cmd, { stdout: (chunk) => { stdout += chunk; }, stderr() {} });
      return directApiAgent.parseOutput(stdout, '');
    }
    try {
      const finish = { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: null };
      for (const streaming of [true, false]) {
        const events = streaming ? [finish, { usage: raw }] : [{ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: raw }];
        const parsed = await run(events, streaming);
        assert.deepEqual(parsed.usage, expected);
        assert.deepEqual(parsed.tokens, { input: 100, output: 20, reasoning: 7, cached: 30, total: 120 });
        assert.equal(parsed.cost, 0.12);
        const compact = buildProcessResult({ pid: 1, agent: 'direct-api', status: 'completed', startTime: '', workFolder: cwd, prompt: 'test', stdout: '', stderr: '' }, parsed);
        assert.deepEqual(compact.agentOutput.usage, expected);
      }
      // 同一個回應的 usage 取最後一筆、不加總：有些供應商每個 chunk 都送累計值，加總會倍增。
      const twice = await run([finish, { usage: raw }, { usage: raw }], true);
      assert.deepEqual(twice.usage, expected);
      const cumulative = await run([finish, { usage: { ...raw, completion_tokens: 10 } }, { usage: raw }], true);
      assert.deepEqual(cumulative.usage, expected);
      for (const usage of [undefined, null, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1, completion_tokens: '2' }]) {
        const parsed = await run([finish, { usage }], true);
        assert.equal(Object.hasOwn(parsed, 'usage'), false);
      }
      const partial = await run([finish, { usage: raw }, { usage: { prompt_tokens: -1, completion_tokens: 2 } }], true);
      assert.deepEqual(partial.usage, { ...expected, incomplete: true });
      const minimal = await run([finish, { usage: { prompt_tokens: 5, completion_tokens: 2 } }], true);
      assert.deepEqual(minimal.usage, { input_tokens: 5, output_tokens: 2, source: 'direct-api usage' });
      const invalidOptional = await run([finish, { usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } } }], true);
      assert.deepEqual(invalidOptional.usage, { input_tokens: 5, output_tokens: 2, incomplete: true, source: 'direct-api usage' });
    } finally { globalThis.fetch = originalFetch; }
  });
  check('Codex single turn usage', () => assert.deepEqual(codexAgent.parseOutput(line(turn), '').usage, expectedCodex));
  check('Codex multiple turns sum usage', () => assert.deepEqual(
    codexAgent.parseOutput(`${line(turn)}\n${line(turn)}`, '').usage,
    Object.fromEntries(Object.entries(expectedCodex).map(([key, value]) => [key, typeof value === 'number' ? value * 2 : value]))));
  check('Codex optional counters sum', () => assert.deepEqual(
    codexAgent.parseOutput(line({ ...turn, usage: { ...turn.usage, cache_write_input_tokens: 11, reasoning_output_tokens: 7 } }), '').usage,
    { ...expectedCodex, cache_write_input_tokens: 11, reasoning_output_tokens: 7 }));
  check('Codex missing cache counter still counts turn', () => {
    const withoutCache = structuredClone(turn);
    delete withoutCache.usage.cached_input_tokens;
    assert.deepEqual(codexAgent.parseOutput(`${line(turn)}\n${line(withoutCache)}`, '').usage,
      { ...expectedCodex, input_tokens: 39684, output_tokens: 10 });
  });
  check('Codex invalid turns mark partial totals incomplete', () => {
    for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: 5 },
      { input_tokens: 10, output_tokens: '5' }, { input_tokens: 10, output_tokens: -1 },
      { input_tokens: null, output_tokens: 5 }, { input_tokens: 10 }]) {
      const bad = { type: 'turn.completed', usage };
      for (const events of [[turn, bad], [bad, turn]])
        assert.deepEqual(codexAgent.parseOutput(events.map(line).join('\n'), '').usage,
          { ...expectedCodex, incomplete: true });
      assert.equal(Object.hasOwn(codexAgent.parseOutput(
        `${line({ type: 'thread.started', thread_id: 'test' })}\n${line(bad)}`, ''), 'usage'), false);
    }
    const nonFinite = '{"type":"turn.completed","usage":{"input_tokens":1e400,"output_tokens":5}}';
    assert.deepEqual(codexAgent.parseOutput(`${line(turn)}\n${nonFinite}`, '').usage,
      { ...expectedCodex, incomplete: true });
  });
  check('Codex legacy token_count preserved without usage', () => {
    const msg = { type: 'token_count', info: { total_token_usage: 17 } };
    const parsed = codexAgent.parseOutput(line({ msg }), '');
    assert.deepEqual(parsed.token_count, msg);
    assert.equal(Object.hasOwn(parsed, 'usage'), false);
  });
  check('Codex missing or malformed usage stays unknown', () => {
    for (const event of [{ type: 'turn.completed' }, { type: 'turn.completed', usage: {} }]) {
      const parsed = codexAgent.parseOutput(`${line({ type: 'thread.started', thread_id: 'test' })}\n${line(event)}`, '');
      assert.equal(Object.hasOwn(parsed, 'usage'), false);
    }
  });
  check('Claude single JSON result usage', () => assert.deepEqual(claudeAgent.parseOutput(line(result), '').usage, expectedClaude));
  check('Claude NDJSON result usage', () => assert.deepEqual(claudeAgent.parseOutput(`{"type":"system"}\n${line(result)}`, '').usage, expectedClaude));
  check('Claude total input includes both cache counters', () => {
    for (const [read, creation] of [[17734, 0], [0, 12528], [17734, 12528]]) {
      const event = { ...result, usage: { input_tokens: 9, output_tokens: 217,
        cache_read_input_tokens: read, cache_creation_input_tokens: creation } };
      assert.equal(claudeAgent.parseOutput(line(event), '').usage.input_tokens, 9 + read + creation);
    }
  });
  check('Claude later invalid result retains valid usage', () => {
    for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: 0 }])
      assert.deepEqual(claudeAgent.parseOutput(
        `${line(result)}\n${line({ type: 'result', result: 'done', usage })}`, '').usage, expectedClaude);
  });
  check('Claude single JSON preserves raw usage and other fields', () => {
    for (const raw of [result.usage, { input_tokens: 'unknown' }, null]) {
      const event = { ...result, usage: raw, result: 'done', session_id: 'test', is_error: false };
      const parsed = claudeAgent.parseOutput(line(event), '');
      assert.deepEqual(parsed.raw_usage, raw);
      const { usage: _usage, raw_usage: _rawUsage, ...rest } = parsed;
      const { usage: _vendorUsage, ...expectedRest } = event;
      assert.deepEqual(rest, expectedRest);
      if (raw !== result.usage) assert.equal(Object.hasOwn(parsed, 'usage'), false);
    }
  });
  check('Claude missing thinking defaults to zero', () => {
    const noThinking = structuredClone(result);
    delete noThinking.usage.output_tokens_details;
    assert.equal(claudeAgent.parseOutput(line(noThinking), '').usage.reasoning_output_tokens, 0);
  });
  check('Claude no result has no usage', () => {
    const assistant = { type: 'assistant', session_id: 'test', message: { content: [{ type: 'text', text: 'done' }] } };
    for (const stdout of [line(assistant), `{"type":"system"}\n${line(assistant)}`])
      assert.equal(Object.hasOwn(claudeAgent.parseOutput(stdout, ''), 'usage'), false);
  });
  check('Claude result without counters stays unknown', () => {
    for (const usage of [undefined, {}]) {
      const parsed = claudeAgent.parseOutput(line({ type: 'result', result: 'done', usage }), '');
      assert.equal(Object.hasOwn(parsed, 'usage'), false);
    }
  });
  check('Compact process result retains both agent usages', () => {
    for (const [agent, usage] of [['codex', expectedCodex], ['claude', expectedClaude]]) {
      const compact = buildProcessResult({ pid: 1, agent, status: 'completed', startTime: '',
        workFolder: ROOT, prompt: 'test', stdout: '', stderr: '' }, { usage, tools: [{ tool: 'test' }] });
      assert.deepEqual(compact.agentOutput, { usage });
    }
  });
  check('Usage-only failed result keeps raw output and usage', () => {
    for (const [agent, usage] of [['codex', expectedCodex], ['claude', expectedClaude]]) {
      for (const verbose of [false, true]) {
        const response = buildProcessResult({ pid: 1, agent, status: 'failed', exitCode: 1,
          startTime: '', workFolder: ROOT, prompt: 'test', stdout: 'original stdout', stderr: 'vendor error' },
          { message: null, session_id: 'test', usage }, verbose);
        assert.equal(response.stdout, 'original stdout');
        assert.equal(response.stderr, 'vendor error');
        assert.equal(response.session_id, 'test');
        assert.deepEqual(response.agentOutput, { usage });
      }
    }
  });
  check('Meaningful message preserves normal compact result', () => {
    const response = buildProcessResult({ pid: 1, agent: 'claude', status: 'completed',
      startTime: '', workFolder: ROOT, prompt: 'test', stdout: 'raw stdout', stderr: 'raw stderr' },
      { message: 'done', session_id: 'test', usage: expectedClaude, tools: [{ tool: 'test' }] });
    assert.deepEqual(response.agentOutput, { message: 'done', session_id: 'test', usage: expectedClaude });
    assert.equal(Object.hasOwn(response, 'stdout'), false);
    assert.equal(Object.hasOwn(response, 'stderr'), false);
  });
  check('Explicit expensive efforts warn and preserve command', () => {
    for (const effort of ['xhigh', 'max', 'ultra']) {
      const cmd = buildCliCommand({ ...options, reasoning_effort: effort });
      warning(cmd, effort, 'explicit');
      assert.ok(cmd.args.includes(`model_reasoning_effort=${effort}`));
    }
  });
  check('Flagship aliases warn with actual effort', () => {
    for (const [model, effort] of [['codex-ultra', 'max'], ['codex-ultracode', 'ultra'], ['claude-ultra', 'max']]) {
      const cmd = buildCliCommand({ ...options, model });
      warning(cmd, effort, 'alias');
      assert.ok(cmd.args.includes(model.startsWith('codex') ? `model_reasoning_effort=${effort}` : effort));
    }
  });
  check('Strict builder preserves warning', () => warning(buildCliCommand({ ...options, capabilities: ['fs/read'], reasoning_effort: 'ultra' }), 'ultra', 'explicit'));
  check('Ordinary efforts and unspecified model omit warnings', () => {
    for (const effort of [undefined, 'low', 'medium', 'high'])
      assert.equal(Object.hasOwn(buildCliCommand({ ...options, reasoning_effort: effort }), 'warnings'), false);
  });
  check('Config default and alias override warn as config', () => {
    config({ defaultReasoningEffort: 'ultra' });
    warning(buildCliCommand(options), 'ultra', 'config');
    warning(buildCliCommand({ ...options, model: 'codex-ultra' }), 'ultra', 'config');
    config({ aliasReasoningEffort: { 'codex-ultracode': 'xhigh' } });
    warning(buildCliCommand({ ...options, model: 'codex-ultracode' }), 'xhigh', 'config');
  });
  check('Config medium suppresses alias warning and explicit wins', () => {
    config({ defaultReasoningEffort: 'medium' });
    assert.equal(Object.hasOwn(buildCliCommand({ ...options, model: 'codex-ultra' }), 'warnings'), false);
    warning(buildCliCommand({ ...options, model: 'codex-ultra', reasoning_effort: 'ultra' }), 'ultra', 'explicit');
  });
  check('Environment default warns as config', () => {
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT = 'max';
    try {
      warning(buildCliCommand(options), 'max', 'config');
    } finally {
      delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT;
      config({});
    }
  });
  check('Invalid environment default leaves alias source intact', () => {
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT = 'invalid';
    try {
      warning(buildCliCommand({ ...options, model: 'codex-ultra' }), 'max', 'alias');
    } finally {
      delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT;
    }
  });
  check('Empty alias override resolves builtin source and legacy value', () => {
    const value = { aliasReasoningEffort: { 'codex-ultracode': '' } };
    assert.deepEqual(resolveConfiguredReasoningEffortWithSource('codex-ultracode', value), { effort: 'ultra', source: 'builtin-alias' });
    assert.equal(resolveConfiguredReasoningEffort('codex-ultracode', value), 'ultra');
    config(value);
    warning(buildCliCommand({ ...options, model: 'codex-ultracode' }), 'ultra', 'alias');
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT = 'invalid';
    try {
      assert.deepEqual(resolveConfiguredReasoningEffortWithSource('codex-ultracode', value), { effort: 'ultra', source: 'builtin-alias' });
      warning(buildCliCommand({ ...options, model: 'codex-ultracode' }), 'ultra', 'alias');
    } finally { delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT; config({}); }
  });
  check('Configured effort source follows actual precedence', () => {
    const value = { defaultReasoningEffort: 'max', aliasReasoningEffort: { 'codex-ultracode': 'xhigh' } };
    assert.deepEqual(resolveConfiguredReasoningEffortWithSource('codex-ultracode', value), { effort: 'xhigh', source: 'alias-override' });
    assert.deepEqual(resolveConfiguredReasoningEffortWithSource('codex', value), { effort: 'max', source: 'config-default' });
    assert.deepEqual(resolveConfiguredReasoningEffortWithSource('codex', {}), { effort: undefined, source: 'builtin-alias' });
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT = ' ULTRA ';
    try {
      assert.deepEqual(resolveConfiguredReasoningEffortWithSource('codex-ultracode', value), { effort: 'ultra', source: 'env' });
    } finally { delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT; }
  });
  check('MCP start response forwards warning without real spawn', () => {
    const service = new ProcessService({ cliPaths: options.cliPaths, breaker: { check() {} } });
    warning(service.startProcess({ ...options, reasoning_effort: 'ultra' }), 'ultra', 'explicit');
    assert.equal(Object.hasOwn(service.startProcess({ ...options, reasoning_effort: 'medium' }), 'warnings'), false);
    assert.equal(spawnCount, 2);
  });
  await checkAsync('CLI run forwards ultra warnings without vendor spawn', async () => {
    const service = new FileProcessService({ stateDir: process.env.AI_CLI_STATE_DIR, cliPaths: options.cliPaths, breaker: { check() {} } });
    const before = spawnCount;
    for (const effort of ['ultra', 'medium']) {
      let stdout = '';
      const code = await runCli(['run', '--cwd', ROOT, '--prompt', 'CLI usage test', '--model', 'codex', '--reasoning-effort', effort], {
        stdout: (text) => { stdout += text; }, stderr: (text) => { throw new Error(text); },
        runProcess: (request) => service.startProcess(request),
      });
      assert.equal(code, 0);
      const output = JSON.parse(stdout);
      if (effort === 'ultra') warning(output, 'ultra', 'explicit');
      else assert.equal(Object.hasOwn(output, 'warnings'), false);
    }
    assert.equal(spawnCount - before, 2);
  });
  const guidance = getModelsPayload().dispatchGuidance;
  for (const [situation, terms] of [
    ['合併零碎小任務', ['2 萬', '3 萬', '固定開銷', '合併']],
    ['避免重複派工', ['重複派兩個 job', '交叉驗證']],
    ['減少輪詢成本', ['自己 session', 'wait', '90 秒', 'peek', '5~10 秒']],
    ['記錄每個 job 用量', ['agentOutput.usage', 'unknown', 'cost_usd_nominal', '訂閱帳單']],
  ]) check(`Dispatch guidance: ${situation}`, () => {
    const entry = guidance.find((g) => g.situation === situation);
    assert.ok(entry);
    for (const term of terms) assert.ok(entry.note.includes(term), term);
  });
  check('MCP run description points to cost guidance', () => assert.ok(
    readFileSync(join(ROOT, 'src/app/mcp.ts'), 'utf8').includes("For cost-aware dispatch (batching, duplicate jobs, polling, and agentOutput.usage), read the models tool's dispatchGuidance.")));
  // 輪詢成本（2026-10-06 實測）：執行中的 claude job 只解析得出 session_id，
  // wait 每次都回傳約 90 KB 的原始 stream-json。精簡結果不再整份帶原始輸出。
  const big = 'x'.repeat(90_000);
  const ctx = (status) => ({ pid: 9, agent: 'claude', status, startTime: '', workFolder: '', prompt: 'p', stdout: `${big}TAIL-END`, stderr: 'boom', liveness: { alive: true } });
  check('Running job compact result omits raw stdout', () => {
    const r = buildProcessResult(ctx('running'), { session_id: 's1', message: null });
    assert.equal(Object.hasOwn(r, 'stdout'), false);
    assert.equal(Object.hasOwn(r, 'stderr'), false);
    assert.deepEqual(r.liveness, { alive: true });
    assert.equal(r.session_id, 's1');
  });
  check('Finished job without reply keeps only the raw output tail', () => {
    const r = buildProcessResult(ctx('failed'), { session_id: 's1', message: null });
    assert.equal(r.stdout.length, 4096);
    assert.ok(r.stdout.endsWith('TAIL-END'));
    assert.deepEqual(r.stdoutTruncated, { totalChars: 90_008, shownChars: 4096 });
    assert.equal(r.stderr, 'boom');
    assert.equal(Object.hasOwn(r, 'stderrTruncated'), false);
  });
  check('Verbose result still returns the full raw output', () => {
    const r = buildProcessResult(ctx('running'), { session_id: 's1', message: null }, true);
    assert.equal(r.stdout.length, 90_008);
    assert.equal(Object.hasOwn(r, 'stdoutTruncated'), false);
  });
  check('Job with a reply still omits raw output', () => {
    const r = buildProcessResult(ctx('completed'), { session_id: 's1', message: 'done' });
    assert.equal(Object.hasOwn(r, 'stdout'), false);
    assert.equal(r.agentOutput.message, 'done');
  });
} finally {
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
}
console.log(`verify-job-usage: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
