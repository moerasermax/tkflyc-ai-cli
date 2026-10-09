/** Stub-only：MCP 真重啟、身分隔離、整棵樹 kill、假時鐘 GC、50×1 MiB heap/IO。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JobStore, atomicJson, collectStoreFiles, jobResult, MAX_FINISHED_BYTES, RETENTION_MS } from '../dist/core/job-store.js';
import { lookupIdentities } from '../dist/core/live-jobs.js';
import { resolvePrincipal } from '../dist/core/principal.js';
import { FileProcessService } from '../dist/core/file-process-service.js';
import { ProcessService } from '../dist/core/process-service.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-durable-'));
const section = process.argv[2];
let passed = 0, failed = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`); }
}
async function until(fn, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(50); }
  throw Error('Test deadline exceeded');
}
const metaFor = (state, pid) => readdirSync(join(state, 'jobs')).map(id => join(state, 'jobs', id)).find(dir => existsSync(join(dir, 'meta.json')) && JSON.parse(readFileSync(join(dir, 'meta.json'))).pid === pid);
const preload = join(TEMP, 'preload.mjs');
// 寫入計數包括後來刪掉的 launch/stdin 暫存檔；stdout/stderr 是 OS fd 直寫，另以 log size 計量。
writeFileSync(preload, `import {createRequire,syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const fs=createRequire(import.meta.url)('node:fs'), original=fs.writeFileSync;
let writes=0,bytes=0; const state=process.env.AI_CLI_STATE_DIR;
fs.writeFileSync=function(path,data,...rest){
if(String(path).startsWith(join(state,'jobs')+'/' ) || String(path).startsWith(join(state,'jobs')+'\\\\')) {writes++;bytes+=Buffer.byteLength(data);}return original.call(this,path,data,...rest);};
syncBuiltinESMExports();
if(process.argv[1]?.endsWith('job-runner.js')) process.on('exit',()=>original(join(state,'io-'+process.pid+'.json'),JSON.stringify({writes,bytes})));
if(process.argv[1]?.endsWith('ai-cli-mcp.js') || process.argv[1]?.endsWith('ai-cli.js')) {
const {getAgent}=await import(${JSON.stringify(pathToFileURL(join(ROOT, 'dist/agents/registry.js')).href)});
for(const id of ['claude','codex'])getAgent(id).buildCommand=input=>({cliPath:process.execPath,args:[${JSON.stringify(join(ROOT, 'tools/stubs/durable-agent.mjs'))},id],cwd:input.cwd,agent:id,prompt:input.prompt,stdinPrompt:input.prompt,resolvedModel:'stub'});
const request=join(state,'heap-request.json');
setInterval(()=>{if(!fs.existsSync(request))return;fs.rmSync(request);global.gc?.();original(join(state,'heap.json'),JSON.stringify({...process.memoryUsage(),writes,bytes}));},25).unref();
}
`);
const envFor = state => ({ ...process.env, AI_CLI_STATE_DIR: state, AI_CLI_BREAKER_DISABLED: 'true', NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(preload).href)}` });
const proxy = join(TEMP, 'proxy.mjs');
writeFileSync(proxy, `import{spawn}from'node:child_process';const c=spawn(process.execPath,process.argv.slice(2),{stdio:'inherit',windowsHide:true});c.on('close',code=>process.exitCode=code);`);
const clients = new Set(), realStates = new Set();
function client(state, differentParent = false) {
  realStates.add(state);
  mkdirSync(state, { recursive: true });
  const args = ['--expose-gc', join(ROOT, 'dist/bin/ai-cli-mcp.js')];
  const child = spawn(process.execPath, differentParent ? [proxy, ...args] : args, { env: envFor(state), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  let buffer = '', errors = '', sequence = 0; const pending = new Map();
  child.stderr.on('data', b => errors += b);
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', b => {
    buffer += b; let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch {}
    }
  });
  async function send(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout ${method}: ${errors}`)); }, 40000);
      pending.set(id, m => { clearTimeout(timeout); pending.delete(id); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const call = async (name, args = {}) => {
    const r = await send('tools/call', { name, arguments: args });
    if (r.isError) throw Error(JSON.stringify(r));
    return JSON.parse(r.content.find(c => c.type === 'text').text);
  };
  const init = () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'durable-stub', version: '1' } });
  const stop = async () => { child.stdin.end(); if (!differentParent) child.kill('SIGKILL'); await closed; clients.delete(api); };
  const api = { child, call, init, stop }; clients.add(api); return api;
}
async function dispatch(c, state, spec, model = 'gpt-5.5') {
  const existing = new Set(existsSync(join(state, 'jobs')) ? readdirSync(join(state, 'jobs')) : []);
  const start = await c.call('run', { model, prompt: JSON.stringify(spec), workFolder: ROOT, session_id: 'original-session' });
  const dir = await until(() => readdirSync(join(state, 'jobs')).filter(id => !existing.has(id)).map(id => join(state, 'jobs', id)).find(dir => existsSync(join(dir, 'meta.json')) && JSON.parse(readFileSync(join(dir, 'meta.json'))).pid === start.pid));
  return { pid: start.pid, dir, meta: JSON.parse(readFileSync(join(dir, 'meta.json'))) };
}
async function heap(state) {
  rmSync(join(state, 'heap.json'), { force: true }); writeFileSync(join(state, 'heap-request.json'), '{}');
  return until(() => existsSync(join(state, 'heap.json')) && JSON.parse(readFileSync(join(state, 'heap.json'))));
}

try {
if (!section || section === 'restart') {
  const state = join(TEMP, 'restart'); let c = client(state); await c.init();
  await check('MCP restart recovers running job without redispatch', async () => {
    const job = await dispatch(c, state, { delay: 8000, filler: '中文字'.repeat(5000) }); const meta = readFileSync(join(job.dir, 'meta.json'), 'utf8');
    assert.equal(job.meta.sessionId, 'original-session');
    assert.ok(!meta.includes('中文字'.repeat(200)), 'metadata must not contain the full prompt');
    await c.stop(); c = client(state); await c.init();
    const row = (await c.call('list_processes')).find(j => j.pid === job.pid);
    assert.equal(row.recovered, true); assert.equal(row.status, 'running');
    const [result] = await c.call('wait', { pids: [job.pid], timeout: 20, verbose: true });
    assert.equal(result.status, 'completed'); assert.equal(result.recovered, true); assert.equal(result.agentOutput.message, '完整輸出：PONG');
    assert.equal(existsSync(join(job.dir, 'stdin.tmp')), false);
    assert.equal(readFileSync(join(job.dir, 'meta.json'), 'utf8'), meta); assert.equal(readdirSync(join(state, 'jobs')).length, 1);
  });
  await check('MCP recovers job completed while server was absent', async () => {
    const job = await dispatch(c, state, { delay: 2500 }, 'claude'); await c.stop();
    await until(() => existsSync(join(job.dir, 'exit.json'))); c = client(state); await c.init();
    const result = await c.call('get_result', { pid: job.pid });
    assert.equal(result.status, 'completed'); assert.equal(result.recovered, true); assert.equal(result.agentOutput.message, '完整輸出：PONG');
  });
  await check('MCP runner and worker dead without exit becomes lost with output', async () => {
    const job = await dispatch(c, state, { delay: 60000 }); await c.stop();
    const ids = await lookupIdentities([job.pid, job.meta.worker.pid]);
    assert.equal(ids.get(job.pid)?.started, job.meta.runner.started);
    assert.equal(ids.get(job.meta.worker.pid)?.started, job.meta.worker.started);
    if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/pid', String(job.pid), '/t', '/f'], { windowsHide: true });
    else { process.kill(job.pid, 'SIGKILL'); process.kill(-job.meta.worker.pid, 'SIGKILL'); }
    await until(async () => (await lookupIdentities([job.pid, job.meta.worker.pid])).size === 0);
    assert.equal(existsSync(join(job.dir, 'exit.json')), false); c = client(state); await c.init();
    const result = await c.call('get_result', { pid: job.pid, verbose: true });
    assert.equal(result.status, 'lost'); assert.equal(result.recovered, true);
    assert.match(readFileSync(join(job.dir, 'stdout.log'), 'utf8'), /thread.started/);
  });
  await check('different principal does not recover another principal jobs', async () => {
    const other = client(state, true); await other.init();
    try { assert.deepEqual(await other.call('list_processes'), []); }
    finally { await other.stop(); }
  });
  await check('CLI run ps result wait jobs share store and persist immutable metadata', async () => {
    const cli = async args => {
      const p = spawn(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), ...args], { env: envFor(state), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = ''; p.stdout.on('data', b => out += b); p.stderr.on('data', b => err += b);
      assert.equal((await once(p, 'close'))[0], 0, err); return JSON.parse(out);
    };
    const { pid } = await cli(['run', '--cwd', ROOT, '--model', 'claude', '--prompt', JSON.stringify({ delay: 0 })]);
    const dir = metaFor(state, pid), before = readFileSync(join(dir, 'meta.json'), 'utf8');
    assert.ok((await cli(['ps'])).some(j => j.pid === pid));
    assert.equal((await cli(['wait', String(pid), '--timeout', '15']))[0].status, 'completed');
    assert.equal((await cli(['result', String(pid)])).agentOutput.message, '完整輸出：PONG');
    assert.equal((await cli(['jobs', '--json'])).find(j => j.pid === pid).source, 'cli');
    assert.equal(readFileSync(join(dir, 'meta.json'), 'utf8'), before);
    assert.equal(existsSync(join(state, 'live-jobs')), false);
  });
  await c.stop();
}
if (!section || section === 'kill') {
  const state = join(TEMP, 'kill'); const c = client(state); await c.init();
  await check('kill terminates runner worker and SIGTERM ignoring grandchild', async () => {
    const childFile = join(TEMP, 'grandchild.pid'); const job = await dispatch(c, state, { mode: 'tree', childFile });
    const grandchild = Number(await until(() => existsSync(childFile) && readFileSync(childFile, 'utf8')));
    const response = await c.call('kill_process', { pid: job.pid }); assert.equal(response.status, 'terminated');
    const exit = JSON.parse(readFileSync(join(job.dir, 'exit.json'))); assert.equal(exit.killed, true); assert.equal(exit.timedOut, false);
    await until(async () => (await lookupIdentities([job.pid, job.meta.worker.pid, grandchild])).size === 0);
  });
  await check('cleanup immediately removes finished disk jobs and keeps running jobs', async () => {
    const running = await dispatch(c, state, { delay: 10000 });
    const finished = await dispatch(c, state, { delay: 0 }); await c.call('wait', { pids: [finished.pid], timeout: 15 });
    const cleaned = await c.call('cleanup_processes'); assert.ok(cleaned.removedPids.includes(finished.pid));
    assert.equal(existsSync(finished.dir), false); assert.equal(existsSync(running.dir), true);
    await c.call('kill_process', { pid: running.pid });
  });
  await check('runner timeout records timeout and terminates worker', async () => {
    const store = new JobStore(join(TEMP, 'timeout')); await store.ready; await store.identify();
    const job = store.start({ cliPath: process.execPath, args: [join(ROOT, 'tools/stubs/durable-agent.mjs'), 'codex'], cwd: ROOT, agent: 'codex', resolvedModel: 'stub', prompt: 'timeout stub', stdinPrompt: JSON.stringify({ delay: 60000 }) }, undefined, 100);
    try {
      const [result] = await store.wait([job.pid], 15); assert.equal(result.status, 'failed');
      const exit = JSON.parse(readFileSync(join(job.directory, 'exit.json'))); assert.equal(exit.timedOut, true); assert.equal(exit.killed, false);
      await until(async () => (await lookupIdentities([job.pid, job.meta.worker.pid])).size === 0);
    } finally { if (job.status === 'running') await store.kill(job.pid); store.dispose(); }
  });
  await check('runner spawn failure persists failed exit and removes stdin prompt', async () => {
    const store = new JobStore(join(TEMP, 'spawn-failure')); await store.ready;
    const job = store.start({ cliPath: process.execPath, args: [], cwd: join(TEMP, 'missing-cwd'), agent: 'codex', resolvedModel: 'stub', prompt: 'failure stub', stdinPrompt: 'unused' });
    const [result] = await store.wait([job.pid], 15); assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 1);
    assert.equal(existsSync(join(job.directory, 'stdin.tmp')), false); assert.match(readFileSync(join(job.directory, 'stderr.log'), 'utf8'), /Process error/); store.dispose();
  });
  await check('claude error output overrides zero exit code', async () => {
    const job = await dispatch(c, state, { delay: 0, error: true }, 'claude');
    assert.equal((await c.call('wait', { pids: [job.pid], timeout: 15 }))[0].status, 'failed');
  });
  await c.stop();
}
if (!section || section === 'gc') {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const live = (await lookupIdentities([process.pid])).get(process.pid);
  function fixture(state, end, size = 0, running = false, pid = 123456789) {
    const id = randomUUID(), dir = join(state, 'jobs', id); mkdirSync(dir, { recursive: true });
    atomicJson(join(dir, 'meta.json'), { version: 1, jobId: id, pid, agent: 'codex', resolvedModel: 'stub', task: 'summary', workFolder: ROOT, source: 'cli', recoverable: true,
      principal: live, server: live, runner: running ? live : { pid, started: 'gone', name: 'stub' }, worker: null, startTime: new Date(end - 1000).toISOString() });
    const fd = openSync(join(dir, 'stdout.log'), 'w'); ftruncateSync(fd, size); closeSync(fd); writeFileSync(join(dir, 'stderr.log'), '');
    if (!running) atomicJson(join(dir, 'exit.json'), { exitCode: 0, signal: null, endTime: new Date(end).toISOString(), killed: false, timedOut: false });
    return { id, dir };
  }
  const lookup = async () => new Map([[process.pid, live]]);
  await check('GC fake clock thirty minute boundary preserves running job', async () => {
    const state = join(TEMP, 'gc-age'), terminal = fixture(state, now), active = fixture(state, now - RETENTION_MS * 2, 0, true, process.pid);
    assert.deepEqual(await collectStoreFiles(state, now + 1800000 - 1, lookup), []);
    assert.deepEqual(await collectStoreFiles(state, now + 1800000, lookup), [terminal.id]); assert.equal(existsSync(active.dir), true);
  });
  await check('GC 100 finished jobs deletes oldest first', async () => {
    const state = join(TEMP, 'gc-count'); const jobs = Array.from({ length: 101 }, (_, i) => fixture(state, now + i));
    assert.deepEqual(await collectStoreFiles(state, now + 101, lookup), [jobs[0].id]); assert.equal(readdirSync(join(state, 'jobs')).length, 100);
  });
  await check('GC 500 MiB finished capacity deletes oldest first', async () => {
    assert.equal(MAX_FINISHED_BYTES, 500 * 1024 * 1024);
    const state = join(TEMP, 'gc-bytes'); const oldest = fixture(state, now, 250 * 1024 * 1024), newest = fixture(state, now + 1, 250 * 1024 * 1024);
    assert.deepEqual(await collectStoreFiles(state, now + 2, lookup), [oldest.id]); assert.equal(existsSync(newest.dir), true);
  });
  await check('silent lost output retains thirty minutes from first confirmed loss', async () => {
    const state = join(TEMP, 'gc-lost'); const job = fixture(state, now - 7200000);
    rmSync(join(job.dir, 'exit.json')); writeFileSync(join(job.dir, 'stdout.log'), 'preserve output');
    assert.deepEqual(await collectStoreFiles(state, now, lookup), []);
    assert.deepEqual(await collectStoreFiles(state, now + 1800000 - 1, lookup), []);
    assert.deepEqual(await collectStoreFiles(state, now + 1800000, lookup), [job.id]);
  });
  await check('PID reuse refuses kill and marks dead identities lost', async () => {
    const state = join(TEMP, 'gc-identity'); fixture(state, Date.now(), 0, true, process.pid);
    const dir = join(state, 'jobs', readdirSync(join(state, 'jobs'))[0]); const meta = JSON.parse(readFileSync(join(dir, 'meta.json')));
    meta.runner.started = 'reused'; atomicJson(join(dir, 'meta.json'), meta);
    const store = new JobStore(state, 'cli', true, async () => new Map([[process.pid, live]])); await store.ready;
    assert.equal(store.get(process.pid).status, 'lost'); assert.equal((await store.kill(process.pid)).status, 'lost'); assert.equal(existsSync(join(dir, 'kill.json')), false); store.dispose();
  });
  await check('PID collision retains UUID jobs and resolves all PID operations to newest', async () => {
    const state = join(TEMP, 'gc-collision'), pid = 123456789;
    const old = fixture(state, Date.now() - 5000, 0, false, pid), latest = fixture(state, Date.now(), 0, false, pid);
    const newerExit = JSON.parse(readFileSync(join(latest.dir, 'exit.json'))); newerExit.exitCode = 1; atomicJson(join(latest.dir, 'exit.json'), newerExit);
    const store = new JobStore(state, 'cli', true); await store.ready;
    assert.equal(store.jobs.size, 2, 'PID collision must retain both UUID jobs');
    assert.equal(store.list().length, 2); assert.equal(store.get(pid).meta.jobId, latest.id);
    assert.equal(jobResult(store.get(pid, old.id)).jobId, old.id);
    assert.equal((await store.wait([pid], 1))[0].jobId, latest.id);
    assert.equal((await store.peek([pid], 1)).processes[0].jobId, latest.id);
    assert.equal((await store.kill(pid)).jobId, latest.id);
    // GC ? job ????? PID ??????
    store.collect(Date.parse(newerExit.endTime) + RETENTION_MS - 1);
    assert.equal(store.jobs.size, 1); assert.equal(store.get(pid).meta.jobId, latest.id);
    store.dispose();
    const file = new FileProcessService({ stateDir: state, cliPaths: {}, readOnly: true });
    assert.equal((await file.getProcessResult(pid)).jobId, latest.id); file.dispose();
    const mcpState = join(TEMP, 'mcp-collision');
    const one = fixture(mcpState, Date.now() - 5000, 0, false, pid), two = fixture(mcpState, Date.now(), 0, false, pid);
    // npm test 的直接父行程是 script shell；fixture 必須使用主導者身分。
    const principal = await resolvePrincipal(process.ppid);
    assert(principal, 'collision fixture requires resolved principal');
    for (const item of [one, two]) { const path = join(item.dir, 'meta.json'), meta = JSON.parse(readFileSync(path)); meta.source = 'mcp'; meta.principal = principal; atomicJson(path, meta); }
    const previousState = process.env.AI_CLI_STATE_DIR; process.env.AI_CLI_STATE_DIR = mcpState;
    const service = new ProcessService({ cliPaths: {} }); await service.ready;
    try {
      assert.equal(service.listProcesses().length, 2);
      assert.equal(service.getProcessResult(pid).jobId, two.id);
      assert.equal(service.getProcessResult(pid, false, one.id).jobId, one.id);
      assert.equal((await service.waitForProcesses([pid], 1))[0].jobId, two.id);
      assert.equal((await service.peekProcesses([pid], 1)).processes[0].jobId, two.id);
      assert.equal((await service.killProcess(pid)).jobId, two.id);
      service.collectExpired(Date.parse(JSON.parse(readFileSync(join(two.dir, 'exit.json'))).endTime) + RETENTION_MS - 1);
      assert.equal(service.listProcesses().length, 1); assert.equal(service.getProcessResult(pid).jobId, two.id);
    } finally { service.dispose(); process.env.AI_CLI_STATE_DIR = previousState; }
  });
  await check('memory direct and agy entries expire at thirty minutes only after terminal', async () => {
    const before = process.env.AI_CLI_STATE_DIR; process.env.AI_CLI_STATE_DIR = join(TEMP, 'memory-gc');
    const service = new ProcessService({ cliPaths: {} }); await service.ready;
    const entries = service.processManager;
    for (const [pid, agent] of [[1, 'direct-api'], [2, 'antigravity']]) entries.set(pid, { pid, toolType: agent, status: 'completed', endTime: new Date(now).toISOString() });
    entries.set(3, { pid: 3, toolType: 'direct-api', status: 'running' });
    service.collectExpired(now + RETENTION_MS - 1); assert.equal(entries.size, 3);
    service.collectExpired(now + RETENTION_MS); assert.deepEqual([...entries.keys()], [3]); service.dispose(); process.env.AI_CLI_STATE_DIR = before;
  });
  await check('incremental output stays bounded and preserves UTF8 and truncation count', async () => {
    const state = join(TEMP, 'gc-parser'); const j = fixture(state, Date.now()); const message = '思'.repeat(3000);
    writeFileSync(join(j.dir, 'stdout.log'), message);
    const store = new JobStore(state, 'cli', true); await store.ready; const job = store.get(123456789), offset = job.cursors.stdout.offset;
    const result = jobResult(job); assert.equal(result.stdoutTruncated.totalChars, message.length); assert.ok(!result.stdout.includes('�'));
    assert.ok(Buffer.byteLength(job.stdout) <= 4096); jobResult(job); assert.equal(job.cursors.stdout.offset, offset); store.dispose();
  });
}
if (!section || section === 'memory') {
  const state = join(TEMP, 'memory'); const c = client(state); await c.init(); await c.call('list_processes');
  await check('50 one MiB jobs retain bounded server heap and write output plus metadata', async () => {
    const dispatched = []; const before = await heap(state); const samples = [{ jobs: 0, heapUsed: before.heapUsed }]; let outputBytes = 0, metadataBytes = 0, metadataWrites = 0;
    for (let i = 0; i < 50; i++) {
      const job = await dispatch(c, state, { mode: 'large' });
      dispatched.push({ pid: job.pid, jobId: job.meta.jobId }); console.log('DISPATCH ' + JSON.stringify(dispatched.at(-1)));
      await until(() => existsSync(join(job.dir, 'exit.json'))); await c.call('list_processes');
      outputBytes += statSync(join(job.dir, 'stdout.log')).size + statSync(join(job.dir, 'stderr.log')).size;
      const io = await until(() => existsSync(join(state, 'io-' + job.pid + '.json')) && JSON.parse(readFileSync(join(state, 'io-' + job.pid + '.json'))));
      assert.equal(io.writes, 2, 'runner must write only meta and exit, never per-chunk logs'); metadataBytes += io.bytes; metadataWrites += io.writes;
      if ((i + 1) % 10 === 0) { samples.push({ jobs: i + 1, heapUsed: (await heap(state)).heapUsed }); console.log('HEAP ' + JSON.stringify(samples.at(-1))); }
    }
    const after = await heap(state); const growth = after.heapUsed - before.heapUsed;
    assert.ok(growth < 8 * 1024 * 1024, `50 MiB output retained too much heap: ${growth}`);
    assert.ok(after.heapUsed - samples[1].heapUsed < 4 * 1024 * 1024, 'heap must not grow linearly with payload');
    const listed = await c.call('list_processes');
    console.log('PID_EVIDENCE ' + JSON.stringify({ dispatched, listed, diskJobs: readdirSync(join(state, 'jobs')).length }));
    assert.equal(listed.length, 50);
    assert.equal(new Set(listed.map(j => j.jobId)).size, 50);
    assert.deepEqual(new Set(listed.map(j => j.jobId)), new Set(dispatched.map(j => j.jobId)));
    const logicalWrites = outputBytes + metadataBytes + after.bytes;
    assert.ok(logicalWrites < outputBytes * 1.02, 'IO must approximate output plus metadata');
    console.log('MEASURE ' + JSON.stringify({ samples, heapGrowthBytes: growth, outputBytes, runnerMetadataBytes: metadataBytes, launcherMetadataBytes: after.bytes, logicalWriteBytes: logicalWrites, runnerMetadataWrites: metadataWrites }));
  });
  await c.stop();
}
} finally {
  for (const c of clients) await c.stop().catch(() => {});
  // 只處理本驗證的 UUID jobs；失敗也先確認並終止 stub，再刪測試目錄。
  for (const state of realStates) {
    if (!existsSync(join(state, 'jobs'))) continue;
    const store = new JobStore(state, 'cli', true); await store.ready;
    for (const job of store.jobs.values()) if (job.status === 'running') await store.kill(job.pid).catch(e => console.log('cleanup: ' + e.message));
    store.dispose();
  }
  rmSync(TEMP, { recursive: true, force: true });
}
console.log(`durable-jobs: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
