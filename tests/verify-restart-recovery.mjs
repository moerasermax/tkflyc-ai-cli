import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, selectJobs, runRecovery, stopOwned, liveDeps } from '../tools/acceptance/restart-recovery.mjs';
const temp = await mkdtemp(join(tmpdir(), 'ai-cli-restart-test-'));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const familyFor = m => m.startsWith('grok-') ? 'grok' : m.startsWith('gpt-') ? 'codex' : m === 'agy' ? 'antigravity' : 'claude';
const artifacts = [];
function stub(mode) {
  let time = 0, servers = 0, cleaned = 0; const jobs = [], calls = [];
  return { calls, get cleaned() { return cleaned; }, familyFor, now: () => time, sleep: async ms => { time += ms; }, capture: async () => {},
    metas: async () => [...jobs.map(j => ({ pid: j.pid, jobId: j.jobId })), ...(mode === 'redispatch' ? [{ jobId: 'extra' }] : [])],
    cleanup: async () => { cleaned++; return []; },
    server: async () => { const generation = ++servers; return { init: async () => {}, stop: async () => {}, call: async (name, args) => {
      calls.push({ name, args, generation });
      if (name === 'run') { const j = { ...args, family: familyFor(args.model), pid: 100 + jobs.length, jobId: 'uuid-' + jobs.length }; jobs.push(j); return j; }
      if (name === 'list_processes') return jobs.map(j => ({ pid: j.pid, jobId: j.jobId, recovered: mode !== 'unrecovered', status: mode === 'early' ? 'completed' : 'running' }));
      const j = jobs.find(j => j.pid === args.pid);
      if (mode === 'timeout') return { status: 'running' };
      return { pid: j.pid, jobId: j.jobId, recovered: true, status: 'completed', session_id: 'session', agentOutput: { message: 'DONE-' + j.family, ...(mode === 'no-usage' ? {} : { usage: { output_tokens: 1 } }) } };
    } }; } };
}
try {
  await test('restart arguments select families/models and medium for every family', () => {
    const selected = selectJobs(parseArgs(['--family', 'codex,grok', '--models', 'haiku,gpt-6.1-sol,grok-4.7']), familyFor);
    assert.deepEqual(selected.map(j => j.family), ['codex', 'grok']); assert(selected.every(j => j.reasoning_effort === 'medium'));
    assert.throws(() => parseArgs(['--family', 'agy'])); assert.throws(() => selectJobs({ models: ['agy'] }, familyFor)); assert.throws(() => parseArgs(['--timeout', 'bogus']));
  });
  for (const mode of ['success', 'unrecovered', 'early', 'redispatch', 'timeout', 'no-usage']) await test('restart stub verdict/report/cleanup: ' + mode, async () => {
    const deps = stub(mode), options = { timeoutMs: 2000, restartMs: 8000, out: join(temp, mode) };
    const result = await runRecovery(options, deps); artifacts.push(result.report.stateDir, result.report.workFolder);
    assert.equal(result.exitCode, mode === 'success' ? 0 : 1); assert.equal(deps.cleaned, 1);
    assert(deps.calls.filter(c => c.name === 'run').every(c => c.args.reasoning_effort === 'medium'));
    assert.equal(deps.calls.filter(c => c.name === 'run').length, 3);
    assert.notEqual(result.report.stateDir, process.env.AI_CLI_STATE_DIR);
    const report = JSON.parse(await readFile(join(options.out, 'report.json')));
    assert.equal(report.status, result.report.status); assert((await readFile(join(options.out, 'report.md'), 'utf8')).includes('Restart recovery'));
  });
  await test('restart cleanup checks each identity, including non-node and reused node', async () => {
    const owned = { pid: 1, ppid: 0, name: 'node.exe', command: 'node own-server', created: '2026-01-01T00:00:00Z' };
    // 使用 runtime 實際 processSnapshot 欄位名稱。
    owned.creationDate = owned.created; owned.started = owned.created;
    const killed = [];
    await stopOwned(owned, { snapshot: async () => [owned], kill: async pid => killed.push(pid) }); assert.deepEqual(killed, [1]);
    await assert.rejects(stopOwned(owned, { snapshot: async () => [{ ...owned, command: 'node other' }], kill: async () => assert.fail('must not kill') }), /Refusing/);
    await assert.rejects(stopOwned({ ...owned, name: 'grok.exe' }, { snapshot: async () => [{ ...owned, name: 'grok.exe', started: '2026-01-02T00:00:00Z' }], kill: async () => assert.fail('must not kill') }), /Refusing/);
  });
  await test('restart live MCP transport uses only three stub vendors and recovers without rerun', async () => {
    const worker = join(temp, 'vendor.mjs'), preload = join(temp, 'preload.mjs');
    await writeFile(worker, `const family=process.argv[2]; await new Promise(r=>setTimeout(r,14000));
const message='DONE-'+family;
if(family==='codex'){console.log(JSON.stringify({type:'thread.started',thread_id:'stub-session'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:message}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:2}}));}
else {console.log(JSON.stringify({type:'system',session_id:'stub-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:message,session_id:'stub-session',stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:2},is_error:false}));}
`);
    const registry = pathToFileURL(join(process.cwd(), 'dist/agents/registry.js')).href;
    await writeFile(preload, `import{getAgent}from ${JSON.stringify(registry)}; for(const family of ['claude','codex','grok']) getAgent(family).buildCommand=i=>({cliPath:process.execPath,args:[${JSON.stringify(worker)},family],agent:family,cwd:i.cwd,prompt:i.prompt,resolvedModel:i.resolvedModel});`);
    const before = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = `--import ${JSON.stringify(pathToFileURL(preload).href)}`;
    try {
      const result = await runRecovery({ timeoutMs: 30000, restartMs: 500, out: join(temp, 'transport') }, await liveDeps());
      artifacts.push(result.report.stateDir, result.report.workFolder);
      assert.equal(result.exitCode, 0, JSON.stringify(result.report)); assert.equal(result.report.storeCount, 3);
      assert(result.report.jobs.every(j => j.result.recovered && j.result.agentOutput.usage));
    } finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
  });
} finally {
  for (const path of artifacts.filter(Boolean)) await rm(path, { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
}
console.log(`restart-recovery: ${passed} passed`);
