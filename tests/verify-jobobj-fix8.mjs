import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicJson, JobStore, readJobExit } from '../dist/core/job-store.js';
import { WinJobClient } from '../dist/core/win-job-client.js';
import { powershell, nativeScript, ContainmentTransportError } from '../dist/core/win-job-broker.js';
import { readContainment } from '../dist/core/containment-store.js';
import { WIN_JOB_NATIVE } from '../dist/core/win-job-native.js';
import { preserveDurableFailure, assertDurableStatus } from './helpers/durable-failure-evidence.mjs';
fs.mkdirSync('.tmp', { recursive: true });
const root = fs.mkdtempSync(resolve('.tmp/fix8-fixture-'));
console.log('EVIDENCE ' + root);
let failed = 0;
async function test(name, fn) {
  if (process.env.FIX8_TEST_FILTER && !name.includes(process.env.FIX8_TEST_FILTER)) return;
  try { await fn(); console.log('PASS ' + name); }
  catch (e) { failed++; preserveDurableFailure({ name, result: { error: e.stack }, roots: [root] }); console.log('FAIL ' + name + '\n' + e.stack); }
}
await test('FIX8 atomic rename retries transient errors and preserves destination on exhaustion', () => {
  const rename = fs.renameSync, path = join(root, 'atomic.json');
  try {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      let calls = 0; fs.renameSync = (...args) => { if (++calls === 1) throw Object.assign(Error(code), { code }); return rename(...args); }; syncBuiltinESMExports();
      atomicJson(path, { code }); assert.equal(calls, 2); assert.deepEqual(JSON.parse(fs.readFileSync(path)), { code });
    }
    const before = fs.readFileSync(path, 'utf8'); let calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(Error('FIX8 persistent rename'), { code: 'EPERM' }); }; syncBuiltinESMExports();
    const started = performance.now(); assert.throws(() => atomicJson(path, { replaced: true }), /FIX8 persistent rename/);
    assert.ok(calls > 1 && calls <= 8); assert.ok(performance.now() - started < 1000); assert.equal(fs.readFileSync(path, 'utf8'), before);
    assert.equal(fs.readdirSync(root).filter(f => f.startsWith('atomic.json.')).length, 0);
    calls = 0; fs.renameSync = () => { calls++; throw Object.assign(Error('FIX8 permanent rename'), { code: 'ENOENT' }); }; syncBuiltinESMExports();
    assert.throws(() => atomicJson(path, {}), /FIX8 permanent rename/); assert.equal(calls, 1);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
});
await test('FIX8 failure record overrides old broker killed result without drained proof', () => {
  const dir = join(root, 'old-broker'); fs.mkdirSync(dir);
  const failure = { exitCode: 1, signal: null, endTime: new Date().toISOString(), killed: false, timedOut: false, error: 'FIX8 original diagnostic' };
  fs.writeFileSync(join(dir, 'runner-error.json'), JSON.stringify(failure));
  fs.writeFileSync(join(dir, 'exit.json'), JSON.stringify({ ...failure, exitCode: 143, killed: true, error: undefined }));
  assert.deepEqual(readJobExit(dir), failure); assert.equal(fs.existsSync(join(dir, 'containment-status.json')), false);
  fs.writeFileSync(join(dir, 'runner-error.json'), '{"exitCode":1,"error":"incomplete"}');
  assert.equal(readJobExit(dir).exitCode, 143, 'invalid diagnostic is not a result');
});
async function fixture(mode) {
  const state = join(root, mode), store = new JobStore(state); await store.ready;
  const previous = { node: process.env.NODE_OPTIONS, fault: process.env.FIX8_REGISTER_FAULT };
  let job;
  try {
    process.env.NODE_OPTIONS = '--import ' + JSON.stringify(pathToFileURL(resolve('tests/helpers/fix8-register-preload.mjs')).href);
    process.env.FIX8_REGISTER_FAULT = mode;
    job = await store.start({ cliPath: process.execPath, args: [resolve('tools/stubs/durable-agent.mjs'), 'claude'], cwd: root, agent: 'claude', prompt: '{}', stdinPrompt: '{}', resolvedModel: 'fixture' });
  } finally {
    if (previous.node === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.node;
    if (previous.fault === undefined) delete process.env.FIX8_REGISTER_FAULT; else process.env.FIX8_REGISTER_FAULT = previous.fault;
  }
  try {
    const [result] = await store.wait([job.pid], 40);
    // A failure becomes readable before terminate by design. Wait for the trace
    // rather than treating that intentional publication order as missing cleanup.
    if (!['once', 'lost-once'].includes(mode)) {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        try { if (fs.readFileSync(join(job.directory, 'fix8-trace.jsonl'), 'utf8').includes('"termination":true')) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const trace = fs.readFileSync(join(job.directory, 'fix8-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const requests = trace.filter(x => x.attempt);
    assert.equal(new Set(requests.map(x => x.requestId)).size, mode === 'outer' ? 0 : 1, 'same requestId across bridge restarts');
    assert.equal(new Set(requests.map(x => x.hash)).size, mode === 'outer' ? 0 : 1, 'same complete request payload');
    if (mode === 'once' || mode === 'lost-once') {
      assertDurableStatus(result, 'completed', { name: mode, roots: [root] }); assert.equal(requests.length, 2);
      assert.match(result.agentOutput.message, /PONG/);
      if (mode === 'lost-once') assert.equal(trace.filter(x => x.realReplyReady).length, 1, 'first READY really assigned by broker');
    } else {
      assertDurableStatus(result, 'failed', { name: mode, roots: [root] }); assert.equal(result.exitCode, 1); assert.notEqual(result.exitCode, 143);
      const error = readJobExit(job.directory);
      assert.equal(error.killed, false); assert.match(result.agentOutput.error, mode === 'outer' ? /original launch read failure/ : /Containment READY failed/);
      assert.doesNotMatch(fs.readFileSync(join(job.directory, 'stderr.log'), 'utf8'), /terminated by user/);
      assert.ok(trace.some(x => x.termination && x.saved?.exitCode === 1 && x.stderr.includes('Process error:')), 'original reason was durable before terminate');
      assert.equal(requests.length, mode === 'always' || mode.startsWith('lost-always') ? 3 : mode === 'outer' ? 0 : 1);
      if (mode.startsWith('lost-always')) assert.equal(trace.filter(x => x.realReplyReady).length, 3, 'broker replayed READY for the assigned runner');
    }
  } finally {
    try {
    const client = new WinJobClient(), ref = job.meta.containment;
    if (ref) {
      let status = await client.inspect(ref);
      if (status.state !== 'drained') status = await client.terminate(ref);
      assert.equal(status.state, 'drained', 'owned fixture drained');
      if (mode === 'lost-always-rename') {
        const exit = JSON.parse(fs.readFileSync(join(job.directory, 'exit.json'), 'utf8'));
        assert.equal(exit.exitCode, 1, 'broker preserves independent failure when exit rename fails');
        assert.match(exit.error, /Containment READY failed/);
        assert.doesNotMatch(fs.readFileSync(join(job.directory, 'stderr.log'), 'utf8'), /terminated by user/);
      }
    }
    } finally {
      store.dispose();
      const path = join(job.directory, 'fix8-trace.jsonl');
      const runner = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.runner)?.runner : undefined;
      if (runner) {
        let evidence;
        const until = Date.now() + 10000;
        do {
          evidence = JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${runner.pid},'${runner.started}')`)));
          if (evidence.state === 'dead') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < until);
        if (evidence.state === 'alive') await powershell(nativeScript(`[AiCliContainment]::StopFixture(${runner.pid},'${runner.started}')`));
        assert.equal(evidence.state, 'dead', 'owned runner exits after containment cleanup (exact PID/birth)');
      }
    }
  }
}
if (process.platform === 'win32') {
  await test('FIX8 launcher and pre-launch failure persist cause before terminate', async () => {
    for (const mode of ['launcher', 'spec']) {
      const store = new JobStore(join(root, 'prestart-' + mode)); await store.ready;
      const spawn = cp.spawn, write = fs.writeFileSync, terminate = WinJobClient.prototype.terminate, observations = [];
      try {
        cp.spawn = function(file, args, options) { if (args?.[0]?.endsWith('job-launcher.js')) throw Error('FIX8 launcher original failure'); return spawn(file, args, { ...options, windowsHide: true }); };
        if (mode === 'spec') fs.writeFileSync = function(path, ...args) { if (String(path).includes('launch.tmp.')) throw Error('FIX8 spec original failure'); return write(path, ...args); };
        WinJobClient.prototype.terminate = async function(ref, reason) {
          const dir = readContainment(ref, this.config)?.resultDirectory;
          observations.push({ directory: dir, failure: dir ? readJobExit(dir) : undefined });
          return terminate.call(this, ref, reason);
        };
        syncBuiltinESMExports();
        await assert.rejects(store.start({ cliPath: process.execPath, args: [], cwd: root, agent: 'claude', prompt: '{}', resolvedModel: 'fixture' }), new RegExp('FIX8 '+mode+' original failure'));
        assert.ok(observations.length > 0);
        for (const item of observations) { assert.equal(item.failure?.exitCode, 1); assert.match(item.failure.error, new RegExp('FIX8 '+mode+' original failure')); }
      } finally { cp.spawn = spawn; fs.writeFileSync = write; WinJobClient.prototype.terminate = terminate; syncBuiltinESMExports(); store.dispose(); }
    }
  });
  await test('FIX8 transport tags retry while validation and policy errors stay permanent', async () => {
    await assert.rejects(powershell("throw 'containment-transport: pipe-I/O: injected EOF'"), ContainmentTransportError);
    for (const reason of ['broker identity lost', 'Native containment assembly load refused']) {
      try { await powershell("throw '" + reason + "'"); assert.fail('expected failure'); }
      catch (e) { assert.equal(e instanceof ContainmentTransportError, false); assert.match(e.message, new RegExp(reason)); }
    }
  });
  await test('FIX8 register transient bridge failure retries and completes', () => fixture('once'));
  await test('FIX8 register lost reply replays assigned runner without duplicate assignment', () => fixture('lost-once'));
  await test('FIX8 register exhaustion records original reason before terminate', () => fixture('always'));
  await test('FIX8 assigned runner persists reason before self termination', () => fixture('lost-always'));
  await test('FIX8 failed exit rename preserves original reason through broker publication', () => fixture('lost-always-rename'));
  await test('FIX8 broker rejection and READY mismatch are never retried', async () => { await fixture('reject'); await fixture('identity'); });
  await test('FIX8 outer runner failure persists reason before terminate', () => fixture('outer'));
  await test('FIX8 pipe busy retries before write and stays bounded', async () => {
    // Compile the real OpenPipe algorithm with a first-call Win32 failure shim.
    // Successful reconnect and WaitNamedPipe both use a real local named pipe.
    const prefix = 'Fix8Pipe' + randomUUID().replaceAll('-', '');
    let source = WIN_JOB_NATIVE.replaceAll('AiCliContainment', prefix);
    const injection = `
  [DllImport("kernel32.dll",SetLastError=true)] static extern void SetLastError(uint error);
  static int Opens, Waits, Mode;
  static IntPtr FaultOpen(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template) {
    Opens++; if(Mode==1 || (Mode==0 && Opens==1) || Mode==2) { SetLastError(Mode==2?5u:231u); return new IntPtr(-1); }
    return CreateFileW(name,access,share,security,creation,flags,template);
  }
  static bool FaultWait(string name,uint timeout) { Waits++; if(Mode==1) { Thread.Sleep(20);SetLastError(121);return false; } return WaitNamedPipeW(name,timeout); }
  public static string Exercise() {
    string name="fix8-pipe-"+Guid.NewGuid().ToString();
    using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous)) {
      var pending=pipe.BeginWaitForConnection(null,null);
      IntPtr h=OpenPipe(name); pipe.EndWaitForConnection(pending);CloseHandle(h);
      Require(Opens==2 && Waits==1,"busy retry was not exercised");
    }
    Mode=1;Opens=0;Waits=0;var clock=Stopwatch.StartNew();bool refused=false;
    try { OpenPipe(name); } catch(IOException) { refused=true; }
    Require(refused && Opens>1 && Opens<=200 && clock.ElapsedMilliseconds<6000,"busy budget failed");
    Mode=2;Opens=0;Waits=0;refused=false;
    try { OpenPipe(name); } catch(Win32Exception) { refused=true; }
    Require(refused && Opens==1 && Waits==0,"access denied retried");
    return "pipe-busy-behavior-ok";
  }
`;
    source = source.replace('static IntPtr OpenPipe(string name) {', injection + '\n  static IntPtr OpenPipe(string name) {');
    source = source.replace('IntPtr raw=CreateFileW(@', 'IntPtr raw=FaultOpen(@').replace('if(!WaitNamedPipeW(@', 'if(!FaultWait(@');
    const answer = await powershell(`Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'\n${source}\n'@\n[${prefix}]::Exercise()`);
    assert.equal(answer, 'pipe-busy-behavior-ok');
  });
}
await test('FIX8 durable evidence preserves result and files before cleanup', () => {
  const mutation = process.env.AI_CLI_MUTATION_TEST; delete process.env.AI_CLI_MUTATION_TEST;
  try {
  const fixtureRoot = join(root, 'evidence'), jobId = randomUUID(), jobs = join(fixtureRoot, 'jobs', jobId), registry = join(fixtureRoot, 'containment'), cache = join(fixtureRoot, 'ai-cli-windowless-fixture');
  for (const dir of [jobs, registry, cache]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(jobs, 'stderr.log'), 'FIX8 reason tail'); fs.writeFileSync(join(jobs, 'exit.json'), '{"exitCode":1}');
  fs.writeFileSync(join(registry, 'broker.json'), '{}'); fs.writeFileSync(join(registry, jobId + '.json'), '{}');
  fs.writeFileSync(join(cache, 'broker-fixture.error.log'), 'TkflycAiCliContainmentBroker-test-fixture bridge diagnostic'); fs.writeFileSync(join(cache, 'fixture.host-error'), 'TkflycAiCliContainmentBroker-test-fixture host diagnostic');
  const result = { status: 'failed', exitCode: 1, agentOutput: { error: 'FIX8 original reason' } };
  const target = preserveDurableFailure({ name: 'FIX8-evidence', result, roots: [fixtureRoot], config: { name: 'TkflycAiCliContainmentBroker-test-fixture', directory: registry }, cacheRoot: fixtureRoot, destination: join(root, 'saved-evidence') });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(target, 'failure.json'))).result, result);
  assert.equal(fs.readFileSync(join(target, '0-' + jobId, 'stderr.log'), 'utf8'), 'FIX8 reason tail');
  for (const name of ['broker.json', jobId + '.json']) assert.ok(fs.existsSync(join(target, 'containment', name)));
  for (const name of ['broker-fixture.error.log', 'fixture.host-error']) assert.ok(fs.existsSync(join(target, 'windowless', 'ai-cli-windowless-fixture', name)));
  } finally { if(mutation===undefined)delete process.env.AI_CLI_MUTATION_TEST;else process.env.AI_CLI_MUTATION_TEST=mutation; }
});
console.log('FIX8: ' + failed + ' failed'); process.exitCode = failed ? 1 : 0;

if(!failed)try{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}catch(e){console.warn('Fixture cleanup deferred: '+root+' '+e.message);}
