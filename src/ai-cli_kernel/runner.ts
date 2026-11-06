/**
 * 脫離行程樹的 runner：一個 run 一個。結束或當掉都不影響日誌，下次可以從日誌接回。
 * 這支檔案只組裝真實依賴，邏輯都在 loop.ts。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { lookupIdentities } from '../core/live-jobs.js';
import { RunStore, releaseActiveLock } from './journal.js';
import { openActions, replayJournal } from './replay.js';
import { FileJobExecutor } from './executor.js';
import { runKernelLoop } from './loop.js';
import { boundaryStatus } from './probe.js';
import { acquireRunnerLock, releaseRunnerLock } from './runner-lock.js';
import { agentForModel, kernelVersionId, readQuota } from './runtime.js';
import { gitSnapshot } from './verdict.js';
import { realWorkspace } from './workspace.js';
import { isTerminalState } from './types.js';

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || !existsSync(directory)) throw new Error('runner 需要 run 目錄');
  const store = new RunStore(directory);
  const self = (await lookupIdentities([process.pid])).get(process.pid) ?? { pid: process.pid, started: '', name: 'node' };
  if (!await acquireRunnerLock(store, self, lookupIdentities)) return;
  const executor = new FileJobExecutor();
  try {
    const state = await runKernelLoop({
      store, contract: store.readContract(), executor,
      boundary: async agent => boundaryStatus(agent), quota: readQuota, agentFor: agentForModel,
      versionId: kernelVersionId, snapshot: gitSnapshot, now: () => Date.now(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs: 2000, killConfirmMs: 20000, pid: process.pid, workspace: realWorkspace,
    });
    if (isTerminalState(state)) releaseActiveLock(store.runId);
  } catch (error) {
    // 程式錯誤時留下狀態，不要讓 run 看起來還在跑。run 結束後就沒人管了，還在跑的 worker 要先試著停掉。
    for (const action of openActions(replayJournal(store.read()))) {
      if (action.job) await executor.kill(action.job).catch(() => false);
    }
    store.append({ type: 'state', state: 'failed', reason: 'kernel_error', detail: (error as Error).stack ?? String(error) });
    releaseActiveLock(store.runId);
  } finally {
    releaseRunnerLock(store, self);
  }
}

main().then(() => process.exit(0), error => {
  try { writeFileSync(`${process.argv[2]}/runner-crash.log`, String((error as Error).stack ?? error)); } catch { /* 沒地方寫就算了 */ }
  process.exit(1);
});
