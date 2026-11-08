import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), source = process.argv.includes('--source');
const load = name => import(pathToFileURL(join(ROOT, source ? 'src' : 'dist', 'ai-cli_kernel', `${name}.${source ? 'ts' : 'js'}`)).href);
const { RunStore, kernelRunDir, kernelStateDir, newRunId, releaseActiveLock } = await load('journal');
const { admitRun, readActiveRuns, validateConcurrencyConfig, normalizedOrigin, claimRunnerSlot } = await load('admission');
const { buildContract } = await load('templates');
const { remainingPercentFromUsage } = await load('runtime');
const { replayJournal, activeMinutes } = await load('replay');
const { waitForTestLock } = await load('test-lock');
const api = await load('api');
const { runKernelCli } = await load('cli');
const work = mkdtempSync(join(tmpdir(), 'kernel-concurrency-'));
const children = new Set();
const commandControls = [];
let count = 0;
async function test(name, fn) {
  if (process.env.KERNEL_CONCURRENCY_TEST_FILTER && !name.includes(process.env.KERNEL_CONCURRENCY_TEST_FILTER)) return;
  await fn(); console.log(`PASS C ${name}`); count++;
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
function finish(store) { store.append({ type: 'state', state: 'cancelled' }); releaseActiveLock(store.runId); }
function clear() {
  for (const run of readActiveRuns()) finish(new RunStore(kernelRunDir(run.runId)));
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

try {
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
    await assert.rejects(admit(fresh(linked)), e => e.reason === 'same_repo'); finish(a);
    const other = repo();
    git(dir, 'config', 'remote.origin.url', 'https://dummy:dummy-secret@EXAMPLE.invalid/org/project.git/');
    git(other, 'config', 'remote.origin.url', 'git@example.invalid:org/project');
    const b = fresh(dir); await admit(b);
    await assert.rejects(admit(fresh(other)), e => e.reason === 'same_repo' && !e.message.includes('dummy-secret'));
    assert.ok(!readFileSync(join(kernelStateDir(), 'active-runs', `${b.runId}.json`), 'utf8').includes('dummy-secret'));
    assert.equal(normalizedOrigin('ssh://git@example.invalid/org/project.git', dir), normalizedOrigin('https://user:secret@example.invalid/org/project/', dir));
    finish(b);
  });
  await test('legacy active.lock counts once and stale/missing/terminal reservations recycle', async () => {
    const a = fresh(); running(a);
    const legacy = join(kernelStateDir(), 'active.lock');
    writeFileSync(legacy, JSON.stringify({ runId: a.runId, at: new Date().toISOString() }));
    const b = fresh(), c = fresh(); await admit(b); await admit(c);
    await assert.rejects(admit(fresh()), e => e.reason === 'slots_full' && e.heldBy.includes(a.runId));
    finish(b); finish(c);
    // Continue a paused legacy run, publishing a new slot without double counting the old lock.
    a.append({ type: 'state', state: 'waiting_human' }); await admit(a);
    assert.equal(readActiveRuns().filter(r => r.runId === a.runId).length, 1); finish(a);
    for (const kind of ['missing', 'terminal', 'awaiting']) {
      const stale = fresh(); await admit(stale);
      if (kind === 'missing') rmSync(stale.dir, { recursive: true, force: true });
      if (kind === 'terminal') stale.append({ type: 'state', state: 'completed' });
      if (kind === 'awaiting') stale.append({ type: 'state', state: 'awaiting_approval' });
      const next = fresh(); await admit(next);
      assert.ok(!existsSync(join(kernelStateDir(), 'active-runs', `${stale.runId}.json`))); finish(next);
    }
    writeFileSync(legacy, JSON.stringify({ runId: newRunId() }));
    const next = fresh(); await admit(next); assert.ok(!existsSync(legacy)); finish(next);
  });
  await test('real dead admission owner and dead mutex ticket are reclaimed', async () => {
    const store = fresh(), c = child('admit', store, { crash: true });
    await c.wait('ready'); c.go(); assert.ok((await c.wait('result')).ok); c.stop(); await c.exited;
    const next = fresh(); await admit(next); assert.equal(readActiveRuns().length, 1); finish(next);
    let entered = false;
    assert.equal(await claimRunnerSlot(store, async () => { entered = true; return true; }), false);
    assert.equal(entered, false, 'a delayed runner cannot enter after its dead admission was reclaimed');
    const holder = child('mutex-crash', fresh()); await holder.wait('ready'); holder.go(); await holder.wait('locked'); holder.stop(); await holder.exited;
    const last = fresh(); await admit(last); finish(last);
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
      if (value === 10) { await admit(b, deps); finish(b); }
      else await assert.rejects(admit(b, deps), e => e.reason === 'claude_quota');
      finish(a);
    }
  });
  await test('Codex threshold is strictly below 20 and includes decide/worker/allowed models', async () => {
    const agentFor = model => model === 'codex' ? 'codex' : 'claude';
    const models = position => ({ decide: { model: position === 'decide' ? 'codex' : 'claude' }, worker: { model: position === 'worker' ? 'codex' : 'claude' }, allowedWorkerModels: position === 'allowed' ? ['claude', 'codex'] : ['claude'] });
    for (const value of [20, 19.999, null, NaN, -1, 101, 'failure']) for (const position of ['decide', 'worker', 'allowed']) {
      const a = fresh(undefined, models('decide')), b = fresh(undefined, models(position)); await admit(a, { agentFor });
      const deps = { agentFor, quota: async agent => { if (agent !== 'codex') return 80; if (value === 'failure') throw new Error('query failed'); return value; } };
      if (value === 20) { await admit(b, deps); finish(b); }
      else await assert.rejects(admit(b, deps), e => e.reason === 'codex_quota');
      const claude = fresh(undefined, models('none')); await admit(claude, deps); finish(claude); finish(a);
    }
  });
  await test('human configuration enforces 1..3 at every admission; MCP exposes no override', async () => {
    for (const value of [0, 4, 3.1, NaN, '3', null]) assert.throws(() => validateConcurrencyConfig({ maxRuns: value }));
    const config = join(kernelStateDir(), 'concurrency.json');
    writeFileSync(config, JSON.stringify({ maxRuns: 4 })); await assert.rejects(admit(fresh()), /1～3/);
    writeFileSync(config, JSON.stringify({ maxRuns: 1 }));
    const a = fresh(); await admit(a); await assert.rejects(admit(fresh()), e => e.reason === 'slots_full'); finish(a);
    writeFileSync(config, JSON.stringify({ maxRuns: 3, codexMinRemainingPercent: 30 }));
    const b = fresh(); await admit(b); await assert.rejects(admit(fresh(), { quota: async agent => agent === 'codex' ? 29 : 80 }), e => e.reason === 'codex_quota'); finish(b);
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
    for (const store of stores) finish(store);
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
    finish(holder); api.aiCliKernelTriggersSetEnabled(false);
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
    const elapsed = activeMinutes(replayJournal(events), Date.now()) * 60000;
    assert.ok(elapsed < Date.now() - Date.parse(events.find(e => e.type === 'runner_started').at) - (Date.parse(acquired.at) - Date.parse(waiting.at)) + 100);
  });
  clear();
  console.log(`PASS C ${count} groups (real cross-process admission and command overlap checks)`);
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
