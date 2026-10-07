/** F1–F3 / G1–G2：隔離設定、CLI stub、mock fetch、假行程表；不呼叫真模型。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertCanStartJob, buildWorkerEnv, NESTED_DISPATCH_ERROR } from '../dist/core/worker-env.js';
import { WORKER_CONTEXT } from '../dist/core/worker-context.js';
import { buildCliCommand } from '../dist/core/command-builder.js';
import { ProcessService } from '../dist/core/process-service.js';
import { FileProcessService } from '../dist/core/file-process-service.js';
import { getAgent } from '../dist/agents/registry.js';
import { runCli } from '../dist/app/cli.js';
import { AiCliMcpServer } from '../dist/app/mcp.js';
import * as logic from '../tools/acceptance/worker-identity-logic.mjs';
import * as runtime from '../tools/acceptance/worker-identity-runtime.mjs';
import { runAcceptance, parseArgs } from '../tools/acceptance/worker-identity.mjs';

let passed = 0, failed = 0;
async function check(name, fn) {
  if (process.env.WORKER_GUARDS_FILTER && !name.includes(process.env.WORKER_GUARDS_FILTER)) return;
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name} — ${e.stack}`); }
}
const temp = await mkdtemp(join(tmpdir(), 'worker-guards-'));
const cli = fileURLToPath(new URL('../dist/bin/ai-cli.js', import.meta.url));
const js = join(temp, 'vendor.mjs');
const stub = process.platform === 'win32' ? join(temp, 'vendor.cmd') : js;
const trace = join(temp, 'trace.jsonl');
const preload = join(temp, 'exec-fixture.mjs');
await writeFile(js, '#!/usr/bin/env node\nimport{appendFileSync}from"node:fs";appendFileSync(process.env.GUARD_TRACE,JSON.stringify({args:process.argv.slice(2),worker:process.env.AI_CLI_WORKER})+"\\n");console.log(JSON.stringify({type:"result",result:"stub done"}));process.stdin.resume();\n');
if (process.platform === 'win32') await writeFile(stub, `@echo off\r\n"${process.execPath}" "%~dp0vendor.mjs" %*\r\n`);
else await chmod(js, 0o755);
// Windows exec 不支援 .cmd；只替換 vendor builder 為 Node fixture，仍走真 CLI exec 入口。
await writeFile(preload, `import { getAgent } from ${JSON.stringify(new URL('../dist/agents/registry.js', import.meta.url).href)};
if (process.argv.includes('exec')) getAgent('claude').buildCommand = input => ({cliPath:process.execPath,args:[${JSON.stringify(js)}],cwd:input.cwd,agent:'claude',prompt:input.prompt,resolvedModel:input.resolvedModel});\n`);
const baseEnv = { ...process.env, CLAUDE_CLI_NAME: stub, CODEX_CLI_NAME: stub, GUARD_TRACE: trace };
const paths = { claude: stub, codex: stub, antigravity: stub };
await writeFile(process.env.AI_CLI_PROVIDERS_PATH, JSON.stringify({ providers: { openrouter: { base_url: 'https://stub.invalid/v1', api_key: 'stub' } } }));
const done = message => ({ status: 'completed', exitCode: 0, agentOutput: { message } });
const p = (pid, ppid, ms, name = 'cmd.exe', command = '') => ({ pid, ppid, started: new Date(ms).toISOString(), name, command });
async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const key of ['AI_CLI_WORKER', 'AI_CLI_ALLOW_NESTED']) delete process.env[key];
  Object.assign(process.env, env);
  try { return await fn(); }
  finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
}
function childCli(args, env, input = '', delayInput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', releasedInput = false;
    child.stdout.setEncoding('utf8').on('data', s => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', s => { stderr += s; });
    child.stdin.on('error', () => {});
    const timer = delayInput ? setTimeout(() => { releasedInput = true; child.stdin.end(input); }, 3000) : null;
    if (!delayInput) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, releasedInput }); });
  });
}

try {
  await check('F1 四要素與 F3 常數逐字等於 hook WORKER_CONTEXT', async () => {
    const source = (await readFile(new URL('../tools/hooks/aicli-model-policy.py', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal(WORKER_CONTEXT, source.match(/^WORKER_CONTEXT = """([\s\S]*?)"""/m)[1]);
    assert.equal(WORKER_CONTEXT.split('\n').length, 5);
    for (const text of ['再派工／交給別的模型／用 ai-cli 或其他 CLI 轉派', '直接自己完成', '不要停下來問', '只有真正缺資訊']) assert(WORKER_CONTEXT.includes(text));
  });
  await check('F2 helper 僅 worker=1 拒絕且只有 allow=1 可解除', () => {
    for (const env of [{}, { AI_CLI_WORKER: '0' }, { AI_CLI_WORKER: 'true' }, { AI_CLI_WORKER: '1', AI_CLI_ALLOW_NESTED: '1' }]) assert.doesNotThrow(() => assertCanStartJob(env));
    for (const allow of [undefined, '0', 'true']) assert.throws(() => assertCanStartJob({ AI_CLI_WORKER: '1', AI_CLI_ALLOW_NESTED: allow }), e => e.message === NESTED_DISPATCH_ERROR && e.message.includes('AI_CLI_ALLOW_NESTED=1'));
  });
  await check('F2 buildWorkerEnv 不改主導者環境或觸發自身閘門', async () => withEnv({}, () => {
    assert.equal(buildWorkerEnv().AI_CLI_WORKER, '1'); assert.equal(process.env.AI_CLI_WORKER, undefined); assertCanStartJob();
  }));
  await check('F2 直接呼叫 ProcessService 與 FileProcessService 也拒絕', async () => withEnv({ AI_CLI_WORKER: '1' }, async () => {
    assert.throws(() => new ProcessService({ cliPaths: paths }).startProcess({ workFolder: temp, prompt: 'stub', model: 'codex' }), /AI_CLI_NESTED_DISPATCH_BLOCKED/);
    await assert.rejects(new FileProcessService({ stateDir: join(temp, 'state'), cliPaths: paths }).startProcess({ cwd: temp, prompt: 'stub', model: 'codex' }), /AI_CLI_NESTED_DISPATCH_BLOCKED/);
  }));
  await check('F2 CLI run 在依賴啟動前拒絕，不能被 stub runProcess 繞過', async () => withEnv({ AI_CLI_WORKER: '1' }, async () => {
    let launched = false, error = '';
    const code = await runCli(['run', '--cwd', temp, '--prompt', 'stub'], { runProcess: async () => { launched = true; }, stderr: s => { error += s; }, stdout: () => {} });
    assert.equal(code, 1); assert(!launched); assert(error.includes(NESTED_DISPATCH_ERROR));
  }));
  await check('F2 MCP run 在設定檢查與 service 前拒絕', async () => withEnv({ ...baseEnv, AI_CLI_WORKER: '1' }, async () => {
    const server = new AiCliMcpServer(); let launched = false;
    server.getCliConfigurationError = () => 'stub configuration unavailable';
    server.processService.startProcess = () => { launched = true; };
    try { assert.throws(() => server.handleRun({}), e => e.message.includes(NESTED_DISPATCH_ERROR) && e.code === -32600); assert(!launched); }
    finally { await server.cleanup(); }
  }));
  for (const [label, env, blocked] of [['無標記', {}, false], ['worker', { AI_CLI_WORKER: '1' }, true], ['worker opt-in', { AI_CLI_WORKER: '1', AI_CLI_ALLOW_NESTED: '1' }, false]]) {
    await check(`F2 CLI run/exec ${label} 用真入口與 vendor stub`, async () => {
      const run = await childCli(['run', '--cwd', temp, '--prompt', 'stub', '--model', 'haiku'], env);
      const exec = await childCli(['exec'], env, JSON.stringify({ cwd: temp, model: 'haiku', prompt: 'stub', authority: 'unrestricted' }));
      if (blocked) { assert.notEqual(run.code, 0); assert(run.stderr.includes(NESTED_DISPATCH_ERROR)); assert.notEqual(exec.code, 0); assert(exec.stdout.includes(NESTED_DISPATCH_ERROR)); assert(!exec.stdout.includes('"type":"started"')); }
      else { assert.equal(run.code, 0, run.stderr); const result = JSON.parse(run.stdout); const wait = await childCli(['wait', String(result.pid), '--timeout', '10'], env); assert.equal(wait.code, 0); assert.equal(JSON.parse(wait.stdout)[0].status, 'completed'); assert.equal(exec.code, 0, exec.stderr); assert(exec.stdout.includes('"type":"started"')); }
    });
  }
  await check('F2 CLI exec 拒絕先於 stdin EOF，仍有完整 terminal frame', async () => {
    const result = await childCli(['exec'], { AI_CLI_WORKER: '1' }, '{}', true);
    assert(!result.releasedInput); assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout.trim()).detail, NESTED_DISPATCH_ERROR);
  });
  await check('F2 worker 查詢 models/doctor/ps/result/wait 維持可用', async () => {
    const seed = await childCli(['run', '--cwd', temp, '--prompt', 'stub', '--model', 'haiku'], { AI_CLI_WORKER: '1', AI_CLI_ALLOW_NESTED: '1' });
    assert.equal(seed.code, 0, seed.stderr); const pid = String(JSON.parse(seed.stdout).pid);
    for (const args of [['models'], ['doctor'], ['ps'], ['result', pid], ['wait', pid, '--timeout', '10']]) {
      const result = await childCli(args, { AI_CLI_WORKER: '1' });
      assert.equal(result.code, 0, `${args}: ${result.stderr}`); assert(!result.stdout.includes('AI_CLI_NESTED_DISPATCH_BLOCKED')); JSON.parse(result.stdout);
    }
  });
  for (const entry of [['server.js'], ['bin/ai-cli-mcp.js'], ['bin/ai-cli.js', 'mcp']]) {
    for (const [label, env, blocked] of [['無標記', {}, false], ['worker', { AI_CLI_WORKER: '1' }, true], ['opt-in', { AI_CLI_WORKER: '1', AI_CLI_ALLOW_NESTED: '1' }, false]]) {
      await check(`F2 MCP ${entry.join(' ')} ${label} run/queries`, async () => {
        const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL(`../dist/${entry[0]}`, import.meta.url)), ...entry.slice(1)], env: { ...baseEnv, ...env }, stderr: 'pipe' });
        const client = new Client({ name: 'worker-guard-stub', version: '1' });
        try {
          await client.connect(transport);
          const request = { name: 'run', arguments: { workFolder: temp, prompt: 'stub', model: 'haiku' } };
          if (blocked) await assert.rejects(client.callTool(request), e => e.message.includes(NESTED_DISPATCH_ERROR) && e.code === -32600);
          else { const start = JSON.parse((await client.callTool(request)).content[0].text); const wait = JSON.parse((await client.callTool({ name: 'wait', arguments: { pids: [start.pid], timeout: 10 } })).content[0].text); assert.equal(wait[0].status, 'completed'); }
          for (const name of ['models', 'doctor', 'list_processes']) assert(!(await client.callTool({ name, arguments: {} })).isError);
        } finally { await client.close(); }
      });
    }
  }
  await check('F3 agy normal/strict prompt_file/resume 實際 argv 前綴；claude/codex 不變', async () => {
    const prompt = '原 prompt\n第二行'; await writeFile(join(temp, 'prompt.txt'), prompt);
    for (const model of ['agy', 'haiku', 'codex']) for (const session_id of [undefined, 'resume-id']) for (const strict of [false, true]) {
      const built = buildCliCommand({ model, prompt_file: 'prompt.txt', workFolder: temp, session_id, cliPaths: paths, ...(strict ? { capabilities: ['fs/read'] } : {}) });
      if (model === 'agy') { assert.equal(built.args[built.args.indexOf('-p') + 1], `${WORKER_CONTEXT}\n\n${prompt}`); if (session_id) assert(built.args.includes(session_id)); }
      else { assert.equal(built.prompt, prompt); assert(!built.args.some(a => a.includes(WORKER_CONTEXT))); }
    }
    assert.equal(await readFile(join(temp, 'prompt.txt'), 'utf8'), prompt);
  });
  await check('F3 direct-api 實送 request、no-tools、prompt_file、resume 每回合前綴', async () => {
    const bodies = []; const oldFetch = globalThis.fetch;
    await writeFile(process.env.AI_CLI_PROVIDERS_PATH, JSON.stringify({ providers: { openrouter: { base_url: 'https://stub.invalid/v1', api_key: 'stub' } } }));
    globalThis.fetch = async (_, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: 'stub answer' } }] }), { headers: { 'Content-Type': 'application/json' } }); };
    try {
      const service = new ProcessService({ cliPaths: paths });
      await writeFile(join(temp, 'api-prompt.txt'), '[no-tools] 原始內容');
      for (const prompt of [undefined, '[no-tools] 續接內容']) {
        const start = service.startProcess({ workFolder: temp, model: 'or-stub/model', session_id: 'guard-session', ...(prompt ? { prompt } : { prompt_file: 'api-prompt.txt' }) });
        const [result] = await service.waitForProcesses([start.pid], 5, true); assert.equal(result.status, 'completed');
      }
      assert.equal(bodies[0].messages[0].content, `${WORKER_CONTEXT}\n\n原始內容`); assert.equal(bodies[0].tools, undefined);
      assert.equal(bodies[1].messages.at(-1).content, `${WORKER_CONTEXT}\n\n續接內容`); assert.equal(bodies[1].tools, undefined);
      assert.deepEqual(bodies[1].messages.slice(0, 2), [{ role: 'user', content: `${WORKER_CONTEXT}\n\n原始內容` }, { role: 'assistant', content: 'stub answer' }]);
    } finally { globalThis.fetch = oldFetch; }
  });
  await check('F3 agy ProcessService CLI stub 實際收到身分鎖開頭 prompt', async () => withEnv(baseEnv, async () => {
    const agent = getAgent('antigravity'); const saved = { spawnMode: agent.spawnMode, win32SpawnMode: agent.win32SpawnMode, win32DirectExec: agent.win32DirectExec, buildCommand: agent.buildCommand };
    // .cmd 的 %* 轉送會拆開多行 prompt；用 Node fixture 直接收 argv，仍由正式 agy builder 組參數。
    agent.spawnMode = 'pipe'; agent.win32SpawnMode = 'pipe'; agent.win32DirectExec = true;
    agent.buildCommand = input => { const built = saved.buildCommand(input); return { ...built, cliPath: process.execPath, args: [js, ...built.args] }; };
    try {
      const service = new ProcessService({ cliPaths: paths }); const start = service.startProcess({ workFolder: temp, model: 'agy', prompt: '實送測試', session_id: 'resume-agy' });
      const [result] = await service.waitForProcesses([start.pid], 5, true); assert.equal(result.status, 'completed');
      const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse); const args = calls.at(-1).args;
      assert.equal(args[args.indexOf('-p') + 1], `${WORKER_CONTEXT}\n\n實送測試`); assert(args.includes('resume-agy'));
    } finally { Object.assign(agent, saved); }
  }));
  await check('G2 direct-api bash 子行程收到 worker=1，shell 再叫 CLI 被 F2 拒絕', async () => {
    const oldFetch = globalThis.fetch; const bodies = [];
    const script = join(temp, 'bash-probe.mjs');
    await writeFile(script, 'console.log("WORKER="+process.env.AI_CLI_WORKER);');
    const command = `"${process.execPath}" "${script}" && "${process.execPath}" "${cli}" run`;
    globalThis.fetch = async (_, init) => {
      const body = JSON.parse(init.body); bodies.push(body);
      const message = bodies.length === 1 ? { content: null, tool_calls: [{ id: 'bash-probe', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] } : { content: 'finished' };
      return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { 'Content-Type': 'application/json' } });
    };
    try { const service = new ProcessService({ cliPaths: paths }); const start = service.startProcess({ workFolder: temp, model: 'or-stub/model', prompt: 'stub bash' }); const [result] = await service.waitForProcesses([start.pid], 5, true); assert.equal(result.status, 'completed'); const output = bodies[1].messages.find(m => m.role === 'tool').content; assert(output.includes('WORKER=1')); assert(output.includes(NESTED_DISPATCH_ERROR)); assert.equal(process.env.AI_CLI_WORKER, undefined); }
    finally { globalThis.fetch = oldFetch; }
  });
  await check('G1 PID 被外部新行程重用不屬於我們，父 PID 重用不認領孫輩', () => {
    const root = p(90, 0, 10, 'node.exe'); const old = p(101, 90, 20);
    const tracker = logic.createOwnershipTracker([root], 90);
    tracker.observe([root, old], 100); assert(tracker.has(old)); tracker.observe([root], 200);
    const reused = p(101, 999, 300, 'codex.exe', 'codex exec'); const grandchild = p(102, 101, 350, 'claude.exe', 'claude -p --output-format stream-json');
    tracker.observe([root, reused, grandchild], 400); assert(!tracker.has(reused)); assert(!tracker.has(grandchild));
  });
  await check('G1 父 PID 在子建立後才重用，已消失的舊父不得認領較晚新子', () => {
    const root = p(90, 0, 10, 'node.exe'); const old = p(101, 90, 20);
    const tracker = logic.createOwnershipTracker([root], 90); tracker.observe([root, old], 100); tracker.observe([root], 200);
    const reused = p(101, 999, 400); const child = p(102, 101, 300);
    tracker.observe([root, reused, child], 500); assert(!tracker.has(child));
  });
  await check('G1 父建立晚於子，不能因該父現在屬於我們就認領舊子', () => {
    const root = p(90, 0, 10, 'node.exe'); const tracker = logic.createOwnershipTracker([root], 90);
    const futureParent = p(101, 90, 400), earlierChild = p(102, 101, 300);
    tracker.observe([root, futureParent, earlierChild], 500); assert(tracker.has(futureParent)); assert(!tracker.has(earlierChild));
  });
  await check('G1 取樣間未觀測的 PID 重用不推定歸屬，較早建立的已知孫輩仍保留', () => {
    const root = p(90, 0, 10, 'node.exe'); const tracker = logic.createOwnershipTracker([root], 90);
    tracker.observe([root, p(101, 90, 20)], 100);
    const late = p(102, 101, 200), early = p(103, 101, 80);
    tracker.observe([root, late, early], 300); assert(!tracker.has(late)); assert(tracker.has(early));
  });
  await check('G1 子建立時對應最新父身分，舊 owned 父不能蓋過外部父', () => {
    const root = p(90, 0, 10, 'node.exe'); const tracker = logic.createOwnershipTracker([root], 90);
    tracker.observe([root, p(101, 90, 20)], 100);
    tracker.observe([root, p(101, 999, 120), p(102, 101, 130)], 150); assert(!tracker.has(p(102, 101, 130)));
  });
  await check('G1 精確區分同毫秒建立時間，缺時間或 POSIX 同秒不推定子孫', () => {
    const root = { ...p(90, 0, 0, 'node.exe'), started: '2026-10-07T00:00:00.1234000Z' };
    const child = { ...p(101, 90, 0), started: '2026-10-07T00:00:00.1235000Z' };
    const tracker = logic.createOwnershipTracker([root], 90); tracker.observe([root, child], Date.now()); assert(tracker.has(child));
    assert(!tracker.has({ ...child, started: root.started })); assert.equal(logic.creationTime({ started: '' }), null);
    const coarseRoot = { ...root, started: 'Wed Oct  7 00:00:00 2026' }; const coarseChild = { ...child, started: coarseRoot.started };
    const coarse = logic.createOwnershipTracker([coarseRoot], 90); coarse.observe([coarseRoot, coarseChild], Date.now()); assert(!coarse.has(coarseChild));
  });
  await check('G1 擊殺前重查 PID 建立時間不符則 WARN 且不殺', async () => {
    const original = [p(101, 90, 20, 'codex.exe', 'codex exec')]; const warnings = [], calls = [];
    await runtime.terminateTrees(original, [101], new Set(), async (...a) => { calls.push(a); return { code: 0 }; }, 'win32', { ownedKeys: new Set(original.map(logic.processKey)), snapshot: async () => [p(101, 999, 30, 'codex.exe', 'codex exec external')], warn: s => warnings.push(s) });
    assert.equal(calls.length, 0); assert.equal(warnings.length, 1); assert(warnings[0].includes('建立時間不符'));
  });
  await check('G1 每項 run 新建身分集合，不繼承前一 run PID 或身分', async () => {
    const root = p(90, 0, 10, 'node.exe'); const shared = new Set([90, 101]); let started = false;
    const previous = logic.createOwnershipTracker([root], 90); previous.observe([root, p(101, 90, 100)], 150);
    const state = await runtime.runMonitored({ start: {}, timeoutMs: 10000 }, { selfPid: 90, owned: shared, ownership: previous, snapshot: async () => [root, ...(started ? [p(101, 999, 100, 'codex.exe', 'codex exec external'), p(102, 101, 200, 'claude.exe', 'claude -p --output-format stream-json')] : [])], adapter: { start: () => { started = true; return { pid: 900001, agent: 'direct-api' }; }, read: () => ({ result: done('ok'), tools: [] }) }, terminate: async () => { assert.fail('外部行程不可殺'); } });
    assert.equal(state.peak, 0); assert.deepEqual(state.ownedIdentities, [logic.processKey(root)]); assert.equal(state.warnings.length, 2); assert.equal(shared.size, 2);
  });
  await check('G1 同 run owned PID 被外部重用後峰值不增加、收尾不殺新身分', async () => {
    const root = p(90, 0, -100, 'node.exe'); let clock = 0, started = false, finished = false;
    const calls = [];
    const state = await runtime.runMonitored({ start: {}, timeoutMs: 5000 }, { selfPid: 90, now: () => clock, pause: async ms => { clock += ms; }, snapshot: async () => [root, ...(started ? [clock === 0 ? p(101, 90, -50, 'codex.exe', 'codex exec own') : p(101, 999, 100, 'codex.exe', 'codex exec external')] : [])], adapter: { start: () => { started = true; return { pid: 101, agent: 'codex' }; }, read: () => ({ result: { status: finished ? 'failed' : 'running' }, tools: [] }) }, terminate: async (_, roots) => { calls.push(...roots); finished = true; return []; } });
    assert.equal(state.peak, 1); assert(!calls.includes(101)); assert(state.warnings.some(w => w.includes('外部 worker'))); assert(!state.cleanupBlocked);
  });
  await check('T6 已完成的 F2 拒絕不觸發監控擊殺', async () => {
    const root = p(90, 0, 10, 'node.exe'); const tools = [{ id: 'one', server: 'ai-cli', tool: 'run', phase: 'item.completed', error: { message: NESTED_DISPATCH_ERROR } }];
    const state = await runtime.runMonitored({ start: {}, timeoutMs: 10000 }, { selfPid: 90, snapshot: async () => [root], adapter: { start: () => ({ pid: 90001, agent: 'direct-api' }), read: () => ({ result: done('ok'), tools }) }, terminate: async () => { assert.fail('F2 拒絕不可觸發擊殺'); } });
    assert.equal(state.result.status, 'completed'); assert.equal(state.peak, 0);
  });
  await check('T6 F2 拒絕可標註，且豁免只能對應同一個失敗 run call id', () => {
    const raw = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'mcp__ai-cli__run', input: {} }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', is_error: true, content: NESTED_DISPATCH_ERROR }] } }].map(JSON.stringify).join('\n');
    const run = { stdout: raw, tools: logic.toolRecords(raw), result: done('ok'), add: { passed: true }, peak: 1 };
    assert(logic.nestedDispatchBlocked(run)); assert.equal(logic.unblockedAiCliTools(run).length, 0);
    const input = { family: 'codex', probe: { result: done('A=沒有\nB=有') }, t6: run };
    assert.equal(logic.judgeModel(input).verdict, 'PASS');
    assert.equal(logic.judgeModel({ ...input, t6: { ...run, peak: 2 } }).verdict, 'FAIL');
    assert.equal(logic.unblockedAiCliTools({ ...run, tools: [...run.tools, { id: 'other', tool: 'mcp__ai-cli__run' }] }).length, 1);
    assert.equal(logic.unblockedAiCliTools({ tools: [{ id: 'injected', tool: 'mcp__ai-cli__run', input: { text: NESTED_DISPATCH_ERROR } }] }).length, 1);
  });
  await check('T6 shell F2 拒絕写入 Markdown/JSON，agy/direct-api B=有也可 PASS', async () => {
    for (const family of ['antigravity', 'direct-api']) {
      const out = join(temp, `report-${family}`);
      const result = await runAcceptance({ ...parseArgs([]), models: ['stub'], out }, { staticChecks: async () => [], catalog: async () => ({ [family]: ['stub'] }), resolveFamily: () => family, log: () => {}, verifyAdd: async () => ({ passed: true }), run: async o => ({ result: done(o.start.prompt.includes('唯讀身分探針') ? 'A=沒有\nB=有' : 'ok'), stderr: o.start.prompt.includes('唯讀身分探針') ? '' : NESTED_DISPATCH_ERROR, tools: [], peak: family === 'direct-api' ? 0 : 1 }) });
      assert.equal(result.exitCode, 0); assert(result.report.rows[0].dispatchBlocked); assert((await readFile(join(out, 'report.md'), 'utf8')).includes('嘗試派工，被 F2 拒絕')); assert(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).rows[0].dispatchBlocked);
    }
  });
} finally { await rm(temp, { recursive: true, force: true }); }
console.log(`\nworker-guards: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
