import '../tools/stubs/catalog-test-env.mjs';
import { installClaudeQuotaStub } from './helpers/claude-quota-stub.mjs';
// G4：萬一有路徑走到真的額度查詢，也只會叫到立刻結束的替身，不會啟動真的 Claude CLI。
installClaudeQuotaStub();
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), source = process.argv.includes('--source');
const load = name => import(pathToFileURL(join(ROOT, source ? 'src' : 'dist', 'ai-cli_kernel', `${name}.${source ? 'ts' : 'js'}`)).href);
const { RunStore, kernelRunDir, kernelStateDir, newRunId, acquireActiveLock, releaseActiveLock } = await load('journal');
const { admitRun, readActiveRuns, validateConcurrencyConfig, normalizedOrigin, claimRunnerSlot, ensureLegacyMarker, startLegacyMarkerWatch, LegacyMarkerReplaceFailed } = await load('admission');
const { buildContract } = await load('templates');
const { remainingPercentFromUsage } = await load('runtime');
const { replayJournal, activeMinutes } = await load('replay');
const { waitForTestLock, releaseStoppedTestLock } = await load('test-lock');
const { ProcessMutexBusy, withProcessMutex, processIdentity } = await load('process-mutex');
const api = await load('api');
const { runKernelCli } = await load('cli');
const work = mkdtempSync(join(tmpdir(), 'kernel-concurrency-'));
const children = new Set();
const commandControls = [];
let count = 0;
const suiteStarted = Date.now();
/** 每組印耗時：npm test 的 runner 只在最後印彙總，kernel 逾時砍掉時看不到卡在哪一組、每組多久。 */
const elapsed = since => `${((Date.now() - since) / 1000).toFixed(1)}s`;
async function test(name, fn) {
  if (process.env.KERNEL_CONCURRENCY_TEST_FILTER && !name.includes(process.env.KERNEL_CONCURRENCY_TEST_FILTER)) return;
  const started = Date.now();
  try { await fn(); console.log(`PASS C ${name} (${elapsed(started)})`); count++; }
  catch (error) { console.error(`FAIL C ${name} (${elapsed(started)})`); throw error; }
}
function git(folder, ...args) {
  const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function folder() { return mkdtempSync(join(work, 'repo-')); }
function repo() { const dir = folder(); git(dir, 'init', '-q'); return dir; }
function fresh(dir = folder(), overrides = {}) {
  const contract = { ...buildContract({ goal: 'concurrency fixture', workFolder: dir, allowUnverifiedBoundary: true }), ...overrides };
  const store = new RunStore(kernelRunDir(newRunId())); store.create(contract); return store;
}
function running(store) {
  store.append({ type: 'approved', kind: 'contract', contractDigest: store.contractDigest() });
  store.append({ type: 'state', state: 'running' });
}
const quota = async () => 80;
async function admit(store, extra = {}) { await admitRun(store, () => running(store), { quota, ...extra }); }
async function finish(store) { store.append({ type: 'state', state: 'cancelled' }); await releaseActiveLock(store.runId); }
async function clear() {
  for (const run of readActiveRuns()) await finish(new RunStore(kernelRunDir(run.runId)));
  rmSync(join(kernelStateDir(), 'active.lock'), { force: true });
  rmSync(join(kernelStateDir(), 'concurrency.json'), { force: true });
}
function child(mode, store, extra = {}) {
  if (extra.control) commandControls.push({ control: extra.control, runId: store.runId });
  const cp = fork(join(ROOT, 'tests/helpers/kernel-concurrency-child.mjs'), [ROOT, mode, source ? 'source' : 'dist', JSON.stringify({ runId: store.runId, ...extra })], {
    execArgv: source ? ['--import', 'tsx'] : [], env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  children.add(cp);
  const messages = [], waiters = [];
  let stderr = '';
  cp.stderr.on('data', data => { stderr += data; });
  cp.on('message', message => {
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.type === message.type || message.type === 'error') {
      waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer);
      message.type === 'error' ? waiter.reject(new Error(message.message)) : waiter.resolve(message);
    }
  });
  const exited = new Promise((resolve, reject) => cp.on('exit', code => {
    children.delete(cp);
    if (code) reject(new Error(`child exit ${code}: ${stderr}`)); else resolve();
  }));
  // Keep a failure observed even if it occurs while waiting for another child's barrier.
  exited.catch(() => {});
  const wait = type => {
    const found = messages.find(message => message.type === type || message.type === 'error');
    if (found) return found.type === 'error' ? Promise.reject(new Error(found.message)) : Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: setTimeout(() => reject(new Error(`IPC timeout ${mode}/${type}: ${stderr}`)), 45000) };
      waiters.push(waiter);
    });
  };
  return { cp, store, messages, wait, exited, go: () => cp.send({ type: 'go' }), stop: () => cp.send({ type: 'stop' }) };
}
async function race(stores, expected, extra = {}) {
  const group = stores.map(store => child('admit', store, extra));
  await Promise.all(group.map(c => c.wait('ready'))); group.forEach(c => c.go());
  const results = await Promise.all(group.map(c => c.wait('result')));
  assert.equal(results.filter(r => r.ok).length, expected, JSON.stringify(results));
  assert.equal(readActiveRuns().length, expected);
  assert.ok(results.every(r => !r.ok || r.active.length <= expected));
  group.forEach(c => c.stop()); await Promise.all(group.map(c => c.exited));
  assert.equal(readActiveRuns().length, 0);
  return results;
}

/* ---- G2：新舊版共存。舊版只認 active.lock：取得用 wx（acquireActiveLock），
   釋放是「標記的 runId 等於自己就刪」，下面的 legacyRelease 照抄這個邏輯。 ---- */
const markerPath = () => join(kernelStateDir(), 'active.lock');
const markerRun = () => existsSync(markerPath()) ? JSON.parse(readFileSync(markerPath(), 'utf8')).runId : null;
const legacyRecord = store => join(kernelStateDir(), 'active-runs', `${store.runId}.legacy.json`);
function legacyRelease(runId) {
  try { if (JSON.parse(readFileSync(markerPath(), 'utf8')).runId === runId) rmSync(markerPath()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
/** 舊版 launcher 開一個 run：wx 取得標記後寫入 running。 */
function legacyStart(store) { assert.equal(acquireActiveLock(store.runId).ok, true); running(store); }
function legacyEnd(store) { store.append({ type: 'state', state: 'completed' }); legacyRelease(store.runId); }

try {
  await test('F1 new reservations exclude legacy launchers until final release', async () => {
    const a = fresh(), old = fresh(), marker = join(kernelStateDir(), 'active.lock');
    await admitRun(a, () => {
      const value = JSON.parse(readFileSync(marker, 'utf8'));
      assert.deepEqual(Object.keys(value).sort(), ['at', 'runId']);
      assert.equal(value.runId, a.runId);
      assert.ok(Number.isFinite(Date.parse(value.at)));
      assert.deepEqual(acquireActiveLock(old.runId), { ok: false, heldBy: a.runId });
      running(a);
    }, { quota });
    assert.equal(acquireActiveLock(old.runId).ok, false);
    await finish(a);
    assert.equal(existsSync(marker), false);
    assert.equal(acquireActiveLock(old.runId).ok, true);
    await finish(old);
  });
  await test('F1 awaiting legacy reservation blocks admission and real cancel releases it', async () => {
    const old = fresh(), next = fresh(), marker = join(kernelStateDir(), 'active.lock');
    assert.equal(acquireActiveLock(old.runId).ok, true);
    const before = readFileSync(marker, 'utf8');
    // Approving `old` itself is not covered here: a marker naming the run being admitted, with no
    // slot file, is treated as that run's own leftover (G2b), not as an old approval window.
    for (const store of [next]) {
      await assert.rejects(admit(store), e => e.heldBy.includes(old.runId) && e.message.includes('cancel'));
      assert.equal(readFileSync(marker, 'utf8'), before);
      assert.equal(replayJournal(store.read()).state, 'awaiting_approval');
      assert.equal(existsSync(join(kernelStateDir(), 'active-runs', `${store.runId}.json`)), false);
    }
    assert.equal((await api.aiCliKernelCancel({ runId: old.runId })).state, 'cancelled');
    assert.equal(existsSync(marker), false);
    await admit(next); await finish(next);
  });
  await test('F1 legacy wx winner is preserved when new marker creation races', async () => {
    const { default: fs } = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const old = fresh(), next = fresh(), marker = join(kernelStateDir(), 'active.lock');
    const original = fs.openSync;
    let raced = false;
    fs.openSync = (path, flags, mode) => {
      if (!raced && path === marker && flags === 'wx') {
        raced = true;
        assert.equal(acquireActiveLock(old.runId).ok, true);
      }
      return original(path, flags, mode);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(admit(next), e => e.heldBy?.includes(old.runId) && e.message.includes('cancel'));
      assert.equal(raced, true);
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, old.runId);
      assert.equal(existsSync(join(kernelStateDir(), 'active-runs', `${next.runId}.json`)), false);
    } finally { fs.openSync = original; syncBuiltinESMExports(); }
    await api.aiCliKernelCancel({ runId: old.runId });
    await admit(next); await finish(next);
  });
  await test('F1 marker deduplication permits three slots and release repoints it', async () => {
    const stores = [fresh(), fresh(), fresh()], old = fresh();
    const marker = join(kernelStateDir(), 'active.lock');
    for (const store of stores) await admit(store);
    assert.equal(readActiveRuns().length, 3, 'a same-run marker must not consume a fourth place');
    await assert.rejects(admit(fresh()), e => e.reason === 'slots_full');
    const remaining = [...stores];
    while (remaining.length) {
      const marked = JSON.parse(readFileSync(marker, 'utf8')).runId;
      const index = remaining.findIndex(store => store.runId === marked);
      assert.ok(index >= 0, 'marker must point to an occupied reservation');
      await finish(remaining.splice(index, 1)[0]);
      if (remaining.length) {
        const repointed = JSON.parse(readFileSync(marker, 'utf8')).runId;
        assert.notEqual(repointed, marked);
        assert.ok(remaining.some(store => store.runId === repointed));
        assert.equal(acquireActiveLock(old.runId).ok, false);
      }
    }
    assert.equal(existsSync(marker), false);
  });
  await test('F1 acquisition rejection and release repair a deleted legacy marker', async () => {
    const a = fresh(), b = fresh(), marker = join(kernelStateDir(), 'active.lock');
    await admit(a);
    rmSync(marker); // Old releaseActiveLock can remove a compatibility marker.
    await assert.rejects(admit(fresh(a.readContract().workFolder)), e => e.reason === 'same_repo');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, a.runId);
    rmSync(marker);
    await admit(b);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, a.runId);
    rmSync(marker);
    await finish(b);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, a.runId);
    await finish(a);
  });
  await test('F1 release waits for admission critical section before changing markers', async () => {
    const { withProcessMutex } = await load('process-mutex');
    const a = fresh(), b = fresh(), marker = join(kernelStateDir(), 'active.lock');
    await admit(a); await admit(b);
    let released = false, release;
    await withProcessMutex('admission', async () => {
      release = releaseActiveLock(a.runId).then(() => { released = true; });
      const deadline = Date.now() + 10000;
      while (!released && readdirSync(join(kernelStateDir(), 'admission.tickets')).filter(f => f.endsWith('.json')).length < 3) {
        assert.ok(Date.now() < deadline, 'release must publish its admission ticket');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(released, false, 'release must wait for the current admission holder');
      assert.ok(existsSync(join(kernelStateDir(), 'active-runs', `${a.runId}.json`)));
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, a.runId);
    });
    await release;
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, b.runId);
    await finish(a); await finish(b);
  });
  await test('F1 failed starts restore remaining marker and release the last reservation', async () => {
    const marker = join(kernelStateDir(), 'active.lock');
    for (const occupied of [false, true]) {
      const holder = occupied ? fresh() : null;
      if (holder) await admit(holder);
      const failed = fresh();
      await assert.rejects(admitRun(failed, () => { throw new Error('start fixture failure'); }, { quota }), /start fixture failure/);
      assert.equal(existsSync(join(kernelStateDir(), 'active-runs', `${failed.runId}.json`)), false);
      if (holder) { assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, holder.runId); await finish(holder); }
      assert.equal(existsSync(marker), false);
    }
  });
  await test('F3 failed identity lookup retries then caches only a successful identity', async () => {
    const { createProcessIdentityReader } = await load('process-mutex');
    for (const failure of ['missing', 'empty', 'reject']) {
      let calls = 0;
      const success = { pid: process.pid, started: 'controlled-start', name: 'node' };
      const read = createProcessIdentityReader(async pids => {
        assert.deepEqual(pids, [process.pid]);
        calls++;
        if (calls > 1) return new Map([[process.pid, success]]);
        if (failure === 'reject') throw new Error('identity lookup failed');
        return failure === 'missing' ? new Map() : new Map([[process.pid, { ...success, started: '' }]]);
      });
      if (failure === 'reject') await assert.rejects(read(), /identity lookup failed/);
      else assert.equal((await read()).started, '');
      assert.deepEqual(await read(), success);
      assert.deepEqual(await read(), success);
      assert.equal(calls, 2);
    }
  });
  await test('six real processes contend for three different-repo slots', async () => {
    await race(Array.from({ length: 6 }, () => fresh(repo())), 3);
  });
  await test('five real processes contend for one common git repo', async () => {
    const dir = repo(), result = await race(Array.from({ length: 5 }, () => fresh(dir)), 1);
    assert.ok(result.filter(r => !r.ok).every(r => r.reason === 'same_repo'), JSON.stringify(result));
  });
  await test('parallel approval of the same run starts only once', async () => {
    const store = fresh(); await race([store, store], 1);
    assert.equal(store.read().filter(e => e.type === 'approved').length, 1);
  });
  await test('parallel unknown Claude/Codex quotas atomically restrict admission', async () => {
    for (const quota of [{ claude: null, codex: 80 }, { claude: 80, codex: null }]) {
      const results = await race(Array.from({ length: 3 }, () => fresh()), 1, { quota });
      const reason = quota.claude === null ? 'claude_quota' : 'codex_quota';
      assert.ok(results.filter(result => !result.ok).every(result => result.reason === reason), JSON.stringify(results));
    }
  });
  await test('worktrees and credential-free normalized clone origins share repo identity', async () => {
    const dir = repo(); git(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    const linked = join(work, 'linked'); git(dir, 'worktree', 'add', '--detach', linked, 'HEAD');
    const a = fresh(dir); await admit(a);
    await assert.rejects(admit(fresh(linked)), e => e.reason === 'same_repo'); await finish(a);
    const other = repo();
    git(dir, 'config', 'remote.origin.url', 'https://dummy:dummy-secret@EXAMPLE.invalid/org/project.git/');
    git(other, 'config', 'remote.origin.url', 'git@example.invalid:org/project');
    const b = fresh(dir); await admit(b);
    await assert.rejects(admit(fresh(other)), e => e.reason === 'same_repo' && !e.message.includes('dummy-secret'));
    assert.ok(!readFileSync(join(kernelStateDir(), 'active-runs', `${b.runId}.json`), 'utf8').includes('dummy-secret'));
    assert.equal(normalizedOrigin('ssh://git@example.invalid/org/project.git', dir), normalizedOrigin('https://user:secret@example.invalid/org/project/', dir));
    await finish(b);
  });
  await test('legacy active.lock counts once and stale/missing/terminal reservations recycle', async () => {
    const a = fresh(); running(a);
    const legacy = join(kernelStateDir(), 'active.lock');
    writeFileSync(legacy, JSON.stringify({ runId: a.runId, at: new Date().toISOString() }));
    const b = fresh(), c = fresh(); await admit(b); await admit(c);
    await assert.rejects(admit(fresh()), e => e.reason === 'slots_full' && e.heldBy.includes(a.runId));
    await finish(b); await finish(c);
    // Continue a paused legacy run, publishing a new slot without double counting the old lock.
    a.append({ type: 'state', state: 'waiting_human' }); await admit(a);
    assert.equal(readActiveRuns().filter(r => r.runId === a.runId).length, 1); await finish(a);
    for (const kind of ['missing', 'terminal', 'awaiting']) {
      const stale = fresh(); await admit(stale);
      if (kind === 'missing') rmSync(stale.dir, { recursive: true, force: true });
      if (kind === 'terminal') stale.append({ type: 'state', state: 'completed' });
      if (kind === 'awaiting') stale.append({ type: 'state', state: 'awaiting_approval' });
      const next = fresh(); await admit(next);
      assert.ok(!existsSync(join(kernelStateDir(), 'active-runs', `${stale.runId}.json`))); await finish(next);
    }
    writeFileSync(legacy, JSON.stringify({ runId: newRunId() }));
    const next = fresh(); await admit(next); assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).runId, next.runId); await finish(next);
  });
  await test('real dead admission owner and dead mutex ticket are reclaimed', async () => {
    const store = fresh(), c = child('admit', store, { crash: true });
    await c.wait('ready'); c.go(); assert.ok((await c.wait('result')).ok); c.stop(); await c.exited;
    const next = fresh(); await admit(next); assert.equal(readActiveRuns().length, 1); await finish(next);
    let entered = false;
    assert.equal(await claimRunnerSlot(store, async () => { entered = true; return true; }), false);
    assert.equal(entered, false, 'a delayed runner cannot enter after its dead admission was reclaimed');
    const holder = child('mutex-crash', fresh()); await holder.wait('ready'); holder.go(); await holder.wait('locked'); holder.stop(); await holder.exited;
    const last = fresh(); await admit(last); await finish(last);
    assert.equal(readdirSync(join(kernelStateDir(), 'admission.tickets')).filter(f => f.endsWith('.json')).length, 0);
  });
  await test('quota parser uses explicit used/remaining basis and rejects invalid data', async () => {
    const p = usage => ({ status: 'ok', usage });
    assert.equal(remainingPercentFromUsage('claude', p({ percentBasis: 'used', weekAllModelsPercent: 90 })), 10);
    assert.equal(remainingPercentFromUsage('claude', p({ weekAllModelsPercent: 1 })), null);
    for (const [basis, values, expected] of [['used', { percentUsed: 80 }, 20], ['left', { percentRemaining: 20 }, 20], ['remaining', { percentRemaining: 21 }, 21]]) {
      assert.equal(remainingPercentFromUsage('codex', p({ weekly: { basis, ...values } })), expected);
    }
    assert.equal(remainingPercentFromUsage('codex', p({ raw: 'Weekly limit: 80% used (20% left)' })), 20);
    assert.equal(remainingPercentFromUsage('codex', p({ raw: 'Weekly limit: 20% left' })), 20);
    assert.equal(remainingPercentFromUsage('codex', p({ raw: 'Weekly limit: 80% used' })), 20);
    assert.equal(remainingPercentFromUsage('codex', p({ weekly: { percentRemaining: 99 } })), null);
    for (const n of [-1, 101, NaN, Infinity, '20', null]) {
      assert.equal(remainingPercentFromUsage('claude', p({ percentBasis: 'used', weekAllModelsPercent: n })), null);
      assert.equal(remainingPercentFromUsage('codex', p({ weekly: { basis: 'used', percentUsed: n } })), null);
    }
    assert.equal(remainingPercentFromUsage('codex', p({ raw: 'Weekly limit: 10% used (20% left)' })), null);
    assert.equal(remainingPercentFromUsage('codex', { status: 'error', usage: {} }), null);
  });
  await test('Claude threshold is strictly below 10; missing/invalid/failed queries reduce to one', async () => {
    for (const value of [10, 9.999, null, undefined, NaN, Infinity, -1, 101, 'failure']) {
      const a = fresh(), b = fresh(); await admit(a);
      const deps = { quota: async agent => { if (agent !== 'claude') return 80; if (value === 'failure') throw new Error('query failed'); return value; } };
      if (value === 10) { await admit(b, deps); await finish(b); }
      else await assert.rejects(admit(b, deps), e => e.reason === 'claude_quota');
      await finish(a);
    }
  });
  await test('Codex threshold is strictly below 20 and includes decide/worker/allowed models', async () => {
    const agentFor = model => model === 'codex' ? 'codex' : 'claude';
    const models = position => ({ decide: { model: position === 'decide' ? 'codex' : 'claude' }, worker: { model: position === 'worker' ? 'codex' : 'claude' }, allowedWorkerModels: position === 'allowed' ? ['claude', 'codex'] : ['claude'] });
    for (const value of [20, 19.999, null, NaN, -1, 101, 'failure']) for (const position of ['decide', 'worker', 'allowed']) {
      const a = fresh(undefined, models('decide')), b = fresh(undefined, models(position)); await admit(a, { agentFor });
      const deps = { agentFor, quota: async agent => { if (agent !== 'codex') return 80; if (value === 'failure') throw new Error('query failed'); return value; } };
      if (value === 20) { await admit(b, deps); await finish(b); }
      else await assert.rejects(admit(b, deps), e => e.reason === 'codex_quota');
      const claude = fresh(undefined, models('none')); await admit(claude, deps); await finish(claude); await finish(a);
    }
  });
  await test('human configuration enforces 1..3 at every admission; MCP exposes no override', async () => {
    mkdirSync(kernelStateDir(), { recursive: true });
    for (const value of [0, 4, 3.1, NaN, '3', null]) assert.throws(() => validateConcurrencyConfig({ maxRuns: value }));
    const config = join(kernelStateDir(), 'concurrency.json');
    writeFileSync(config, JSON.stringify({ maxRuns: 4 })); await assert.rejects(admit(fresh()), /1～3/);
    writeFileSync(config, JSON.stringify({ maxRuns: 1 }));
    const a = fresh(); await admit(a); await assert.rejects(admit(fresh()), e => e.reason === 'slots_full'); await finish(a);
    writeFileSync(config, JSON.stringify({ maxRuns: 3, codexMinRemainingPercent: 30 }));
    const b = fresh(); await admit(b); await assert.rejects(admit(fresh(), { quota: async agent => agent === 'codex' ? 29 : 80 }), e => e.reason === 'codex_quota'); await finish(b);
    rmSync(config);
    const { aiCliKernelToolDefinitions } = await load('mcp-tools');
    const previous = process.env.AI_CLI_KERNEL;
    try {
      process.env.AI_CLI_KERNEL = 'on';
      const definitions = aiCliKernelToolDefinitions(); assert.ok(definitions.length);
      assert.ok(!JSON.stringify(definitions).includes('maxRuns'));
      assert.ok(!JSON.stringify(definitions).includes('codexMinRemainingPercent'));
      assert.ok(!JSON.stringify(definitions).includes('claudeMinRemainingPercent'));
    } finally { if (previous === undefined) delete process.env.AI_CLI_KERNEL; else process.env.AI_CLI_KERNEL = previous; }
  });
  await test('paused runs retain slots after limits fall; awaiting approval never occupies', async () => {
    const stores = [fresh(), fresh(), fresh()]; for (const store of stores) await admit(store);
    stores[0].append({ type: 'state', state: 'waiting_human' });
    writeFileSync(join(kernelStateDir(), 'concurrency.json'), JSON.stringify({ maxRuns: 1 }));
    await admit(stores[0], { quota: async () => null });
    assert.equal(readActiveRuns().length, 3);
    const pending = fresh(); assert.ok(!readActiveRuns().some(run => run.runId === pending.runId));
    await assert.rejects(admit(pending), e => e.reason === 'slots_full');
    for (const store of stores) await finish(store);
    rmSync(join(kernelStateDir(), 'concurrency.json'));
  });
  await test('quota-blocked triggers skip immediately and record holder without launching', async () => {
    const holder = fresh(); await admit(holder);
    const name = 'concurrency-quota';
    api.aiCliKernelTriggersSetEnabled(true);
    api.aiCliKernelMandateSave({ name, input: { goal: 'trigger admission fixture', workFolder: folder(), allowUnverifiedBoundary: true }, maxRunsPerDay: 10, maxInputTokensPerDay: 1000 });
    api.aiCliKernelMandateApprove({ name, acknowledgeUnisolated: true });
    for (const agent of ['claude', 'codex']) {
      let launched = false;
      const result = await api.aiCliKernelTrigger({ name }, { quota: async queried => queried === agent ? null : 80, launch: async () => { launched = true; } });
      assert.equal(result.status, 'skipped'); assert.equal(result.reason, `${agent}_quota`);
      assert.ok(result.detail.includes(holder.runId)); assert.equal(launched, false);
      assert.equal(replayJournal(new RunStore(kernelRunDir(result.runId)).read()).state, 'cancelled');
      const ledger = readFileSync(join(kernelStateDir(), 'triggers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(ledger.at(-1).reason, `${agent}_quota`);
      assert.equal(ledger.at(-1).status, 'skipped');
      assert.ok(!ledger.some(row => row.runId === result.runId && row.event === 'reserved'));
    }
    await finish(holder); api.aiCliKernelTriggersSetEnabled(false);
  });
  await test('status.active remains string|null; actions array and dashboard show all active runs', async () => {
    const stores = [fresh(), fresh(), fresh()]; for (const store of stores) await admit(store);
    const status = await api.aiCliKernelStatus(); assert.equal(typeof status.active, 'string'); assert.equal(status.activeRuns.length, 3);
    for (const item of status.activeRuns) assert.ok(item.runId && item.repo && item.models.decide && item.acquiredAt);
    const { parseSnapshot, summaryLine } = await load('dashboard-rules');
    const snap = parseSnapshot(status, false, Date.now()); assert.match(summaryLine(snap), /3 執行中/);
    const { renderDashboard } = await load('dashboard-view');
    const frame = renderDashboard({ snapshot: snap, selected: null, detail: null, pending: null, report: null, scroll: 0, notice: '', busy: false }, 160, 50);
    for (const store of stores) assert.ok(frame.text.includes(store.runId));
    const { dashboardActions } = await load('dashboard-api');
    const actions = await dashboardActions(stores[0].runId); assert.ok(Array.isArray(actions) && actions.length);
    for (const action of actions) { assert.equal(action.activeRuns.length, 3); for (const key of ['id', 'args', 'commit', 'isRelease']) assert.ok(key in action); }
    let output = ''; assert.equal(await runKernelCli(['actions', stores[0].runId, '--json'], { stdout: x => { output += x; }, stderr: x => { throw new Error(x); } }), 0);
    assert.equal(JSON.parse(output)[0].activeRuns.length, 3);
    // Real cancellation, no fake runner/worker involved.
    for (const store of stores) assert.equal((await api.aiCliKernelCancel({ runId: store.runId })).state, 'cancelled');
    assert.equal((await api.aiCliKernelStatus()).active, null);
  });
  await test('F2 mutex timeout is typed and cleans its own tickets', async () => {
    const dir = join(kernelStateDir(), 'f2-timeout.tickets'); mkdirSync(dir, { recursive: true });
    const owner = await processIdentity();
    writeFileSync(join(dir, 'holder.json'), JSON.stringify({ id: 'holder', owner, number: 0 }));
    let clock = 0;
    try {
      await assert.rejects(withProcessMutex('f2-timeout', () => assert.fail('must not enter'), {
        now: () => clock, sleep: async () => { clock += 15000; },
      }), error => error instanceof ProcessMutexBusy && error.mutex === 'f2-timeout');
      assert.deepEqual(readdirSync(dir), ['holder.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  await test('F2 busy wait retries, observes stop and propagates other errors', async () => {
    const store = fresh(); let calls = 0, stopped = false, waits = 0;
    const mutex = async (_name, work) => { if (++calls <= 2) throw new ProcessMutexBusy('test-lease'); return work(); };
    const sleep = async ms => { assert.equal(ms, 1000); waits++; };
    const lease = await waitForTestLock(store, () => false, () => {}, { mutex, sleep });
    assert.ok(lease); assert.equal(calls, 3); assert.equal(waits, 2); await lease.release();
    calls = 0;
    assert.equal(await waitForTestLock(store, () => stopped, () => {}, {
      mutex: async () => { calls++; throw new ProcessMutexBusy('test-lease'); },
      sleep: async ms => { assert.equal(ms, 1000); stopped = true; },
    }), null);
    assert.equal(calls, 1); assert.ok(!existsSync(join(kernelStateDir(), 'test.lock')));
    const other = new Error('disk unavailable');
    await assert.rejects(waitForTestLock(store, () => false, () => {}, { mutex: async () => { throw other; } }), error => error === other);
    // Cancellation that arrives while the critical section is executing leaves no owned lease.
    stopped = false;
    assert.equal(await waitForTestLock(store, () => stopped, () => {}, {
      mutex: async (_name, work) => { const result = await work(); stopped = true; return result; },
    }), null);
    assert.ok(!existsSync(join(kernelStateDir(), 'test.lock')));
  });
  await test('F2 release busy defers in journal without failing a passed check', async () => {
    const store = fresh(); let busy = false, calls = 0, sleeps = 0;
    const deps = { mutex: async (_name, work) => { calls++; if (busy) throw new ProcessMutexBusy('test-lease'); return work(); }, sleep: async ms => { assert.equal(ms, 1000); sleeps++; } };
    const lease = await waitForTestLock(store, () => false, () => {}, deps);
    await lease.command({ pid: 99999999, started: 'ended', name: 'node' });
    busy = true; calls = 0;
    async function passedCheck() { try { return { passed: true }; } finally { await lease.release(); } }
    assert.deepEqual(await passedCheck(), { passed: true }); assert.equal(calls, 3); assert.equal(sleeps, 2);
    assert.equal(store.read().filter(e => e.type === 'test_lock_release_deferred').length, 1);
    assert.ok(existsSync(join(kernelStateDir(), 'test.lock')));
    // The stopped command identity permits the next contender to reclaim immediately.
    const successor = await waitForTestLock(fresh(), () => false, () => {}, { mayBeAlive: () => false });
    assert.ok(successor); await successor.release();
    calls = 0; await releaseStoppedTestLock(store.runId, deps); assert.equal(calls, 3);
    const error = new Error('release disk error');
    busy = false;
    const releaseError = await waitForTestLock(store, () => false, () => {}, { mutex: async (_name, work) => { if (busy) throw error; return work(); } });
    busy = true; await assert.rejects(releaseError.release(), e => e === error);
    busy = false; await releaseError.release();
  });
  await test('F2 command retries are bounded and preserve successor ownership', async () => {
    const store = fresh(); let busyLeft = 0, calls = 0, sleeps = 0;
    const deps = { mutex: async (_name, work) => { calls++; if (busyLeft-- > 0) throw new ProcessMutexBusy('test-lease'); return work(); }, sleep: async ms => { assert.equal(ms, 1000); sleeps++; } };
    const lease = await waitForTestLock(store, () => false, () => {}, deps);
    const identity = { pid: 99999999, started: 'command', name: 'node' };
    busyLeft = 2; calls = 0; await lease.command(identity); assert.equal(calls, 3); assert.equal(sleeps, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(kernelStateDir(), 'test.lock'), 'utf8')).command, identity);
    busyLeft = 10; calls = 0; sleeps = 0;
    await assert.rejects(lease.command(identity), ProcessMutexBusy); assert.equal(calls, 3); assert.equal(sleeps, 2);
    busyLeft = 0;
    const successor = { runId: 'successor', token: 'successor', owner: identity };
    writeFileSync(join(kernelStateDir(), 'test.lock'), JSON.stringify(successor));
    await lease.command(identity); await lease.release();
    assert.deepEqual(JSON.parse(readFileSync(join(kernelStateDir(), 'test.lock'), 'utf8')), successor);
    rmSync(join(kernelStateDir(), 'test.lock'));
    const unregistered = await waitForTestLock(store, () => false, () => {}, deps);
    writeFileSync(join(kernelStateDir(), 'test.lock'), JSON.stringify(successor));
    await assert.rejects(unregistered.command(identity), /測試鎖所有權已變動/);
    await unregistered.release(); assert.deepEqual(JSON.parse(readFileSync(join(kernelStateDir(), 'test.lock'), 'utf8')), successor);
    rmSync(join(kernelStateDir(), 'test.lock'));
    let ioError = false; const error = new Error('command disk error');
    const broken = await waitForTestLock(store, () => false, () => {}, { mutex: async (_name, work) => { if (ioError) throw error; return work(); } });
    ioError = true; await assert.rejects(broken.command(identity), e => e === error);
    ioError = false; await broken.release();
  });
  await test('F2 runner claim retries are bounded and keep the slot fence', async () => {
    await clear(); const store = fresh(); await admit(store);
    let busyLeft = 2, calls = 0, claims = 0, sleeps = 0;
    const deps = { mutex: async (_name, work) => { calls++; if (busyLeft-- > 0) throw new ProcessMutexBusy('admission'); return work(); }, sleep: async ms => { assert.equal(ms, 1000); sleeps++; } };
    assert.equal(await claimRunnerSlot(store, async () => { claims++; return true; }, deps), true);
    assert.equal(calls, 3); assert.equal(claims, 1); assert.equal(sleeps, 2);
    calls = 0; sleeps = 0; busyLeft = 9;
    await assert.rejects(claimRunnerSlot(store, async () => { claims++; return true; }, deps), ProcessMutexBusy);
    assert.equal(calls, 3); assert.equal(sleeps, 2); assert.equal(claims, 1);
    busyLeft = 1; await finish(store);
    assert.equal(await claimRunnerSlot(store, async () => assert.fail('reclaimed slot must fence runner'), deps), false);
    const other = new Error('admission disk error'); calls = 0;
    await assert.rejects(claimRunnerSlot(store, async () => true, { mutex: async () => { calls++; throw other; } }), e => e === other);
    assert.equal(calls, 1);
  });
  await test('F2 lease identity checks throttle, detect death, token changes and PID reuse', async () => {
    const path = join(kernelStateDir(), 'test.lock'); mkdirSync(kernelStateDir(), { recursive: true });
    const held = { runId: 'holder', token: 'holder-1', owner: { pid: 12345, started: 'owner', name: 'node' } };
    const put = () => writeFileSync(path, JSON.stringify(held));
    let now = 0, full = 0, cheap = 0, sleeps = 0;
    put();
    assert.equal(await waitForTestLock(fresh(), () => sleeps >= 61, () => {}, {
      now: () => now, mayBeAlive: () => { cheap++; return true; }, identityAlive: async () => { full++; return true; },
      sleep: async ms => { assert.equal(ms, 1000); now += ms; sleeps++; },
    }), null);
    assert.equal(full, 3); assert.equal(cheap, 61);
    // kill(0) detects death at the next 1s poll without another full lookup.
    now = 0; full = 0; put();
    const dead = await waitForTestLock(fresh(), () => false, () => {}, {
      now: () => now, mayBeAlive: () => now === 0, identityAlive: async () => { full++; return true; }, sleep: async ms => { now += ms; assert.ok(now <= 1000, 'death must be detected next poll'); },
    });
    assert.ok(dead); assert.equal(now, 1000); assert.equal(full, 1); await dead.release();
    now = 0; full = 0; put();
    const reused = await waitForTestLock(fresh(), () => false, () => {}, {
      now: () => now, mayBeAlive: () => true, identityAlive: async () => { full++; return now < 30000; },
      sleep: async ms => { now += ms; assert.ok(now <= 30000, 'PID reuse must be caught at 30s'); },
    });
    assert.ok(reused); assert.equal(now, 30000); assert.equal(full, 2); await reused.release();
    for (const change of ['token', 'command']) {
      now = 0; full = 0; delete held.command; put();
      const changed = await waitForTestLock(fresh(), () => false, () => {}, {
        now: () => now, mayBeAlive: () => true, identityAlive: async () => { full++; return now === 0; },
        sleep: async ms => { now += ms; assert.equal(now, 1000); if (change === 'token') held.token += '-next'; else held.command = { pid: 23456, started: 'command', name: 'node' }; put(); },
      });
      assert.ok(changed); assert.equal(full, 2); await changed.release();
    }
  });
  await test('setup/test child processes exclude each other, cancellation while waiting is harmless', async () => {
    const control = folder(), a = fresh(), b = fresh();
    const first = child('lease', a, { control, kind: 'setup' }); await first.wait('ready'); first.go(); await first.wait('command');
    const second = child('lease', b, { control, kind: 'test' }); await second.wait('ready'); second.go();
    assert.equal((await second.wait('wait')).heldBy, a.runId);
    assert.ok(!existsSync(join(control, `started-${b.runId}`)));
    writeFileSync(join(control, `release-${a.runId}`), 'go'); assert.equal((await first.wait('result')).exitCode, 0); await first.exited;
    await second.wait('command'); writeFileSync(join(control, `release-${b.runId}`), 'go'); assert.equal((await second.wait('result')).exitCode, 0); await second.exited;
    assert.ok(!existsSync(join(control, 'overlap'))); assert.ok(!existsSync(join(kernelStateDir(), 'test.lock')));
    const held = await waitForTestLock(a, () => false, () => {});
    const cancelled = child('lease', fresh(), { control }); await cancelled.wait('ready'); cancelled.go(); await cancelled.wait('wait'); cancelled.store.requestCancel();
    assert.ok((await cancelled.wait('result')).cancelled); await cancelled.exited; await held.release();
    const live = child('lease', fresh(), { control, cancel: true }); await live.wait('ready'); live.go(); await live.wait('command');
    const commandPid = JSON.parse(readFileSync(join(control, 'busy'), 'utf8')).pid;
    live.stop(); assert.equal((await live.wait('result')).stopped, true); await live.exited;
    assert.throws(() => process.kill(commandPid, 0), /ESRCH/);
    assert.ok(!existsSync(join(kernelStateDir(), 'test.lock')));
  });
  await test('dead runner retains lease while real command lives, then reclaims dead identities', async () => {
    const control = folder(), a = fresh(), first = child('lease', a, { control, crash: true });
    await first.wait('ready'); first.go(); const marker = await first.wait('command');
    const { identityAlive } = await load('process-mutex');
    assert.ok(await identityAlive(marker.lease.command), `command identity not live before crash: ${JSON.stringify(marker.lease)}`);
    first.stop(); await first.exited;
    assert.ok(await identityAlive(marker.lease.command), `supervisor disappeared after owner crash: ${JSON.stringify(marker.lease)}`);
    const second = child('lease', fresh(), { control }); await second.wait('ready'); second.go(); assert.equal((await second.wait('wait')).heldBy, a.runId);
    writeFileSync(join(control, `release-${a.runId}`), 'go'); await second.wait('command');
    writeFileSync(join(control, `release-${second.store.runId}`), 'go'); assert.equal((await second.wait('result')).exitCode, 0); await second.exited;
    assert.ok(!existsSync(join(control, 'overlap')));
    writeFileSync(join(kernelStateDir(), 'test.lock'), JSON.stringify({ runId: a.runId, token: 'dead', owner: { pid: 99999999, started: 'dead', name: 'node' } }));
    const lease = await waitForTestLock(a, () => false, () => {}); assert.ok(lease); await lease.release();
    // PID reused: identity differs even though the pid is live.
    writeFileSync(join(kernelStateDir(), 'test.lock'), JSON.stringify({ runId: a.runId, token: 'reused', owner: { pid: process.pid, started: 'not-this-process', name: 'node' } }));
    const reused = await waitForTestLock(a, () => false, () => {}); assert.ok(reused); await reused.release();
  });
  await test('production loop journals waiting/status, excludes wait from deadlines, releases on success/failure/timeout', async () => {
    const holder = fresh(), lease = await waitForTestLock(holder, () => false, () => {});
    const dir = repo(); git(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    function loopStore(options = {}) {
      const runId = newRunId();
      const contract = buildContract({ goal: 'check lock wait', workFolder: dir, template: 'develop', testCommand: 'fake-test', checkpoint: 'off', budget: { maxActionMinutes: 0.002, maxWallMinutes: 10, maxTestFailures: 1, maxDecides: 1 }, ...options }, new Date(), { runId, worktree: dir });
      const store = new RunStore(kernelRunDir(runId)); store.create(contract); running(store);
      if (!options.setupCommand) store.append({ type: 'workspace_ready', head: 'head' });
      store.append({ type: 'action_intent', action: { actionId: 'a1', kind: 'decide', model: contract.decide.model, prompt: 'fixture', marker: 'fixture' } });
      store.append({ type: 'action_result', actionId: 'a1', outcome: { ok: true, usage: { input: 0, output: 0, cached: 0 } } });
      store.append({ type: 'decide_processed', actionId: 'a1', ok: true, decision: 'plan', plan: { planId: 'p1', steps: [] } });
      return store;
    }
    const store = loopStore(), c = child('loop', store); await c.wait('ready'); c.go();
    // Synchronize on the real journal event, not an assumed process-start sleep.
    const until = async predicate => { const end = Date.now() + 20000; while (!predicate()) { if (Date.now() > end) throw new Error('journal barrier timeout'); await new Promise(r => setTimeout(r, 10)); } };
    await until(() => store.read().some(e => e.type === 'test_lock_wait'));
    assert.match((await api.aiCliKernelStatus({ runId: store.runId })).stateLabel, new RegExp(`等測試鎖.*${holder.runId}`));
    // A measured >120ms lock wait must not consume the command's 120ms timeout.
    const began = Date.now(); await until(() => Date.now() - began > 250); await lease.release();
    const result = await c.wait('result'); await c.exited;
    assert.ok(result.verification?.passed && !result.verification.timedOut && result.testFailures === 0, JSON.stringify(result));
    assert.ok(store.read().some(e => e.type === 'test_lock_acquired'));
    assert.equal(replayJournal(store.read()).testLockWaiting, null);
    for (const extra of [{ exitCode: 7 }, { timeout: true }]) {
      const failing = child('loop', loopStore(), extra); await failing.wait('ready'); failing.go(); const r = await failing.wait('result'); await failing.exited;
      assert.equal(r.testFailures, 1); assert.equal(r.verification.timedOut, !!extra.timeout); assert.ok(!existsSync(join(kernelStateDir(), 'test.lock')));
    }
    const setupHeld = await waitForTestLock(holder, () => false, () => {});
    const setupStore = loopStore({ setupCommand: 'fake-setup' }), setup = child('loop', setupStore);
    await setup.wait('ready'); setup.go();
    await until(() => setupStore.read().some(e => e.type === 'test_lock_wait'));
    assert.equal(setup.messages.filter(message => message.type === 'command').length, 0, 'production setup must wait on the same test lease');
    await setupHeld.release();
    const prepared = await setup.wait('result'); await setup.exited;
    assert.equal(prepared.starts, 2); assert.equal(prepared.verification.passed, true);
    assert.deepEqual([...new Set(setupStore.read().filter(e => e.type === 'check_started').map(e => e.kind))], ['setup', 'test']);
    assert.ok(!existsSync(join(kernelStateDir(), 'test.lock')));
    const cancelHeld = await waitForTestLock(holder, () => false, () => {});
    const cancelledStore = loopStore(), cancelled = child('loop', cancelledStore);
    await cancelled.wait('ready'); cancelled.go();
    await until(() => cancelledStore.read().some(e => e.type === 'test_lock_wait'));
    cancelledStore.requestCancel();
    const stopped = await cancelled.wait('result'); await cancelled.exited;
    assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.starts, 0); assert.equal(stopped.testFailures, 0);
    assert.ok(!cancelledStore.read().some(e => e.type === 'test_lock_acquired'), 'cancelled wait must not claim an acquisition');
    assert.equal(JSON.parse(readFileSync(join(kernelStateDir(), 'test.lock'), 'utf8')).runId, holder.runId);
    await cancelHeld.release();
    const events = store.read(), waiting = events.find(e => e.type === 'test_lock_wait'), acquired = events.find(e => e.type === 'test_lock_acquired');
    const terminalEvent = events.findLast(e => e.type === 'state' && e.state !== 'running');
    const expectedMs = Date.parse(terminalEvent.at) - Date.parse(events.find(e => e.type === 'runner_started').at)
      - (Date.parse(acquired.at) - Date.parse(waiting.at));
    const elapsed = activeMinutes(replayJournal(events), Date.parse(terminalEvent.at)) * 60000;
    assert.ok(Math.abs(elapsed - expectedMs) < 1, `active budget ${elapsed}ms must exclude the recorded lock wait; expected ${expectedMs}ms`);
  });
  await test('G1 busy slot release keeps delivered runs terminal and journals slot_release_failed', async () => {
    await clear();
    const { settleRunnerRun } = await load('runner-settle');
    const dir = folder(), slotFile = store => join(kernelStateDir(), 'active-runs', `${store.runId}.json`);
    let calls = 0, sleeps = 0;
    const busy = { mutex: async () => { calls++; throw new ProcessMutexBusy('admission'); }, sleep: async ms => { assert.equal(ms, 1000); sleeps++; } };
    const noKill = { kill: async () => assert.fail('no open action to kill') };
    for (const terminal of ['completed', 'failed', 'cancelled']) {
      const store = fresh(dir); await admit(store); calls = 0; sleeps = 0;
      const state = await settleRunnerRun(store, noKill, async () => { store.append({ type: 'state', state: terminal }); return terminal; }, runId => releaseActiveLock(runId, { deps: busy }));
      assert.equal(state, terminal); assert.equal(calls, 3); assert.equal(sleeps, 2);
      const events = store.read();
      assert.equal(replayJournal(events).state, terminal, 'busy release must not rewrite the terminal state');
      assert.ok(!events.some(e => e.type === 'state' && e.reason === 'kernel_error'), 'busy release is not a kernel_error');
      assert.equal(events.filter(e => e.type === 'slot_release_failed').length, 1); assert.equal(events.at(-1).type, 'slot_release_failed');
      assert.ok(existsSync(slotFile(store)), 'busy release leaves the slot file behind');
      // A later admission for the SAME repo reclaims the slot that points at a terminal run.
      const next = fresh(dir); await admit(next);
      assert.ok(!existsSync(slotFile(store)), 'admission reclaims slots of terminal runs');
      assert.deepEqual(readActiveRuns().map(run => run.runId), [next.runId]); await finish(next);
    }
    // The real admission mutex held by another live ticket (fast clock) takes the same busy path.
    const tickets = join(kernelStateDir(), 'admission.tickets'); mkdirSync(tickets, { recursive: true });
    const holder = join(tickets, 'g1-holder.json');
    const held = fresh(dir); await admit(held); let clock = 0;
    writeFileSync(holder, JSON.stringify({ id: 'g1-holder', owner: await processIdentity(), number: 0 }));
    try {
      const realBusy = { mutex: (name, work) => withProcessMutex(name, work, { now: () => clock, sleep: async () => { clock += 15000; } }), sleep: async () => {} };
      assert.equal(await settleRunnerRun(held, noKill, async () => { held.append({ type: 'state', state: 'completed' }); return 'completed'; }, runId => releaseActiveLock(runId, { deps: realBusy })), 'completed');
      assert.equal(replayJournal(held.read()).state, 'completed'); assert.equal(held.read().at(-1).type, 'slot_release_failed');
      assert.ok(existsSync(slotFile(held)));
    } finally { rmSync(holder, { force: true }); }
    const reclaimer = fresh(dir); await admit(reclaimer); assert.ok(!existsSync(slotFile(held))); await finish(reclaimer);
    // Only a real program error from the loop becomes failed/kernel_error; the slot is still released.
    const broken = fresh(dir); await admit(broken);
    assert.equal(await settleRunnerRun(broken, noKill, async () => { throw new Error('loop bug'); }), 'failed');
    assert.equal(replayJournal(broken.read()).reason, 'kernel_error'); assert.ok(!existsSync(slotFile(broken)));
    // Non-busy release errors propagate but never rewrite the delivered state.
    const ioStore = fresh(dir); await admit(ioStore); const io = new Error('slot disk error');
    await assert.rejects(settleRunnerRun(ioStore, noKill, async () => { ioStore.append({ type: 'state', state: 'completed' }); return 'completed'; },
      runId => releaseActiveLock(runId, { deps: { mutex: async () => { throw io; } } })), e => e === io);
    assert.equal(replayJournal(ioStore.read()).state, 'completed');
    assert.ok(!ioStore.read().some(e => e.type === 'slot_release_failed')); await releaseActiveLock(ioStore.runId);
  });
  await test('G1 cancel stays cancelled when slot release is busy', async () => {
    await clear();
    const busy = { mutex: async () => { throw new ProcessMutexBusy('admission'); }, sleep: async () => {} };
    const store = fresh(); await admit(store);
    const status = await api.aiCliKernelCancel({ runId: store.runId }, { release: busy });
    assert.equal(status.state, 'cancelled'); assert.match(status.detail, /admission 會回收/);
    assert.equal(store.read().filter(e => e.type === 'slot_release_failed').length, 1);
    // Cancelling an already terminal run with a busy release is not a failure either.
    const again = await api.aiCliKernelCancel({ runId: store.runId }, { release: busy });
    assert.equal(again.state, 'cancelled'); assert.match(again.detail, /admission 會回收/);
    assert.ok(existsSync(join(kernelStateDir(), 'active-runs', `${store.runId}.json`)));
    const next = fresh(); await admit(next);
    assert.deepEqual(readActiveRuns().map(run => run.runId), [next.runId]);
    assert.ok(!existsSync(join(kernelStateDir(), 'active-runs', `${store.runId}.json`)));
    const quiet = await api.aiCliKernelCancel({ runId: next.runId });
    assert.equal(quiet.state, 'cancelled'); assert.doesNotMatch(String(quiet.detail), /admission 會回收/);
  });
  await test('G3 failed runner launch releases the slot and approve resumes the interrupted run', async () => {
    await clear();
    const slotFile = store => join(kernelStateDir(), 'active-runs', `${store.runId}.json`);
    const store = fresh(), failure = new Error('launcher 結束碼 1');
    await assert.rejects(api.aiCliKernelApprove({ runId: store.runId }, { quota, launch: async () => { throw failure; } }), e => e === failure);
    assert.ok(!existsSync(slotFile(store)), 'failed launch releases its slot'); assert.equal(readActiveRuns().length, 0);
    assert.equal(replayJournal(store.read()).state, 'running');
    assert.equal((await api.aiCliKernelStatus({ runId: store.runId })).effectiveState, 'interrupted');
    // A late runner is fenced by claimRunnerSlot.
    assert.equal(await claimRunnerSlot(store, async () => assert.fail('late runner must be fenced')), false);
    let launches = 0;
    const resumed = await api.aiCliKernelApprove({ runId: store.runId }, { quota, launch: async () => { launches++; } });
    assert.equal(launches, 1); assert.equal(resumed.state, 'running');
    assert.equal(store.read().filter(e => e.type === 'approved').at(-1).kind, 'continue');
    assert.deepEqual(readActiveRuns().map(run => run.runId), [store.runId]); await finish(store);
    // A runner that already claimed the slot (live runner.json) keeps it.
    const claimed = fresh();
    await assert.rejects(api.aiCliKernelApprove({ runId: claimed.runId }, { quota, launch: async () => {
      writeFileSync(claimed.runnerPath, JSON.stringify(await processIdentity())); throw failure;
    } }), e => e === failure);
    assert.ok(existsSync(slotFile(claimed)), 'a live runner keeps its slot'); rmSync(claimed.runnerPath); await finish(claimed);
    // Busy release after a failed launch is journaled and never masks the launch error.
    const busyStore = fresh();
    await assert.rejects(api.aiCliKernelApprove({ runId: busyStore.runId }, { quota, launch: async () => { throw failure; },
      release: { mutex: async () => { throw new ProcessMutexBusy('admission'); }, sleep: async () => {} } }), e => e === failure);
    assert.equal(busyStore.read().filter(e => e.type === 'slot_release_failed').length, 1);
    assert.ok(existsSync(slotFile(busyStore)));
    const own = await api.aiCliKernelApprove({ runId: busyStore.runId }, { quota, launch: async () => {} });
    assert.equal(own.state, 'running'); await finish(busyStore);
  });
  await test('G2 legacy-held marker moves to a new slot so the old release leaves no gap', async () => {
    const legacy = fresh(), next = fresh(), late = fresh();
    legacyStart(legacy);
    await admit(next);
    assert.equal(markerRun(), next.runId, 'marker must name a new-format slot while one exists');
    assert.ok(existsSync(legacyRecord(legacy)), 'the legacy run is recorded as its own reservation');
    assert.deepEqual(readActiveRuns().map(run => run.runId).sort(), [legacy.runId, next.runId].sort());
    legacyEnd(legacy); // old release: runId differs, so the marker survives
    assert.equal(markerRun(), next.runId);
    assert.equal(acquireActiveLock(late.runId).ok, false, 'old launchers stay excluded while a new slot exists');
    await finish(next);
    assert.equal(existsSync(legacyRecord(legacy)), false, 'a terminal legacy record is reclaimed');
    assert.equal(existsSync(markerPath()), false);
    await finish(late);
  });
  await test('G2 legacy record counts toward the cap and same repo, unknown repo blocks every repo', async () => {
    const dir = repo(), legacy = fresh(dir), a = fresh(), b = fresh();
    legacyStart(legacy);
    await admit(a);
    await assert.rejects(admit(fresh(dir)), e => e.reason === 'same_repo' && e.heldBy.includes(legacy.runId));
    await admit(b);
    await assert.rejects(admit(fresh()), e => e.reason === 'slots_full' && e.heldBy.includes(legacy.runId));
    legacyEnd(legacy);
    const sameRepo = fresh(dir); await admit(sameRepo); // the repo frees up once the legacy run ends
    await finish(sameRepo); await finish(a); await finish(b);
    assert.equal(existsSync(legacyRecord(legacy)), false);
    // A develop run whose repoRoot is not a git repo: its repo identity cannot be determined.
    const unknown = fresh(folder(), { develop: { repoRoot: folder() } }), blocked = fresh();
    legacyStart(unknown);
    await assert.rejects(admit(blocked), e => e.reason === 'same_repo' && e.heldBy.includes(unknown.runId));
    assert.equal(markerRun(), unknown.runId, 'without new slots the marker points back at the live legacy run');
    legacyEnd(unknown);
    await admit(blocked); await finish(blocked);
    assert.equal(existsSync(legacyRecord(unknown)), false);
    assert.equal(existsSync(markerPath()), false);
  });
  await test('G2a last release reclaims a marker naming a terminal or missing run', async () => {
    for (const kind of ['terminal', 'missing']) {
      // e.g. an old cancel deleted the marker, an old launcher took it and then died without releasing.
      const holder = fresh(), stale = fresh(), late = fresh();
      running(stale);
      await admit(holder);
      if (kind === 'terminal') stale.append({ type: 'state', state: 'completed' });
      else rmSync(stale.dir, { recursive: true, force: true });
      writeFileSync(markerPath(), JSON.stringify({ runId: stale.runId, at: new Date().toISOString() }));
      await finish(holder);
      assert.equal(existsSync(markerPath()), false, `${kind} marker must be reclaimed by the last release`);
      assert.equal(acquireActiveLock(late.runId).ok, true);
      legacyRelease(late.runId); await finish(late);
    }
  });
  await test('G2b own marker left before the slot write is not mistaken for a legacy approval', async () => {
    const own = fresh();
    writeFileSync(markerPath(), JSON.stringify({ runId: own.runId, at: new Date().toISOString() }));
    await admit(own);
    assert.equal(markerRun(), own.runId);
    assert.ok(existsSync(join(kernelStateDir(), 'active-runs', `${own.runId}.json`)));
    assert.deepEqual(readActiveRuns().map(run => run.runId), [own.runId]);
    await finish(own);
    assert.equal(existsSync(markerPath()), false);
  });
  await test('G2c repointing never overwrites an old launcher that won wx after the read', async () => {
    const { default: fs } = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const legacy = fresh(), racer = fresh(), next = fresh(), late = fresh();
    legacyStart(legacy);
    const original = fs.renameSync;
    let raced = false;
    // Between our read (legacy) and our move: the old run ends and releases, an old launcher wins wx.
    fs.renameSync = (from, to) => {
      if (!raced && from === markerPath()) { raced = true; legacyEnd(legacy); assert.equal(acquireActiveLock(racer.runId).ok, true); }
      return original(from, to);
    };
    syncBuiltinESMExports();
    try { await admit(next); }
    finally { fs.renameSync = original; syncBuiltinESMExports(); }
    assert.equal(raced, true);
    assert.equal(markerRun(), next.runId, 'confirmed by re-reading after the write');
    assert.ok(existsSync(legacyRecord(racer)), 'the displaced old launcher is recorded, not lost');
    assert.ok(readActiveRuns().some(run => run.runId === racer.runId));
    running(racer); legacyEnd(racer);
    assert.equal(markerRun(), next.runId);
    assert.equal(acquireActiveLock(late.runId).ok, false);
    await finish(next);
    assert.equal(existsSync(legacyRecord(racer)), false);
    assert.equal(existsSync(markerPath()), false);
    await finish(late);
  });
  /* ---- H1：新版名額之間改指向用原子覆蓋，active.lock 全程存在。 ---- */
  /** 在 fs 每一步之前插入「舊版 launcher 用 wx 搶 active.lock」，回傳搶到的步驟（應該一個都沒有）。 */
  async function withLegacyProbe(racer, work) {
    const { default: fs } = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const names = ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'rmSync', 'readFileSync', 'existsSync', 'readdirSync', 'mkdirSync'];
    const originals = Object.fromEntries(names.map(name => [name, fs[name]]));
    const leaks = [];
    let inside = false, probes = 0, overwrites = 0;
    for (const name of names) {
      fs[name] = (...args) => {
        if (!inside) {
          inside = true;
          try {
            probes++;
            if (acquireActiveLock(racer.runId).ok) { leaks.push(`${name}(${String(args[0]).split(/[\\/]/).pop()})`); legacyRelease(racer.runId); }
          } finally { inside = false; }
          if (name === 'renameSync' && args[1] === markerPath()) overwrites++;
        }
        return originals[name](...args);
      };
    }
    syncBuiltinESMExports();
    try { await work(); }
    finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
    return { leaks, probes, overwrites };
  }
  await test('H1 repointing between new-format slots never leaves active.lock missing', async () => {
    // (1) releasing the slot the marker names while another slot remains.
    const a = fresh(), b = fresh(), racer = fresh();
    await admit(a); await admit(b);
    assert.equal(markerRun(), a.runId);
    a.append({ type: 'state', state: 'cancelled' });
    const release = await withLegacyProbe(racer, () => releaseActiveLock(a.runId));
    assert.deepEqual(release.leaks, [], 'an old launcher never wins wx while the marker moves from A to B');
    assert.ok(release.probes > 10 && release.overwrites >= 1, JSON.stringify(release));
    assert.equal(markerRun(), b.runId);
    // (2) admission reclaiming the stale slot the marker names (terminal run whose release never ran).
    const c = fresh();
    b.append({ type: 'state', state: 'completed' });
    const admission = await withLegacyProbe(racer, () => admit(c));
    assert.deepEqual(admission.leaks, [], 'an old launcher never wins wx while the marker moves off a reclaimed slot');
    assert.ok(admission.overwrites >= 1, JSON.stringify(admission));
    assert.equal(markerRun(), c.runId);
    assert.equal(acquireActiveLock(racer.runId).ok, false);
    await finish(c);
    assert.equal(existsSync(markerPath()), false);
    assert.equal(acquireActiveLock(racer.runId).ok, true); legacyRelease(racer.runId); await finish(racer);
  });
  await test('H1 marker overwrite retries EPERM and raises a recognizable error when it persists', async () => {
    const { default: fs } = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const original = fs.renameSync;
    const strays = () => readdirSync(kernelStateDir()).filter(file => /^active\.lock\..*\.tmp$/.test(file));
    const failing = times => {
      let calls = 0;
      fs.renameSync = (from, to) => {
        if (to === markerPath() && calls++ < times) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
        return original(from, to);
      };
      syncBuiltinESMExports();
      return () => calls;
    };
    const restore = () => { fs.renameSync = original; syncBuiltinESMExports(); };
    // Transient: two EPERMs, then the overwrite lands.
    const a = fresh(), b = fresh(), late = fresh();
    await admit(a); await admit(b);
    a.append({ type: 'state', state: 'cancelled' });
    let calls = failing(2);
    try { await releaseActiveLock(a.runId); } finally { restore(); }
    assert.equal(calls(), 3, 'retried after transient EPERM');
    assert.equal(markerRun(), b.runId);
    // Persistent: bounded retries, then a recognizable error; the marker is never left missing.
    const c = fresh();
    await admit(c);
    b.append({ type: 'state', state: 'cancelled' });
    calls = failing(Infinity);
    let caught;
    try { await releaseActiveLock(b.runId); } catch (error) { caught = error; } finally { restore(); }
    assert.ok(caught instanceof LegacyMarkerReplaceFailed, `expected LegacyMarkerReplaceFailed, got ${caught}`);
    assert.equal(caught.code, 'KERNEL_LEGACY_MARKER_REPLACE_FAILED');
    assert.ok(calls() > 1 && caught.attempts === calls(), `bounded retries: ${calls()}`);
    assert.equal(markerRun(), b.runId, 'the previous marker stays in place');
    assert.equal(acquireActiveLock(late.runId).ok, false);
    assert.deepEqual(strays(), [], 'the temp file is removed on failure');
    // The stale marker (B is terminal) is reclaimed by the next coordination; here the last release.
    await finish(c);
    assert.equal(existsSync(markerPath()), false);
    await finish(late);
  });

  /* ---- H2：runner 定期補標記，縮短舊版「先讀後刪」造成沒有標記的時間。 ---- */
  await test('H2 marker check restores a deleted marker to a new-format slot', async () => {
    const a = fresh(), late = fresh();
    await admit(a);
    rmSync(markerPath()); // an old release read its own runId, then deleted ours after we repointed
    assert.equal(acquireActiveLock(late.runId).ok, true); legacyRelease(late.runId); // the gap is real
    assert.equal(await ensureLegacyMarker(a), 'repaired');
    assert.equal(markerRun(), a.runId);
    assert.equal(acquireActiveLock(late.runId).ok, false);
    assert.equal(replayJournal(a.read()).state, 'running');
    await finish(a); await finish(late);
    assert.equal(existsSync(markerPath()), false);
  });
  await test('H2 marker check skips a busy mutex and never fails the run', async () => {
    const a = fresh();
    await admit(a);
    rmSync(markerPath());
    const before = a.read().length;
    assert.equal(await ensureLegacyMarker(a, { mutex: async () => { throw new ProcessMutexBusy('admission'); } }), 'busy');
    assert.equal(a.read().length, before, 'busy is skipped silently');
    assert.equal(existsSync(markerPath()), false);
    assert.equal(await ensureLegacyMarker(a, { mutex: async () => { throw new Error('disk on fire'); } }), 'failed');
    const events = a.read();
    assert.equal(events.length, before + 1);
    assert.equal(events.at(-1).type, 'legacy_marker_check_failed');
    assert.ok(!events.slice(before).some(event => event.type === 'state'));
    assert.equal(replayJournal(a.read()).state, 'running');
    assert.equal(await ensureLegacyMarker(a), 'repaired');
    assert.equal(markerRun(), a.runId);
    await finish(a);
  });
  await test('H2 healthy marker never enters the admission mutex', async () => {
    let entered = 0;
    const counting = { mutex: (name, work) => { entered++; return withProcessMutex(name, work); } };
    const a = fresh();
    assert.equal(await ensureLegacyMarker(a, counting), 'ok', 'no new-format slot');
    await admit(a);
    assert.equal(await ensureLegacyMarker(a, counting), 'ok');
    assert.equal(entered, 0, 'a marker naming a new-format slot is checked without the mutex');
    rmSync(markerPath());
    assert.equal(await ensureLegacyMarker(a, counting), 'repaired');
    assert.equal(entered, 1, 'the counter does see a repair');
    await finish(a);
  });
  await test('H2 runner watch repeats the check until stopped', async () => {
    const a = fresh();
    let calls = 0;
    const stop = startLegacyMarkerWatch(a, 20, async store => { assert.equal(store, a); calls++; });
    // Poll instead of a fixed sleep: done as soon as two checks ran, bounded so a stuck watch still fails.
    for (const until = Date.now() + 5000; calls < 2 && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 10));
    stop();
    const seen = calls;
    assert.ok(seen >= 2, `checked ${seen} times`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls, seen, 'no check after stop');
  });

  /* ---- H3：catch 路徑把舊版 awaiting_approval 標記改指向新版名額（行為不改，只驗證取捨）。 ---- */
  await test('H3 refused approval behind an awaiting legacy marker keeps the legacy run counted', async () => {
    const dir = repo(), b = fresh(), legacy = fresh(dir), x = fresh(), sameRepo = fresh(dir);
    await admit(b);
    // The old release deleted B's marker (H2 window) and an old launcher took it to approve L.
    rmSync(markerPath());
    assert.equal(acquireActiveLock(legacy.runId).ok, true);
    assert.equal(replayJournal(legacy.read()).state, 'awaiting_approval');
    await assert.rejects(admit(x), e => e.reason === 'slots_full' && e.heldBy.includes(legacy.runId) && e.message.includes(`cancel ${legacy.runId}`));
    assert.ok(existsSync(legacyRecord(legacy)), 'L is recorded as a legacy reservation');
    assert.equal(markerRun(), b.runId, 'G2 rule: with a new-format slot the marker names it');
    let blocked;
    await assert.rejects(admit(sameRepo), e => { blocked = e; return e.reason === 'same_repo' && e.heldBy.includes(legacy.runId) && e.message.includes(legacy.runId); });
    // Observed: same_repo carries L's runId but no cancel hint (only the awaiting-marker refusal does).
    console.log(`H3 same_repo message: ${blocked.message}`);
    assert.equal(markerRun(), b.runId);
    assert.ok(readActiveRuns().some(run => run.runId === legacy.runId));
    assert.equal((await api.aiCliKernelCancel({ runId: legacy.runId })).state, 'cancelled');
    await finish(b);
    assert.equal(existsSync(legacyRecord(legacy)), false);
    assert.equal(existsSync(markerPath()), false);
    await finish(x); await finish(sameRepo);
  });
  await clear();
  assert.ok(count > 0, 'refuse an empty test selection');
  console.log(`PASS C ${count} groups (real cross-process admission and command overlap checks) in ${elapsed(suiteStarted)}`);
} catch (error) {
  console.error(error.stack);
  throw error;
} finally {
  for (const { control, runId } of commandControls) { try { writeFileSync(join(control, `release-${runId}`), 'cleanup'); } catch {} }
  const deadline = Date.now() + 5000;
  while (commandControls.some(({ control }) => existsSync(join(control, 'busy'))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  for (const cp of children) { try { cp.kill(); } catch {} }
  // Helpers own only these temporary fixtures.
  try { rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (error) { console.error(`fixture cleanup: ${error.code}`); }
}
