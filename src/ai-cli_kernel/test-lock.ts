/** All setup/test commands share this lease. The command identity survives runner death. */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessIdentity } from '../core/live-jobs.js';
import { mayBeAlive } from '../core/job-store.js';
import { atomicWrite, kernelStateDir, RunStore, kernelRunDir } from './journal.js';
import { identityAlive, processIdentity, withProcessMutex, ProcessMutexBusy, retryProcessMutex, type MutexRetryDeps } from './process-mutex.js';

interface TestLease { runId: string; token: string; owner: ProcessIdentity; command?: ProcessIdentity }
const path = () => join(kernelStateDir(), 'test.lock');
function read(): TestLease | null {
  try { return JSON.parse(readFileSync(path(), 'utf8')) as TestLease; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export interface TestLock {
  command(identity: ProcessIdentity): Promise<void>;
  release(): Promise<void>;
}
/** Internal injection points for deterministic contention/clock/identity tests. */
export interface TestLockDeps extends MutexRetryDeps {
  now(): number;
  mayBeAlive: typeof mayBeAlive;
  identityAlive: typeof identityAlive;
}
async function releaseLease(store: RunStore, work: () => void | Promise<void>, deps: Partial<MutexRetryDeps>): Promise<void> {
  try { await retryProcessMutex('test-lease', work, deps); }
  catch (error) {
    if (!(error instanceof ProcessMutexBusy)) throw error;
    // Release is called only after stop confirmation. The lease command identity
    // belongs to the ended test command, so another run can prove death and reclaim
    // it. Contention in finally must not turn a passing test into kernel_error.
    store.append({ type: 'test_lock_release_deferred', detail: 'test-lease 協調忙碌；釋放重試耗盡，保留租約供身分回收' });
  }
}
/** Used only after orphan/cancel handling has confirmed the check has stopped. */
export async function releaseStoppedTestLock(runId: string, deps: Partial<TestLockDeps> = {}): Promise<void> {
  await releaseLease(new RunStore(kernelRunDir(runId)), async () => {
    const held = read();
    if (held?.runId === runId && (!held.command || !await (deps.identityAlive ?? identityAlive)(held.command))) rmSync(path(), { force: true });
  }, deps);
}
export async function waitForTestLock(store: RunStore, shouldStop: () => boolean, onWait: (heldBy: string | null) => void, deps: Partial<TestLockDeps> = {}): Promise<TestLock | null> {
  const mutex = deps.mutex ?? withProcessMutex;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const cheapAlive = deps.mayBeAlive ?? mayBeAlive;
  const fullAlive = deps.identityAlive ?? identityAlive;
  const owner = await processIdentity();
  let waited = false, previous = '';
  let checked: { key: string; at: number; alive: boolean } | undefined;
  const leaseAlive = async (held: TestLease) => {
    const identity = held.command ?? held.owner;
    if (!cheapAlive(identity.pid)) return false; // Detect death each poll, even inside the 30s cache.
    const key = JSON.stringify([held.token, identity.pid, identity.started, identity.name]);
    if (!checked || checked.key !== key || now() - checked.at >= 30000) {
      checked = { key, at: now(), alive: await fullAlive(identity) };
    }
    return checked.alive;
  };
  for (;;) {
    if (shouldStop()) return null; // Cancellation/fencing is not a successful acquisition.
    let result: { lease?: TestLease; heldBy?: string; stopped?: boolean };
    try {
      result = await mutex('test-lease', async () => {
        if (shouldStop()) return { stopped: true };
        const held = read();
        if (held && await leaseAlive(held)) return { heldBy: held.runId };
        if (shouldStop()) return { stopped: true };
        const lease: TestLease = { runId: store.runId, token: `${process.pid}-${now()}-${Math.random()}`, owner };
        atomicWrite(path(), JSON.stringify(lease));
        return { lease };
      });
    } catch (error) {
      if (!(error instanceof ProcessMutexBusy)) throw error;
      // Mutex timeout is still a test-lock wait; cancellation/fencing is checked
      // again next round. Do not classify coordination contention as test failure.
      result = { heldBy: read()?.runId ?? 'test-lease 協調中' };
    }
    if (result.stopped) return null;
    if (result.lease) {
      const lease = result.lease;
      const release = async () => {
        await releaseLease(store, () => { if (read()?.token === lease.token) rmSync(path(), { force: true }); }, deps);
      };
      if (shouldStop()) { await release(); return null; }
      try { if (waited) onWait(null); }
      catch (error) { await release(); throw error; }
      return {
        async command(identity) {
          await retryProcessMutex('test-lease', () => {
            if (read()?.token !== lease.token) {
              // A short command can finish while identify() is in flight. A successor
              // may already own the lease; never overwrite its command identity.
              if (lease.command) return;
              throw new Error('測試鎖所有權已變動');
            }
            lease.command = identity;
            atomicWrite(path(), JSON.stringify(lease));
          }, deps);
        },
        release,
      };
    }
    if (result.heldBy !== previous) { onWait(result.heldBy!); previous = result.heldBy!; waited = true; }
    // Waiting is outside command deadlines; the loop still observes cancellation/fencing.
    await sleep(1000);
  }
}
