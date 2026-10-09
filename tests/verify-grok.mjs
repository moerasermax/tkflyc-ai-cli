/** Grok stub-only：參數、rules、usage、vendor 探查、runner 接回與唯讀 fail-closed。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokAgent, parseGrokModelsOutput } from '../dist/agents/grok.js';
import { WORKER_CONTEXT } from '../dist/core/worker-context.js';
import { buildCliCommand } from '../dist/core/command-builder.js';
import { getAgent, selectAgentForModel } from '../dist/agents/registry.js';
import { inspectCliBinary } from '../dist/core/binary-resolver.js';
import { getCliDoctorStatus } from '../dist/core/doctor.js';
import { getModelsPayload, getSupportedModelsDescription, getModelParameterDescription } from '../dist/models/catalog.js';
import { clearCatalogCache, refreshCatalogV2 } from '../dist/models/catalog-v2.js';
import { JobStore, jobResult, collectStoreFiles, RETENTION_MS } from '../dist/core/job-store.js';
import { PeekEventExtractor, LivenessEventExtractor } from '../dist/core/peek-extractor.js';
import { FileProcessService } from '../dist/core/file-process-service.js';
import { ProcessService } from '../dist/core/process-service.js';
import * as acceptance from '../tools/acceptance/worker-identity-logic.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-grok-test-'));
const STUB = join(ROOT, 'tools/stubs/grok-agent.mjs');
const section = process.argv[2];
let passed = 0, failed = 0;
const promptFiles = new Set();
const stores = new Set();
async function check(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack); } }
const value = (args, flag) => args[args.indexOf(flag) + 1];
const input = { cliPath: 'C:\\Users\\stub\\.grok\\bin\\grok.exe', cwd: ROOT,
  prompt: '長中文 "quotes"\n'.repeat(3000), resolvedModel: 'grok-4.7', rawModel: 'grok-4.7', reasoningEffort: 'medium' };
function build(overrides = {}, capabilities) {
  const command = capabilities === undefined ? grokAgent.buildCommand({ ...input, ...overrides })
    : grokAgent.buildStrictCommand({ ...input, ...overrides }, capabilities);
  promptFiles.add(value(command.args, '--prompt-file')); return command;
}
const fixture = { type: 'result', subtype: 'success', is_error: false, duration_ms: 7631, num_turns: 1, result: 'fixture answer',
  stop_reason: 'end_turn', total_cost_usd: 0.02655808, usage: { input_tokens: 17306, output_tokens: 602,
    cache_read_input_tokens: 1664, cache_creation_input_tokens: 0 }, modelUsage: {}, session_id: '01a11ed9-stub', uuid: 'fixture' };
const modelsFixture = 'Default model: grok-4.7\r\nAvailable models:\r\n* grok-4.7 (default)\r\n- grok-4.7-build-fast\r\n- grok-4.6\r\n- grok-4.5';
const modules = createRequire(import.meta.url)('node:child_process');
const originalSpawn = modules.spawn;
const discoveryChildren = [];
const nativeStub = join(TEMP, 'grok.exe'); writeFileSync(nativeStub, 'stub'); chmodSync(nativeStub, 0o755);
// 模擬 native executable，用真的 Node stub 子行程驗證 close/error/timeout。其他 spawn 保留。
modules.spawn = (path, args, options) => {
  if (path !== nativeStub) return originalSpawn(path, args, options);
  const child = originalSpawn(process.execPath, [STUB, ...args], options); discoveryChildren.push(child); return child;
};
syncBuiltinESMExports();
const originalBuild = grokAgent.buildCommand;
function stubCommand(i) { const c = originalBuild(i); promptFiles.add(value(c.args, '--prompt-file')); return { ...c, cliPath: process.execPath, args: [STUB, ...c.args] }; }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 300; i++) { const result = await fn(); if (result) return result; await pause(50); } throw Error('stub deadline'); }
try {
if (!section || section === 'command') {
  await check('Grok normal native argv and long prompt file', () => {
    const c = build(); assert.equal(c.cliPath, input.cliPath); assert.equal(c.agent, 'grok'); assert.equal(c.stdinPrompt, undefined);
    assert.equal(readFileSync(value(c.args, '--prompt-file'), 'utf8'), input.prompt);
    assert.deepEqual(c.args, ['--prompt-file', value(c.args, '--prompt-file'), '--output-format', 'streaming-messages-json',
      '--always-approve', '--no-subagents', '--cwd', ROOT, '--rules', WORKER_CONTEXT, '-m', 'grok-4.7', '--reasoning-effort', 'medium']);
    assert.equal(grokAgent.win32DirectExec, true); assert.equal(grokAgent.spawnMode, 'pipe');
  });
  await check('Grok rules worker lock precedes system prompt on every resume', () => {
    for (const capabilities of [undefined, ['fs/read']]) {
      const c = build({ systemPrompt: '你是稽核者。\n"只回報"', sessionId: 'session-123' }, capabilities);
      assert.equal(value(c.args, '--rules'), WORKER_CONTEXT + '\n\n你是稽核者。\n"只回報"');
      assert.equal(value(c.args, '--resume'), 'session-123'); assert.equal(c.sessionId, 'session-123');
      assert(!c.args.includes('--system-prompt-override')); assert(!c.args.includes('--session-id'));
    }
  });
  await check('Grok strict permits only read tools and blocks shell writes web subagents', () => {
    const c = build({}, ['fs/read', 'analysis/produce']); assert.equal(value(c.args, '--tools'), 'Read,Glob,Grep');
    const denied = value(c.args, '--disallowed-tools').split(',');
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Task', 'Agent', 'ToolSearch', 'search_tool', 'use_tool', 'run_terminal_command', 'write', 'search_replace', 'spawn_subagent', 'workflow', 'scheduler_create', 'monitor', 'web_fetch', 'web_search', 'image_gen', 'image_edit']) assert(denied.includes(tool));
    assert(c.args.includes('--disable-web-search')); assert(c.args.includes('--no-subagents'));
    assert.equal(value(c.args, '--permission-mode'), 'dontAsk'); assert(!c.args.includes('--always-approve'));
    assert.throws(() => build({}, []), /零工具模式.*拒絕啟動/);
    assert.throws(() => build({}, ['analysis/produce']), /零工具模式.*拒絕啟動/);
    assert.throws(() => build({}, ['fs/write']), /拒絕啟動/); assert.throws(() => build({}, ['shell/run']), /拒絕啟動/);
  });
  await check('Grok command-builder routing effort strict and system_prompt', () => {
    const opts = { prompt: 'hello', workFolder: ROOT, model: 'grok-4.7-build-fast', cliPaths: { grok: input.cliPath },
      system_prompt: 'system test', reasoning_effort: 'high', session_id: 'resume' };
    for (const caps of [undefined, ['fs/read']]) {
      const c = buildCliCommand({ ...opts, capabilities: caps }); promptFiles.add(value(c.args, '--prompt-file'));
      assert.equal(c.agent, 'grok'); assert.equal(c.reasoningEffort, 'high'); assert.equal(value(c.args, '--rules'), WORKER_CONTEXT + '\n\nsystem test');
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh']) assert(grokAgent.reasoning.allowed.has(effort));
    assert.throws(() => buildCliCommand({ ...opts, reasoning_effort: 'max' }), /only low, medium, high/);
    assert.equal(selectAgentForModel('grok-future').id, 'grok');
  });
}
if (!section || section === 'parse') {
  await check('Grok result fixture normalizes usage costs and session single JSON NDJSON', () => {
    for (const text of [JSON.stringify(fixture), JSON.stringify({ type: 'system', session_id: fixture.session_id }) + '\n' + JSON.stringify(fixture)]) {
      const r = grokAgent.parseOutput(text, ''); assert.equal(r.message, 'fixture answer'); assert.equal(r.session_id, fixture.session_id);
      assert.deepEqual(r.usage, { input_tokens: 18970, cached_input_tokens: 1664, cache_write_input_tokens: 0, output_tokens: 602,
        reasoning_output_tokens: 0, num_turns: 1, cost_usd_nominal: 0.02655808, source: 'grok result' });
      assert.deepEqual(r.raw_usage, fixture.usage); assert.equal(r.is_error, false); assert.equal(r.stop_reason, 'end_turn');
    }
  });
  await check('Grok parser assistant tools errors malformed usage and empty result', () => {
    const events = [{ type: 'system', session_id: 'session' }, { type: 'assistant', message: { content: [
      { type: 'text', text: 'assistant only' }, { type: 'tool_use', id: 'tool1', name: 'Read', input: { path: 'file' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'body' }] } }];
    const r = grokAgent.parseOutput('junk\n' + events.map(JSON.stringify).join('\n'), ''); assert.equal(r.message, 'assistant only');
    assert.equal(r.tools[0].output, 'body'); assert.equal(r.session_id, 'session');
    for (const failure of [{ subtype: 'error_during_execution', stop_reason: 'end_turn' }, { subtype: 'success', stop_reason: 'cancelled' }]) {
      const out = grokAgent.parseOutput(JSON.stringify({ ...fixture, ...failure, is_error: false, result: null }), '');
      assert.equal(out.is_error, true); assert(out.error.includes(failure.subtype)); assert(out.error.includes(failure.stop_reason));
    }
    const err = grokAgent.parseOutput(JSON.stringify({ ...fixture, result: '', is_error: true, subtype: 'error' }), '');
    assert.equal(err.is_error, true); assert.equal(err.message, '');
    for (const raw of [{ input_tokens: -1, output_tokens: 2 }, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 'bad' }]) {
      assert.equal(grokAgent.parseOutput(JSON.stringify({ ...fixture, usage: raw }), '').usage, undefined);
    }
    assert.equal(grokAgent.parseOutput('', ''), null);
    const peek = new PeekEventExtractor('grok', { includeToolCalls: true }); assert.equal(peek.push(events.map(JSON.stringify).join('\n') + '\n').filter(e => e.kind === 'tool_call').length, 2);
    assert(new LivenessEventExtractor('grok').push(JSON.stringify(events[1]) + '\n')[0].includes('Read'));
  });
}
if (!section || section === 'discovery') {
  await check('Grok model discovery fixture rejects unauthenticated output', () => {
    assert.deepEqual(parseGrokModelsOutput(modelsFixture), grokAgent.models);
    assert.deepEqual(parseGrokModelsOutput('\x1b[32m' + modelsFixture + '\x1b[0m'), grokAgent.models);
    for (const text of ['Default model: grok-4.7\nPlease login', 'Please log in first', 'Available models:\nlogin-required']) assert.equal(parseGrokModelsOutput(text), null);
  });
  await check('Grok vendor discovery success env nonzero unauthenticated spawn failure timeout', async () => {
    const r = await grokAgent.discoverModels(nativeStub); assert.deepEqual(r.models, grokAgent.models); assert.equal(r.note, null);
    for (const mode of ['error', 'unauthenticated']) { process.env.GROK_STUB_DISCOVERY = mode; const fail = await grokAgent.discoverModels(nativeStub); assert.equal(fail.models, null); assert.match(fail.note, /log in/); }
    const missing = await grokAgent.discoverModels(join(TEMP, 'missing')); assert.equal(missing.models, null);
    process.env.GROK_STUB_DISCOVERY = 'timeout'; process.env.AI_CLI_DISCOVER_TIMEOUT_MS = '100';
    const started = Date.now(); const timeout = await grokAgent.discoverModels(nativeStub); assert.equal(timeout.models, null); assert.match(timeout.note, /逾時/); assert(Date.now() - started < 3000);
    const child = discoveryChildren.at(-1); await until(() => child.exitCode !== null || child.signalCode !== null);
    delete process.env.GROK_STUB_DISCOVERY; delete process.env.AI_CLI_DISCOVER_TIMEOUT_MS;
  });
  await check('Grok catalog vendor success failure fallback models CLI and doctor', async () => {
    process.env.GROK_CLI_NAME = nativeStub; clearCatalogCache({ disk: true });
    const catalog = await refreshCatalogV2({ force: true }); assert.equal(catalog.agents.find(a => a.agent === 'grok').source, 'vendor-cli');
    assert(catalog.entries.filter(e => e.agent === 'grok').every(e => e.routable && e.displayName.startsWith('xAI_')));
    process.env.GROK_STUB_DISCOVERY = 'unauthenticated';
    const retained = await refreshCatalogV2({ force: true }); assert.equal(retained.agents.find(a => a.agent === 'grok').source, 'vendor-cli');
    assert(retained.agents.find(a => a.agent === 'grok').discoveryNote.includes('log in'));
    clearCatalogCache({ disk: true }); await refreshCatalogV2({ force: true });
    const payload = getModelsPayload(); assert.deepEqual(payload.grok, grokAgent.models); assert.equal(payload.catalogV2.agents.find(a => a.agent === 'grok').source, 'builtin-fallback');
    assert(payload.catalogV2.agents.find(a => a.agent === 'grok').discoveryNote.includes('log in'));
    assert(getSupportedModelsDescription().includes('grok-4.7')); assert(getModelParameterDescription().includes('grok-4.5'));
    assert.equal(getCliDoctorStatus().grok.resolvedPath, nativeStub);
    // 子 CLI 安全 override 是 Node，models 探查只會以 Node 執行不存在的 models，絕不呼叫真 Grok。
    const result = spawnSync(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), 'models', '--json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GROK_CLI_NAME: process.execPath } });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).grok, grokAgent.models);
    delete process.env.GROK_STUB_DISCOVERY; process.env.GROK_CLI_NAME = process.execPath;
  });
  await check('Grok binary PATH then local fallback env override and existing precedence', () => {
    const saved = process.env.PATH; delete process.env.GROK_CLI_NAME;
    const pathDir = join(TEMP, 'path-bin'); mkdirSync(pathDir);
    const name = process.platform === 'win32' ? 'grok.EXE' : 'grok'; const path = join(pathDir, name); writeFileSync(path, 'stub'); chmodSync(path, 0o755);
    process.env.PATH = pathDir + delimiter + saved;
    const config = { ...grokAgent.binary, localInstallPath: nativeStub };
    assert.equal(inspectCliBinary(config).lookup, 'path'); assert.equal(inspectCliBinary(config).resolvedPath, path);
    assert.equal(inspectCliBinary({ ...config, preferPath: false }).lookup, 'local');
    process.env.PATH = ''; assert.equal(inspectCliBinary(config).resolvedPath, nativeStub); assert.equal(inspectCliBinary(config).lookup, 'local');
    process.env.GROK_CLI_NAME = process.execPath; assert.equal(inspectCliBinary(config).lookup, 'env'); process.env.PATH = saved;
  });
}
if (!section || section === 'jobs') {
  grokAgent.buildCommand = stubCommand;
  await check('Grok JobStore recovers running without redispatch and preserves worker env session usage', async () => {
    const state = join(TEMP, 'recovered'); const capture = join(TEMP, 'captured.json'), release = join(TEMP, 'release');
    const first = new JobStore(state, 'mcp'); stores.add(first); await first.ready;
    const cmd = buildCliCommand({ cliPaths: { grok: process.execPath }, model: 'grok-4.7', workFolder: ROOT,
      prompt: JSON.stringify({ release, capture }), session_id: 'original', system_prompt: 'system test' });
    const job = first.start(cmd, 'grok-4.7'); await until(() => existsSync(join(job.directory, 'meta.json')) && existsSync(capture)); first.dispose();
    const second = new JobStore(state, 'mcp'); stores.add(second);
    try {
      await second.ready;
      assert.equal(second.get(job.pid).recovered, true); assert.equal(second.get(job.pid).status, 'running');
    } finally { writeFileSync(release, 'ready'); }
    const [result] = await second.wait([job.pid], 15); assert.equal(result.status, 'completed'); assert.equal(result.recovered, true);
    assert.equal(result.agentOutput.message, '完整輸出：PONG'); assert.equal(result.agentOutput.session_id, 'grok-stub-session'); assert.equal(result.agentOutput.usage.input_tokens, 18970);
    const meta = JSON.parse(readFileSync(join(job.directory, 'meta.json'))); assert.equal(meta.sessionId, 'original'); assert.equal(meta.agent, 'grok');
    const sent = JSON.parse(readFileSync(capture)); assert.equal(sent.worker, '1'); assert.equal(sent.rules, WORKER_CONTEXT + '\n\nsystem test');
    assert.equal(second.jobs.size, 1);
    const third = new JobStore(state, 'mcp'); stores.add(third); await third.ready; assert.equal(jobResult(third.get(job.pid)).agentOutput.usage.cost_usd_nominal, 0.02655808);
    const end = Date.parse(JSON.parse(readFileSync(join(job.directory, 'exit.json'))).endTime);
    assert.deepEqual(await collectStoreFiles(state, end + RETENTION_MS - 1), []);
    assert.deepEqual(await collectStoreFiles(state, end + RETENTION_MS + 1), [meta.jobId]);
  });
  await check('Grok result failure exit zero remains failed in durable runner', async () => {
    const store = new JobStore(join(TEMP, 'error')); stores.add(store); await store.ready;
    const c = stubCommand({ ...input, prompt: JSON.stringify({ error: true }) }); const job = store.start(c);
    const [result] = await store.wait([job.pid], 15); assert.equal(result.exitCode, 0); assert.equal(result.status, 'failed');
    assert.equal(jobResult(job, true).agentOutput.is_error, true);
    for (const spec of [{ subtype: 'error_during_execution' }, { stop_reason: 'cancelled' }]) {
      const failed = store.start(stubCommand({ ...input, prompt: JSON.stringify(spec) }));
      const [r] = await store.wait([failed.pid], 15); assert.equal(r.status, 'failed');
      assert.match(r.agentOutput.error, /subtype=.*stop_reason=/); assert.ok(r.jobId);
    }
  });
  await check('Grok MCP and CLI process services select durable runner', async () => {
    const svc = new ProcessService({ cliPaths: { claude: '', codex: '', antigravity: '', grok: process.execPath } }); await svc.ready;
    try { const { pid } = svc.startProcess({ model: 'grok-4.7', workFolder: ROOT, prompt: '{}' }); const result = (await svc.waitForProcesses([pid], 15))[0]; assert.equal(result.status, 'completed'); assert.equal(result.agent, 'grok'); }
    finally { svc.dispose(); }
    const file = new FileProcessService({ stateDir: join(TEMP, 'file-service'), cliPaths: { grok: process.execPath } });
    try {
      const { pid } = await file.startProcess({ model: 'grok-4.7', cwd: ROOT, prompt: '{}' });
      const [r] = await file.waitForProcesses([pid], 15); assert.equal(r.status, 'completed'); assert.equal(r.agent, 'grok');
    } finally { file.dispose(); }
  });
}
if (!section || section === 'acceptance') {
  await check('Grok indirect MCP fixture distinguishes blocked and unblocked dispatch', () => {
    const content = [{ type: 'tool_use', id: 'search', name: 'search_tool', input: { query: 'ai-cli run', limit: 5 } },
      { type: 'tool_use', id: 'run', name: 'use_tool', input: { tool_name: 'ai-cli__run', tool_input: { model: 'haiku', workFolder: 'stub', prompt: '只回：好' } } }];
    const result = { type: 'tool_result', tool_use_id: 'run', is_error: true, content: '{"error":"tool_execution_failed","message":"Mcp error: -32600: AI_CLI_NESTED_DISPATCH_BLOCKED: stub"}' };
    const ndjson = JSON.stringify({ type: 'assistant', message: { content } }) + '\n' + JSON.stringify({ type: 'user', message: { content: [result] } });
    const tools = acceptance.toolRecords(ndjson); assert.equal(acceptance.aiCliTools(tools).length, 1);
    assert.equal(acceptance.unblockedAiCliTools({ tools }).length, 0);
    // fixture 原文沒有 call id；Grok 的序列工具結果仍要配回最後一次呼叫。
    const noIds = content.map(({ id, ...rest }) => rest);
    const { tool_use_id, ...noIdResult } = result;
    const native = acceptance.toolRecords(JSON.stringify({ type: 'assistant', message: { content: noIds } }) + '\n' + JSON.stringify({ type: 'user', message: { content: [noIdResult] } }));
    assert.equal(acceptance.unblockedAiCliTools({ tools: native }).length, 0);
    const allowed = acceptance.toolRecords(ndjson.replace('AI_CLI_NESTED_DISPATCH_BLOCKED', 'completed'));
    assert.equal(acceptance.unblockedAiCliTools({ tools: allowed }).length, 1);
    for (const name of ['ai-cli__run', 'mcp__ai-cli__run']) assert.equal(acceptance.aiCliTools([{ name: 'use_tool', input: { tool_name: name } }]).length, 1);
    const completed = message => ({ status: 'completed', exitCode: 0, agentOutput: { message } });
    const base = { family: 'grok', probe: { result: completed('A=沒有\nB=有') }, t6: { result: completed('done'), add: { passed: true }, peak: 1, tools } };
    assert.equal(acceptance.judgeModel(base).verdict, 'PASS', JSON.stringify(acceptance.judgeModel(base)));
    assert.equal(acceptance.judgeModel({ ...base, t6: { ...base.t6, tools: allowed } }).failureClass, 'safety');
  });
  await check('Grok acceptance requires A absent B present and counts native workers T6', () => {
    assert.deepEqual(acceptance.selectModels({ grok: ['grok-4.7'] }, { families: ['grok'] }), [{ family: 'grok', model: 'grok-4.7' }]);
    assert.deepEqual(acceptance.probeFailures(acceptance.parseProbe('A=沒有\nB=有'), 'grok'), []);
    assert(acceptance.probeFailures(acceptance.parseProbe('A=沒有\nB=沒有'), 'grok').length);
    assert(acceptance.probeFailures(acceptance.parseProbe('A=有\nB=有'), 'grok').length);
    for (const name of ['grok.exe', 'agent.exe']) assert(acceptance.isWorker({ name, command: `${name} --prompt-file p.txt --output-format streaming-messages-json` }));
    for (const flag of ['--prompt-json', '--prompt-file=p.txt', '--single=hello']) assert(acceptance.isWorker({ name: 'grok', command: `grok ${flag} --output-format=streaming-messages-json` }));
    assert(!acceptance.isWorker({ name: 'grok.exe', command: 'grok.exe models' }));
    const result = message => ({ status: 'completed', exitCode: 0, agentOutput: { message } });
    assert.equal(acceptance.judgeModel({ family: 'grok', probe: { result: result('A=沒有\nB=有') }, t6: { result: result('done'), add: { passed: true }, peak: 1 } }).verdict, 'PASS');
    assert.equal(acceptance.judgeModel({ family: 'grok', probe: { result: result('A=沒有\nB=有') }, t6: { result: result('done'), add: { passed: true }, peak: 2 } }).failureClass, 'safety');
  });
}
} finally {
  grokAgent.buildCommand = originalBuild; modules.spawn = originalSpawn; syncBuiltinESMExports();
  for (const store of stores) { for (const job of store.jobs.values()) if (job.status === 'running' && existsSync(job.directory)) await store.kill(job.pid); store.dispose(); }
  for (const path of promptFiles) rmSync(path, { force: true }); rmSync(TEMP, { recursive: true, force: true });
}
console.log(`grok: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
