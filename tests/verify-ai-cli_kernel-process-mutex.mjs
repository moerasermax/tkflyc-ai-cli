/** 真實 Windows delete-pending ticket：短暫阻擋可恢復，持續阻擋必須 fail-closed。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessMutexBusy, ProcessMutexReadError, processIdentity, retryProcessMutex, withProcessMutex } from '../dist/ai-cli_kernel/process-mutex.js';
import { RunStore, kernelRunDir, newRunId, releaseActiveLock, kernelStateDir } from '../dist/ai-cli_kernel/journal.js';
import { waitForTestLock, releaseStoppedTestLock } from '../dist/ai-cli_kernel/test-lock.js';
import { admitRun, ensureLegacyMarker } from '../dist/ai-cli_kernel/admission.js';
import { buildContract } from '../dist/ai-cli_kernel/templates.js';
import { replayJournal } from '../dist/ai-cli_kernel/replay.js';
import { settleRunnerRun } from '../dist/ai-cli_kernel/runner-settle.js';
import { runKernelLoop } from '../dist/ai-cli_kernel/loop.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readError = original => error => error instanceof ProcessMutexReadError && !(error instanceof ProcessMutexBusy)
  && error.cause === original && error.code === original.code && error.ticket === original.path
  && error.message.includes(original.code) && error.message.includes(original.path);
function fresh() {
  const store = new RunStore(kernelRunDir(newRunId()));
  const contract = buildContract({ goal: 'mutex release fixture', workFolder: ROOT, model: 'gpt-6.1-sol', decideModel: 'gpt-6.1-sol', allowUnverifiedBoundary: true });
  store.create(contract); store.append({ type: 'state', state: 'running' }); return store;
}
const noKill = { kill: async () => assert.fail('no worker should be killed'), isGone: async () => true };

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(ROOT, '.tmp'), { recursive: true });
const root = mkdtempSync(join(ROOT, '.tmp', 'mutex-delete-pending-'));
// 本機 openSync + unlinkSync（以及 DeleteFileW）採立即移除名稱的語意，讀取回 ENOENT。
// 用原生 FileDispositionInfo 明確要求傳統 delete-pending，保留真實 EPERM，不注入讀取錯誤。
const helper = join(root, 'hold.ps1');
writeFileSync(helper, `param([string]$Ticket, [string]$Directory, [string]$Release, [int]$Transient)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class MutexPendingTicket {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref int data, uint size);
  public static void Hold(string ticket, string directory, string release, int transient) {
    using (var handle = CreateFileW(ticket, 0x80010000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception();
      int delete = 1;
      if (!SetFileInformationByHandle(handle, 4, ref delete, 4)) throw new System.ComponentModel.Win32Exception();
      Console.WriteLine("READY"); Console.Out.Flush();
      var deadline = DateTime.UtcNow.AddSeconds(15);
      while (!File.Exists(release)) {
        if (transient != 0 && File.Exists(release + ".read-blocked")) {
          return;
        }
        if (DateTime.UtcNow > deadline) throw new TimeoutException("delete-pending fixture release timeout");
        Thread.Sleep(1);
      }
    }
  }
}
'@
[MutexPendingTicket]::Hold($Ticket, $Directory, $Release, $Transient)
`);

async function pendingTicket(name, transient) {
  const directory = join(kernelStateDir(), name + '.tickets');
  mkdirSync(directory, { recursive: true });
  const ticket = join(directory, 'held.json'), release = join(root, name + '.release');
  writeFileSync(ticket, JSON.stringify({ id: 'held', number: 0, owner: { pid: process.pid, started: '', name: 'node' } }));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, ticket, directory, release, String(Number(transient))], {
    cwd: ROOT, windowsHide: true, env: { ...process.env, PSExecutionPolicyPreference: 'Restricted' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}: ${output}`)));
  });
  done.catch(() => {});
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture readiness timeout: ${output}`)), 12000);
    child.stdout.on('data', data => { output += data; if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', data => { output += data; });
    done.then(() => { clearTimeout(timer); reject(new Error('fixture exited before use')); }, error => { clearTimeout(timer); reject(error); });
  });
  const close = async () => { writeFileSync(release, 'release'); await done; };
  try {
    await ready;
    assert.ok(readdirSync(directory).includes('held.json'), 'delete-pending ticket must still be enumerated');
    assert.throws(() => readFileSync(ticket), error => error.code === 'EPERM', 'real delete-pending open must return EPERM');
    return { directory, ticket, release, done, close };
  } catch (error) { await close(); throw error; }
}

let passed = 0, failed = 0, skipped = 0;
async function test(name, work, windowsOnly = false) {
  if (windowsOnly && process.platform !== 'win32') {
    console.log(`SKIP ${name}: requires native Windows FileDispositionInfo delete-pending semantics`); skipped++; return;
  }
  try { await work(); console.log(`PASS ${name}`); passed++; }
  catch (error) { console.log(`FAIL ${name}`); console.error(error); failed++; }
}
function fixture(name, id = 'held') {
  const directory = join(kernelStateDir(), name + '.tickets'), file = join(directory, id + '.json');
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify({ id, number: 0, owner: { pid: process.pid, started: '', name: 'node' } }));
  return { directory, file };
}
function fault(code, file) { return Object.assign(new Error(`${code}: injected open '${file}'`), { code, path: file }); }
async function intercept(read, work) {
  const realRead = fs.readFileSync;
  fs.readFileSync = function (file, ...args) { return read(file, () => realRead.call(this, file, ...args)); };
  syncBuiltinESMExports();
  try { return await work(); }
  finally { fs.readFileSync = realRead; syncBuiltinESMExports(); }
}
try {
// 暖身自己的身分查詢，避免把程序查詢耗時混入同步讀取重試的測試。
await processIdentity();
await test('mutex delete-pending closes during retry and acquires normally', async () => {
  const name = 'delete-pending-transient', holder = await pendingTicket(name, true);
  let worked = 0, blockedReads = 0;
  const realRead = fs.readFileSync;
  // 只觀察真正的 OS 錯誤並通知持有者開始關閉；不注入錯誤／內容，也不讓關閉搶在首次讀取前。
  fs.readFileSync = function (path, ...args) {
    try { return realRead.call(this, path, ...args); }
    catch (error) {
      if (path === holder.ticket && error.code === 'EPERM') {
        blockedReads++;
        writeFileSync(holder.release + '.read-blocked', 'observed');
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await withProcessMutex(name, () => { worked++; return 'acquired'; }), 'acquired');
    assert.ok(blockedReads > 0, 'acquisition really encountered delete-pending');
    assert.equal(worked, 1);
    await holder.done;
    assert.deepEqual(readdirSync(holder.directory), [], 'all tickets disappear after successful work');
  } finally { fs.readFileSync = realRead; syncBuiltinESMExports(); await holder.close(); }
}, true);
await test('mutex persistent delete-pending is typed busy and never executes work', async () => {
  const name = 'delete-pending-persistent', holder = await pendingTicket(name, false);
  let worked = 0;
  try {
    const since = performance.now();
    const acquire = () => withProcessMutex(name, () => { worked++; });
    const busy = error => error instanceof ProcessMutexBusy && error.mutex === name && error.cause?.code === 'EPERM'
      && error.message.includes('EPERM') && error.message.includes('held.json');
    await assert.rejects(acquire(), busy);
    assert.equal(worked, 0, 'inaccessible ticket must never permit entry');
    assert.ok(performance.now() - since < 2000, 'read retries must be bounded');
    assert.deepEqual(readdirSync(holder.directory), ['held.json'], 'failure cleans only its own tickets');
    assert.throws(() => readFileSync(holder.ticket), error => error.code === 'EPERM', 'holder remains open beyond retry exhaustion');
    await assert.rejects(acquire(), busy);
    await assert.rejects(acquire(), busy); // Three quick calls must remain transient.
    assert.equal(worked, 0, 'persistent errors must not enter work on later attempts either');
  } finally { await holder.close(); }
}, true);
for (const code of ['EACCES', 'EBUSY']) await test(`mutex ${code} recovery still respects a live ticket`, async () => {
  const name = 'recover-' + code, { file } = fixture(name);
  let reads = 0, worked = 0, clock = 0;
  try {
    await intercept((path, real) => { if (path === file && reads++ === 0) throw fault(code, file); return real(); }, async () => {
      await assert.rejects(withProcessMutex(name, () => { worked++; }, { now: () => clock, sleep: async () => { clock += 10000; }, maxWaitMs: 5000 }),
        error => error instanceof ProcessMutexBusy && error.cause === undefined);
    });
    assert.ok(reads >= 2, 'fault injection ran and a later read succeeded');
    assert.equal(worked, 0, 'recovered live ticket must still block entry');
  } finally { rmSync(file, { force: true }); }
});
await test('mutex scan shares one wall-clock budget across tickets and blocking IO', async () => {
  const name = 'shared-read-budget', files = Array.from({ length: 8 }, (_, i) => fixture(name, 'held-' + i).file);
  const seen = new Set(), pause = new Int32Array(new SharedArrayBuffer(4));
  let worked = 0;
  try {
    await intercept((path, real) => {
      if (files.includes(path) && !seen.has(path)) { seen.add(path); Atomics.wait(pause, 0, 0, 35); throw fault('EACCES', path); }
      return real();
    }, async () => {
      await assert.rejects(withProcessMutex(name, () => { worked++; }, { maxWaitMs: 1000 }),
        error => error instanceof ProcessMutexBusy && error.cause?.code === 'EACCES');
    });
    assert.ok(seen.size > 0 && seen.size < files.length, 'blocking IO on earlier tickets consumed the shared scan budget');
    assert.equal(worked, 0);
  } finally { files.forEach(file => rmSync(file, { force: true })); }
});
await test('mutex persistent errno escapes retryProcessMutex with typed cause', async () => {
  const name = 'persistent-retry', { file } = fixture(name), original = fault('EACCES', file);
  let sleeps = 0, reads = 0, worked = 0;
  try {
    await intercept((path, real) => { if (path === file) { reads++; throw original; } return real(); }, async () => {
      await assert.rejects(retryProcessMutex(name, () => { worked++; }, { sleep: async ms => { sleeps++; await pause(ms); } }), readError(original));
    });
    assert.ok(reads > 0); assert.equal(sleeps, 2); assert.equal(worked, 0);
  } finally { rmSync(file, { force: true }); }
});
await test('mutex persistent errno stops test-lock polling instead of waiting forever', async () => {
  const { file } = fixture('test-lease'), original = fault('EACCES', file);
  let sleeps = 0, reads = 0, acquired;
  try {
    await intercept((path, real) => { if (path === file) { reads++; throw original; } return real(); }, async () => {
      await assert.rejects(waitForTestLock({ runId: 'fixture' }, () => false, () => {}, { sleep: async () => {
        if (++sleeps > 3) throw new Error('unbounded test-lock polling');
        await pause(1000);
      } }).then(lease => { acquired = lease; return lease; }), readError(original));
    });
    assert.ok(reads > 0); assert.equal(sleeps, 2); assert.equal(existsSync(join(kernelStateDir(), 'test.lock')), false);
  } finally { rmSync(file, { force: true }); await acquired?.release(); }
});
await test('mutex persistent errno becomes legacy_marker_check_failed', async () => {
  const { file } = fixture('admission'), original = fault('EACCES', file), events = [];
  const slots = join(kernelStateDir(), 'active-runs'), slot = join(slots, 'kr-20261112-000000-cafe.json');
  mkdirSync(slots, { recursive: true }); writeFileSync(slot, JSON.stringify({ runId: 'kr-20261112-000000-cafe' }));
  let reads = 0, entered = 0;
  try {
    await intercept((path, real) => { if (path === file) { reads++; throw original; } return real(); }, async () => {
      const store = { append: event => events.push(event) };
      const deps = { mutex: (name, work, options) => withProcessMutex(name, () => { entered++; return work(); }, options) };
      assert.equal(await ensureLegacyMarker(store, deps), 'busy');
      assert.equal(await ensureLegacyMarker(store, deps), 'busy');
      await pause(2050);
      assert.equal(await ensureLegacyMarker(store, deps), 'failed');
    });
    assert.ok(reads > 0); assert.equal(entered, 0); assert.equal(events.length, 1);
    assert.equal(events[0].type, 'legacy_marker_check_failed');
    assert.ok(events[0].detail.includes('EACCES') && events[0].detail.includes('held.json'));
  } finally { rmSync(file, { force: true }); rmSync(slot, { force: true }); }
});
await test('mutex successful read resets persistent errno observations', async () => {
  const name = 'recovered-error-state', { file } = fixture(name), original = fault('EACCES', file);
  let blocked = true, worked = 0, clock = 0;
  const acquire = () => withProcessMutex(name, () => { worked++; });
  const busy = error => error instanceof ProcessMutexBusy && error.cause === original;
  try {
    await intercept((path, real) => { if (path === file && blocked) throw original; return real(); }, async () => {
      await assert.rejects(acquire(), busy); await assert.rejects(acquire(), busy);
      await pause(2050);
      blocked = false;
      await assert.rejects(withProcessMutex(name, () => { worked++; }, { now: () => clock, sleep: async () => { clock += 10000; }, maxWaitMs: 5000 }),
        error => error instanceof ProcessMutexBusy && error.cause === undefined);
      blocked = true;
      await assert.rejects(acquire(), busy);
    });
    assert.equal(worked, 0);
  } finally { rmSync(file, { force: true }); }
});
await test('mutex same errno after two seconds surfaces without a third exhaustion', async () => {
  const name = 'aged-read-error', { file } = fixture(name), original = fault('EBUSY', file);
  try {
    await intercept((path, real) => { if (path === file) throw original; return real(); }, async () => {
      await assert.rejects(withProcessMutex(name, () => assert.fail('must not enter')), error => error instanceof ProcessMutexBusy && error.cause === original);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2050);
      await assert.rejects(withProcessMutex(name, () => assert.fail('must not enter')), readError(original));
    });
  } finally { rmSync(file, { force: true }); }
});
await test('mutex concurrent callers cannot accelerate persistence or contaminate other tickets', async () => {
  const name = 'concurrent-read-error', { file } = fixture(name), original = fault('EPERM', file);
  const other = fixture('unrelated-read-error');
  let worked = 0;
  try {
    await intercept((path, real) => { if (path === file) throw original; if (path === other.file) throw fault('EPERM', other.file); return real(); }, async () => {
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => withProcessMutex(name, () => { worked++; })));
      assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof ProcessMutexBusy && result.reason.cause === original));
      await pause(2050);
      await assert.rejects(withProcessMutex(name, () => { worked++; }), readError(original));
      await assert.rejects(withProcessMutex('unrelated-read-error', () => { worked++; }), error => error instanceof ProcessMutexBusy && error.cause?.path === other.file);
    });
    assert.equal(worked, 0);
  } finally { fs.unlinkSync(file); fs.unlinkSync(other.file); }
});
await test('mutex persistent test lease release preserves passed run and records deferred diagnosis', async () => {
  const store = fresh(), lease = await waitForTestLock(store, () => false, () => {});
  await lease.command({ pid: 99999999, started: 'ended', name: 'node' });
  const { file } = fixture('test-lease', 'release-held'), original = fault('EPERM', file);
  try {
    await intercept((path, real) => { if (path === file) throw original; return real(); }, async () => {
      // Same finally boundary as loop.runCheck, inside the real runner settlement.
      const state = await settleRunnerRun(store, noKill, async () => {
        try { store.append({ type: 'state', state: 'completed' }); return 'completed'; } finally { await lease.release(); }
      }, async () => {});
      assert.equal(state, 'completed');
      await releaseStoppedTestLock(store.runId);
    });
    const events = store.read(), deferred = events.filter(event => event.type === 'test_lock_release_deferred');
    assert.equal(deferred.length, 2);
    assert.equal(replayJournal(events).state, 'completed');
    assert.ok(deferred.every(event => event.detail.includes('EPERM') && event.detail.includes(file)));
    assert.ok(!events.some(event => event.reason === 'kernel_error'));
    assert.ok(existsSync(join(kernelStateDir(), 'test.lock')), 'deferred lease remains for identity-based reclamation');
  } finally { fs.unlinkSync(file); await lease.release(); }
});
await test('mutex persistent slot release preserves terminal run and records slot failure', async () => {
  const store = fresh(); await admitRun(store, () => {}, { quota: async () => 80 });
  const { file } = fixture('admission', 'release-held'), original = fault('EACCES', file);
  try {
    await intercept((path, real) => { if (path === file) throw original; return real(); }, async () => {
      assert.equal(await settleRunnerRun(store, noKill, async () => {
        store.append({ type: 'state', state: 'completed' }); return 'completed';
      }), 'completed');
      assert.equal(await releaseActiveLock(store.runId), false);
    });
    const events = store.read(), failures = events.filter(event => event.type === 'slot_release_failed');
    assert.equal(replayJournal(events).state, 'completed');
    assert.equal(failures.length, 2);
    assert.ok(failures.every(event => event.detail.includes('EACCES') && event.detail.includes(file)));
    assert.ok(!events.some(event => event.reason === 'kernel_error'));
    assert.ok(existsSync(join(kernelStateDir(), 'active-runs', store.runId + '.json')));
  } finally { fs.unlinkSync(file); await releaseActiveLock(store.runId); }
});
await test('mutex production loop preserves successful check when release ticket stays unreadable', async () => {
  const runId = newRunId(), store = new RunStore(kernelRunDir(runId));
  const contract = buildContract({ goal: 'loop release fixture', workFolder: ROOT, template: 'develop', testCommand: 'fake-test',
    model: 'gpt-6.1-sol', decideModel: 'gpt-6.1-sol', allowUnverifiedBoundary: true, checkpoint: 'off',
    budget: { maxDecides: 1, maxWallMinutes: 10 } }, new Date(), { runId, worktree: ROOT });
  store.create(contract);
  store.append({ type: 'approved', kind: 'contract', contractDigest: store.contractDigest() });
  store.append({ type: 'state', state: 'running' });
  store.append({ type: 'workspace_ready', head: 'head' });
  store.append({ type: 'action_intent', action: { actionId: 'a1', kind: 'decide', model: contract.decide.model, prompt: 'fixture', marker: 'fixture' } });
  store.append({ type: 'action_result', actionId: 'a1', outcome: { ok: true, usage: { input: 0, output: 0, cached: 0 } } });
  store.append({ type: 'decide_processed', actionId: 'a1', ok: true, decision: 'plan', plan: { planId: 'p1', steps: [] } });
  let file, original, checks = 0;
  const workspace = {
    refs: () => [], commitHistory: () => [], restore() {},
    inspect: () => ({ branch: contract.develop.branch, head: 'head', dirty: [], changed: ['feature'], ancestorOk: true }),
    startCheck() {
      checks++;
      return { pid: 99999999, identify: async () => ({ started: '', name: '' }), tail: () => '', kill: async () => true,
        wait: async () => {
          ({ file } = fixture('test-lease', 'loop-release-held')); original = fault('EPERM', file);
          return { exitCode: 0, tail: 'passed local check' };
        } };
    },
  };
  try {
    await intercept((path, real) => { if (file && path === file) throw original; return real(); }, async () => {
      const state = await settleRunnerRun(store, noKill, () => runKernelLoop({ store, contract, workspace,
        executor: { ...noKill, start: async () => assert.fail('no vendor calls permitted') },
        quota: async () => 80, boundary: async () => 'PASS', agentFor: () => 'codex', versionId: () => 'test',
        snapshot: () => null, now: Date.now, sleep: async () => {}, pollMs: 1, killConfirmMs: 1, pid: process.pid }));
      assert.equal(state, 'budget_exhausted', 'one already-consumed decide budget ends the fixture after verification');
    });
    const events = store.read(), view = replayJournal(events);
    assert.equal(checks, 1); assert.equal(view.verification?.passed, true); assert.equal(view.testFailures, 0);
    assert.ok(!events.some(event => event.reason === 'kernel_error'));
    assert.ok(events.some(event => event.type === 'test_lock_release_deferred' && event.detail.includes('EPERM') && event.detail.includes(file)));
  } finally { if (file) fs.unlinkSync(file); await releaseStoppedTestLock(runId); }
});
console.log(`Process mutex: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed ? 1 : 0;
} finally {
  // 只清理本次 mkdtemp 建立且核對過的目錄，不碰其他測試或既有 repo 檔案。
  assert.equal(dirname(root), join(ROOT, '.tmp'));
  assert.ok(basename(root).startsWith('mutex-delete-pending-'));
  rmSync(root, { recursive: true, force: true });
}
