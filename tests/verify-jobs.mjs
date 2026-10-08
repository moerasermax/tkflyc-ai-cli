/** jobs 的 stub 回歸：不呼叫任何 vendor；狀態與設定完全隔離。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { LiveJobPublisher, readLiveJobs, lookupIdentities, taskSummary, shortText, JOB_RETENTION_MS } from '../dist/core/live-jobs.js';
import { ProcessService } from '../dist/core/process-service.js';
import { FileProcessService, flushJobIdentities } from '../dist/core/file-process-service.js';
import { getAgent } from '../dist/agents/registry.js';
import { formatJobsTable, displayWidth, runJobs, listJobs } from '../dist/app/jobs.js';
import { runCli, CLI_HELP_TEXT } from '../dist/app/cli.js';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'ai-cli-jobs-'));
process.env.AI_CLI_STATE_DIR = dir;
let passed = 0, failed = 0;
async function check(name, fn) {
  if (process.env.JOBS_TEST_FILTER && !name.includes(process.env.JOBS_TEST_FILTER)) return;
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.log(`FAIL ${name} — ${error.stack}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 10000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(25); } throw new Error('stub condition timed out'); }
const instant = Date.parse('2026-10-08T00:00:00Z');
const owner = { pid: 4242, started: 'original-creation', name: 'node' };
const dispatcher = { pid: 4242, started: owner.started, parentPid: 100, parentName: 'codex' };
const sample = (overrides = {}) => ({ pid: 99, agent: 'codex', model: 'stub-model', reasoning_effort: 'high',
  task: 'Inspect stub task', workFolder: '/stub', status: 'running', startTime: new Date(instant - 65000).toISOString(),
  elapsedSec: 65, sinceLastOutputSec: 1, lastEvent: 'stub progress', dispatcher, source: 'mcp', ...overrides });
const fakeLookup = async pids => new Map(pids.includes(owner.pid) ? [[owner.pid, owner]] : []);
let clock = instant;
let rows = [sample()];
const publisher = new LiveJobPublisher(dir, owner, () => clock);
publisher.setSource({}, () => rows);
try {
  await check('publish sanitized summary and schema', async () => {
    const snapshot = JSON.parse(readFileSync(publisher.filePath, 'utf8'));
    assert.equal(snapshot.version, 1); assert.deepEqual(snapshot.owner, owner);
    assert.equal(snapshot.jobs[0].dispatcher.parentName, 'codex'); assert.equal(snapshot.jobs[0].reasoning_effort, 'high');
    assert.ok(!('prompt' in snapshot.jobs[0]));
    assert.equal(taskSummary('\n---\n# Meaningful task\nsecret full prompt'), '# Meaningful task');
    assert.equal(Array.from(taskSummary('字'.repeat(60))).length, 40);
  });
  await check('throttle output refresh at two seconds', async () => {
    const before = readFileSync(publisher.filePath, 'utf8');
    rows = [sample({ lastEvent: 'next event' })]; clock += 1949;
    publisher.publish(); assert.equal(readFileSync(publisher.filePath, 'utf8'), before);
    clock += 50; publisher.publish(); assert.equal(JSON.parse(readFileSync(publisher.filePath)).jobs[0].lastEvent, 'next event');
  });
  await check('forced terminal update bypasses throttle', async () => {
    rows = [sample({ status: 'completed', endTime: new Date(clock).toISOString() })];
    publisher.publish(true); assert.equal(JSON.parse(readFileSync(publisher.filePath)).jobs[0].status, 'completed');
  });
  await check('terminal retention expires after ten minutes', async () => {
    assert.equal(JOB_RETENTION_MS, 600000);
    clock = instant; rows = [sample({ status: 'completed', endTime: new Date(clock).toISOString() })]; publisher.publish(true);
    clock += JOB_RETENTION_MS - 1; publisher.publish(true);
    assert.equal(JSON.parse(readFileSync(publisher.filePath)).jobs.length, 1);
    clock++; publisher.publish(true); assert.equal(JSON.parse(readFileSync(publisher.filePath)).jobs.length, 0);
  });
  await check('atomic snapshot keeps old target when rename fails', async () => {
    const atomicDir = join(dir, 'atomic'); const p = new LiveJobPublisher(atomicDir, owner, () => instant);
    mkdirSync(p.filePath, { recursive: true });
    writeFileSync(join(p.filePath, 'sentinel'), 'old target');
    const saved = console.error; console.error = () => {};
    try { p.setSource({}, () => [sample()]); } finally { console.error = saved; }
    assert.equal(readFileSync(join(p.filePath, 'sentinel'), 'utf8'), 'old target');
    assert.equal(existsSync(p.filePath + '.tmp'), false); p.dispose();
    // 另以 concurrent reader 驗原子可見性，見下面跨行程測試。
  });
  await check('atomic reader sees previous complete snapshot until rename', async () => {
    const fs = createRequire(import.meta.url)('node:fs'); const rename = fs.renameSync;
    const previous = readFileSync(publisher.filePath, 'utf8'); let commits = 0;
    fs.renameSync = (from, to) => {
      if (to === publisher.filePath) {
        commits++; assert.equal(readFileSync(to, 'utf8'), previous);
        assert.equal(JSON.parse(readFileSync(from, 'utf8')).version, 1);
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    try { publisher.publish(true); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(commits, 1);
  });
  await check('stale owner and PID reuse excluded without deleting', async () => {
    clock = instant; rows = [sample()]; publisher.publish(true);
    assert.equal((await readLiveJobs(dir, async () => new Map(), clock)).length, 0);
    assert.equal((await readLiveJobs(dir, async () => new Map([[owner.pid, { ...owner, started: 'reused-creation' }]]), clock)).length, 0);
    assert.equal(existsSync(publisher.filePath), true);
  });
  await check('matching creation identity accepted and timing extrapolated', async () => {
    const jobs = await readLiveJobs(dir, fakeLookup, clock + 4000);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].elapsedSec, 69); assert.equal(jobs[0].sinceLastOutputSec, 5);
    writeFileSync(join(dir, 'live-jobs', 'broken.json'), '{');
    writeFileSync(join(dir, 'live-jobs', 'partial.json.tmp'), '{');
    assert.equal((await readLiveJobs(dir, fakeLookup, clock)).length, 1);
  });
  await check('table statuses model effort elapsed dispatcher and narrow CJK', async () => {
    const table = formatJobsTable([sample(), sample({ status: 'completed' }), sample({ status: 'failed' }), sample({ status: 'lost' })], 200);
    assert.match(table, /AGENT\s{2,}MODEL/);
    for (const text of ['◐', '✓', '✗', '?', 'stub-model (high)', '1:05', 'codex+4242', 'stub progress']) assert.ok(table.includes(text), text);
    for (const width of [1, 20, 60, 100]) {
      const narrow = formatJobsTable([sample({ task: '中文'.repeat(40), lastEvent: '\x1b[31mhello\nworld' })], width);
      assert.ok(narrow.trimEnd().split('\n').every(line => displayWidth(line) < width || width === 1 && displayWidth(line) <= 1));
      assert.ok(!narrow.includes('\x1b')); assert.equal(narrow.trimEnd().split('\n').length, 2);
    }
  });
  await check('jobs json and running options select correct rows', async () => {
    let output = ''; const deps = { stdout: text => output += text, list: async () => [sample(), sample({ status: 'failed' })] };
    assert.equal(await runJobs(['--json'], deps), 0); assert.equal(JSON.parse(output).length, 2);
    output = ''; assert.equal(await runJobs(['--json', '--running'], deps), 0);
    assert.deepEqual(JSON.parse(output).map(job => job.status), ['running']);
    output = ''; await runJobs([], deps); assert.ok(output.includes('stub progress'));
    assert.equal(await runJobs(['--bogus'], { stderr: () => {} }), 1);
  });
  await check('watch repeats then Ctrl+C removes handlers', async () => {
    const before = process.listenerCount('SIGINT'); const output = []; const times = [];
    const code = await runJobs(['--watch'], { isTTY: () => true, list: async () => [sample()], stdout: text => {
      output.push(text); times.push(Date.now()); if (output.length === 2) process.emit('SIGINT');
    } });
    assert.equal(code, 0); assert.equal(output.length, 2); assert.ok(times[1] - times[0] >= 1900);
    assert.ok(output.every(text => text.startsWith('\x1b[2J\x1b[H')));
    assert.notEqual(output[0], output[1]); assert.equal(process.listenerCount('SIGINT'), before);
    let json = ''; await runJobs(['--watch', '--json'], { list: async () => [sample()], stdout: text => { json += text; process.emit('SIGINT'); } });
    assert.equal(JSON.parse(json).length, 1); assert.ok(!json.includes('\x1b'));
  });
  await check('publisher GC removes only expired proven stale owners', async () => {
    const state = join(dir, 'gc'), folder = join(state, 'live-jobs'); mkdirSync(folder, { recursive: true });
    const owners = new Map([[10, { pid: 10, started: 'alive', name: 'node' }], [11, { pid: 11, started: 'new', name: 'node' }]]);
    const alive = pid => pid === 10 || pid === 11 || pid === process.pid;
    const put = (name, pid, started, age) => writeFileSync(join(folder, name + '.json'), JSON.stringify({ version: 1, owner: { pid, started }, updatedAt: new Date(instant - age).toISOString(), jobs: [] }));
    put('alive', 10, 'alive', JOB_RETENTION_MS + 1); put('reused', 11, 'old', JOB_RETENTION_MS + 1);
    put('dead', 12, 'old', JOB_RETENTION_MS + 1); put('unknown', process.pid, 'unknown', JOB_RETENTION_MS + 1);
    put('recent', 12, 'old', JOB_RETENTION_MS); put('fresh', 11, 'old', 0);
    const p = new LiveJobPublisher(state, owner, () => instant, async () => owners, alive);
    try {
      await p.ready;
      for (const name of ['alive', 'unknown', 'recent', 'fresh']) assert.ok(existsSync(join(folder, name + '.json')), name);
      for (const name of ['reused', 'dead']) assert.equal(existsSync(join(folder, name + '.json')), false, name);
      put('changed', 11, 'old', JOB_RETENTION_MS + 1);
      const q = new LiveJobPublisher(state, owner, () => instant, async () => { put('changed', 11, 'old', 0); return owners; }, alive);
      await q.ready; q.dispose(); assert.ok(existsSync(join(folder, 'changed.json')));
    } finally { p.dispose(); }
  });
  await check('publisher GC retains expired unknown owner when alive returns true (EPERM)', async () => {
    const state = join(dir, 'gc-eperm'), folder = join(state, 'live-jobs'); mkdirSync(folder, { recursive: true });
    const path = join(folder, 'unknown.json'), calls = [];
    writeFileSync(path, JSON.stringify({ version: 1, owner: { pid: 12, started: 'unknown' }, updatedAt: new Date(instant - JOB_RETENTION_MS - 1).toISOString(), jobs: [] }));
    // 模擬 EPERM 的保守存活結果，不依賴真實系統上的 PID。
    const p = new LiveJobPublisher(state, owner, () => instant, async () => new Map(), pid => { calls.push(pid); return true; });
    try {
      await p.ready;
      assert.deepEqual(calls, [12]);
      assert.equal(existsSync(path), true, 'possibly alive owner must be retained');
    } finally { p.dispose(); }
  });
  await check('idle snapshots skip unchanged writes and still expire terminal jobs', async () => {
    let time = instant, jobs = [sample({ status: 'completed', endTime: new Date(instant).toISOString() })];
    const p = new LiveJobPublisher(join(dir, 'idle'), owner, () => time, fakeLookup);
    try {
      p.setSource({}, () => jobs); const before = readFileSync(p.filePath, 'utf8');
      time += 2000; p.publish(); assert.equal(readFileSync(p.filePath, 'utf8'), before);
      time += JOB_RETENTION_MS; p.publish(); assert.deepEqual(JSON.parse(readFileSync(p.filePath)).jobs, []);
      const empty = readFileSync(p.filePath, 'utf8'); time += 2000; p.publish(); assert.equal(readFileSync(p.filePath, 'utf8'), empty);
      jobs = [sample()]; time += 2000; p.publish(); const running = readFileSync(p.filePath, 'utf8');
      time += 1999; p.publish(); assert.notEqual(readFileSync(p.filePath, 'utf8'), running);
    } finally { p.dispose(); }
  });
  await check('write errors deduplicate and log recovery once', async () => {
    const fs = createRequire(import.meta.url)('node:fs'), rename = fs.renameSync, log = console.error;
    const p = new LiveJobPublisher(join(dir, 'errors'), owner, () => instant, fakeLookup), messages = [];
    console.error = text => messages.push(text);
    fs.renameSync = () => { throw Error('sharing violation'); }; syncBuiltinESMExports();
    try {
      p.setSource({}, () => [sample()]); p.publish(true); p.publish(true); assert.equal(messages.length, 1);
      fs.renameSync = () => { throw Error('different failure'); }; syncBuiltinESMExports(); p.publish(true); assert.equal(messages.length, 2);
      fs.renameSync = rename; syncBuiltinESMExports(); p.publish(true); p.publish(true);
      assert.equal(messages.length, 3); assert.match(messages[2], /recovered/);
    } finally { fs.renameSync = rename; syncBuiltinESMExports(); console.error = log; p.dispose(); }
  });
  await check('reader retries transient file errors without writes', async () => {
    const fs = createRequire(import.meta.url)('node:fs'), read = fs.readFileSync; let calls = 0;
    fs.readFileSync = (path, ...args) => {
      if (path === publisher.filePath && ++calls === 1) throw Object.assign(Error('rename gap'), { code: 'ENOENT' });
      return read(path, ...args);
    }; syncBuiltinESMExports();
    try { assert.equal((await readLiveJobs(dir, fakeLookup, clock)).length, 1); assert.equal(calls, 2); }
    finally { fs.readFileSync = read; syncBuiltinESMExports(); }
  });
  await check('OSC titles are removed with BEL and ST terminators', async () => {
    assert.equal(shortText('before\x1b]0;hidden title\x07after', 80), 'beforeafter');
    assert.equal(shortText('before\x1b]0;hidden title\x1b\\after', 80), 'beforeafter');
    assert.ok(!formatJobsTable([sample({ lastEvent: '\x1b]0;secret title\x07visible' })], 200).includes('secret title'));
  });
  await check('non TTY watch appends plain frames', async () => {
    let output = ''; await runJobs(['--watch'], { isTTY: () => false, list: async () => [sample()], stdout: text => { output += text; process.emit('SIGINT'); } });
    assert.ok(output.includes('AGENT')); assert.ok(!output.includes('\x1b'));
  });
  await check('MCP publication rejection resets promise and retries', async () => {
    const service = new ProcessService({ cliPaths: {} }), all = Promise.all; let calls = 0;
    Promise.all = () => ++calls === 1 ? Promise.reject(Error('stub failure')) : Promise.resolve([{ setSource() {} }, dispatcher]);
    try { service.publishJobs(); await sleep(0); assert.equal(service.publishing, undefined); service.publishJobs(); await sleep(0); assert.ok(service.publisher); assert.equal(calls, 2); }
    finally { Promise.all = all; }
  });
  await check('audit documentation describes excerpts and unverified CLI jobs', async () => {
    const en = readFileSync(join(ROOT, 'README.md'), 'utf8'), zh = readFileSync(join(ROOT, 'README.zh-TW.md'), 'utf8');
    assert.ok(en.includes('80-character') && en.includes('model response') && en.includes('identityVerified: false'));
    assert.ok(zh.includes('80 字') && zh.includes('模型回覆') && zh.includes('identityVerified: false'));
    const changes = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').split('## [6.6.1]')[0];
    assert.ok(changes.includes('依獨立稽核修正')); assert.ok(!changes.includes('依 worker 派工限制未進行'));
  });
  await check('worker jobs remains allowed and help advertises options', async () => {
    process.env.AI_CLI_WORKER = '1'; let output = '';
    try {
      assert.equal(await runCli(['jobs', '--json'], { stdout: text => output += text }), 0);
      assert.ok(Array.isArray(JSON.parse(output)));
      output = ''; await runCli(['jobs', '--help'], { stdout: text => output += text });
      for (const flag of ['--watch', '--json', '--running']) assert.ok(output.includes(flag));
      assert.ok(CLI_HELP_TEXT.includes('jobs'));
    } finally { delete process.env.AI_CLI_WORKER; }
  });
  await check('binary worker jobs preserves updater state and stdout JSON', async () => {
    const state = join(dir, 'readonly-bin'); const repo = join(dir, 'fake-source-install');
    mkdirSync(state, { recursive: true }); mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.git'), 'stub marker'); writeFileSync(join(repo, 'package.json'), '{}');
    const update = join(state, 'update.json'); const trace = join(dir, 'readonly-git-trace'); const preload = join(dir, 'readonly-preload.mjs');
    const before = JSON.stringify({ notice: 'keep this notice', lastApplied: { at: 'stub', from: 'old', to: 'stub-head', ok: true, commits: [], message: 'stub' } });
    writeFileSync(update, before);
    writeFileSync(preload, `import{createRequire,syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';import{PassThrough}from'node:stream';import{appendFileSync}from'node:fs';
const cp=createRequire(import.meta.url)('node:child_process'),original=cp.spawn;
cp.spawn=(binary,...args)=>{if(binary!=='git')return original(binary,...args);appendFileSync(${JSON.stringify(trace)},'git called');const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setImmediate(()=>{child.stdout.end('stub-head\\n');child.stderr.end();child.emit('close',0);});return child;};syncBuiltinESMExports();`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, join(ROOT, 'dist/bin/ai-cli.js'), 'jobs', '--json'], {
      env: { ...process.env, AI_CLI_WORKER: '1', AI_CLI_STATE_DIR: state, AI_CLI_UPDATE_REPO_ROOT: repo }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 0, errors); assert.deepEqual(JSON.parse(output), []);
    assert.equal(readFileSync(update, 'utf8'), before); assert.equal(existsSync(trace), false);
  });
  await check('actual OS creation identity and nonexistent PID', async () => {
    const first = (await lookupIdentities([process.pid])).get(process.pid);
    const second = (await lookupIdentities([process.pid])).get(process.pid);
    assert.ok(first?.started); assert.equal(first.started, second.started); assert.ok(first.name);
    assert.equal((await lookupIdentities([2147483647])).size, 0);
  });
  await check('POSIX creation token uses stable UTC across session timezones', async () => {
    const probe = join(dir, 'posix-identity.mjs');
    writeFileSync(probe, `import{createRequire,syncBuiltinESMExports}from'node:module';import{promisify}from'node:util';import assert from'node:assert/strict';
Object.defineProperty(process,'platform',{value:'darwin'});
const cp=createRequire(import.meta.url)('node:child_process');const stub=()=>{throw Error('unexpected callback form');};
stub[promisify.custom]=async(binary,args,options)=>{assert.equal(binary,'ps');assert.equal(options.env.LC_ALL,'C');assert.equal(options.env.TZ,'UTC');return{stdout:'123 1 Thu Oct  8 00:00:00 2026 /usr/bin/codex\\n'};};
cp.execFile=stub;syncBuiltinESMExports();const{lookupIdentities}=await import(${JSON.stringify(pathToFileURL(join(ROOT, 'dist/core/live-jobs.js')).href)});
process.env.TZ='Asia/Taipei';const a=(await lookupIdentities([123])).get(123);process.env.TZ='America/New_York';const b=(await lookupIdentities([123])).get(123);console.log(JSON.stringify([a,b]));`);
    const child = spawn(process.execPath, [probe], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
    const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0, errors);
    const [a, b] = JSON.parse(output); assert.equal(a?.started, 'Thu Oct  8 00:00:00 2026'); assert.deepEqual(a, b); assert.equal(a.name, 'codex');
  });
  await check('POSIX partial nonzero ps preserves live owners', async () => {
    const probe = join(dir, 'partial-ps.mjs');
    writeFileSync(probe, `import{createRequire,syncBuiltinESMExports}from'node:module';import{promisify}from'node:util';import assert from'node:assert/strict';
Object.defineProperty(process,'platform',{value:'darwin'});
const cp=createRequire(import.meta.url)('node:child_process');const stub=()=>{throw Error('unexpected callback');};let empty=false;
stub[promisify.custom]=async(binary,args)=>{assert.equal(binary,'ps');assert.equal(args[1],'123,999999');throw Object.assign(Error('exit 1'),{code:1,stdout:empty?undefined:'123 1 Thu Oct  8 00:00:00 2026 /usr/bin/codex\\n'});};cp.execFile=stub;syncBuiltinESMExports();
const{lookupIdentities}=await import(${JSON.stringify(pathToFileURL(join(ROOT, 'dist/core/live-jobs.js')).href)});
const ids=await lookupIdentities([123,999999]);assert.equal(ids.size,1);assert.equal(ids.get(123).name,'codex');empty=true;assert.equal((await lookupIdentities([123,999999])).size,0);`);
    const child = spawn(process.execPath, [probe], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => errors += data); child.stdout.resume();
    assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, errors);
  });
  await check('CLI missing creation token remains running and unverified', async () => {
    const state = join(dir, 'unverified'), folder = join(state, 'cwds', 'stub', String(process.pid)); mkdirSync(folder, { recursive: true });
    const meta = join(folder, 'meta.json'), stdout = join(folder, 'stdout.log'), stderr = join(folder, 'stderr.log');
    const stored = { pid: process.pid, prompt: 'Unverified task', toolType: 'claude', workFolder: dir, cwdKey: 'stub',
      status: 'running', startTime: new Date().toISOString(), dispatcher, stdoutPath: stdout, stderrPath: stderr };
    writeFileSync(meta, JSON.stringify(stored)); writeFileSync(stdout, ''); writeFileSync(stderr, ''); const before = readFileSync(meta, 'utf8');
    const reader = new FileProcessService({ stateDir: state, cliPaths: {}, readOnly: true });
    for (const lookup of [async () => new Map([[process.pid, { pid: process.pid, started: 'known', name: 'stub' }]]), async () => new Map()]) {
      const job = (await reader.listJobSummaries(lookup))[0]; assert.equal(job.status, 'running'); assert.equal(job.identityVerified, false);
      assert.ok(formatJobsTable([job], 300).includes('[unverified]')); assert.equal(job.dispatcher.parentName, dispatcher.parentName);
    }
    assert.equal(readFileSync(meta, 'utf8'), before);
  });
  await check('CLI identity batching caches dispatcher without blocking PID', async () => {
    const cp = createRequire(import.meta.url)('node:child_process'), originalSpawn = cp.spawn;
    const agent = getAgent('claude'), build = agent.buildCommand, platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const state = join(dir, 'async-identities'), calls = [], resolvers = []; let pid = 54320;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    cp.spawn = () => ({ pid: ++pid, unref() {} }); syncBuiltinESMExports();
    agent.buildCommand = input => ({ cliPath: process.execPath, args: [], cwd: input.cwd, agent: 'claude', prompt: input.prompt });
    const service = new FileProcessService({ stateDir: state, cliPaths: {}, identityLookup: pids => { calls.push(pids); return new Promise(resolve => resolvers.push(resolve)); } });
    try {
      const start = await Promise.race([service.startProcess({ cwd: dir, model: 'claude', prompt: 'Async first' }), sleep(500).then(() => { throw Error('PID blocked on lookup'); })]);
      assert.deepEqual(calls[0], [start.pid, process.pid, process.ppid]);
      const key = readdirSync(join(state, 'cwds'))[0], meta = join(state, 'cwds', key, String(start.pid), 'meta.json');
      const before = JSON.parse(readFileSync(meta)); assert.equal(before.processStarted, undefined);
      before.status = 'completed'; before.endTime = new Date().toISOString(); writeFileSync(meta, JSON.stringify(before));
      resolvers[0](new Map([[start.pid, { pid: start.pid, started: 'child' }], [process.pid, { started: 'dispatcher' }], [process.ppid, { name: 'shell' }]])); await flushJobIdentities();
      const updated = JSON.parse(readFileSync(meta)); assert.equal(updated.status, 'completed'); assert.equal(updated.processStarted, 'child'); assert.equal(updated.dispatcher.parentName, 'shell');
      const second = await service.startProcess({ cwd: dir, model: 'claude', prompt: 'Async second' }); assert.deepEqual(calls[1], [second.pid]);
      const secondMeta = join(state, 'cwds', key, String(second.pid), 'meta.json'); rmSync(secondMeta);
      resolvers[1](new Map([[second.pid, { started: 'second' }]])); await flushJobIdentities(); assert.equal(existsSync(secondMeta), false);
      assert.equal(calls.length, 2);
    } finally { for (const resolve of resolvers) resolve(new Map()); await flushJobIdentities(); cp.spawn = originalSpawn; syncBuiltinESMExports(); agent.buildCommand = build; Object.defineProperty(process, 'platform', platform); }
  });
  await check('binary run flushes PID before identity persistence and exit', async () => {
    const state = join(dir, 'binary-run'), preload = join(dir, 'run-preload.mjs'), trace = join(dir, 'run-query.json');
    writeFileSync(preload, `import{createRequire,syncBuiltinESMExports}from'node:module';import{promisify}from'node:util';import{writeFileSync}from'node:fs';
Object.defineProperty(process,'platform',{value:'win32'});
const cp=createRequire(import.meta.url)('node:child_process');let queries=0;
const stub=()=>{throw Error('callback not expected');};stub[promisify.custom]=async()=>{queries++;await new Promise(r=>setTimeout(r,800));writeFileSync(${JSON.stringify(trace)},JSON.stringify({queries,at:Date.now()}));return{stdout:JSON.stringify([{pid:54321,started:'child',name:'stub'},{pid:process.pid,started:'launcher',name:'node'},{pid:process.ppid,started:'parent',name:'shell'}])};};
cp.execFile=stub;cp.spawn=()=>({pid:54321,unref(){}});syncBuiltinESMExports();
const{getAgent}=await import(${JSON.stringify(pathToFileURL(join(ROOT, 'dist/agents/registry.js')).href)});
getAgent('claude').buildCommand=input=>({cliPath:process.execPath,args:[],cwd:input.cwd,agent:'claude',prompt:input.prompt});`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, join(ROOT, 'dist/bin/ai-cli.js'), 'run', '--cwd', dir, '--model', 'claude', '--prompt', 'Binary stub'],
      { env: { ...process.env, AI_CLI_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', firstAt; const done = new Promise(resolve => child.once('close', resolve));
    child.stdout.on('data', data => { firstAt ??= Date.now(); output += data; }); child.stderr.on('data', data => errors += data);
    assert.equal(await done, 0, errors); assert.equal(JSON.parse(output).pid, 54321);
    const query = JSON.parse(readFileSync(trace)); assert.equal(query.queries, 1); assert.ok(query.at - firstAt >= 500, 'PID must precede slow lookup completion');
    const key = readdirSync(join(state, 'cwds'))[0], stored = JSON.parse(readFileSync(join(state, 'cwds', key, '54321', 'meta.json')));
    assert.equal(stored.processStarted, 'child'); assert.equal(stored.dispatcher.started, 'launcher');
  });

  const fixture = join(dir, 'publisher.mjs');
  const liveUrl = pathToFileURL(join(ROOT, 'dist/core/live-jobs.js')).href;
  writeFileSync(fixture, `import {LiveJobPublisher,lookupIdentities} from ${JSON.stringify(liveUrl)};
const owner=(await lookupIdentities([process.pid])).get(process.pid);
const publisher=new LiveJobPublisher(process.argv[2],owner);
let event=0; publisher.setSource({},()=>[${JSON.stringify(sample())}].map(job=>({...job,pid:process.pid,dispatcher:{pid:process.pid,parentPid:process.ppid},startTime:new Date().toISOString(),lastEvent:'stub '+event++})));
const timer=setInterval(()=>publisher.publish(true),10);
console.log(publisher.filePath);
process.stdin.resume(); process.stdin.on('data',data=>{clearInterval(timer);if(data.toString().trim()==='crash')process.abort();else{process.stdin.destroy();}});
`);
  function fixtureChild(state) {
    const child = spawn(process.execPath, [fixture, state], { env: { ...process.env, AI_CLI_AUTO_UPDATE: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.done = new Promise(resolve => child.once('close', resolve));
    child.path = new Promise(resolve => child.stdout.once('data', data => resolve(data.toString().trim())));
    child.stderr.resume(); return child;
  }
  await check('aggregate two OS processes and concurrent atomic reads', async () => {
    const shared = join(dir, 'shared'); const a = fixtureChild(shared), b = fixtureChild(shared);
    try {
      const paths = await Promise.all([a.path, b.path]);
      const jobs = await readLiveJobs(shared); assert.deepEqual(jobs.map(job => job.pid).sort(), [a.pid, b.pid].sort());
      for (let i = 0; i < 40; i++) { for (const path of paths) assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1); await sleep(2); }
      a.stdin.end('stop'); await a.done; assert.equal(existsSync(paths[0]), false);
      assert.equal((await readLiveJobs(shared)).length, 1);
      // 異常退出殘檔以 OS 身分失效略過（不對 node 行程送 kill）。
      b.stdin.end('crash'); await b.done;
      assert.equal(existsSync(paths[1]), true); assert.equal((await readLiveJobs(shared)).length, 0);
    } finally { for (const child of [a, b]) if (child.exitCode === null && child.signalCode === null) child.stdin.end('stop'); await Promise.all([a.done, b.done]); }
  });

  await check('MCP stub publishes start output terminal and cleanup', async () => {
    const agent = getAgent('claude'); const original = agent.buildCommand;
    const vendor = join(dir, 'vendor.mjs'); writeFileSync(vendor, `console.log(JSON.stringify({type:'tool_use',name:'stub progress'}));setTimeout(()=>process.exit(0),2400);`);
    agent.buildCommand = input => ({ cliPath: process.execPath, args: [vendor], cwd: input.cwd, agent: 'claude', prompt: input.prompt, resolvedModel: 'stub-resolved' });
    try {
      const service = new ProcessService({ cliPaths: { claude: '', codex: '', antigravity: '' } });
      const started = service.startProcess({ prompt: '\nInspect stub task\nSECRET SECOND LINE', workFolder: dir, model: 'claude', reasoning_effort: 'high' });
      const find = async () => (await readLiveJobs(dir)).find(job => job.pid === started.pid);
      const first = await until(find); assert.equal(first.status, 'running'); assert.equal(first.task, 'Inspect stub task');
      assert.equal(first.model, 'stub-resolved'); assert.equal(first.reasoning_effort, 'high');
      assert.ok(!JSON.stringify(first).includes('SECRET SECOND LINE'));
      await until(async () => (await find())?.lastEvent?.includes('stub progress'));
      await service.waitForProcesses([started.pid], 10);
      const terminal = await find(); assert.equal(terminal.status, 'completed');
      assert.ok(terminal.endTime); const elapsed = terminal.elapsedSec; await sleep(50);
      assert.equal((await find()).elapsedSec, elapsed);
      service.cleanupProcesses(); assert.equal(await find(), undefined);
      writeFileSync(vendor, 'setTimeout(()=>process.exit(7),100);');
      const failedStart = service.startProcess({ prompt: 'Failed stub task', workFolder: dir, model: 'claude' });
      await service.waitForProcesses([failedStart.pid], 10);
      // 不等 OS 查詢，以免兩秒 timer 補寫後掩蓋「close 沒立即發佈」的錯誤。
      const immediate = JSON.parse(readFileSync(service.publisher.filePath, 'utf8')).jobs.find(job => job.pid === failedStart.pid);
      assert.equal(immediate.status, 'failed');
      const failedJob = (await readLiveJobs(dir)).find(job => job.pid === failedStart.pid);
      assert.equal(failedJob.status, 'failed'); assert.ok(failedJob.endTime);
      service.cleanupProcesses(); assert.ok(!(await readLiveJobs(dir)).some(job => job.pid === failedStart.pid));
    } finally { agent.buildCommand = original; }
  });

  await check('CLI detached stub included after launcher and readonly projection', async () => {
    const agent = getAgent('claude'); const original = agent.buildCommand;
    const vendor = join(dir, 'file-vendor.mjs'); writeFileSync(vendor, `console.log(JSON.stringify({type:'result',result:'file stub progress'}));setTimeout(()=>process.exit(0),1400);`);
    agent.buildCommand = input => ({ cliPath: process.execPath, args: [vendor], cwd: input.cwd, agent: 'claude', prompt: input.prompt, resolvedModel: 'file-resolved' });
    try {
      const service = new FileProcessService({ stateDir: dir, cliPaths: {} });
      const start = await service.startProcess({ cwd: dir, model: 'claude', reasoning_effort: 'medium', prompt: 'File stub task\nSECRET FILE PROMPT' });
      const live = (await listJobs()).find(job => job.pid === start.pid);
      assert.ok(live); assert.equal(live.model, 'file-resolved'); assert.equal(live.reasoning_effort, 'medium'); assert.equal(live.source, 'cli');
      const key = readdirSync(join(dir, 'cwds'))[0]; const meta = join(dir, 'cwds', key, String(start.pid), 'meta.json');
      const before = readFileSync(meta, 'utf8');
      await service.waitForProcesses([start.pid], 10); // 已有 CLI 寫端更新，讀端以後應保持內容不變。
      const afterWait = readFileSync(meta, 'utf8');
      const terminal = (await listJobs()).find(job => job.pid === start.pid);
      assert.equal(terminal.status, 'completed'); assert.equal(terminal.lastEvent, 'result');
      assert.equal(readFileSync(meta, 'utf8'), afterWait);
      // 偽造還在 running 的舊 meta，PID 身分不同要 lost，且不可寫回。
      const fake = JSON.parse(before); fake.processStarted = 'reused-pid'; writeFileSync(meta, JSON.stringify(fake));
      const exit = join(dirname(meta), 'exit-status.json'); const exitData = readFileSync(exit); rmSync(exit);
      const readonly = new FileProcessService({ stateDir: dir, cliPaths: {}, readOnly: true });
      const projected = await readonly.listJobSummaries(async () => new Map([[start.pid, { pid: start.pid, started: 'different', name: 'stub' }]]));
      assert.equal(projected.find(job => job.pid === start.pid).status, 'lost');
      assert.equal(readFileSync(meta, 'utf8'), JSON.stringify(fake)); writeFileSync(exit, exitData);
      await service.cleanupProcesses();
    } finally { agent.buildCommand = original; }
    const absent = join(dir, 'never-created'); await new FileProcessService({ stateDir: absent, cliPaths: {}, readOnly: true }).listJobSummaries();
    assert.equal(existsSync(absent), false);
  });
  await check('CLI job survives real launcher exit with dispatcher identity', async () => {
    const state = join(dir, 'launcher'); const launch = join(dir, 'launcher.mjs'); const vendor = join(dir, 'launch-vendor.mjs');
    writeFileSync(vendor, `console.log(JSON.stringify({type:'tool_use',name:'detached stub'}));setTimeout(()=>process.exit(0),4500);`);
    writeFileSync(launch, `import{FileProcessService}from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist/core/file-process-service.js')).href)};
import{getAgent}from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist/agents/registry.js')).href)};
getAgent('claude').buildCommand=input=>({cliPath:process.execPath,args:[${JSON.stringify(vendor)}],cwd:input.cwd,agent:'claude',prompt:input.prompt,resolvedModel:'launcher-stub'});
console.log(JSON.stringify(await new FileProcessService({stateDir:${JSON.stringify(state)},cliPaths:{}}).startProcess({cwd:${JSON.stringify(dir)},model:'claude',prompt:'Launcher stub'})));
await (await import(${JSON.stringify(pathToFileURL(join(ROOT, 'dist/core/file-process-service.js')).href)})).flushJobIdentities();
`);
    const child = spawn(process.execPath, [launch], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
    const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0, errors);
    const start = JSON.parse(output); const service = new FileProcessService({ stateDir: state, cliPaths: {}, readOnly: true });
    const running = (await service.listJobSummaries()).find(job => job.pid === start.pid);
    assert.equal(running.status, 'running'); assert.equal(running.dispatcher.pid, child.pid); assert.ok(running.dispatcher.started);
    assert.equal((await lookupIdentities([child.pid])).size, 0);
    await until(async () => (await service.listJobSummaries()).find(job => job.pid === start.pid)?.status === 'completed');
  });
  await check('CLI reused directory resets cached output identity', async () => {
    const state = join(dir, 'cache-state'), folder = join(state, 'cwds', 'stub', '123'); mkdirSync(folder, { recursive: true });
    const meta = join(folder, 'meta.json'), stdout = join(folder, 'stdout.log'), stderr = join(folder, 'stderr.log');
    const stored = { pid: 123, prompt: 'Cache stub', toolType: 'claude', workFolder: dir, cwdKey: 'stub',
      model: 'stub', status: 'running', startTime: new Date(instant).toISOString(), processStarted: 'first', dispatcher,
      stdoutPath: stdout, stderrPath: stderr };
    const emit = name => JSON.stringify({ type: 'tool_use', name }) + '\n';
    writeFileSync(meta, JSON.stringify(stored)); writeFileSync(stdout, emit('tool-A')); writeFileSync(stderr, '');
    const reader = new FileProcessService({ stateDir: state, cliPaths: {}, readOnly: true });
    let identities = new Map([[123, { pid: 123, name: 'stub', started: 'first' }]]);
    assert.equal((await reader.listJobSummaries(async () => identities))[0].lastEvent, 'tool_use tool-A');
    stored.startTime = new Date(instant + 1000).toISOString(); stored.processStarted = 'second';
    writeFileSync(meta, JSON.stringify(stored)); writeFileSync(stdout, emit('tool-B'));
    identities = new Map([[123, { pid: 123, name: 'stub', started: 'second' }]]);
    assert.equal((await reader.listJobSummaries(async () => identities))[0].lastEvent, 'tool_use tool-B');
  });
  await check('dispose removes owner snapshot and timer', async () => {
    publisher.dispose(); assert.equal(existsSync(publisher.filePath), false);
    publisher.publish(true); assert.equal(existsSync(publisher.filePath), false);
  });
  if (process.argv.includes('--examples')) {
    const jobs = [sample(), sample({ pid: 100, status: 'completed', task: 'Completed stub', endTime: new Date(instant).toISOString() }), sample({ pid: 101, status: 'failed', task: 'Failed stub', endTime: new Date(instant).toISOString() })];
    for (const args of [[], ['--running'], ['--json'], ['--watch'], ['--watch', '--json']]) {
      console.log(`EXAMPLE ai-cli jobs ${args.join(' ')}`);
      await runJobs(args, { list: async () => jobs, columns: () => 160, stdout: text => { process.stdout.write(text); if (args.includes('--watch')) process.emit('SIGINT'); } });
    }
  }
} finally { publisher.dispose(); rmSync(dir, { recursive: true, force: true }); }
console.log(`jobs: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
