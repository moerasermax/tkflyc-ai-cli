/** 面板控制器：所有副作用均注入；鍵盤模式、刷新及確認共用同一份規則。 */
import { actionsFor, chooseRun, EMPTY, triggerAction, type KernelAction, type KernelDetail, type KernelSnapshot } from './dashboard-rules.js';

export interface DashboardEffects {
  snapshot(): Promise<KernelSnapshot>;
  detail(runId: string): Promise<KernelDetail>;
  report(runId: string): Promise<string>;
  execute(action: KernelAction): Promise<unknown>;
  createRelease(action: KernelAction): Promise<{ id?: unknown }>;
  runRelease(id: string): Promise<unknown>;
  triggers(): Promise<boolean>;
}
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const identity = (a: KernelAction): string => JSON.stringify([a.id, a.runId, a.args, a.commit, a.isRelease]);

/** 無重試：create 或 run 拋錯／回傳不明，一律讓呼叫者回報並人工對帳。 */
export async function perform(effects: DashboardEffects, action: KernelAction): Promise<unknown> {
  const fresh = action.runId ? await effects.detail(action.runId) : null;
  if (fresh && 'confirmedCommit' in action && (fresh.develop?.verifiedCommit ?? null) !== action.confirmedCommit) {
    throw new Error('確認後 commit 已改變，沒有執行。請重新看過再確認。');
  }
  const available = fresh ? actionsFor(fresh) : [triggerAction(await effects.triggers())];
  if (!available.some(fresh => identity(fresh) === identity(action))) {
    throw new Error('操作已失效或 commit 已改變，沒有執行。請重新看過再確認。');
  }
  if (action.isRelease) {
    const created = await effects.createRelease(action);
    const id = created?.id;
    if (typeof id !== 'string' || !new RegExp(`^${action.runId}-rel-[0-9a-f]{16}$`).test(id)) {
      throw new Error('kernel 沒有回傳可靠的放行 id，沒有執行；請人工對帳。');
    }
    return effects.runRelease(id);
  }
  return effects.execute(action);
}

export class DashboardController {
  snapshot: KernelSnapshot = { ...EMPTY, runs: [] };
  selected: string | null = null;
  detail: KernelDetail | null = null;
  pending: KernelAction | null = null;
  report: string | null = null;
  scroll = 0;
  notice = '';
  noticeTone: 'success' | 'error' | 'running' = 'success';
  busy = false;
  closed = false;
  private pinned = false;
  private previousActive: string | null = null;
  private generation = 0;
  private flight: Promise<void> | null = null;
  private requested = false;
  private idleWaiters: Array<() => void> = [];
  constructor(readonly effects: DashboardEffects, readonly changed: () => void = () => {}) {}
  get interval(): number { return this.snapshot.active ? 5_000 : 30_000; }

  /** 單飛且合併更新請求；選擇改變時丟棄過期結果，不讓舊 detail 蓋掉新選擇。 */
  refresh(): Promise<void> {
    if (this.closed || this.busy) return Promise.resolve();
    this.requested = true;
    if (this.flight) return this.flight;
    this.flight = this.readLoop().finally(() => { this.flight = null; });
    return this.flight;
  }
  private async readLoop(): Promise<void> {
    while (this.requested && !this.closed && !this.busy) {
      this.requested = false;
      const generation = this.generation;
      try {
        const snap = await this.effects.snapshot();
        if (snap.error) throw new Error(snap.error);
        const pick = this.pending ? { runId: this.selected, pinned: this.pinned }
          : chooseRun(this.selected, this.pinned, this.previousActive, snap);
        const detail = pick.runId ? await this.effects.detail(pick.runId) : null;
        if (this.closed || generation !== this.generation || this.busy) continue;
        if (pick.runId !== this.selected) { this.scroll = 0; this.report = null; }
        this.snapshot = snap;
        this.selected = pick.runId;
        this.pinned = pick.pinned;
        this.detail = detail;
        if (!this.pending) this.previousActive = snap.active;
      } catch (error) {
        if (!this.closed && generation === this.generation) {
          this.snapshot = { ...this.snapshot, error: `更新失敗：${reason(error)}` };
        }
      }
      if (!this.closed) this.changed();
    }
  }
  private select(runId: string, pinned: boolean): Promise<void> {
    this.selected = runId; this.pinned = pinned; this.detail = null;
    this.report = null; this.scroll = 0; this.generation++;
    this.changed();
    return this.refresh();
  }
  private confirm(action: KernelAction): void {
    // 拷貝並凍結對象、參數及 commit，不隨背景刷新變動。
    this.pending = Object.freeze({ ...action, confirmedCommit: action.runId ? this.detail?.develop?.verifiedCommit ?? null : null,
      args: Object.freeze([...action.args]) as unknown as string[] });
    this.generation++; this.scroll = 0; this.changed();
  }
  close(): void { this.closed = true; this.generation++; }

  async key(key: string, pageSize = 10, confirmationVisible = true): Promise<'quit' | void> {
    if (this.closed) return;
    if (this.busy) {
      // 已核准的操作先收尾，退出不把它做成結果不明；其他操作仍不可重入。
      if (key === 'q' || key === 'ctrl+c') {
        await new Promise<void>(done => { this.idleWaiters.push(done); });
        return 'quit';
      }
      return;
    }
    if (this.pending) {
      if (key === 'n' || key === 'escape') {
        this.pending = null; this.scroll = 0; this.generation++;
        await this.refresh(); this.changed(); return;
      }
      if (key !== 'y' || !confirmationVisible) return;
      const action = this.pending;
      this.pending = null; this.busy = true; this.generation++;
      this.noticeTone = 'running';
      this.notice = `執行中：${action.label}…`; this.changed();
      try {
        const result = await perform(this.effects, action);
        this.noticeTone = 'success';
        this.notice = `${action.label}：${typeof result === 'string' ? result : JSON.stringify(result) ?? '完成'}`;
      } catch (error) { this.noticeTone = 'error'; this.notice = `${action.label}失敗：${reason(error)}（不會自動重試）`; }
      finally {
        this.busy = false;
        try { await this.refresh(); this.changed(); }
        finally { for (const done of this.idleWaiters.splice(0)) done(); }
      }
      return;
    }
    if (key === 'q' || key === 'ctrl+c') return 'quit';
    if (key === 'pageup' || key === 'pagedown') {
      this.scroll = Math.max(0, this.scroll + (key === 'pageup' ? -pageSize : pageSize)); this.changed(); return;
    }
    if (this.report !== null) {
      if (key === 'escape') { this.report = null; this.scroll = 0; this.changed(); }
      return;
    }
    if (key === 'up' || key === 'k' || key === 'down' || key === 'j') {
      const runs = this.snapshot.runs;
      if (!runs.length) return;
      const at = Math.max(0, runs.findIndex(r => r.runId === this.selected));
      const next = Math.max(0, Math.min(runs.length - 1, at + (key === 'up' || key === 'k' ? -1 : 1)));
      return this.select(runs[next].runId, true);
    }
    if (key === 'f' && this.snapshot.active) return this.select(this.snapshot.active, false);
    if (key === 'g') return this.refresh();
    if (key === 't' && this.snapshot.triggersOn !== null) { this.confirm(triggerAction(this.snapshot.triggersOn)); return; }
    if (key === 'r' && this.selected) {
      const runId = this.selected, generation = this.generation;
      try {
        const report = await this.effects.report(runId);
        if (!this.closed && generation === this.generation && !this.pending) { this.report = report; this.scroll = 0; }
      } catch (error) { this.noticeTone = 'error'; this.notice = `讀不到報告：${reason(error)}`; }
      this.changed(); return;
    }
    if (/^[1-9]$/.test(key) && this.detail?.runId === this.selected) {
      const action = actionsFor(this.detail)[Number(key) - 1];
      if (action) this.confirm(action);
    }
  }
}
