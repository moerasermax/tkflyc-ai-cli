/** 主動觸發：一次檢查、先記名額再開工；帳本與 run 日誌共同保留跨程序事實。 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCanStartJob } from '../core/worker-env.js';
import { atomicWrite, kernelRunDir, kernelStateDir, newRunId, RunStore } from './journal.js';
import { aiCliKernelMandateShow } from './mandates.js';
import { replayJournal } from './replay.js';
import { AdmissionBlocked } from './admission.js';
import { agentForModel } from './runtime.js';
import { buildContract } from './templates.js';
import { describeRepo } from './workspace.js';

export interface KernelTriggerResult {
  status: 'started' | 'skipped' | 'failed'; reason: string; mandate: string; runId: string | null; detail: string;
}
interface TriggerRecord extends KernelTriggerResult { at: string; day: string; event: 'attempt' | 'reserved' | 'result'; digest?: string }
export interface KernelTriggerDeps {
  now(): number;
  approveAndStart(store: RunStore, note: string, beforeStart: () => void): Promise<unknown>;
  /** 測試用：在最後一次授權檢查之前插入事件。 */
  beforeStart?(): void;
}
function safePath(name: string): string {
  const path = join(kernelStateDir(), name);
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('觸發路徑不能是符號連結'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}
export function aiCliKernelTriggersEnabled(): boolean {
  try {
    const record = JSON.parse(readFileSync(safePath('triggers.json'), 'utf8'));
    if (typeof record.enabled !== 'boolean') throw new Error('觸發開關損毀');
    return record.enabled;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function aiCliKernelTriggersSetEnabled(enabled: boolean): { enabled: boolean } {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必須是布林值');
  if (process.env.AI_CLI_WORKER === '1') throw new Error('worker 不能變更主動觸發開關');
  mkdirSync(kernelStateDir(), { recursive: true });
  atomicWrite(safePath('triggers.json'), JSON.stringify({ enabled }) + '\n');
  return { enabled };
}
/** 本機日曆日；不用 UTC 切日，也不用固定 24 小時推算跨日。 */
export function aiCliKernelTriggerDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function records(): TriggerRecord[] {
  let text: string;
  try { text = readFileSync(safePath('triggers.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (text && !text.endsWith('\n')) throw new Error('觸發帳本殘行，請人工對帳');
  return text.split('\n').filter(Boolean).map(line => {
    const record = JSON.parse(line) as TriggerRecord;
    if (!record || !['attempt', 'reserved', 'result'].includes(record.event) || typeof record.mandate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(record.day) || !Number.isFinite(Date.parse(record.at)) ||
      (record.event === 'reserved' && (typeof record.runId !== 'string' || typeof record.digest !== 'string'))) throw new Error('觸發帳本格式損毀');
    return record;
  });
}
function append(record: TriggerRecord): void {
  records(); // 不覆蓋或跳過可能已扣帳的殘行。
  mkdirSync(kernelStateDir(), { recursive: true });
  const fd = openSync(safePath('triggers.jsonl'), 'a', 0o600);
  try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
/** 用量永遠由 run 日誌重算；不信任 worker 自報，也不因程序重啟或範本重新核准歸零。 */
function dailyUsage(name: string, day: string): { runs: number; tokens: number } {
  const reservations = records().filter(record => record.event === 'reserved' && record.mandate === name && record.day === day);
  let tokens = 0;
  const seen = new Set<string>();
  for (const record of reservations) {
    if (seen.has(record.runId!)) throw new Error('觸發帳本重複名額，請人工對帳');
    seen.add(record.runId!);
    const store = new RunStore(kernelRunDir(record.runId!));
    if (!existsSync(store.contractPath)) throw new Error('已保留名額的 run 缺失，用量未知');
    const events = store.read();
    const raw = readFileSync(store.journalPath, 'utf8');
    if (!raw.endsWith('\n') || events.length === 0) throw new Error('已保留名額的 run 日誌不完整，用量未知');
    for (const line of raw.split('\n').filter(Boolean)) JSON.parse(line); // 用量不能忽略損毀的末行。
    const view = replayJournal(events);
    if (view.counters.unknownUsage > 0 || [...view.actions.values()].some(action => !action.outcome)) throw new Error('已保留名額的 run 用量未知');
    tokens += Math.max(0, view.counters.inputTokens - view.counters.cachedTokens);
    if (!Number.isSafeInteger(tokens)) throw new Error('每日用量超出安全範圍');
  }
  return { runs: reservations.length, tokens };
}

/** 由 loop 入口注入啟動能力。沒有佇列、常駐程序或失敗重試。 */
export async function aiCliKernelRunTrigger(name: string, deps: KernelTriggerDeps): Promise<KernelTriggerResult> {
  const now = deps.now(); // 授權、用量與名額使用同一時點，避免檢查中途跨午夜。
  let runId: string | null = null, starting = false;
  let fd: number | undefined;
  let lockPath: string | undefined;
  const result = (status: KernelTriggerResult['status'], reason: string, detail = ''): KernelTriggerResult => ({ status, reason, mandate: name, runId, detail });
  const record = (value: KernelTriggerResult, event: TriggerRecord['event'] = 'result', digest?: string): KernelTriggerResult => {
    append({ ...value, at: new Date(now).toISOString(), day: aiCliKernelTriggerDay(now), event, ...(digest ? { digest } : {}) });
    return value;
  };
  try {
    if (!aiCliKernelTriggersEnabled()) return record(result('skipped', 'triggers_disabled'));
    assertCanStartJob();
    // 即使呼叫端允許巢狀派工，主動觸發也不是 worker 的權限。
    if (process.env.AI_CLI_WORKER === '1') return record(result('skipped', 'worker_forbidden'));
    mkdirSync(kernelStateDir(), { recursive: true });
    lockPath = safePath('triggers.lock');
    try { fd = openSync(lockPath, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return record(result('skipped', 'trigger_busy')); throw error; }
    const mandate = aiCliKernelMandateShow({ name });
    if (!mandate.approval) return record(result('skipped', 'mandate_unapproved'));
    if (mandate.approval.digest !== mandate.digest) return record(result('skipped', 'mandate_changed'));
    if (now >= Date.parse(mandate.approval.expiresAt)) return record(result('skipped', 'mandate_expired'));
    const usage = dailyUsage(name, aiCliKernelTriggerDay(now));
    if (usage.runs >= mandate.limits.maxRunsPerDay) return record(result('skipped', 'daily_runs_limit'));
    if (usage.tokens >= mandate.limits.maxInputTokensPerDay) return record(result('skipped', 'daily_tokens_limit'));
    runId = newRunId(new Date(now));
    const contract = buildContract({ ...mandate.input, budget: { ...mandate.input.budget,
      maxInputTokens: Math.min(mandate.input.budget?.maxInputTokens ?? Infinity, mandate.limits.maxInputTokensPerDay - usage.tokens),
    } }, new Date(now), { runId, worktree: join(kernelRunDir(runId), 'wt') });
    contract.origin = { kind: 'trigger', mandate: name, digest: mandate.digest };
    if (contract.develop?.checkpoint?.mode === 'off') { runId = null; return record(result('skipped', 'checkpoint_off_forbidden')); }
    // Create before admission: a crash can never leave a slot pointing at a missing run.
    const store = new RunStore(kernelRunDir(runId));
    store.create(contract);
    const root = contract.develop?.repoRoot ?? describeRepo(contract.workFolder)?.root ?? contract.workFolder;
    const hooks = existsSync(join(root, '.codex', 'hooks.json')) && contract.allowedWorkerModels.some(model => agentForModel(model) === 'codex');
    const note = `委任範本 ${name}（${mandate.digest}）主動觸發。${hooks ? '專案層 .codex/hooks.json 在新 worktree 可能不生效。' : ''}`;
    await deps.approveAndStart(store, note, () => {
      record(result('started', 'reserved'), 'reserved', mandate.digest);
      record(result('started', 'starting'), 'attempt');
      deps.beforeStart?.();
      const current = aiCliKernelMandateShow({ name });
      const revoked = !aiCliKernelTriggersEnabled() ? 'triggers_disabled'
        : !current.approval ? 'mandate_unapproved'
        : current.digest !== mandate.digest || current.approval.digest !== mandate.digest ? 'mandate_changed'
        : Math.max(now, Date.now()) >= Date.parse(current.approval.expiresAt) ? 'mandate_expired' : null;
      if (revoked) throw new Error(`trigger_revoked:${revoked}`);
      starting = true;
    });
    return record(result('started', 'started'));
  } catch (error) {
    const detail = (error as Error).message;
    const revoked = detail.match(/^trigger_revoked:(.+)$/)?.[1];
    if (runId && !starting && existsSync(join(kernelRunDir(runId), 'contract.json'))) {
      try { new RunStore(kernelRunDir(runId)).append({ type: 'state', state: 'cancelled', reason: revoked ?? 'trigger_admission_failed', detail }); }
      catch { return { ...result('failed', 'trigger_error', detail), detail: `${detail}；無法記錄停止狀態，請人工對帳` }; }
    }
    const value = result(starting ? 'failed' : 'skipped', error instanceof AdmissionBlocked ? error.reason : revoked ?? (/AI_CLI_NESTED_DISPATCH_BLOCKED/.test(detail) ? 'worker_forbidden' : starting ? 'start_failed' : 'trigger_error'), detail);
    // 帳本本身壞掉或無法寫入時只回傳失敗；絕不能因此派工。
    try { return record(value); } catch { return { ...value, status: 'failed', detail: `${detail}；原因無法寫入觸發帳本，請人工對帳` }; }
  } finally {
    if (fd !== undefined) { closeSync(fd); rmSync(lockPath!); }
  }
}
