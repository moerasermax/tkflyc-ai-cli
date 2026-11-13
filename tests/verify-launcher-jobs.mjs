import { assertDurableStatus, preserveDurableFailure } from './helpers/durable-failure-evidence.mjs';
/** Windows runner 行程樹隔離：只 taskkill 本測試 SDK 啟動的 server，vendor 與狀態全部隔離。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { atomicJson, mayBeAlive } from '../dist/core/job-store.js';
import { lookupIdentities } from '../dist/core/live-jobs.js';
import { buildWorkerEnv } from '../dist/core/worker-env.js';
import { runJob } from '../dist/core/job-runner.js';

if (process.platform !== 'win32') { console.log('SKIP verify-launcher-jobs: Windows process tree only'); process.exit(0); }
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-launcher-jobs-')), state = join(TEMP, 'state');
process.env.AI_CLI_STATE_DIR = state;
const clients = new Set(), runners = new Set(), jobs = [];
// 本測試啟動的 runner／worker：PID → 建立時間；收尾只強制終止仍相符者，避免 PID 重用誤殺。
const owned = new Map();
const own = identity => { if (identity?.started) owned.set(identity.pid, identity.started); };
const ownPid = async pid => own((await lookupIdentities([pid]).catch(() => new Map())).get(pid));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
let passed = 0, failed = 0, a, b;
async function until(fn, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error('Launcher test deadline exceeded');
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; preserveDurableFailure({name, result: { assertionError: String(error) }, roots: [TEMP]}); console.log('FAIL ' + name + '\n' + error.stack); }
}
const stub = join(TEMP, 'worker.mjs');
writeFileSync(stub, `const s=JSON.parse(process.argv[2]);console.log('LAUNCHER_READY');setTimeout(()=>console.log(JSON.stringify({type:'result',result:'LAUNCHER_DONE',response:'LAUNCHER_DONE',status:'SUCCESS'})),s.delay??20000);`);
const serverEntry = join(ROOT, 'dist/bin/ai-cli-mcp.js'), launcherEntry = join(ROOT, 'dist/core/job-launcher.js');
const preload = join(TEMP, 'preload.mjs');
writeFileSync(preload, `import {createRequire,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url), cp=require('node:child_process'), fs=require('node:fs');
const fault=process.env.AI_CLI_TEST_LAUNCHER_FAULT;
if(process.argv[1]===${JSON.stringify(serverEntry)}){
 const {getAgent}=await import(${JSON.stringify(pathToFileURL(join(ROOT,'dist/agents/registry.js')).href)});
 for(const id of ['codex','antigravity']){const agent=getAgent(id);agent.win32DirectExec=true;agent.buildCommand=input=>({cliPath:process.execPath,args:[${JSON.stringify(stub)},input.prompt],cwd:input.cwd,agent:id,prompt:input.prompt,resolvedModel:'stub'});}
 const original=cp.spawn;
 cp.spawn=(command,args,...rest)=>{
  if(args?.[0]===${JSON.stringify(launcherEntry)}){
   if(fault==='no-pid')args=['-e','process.exit(0)'];
   if(fault==='timeout')args=['-e','setTimeout(()=>{},60000)'];
   if(fault==='spawn')command=${JSON.stringify(join(TEMP,'missing-launcher.exe'))};
  }
  return original(command,args,...rest);
 };
 if(fault==='ready-write'){const original=fs.writeFileSync;fs.writeFileSync=(file,...rest)=>{if(String(file).includes('launcher.ready'))throw Error('injected launcher.ready write failure');return original(file,...rest);};}
 syncBuiltinESMExports();
}
if(process.argv[1]===${JSON.stringify(launcherEntry)}){
 if(fault==='runner-spawn'){const original=cp.spawn;cp.spawn=(command,args,...rest)=>original(${JSON.stringify(join(TEMP,'missing-runner.exe'))},args,...rest);syncBuiltinESMExports();}
 if(fault==='invalid-pid'){const original=fs.writeFileSync;fs.writeFileSync=(file,data,...rest)=>{
  if(String(file).endsWith('launcher.json')){const report=JSON.parse(data);original(process.env.AI_CLI_TEST_LAUNCHER_EVIDENCE,JSON.stringify(report));data=JSON.stringify({...report,pid:0});}
  return original(file,data,...rest);
 };syncBuiltinESMExports();}
}`);
async function client(fault = '') {
  const id = randomUUID(), proxy = join(TEMP, `principal-${id}.mjs`), pidFile = join(TEMP, `server-${id}.json`);
  const evidence = join(TEMP, `evidence-${id}.json`);
  writeFileSync(proxy, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,[${JSON.stringify(serverEntry)}],{stdio:'inherit',windowsHide:true});writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:c.pid}));process.on('SIGTERM',()=>c.kill());c.on('close',code=>process.exitCode=code??0);`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [proxy], cwd: ROOT, stderr: 'pipe', env: {
    ...process.env, AI_CLI_AUTO_ADOPT: 'on', AI_CLI_BREAKER_DISABLED: 'true', AI_CLI_TEST_LAUNCHER_FAULT: fault,
    AI_CLI_TEST_LAUNCHER_EVIDENCE: evidence, NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(preload).href)}`,
  } });
  let errors = ''; transport.stderr?.on('data', data => errors += data);
  const sdk = new Client({ name: 'launcher-stub-client', version: '1' });
  const api = { sdk, transport, evidence, async call(name, args = {}) {
    const result = await sdk.callTool({ name, arguments: args }, undefined, { timeout: 40000 });
    assert.equal(result.isError ?? false, false, JSON.stringify(result) + errors);
    return JSON.parse(result.content.find(c => c.type === 'text').text);
  }, async stop() { await sdk.close(); clients.delete(api); } };
  clients.add(api); await sdk.connect(transport); api.serverPid = json(pidFile).pid; await ownPid(api.serverPid);
  return api;
}
async function dispatch(api, model) {
  const start = await api.call('run', { model, prompt: JSON.stringify({ delay: 20000 }), workFolder: ROOT });
  assert.match(start.jobId ?? '', /^[0-9a-f-]{36}$/); runners.add(start.pid);
  const dir = join(state, 'jobs', start.jobId);
  await until(() => existsSync(join(dir, 'meta.json')));
  const meta = json(join(dir, 'meta.json')); own(meta.runner); own(meta.worker);
  return { ...start, dir, meta };
}
// 直接呼叫 runJob 的等待路徑：worker 若被啟動會寫 marker，失敗路徑都不可出現。
const fakeLookup = async pids => new Map(pids.map(pid => [pid, { pid, ppid: 0, started: 'launcher-test', name: 'node' }]));
function runnerDir() {
  const jobId = randomUUID(), dir = join(state, 'jobs', jobId), marker = join(TEMP, `worker-${jobId}.txt`);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'stdin.tmp'), 'secret prompt');
  atomicJson(join(dir, 'launch.tmp'), { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`],
    cwd: ROOT, stdin: true, needsShell: false, serverPid: process.pid, principalPid: process.ppid,
    meta: { version: 1, jobId, agent: 'codex', resolvedModel: 'stub', task: 'runner wait', workFolder: ROOT,
      startTime: new Date().toISOString(), source: 'cli', principal: null, server: null, recoverable: true } });
  return { dir, marker };
}
function assertNoWorker({ dir, marker }) {
  assert.equal(existsSync(marker), false, 'worker must not start'); assert.equal(existsSync(join(dir, 'stdout.log')), false);
  assert.equal(existsSync(join(dir, 'launch.tmp')), false, 'launch.tmp removed'); assert.equal(existsSync(join(dir, 'stdin.tmp')), false, 'stdin.tmp removed');
  assert.equal(existsSync(join(dir, 'launcher.ready')), false);
}
function assertRunnerFailed(target, pattern) {
  const exit = json(join(target.dir, 'exit.json'));
  assert.equal(exit.exitCode, 1); assert.equal(exit.killed, false); assert.equal(exit.timedOut, false); assert.match(exit.error, pattern);
  const meta = json(join(target.dir, 'meta.json')); assert.equal(meta.pid, process.pid); assert.equal(meta.worker, null);
  assert.match(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), /Process error:/);
  assertNoWorker(target);
}
try {
  await test('Windows launcher returns runner PID and exits for pipe and PTY', async () => {
    a = await client();
    for (const model of ['gpt-6.1-sol', 'agy-default']) jobs.push(await dispatch(a, model));
    const ids = await lookupIdentities(jobs.flatMap(job => [job.pid, job.meta.worker.pid]));
    for (const job of jobs) {
      const launch = json(join(job.dir, 'launcher.json'));
      assert.equal(launch.pid, job.pid); assert.notEqual(launch.launcherPid, job.pid);
      assert.equal(job.meta.server.pid, a.serverPid); assert.equal(ids.get(job.pid).ppid, launch.launcherPid);
      assert.notEqual(ids.get(job.pid).ppid, a.serverPid); assert.equal(ids.get(job.meta.worker.pid).ppid, job.pid);
      assert.equal(mayBeAlive(launch.launcherPid), false);
      assert.equal(existsSync(join(job.dir, 'launch.tmp')), false, 'launch.tmp removed once launcher confirms');
    }
  });
  await test('Windows verified server exit cannot terminate durable pipe or PTY jobs', async () => {
    assert.equal(jobs.length, 2); assert.ok(mayBeAlive(a.serverPid));
    const expected = owned.get(a.serverPid), current = (await lookupIdentities([a.serverPid])).get(a.serverPid);
    assert.ok(expected && current?.started === expected, 'own server identity verified before stop');
    process.kill(a.serverPid, 'SIGKILL');
    await until(() => !mayBeAlive(a.serverPid));
    await sleep(500);
    for (const job of jobs) { assert.ok(mayBeAlive(job.pid), 'runner survives server tree kill'); assert.ok(mayBeAlive(job.meta.worker.pid), 'worker survives server tree kill'); }
    await a.stop().catch(() => {}); b = await client(); assert.notEqual(b.serverPid, a.serverPid);
    for (const job of jobs) {
      const adopted = await until(async () => {
        try { const result = await b.call('get_result', { pid: job.pid }); return result.adopted ? result : false; } catch { return false; }
      }, 15000);
      assert.equal(adopted.adopted, true); assert.notEqual(json(join(job.dir, 'meta.json')).principal.pid, job.meta.principal.pid);
      const result = await b.call('wait', { pids: [job.pid], timeout: 30, verbose: true });
      assert.match(JSON.stringify(result), /LAUNCHER_DONE/); assert.match(JSON.stringify(result), /completed/);
      const exit = json(join(job.dir, 'exit.json')); assert.equal(exit.exitCode, 0);
      assert.equal(exit.killed, false); assert.equal(exit.timedOut, false); assert.equal(existsSync(join(job.dir, 'lost.json')), false);
      await until(() => !mayBeAlive(job.pid) && !mayBeAlive(job.meta.worker.pid));
    }
  });
  await test('Windows legacy server spec gains containment before pipe and PTY spawn', async () => {
    for (const pty of [false, true]) {
      const jobId = randomUUID(), dir = join(state, 'jobs', jobId); mkdirSync(dir, { recursive: true });
      atomicJson(join(dir, 'launch.tmp'), { command: process.execPath, args: [stub, JSON.stringify({ delay: 100 })], cwd: ROOT,
        stdin: false, needsShell: false, ...(pty ? { pty: true } : {}), serverPid: process.pid, principalPid: process.ppid,
        meta: { version: 1, jobId, agent: pty ? 'antigravity' : 'codex', resolvedModel: 'stub', task: 'old entry', workFolder: ROOT,
          startTime: new Date().toISOString(), source: 'cli', principal: null, server: null, recoverable: true } });
      const child = spawn(process.execPath, [join(ROOT, 'dist/core/job-runner.js'), dir], { env: buildWorkerEnv(), detached: true, stdio: 'ignore', windowsHide: true });
      child.unref(); runners.add(child.pid); await ownPid(child.pid);
      await until(() => existsSync(join(dir, 'exit.json'))); assert.equal(json(join(dir, 'exit.json')).exitCode, 0);
      assert.ok(json(join(dir, 'meta.json')).containment?.generation, 'legacy spec must acquire containment, never silently bypass');
      assert.equal(json(join(dir, 'meta.json')).pid, child.pid); assert.equal(existsSync(join(dir, 'launcher.ready')), false);
      await until(() => !mayBeAlive(child.pid));
    }
  });
  await test('Windows launcher failures persist failed exit without starting workers', async () => {
    for (const fault of ['no-pid', 'timeout', 'spawn', 'runner-spawn', 'invalid-pid']) {
      const c = await client(fault), existing = new Set(readdirSync(join(state, 'jobs')));
      try {
        await assert.rejects(c.call('run', { model: 'gpt-6.1-sol', prompt: JSON.stringify({ delay: 100 }), workFolder: ROOT }), /launcher|ENOENT|runner/i);
        const dir = readdirSync(join(state, 'jobs')).filter(id => !existing.has(id)).map(id => join(state, 'jobs', id));
        assert.equal(dir.length, 1); const exit = json(join(dir[0], 'exit.json'));
        assert.equal(exit.exitCode, 1); assert.equal(exit.killed, false); assert.equal(exit.timedOut, false);
        assert.match(exit.error, /Failed to start codex runner:/); assert.doesNotMatch(exit.error, /terminated by user/i);
        assert.match(readFileSync(join(dir[0], 'stderr.log'), 'utf8'), /Process error:/);
        assert.equal(existsSync(join(dir[0], 'stdout.log')), false); assert.equal(existsSync(join(dir[0], 'stdin.tmp')), false);
        if (fault === 'invalid-pid') { const pid = json(c.evidence).pid; runners.add(pid); await ownPid(pid); await until(() => !mayBeAlive(pid)); }
        assert.equal(existsSync(join(dir[0], 'launch.tmp')), false);
      } finally { await c.stop(); }
    }
  });
  await test('Windows launcher.ready write failure fails run and leaves no running job', async () => {
    const c = await client('ready-write'), existing = new Set(readdirSync(join(state, 'jobs')));
    try {
      await assert.rejects(c.call('run', { model: 'gpt-6.1-sol', prompt: JSON.stringify({ delay: 100 }), workFolder: ROOT }), /injected launcher\.ready write failure/);
      const [jobId] = readdirSync(join(state, 'jobs')).filter(id => !existing.has(id)), dir = join(state, 'jobs', jobId);
      const pid = json(join(dir, 'launcher.json')).pid; runners.add(pid); await ownPid(pid);
      const exit = json(join(dir, 'exit.json')); assert.equal(exit.exitCode, 1); assert.equal(exit.killed, false); assert.equal(exit.timedOut, false);
      assert.match(exit.error, /injected launcher\.ready write failure/); assert.doesNotMatch(exit.error, /terminated by user/i); assert.match(readFileSync(join(dir,'stderr.log'),'utf8'), /launcher\.ready/);
      await until(() => !mayBeAlive(pid), 15000);
      assert.equal(json(join(dir, 'exit.json')).error, exit.error, 'runner must not overwrite the launch failure');
      assert.equal(existsSync(join(dir, 'stdout.log')), false); assert.equal(existsSync(join(dir, 'launch.tmp')), false); assert.equal(existsSync(join(dir, 'stdin.tmp')), false);
      const row = (await c.call('list_processes')).find(r => r.jobId === jobId);
      assert.equal(row?.status, 'failed');
    } finally { await c.stop(); }
  });
  await test('Windows runner returns without worker when exit.json appears while waiting', async () => {
    const target = runnerDir(), startedAt = Date.now();
    const running = runJob(target.dir, { waitForLauncher: true, launcherWaitMs: 15000, lookup: fakeLookup });
    await sleep(300); assert.equal(existsSync(join(target.dir, 'launch.tmp')), true, 'launch.tmp kept while waiting for launcher');
    const cancelled = { exitCode: 1, signal: null, endTime: new Date().toISOString(), timedOut: false, killed: false, error: 'server launch failure' };
    atomicJson(join(target.dir, 'exit.json'), cancelled);
    await running; assert.ok(Date.now() - startedAt < 10000, 'exit.json ends the wait');
    assert.deepEqual(json(join(target.dir, 'exit.json')), cancelled); assert.equal(existsSync(join(target.dir, 'meta.json')), false);
    assertNoWorker(target);
  });
  await test('Windows runner launcher timeout or foreign PID fails without worker', async () => {
    for (const ready of [undefined, { pid: process.pid + 1 }]) {
      const target = runnerDir(); if (ready) atomicJson(join(target.dir, 'launcher.ready'), ready);
      await runJob(target.dir, { waitForLauncher: true, launcherWaitMs: 300, lookup: fakeLookup });
      assertRunnerFailed(target, /activation timed out or returned invalid PID/);
    }
  });
  await test('Windows runner wait exceptions and identity failure never leave launch.tmp', async () => {
    const thrown = runnerDir();
    await runJob(thrown.dir, { waitForLauncher: true, launcherWaitMs: 5000, lookup: fakeLookup, pause: async () => { throw new Error('injected pause failure'); } });
    assertRunnerFailed(thrown, /activation timed out or returned invalid PID/);
    const anonymous = runnerDir(); atomicJson(join(anonymous.dir, 'launcher.ready'), { pid: process.pid });
    await runJob(anonymous.dir, { waitForLauncher: true, launcherWaitMs: 300, lookup: async () => new Map(), pause: async () => {} });
    assert.match(json(join(anonymous.dir, 'exit.json')).error, /Cannot identify runner/); assertNoWorker(anonymous);
    const corrupt = runnerDir(); writeFileSync(join(corrupt.dir, 'launch.tmp'), '{not json');
    await assert.rejects(runJob(corrupt.dir, { waitForLauncher: true, launcherWaitMs: 300, lookup: fakeLookup }), SyntaxError);
    assert.equal(existsSync(join(corrupt.dir, 'launch.tmp')), false, 'corrupt launch.tmp removed'); assert.equal(existsSync(corrupt.marker), false);
  });
} finally {
  for (const job of jobs) if (mayBeAlive(job.pid)) atomicJson(join(job.dir, 'kill.json'), { runner: job.meta.runner });
  for (const c of clients) await c.stop().catch(() => {});
  await until(() => [...runners].every(pid => !mayBeAlive(pid)), 30000).catch(error => { failed++; console.log('FAIL Windows launcher cleanup\n' + error.stack); });
  // 突變可能讓 runner／worker 永遠不結束：只強制終止建立時間仍相符的自家行程。
  const leftovers = [...owned].filter(([pid]) => mayBeAlive(pid));
  if (leftovers.length) {
    const current = await lookupIdentities(leftovers.map(([pid]) => pid)).catch(() => new Map());
    for (const [pid, started] of leftovers) if (current.get(pid)?.started === started) {
      console.log(`Launcher cleanup: force terminating own PID ${pid}`);
      await promisify(execFile)('taskkill.exe', ['/pid', String(pid), '/f'], { windowsHide: true }).catch(() => {});
    }
    await until(() => [...runners].every(pid => !mayBeAlive(pid)), 10000).catch(() => {});
  }
  if ([...runners].every(pid => !mayBeAlive(pid))) rmSync(TEMP, { recursive: true, force: true });
  else console.log('Launcher evidence retained: ' + TEMP);
}
console.log(`Launcher jobs: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
