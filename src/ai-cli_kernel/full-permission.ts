/**
 * 全權限動作的收尾：run 要進終態、要 cleanup、要放棄動作之前，全權限 worker 的程序必須確認消失。
 *
 * 為什麼集中在這裡（issue #17 審查發現的競態）：job 已經回了結果、判定還沒落盤、程序卻還活著時取消，
 * 原本會直接寫成 cancelled；cancelled 是終態，cleanup 就會去拆它還在寫的 worktree。
 * 「哪些動作算全權限」和「怎樣才算確認消失」各只有這一份，loop、取消、runner 收尾、cleanup、放棄都用它。
 *
 * 這支檔案不寫日誌，只回報擋住的原因；要寫什麼狀態由呼叫端決定。
 */
import type { ActionRecord, RunView } from './replay.js';
import type { ActionSpec, JobRef, KernelExecutor } from './types.js';

/** 唯一的判斷點：不帶 capabilities 派出去的 worker。目前只有 develop 的寫入步驟。 */
export function isFullPermission(spec: ActionSpec): boolean {
  return spec.kind === 'worker' && spec.mode === 'write';
}

/**
 * 未結清的全權限動作：還沒有結果（也沒被放棄），或有結果但判定還沒落盤。
 * 判定落盤（step_checked）之前 loop 已經確認過程序消失，所以 processed 的視為結清。
 */
export function unsettledFullPermission(view: RunView): ActionRecord[] {
  return [...view.actions.values()].filter(action => isFullPermission(action.spec) && !action.processed);
}

/** cleanup 用：這個 run 派過的全部全權限動作，不論結清與否。 */
export function fullPermissionRecords(view: RunView): ActionRecord[] {
  return [...view.actions.values()].filter(action => isFullPermission(action.spec));
}

export interface GoneDeps {
  executor: Pick<KernelExecutor, 'kill' | 'isGone' | 'find' | 'blockers'>;
  now(): number;
  sleep(ms: number): Promise<void>;
  pollMs: number;
  /** 等程序消失最多等多久；0 表示只查一次。 */
  confirmMs: number;
  onLegacy?(detail: string): void;
}

export interface GoneBlock {
  actionId: string;
  jobId: string | null;
  pid: number | null;
  reason: 'worker_still_alive' | 'cannot_verify_start';
  /** 給人看的說明：哪個 job、哪些 pid 還在。寫進 stop_pending 的 detail。 */
  detail: string;
}

async function confirmJobGone(job: JobRef, deps: GoneDeps, kill: boolean): Promise<boolean> {
  if (kill) await deps.executor.kill(job).catch(() => false);
  const deadline = deps.now() + deps.confirmMs;
  for (;;) {
    // 只有明確回 true 才算消失：回 false、丟例外（查不了）都不算。
    if (await deps.executor.isGone(job).catch(() => false) === true) {
      if(job.legacyNotice)deps.onLegacy?.(`${job.jobId}：${job.legacyNotice}`);
      return true;
    }
    if (deps.now() >= deadline) return false;
    await deps.sleep(deps.pollMs);
  }
}

/**
 * 逐一確認這些動作的程序都消失了。全部確認才回 null；第一個確認不了的就回它。
 * - 有 job：kill 為真先送終止，再輪詢 isGone 到 confirmMs。
 * - 沒 job 也沒結果：用 marker 查有沒有啟動過。確定沒有才算過；查不了就擋；查到了照有 job 處理。
 * - 沒 job 但有結果（啟動失敗）：沒有程序可查。
 */
export async function confirmFullPermissionGone(records: ActionRecord[], deps: GoneDeps, opts: { kill: boolean }): Promise<GoneBlock | null> {
  for (const record of records) {
    const actionId = record.spec.actionId;
    let job = record.job ?? null;
    if (!job) {
      if (record.outcome) continue;
      const found = await deps.executor.find(record.spec.marker).catch(() => 'unknown' as const);
      if (found === null) continue;
      if (found === 'unknown') return { actionId, jobId: null, pid: null, reason: 'cannot_verify_start', detail: `查不了全權限動作 ${actionId} 是否啟動過` };
      job = found;
    }
    if (await confirmJobGone(job, deps, opts.kill)) continue;
    const blockers = await deps.executor.blockers?.(job).catch(() => [] as string[]) ?? [];
    return {
      actionId, jobId: job.jobId, pid: job.pid, reason: 'worker_still_alive',
      detail: `全權限動作 ${actionId} 的 job ${job.jobId}（pid ${job.pid}）還沒確認停止${blockers.length ? `：${blockers.slice(0, 8).join('、')}` : ''}`,
    };
  }
  return null;
}
