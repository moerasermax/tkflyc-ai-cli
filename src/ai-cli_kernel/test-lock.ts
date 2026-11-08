/** All setup/test commands share this lease. The command identity survives runner death. */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessIdentity } from '../core/live-jobs.js';
import { atomicWrite, kernelStateDir, type RunStore } from './journal.js';
import { identityAlive, processIdentity, withProcessMutex } from './process-mutex.js';

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
/** Used only after orphan/cancel handling has confirmed the check has stopped. */
export async function releaseStoppedTestLock(runId: string): Promise<void> {
  await withProcessMutex('test-lease', async () => {
    const held = read();
    if (held?.runId === runId && (!held.command || !await identityAlive(held.command))) rmSync(path(), { force: true });
  });
}
export async function waitForTestLock(store: RunStore, shouldStop: () => boolean, onWait: (heldBy: string | null) => void): Promise<TestLock | null> {
  const owner = await processIdentity();
  let waited = false, previous = '';
  for (;;) {
    if (shouldStop()) return null; // Cancellation/fencing is not a successful acquisition.
    const result = await withProcessMutex('test-lease', async () => {
      const held = read();
      if (held && await identityAlive(held.command ?? held.owner)) return { heldBy: held.runId };
      const lease: TestLease = { runId: store.runId, token: `${process.pid}-${Date.now()}-${Math.random()}`, owner };
      atomicWrite(path(), JSON.stringify(lease));
      return { lease };
    });
    if (result.lease) {
      const lease = result.lease;
      const release = async () => {
        await withProcessMutex('test-lease', () => { if (read()?.token === lease.token) rmSync(path(), { force: true }); });
      };
      try { if (waited) onWait(null); }
      catch (error) { await release(); throw error; }
      return {
        async command(identity) {
          await withProcessMutex('test-lease', () => {
            if (read()?.token !== lease.token) {
              // A short command can finish while identify() is in flight. A successor
              // may already own the lease; never overwrite its command identity.
              if (lease.command) return;
              throw new Error('測試鎖所有權已變動');
            }
            lease.command = identity;
            atomicWrite(path(), JSON.stringify(lease));
          });
        },
        release,
      };
    }
    if (result.heldBy !== previous) { onWait(result.heldBy!); previous = result.heldBy!; waited = true; }
    // Waiting is outside command deadlines; the loop still observes cancellation/fencing.
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
