/**
 * runner 的收尾，從 runner.ts 抽出來才測得到（runner.ts 一載入就執行 main）。
 * 只有 loop 丟出的程式錯誤才寫 failed／kernel_error；釋放名額在 run 的結果之外，
 * 忙碌時 releaseActiveLock 有限重試後只記 slot_release_failed、不丟出；active.lock 覆蓋重試耗盡也一樣（I2）。
 * 已交付的 run 不會被改寫，runner 照常 exit 0。
 */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {JournalUnavailableError} from './journal-lock.js';
import { confirmFullPermissionGone, unsettledFullPermission, type GoneDeps } from './full-permission.js';
import { releaseActiveLock, type RunStore } from './journal.js';
import { openActions, replayJournal } from './replay.js';
import { isTerminalState, type RunState } from './types.js';

/** 確認全權限 worker 消失時的等待方式；預設等 20 秒、每 0.5 秒查一次，測試可以換掉。 */
export type SettleTiming = Pick<GoneDeps, 'now' | 'sleep' | 'pollMs' | 'confirmMs'>;

export async function settleRunnerRun(store: RunStore, executor: GoneDeps['executor'], run: () => Promise<RunState>, release: (runId: string) => Promise<unknown> = runId => releaseActiveLock(runId), timing: Partial<SettleTiming> = {}): Promise<RunState> {
  let state: RunState;
  try { state = await run(); }
  catch (error) {
    if(error instanceof JournalUnavailableError) {
      // A temporarily unavailable journal is not a worker failure. Never kill or
      // publish a terminal state through a lock we could not acquire.
      const view=replayJournal(store.read());
      const detail={reason:'journal_unavailable',at:new Date().toISOString(),pid:process.pid,observedSeq:view.lastSeq,detail:error.message,action:'保留現狀與名額；稍後重試或人工對帳 journal writer'};
      writeFileSync(join(store.dir,'journal-reconcile.json'),JSON.stringify(detail,null,2),{mode:0o600});
      console.error(detail.action+': '+error.message);
      return view.state;
    }
    // 程式錯誤時留下狀態，不要讓 run 看起來還在跑。run 結束後就沒人管了，還在跑的 worker 要先試著停掉。
    const view = replayJournal(store.read());
    for (const action of openActions(view)) {
      if (action.job) await executor.kill(action.job).catch(() => false);
    }
    const stack = (error as Error).stack ?? String(error);
    // failed 是終態，寫下去 cleanup 就能拆 worktree。全權限 worker（含已回結果、判定還沒落盤的）要先確認消失；
    // 確認不了就停在 stop_pending，錯誤留在 detail，名額也不釋放（下面只在終態釋放）。
    const block = await confirmFullPermissionGone(unsettledFullPermission(view), {
      executor, now: timing.now ?? (() => Date.now()), sleep: timing.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      pollMs: timing.pollMs ?? 500, confirmMs: timing.confirmMs ?? 20000,
      onLegacy: detail=>store.append({type:'compatibility_warning',detail}),
    }, { kill: true });
    if (block) {
      store.append({ type: 'state', state: 'stop_pending', reason: block.reason, detail: `${block.detail}。kernel 發生程式錯誤：${stack}` });
      state = 'stop_pending';
    } else {
      store.append({ type: 'state', state: 'failed', reason: 'kernel_error', detail: stack });
      state = 'failed';
    }
  }
  if (isTerminalState(state)) await release(store.runId);
  return state;
}
