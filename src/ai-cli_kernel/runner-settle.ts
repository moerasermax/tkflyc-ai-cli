/**
 * runner 的收尾，從 runner.ts 抽出來才測得到（runner.ts 一載入就執行 main）。
 * 只有 loop 丟出的程式錯誤才寫 failed／kernel_error；釋放名額在 run 的結果之外，
 * 忙碌時 releaseActiveLock 有限重試後只記 slot_release_failed、不丟出；active.lock 覆蓋重試耗盡也一樣（I2）。
 * 已交付的 run 不會被改寫，runner 照常 exit 0。
 */
import { releaseActiveLock, type RunStore } from './journal.js';
import { openActions, replayJournal } from './replay.js';
import { isTerminalState, type KernelExecutor, type RunState } from './types.js';

export async function settleRunnerRun(store: RunStore, executor: Pick<KernelExecutor, 'kill'>, run: () => Promise<RunState>, release: (runId: string) => Promise<unknown> = runId => releaseActiveLock(runId)): Promise<RunState> {
  let state: RunState;
  try { state = await run(); }
  catch (error) {
    // 程式錯誤時留下狀態，不要讓 run 看起來還在跑。run 結束後就沒人管了，還在跑的 worker 要先試著停掉。
    for (const action of openActions(replayJournal(store.read()))) {
      if (action.job) await executor.kill(action.job).catch(() => false);
    }
    store.append({ type: 'state', state: 'failed', reason: 'kernel_error', detail: (error as Error).stack ?? String(error) });
    state = 'failed';
  }
  if (isTerminalState(state)) await release(store.runId);
  return state;
}
