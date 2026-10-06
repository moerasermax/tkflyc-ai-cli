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
cp.spawn = () => {
  spawnCount++;
  return Object.assign(new EventEmitter(), {
    pid: nextPid++, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  });
};
syncBuiltinESMExports();
delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT;
const { codexAgent } = await load('dist/agents/codex.js');
const { claudeAgent } = await load('dist/agents/claude.js');
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
const expectedClaude = { input_tokens: 9, cached_input_tokens: 17734, cache_write_input_tokens: 12528,
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
  check('Codex single turn usage', () => assert.deepEqual(codexAgent.parseOutput(line(turn), '').usage, expectedCodex));
  check('Codex multiple turns sum usage', () => assert.deepEqual(
    codexAgent.parseOutput(`${line(turn)}\n${line(turn)}`, '').usage,
    Object.fromEntries(Object.entries(expectedCodex).map(([key, value]) => [key, typeof value === 'number' ? value * 2 : value]))));
  check('Codex optional counters sum', () => assert.deepEqual(
    codexAgent.parseOutput(line({ ...turn, usage: { ...turn.usage, cache_write_input_tokens: 11, reasoning_output_tokens: 7 } }), '').usage,
    { ...expectedCodex, cache_write_input_tokens: 11, reasoning_output_tokens: 7 }));
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
    warning(buildCliCommand(options), 'max', 'config');
    delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT;
    config({});
  });
  check('Invalid environment default leaves alias source intact', () => {
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT = 'invalid';
    warning(buildCliCommand({ ...options, model: 'codex-ultra' }), 'max', 'alias');
    delete process.env.AI_CLI_DEFAULT_REASONING_EFFORT;
  });
  check('MCP start response forwards warning without real spawn', () => {
    const service = new ProcessService({ cliPaths: options.cliPaths, breaker: { check() {} } });
    warning(service.startProcess({ ...options, reasoning_effort: 'ultra' }), 'ultra', 'explicit');
    assert.equal(Object.hasOwn(service.startProcess({ ...options, reasoning_effort: 'medium' }), 'warnings'), false);
    assert.equal(spawnCount, 2);
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
} finally {
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
}
console.log(`verify-job-usage: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
