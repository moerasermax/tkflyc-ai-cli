import { assertDurableStatus, preserveDurableFailure } from './helpers/durable-failure-evidence.mjs';
/** 接管回歸：注入 OS 身分與存活資料，不啟動任何 AI CLI，也不接觸正式 job store。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore, atomicJson, autoAdoptSwitchOn, currentHomeDir, GC_INTERVAL_MS, inAutoAdoptScope, jobResult, listAdoptCandidates, readJobMetas, RETENTION_MS } from '../dist/core/job-store.js';
import { ProcessService } from '../dist/core/process-service.js';
import { runCli } from '../dist/app/cli.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const temp = mkdtempSync(join(tmpdir(), 'ai-cli-adopt-'));
const originalAutoAdopt = process.env.AI_CLI_AUTO_ADOPT;
delete process.env.AI_CLI_AUTO_ADOPT;
// ppid 0：祖先鏈到此確定結束（不在 worker 底下）；缺 ppid 會被判成無法確認而停用自動接管。
const ownPrincipal = { pid: process.ppid, started: 'own-principal', name: 'test-principal', ppid: 0 };
const ownServer = { pid: process.pid, started: 'own-server', name: 'test-server' };
const rows = new Map([[ownPrincipal.pid, ownPrincipal], [ownServer.pid, ownServer]]);
const alive = new Set();
let nextPid = 900000;
const id = (name, live = false) => {
  const identity = { pid: ++nextPid, started: name, name };
  if (live) { alive.add(identity.pid); rows.set(identity.pid, identity); }
  return identity;
};
const realKill = process.kill;
process.kill = function (pid, signal) {
  if (pid > 900000 && pid < 910000) {
    assert.equal(signal, 0, 'fake processes must never receive termination signals');
    if (alive.has(pid)) return true;
    throw Object.assign(new Error('synthetic process is absent'), { code: 'ESRCH' });
  }
  return realKill.call(process, pid, signal);
};
const lookup = async pids => new Map(pids.filter(pid => rows.has(pid)).map(pid => [pid, rows.get(pid)]));
const stores = [];
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; preserveDurableFailure({name, result: { assertionError: String(error) }, roots: [temp]}); console.log('FAIL ' + name + '\n' + error.stack); }
}
function fixture(dir, options = {}) {
  const jobId = randomUUID(), runner = options.runner ?? id('runner', true);
  const meta = { version: 1, jobId, pid: runner.pid, agent: 'codex', model: 'fixture-model', resolvedModel: 'fixture-model',
    task: 'task summary for adoption', workFolder: ROOT, startTime: new Date().toISOString(), source: 'mcp',
    principal: id('original-principal'), server: id('original-server'), runner, worker: id('worker', true), recoverable: true,
    ...options.meta };
  const directory = join(dir, 'jobs', jobId); mkdirSync(directory, { recursive: true });
  const path = join(directory, 'meta.json');
  atomicJson(options.bootstrap ? join(directory, 'bootstrap.json') : path, meta);
  if (options.exitCode !== undefined) atomicJson(join(directory, 'exit.json'), { exitCode: options.exitCode, signal: null,
    endTime: new Date().toISOString(), timedOut: false, killed: false });
  writeFileSync(join(directory, 'stdout.log'), ''); writeFileSync(join(directory, 'stderr.log'), '');
  return { meta, directory, path, lock: join(directory, 'adopt.lock') };
}
const contents = path => readFileSync(path, 'utf8');
const metaOf = f => JSON.parse(contents(f.path));
function snapshot(directory) { return Object.fromEntries(readdirSync(directory).map(name => [name, contents(join(directory, name))])); }
async function store(dir, customLookup = lookup, source = 'mcp', principal = ownPrincipal, server = ownServer) {
  const result = new JobStore(dir, source, true, customLookup); stores.push(result); await result.ready;
  // 不依賴主機祖先鏈；每個模擬 MCP 的完整身分由測資決定。
  result.principal = principal; result.server = server; result.scan();
  return result;
}
function caseDir() { const dir = join(temp, randomUUID()); mkdirSync(dir); return dir; }
async function automaticStore(dir, { projectDir = ROOT, useCwd = false, principal = ownPrincipal, server = ownServer, customLookup = lookup, source = 'mcp', readOnly = false } = {}) {
  const identities = async pids => {
    const found = await customLookup(pids.filter(pid => pid !== process.pid && pid !== process.ppid));
    if (pids.includes(process.pid)) found.set(process.pid, server);
    if (pids.includes(process.ppid)) found.set(process.ppid, { ppid: 0, ...principal });
    return found;
  };
  // 啟動那一輪接管在 ready 之後背景進行；等它的完成點，不靠 sleep。
  const s = new JobStore(dir, source, readOnly, identities, useCwd ? undefined : projectDir); stores.push(s); await s.ready; await s.autoAdoptSettled; return s;
}
async function gcCycle(s) { s.collectedAt = -Infinity; s.checkedAt = -Infinity; await s.check(undefined, true); await s.gcPass(); }
function processService(s) { const ps = Object.create(ProcessService.prototype); ps.store = s; ps.processManager = new Map(); ps.ready = s.ready; return ps; }

try {
  await test('adopt rejects a live original principal without changing metadata', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { principal: id('live-principal', true) } });
    const s = await store(dir), before = contents(f.path);
    await assert.rejects(s.adopt(f.meta.pid), /still alive/);
    assert.equal(contents(f.path), before); assert(!existsSync(f.lock));
  });
  await test('adopt transfers dead principal and exposes adopted results immediately', async () => {
    const dir = caseDir(), f = fixture(dir, { exitCode: 0 });
    // bootstrap/exit/log 都必須原封不動；接管只能變 meta。
    atomicJson(join(f.directory, 'bootstrap.json'), f.meta);
    const before = snapshot(f.directory), s = await store(dir);
    const ps = Object.create(ProcessService.prototype); ps.store = s; ps.processManager = new Map(); ps.ready = s.ready;
    const result = await ps.adopt(f.meta.pid, f.meta.jobId);
    assert.equal(result.adopted, true);
    assert.deepEqual(metaOf(f).principal, ownPrincipal); assert.deepEqual(metaOf(f).server, ownServer);
    assert.deepEqual(metaOf(f).adoptedFrom[0].principal, f.meta.principal);
    assert.deepEqual(metaOf(f).adoptedFrom[0].server, f.meta.server);
    assert(Number.isFinite(Date.parse(metaOf(f).adoptedFrom[0].adoptedAt)));
    assert.equal(s.list()[0].adopted, true); assert.equal(ps.listProcesses()[0].adopted, true);
    assert.equal(ps.getProcessResult(f.meta.pid).adopted, true);
    assert.equal(ps.getProcessResult(f.meta.pid).adoptedFrom, undefined);
    assert.deepEqual(ps.getProcessResult(f.meta.pid, true).adoptedFrom, metaOf(f).adoptedFrom);
    assertDurableStatus((await ps.waitForProcesses([f.meta.pid], 1))[0], 'completed', {name:'adopt',roots:[temp]});
    assertDurableStatus((await ps.peekProcesses([f.meta.pid], 1)).processes[0], 'completed', {name:'adopt',roots:[temp]});
    if(process.platform==='win32')assert.equal((await ps.killProcess(f.meta.pid)).containment,'unknown');else assertDurableStatus((await ps.killProcess(f.meta.pid)), 'completed', {name:'adopt',roots:[temp]});
    for (const [name, value] of Object.entries(before)) if (name !== 'meta.json') assert.equal(contents(join(f.directory, name)), value);
    assert(!existsSync(f.lock));
    const restarted = await store(dir); assert.equal(restarted.list()[0].adopted, true);
  });
  await test('adopt permits PID reuse with a different creation identity', async () => {
    const dir = caseDir(), principal = id('reused-principal', true), f = fixture(dir, { meta: { principal } });
    rows.set(principal.pid, { ...principal, started: 'new-process' });
    const s = await store(dir); assert.equal((await s.adopt(undefined, f.meta.jobId)).adopted, true);
  });
  await test('adopt fails closed when original principal identity is unavailable', async () => {
    for (const mode of ['throw', 'missing', 'empty-started']) {
      const dir = caseDir(), principal = id('unknown-principal', true), f = fixture(dir, { meta: { principal } });
      const s = await store(dir, async pids => {
        if (pids.includes(principal.pid)) {
          if (mode === 'throw') throw Error('OS query failure');
          return mode === 'missing' ? new Map() : new Map([[principal.pid, { ...principal, started: '' }]]);
        }
        return lookup(pids);
      });
      const before = contents(f.path);
      await assert.rejects(s.adopt(f.meta.pid), /無法確認原派工者已結束/);
      assert.equal(contents(f.path), before); assert(!existsSync(f.lock));
      assert.deepEqual(await s.adopt(), []);
    }
  });
  await test('adopt refuses bootstrap-only and unfinished runner metadata', async () => {
    for (const bootstrap of [true, false]) {
      const dir = caseDir(), f = fixture(dir, { bootstrap, ...(bootstrap ? {} : { meta: { runner: { pid: nextPid + 1, started: '', name: 'runner' } } }) });
      const s = await store(dir), before = snapshot(f.directory);
      await assert.rejects(s.adopt(f.meta.pid), /bootstrap-only/);
      assert.deepEqual(snapshot(f.directory), before);
    }
  });
  await test('adopt already-owned response leaves files unchanged', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { principal: ownPrincipal, server: ownServer } }), s = await store(dir);
    const before = snapshot(f.directory), mtime = statSync(f.path).mtimeMs;
    assert.equal((await s.adopt(f.meta.pid)).alreadyOwned, true);
    assert.deepEqual(snapshot(f.directory), before); assert.equal(statSync(f.path).mtimeMs, mtime);
  });
  await test('adopt rejects unknown receiving principal or server', async () => {
    for (const missing of ['principal', 'server']) {
      const dir = caseDir(), f = fixture(dir), s = await store(dir); s[missing] = null;
      const before = snapshot(f.directory);
      await assert.rejects(s.adopt(f.meta.pid), new RegExp(missing + ' identity is unknown'));
      await assert.rejects(s.adopt(), new RegExp(missing + ' identity is unknown'));
      assert.deepEqual(snapshot(f.directory), before);
    }
  });
  await test('adopt rejects every existing lock without deleting or retrying', async () => {
    const live = id('lock-holder', true), dead = id('dead-lock-holder');
    for (const lockText of [JSON.stringify({ principal: live, createdAt: 'live-time' }), JSON.stringify({ principal: dead, createdAt: 'dead-time' }), 'not JSON', 'null', '']) {
      const dir = caseDir(), f = fixture(dir), s = await store(dir);
      writeFileSync(f.lock, lockText); const before = snapshot(f.directory);
      await assert.rejects(s.adopt(f.meta.pid), error => {
        assert(error.message.includes(f.lock)); assert.match(error.message, /另一個 session 可能正在接管/); assert.match(error.message, /持續存在.*才手動刪除/);
        const parsed = (() => { try { return JSON.parse(lockText); } catch { return null; } })();
        assert(error.message.includes(String(parsed?.principal?.pid ?? 'unknown')));
        assert(error.message.includes(parsed?.createdAt ?? 'unknown')); return true;
      });
      assert.deepEqual(snapshot(f.directory), before);
    }
  });
  await test('adopt reports an absolute lock path for a relative state directory', async () => {
    const dir = caseDir(), f = fixture(dir), originalCwd = process.cwd();
    writeFileSync(f.lock, 'unreadable holder'); const before = snapshot(f.directory);
    try {
      process.chdir(temp);
      const s = await store(basename(dir));
      await assert.rejects(s.adopt(f.meta.pid), error => { assert(error.message.includes(f.lock)); return true; });
      assert.deepEqual(snapshot(f.directory), before);
    } finally { process.chdir(originalCwd); }
  });
  await test('adopt rechecks metadata inside lock after asynchronous verification', async () => {
    for (const field of ['principal', 'server']) {
      const dir = caseDir(), old = id('old-reused-principal', true), f = fixture(dir, { meta: { principal: old } });
      rows.set(old.pid, { ...old, started: 'reused' });
      let changed;
      const s = await store(dir, async pids => {
        if (pids.includes(old.pid)) { changed = { ...metaOf(f), [field]: id('changed-' + field, true) }; atomicJson(f.path, changed); }
        return lookup(pids);
      });
      await assert.rejects(s.adopt(f.meta.pid), /驗證期間已被其他 session 接管或變更/);
      assert.deepEqual(metaOf(f), changed); assert(!existsSync(f.lock));
    }
  });
  await test('adopt removes its lock after success and critical-section rejection', async () => {
    const dir = caseDir(), f = fixture(dir), s = await store(dir);
    await s.adopt(f.meta.pid); assert(!existsSync(f.lock));
    const dir2 = caseDir(), old = id('changing-principal', true), f2 = fixture(dir2, { meta: { principal: old } });
    rows.set(old.pid, { ...old, started: 'reused' });
    const s2 = await store(dir2, async pids => {
      if (pids.includes(old.pid)) atomicJson(f2.path, { ...metaOf(f2), principal: ownPrincipal });
      return lookup(pids);
    });
    await assert.rejects(s2.adopt(f2.meta.pid), /驗證期間/); assert(!existsSync(f2.lock));
  });
  await test('adopt concurrent sessions permit exactly one successful transfer', async () => {
    const dir = caseDir(), f = fixture(dir), s1 = await store(dir);
    const s2 = await store(dir, lookup, 'mcp', id('second-session', true), id('second-server', true));
    const results = await Promise.allSettled([s1.adopt(f.meta.pid), s2.adopt(f.meta.pid)]);
    assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.adopted).length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal(metaOf(f).adoptedFrom.length, 1); assert(!existsSync(f.lock));
  });
  await test('adopt appends complete history in chronological transfer order', async () => {
    const dir = caseDir(), firstPrincipal = id('first-session', true), firstServer = id('first-server', true);
    const f = fixture(dir), s1 = await store(dir, lookup, 'mcp', firstPrincipal, firstServer);
    await s1.adopt(f.meta.pid); const first = metaOf(f).adoptedFrom[0];
    alive.delete(firstPrincipal.pid); rows.delete(firstPrincipal.pid);
    const secondPrincipal = id('second-session', true), secondServer = id('second-server', true);
    const s2 = await store(dir, lookup, 'mcp', secondPrincipal, secondServer);
    const cached = s1.get(f.meta.pid); s2.jobs.set(f.meta.jobId, cached);
    await s2.adopt(f.meta.pid);
    const history = metaOf(f).adoptedFrom;
    assert.equal(history.length, 2); assert.deepEqual(history[0], first);
    assert.deepEqual(history[1].principal, firstPrincipal); assert.deepEqual(history[1].server, firstServer);
    assert(Date.parse(history[1].adoptedAt) >= Date.parse(history[0].adoptedAt));
    assert.deepEqual(metaOf(f).principal, secondPrincipal); assert.deepEqual(metaOf(f).server, secondServer);
    assert.equal(s2.jobs.get(f.meta.jobId), cached); assert.deepEqual(cached.meta, metaOf(f));
  });
  await test('adopt candidate list is read-only and excludes ineligible jobs', async () => {
    const dir = caseDir();
    const good = [fixture(dir), fixture(dir, { exitCode: 0 }), fixture(dir, { exitCode: 1 }),
      fixture(dir, { runner: id('dead-runner'), meta: { worker: null } }), fixture(dir, { meta: { principal: null, server: null } })];
    const excluded = [fixture(dir, { meta: { principal: ownPrincipal } }), fixture(dir, { meta: { principal: id('live-owner', true) } }),
      fixture(dir, { bootstrap: true }), fixture(dir, { meta: { source: 'cli' } })];
    const s = await store(dir), all = [...good, ...excluded], before = all.map(f => snapshot(f.directory));
    const candidates = await s.adopt();
    assert.deepEqual(candidates.map(c => c.jobId).sort(), good.map(f => f.meta.jobId).sort());
    assert.deepEqual(candidates.map(c => c.status).sort(), ['running', 'completed', 'failed', 'lost', 'running'].sort());
    const first = candidates.find(c => c.jobId === good[0].meta.jobId);
    assert.equal(first.pid, good[0].meta.pid); assert.equal(first.agent, good[0].meta.agent);
    assert.equal(first.model, good[0].meta.resolvedModel); assert.equal(first.task, good[0].meta.task);
    assert.equal(first.startTime, good[0].meta.startTime); assert.equal(first.workFolder, ROOT);
    assert.deepEqual(first.principal, { pid: good[0].meta.principal.pid, name: good[0].meta.principal.name });
    assert.equal(candidates.find(c => c.jobId === good[4].meta.jobId).principal, null);
    assert.deepEqual(all.map(f => snapshot(f.directory)), before);
    // CLI 沒有自身 principal，可列到 MCP 自己的 job 以外相同的候選。
    const cliCandidates = await listAdoptCandidates(dir, lookup, ownPrincipal);
    assert.deepEqual(cliCandidates.map(c => c.jobId).sort(), candidates.map(c => c.jobId).sort());
    const nullOwned = good[4]; await s.adopt(nullOwned.meta.pid);
    assert.equal(metaOf(nullOwned).adoptedFrom[0].principal, null);
  });
  await test('adopt PID selection uses latest job and rejects mismatched selectors', async () => {
    const dir = caseDir(), runner = id('shared-runner', true);
    const older = fixture(dir, { runner, meta: { startTime: '2026-01-01T00:00:00.000Z' } });
    const newer = fixture(dir, { runner, meta: { startTime: '2026-01-02T00:00:00.000Z' } });
    const s = await store(dir);
    await assert.rejects(s.adopt(runner.pid, older.meta.jobId), /same latest job/);
    assert.equal((await s.adopt(runner.pid)).jobId, newer.meta.jobId);
    assert.equal(metaOf(older).adoptedFrom, undefined);
    await s.adopt(undefined, older.meta.jobId); assert.equal(metaOf(older).adoptedFrom.length, 1);
    for (const pid of [0, -1, 1.5, NaN]) await assert.rejects(s.adopt(pid), /positive integer/);
    await assert.rejects(s.adopt(undefined, '../escape'), /UUID/);
  });
  await test('adopt switches server identity for subsequent lost-process checks', async () => {
    const dir = caseDir(), f = fixture(dir), s = await store(dir);
    await s.adopt(f.meta.pid); assert.deepEqual(metaOf(f).server, ownServer);
    // 去掉 owned，才能釘住 server 歸屬真的換掉，而不是被 owned 條件掩蓋。
    s.owned.clear(); s.readOnly = false; s.collectedAt = Date.now();
    alive.delete(f.meta.runner.pid); alive.delete(f.meta.worker.pid); rows.delete(f.meta.runner.pid); rows.delete(f.meta.worker.pid);
    await s.check(async pids => lookup(pids));
    assert.equal(s.get(f.meta.pid).status, 'lost'); assert.equal(jobResult(s.get(f.meta.pid)).adopted, true);
  });
  await test('adopt does not extend completed job retention', async () => {
    const dir = caseDir(), f = fixture(dir, { exitCode: 0 }), s = await store(dir);
    const endTime = JSON.parse(contents(join(f.directory, 'exit.json'))).endTime;
    await s.adopt(f.meta.pid);
    assert.equal(s.get(f.meta.pid).endTime, endTime);
    assert.deepEqual(s.collect(Date.parse(endTime) + RETENTION_MS), [f.meta.pid]);
    assert(!existsSync(f.directory));
  });
  await test('adopt CLI store rejects writes and CLI command returns candidates only', async () => {
    const dir = caseDir(), f = fixture(dir), s = await store(dir, lookup, 'cli');
    await assert.rejects(s.adopt(f.meta.pid), /CLI stores cannot adopt/);
    await assert.rejects(s.adopt(), /CLI stores cannot adopt/);
    const output = [], errors = [], expected = await listAdoptCandidates(dir, lookup);
    const deps = { stdout: t => output.push(t), stderr: t => errors.push(t), listAdoptCandidates: async () => expected };
    assert.equal(await runCli(['adopt'], deps), 0); assert.deepEqual(JSON.parse(output.pop()), expected);
    for (const args of [[String(f.meta.pid)], ['--pid', String(f.meta.pid)], ['--jobId', f.meta.jobId], ['--job-id', f.meta.jobId]]) {
      assert.equal(await runCli(['adopt', ...args], deps), 1); assert.match(errors.pop(), /receiving MCP session/);
    }
    const child = spawnSync(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), 'adopt', String(f.meta.pid)], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /CLI ps\/result\/wait\/kill already see all jobs/);
    const listed = spawnSync(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), 'adopt'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(listed.status, 0, listed.stderr); assert(Array.isArray(JSON.parse(listed.stdout)));
  });
  await test('adopt CLI preserves startup notice and drains large JSON output', async () => {
    const dir = caseDir(), jobs = [];
    for (let i = 0; i < 40; i++) jobs.push(fixture(dir, { exitCode: 0, meta: { principal: null, server: null } }));
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(head.status, 0, head.stderr);
    const noticePath = join(dir, 'update.json');
    // from 要是真的 commit：新版啟動會用 from..to 重算待辦，算不出來（git 失敗）且沒送達就保留提示。
    atomicJson(noticePath, { notice: 'fixture update notice', lastApplied: { at: new Date().toISOString(), from: head.stdout.trim(),
      to: head.stdout.trim(), ok: true, commits: [], message: 'fixture update notice' } });
    const before = contents(noticePath), jobFiles = jobs.map(f => snapshot(f.directory));
    const env = { ...process.env, AI_CLI_STATE_DIR: dir, AI_CLI_UPDATE_REPO_ROOT: ROOT, AI_CLI_UPDATE_SKIP_STARTUP: '' };
    const child = spawnSync(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), 'adopt'], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert(Buffer.byteLength(child.stdout) > 8192, 'payload must exceed the macOS pipe buffer');
    assert.deepEqual(JSON.parse(child.stdout).map(c => c.jobId).sort(), jobs.map(f => f.meta.jobId).sort());
    assert.equal(contents(noticePath), before); assert.deepEqual(jobs.map(f => snapshot(f.directory)), jobFiles);
    // 正對照：同一份有效 notice 若由一般入口啟動，確實會被清掉。
    const control = spawnSync(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), 'help'], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(control.status, 0, control.stderr); assert.equal(JSON.parse(contents(noticePath)).notice, null);
  });
  await test('auto-adopt scope normalizes paths and respects platform case rules', async () => {
    const project = join(temp, 'CaseProject'), nested = join(project, 'nested');
    assert(inAutoAdoptScope({ projectDir: project + sep, workFolder: temp }, project));
    assert(inAutoAdoptScope({ workFolder: nested }, project + sep));
    assert(!inAutoAdoptScope({ projectDir: nested, workFolder: project }, project));
    assert(!inAutoAdoptScope({ workFolder: project + 'extra' }, project));
    assert.equal(inAutoAdoptScope({ projectDir: project.toUpperCase(), workFolder: temp }, project), process.platform === 'win32');
    assert.equal(inAutoAdoptScope({ workFolder: nested.toUpperCase() }, project), process.platform === 'win32');
    if (process.platform === 'win32') {
      assert(!inAutoAdoptScope({ workFolder: 'C:\\a\\bc' }, 'C:\\a\\b'));
      assert(inAutoAdoptScope({ workFolder: 'C:\\A\\B\\child' }, 'c:\\a\\b\\'));
    }
  });
  await test('auto-adopt startup exposes all same-project orphan statuses with ownership history', async () => {
    const dir = caseDir(), fixtures = [fixture(dir, { meta: { projectDir: ROOT } }), fixture(dir, { exitCode: 0, meta: { projectDir: ROOT } }),
      fixture(dir, { exitCode: 1, meta: { projectDir: ROOT } }), fixture(dir, { runner: id('gone-runner'), meta: { projectDir: ROOT, worker: null } })];
    const s = await automaticStore(dir), ps = processService(s), listed = ps.listProcesses();
    assert.equal(listed.length, 4); assert.deepEqual(listed.map(j => j.status).sort(), ['running', 'completed', 'failed', 'lost'].sort());
    for (const f of fixtures) {
      const meta = metaOf(f); assert.deepEqual(meta.principal, ownPrincipal); assert.deepEqual(meta.server, ownServer);
      assert.equal(meta.adoptedFrom.length, 1); assert.deepEqual(meta.adoptedFrom[0].principal, f.meta.principal);
      assert.equal(listed.find(j => j.jobId === f.meta.jobId).adopted, true); assert(!existsSync(f.lock));
    }
  });
  await test('auto-adopt leaves different-project metadata unchanged', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { projectDir: join(temp, 'other-project'), workFolder: ROOT } }), before = contents(f.path);
    const s = await automaticStore(dir); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
  });
  await test('auto-adopt legacy scope includes descendants and rejects neighboring prefixes', async () => {
    const dir = caseDir(), projectDir = join(temp, 'legacy-project');
    const inside = fixture(dir, { meta: { workFolder: join(projectDir, 'child') } });
    const outside = [fixture(dir, { meta: { workFolder: projectDir + 'extra' } }), fixture(dir, { meta: { workFolder: temp } })];
    const before = outside.map(f => contents(f.path)), s = await automaticStore(dir, { projectDir });
    assert.deepEqual(s.list().map(j => j.jobId), [inside.meta.jobId]); assert.deepEqual(outside.map(f => contents(f.path)), before);
  });
  await test('auto-adopt refuses a live original principal', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT, principal: id('live-auto-owner', true) } }), before = contents(f.path);
    const s = await automaticStore(dir); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
  });
  await test('auto-adopt fails closed on missing or failed batched identity queries', async () => {
    for (const mode of ['throw', 'missing', 'empty-started']) {
      const dir = caseDir(), old = id('unknown-auto-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } }), before = contents(f.path);
      const s = await automaticStore(dir, { customLookup: async pids => {
        if (pids.includes(old.pid) && mode === 'throw') throw new Error('synthetic batch identity failure');
        const result = await lookup(pids);
        if (mode === 'missing') result.delete(old.pid);
        if (mode === 'empty-started' && result.has(old.pid)) result.set(old.pid, { ...old, started: '' });
        return result;
      } });
      assert.equal(s.list().length, 0); assert.equal(contents(f.path), before); assert(!existsSync(f.lock));
    }
  });
  await test('auto-adopt batches original principal identity with GC worker lookup', async () => {
    const dir = caseDir(), old = id('reused-auto-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } }), queries = [];
    rows.set(old.pid, { ...old, started: 'reused-auto-pid' });
    const s = await automaticStore(dir, { customLookup: async pids => { if (pids.length) queries.push([...pids]); return lookup(pids); } });
    assert.equal(s.list().length, 1);
    assert.equal(queries.length, 1, 'GC and adoption must not perform separate OS queries');
    assert(queries[0].includes(old.pid)); assert(queries[0].includes(f.meta.runner.pid)); assert(queries[0].includes(f.meta.worker.pid));
  });
  await test('auto-adopt rejects expired identity evidence and refreshes due GC despite throttling', async () => {
    const dir = caseDir(), old = id('cached-auto-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } }), before = contents(f.path);
    const s = await automaticStore(dir);
    s.autoAdoptSnapshot = { metas: [metaOf(f)], identities: new Map([[old.pid, { ...old, started: 'stale-unrelated-identity' }]]), at: Date.now() - GC_INTERVAL_MS };
    await s.autoAdoptJobs(); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
    rows.set(old.pid, { ...old, started: 'reused-after-initial-batch' });
    s.checkedAt = Date.now(); s.collectedAt = -Infinity;
    await s.check(undefined, true); await s.gcPass(); assert.equal(s.list()[0]?.jobId, f.meta.jobId);
  });
  await test('auto-adopt excludes jobs created after its identity batch', async () => {
    const dir = caseDir(), old = id('batch-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } });
    let late, before;
    const s = await automaticStore(dir, { customLookup: async pids => {
      const result = await lookup(pids);
      if (pids.includes(old.pid) && !late) {
        const current = { ...old, started: 'new-session-after-query' }; rows.set(old.pid, current);
        late = fixture(dir, { meta: { projectDir: ROOT, principal: current } }); before = contents(late.path);
      }
      return result;
    } });
    assert.equal(s.list().length, 0); assert.equal(contents(late.path), before);
    await gcCycle(s); assert.deepEqual(s.list().map(j => j.jobId), [f.meta.jobId]); assert.equal(contents(late.path), before);
  });
  await test('auto-adopt rejects ownership changed after its identity batch', async () => {
    const dir = caseDir(), old = id('changing-batch-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } });
    let changed;
    const s = await automaticStore(dir, { customLookup: async pids => {
      const result = await lookup(pids);
      if (pids.includes(old.pid)) {
        const current = { ...old, started: 'new-owner-after-query' }; rows.set(old.pid, current);
        changed = { ...metaOf(f), principal: current }; atomicJson(f.path, changed);
      }
      return result;
    } });
    assert.equal(s.list().length, 0); assert.deepEqual(metaOf(f), changed); assert(!existsSync(f.lock));
  });
  await test('auto-adopt retains existing locks and logs each job only once', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT } }); writeFileSync(f.lock, 'stale lock');
    const before = snapshot(f.directory), logs = [], originalError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(' '));
    try {
      const s = await automaticStore(dir); await gcCycle(s); await gcCycle(s);
      assert.equal(s.list().length, 0); assert.equal(logs.length, 1); assert(logs[0].includes(f.lock));
      assert.deepEqual(snapshot(f.directory), before);
    } finally { console.error = originalError; }
  });
  await test('auto-adopt off disables startup and GC while preserving manual takeover', async () => {
    const previous = process.env.AI_CLI_AUTO_ADOPT; process.env.AI_CLI_AUTO_ADOPT = 'off';
    try {
      const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT } }), before = contents(f.path), s = await automaticStore(dir);
      await gcCycle(s); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
      await s.adopt(f.meta.pid); assert.equal(s.list()[0].adopted, true);
    } finally { if (previous === undefined) delete process.env.AI_CLI_AUTO_ADOPT; else process.env.AI_CLI_AUTO_ADOPT = previous; }
  });
  await test('auto-adopt GC takes over after the original session ends', async () => {
    const dir = caseDir(), old = id('later-ended-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } });
    const s = await automaticStore(dir), ps = processService(s); assert.equal(ps.listProcesses().length, 0);
    alive.delete(old.pid); rows.delete(old.pid); await gcCycle(s);
    assert.equal(ps.listProcesses()[0].jobId, f.meta.jobId); assert.equal(ps.listProcesses()[0].adopted, true);
    assert.equal(metaOf(f).adoptedFrom.length, 1);
  });
  await test('auto-adopt concurrent same-project sessions produce one owner without error logs', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT } }), logs = [], originalError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(' '));
    try {
      const [a, b] = await Promise.all([automaticStore(dir, { principal: id('auto-session-a', true), server: id('auto-server-a', true) }),
        automaticStore(dir, { principal: id('auto-session-b', true), server: id('auto-server-b', true) })]);
      assert.equal(a.list().length + b.list().length, 1); assert.equal(metaOf(f).adoptedFrom.length, 1); assert.equal(logs.length, 0);
    } finally { console.error = originalError; }
  });
  await test('auto-adopt excludes read-only stores and CLI stores', async () => {
    for (const settings of [{ readOnly: true }, { source: 'cli' }]) {
      const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT } }), before = contents(f.path);
      const s = await automaticStore(dir, settings);
      assert.equal(contents(f.path), before); assert.equal(metaOf(f).adoptedFrom, undefined);
      if (settings.readOnly) assert.equal(s.list().length, 0);
    }
  });
  await test('auto-adopt start persists normalized MCP project directory and omits it for CLI', async () => {
    const project = join(temp, 'launch-project');
    for (const source of ['mcp', 'cli']) {
      const dir = caseDir(), s = await automaticStore(dir, { source, projectDir: project + sep });
      const job = await s.start({ agent: 'codex', cliPath: process.execPath, args: ['-e', 'process.stdout.write("{}\\n")'], cwd: ROOT,
        prompt: 'synthetic worker', resolvedModel: 'fixture-resolved' }, 'fixture-requested');
      const expected = source === 'mcp' ? resolve(project) : undefined;
      // async launcher 返回時 runner 可能已讀掉 launch.tmp；bootstrap 永遠保留啟動摘要。
      assert.equal(job.meta.projectDir, expected); assert.equal(JSON.parse(contents(join(job.directory, 'bootstrap.json'))).projectDir, expected);
      const deadline = Date.now() + 15000;
      while (!existsSync(join(job.directory, 'exit.json')) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
      assert(existsSync(join(job.directory, 'exit.json')), 'synthetic Node worker must finish');
      assert.equal(JSON.parse(contents(join(job.directory, 'meta.json'))).projectDir, expected);
    }
  });
  await test('auto-adopt candidates expose project directory and automatic scope flags', async () => {
    const dir = caseDir(), project = join(temp, 'candidate-project'), cases = [
      [fixture(dir, { meta: { projectDir: project, workFolder: temp } }), true],
      [fixture(dir, { meta: { projectDir: temp, workFolder: project } }), false],
      [fixture(dir, { meta: { workFolder: join(project, 'child') } }), true],
      [fixture(dir, { meta: { workFolder: project + 'extra' } }), false]];
    const s = new JobStore(dir, 'mcp', true, lookup, project); stores.push(s); await s.ready;
    const mcp = await s.adopt(), cli = await listAdoptCandidates(dir, lookup, ownPrincipal, project);
    assert.deepEqual(mcp, cli);
    for (const [f, flag] of cases) {
      const item = mcp.find(j => j.jobId === f.meta.jobId); assert.equal(item.autoAdopt, flag); assert.equal(item.projectDir, f.meta.projectDir ?? null);
    }
    await s.adopt(cases[1][0].meta.pid); assert.equal(s.list()[0].adopted, true, 'manual takeover must allow other projects');
  });
  await test('auto-adopt list rows expose requested model with resolved fallback', async () => {
    const dir = caseDir(), requested = fixture(dir, { meta: { projectDir: ROOT, model: 'fixture-requested', resolvedModel: 'fixture-resolved' } });
    const fallback = fixture(dir, { meta: { projectDir: ROOT, model: undefined, resolvedModel: 'fixture-fallback' } }), s = await automaticStore(dir);
    for (const listed of [s.list(), processService(s).listProcesses()]) {
      assert.equal(listed.find(j => j.jobId === requested.meta.jobId).model, 'fixture-requested');
      assert.equal(listed.find(j => j.jobId === fallback.meta.jobId).model, 'fixture-fallback');
    }
  });
  await test('adopt worker environment disables automatic and manual takeover', async () => {
    const saved = { worker: process.env.AI_CLI_WORKER, nested: process.env.AI_CLI_ALLOW_NESTED };
    process.env.AI_CLI_WORKER = '1'; delete process.env.AI_CLI_ALLOW_NESTED;
    try {
      const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT } }), before = contents(f.path), s = await automaticStore(dir);
      await gcCycle(s); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
      await assert.rejects(s.adopt(f.meta.pid), /ai-cli worker/); assert.equal(contents(f.path), before); assert(!existsSync(f.lock));
      assert.deepEqual((await s.adopt()).map(c => c.autoAdopt), [false]);
      // 與派工判斷同一語意：明示 AI_CLI_ALLOW_NESTED=1 時標記不擋。
      process.env.AI_CLI_ALLOW_NESTED = '1';
      await gcCycle(s); assert.equal(s.list()[0]?.jobId, f.meta.jobId);
    } finally {
      for (const [key, value] of [['AI_CLI_WORKER', saved.worker], ['AI_CLI_ALLOW_NESTED', saved.nested]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await test('adopt worker ancestry disables automatic and manual takeover', async () => {
    // 模擬 codex 沒轉標記：MCP 的父行程是 worker CLI，再上一層是父 job 的 runner。
    const dir = caseDir(), runner = { ...id('ancestor-runner', true), ppid: 0 }; rows.set(runner.pid, runner);
    const parentJob = fixture(dir, { runner, meta: { projectDir: ROOT } }), orphan = fixture(dir, { meta: { projectDir: ROOT } });
    const before = [parentJob, orphan].map(f => contents(f.path));
    const s = await automaticStore(dir, { principal: { ...id('worker-cli', true), ppid: runner.pid } });
    await gcCycle(s); assert.equal(s.list().length, 0); assert.deepEqual([parentJob, orphan].map(f => contents(f.path)), before);
    for (const f of [parentJob, orphan]) await assert.rejects(s.adopt(f.meta.pid), /ai-cli worker/);
    assert.deepEqual([parentJob, orphan].map(f => contents(f.path)), before);
    // 祖先還在卻查不到身分：無法確認 → 不自動接；手動不受影響。
    const dir2 = caseDir(), hidden = id('hidden-ancestor'); alive.add(hidden.pid);
    const g = fixture(dir2, { meta: { projectDir: ROOT } }), beforeG = contents(g.path);
    const u = await automaticStore(dir2, { principal: { ...id('unconfirmed-chain', true), ppid: hidden.pid } });
    await gcCycle(u); assert.equal(u.list().length, 0); assert.equal(contents(g.path), beforeG);
    assert.equal((await u.adopt(g.meta.pid)).adopted, true);
  });
  await test('adopt null principal defers to the dispatching MCP server', async () => {
    const dir = caseDir(), a = fixture(dir, { meta: { projectDir: ROOT, principal: null, server: id('null-principal-live-server', true) } }), before = contents(a.path);
    const s = await automaticStore(dir); await gcCycle(s);
    assert.equal(s.list().length, 0); assert.equal(contents(a.path), before);
    await assert.rejects(s.adopt(a.meta.pid), /dispatching MCP server is still alive/); assert.equal(contents(a.path), before);
    assert.deepEqual(await s.adopt(), []);
    const dir2 = caseDir(), b = fixture(dir2, { meta: { projectDir: ROOT, principal: null, server: id('null-principal-dead-server') } });
    const s2 = await automaticStore(dir2); assert.deepEqual(s2.list().map(j => j.jobId), [b.meta.jobId]);
    const dir3 = caseDir(), c = fixture(dir3, { meta: { projectDir: ROOT, principal: null, server: null } }), beforeC = contents(c.path);
    const s3 = await automaticStore(dir3); await gcCycle(s3); assert.equal(s3.list().length, 0); assert.equal(contents(c.path), beforeC);
    assert.deepEqual((await s3.adopt()).map(candidate => candidate.autoAdopt), [false], 'ownerless candidates are never adopted automatically');
    assert.equal((await s3.adopt(c.meta.pid)).adopted, true); assert.equal(metaOf(c).adoptedFrom[0].server, null);
  });
  await test('auto-adopt legacy scope at a filesystem root or home directory requires an exact workFolder', async () => {
    const home = homedir(), root = parse(ROOT).root;
    assert(!inAutoAdoptScope({ workFolder: join(home, 'some-project') }, home)); assert(inAutoAdoptScope({ workFolder: home }, home));
    assert(!inAutoAdoptScope({ workFolder: ROOT }, root)); assert(inAutoAdoptScope({ workFolder: root }, root));
    assert(inAutoAdoptScope({ workFolder: join(ROOT, 'src') }, ROOT), 'ordinary project directories keep descendant scope');
    const dir = caseDir(), f = fixture(dir, { meta: { workFolder: join(home, 'other-project') } }), before = contents(f.path);
    const s = await automaticStore(dir, { projectDir: home }); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
  });
  await test('auto-adopt disabled when the MCP cwd is unavailable', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT } }), before = contents(f.path), realCwd = process.cwd;
    const broken = () => { throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT' }); };
    let pending;
    process.cwd = broken;
    try { pending = Promise.all([automaticStore(dir, { useCwd: true }), listAdoptCandidates(dir, lookup, ownPrincipal)]); }
    finally { process.cwd = realCwd; }
    const [s, candidates] = await pending; assert.equal(s.projectDir, null);
    assert.deepEqual(candidates.map(c => c.autoAdopt), [false]);
    await gcCycle(s); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
    assert.equal((await s.adopt(f.meta.pid)).adopted, true);
  });
  await test('auto-adopt switch accepts trimmed case-insensitive off values', async () => {
    const previous = process.env.AI_CLI_AUTO_ADOPT;
    try {
      for (const value of [' OFF ', 'Off', '0', 'false', 'FALSE', ' no ']) { process.env.AI_CLI_AUTO_ADOPT = value; assert.equal(autoAdoptSwitchOn(), false, JSON.stringify(value)); }
      for (const value of ['on', '1', '', 'offline']) { process.env.AI_CLI_AUTO_ADOPT = value; assert.equal(autoAdoptSwitchOn(), true, JSON.stringify(value)); }
      process.env.AI_CLI_AUTO_ADOPT = ' Off ';
      const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT } }), before = contents(f.path), s = await automaticStore(dir);
      await gcCycle(s); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
    } finally { if (previous === undefined) delete process.env.AI_CLI_AUTO_ADOPT; else process.env.AI_CLI_AUTO_ADOPT = previous; }
  });
  await test('adopt keeps a committed transfer when lock removal fails', async () => {
    const dir = caseDir(), f = fixture(dir), s = await store(dir), logs = [], originalError = console.error;
    // 持有 lock 期間把它換成非空目錄，rmSync 必丟例外（模擬 EPERM／EBUSY）。
    s.adoptLockHeld = () => { rmSync(f.lock); mkdirSync(f.lock); writeFileSync(join(f.lock, 'busy'), ''); };
    console.error = (...args) => logs.push(args.map(String).join(' '));
    try { assert.equal((await s.adopt(f.meta.pid)).adopted, true); }
    finally { console.error = originalError; }
    assert.deepEqual(metaOf(f).principal, ownPrincipal); assert.equal(s.list()[0].adopted, true);
    assert(logs.some(line => line.includes(f.lock)), 'lock removal failure must be logged with its path');
    assert(existsSync(f.lock)); rmSync(f.lock, { recursive: true, force: true });
  });
  await test('adopt lock refuses a second session inside the critical section', async () => {
    const dir = caseDir(), f = fixture(dir), a = await store(dir);
    const b = await store(dir, lookup, 'mcp', id('lock-session-b', true), id('lock-server-b', true));
    let refused, lockKept;
    // A 持有 lock 時，B 已完成非同步查證、直接進入同步提交。
    a.adoptLockHeld = () => { try { b.commitAdoption(f.directory, metaOf(f), false); } catch (error) { refused = error; } lockKept = existsSync(f.lock); };
    assert.equal((await a.adopt(f.meta.pid)).adopted, true);
    assert(refused, 'B must be refused while A holds the lock'); assert.equal(refused.reason, 'locked'); assert.match(refused.message, /Adoption lock exists/);
    assert.equal(lockKept, true, 'the refused session must not remove the holder lock');
    assert.deepEqual(metaOf(f).principal, ownPrincipal); assert.equal(metaOf(f).adoptedFrom.length, 1); assert(!existsSync(f.lock));
  });
  await test('auto-adopt due GC does not bypass throttling for wait and peek checks', async () => {
    const dir = caseDir(), queries = []; fixture(dir, { meta: { projectDir: ROOT, principal: ownPrincipal, server: ownServer } });
    const s = await automaticStore(dir, { customLookup: async pids => { if (pids.length) queries.push([...pids]); return lookup(pids); } });
    s.checkedAt = Date.now(); s.collectedAt = -Infinity; queries.length = 0;
    await s.check(); assert.equal(queries.length, 0, 'unforced checks stay throttled while GC is due');
    await s.check(undefined, true); assert.equal(queries.length, 1);
  });
  await test('auto-adopt reads its GC identity snapshot instead of the shared cache', async () => {
    const dir = caseDir(), old = id('snapshot-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } }), before = contents(f.path);
    const s = await automaticStore(dir); assert.equal(s.list().length, 0);
    s.collectedAt = -Infinity; s.checkedAt = -Infinity; await s.check(undefined, true);
    // 晚到的舊查詢改寫共用快取，不得影響這一輪已查到的「原 principal 仍活著」。
    s.identities.set(old.pid, { identity: { ...old, started: 'late-stale-query' }, checkedAt: Date.now() });
    await s.gcPass(); assert.equal(s.list().length, 0); assert.equal(contents(f.path), before);
  });
  await test('adopt candidates batch identity lookups and skip directories deleted while listing', async () => {
    const dir = caseDir(), keep = fixture(dir), gone = fixture(dir, { exitCode: 0 }), calls = [];
    const candidates = await listAdoptCandidates(dir, async pids => { calls.push([...pids]); rmSync(gone.directory, { recursive: true, force: true }); return lookup(pids); }, ownPrincipal, ROOT);
    assert.deepEqual(candidates.map(c => c.jobId), [keep.meta.jobId]); assert.equal(calls.length, 1);
    assert.equal(candidates[0].status, 'running');
  });
  await test('adopt candidate and list fields stay consistent', async () => {
    const dir = caseDir(), f = fixture(dir, { meta: { projectDir: ROOT, model: 'fixture-requested', resolvedModel: 'fixture-resolved' } }), s = await store(dir);
    assert.equal((await s.adopt())[0].model, 'fixture-requested');
    const previous = process.env.AI_CLI_AUTO_ADOPT; process.env.AI_CLI_AUTO_ADOPT = 'off';
    try { assert.equal((await s.adopt())[0].autoAdopt, false); }
    finally { if (previous === undefined) delete process.env.AI_CLI_AUTO_ADOPT; else process.env.AI_CLI_AUTO_ADOPT = previous; }
    await s.adopt(f.meta.pid);
    assert.equal(s.list()[0].adopted, true); assert.equal(s.list()[0].recovered, undefined, 'adopted jobs are not same-principal recoveries');
    assert.equal(jobResult(s.get(f.meta.pid)).recovered, undefined);
  });
  await test('adopt worker ancestry recognizes a principal that is a job worker without walking the chain', async () => {
    // claude 由 runner 直接啟動時 principal 就是 meta.worker；往上走會碰到查不到的祖先（無法確認），快速路徑必須先判 worker。
    const dir = caseDir(), workerCli = id('worker-is-principal', true), hidden = id('fast-path-hidden'), queries = []; alive.add(hidden.pid);
    const parentJob = fixture(dir, { meta: { projectDir: ROOT, worker: workerCli } }), before = contents(parentJob.path);
    const s = await automaticStore(dir, { principal: { ...workerCli, ppid: hidden.pid }, customLookup: async pids => { queries.push(...pids); return lookup(pids); } });
    await gcCycle(s); assert.equal(s.list().length, 0); assert.equal(contents(parentJob.path), before);
    await assert.rejects(s.adopt(parentJob.meta.pid), /ai-cli worker/);
    assert(!queries.includes(hidden.pid), 'fast path must not query ancestors');
  });
  await test('adopt worker ancestry stops four levels above the principal', async () => {
    const dir = caseDir(), runner = { ...id('distant-runner', true), ppid: 0 }; rows.set(runner.pid, runner);
    fixture(dir, { runner, meta: { projectDir: join(temp, 'elsewhere') } });
    let parent = runner.pid; const ancestors = [];
    for (let level = 4; level >= 1; level--) { const a = { ...id('ancestor-' + level, true), ppid: parent }; rows.set(a.pid, a); ancestors.push(a.pid); parent = a.pid; }
    const orphan = fixture(dir, { meta: { projectDir: ROOT } }), queries = [];
    const s = await automaticStore(dir, { principal: { ...id('deep-principal', true), ppid: parent }, customLookup: async pids => { queries.push(...pids); return lookup(pids); } });
    assert.deepEqual(s.list().map(j => j.jobId), [orphan.meta.jobId], 'a runner five levels up is outside any worker tree');
    assert.equal(queries.filter(pid => ancestors.includes(pid)).length, 4);
  });
  await test('adopt worker ancestry treats a bootstrap-only runner ancestor as unconfirmed', async () => {
    const dir = caseDir(), runner = { pid: ++nextPid, started: '', name: 'runner' }; alive.add(runner.pid);
    rows.set(runner.pid, { pid: runner.pid, started: 'bootstrap-runner-os', name: 'node', ppid: 0 });
    fixture(dir, { bootstrap: true, runner, meta: { projectDir: join(temp, 'elsewhere') } });
    const orphan = fixture(dir, { meta: { projectDir: ROOT } }), before = contents(orphan.path);
    const s = await automaticStore(dir, { principal: { ...id('pending-chain', true), ppid: runner.pid } });
    await gcCycle(s); assert.equal(s.list().length, 0); assert.equal(contents(orphan.path), before);
    assert.equal((await s.adopt(orphan.meta.pid)).adopted, true, 'manual takeover stays available when ancestry is unconfirmed');
  });
  await test('adopt worker ancestry treats an ancestor without ppid as unconfirmed', async () => {
    const dir = caseDir(), middle = id('ppid-less-ancestor', true);
    const orphan = fixture(dir, { meta: { projectDir: ROOT } }), before = contents(orphan.path);
    const s = await automaticStore(dir, { principal: { ...id('ppid-less-chain', true), ppid: middle.pid } });
    await gcCycle(s); assert.equal(s.list().length, 0); assert.equal(contents(orphan.path), before);
    assert.equal((await s.adopt(orphan.meta.pid)).adopted, true);
  });
  await test('auto-adopt GC timer forces its due check past throttling', async () => {
    const dir = caseDir(), old = id('timer-owner', true), f = fixture(dir, { meta: { projectDir: ROOT, principal: old } });
    const s = await automaticStore(dir); assert.equal(s.list().length, 0);
    alive.delete(old.pid); rows.delete(old.pid);
    // 未強制的 check 一律被節流；只有真實計時器帶 force 的那一路能重建身分快照並接管。
    s.checkedAt = Date.now() + GC_INTERVAL_MS; s.collectedAt = -Infinity;
    const deadline = Date.now() + 6000;
    while (!s.list().length && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    assert.deepEqual(s.list().map(j => j.jobId), [f.meta.jobId]);
  });
  await test('auto-adopt survives an unavailable home directory and candidate failures', async () => {
    const os = require('node:os'), realHome = os.homedir;
    const dir = caseDir(), legacy = fixture(dir, { meta: { workFolder: join(ROOT, 'src') } });
    os.homedir = () => { throw Object.assign(new Error('ENOENT: no such file or directory, uv_os_homedir'), { code: 'ENOENT' }); }; syncBuiltinESMExports();
    let s;
    try { assert.equal(currentHomeDir(), null); s = await automaticStore(dir); }
    finally { os.homedir = realHome; syncBuiltinESMExports(); }
    assert.deepEqual(s.list().map(j => j.jobId), [legacy.meta.jobId], 'root-only scope rule still applies without a home directory');
    // 候選篩選丟例外時，同一輪的 lost 判定照常。
    const dir2 = caseDir(), own = fixture(dir2, { meta: { projectDir: ROOT, principal: ownPrincipal, server: ownServer } }), logs = [], originalError = console.error;
    const s2 = await automaticStore(dir2); assert.equal(s2.get(own.meta.pid).status, 'running');
    s2.autoAdoptMetas = () => { throw new Error('synthetic candidate failure'); };
    for (const pid of [own.meta.runner.pid, own.meta.worker.pid]) { alive.delete(pid); rows.delete(pid); }
    console.error = (...args) => logs.push(args.map(String).join(' '));
    try { s2.collectedAt = -Infinity; s2.checkedAt = -Infinity; await s2.check(undefined, true); }
    finally { console.error = originalError; }
    assert.equal(s2.get(own.meta.pid).status, 'lost'); assert(logs.some(line => line.includes('synthetic candidate failure')));
  });
  await test('auto-adopt runs after ready without blocking it', async () => {
    // 祖先鏈查詢卡住時，ready 必須先 resolve；放行後接管完成，list 才看得到。
    const dir = caseDir(), orphan = fixture(dir, { meta: { projectDir: ROOT } }), gate = id('slow-ancestor');
    let release; const stuck = new Promise(done => { release = done; });
    const principal = { ...id('slow-chain', true), ppid: gate.pid };
    const identities = async pids => {
      const found = await lookup(pids.filter(pid => pid !== process.pid && pid !== process.ppid));
      if (pids.includes(gate.pid)) await stuck;
      if (pids.includes(process.pid)) found.set(process.pid, ownServer);
      if (pids.includes(process.ppid)) found.set(process.ppid, principal);
      return found;
    };
    const s = new JobStore(dir, 'mcp', false, identities, ROOT); stores.push(s);
    try {
      const first = await Promise.race([s.ready.then(() => 'ready'), new Promise(done => setTimeout(() => done('timeout'), 3000))]);
      assert.equal(first, 'ready', 'ready must not wait for the ancestor lookup');
      assert.equal(s.list().length, 0, 'takeover is still waiting on the ancestor lookup');
    } finally { release(); }
    await s.autoAdoptSettled;
    assert.deepEqual(s.list().map(j => j.jobId), [orphan.meta.jobId]);
  });
  await test('auto-adopt in progress never holds up collection', async () => {
    // collectAll 是 single-flight，initialize 也會 await 它；接管若放進去，GC 計時器剛好在啟動期間觸發時 ready 會跟著等。
    const dir = caseDir(); fixture(dir, { meta: { projectDir: ROOT } }); const gate = id('slow-gc-ancestor');
    let release; const stuck = new Promise(done => { release = done; });
    const principal = { ...id('slow-gc-chain', true), ppid: gate.pid };
    const identities = async pids => {
      const found = await lookup(pids.filter(pid => pid !== process.pid && pid !== process.ppid));
      if (pids.includes(gate.pid)) await stuck;
      if (pids.includes(process.pid)) found.set(process.pid, ownServer);
      if (pids.includes(process.ppid)) found.set(process.ppid, principal);
      return found;
    };
    const s = new JobStore(dir, 'mcp', false, identities, ROOT); stores.push(s);
    try {
      const started = await Promise.race([s.ready.then(() => 'ready'), new Promise(done => setTimeout(() => done('timeout'), 3000))]);
      assert.equal(started, 'ready', 'ready must not wait for a takeover stuck on the ancestor lookup');
      const collected = await Promise.race([s.collectAll().then(() => 'collected'), new Promise(done => setTimeout(() => done('timeout'), 3000))]);
      assert.equal(collected, 'collected', 'collection must not wait for a takeover stuck on the ancestor lookup');
    } finally { release(); }
    await s.autoAdoptSettled;
  });
  await test('auto-adopt timer stays idle until startup finishes', async () => {
    // 啟動中的計時器強制 check 會清快取、多查一輪，直接加在 ready 上；ready 之前一律跳過。
    const dir = caseDir(); let calls = 0, release; const stuck = new Promise(done => { release = done; });
    const identities = async pids => { calls++; if (pids.includes(process.pid)) await stuck; const found = await lookup(pids.filter(pid => pid !== process.pid && pid !== process.ppid)); if (pids.includes(process.pid)) found.set(process.pid, ownServer); if (pids.includes(process.ppid)) found.set(process.ppid, { ...id('gate-chain', true), ppid: 0 }); return found; };
    const s = new JobStore(dir, 'mcp', false, identities, ROOT); stores.push(s);
    try {
      await new Promise(done => setTimeout(done, 2500));
      assert.equal(calls, 1, `only the stuck startup lookup may run before ready, saw ${calls}`);
    } finally { release(); }
    await s.ready;
  });
} finally {
  for (const s of stores) s.dispose();
  if (originalAutoAdopt === undefined) delete process.env.AI_CLI_AUTO_ADOPT; else process.env.AI_CLI_AUTO_ADOPT = originalAutoAdopt;
  process.kill = realKill;
  rmSync(temp, { recursive: true, force: true });
}
console.log(`adopt: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
