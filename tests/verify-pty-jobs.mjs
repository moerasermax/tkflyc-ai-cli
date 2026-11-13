import { assertDurableStatus, preserveDurableFailure } from './helpers/durable-failure-evidence.mjs';
/** Windows ConPTY 持久化回歸：SDK 獨立 server、真實 PTY + Node stub，狀態全部隔離。 */
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
import { atomicJson, mayBeAlive, JobStore, jobResult } from '../dist/core/job-store.js';
import { readLiveJobs, lookupIdentities } from '../dist/core/live-jobs.js';
import { createAnsiCleaner, stripAnsi } from '../dist/core/ansi.js';
import { loadPtyModule, releaseExitedPty } from '../dist/core/pty-runner.js';
import { FileProcessService } from '../dist/core/file-process-service.js';
import { getAgent } from '../dist/agents/registry.js';
import { buildWorkerEnv } from '../dist/core/worker-env.js';
import { WinJobClient, lookupNativeIdentities } from '../dist/core/win-job-client.js';
import { saveContainmentRef } from '../dist/core/containment-store.js';
import { runJobs } from '../dist/app/jobs.js';

if (process.platform !== 'win32') { console.log('SKIP verify-pty-jobs: Windows ConPTY only'); process.exit(0); }
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-pty-jobs-'));
const state = join(TEMP, 'state');
process.env.AI_CLI_STATE_DIR = state;
const clients = new Set(), runners = new Set();
let passed = 0, failed = 0, nativeFaultFailed = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error('PTY test deadline exceeded');
}
async function test(name, fn) {
  if(process.env.PTY_TEST_FILTER&&!name.includes(process.env.PTY_TEST_FILTER))return;
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; preserveDurableFailure({name, result: { assertionError: String(e) }, roots: [TEMP]}); console.log('FAIL ' + name + '\n' + e.stack); }
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));
// PID 可被新 job 重用；同 jobId 必須唯一，同 PID 的其他紀錄只能屬於較早 job。
async function assertJobIdentity(rows, expected, origin, { sources = async () => ({}), log = console.log,
  readMeta = id => { try { return json(join(state, 'jobs', id, 'meta.json')); } catch { return undefined; } } } = {}) {
  const relevant = rows.filter(r => r.jobId === expected.jobId || r.pid === expected.pid).map(r => {
    const meta = typeof r.jobId === 'string' && r.jobId ? readMeta(r.jobId) : undefined;
    return { jobId: r.jobId ?? null, pid: r.pid, status: r.status ?? null,
      startTime: r.startTime ?? meta?.startTime ?? null, metadataStartTime: meta?.startTime ?? null,
      agent: r.agent ?? null, origin: origin.startsWith('file') ? `${origin}:${r.jobId ? 'jobs' : 'cwds'}` : origin,
      source: r.source ?? meta?.source ?? null };
  });
  const current = relevant.filter(r => r.jobId === expected.jobId);
  const earlier = relevant.filter(r => r.pid === expected.pid && r.jobId !== expected.jobId);
  const expectedTime = Date.parse(expected.startTime), violations = [];
  if (!expected.jobId || current.length !== 1) violations.push('expected jobId must occur exactly once');
  if (current.some(r => r.pid !== expected.pid)) violations.push('expected jobId must have expected pid');
  if (!Number.isFinite(expectedTime)) violations.push('expected startTime must parse');
  if (earlier.some(r => typeof r.jobId !== 'string' || !r.jobId.trim()
    || !Number.isFinite(Date.parse(r.startTime)) || !(Date.parse(r.startTime) < expectedTime))) {
    violations.push('other rows with the same pid must have nonempty jobId and earlier startTime');
  }
  if (violations.length) {
    let projections;
    try { projections = await sources(); } catch (error) { projections = { projectionError: String(error) }; }
    assert.deepEqual(violations, [], JSON.stringify({ expected, origin, matches: relevant, ...projections }, null, 2));
  }
  if (earlier.length) log(`OBSERVED PID reuse (${origin}): pid ${expected.pid} also listed for earlier job(s) ${earlier.map(r => r.jobId).join(', ')}`);
}
const stub = join(TEMP, 'stub.mjs');
writeFileSync(stub, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const spec=JSON.parse(process.argv[2]);
if(spec.tree){const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});writeFileSync(spec.tree,String(c.pid));}
process.stdout.write('\\x1b[');
setTimeout(()=>process.stdout.write('31mPTY_READY\\x1b[0m\\n'),100);
setTimeout(()=>process.stdout.write('\\x1b]0;'+ 'title'.repeat(12)),150);
setTimeout(()=>process.stdout.write('\\x1b\\\\'),250);
setTimeout(()=>{process.stdout.write(JSON.stringify({response:'PTY_PONG',status:'SUCCESS',conversation_id:'stub-session'})+'\\n');process.exitCode=spec.code??0;},spec.delay??3000);
`);
const buildStub = input => ({ cliPath: process.execPath, args: [stub, input.prompt], cwd: input.cwd,
  agent: 'antigravity', prompt: input.prompt, resolvedModel: 'agy-default' });
const preload = join(TEMP, 'preload.mjs');
writeFileSync(preload, `if(!process.argv[1]?.endsWith('job-runner.js')) {
const {getAgent}=await import(${JSON.stringify(pathToFileURL(join(ROOT, 'dist/agents/registry.js')).href)});
// Node stub 在 pipe 對照也直接執行，避免 Windows cmd 引號先失敗而遮蔽 PTY 旗標回歸。
getAgent('antigravity').win32DirectExec=true;
getAgent('antigravity').buildCommand=input=>({cliPath:process.execPath,args:[${JSON.stringify(stub)},input.prompt],cwd:input.cwd,agent:'antigravity',prompt:input.prompt,resolvedModel:'agy-default'});
}`);
// SDK transport 的直屬 child 是獨立 principal；server 的父行程不是本測試的共同 PID。
const proxy = join(TEMP, 'principal.mjs');
writeFileSync(proxy, `import{spawn}from'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(join(ROOT, 'dist/bin/ai-cli-mcp.js'))}],{stdio:'inherit',windowsHide:true});
process.on('SIGTERM',()=>child.kill()); child.on('close',code=>process.exitCode=code??0);`);
async function client() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [proxy], cwd: ROOT, stderr: 'pipe',
    env: { ...process.env, AI_CLI_AUTO_ADOPT: 'on', AI_CLI_BREAKER_DISABLED: 'true',
      NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(preload).href)}` } });
  let errors = ''; transport.stderr?.on('data', b => errors += b);
  const sdk = new Client({ name: 'pty-stub-client', version: '1' });
  const api = { transport, sdk, async call(name, args = {}) {
    const r = await sdk.callTool({ name, arguments: args }, undefined, { timeout: 40000 });
    assert.equal(r.isError ?? false, false, JSON.stringify(r) + errors);
    return JSON.parse(r.content.find(c => c.type === 'text').text);
  }, async stop() { await sdk.close(); clients.delete(api); } };
  clients.add(api); await sdk.connect(transport); return api;
}
async function dispatch(c, spec = {}) {
  const start = await c.call('run', { model: 'agy-default', prompt: JSON.stringify(spec), workFolder: ROOT });
  // 路由突變可能啟動 legacy stub：仍透過本 server 的 kill 收回自己的測試行程。
  if (!start.jobId) await c.call('kill_process', { pid: start.pid });
  assert.match(start.jobId ?? '', /^[0-9a-f-]{36}$/);
  runners.add(start.pid);
  const dir = join(state, 'jobs', start.jobId);
  await until(() => existsSync(join(dir, 'meta.json')));
  return { ...start, dir, meta: json(join(dir, 'meta.json')) };
}
async function rawRunner(extra = {}, command = process.execPath, launch = {}) {
  const id = randomUUID(), dir = join(state, 'jobs', id); mkdirSync(dir, { recursive: true });
  const spec = { command, args: [stub, JSON.stringify({ delay: 3000 })], cwd: ROOT, stdin: false, needsShell: false,
    meta: { version: 1, jobId: id, agent: 'antigravity', resolvedModel: 'agy-default', task: 'stub', workFolder: ROOT,
      startTime: new Date().toISOString(), source: 'cli', server: null, principal: null, recoverable: true },
    serverPid: process.pid, principalPid: process.ppid, ...extra };
  if (process.platform === 'win32') { spec.meta.containment = await new WinJobClient().prepare(id, dir); saveContainmentRef(state, spec.meta.containment); atomicJson(join(dir, 'hold.json'), { containment: spec.meta.containment }); }
  atomicJson(join(dir, 'launch.tmp'), spec);
  const child = spawn(process.execPath, [launch.entry ?? join(ROOT, 'dist/core/job-runner.js'), dir], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...buildWorkerEnv(), ...launch.env } }); child.unref(); runners.add(child.pid);
  await until(() => existsSync(join(dir, 'meta.json')));
  return { dir, pid: child.pid, meta: json(join(dir, 'meta.json')) };
}
async function exited(job) {
  // 真 node-pty 的 console kill 可先等 ready，再走 5 秒查詢退路；使用一般原生 PTY 期限。
  try { await until(async () => { if (process.platform === 'win32' && !mayBeAlive(job.pid) && !existsSync(join(job.dir, 'exit.json'))) await storedResult(job); return existsSync(join(job.dir, 'exit.json')); }, job.evidence && !job.nativePty ? 8000 : 20000); }
  catch (error) {
    if (job.nativePty) {
      nativeFaultFailed = true;
      const evidence = json(job.evidence), log = join(job.dir, 'stderr.log');
      console.log('PTY native timeout evidence: ' + JSON.stringify({ directory: job.dir, evidence,
        runnerAlive: mayBeAlive(job.pid), workerAlive: mayBeAlive(evidence.worker), stderr: existsSync(log) ? readFileSync(log, 'utf8') : '' }));
    }
    throw error;
  }
  await until(() => !mayBeAlive(job.pid), 8000);
  return json(join(job.dir, 'exit.json'));
}
async function storedResult(target) {
  const store = new JobStore(state, 'cli', true); await store.ready;
  try { return jobResult(store.get(target.pid), true); } finally { store.dispose(); }
}
// 每個 fault 都在獨立 runner 注入；不修改已載入模組，不與 SDK server 共用 PTY cache。
async function faultRunner(fault, extra = {}) {
  const evidence = join(TEMP, randomUUID() + '.json'), loader = evidence + '.cjs', entry = evidence + '.mjs';
  writeFileSync(loader, `if(require('node:worker_threads').isMainThread&&process.argv[1]===${JSON.stringify(entry)}){
const fs=require('node:fs'),m=require('node:module');
const original={open:fs.openSync,write:fs.writeSync,close:fs.closeSync,load:m._load};
const stats={writes:0,lateWrites:0,kills:0,ended:false}; const persist=()=>{const fd=original.open(${JSON.stringify(evidence)},'w');try{original.write(fd,JSON.stringify(stats));}finally{original.close(fd);}};
let outputFd,closed=false;
fs.openSync=function(path,...args){const fd=original.open.call(this,path,...args);if(String(path).endsWith('stdout.log'))outputFd=fd;return fd;};
fs.closeSync=function(fd){if(fd===outputFd)closed=true;return original.close.call(this,fd);};
fs.writeSync=function(fd,text,...args){if(fd===outputFd&&(!closed||text==='LATE_DATA')){stats.writes++;if(closed){stats.lateWrites++;persist();return String(text).length;}
if(${JSON.stringify(fault)}==='write'||${JSON.stringify(fault)}==='flush-write'&&text==='FLUSH_WRITE'){persist();throw Error('injected stdout EIO');}}
return original.write.call(this,fd,text,...args);};
require('node:module').syncBuiltinESMExports();
m._load=function(id,...args){if(id!=='@homebridge/node-pty-prebuilt-multiarch')return original.load.call(this,id,...args);
if(${JSON.stringify(fault)}.startsWith('native-')){const native=original.load.call(this,id,...args);return{spawn(...args){const p=native.spawn(...args),kill=p.kill.bind(p);stats.worker=p.pid;persist();if(${JSON.stringify(fault)}==='native-broker-lost'){const agent=p._agent,nativeKill=agent._ptyNative.kill.bind(agent._ptyNative);agent._ptyNative={...agent._ptyNative,kill(...a){stats.nativeKills=(stats.nativeKills??0)+1;persist();return nativeKill(...a);}};}if(${JSON.stringify(fault)}==='native-kill-zero'){const onExit=p.onExit.bind(p);Object.defineProperty(p,'onExit',{value:fn=>onExit(event=>{stats.nativeExit=event.exitCode;stats.forwardedExit=0;persist();fn({...event,exitCode:0});})});}p.kill=()=>{stats.kills++;stats.killReady=p._isReady;stats.deferred=p._deferreds?.length;persist();return kill();};return p;}};}
return{spawn(){let data,exit;const p={pid:process.pid,onData(fn){data=fn;},onExit(fn){exit=fn;},kill(){stats.kills++;persist();if(stats.ended)throw Error('kill after exit');if(${JSON.stringify(fault)}==='kill-throws')throw Error('injected kill failure');}};
if(${JSON.stringify(fault)}==='cleanup-stuck')setInterval(()=>{},1000);
if(${JSON.stringify(fault)}!=='missing')p._agent={inSocket:{destroy(){if(${JSON.stringify(fault)}.startsWith('cleanup'))throw Error('injected release failure');}},_conoutSocketWorker:{dispose(){}}};
setTimeout(()=>{if(${JSON.stringify(fault)}==='write'){data('first');data('second');}else if(${JSON.stringify(fault)}==='ansi-only')data('\\x1b[?25l\\x1b[2J\\x1b[H');else if(${JSON.stringify(fault)}!=='async-failure')data('before\\n');},10);
setTimeout(()=>{stats.ended=true;persist();exit({exitCode:${JSON.stringify(fault)}==='async-failure'?127:${JSON.stringify(extra.code ?? 0)}});
if(${JSON.stringify(fault)}==='after-exit')queueMicrotask(()=>process.emit('SIGTERM'));
setTimeout(()=>{data('LATE_DATA');persist();},50);},150);return p;}};};persist();}`);
  writeFileSync(entry, `import{runJob}from ${JSON.stringify(pathToFileURL(join(ROOT,'dist/core/job-runner.js')).href)};
import{lookupNativeIdentities,WinJobClient}from ${JSON.stringify(pathToFileURL(join(ROOT,'dist/core/win-job-client.js')).href)};
if(['native-broker-lost','native-kill-zero','kill-throws','after-exit'].includes(${JSON.stringify(fault)}))WinJobClient.prototype.terminate=async()=>{(await import('node:fs')).appendFileSync(${JSON.stringify(evidence+'.requests')},'terminate\\n');return {state:'unknown'}};
import{lookupIdentities}from ${JSON.stringify(pathToFileURL(join(ROOT,'dist/core/live-jobs.js')).href)};
import{createAnsiCleaner}from ${JSON.stringify(pathToFileURL(join(ROOT,'dist/core/ansi.js')).href)};
const cleaner=createAnsiCleaner();
if(${JSON.stringify(fault)}==='flush-throw')cleaner.flush=()=>{throw Error('injected flush failure');};
if(${JSON.stringify(fault)}==='flush-write')cleaner.flush=()=>'FLUSH_WRITE';
await runJob(process.argv[2],{cleaner,lookup:async pids=>{if(pids.length===1){if(${JSON.stringify(fault)}==='native-kill')throw Error('injected worker lookup failure');return new Map();}return (process.platform==='win32'?lookupNativeIdentities:lookupIdentities)(pids);}});`);
  const target = await rawRunner({ pty: true, ...extra }, process.execPath, { entry,
    env: { NODE_OPTIONS: `--require ${JSON.stringify(loader)}` } });
  if (fault.startsWith('native-')) assert.ok(Number.isInteger(json(evidence).worker), 'native spawn instrumentation must record its own worker');
  return { ...target, evidence, nativePty: fault.startsWith('native-') };
}
async function stopOwnWorker(identity) {
  if (!identity || !mayBeAlive(identity.pid)) return;
  const current = (await lookupIdentities([identity.pid])).get(identity.pid);
  assert.equal(current?.started, identity.started, 'refuse to terminate reused test worker PID');
  await promisify(execFile)('taskkill.exe', ['/pid', String(identity.pid), '/t', '/f'], { windowsHide: true });
}
let a, b, job;
const originalBuilder = getAgent('antigravity').buildCommand;
const originalDirectExec = getAgent('antigravity').win32DirectExec;
getAgent('antigravity').win32DirectExec = true;
try {
  await test('PTY list identity accepts earlier PID reuse and rejects ambiguous jobs', async () => {
    const current = { jobId: 'current', pid: 123, status: 'running', startTime: '2026-10-20T02:00:00Z', agent: 'stub', source: 'cli' };
    const earlier = { ...current, jobId: 'earlier', startTime: '2026-10-20T01:00:00Z' };
    const observed = [], options = { readMeta: () => undefined, log: line => { observed.push(line); console.log(line); } };
    await assertJobIdentity([current, earlier], current, 'identity fixture', options);
    assert.deepEqual(observed, ['OBSERVED PID reuse (identity fixture): pid 123 also listed for earlier job(s) earlier']);
    for (const rows of [[current, current], [current, { ...earlier, jobId: null }],
      [current, { ...earlier, startTime: '2026-10-20T03:00:00Z' }], [earlier],
      [current, { ...earlier, startTime: 'invalid' }], [{ ...current, pid: 456 }]]) {
      await assert.rejects(assertJobIdentity(rows, current, 'identity fixture', options), { code: 'ERR_ASSERTION' });
    }
    assert.equal(observed.length, 1, 'rejected identity rows must not report accepted PID reuse');
  });
  await test('PTY ANSI cleaner preserves split CSI and long OSC without delaying plain text', () => {
    const clean = createAnsiCleaner();
    assert.equal(clean.push('first\x1b['), 'first'); assert.equal(clean.push('31mred\x1b[0m'), 'red');
    assert.equal(clean.push('\x1b]0;' + 'x'.repeat(200)), '');
    assert.equal(clean.push('\x1b'), ''); assert.equal(clean.push('\\after'), 'after'); assert.equal(clean.flush(), '');
  });
  await test('PTY malformed CSI never withholds later text', () => {
    for (const suffix of ['\nnext', '漢字', '\x1b[2mnext']) {
      const clean = createAnsiCleaner(); assert.equal(clean.push('\x1b['), '');
      assert.equal(clean.push(suffix), '[' + stripAnsi(suffix)); assert.equal(clean.push('visible'), 'visible');
    }
    assert.equal(createAnsiCleaner().push('\x1b[1 \x1b[2m'), '[1 ');
  });
  await test('PTY incomplete OSC and DCS carry is bounded', () => {
    for (const start of ['\x1b]0;', '\x1bP']) {
      const clean = createAnsiCleaner(); assert.equal(clean.push(start), '');
      for (let i = 0; i < 3; i++) assert.equal(clean.push('x'.repeat(1000)), '');
      assert.equal(clean.push('x'.repeat(2000)), start.slice(1) + 'x'.repeat(5000)); assert.equal(clean.push('visible'), 'visible');
    }
  });
  await test('PTY OSC matches stripAnsi and flush drops incomplete sequences', () => {
    for (const text of ['\x1b]title\x07plain', '\x1b]title\x1b\\plain']) assert.equal(createAnsiCleaner().push(text), stripAnsi(text));
    assert.equal(createAnsiCleaner().push('\x1b]bad\x1b[31mvisible'), ']badvisible');
    assert.equal(createAnsiCleaner().push('\x1b]bad\x1b[31mhidden\x1b\\visible'), ']badhidden\\visible');
    for (const text of ['\x1b[3', '\x1b]title', '\x1bPdata', '\x1b']) {
      const clean = createAnsiCleaner(); assert.equal(clean.push(text), ''); assert.equal(clean.flush(), ''); assert.equal(clean.push('visible'), 'visible');
    }
  });
  await test('PTY overlong OSC preserves plain text in the same chunk', () => {
    const tail = ']0;' + 'x'.repeat(5000) + 'VISIBLE';
    assert.equal(createAnsiCleaner().push('\x1b' + tail), tail);
  });
  await test('PTY resource release tolerates absent private fields and reports release', () => {
    for (const value of [undefined, {}, { _agent: {} }]) assert.equal(releaseExitedPty(value), false);
    let released = 0; assert.equal(releaseExitedPty({ _agent: { inSocket: { destroy: () => released++ } } }), true);
    assert.equal(released, 1);
  });
  await test('PTY onExit release exceptions still persist correct results', async () => {
    for (const code of [0, 7]) {
      const target = await faultRunner('cleanup', { code }); assert.equal((await exited(target)).exitCode, code);
      assert.equal((await storedResult(target)).status, code ? 'failed' : 'completed');
      assert.match(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), /injected release failure/);
    }
    const retained = await faultRunner('cleanup-stuck');
    try {
      await until(() => existsSync(join(retained.dir, 'exit.json')), 8000);
      assert.ok(mayBeAlive(retained.pid), 'fixture must retain its own handle after exit');
      assertDurableStatus((await storedResult(retained)), 'completed', {name:'pty-jobs',roots:[TEMP]});
    } finally { await stopOwnWorker(retained.meta.runner); }
  });
  await test('PTY missing private fields still persist correct results', async () => {
    for (const code of [0, 7]) {
      const target = await faultRunner('missing', { code }); assert.equal((await exited(target)).exitCode, code);
      assert.equal((await storedResult(target)).status, code ? 'failed' : 'completed');
      assert.equal(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), '');
    }
  });
  await test('PTY flush and write exceptions cannot prevent exit persistence', async () => {
    for (const fault of ['flush-throw', 'flush-write']) {
      const target = await faultRunner(fault); assert.equal((await exited(target)).exitCode, 0);
      assert.match(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), /PTY stdout flush failed/);
      assertDurableStatus((await storedResult(target)), 'completed', {name:'pty-jobs',roots:[TEMP]});
    }
  });
  await test('PTY onData write errors are recorded once without uncaught exit', async () => {
    const target = await faultRunner('write'); assert.equal((await exited(target)).exitCode, 0);
    assert.equal(json(target.evidence).writes, 2);
    assert.equal((readFileSync(join(target.dir, 'stderr.log'), 'utf8').match(/PTY stdout write failed/g) ?? []).length, 1);
  });
  await test('PTY late onData never writes a closed or reused stdout fd', async () => {
    const target = await faultRunner('late'); assert.equal((await exited(target)).exitCode, 0);
    assert.equal(json(target.evidence).lateWrites, 0); assert.equal(json(target.evidence).writes, 1);
    assert.equal(readFileSync(join(target.dir, 'stdout.log'), 'utf8'), 'before\n');
  });
  await test('PTY received data with failed writes is never reported without output', async () => {
    const target = await faultRunner('write', { code: 7 });
    const exit = await exited(target); assert.equal(exit.exitCode, 7); assert.equal(exit.error, undefined);
    const errors = readFileSync(join(target.dir, 'stderr.log'), 'utf8');
    assert.match(errors, /PTY stdout write failed/); assert.doesNotMatch(errors, /without output/);
    assert.equal((await storedResult(target)).status, 'failed');
  });
  await test('PTY control-only data with nonzero exit is reported without output', async () => {
    const target = await faultRunner('ansi-only', { code: 7 });
    const exit = await exited(target); assert.equal(exit.exitCode, 7); assert.match(exit.error ?? '', /PTY worker exited with code 7 without output/);
    assert.equal(readFileSync(join(target.dir, 'stdout.log'), 'utf8'), '');
    assert.equal((await storedResult(target)).status, 'failed');
  });
  await test('PTY missing worker identity uses containment or owned console kill', async () => {
    const target = await faultRunner('native-kill', { args: [stub, JSON.stringify({ delay: 60000 })] });
    const pid = json(target.evidence).worker, identity = (await lookupIdentities([pid])).get(pid);
    try {
      assert.equal(target.meta.worker, null); atomicJson(join(target.dir, 'kill.json'), { runner: target.meta.runner });
      const exit = await exited(target); assert.equal(exit.killed, true); assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 143);
      if (process.platform === 'win32') assert.equal(json(target.evidence).kills, 0, 'broker terminates the job without console fallback'); else assert.ok(json(target.evidence).kills >= 1); await until(() => !mayBeAlive(pid));
    } finally { await stopOwnWorker(identity); }
  });
  await test('PTY missing identity and lost broker use owned real console kill',async()=>{
    const target=await faultRunner('native-broker-lost',{args:[stub,JSON.stringify({delay:60000})]});
    const pid=json(target.evidence).worker,identity=(await lookupIdentities([pid])).get(pid);
    try{assert.equal(target.meta.worker,null);atomicJson(join(target.dir,'kill.json'),{runner:target.meta.runner});
      const exit=await exited(target);assert.equal(exit.killed,true);assert.ok(json(target.evidence).nativeKills>=1);await until(()=>!mayBeAlive(pid));
    }finally{await stopOwnWorker(identity);}
  });
  await test('PTY killed native zero exit normalizes to 143', async()=>{
    const target=await faultRunner('native-kill-zero',{args:[stub,JSON.stringify({delay:60000})]});
    atomicJson(join(target.dir,'kill.json'),{runner:target.meta.runner});
    const exit=await exited(target);assert.equal(json(target.evidence).forwardedExit,0,'injected ConPTY exit must differ from 143');
    assert.equal(exit.killed,true);assert.equal(exit.exitCode,143);assert.equal((await storedResult(target)).exitCode,143);
  });
  await test('PTY missing worker identity uses containment or owned console timeout', async () => {
    const target = await faultRunner('native-timeout', { timeoutMs: 1500, args: [stub, JSON.stringify({ delay: 60000 })] });
    const pid = json(target.evidence).worker, identity = (await lookupIdentities([pid])).get(pid);
    try {
      const exit = await exited(target); assert.equal(target.meta.worker, null);
      assert.equal(exit.timedOut, true); assert.equal(exit.killed, false); await until(() => !mayBeAlive(pid));
      if (process.platform === 'win32') assert.equal(json(target.evidence).kills, 0, 'broker terminates the job without console fallback'); else assert.ok(json(target.evidence).kills >= 1);
    } finally { await stopOwnWorker(identity); }
  });
  await test('PTY failed held-console termination never claims request was sent', async () => {
    const target = await faultRunner('kill-throws', { timeoutMs: 0 }); const exit = await exited(target);
    if (process.platform === 'win32') { assert.equal(exit.timedOut, true); assert.equal(json(target.evidence).kills, 0); const text=readFileSync(join(target.dir,'stderr.log'),'utf8');assert.match(text,/no direct worker termination request was sent/);assert.doesNotMatch(text,/direct worker termination requested|Process terminated by user/); return; }
    assert.equal(exit.killed, false); assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0);
    if (process.platform === 'win32') assert.equal(json(target.evidence).kills, 0, 'broker terminates the job without console fallback'); else assert.ok(json(target.evidence).kills >= 1); assert.match(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), /injected kill failure/);
  });
  await test('PTY console fallback never kills after onExit', async () => {
    const target = await faultRunner('after-exit'); const exit = await exited(target);
    assert.equal(existsSync(target.evidence+'.requests'),false,'natural close must not request new broker termination');
    assert.equal(json(target.evidence).kills, 0); assert.equal(exit.killed, false); assert.equal(exit.timedOut, false);
  });
  await test('PTY asynchronous spawn failure reports a failed job with reason', async () => {
    const target = await faultRunner('async-failure'); const exit = await exited(target);
    assert.equal(exit.exitCode, 127); assert.match(exit.error, /PTY worker exited with code 127/);
    const result = await storedResult(target); assert.equal(result.status, 'failed'); assert.match(result.agentOutput.error, /code 127/);
  });
  await test('PTY MCP run returns jobId and verified worker metadata', async () => {
    a = await client(); job = await dispatch(a, { delay: 60000 });
    assert.ok(job.meta.worker?.started); assert.notEqual(job.meta.worker.pid, job.pid);
    assert.ok(job.meta.runner.started); assert.equal(job.meta.principal.pid, a.transport.pid);
    assert.equal(job.meta.version, 1); assert.equal(job.meta.recoverable, true);
  });
  await test('PTY peek and live-jobs list the durable job once', async () => {
    const observed = await a.call('peek', { pids: [job.pid], timeSec: 1 });
    assert.equal(observed.processes[0].jobId, job.jobId); assert.equal(observed.processes[0].status, 'running');
    const expected = { jobId: job.jobId, pid: job.pid, startTime: job.meta.startTime };
    const projections = async () => {
      const matching = (rows, origin) => rows.filter(r => r.pid === job.pid || r.jobId === job.jobId).map(r => ({
        origin, jobId: r.jobId ?? null, pid: r.pid, status: r.status ?? null,
        startTime: r.startTime ?? null, agent: r.agent ?? null, source: r.source ?? null,
      }));
      const sources = { live: matching(await readLiveJobs(state), 'live') };
      const file = new FileProcessService({ stateDir: state, cliPaths: {}, readOnly: true });
      try { sources.file = matching(await file.listJobSummaries(), 'file'); }
      catch (error) { sources.fileError = String(error); }
      finally { file.dispose(); }
      return sources;
    };
    const options = { sources: projections };
    await assertJobIdentity(await a.call('list_processes'), expected, 'list_processes', options);
    const live = await readLiveJobs(state);
    await assertJobIdentity(live, expected, 'live', options);
    let output = ''; assert.equal(await runJobs(['--json'], { stdout: text => output += text }), 0);
    await assertJobIdentity(JSON.parse(output), expected, 'jobs --json (merged)', options);
  });
  await test('PTY survives SDK server exit and a different principal automatically adopts', async () => {
    const old = job.meta.principal.pid; await a.stop();
    await until(() => !mayBeAlive(old)); await until(() => !mayBeAlive(job.meta.server.pid));
    assert.ok(mayBeAlive(job.meta.worker.pid)); assert.ok(mayBeAlive(job.pid));
    b = await client(); assert.notEqual(b.transport.pid, old);
    const row = await until(async () => (await b.call('list_processes')).find(r => r.pid === job.pid && r.adopted));
    assert.equal(row.status, 'running'); assert.equal(row.jobId, job.jobId);
    const meta = json(join(job.dir, 'meta.json')); assert.equal(meta.principal.pid, b.transport.pid);
    assert.equal(meta.adoptedFrom[0].principal.pid, old);
    const result = await b.call('get_result', { pid: job.pid, verbose: true }); assert.equal(result.adopted, true);
  });
  await test('PTY kill_process writes killed true with failed 143 and terminates the tree', async () => {
    const tree = join(TEMP, 'descendant.txt'); const target = await dispatch(b, { delay: 60000, tree });
    await until(() => existsSync(tree)); const descendant = Number(readFileSync(tree, 'utf8'));
    const grandchild = (await lookupIdentities([descendant])).get(descendant);
    try {
      assert.equal((await b.call('kill_process', { pid: target.pid })).status, 'terminated');
      const exit = await exited(target); assert.equal(exit.killed, true); assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 143);
      await until(() => !mayBeAlive(descendant) && !mayBeAlive(target.meta.worker.pid));
      const result = await b.call('get_result', { pid: target.pid, verbose: true });
      assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 143);
      assert.match(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), /Process terminated by user/);
      // 與原 in-process 路徑共用 result shaper：有解析回覆時不另外回 raw stderr。
      assert.equal(result.stderr, undefined);
    } finally {
      // tree kill 突變會留下孫行程：只終止建立時間仍相符的那一個。
      if (grandchild?.started && mayBeAlive(descendant) && (await lookupIdentities([descendant])).get(descendant)?.started === grandchild.started) {
        await promisify(execFile)('taskkill.exe', ['/pid', String(descendant), '/f'], { windowsHide: true }).catch(() => {});
      }
    }
  });
  await test('PTY stdout strips split ANSI and get_result wait parse the response', async () => {
    const target = await dispatch(b); const [result] = await b.call('wait', { pids: [target.pid], timeout: 20, verbose: true });
    assertDurableStatus(result, 'completed', { name: 'pty-jobs', roots: [TEMP] }); assert.equal(result.agentOutput.message, 'PTY_PONG');
    const text = readFileSync(join(target.dir, 'stdout.log'), 'utf8'); assert.ok(text.includes('PTY_READY'));
    assert.ok(!text.includes('\x1b')); assert.ok(!text.includes('title')); assert.ok(!text.includes('31m'));
    assert.equal(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), '');
    assert.equal((await exited(target)).exitCode, 0);
  });
  await test('PTY nonzero exit fails and the runner naturally exits', async () => {
    const target = await dispatch(b, { code: 7 }); const exit = await exited(target);
    assert.equal(exit.exitCode, 7); assert.equal(exit.killed, false);
    assert.equal((await b.call('get_result', { pid: target.pid })).status, 'failed');
  });
  await test('PTY timeout records timedOut without killed and exits naturally', async () => {
    // needsShell=true 也必須直接交給 node-pty；argv 的 JSON 引號不可經 cmd 重新解讀。
    const target = await rawRunner({ pty: true, needsShell: true, timeoutMs: 500, args: [stub, JSON.stringify({ delay: 60000 })] });
    const exit = await exited(target); assert.equal(exit.timedOut, true); assert.equal(exit.killed, false);
    await until(() => !mayBeAlive(target.meta.worker.pid));
  });
  await test('PTY missing module and spawn failures write failed exit without fallback', async () => {
    const missing = join(TEMP, 'missing.exe');
    assert.throws(() => loadPtyModule().spawn(missing, [], { name: 'xterm-color', cols: 200, rows: 50, cwd: ROOT, env: buildWorkerEnv() }), /File not found:/);
    console.log('OBSERVED Windows missing command: synchronous throw (File not found)');
    const target = await rawRunner({ pty: true }, join(TEMP, 'missing.exe')); const exit = await exited(target);
    assert.equal(exit.exitCode, 1); assert.match(exit.error, /Worker spawn failed/); assert.equal(target.meta.worker, null);
    assert.match(readFileSync(join(target.dir, 'stderr.log'), 'utf8'), /Process error:/);
    const failedResult = await storedResult(target); assert.equal(failedResult.status, 'failed'); assert.match(failedResult.agentOutput.error, /File not found:/);
    const loadPreload = join(TEMP, 'missing-pty.cjs');
    writeFileSync(loadPreload, `const m=require('node:module'),load=m._load;m._load=function(id,...args){if(id==='@homebridge/node-pty-prebuilt-multiarch')throw Error('synthetic PTY load failure');return load.call(this,id,...args);};`);
    const old = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = `--require ${JSON.stringify(loadPreload)}`;
    try { const load = await rawRunner({ pty: true }); const result = await exited(load); assert.match(result.error, /synthetic PTY load failure/); assert.equal(load.meta.worker, null); }
    finally { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; }
  });
  await test('PTY rejects stdin prompt in store and old runner spec', async () => {
    const store = new JobStore(join(TEMP, 'stdin-store'), 'cli'); await store.ready;
    try { await assert.rejects(store.start({ ...buildStub({ cwd: ROOT, prompt: '{}' }), stdinPrompt: 'secret' }), /do not support stdinPrompt/); }
    finally { store.dispose(); }
    const target = await rawRunner({ pty: true, stdin: true }); const exit = await exited(target);
    assert.match(exit.error, /do not support stdinPrompt/); assert.equal(target.meta.worker, null);
  });
  await test('PTY absent RunnerSpec flag keeps old pipe behavior', async () => {
    const target = await rawRunner(); const exit = await exited(target);
    assert.equal(exit.exitCode, 0); assert.ok(target.meta.worker?.started);
    assert.ok(readFileSync(join(target.dir, 'stdout.log'), 'utf8').includes('\x1b[31m'));
  });
  await test('PTY CLI FileProcessService routes to JobStore and lists only once', async () => {
    getAgent('antigravity').buildCommand = buildStub;
    const service = new FileProcessService({ stateDir: state, cliPaths: { antigravity: process.execPath } });
    const start = await service.startProcess({ model: 'agy-default', prompt: JSON.stringify({ delay: 3000 }), cwd: ROOT });
    if (!start.jobId) await service.killProcess(start.pid);
    runners.add(start.pid); assert.ok(start.jobId);
    const dir = join(state, 'jobs', start.jobId), meta = json(join(dir, 'meta.json')); assert.ok(meta.worker?.started);
    await assertJobIdentity(await service.listProcesses(), { ...start, startTime: meta.startTime }, 'file listProcesses', {
      sources: async () => ({ file: (await service.listJobSummaries()).filter(r => r.pid === start.pid || r.jobId === start.jobId).map(r => ({
          jobId: r.jobId ?? null, pid: r.pid, status: r.status, startTime: r.startTime,
          agent: r.agent, origin: r.jobId ? 'file:jobs' : 'file:cwds', source: r.source,
        })) }),
    });
    const exit = await exited({ pid: start.pid, dir }); assert.equal(exit.exitCode, 0);
    assert.ok(!readFileSync(join(dir, 'stdout.log'), 'utf8').includes('\x1b'));
  });
} finally {
  getAgent('antigravity').buildCommand = originalBuilder;
  if (originalDirectExec === undefined) delete getAgent('antigravity').win32DirectExec;
  else getAgent('antigravity').win32DirectExec = originalDirectExec;
  // 只終止本測試啟動的 runner：透過已落盤身分的控制通道，不掃描其他 node/agy。
  if (existsSync(join(state, 'jobs'))) for (const id of readdirSync(join(state, 'jobs'))) {
    const dir = join(state, 'jobs', id); if (!existsSync(join(dir, 'meta.json'))) continue;
    const meta = json(join(dir, 'meta.json'));
    if (runners.has(meta.pid) && mayBeAlive(meta.pid)) atomicJson(join(dir, 'kill.json'), { runner: meta.runner });
  }
  for (const c of clients) await c.stop().catch(() => {});
  await until(() => [...runners].every(pid => !mayBeAlive(pid)), 20000).catch(e => { failed++; console.log('FAIL PTY cleanup\n' + e.stack); });
  // 生命週期突變刻意留下 handle：worker 已確認退出才清測試 runner，避免累積殘留。
  if (existsSync(join(state, 'jobs'))) for (const id of readdirSync(join(state, 'jobs'))) {
    const dir = join(state, 'jobs', id);
    if (!existsSync(join(dir, 'meta.json'))) continue;
    const meta = json(join(dir, 'meta.json')); if (!runners.has(meta.pid) || !mayBeAlive(meta.pid)) continue;
    const identities = await lookupIdentities([meta.pid, ...(meta.worker ? [meta.worker.pid] : [])]);
    if (identities.get(meta.pid)?.started !== meta.runner.started || meta.worker && mayBeAlive(meta.worker.pid)) continue;
    await promisify(execFile)('taskkill.exe', ['/pid', String(meta.pid), '/t', '/f'], { windowsHide: true });
  }
  if (!nativeFaultFailed && [...runners].every(pid => !mayBeAlive(pid))) rmSync(TEMP, { recursive: true, force: true });
  else console.log('PTY evidence retained: ' + TEMP);
}
console.log(`PTY jobs: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
