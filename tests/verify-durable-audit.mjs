/** 第四部分稽核回歸；故障注入與啟動鏈全用 stub，M1 只啟動自己的 Node stub。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { runJob, verifiedTermination } from '../dist/core/job-runner.js';
import { JobStore, atomicJson, collectStoreFiles, removeJobDirectory, jobResult, VERBOSE_MAX_BYTES, STARTUP_GRACE_MS, mayBeAlive } from '../dist/core/job-store.js';
import { lookupIdentities, LiveJobPublisher } from '../dist/core/live-jobs.js';
import { resolvePrincipal, isPackageLauncher } from '../dist/core/principal.js';
import { FileProcessService } from '../dist/core/file-process-service.js';
import { grokAgent } from '../dist/agents/grok.js';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-audit-'));
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.log('FAIL ' + name + '\n' + error.stack); } }
const self = { pid: process.pid, started: 'self', name: 'node' }, parent = { pid: process.ppid, started: 'parent', name: 'claude' };
const meta = (id, extras = {}) => ({ version: 1, jobId: id, pid: process.pid, runner: self, worker: null, server: self, principal: parent,
  agent: 'codex', resolvedModel: 'stub', source: 'cli', task: 'summary', workFolder: ROOT, recoverable: true, startTime: new Date().toISOString(), ...extras });
function directory(state = TEMP) { const id = randomUUID(), dir = join(state, 'jobs', id); mkdirSync(dir, { recursive: true }); return { id, dir }; }
function launch(dir, base, args = []) { atomicJson(join(dir, 'launch.tmp'), { command: process.execPath, args, cwd: ROOT, stdin: true, needsShell: false, meta: base, serverPid: process.pid, principalPid: process.ppid }); writeFileSync(join(dir, 'stdin.tmp'), 'complete secret prompt'); }
try {
await test('H1 identity failure retries then fails before worker spawn', async () => {
  const { id, dir } = directory(), marker = join(dir, 'worker-started');
  launch(dir, meta(id), ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`]);
  let calls = 0; const delays = [];
  await runJob(dir, { lookup: async () => { calls++; return new Map(); }, pause: async ms => delays.push(ms) });
  assert.equal(calls, 3); assert.deepEqual(delays, [250, 500]);
  assert.equal(existsSync(marker), false); assert.equal(existsSync(join(dir, 'stdin.tmp')), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'meta.json'))).worker, null);
  assert.match(JSON.parse(readFileSync(join(dir, 'exit.json'))).error, /worker was not started/);
  const store = new JobStore(TEMP, 'cli', true); await store.ready; assert.equal(store.get(process.pid, id).status, 'failed'); store.dispose();
});
await test('H1 startup without meta stops reporting running after grace', async () => {
  const state = join(TEMP, 'startup'), { id, dir } = directory(state);
  atomicJson(join(dir, 'bootstrap.json'), meta(id, { runner: { ...self, started: '' }, startTime: new Date(Date.now() - STARTUP_GRACE_MS - 1).toISOString() }));
  const store = new JobStore(state, 'cli', true); await store.ready;
  assert.equal(store.get(process.pid).status, 'lost'); assert.match(jobResult(store.get(process.pid)).agentOutput.error, /metadata unavailable/); store.dispose();
});
await test('H2 identity lookup failure remains retryable and does not mark killed', async () => {
  let calls = 0, sends = 0, marked = false;
  const terminate = verifiedTermination(self, async () => new Map(++calls === 1 ? [] : [[self.pid, self]]), async () => { sends++; return true; }, () => true);
  marked = await terminate(); assert.equal(marked, false); assert.equal(sends, 0);
  marked = await terminate(); assert.equal(marked, true); assert.equal(sends, 1);
  const mismatch = verifiedTermination(self, async () => new Map([[self.pid, { ...self, started: 'reused' }]]), async () => { throw Error('must never kill reused PID'); });
  assert.equal(await mismatch(), false); assert.equal(await mismatch(), false);
  const throws = verifiedTermination(self, async () => { if (++calls === 3) throw Error('CIM timeout'); return new Map([[self.pid, self]]); }, async () => true);
  await assert.rejects(throws(), /timeout/); assert.equal(await throws(), true);
});
await test('M1 meta write failure stops newly spawned stub and persists error', async () => {
  const { id, dir } = directory(); let workerPid;
  launch(dir, meta(id), ['-e', 'setInterval(()=>{},1000)']);
  const lookup = async pids => { const ids = await lookupIdentities(pids); for (const pid of pids) if (pid !== process.pid && pid !== process.ppid) workerPid = pid; return ids; };
  await runJob(dir, { lookup, save: (path, value) => { if (path.endsWith('meta.json')) throw Error('EACCES injected'); atomicJson(path, value); } });
  assert(workerPid); assert.equal(mayBeAlive(workerPid), false);
  assert.match(JSON.parse(readFileSync(join(dir, 'exit.json'))).error, /EACCES injected/); assert(!existsSync(join(dir, 'stdin.tmp')));
});
await test('H2 failed timeout verification retries and normal exit keeps both flags false', async () => {
  const { id, dir } = directory(); let lookups = 0;
  launch(dir, meta(id), ['-e', 'setTimeout(()=>process.exit(0),1500)']);
  const spec = JSON.parse(readFileSync(join(dir, 'launch.tmp'))); spec.timeoutMs = 50; atomicJson(join(dir, 'launch.tmp'), spec);
  await runJob(dir, { lookup: async pids => ++lookups <= 2 ? new Map(pids.map(pid => [pid, pid === process.pid ? self : { pid, started: 'own-stub', name: 'node' }])) : new Map() });
  const exit = JSON.parse(readFileSync(join(dir, 'exit.json')));
  assert(lookups > 3, 'timeout lookup must retry'); assert.equal(exit.exitCode, 0); assert.equal(exit.killed, false); assert.equal(exit.timedOut, false);
});
await test('M2 GC retries deleting directories and leaves fresh startup alone', async () => {
  const state = join(TEMP, 'orphan'), fresh = directory(state), old = directory(state), deleting = join(state, 'jobs', randomUUID() + '.deleting'); mkdirSync(deleting); writeFileSync(join(deleting, 'stdout.log'), 'locked before retry');
  utimesSync(old.dir, new Date(0), new Date(0));
  await collectStoreFiles(state);
  assert(existsSync(fresh.dir)); assert(!existsSync(old.dir)); assert(!existsSync(deleting));
  const locked = directory(state); writeFileSync(join(locked.dir, 'meta.json'), '{}');
  const fs = createRequire(import.meta.url)('node:fs'), original = fs.rmSync;
  fs.rmSync = (path, ...args) => { if (String(path) === locked.dir + '.deleting') throw Error('EBUSY injected'); return original(path, ...args); }; syncBuiltinESMExports();
  try { assert(removeJobDirectory(locked.dir)); assert(!existsSync(locked.dir)); assert(existsSync(locked.dir + '.deleting')); }
  finally { fs.rmSync = original; syncBuiltinESMExports(); }
  await collectStoreFiles(state); assert(!existsSync(locked.dir + '.deleting'));
});
await test('M3 verbose raw output capped at eight MiB with byte truncation', async () => {
  const state = join(TEMP, 'verbose'), { id, dir } = directory(state);
  atomicJson(join(dir, 'meta.json'), meta(id)); atomicJson(join(dir, 'exit.json'), { exitCode: 0, signal: null, endTime: new Date().toISOString(), killed: false, timedOut: false });
  writeFileSync(join(dir, 'stdout.log'), 'a'.repeat(VERBOSE_MAX_BYTES + 100));
  const store = new JobStore(state, 'cli', true); await store.ready; const result = jobResult(store.get(process.pid), true);
  assert.equal(result.stdout.length, VERBOSE_MAX_BYTES); assert.equal(result.stdoutTruncated.totalBytes, VERBOSE_MAX_BYTES + 100); store.dispose();
});
await test('M4 missing principal retries on next check and recovers jobs', async () => {
  const state = join(TEMP, 'identify'), { id, dir } = directory(state); let available = false;
  atomicJson(join(dir, 'meta.json'), meta(id, { source: 'mcp' })); atomicJson(join(dir, 'exit.json'), { exitCode: 0, signal: null, endTime: new Date().toISOString(), killed: false, timedOut: false });
  const store = new JobStore(state, 'mcp', true, async () => available ? new Map([[self.pid, self], [parent.pid, parent]]) : new Map());
  await store.ready; assert.equal(store.jobs.size, 0); available = true; store.checkedAt = -Infinity; await store.check(); assert.equal(store.jobs.size, 1); store.dispose();
});
await test('M4 unavailable script shell command retries and reports principal on stderr', async () => {
  const state = join(TEMP, 'script-identify'); let available = false, queries = 0;
  const messages = [], originalError = console.error;
  const lookup = async pids => { queries++; return new Map(pids.flatMap(pid => {
    if (pid === self.pid) return [[pid, self]];
    if (pid === parent.pid) return [[pid, { ...parent, name: 'cmd.exe', commandLine: available ? 'cmd.exe /c echo stub' : '' }]];
    return [];
  })); };
  console.error = (...args) => messages.push(args.join(' '));
  let store;
  try {
    store = new JobStore(state, 'mcp', true, lookup); await store.ready;
    assert.equal(store.principal, null); assert(messages.some(m => m.includes('cannot identify principal; retrying on next check')));
    const before = queries; available = true; store.checkedAt = -Infinity; await store.check();
    assert(queries > before); assert.equal(store.principal.pid, parent.pid);
    assert.equal(await resolvePrincipal(parent.pid, async () => new Map()), null);
  } finally { store?.dispose(); console.error = originalError; }
});
await test('M5 skips exact npx launchers and retains node principal', async () => {
  const cases = [
    ['direct node', [{ name: 'claude', commandLine: 'claude' }]],
    ['Windows npx', [{ name: 'node.exe', commandLine: 'node "C:\\npm\\npx-cli.js" -y @tkflyc/ai-cli-mcp' }, { name: 'cmd.exe', commandLine: 'cmd.exe /d /s /c ""C:\\npm\\npx.cmd" -y @tkflyc/ai-cli-mcp"' }, { name: 'claude.exe', commandLine: 'claude' }]],
    ['Windows npx path with spaces', [{ name: 'node.exe', commandLine: 'node "C:\\Program Files\\nodejs\\npx-cli.js" -y @tkflyc/ai-cli-mcp' }, { name: 'cmd.exe', commandLine: 'cmd.exe /d /s /c ""C:\\Program Files\\nodejs\\npx.cmd" -y @tkflyc/ai-cli-mcp"' }, { name: 'node.exe', commandLine: 'node "C:\\Claude Code\\cli.js"' }]],
    ['POSIX npx', [{ name: 'node', commandLine: '/usr/bin/node /usr/lib/npm/bin/npx-cli.js -y @tkflyc/ai-cli-mcp' }, { name: 'sh', commandLine: 'sh -c "npx -y @tkflyc/ai-cli-mcp"' }, { name: 'claude', commandLine: 'claude' }]],
    ['npm exec / node principal', [{ name: 'node', commandLine: 'node /npm/bin/npm-cli.js exec -- @tkflyc/ai-cli-mcp' }, { name: 'sh', commandLine: 'sh -c "npm exec -- @tkflyc/ai-cli-mcp"' }, { name: 'node', commandLine: 'node /node_modules/@anthropic-ai/claude-code/cli.js' }]],
    ['direct node principal', [{ name: 'node.exe', commandLine: 'node.exe C:\\claude-code\\cli.js' }]],
    ['POSIX npm exec child shell', [{ name: 'sh', commandLine: 'sh -c ai-cli-mcp' }, { name: 'node', commandLine: 'node /npm/bin/npx-cli.js -y @tkflyc/ai-cli-mcp' }, { name: 'node', commandLine: 'node /claude-code/cli.js' }]],
    ['Windows npm exec child cmd', [{ name: 'cmd.exe', commandLine: 'cmd.exe /d /s /c "ai-cli-mcp"' }, { name: 'node.exe', commandLine: 'node.exe C:\\npm\\npm-cli.js exec -- @tkflyc/ai-cli-mcp' }, { name: 'claude.exe', commandLine: 'claude' }]],
    ['unrelated shell invoking package', [{ name: 'sh', commandLine: 'sh -c ai-cli-mcp' }]],
    ['Windows npm run script shell to snapshot bash', [{ name: 'cmd.exe', commandLine: 'cmd.exe /d /s /c "node tools/acceptance/worker-identity.mjs"' }, { name: 'node.exe', commandLine: 'node "C:\\npm\\npm-cli.js" run verify:worker-identity' }, { name: 'bash.exe', commandLine: 'bash.exe -c "source /shell-snapshots/long-command; npm run verify:worker-identity"' }]],
    ['POSIX npm test script shell', [{ name: 'sh', commandLine: 'sh -c "node tests/stub.mjs"' }, { name: 'node', commandLine: 'node /npm/bin/npm-cli.js test' }, { name: 'claude', commandLine: 'claude' }]],
    ['Windows npm run shell launcher', [{ name: 'bash.exe', commandLine: 'bash.exe -c "npm run verify:worker-identity"' }, { name: 'claude.exe', commandLine: 'claude' }]],
    ['unrelated node script shell', [{ name: 'cmd.exe', commandLine: 'cmd.exe /c node script.mjs' }]],
  ];
  for (const [name, chain] of cases) {
    const rows = chain.map((item, index) => ({ ...item, pid: 100 + index, ppid: 101 + index, started: name + index }));
    const principal = await resolvePrincipal(100, async pids => new Map(pids.flatMap(pid => rows.filter(row => row.pid === pid).map(row => [pid, row]))));
    assert.equal(principal.pid, rows.at(-1).pid, name); assert.equal(principal.commandLine, undefined);
    console.log('PRINCIPAL ' + name + ': ' + principal.pid + '/' + principal.name);
  }
  assert(!isPackageLauncher({ ...self, commandLine: 'node /npm-cli.js install package' }));
  assert(!isPackageLauncher({ ...self, name: 'sh', commandLine: 'sh -c "echo npx"' }));
  assert(!isPackageLauncher({ ...self, name: 'cmd.exe', commandLine: 'cmd.exe /c echo C:\\npm\\npx.cmd' }));
  assert(isPackageLauncher({ ...self, name: 'sh', commandLine: 'sh -c \'exec "/path with spaces/npx" -y @tkflyc/ai-cli-mcp\'' }));
  assert.equal(await resolvePrincipal(100, async () => new Map()), null);
  assert.equal(await resolvePrincipal(100, async () => new Map([[100, { ...self, pid: 100 }]])), null);
});
await test('M7 metadata handshake timeout returns started pid jobId warning', async () => {
  const now = Date.now, fakeJob = { pid: 12345, meta: { jobId: 'already-launched' }, directory: join(TEMP, 'no-meta') };
  const service = Object.create(FileProcessService.prototype);
  service.store = { ready: Promise.resolve(), identify: async () => {}, start: () => fakeJob, get: () => fakeJob };
  let time = 0; Date.now = () => time += 16_000;
  try { const result = await service.startDetachedTracked({ agent: 'codex' }); assert.equal(result.pid, fakeJob.pid); assert.equal(result.jobId, fakeJob.meta.jobId); assert.equal(result.status, 'started'); assert.match(result.warnings[0], /do not redispatch/); }
  finally { Date.now = now; }
});
await test('L1 all non-success Grok results fail with explicit error', () => {
  for (const subtype of ['error_max_turns', 'error_during_execution', 'unknown', undefined]) {
    const parsed = grokAgent.parseOutput(JSON.stringify({ type: 'result', subtype, result: 'partial answer' }), ''); assert.equal(parsed.is_error, true); assert.match(parsed.error, /Grok execution failed/);
  }
});
await test('L3 Grok prompt is moved into job and GC removes it', async () => {
  const state = join(TEMP, 'grok-prompt'), store = new JobStore(state); await store.ready;
  const command = grokAgent.buildCommand({ cliPath: process.execPath, cwd: ROOT, prompt: 'secret', resolvedModel: 'grok-stub', reasoningEffort: 'medium' });
  const staging = command.temporaryPromptFile; command.args = ['-e', 'process.exit(0)', ...command.args]; // Node would reject vendor args; only a stub exit is needed.
  command.args = ['-e', 'process.exit(0)', '--', staging];
  const job = store.start(command); await store.wait([job.pid], 15);
  assert(!existsSync(staging)); assert.equal(readFileSync(join(job.directory, 'prompt.txt'), 'utf8'), 'secret'); store.collect(Date.now(), true); assert(!existsSync(job.directory)); assert.equal(store.owned.size, 0); store.dispose();
});
await test('L4 checks own server only and shares cached identities with GC', async () => {
  const state = join(TEMP, 'cache'), a = directory(state), b = directory(state); let calls = 0;
  atomicJson(join(a.dir, 'meta.json'), meta(a.id, { source: 'mcp' }));
  atomicJson(join(b.dir, 'meta.json'), meta(b.id, { source: 'mcp', pid: parent.pid, server: { ...self, started: 'other-server' }, runner: parent }));
  const store = new JobStore(state, 'mcp', false, async pids => { calls++; return new Map(pids.flatMap(pid => [self, parent].filter(id => id.pid === pid).map(id => [pid, id]))); });
  await store.ready; const before = calls, now = Date.now; let clock = now();
  Date.now = () => clock;
  try {
    for (let i = 0; i < 60; i++) { clock += 2000; store.checkedAt = -Infinity; await store.check(); if ((i + 1) % 30 === 0) await store.collectAll(); }
    assert.equal(calls - before, 2); assert.equal(store.identities.has(parent.pid), true);
    console.log('L4_LOOKUPS ' + JSON.stringify({ minutes: 2, before: 120, after: calls - before, excludesStartupAndDispatch: true }));
  } finally { Date.now = now; store.dispose(); }
});
await test('M5 command lines never enter monitoring snapshots', async () => {
  const state = join(TEMP, 'privacy'), publisher = new LiveJobPublisher(state, { ...self, commandLine: 'node ai-cli run --prompt private-secret' }, Date.now, async () => new Map());
  await publisher.ready; publisher.setSource({}, () => []);
  assert(!readFileSync(publisher.filePath, 'utf8').includes('private-secret')); publisher.dispose();
});
} finally { rmSync(TEMP, { recursive: true, force: true }); }
console.log(`durable-audit: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
