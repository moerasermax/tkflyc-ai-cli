/**
 * 可重用的委任範本：只保存輸入與有期限的人工同意，不建立 run、不派 worker。
 * 狀態從當前內容和核准推導；後續 trigger 必須重新驗證，不能相信儲存的狀態字串。
 */
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, digestText, kernelStateDir } from './journal.js';
import { buildContract, DEFAULT_BUDGET, type KernelStartInput } from './templates.js';

export interface KernelMandate {
  name: string;
  input: KernelStartInput;
  approval: { digest: string; approvedAt: string; expiresAt: string } | null;
  limits: { maxRunsPerDay: number; maxInputTokensPerDay: number };
}
export interface KernelMandateView extends KernelMandate {
  digest: string;
  status: 'unapproved' | 'approved' | 'expired' | 'changed';
}

function mandateName(name: string): void {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)) {
    throw new Error('範本名稱需為 1–64 個小寫英數、底線或連字號，開頭為英數，不能是系統保留名稱');
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('委任範本含未知欄位');
}
function inputShape(input: unknown): asserts input is KernelStartInput {
  if (!plain(input)) throw new Error('委任範本 input 必須是物件');
  const strings = ['goal', 'workFolder', 'template', 'model', 'effort', 'decideModel', 'decideEffort', 'testCommand', 'setupCommand', 'checkpoint'];
  keys(input, [...strings, 'workerModels', 'allowedPaths', 'budget', 'allowUnverifiedBoundary', 'mandateHours']);
  if (typeof input.goal !== 'string' || !input.goal.trim() || typeof input.workFolder !== 'string' || !input.workFolder) throw new Error('委任範本缺少 goal 或 workFolder');
  for (const key of strings) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} 必須是字串`);
  for (const key of ['workerModels', 'allowedPaths']) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || Array.from(input[key] as unknown[]).some(item => typeof item !== 'string'))) throw new Error(`${key} 必須是字串陣列`);
  }
  if (input.allowUnverifiedBoundary !== undefined && typeof input.allowUnverifiedBoundary !== 'boolean') throw new Error('allowUnverifiedBoundary 必須是布林值');
  if (input.mandateHours !== undefined && (typeof input.mandateHours !== 'number' || !Number.isFinite(input.mandateHours) || input.mandateHours <= 0)) throw new Error('mandateHours 必須是正數');
  if (input.budget !== undefined) {
    if (!plain(input.budget)) throw new Error('budget 必須是物件');
    keys(input.budget, Object.keys(DEFAULT_BUDGET));
    if (Object.values(input.budget).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('budget 必須是非負有限數字');
  }
}
function limit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必須是非負安全整數`);
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
/** 純函式；digest 包含名稱、完整輸入與每日上限，與 JSON 排版、鍵順序無關。 */
export function aiCliKernelMandateDigest(mandate: Pick<KernelMandate, 'name' | 'input' | 'limits'>): string {
  return digestText(canonical({ name: mandate.name, input: mandate.input, limits: mandate.limits }));
}
/** 純函式；expiresAt 當刻即失效。digest 不符優先顯示內容變動。 */
export function aiCliKernelMandateState(mandate: KernelMandate, now = Date.now()): KernelMandateView['status'] {
  if (!mandate.approval) return 'unapproved';
  if (mandate.approval.digest !== aiCliKernelMandateDigest(mandate)) return 'changed';
  return now >= Date.parse(mandate.approval.expiresAt) ? 'expired' : 'approved';
}

function noLink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('委任範本路徑不能是符號連結'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function directory(): string {
  const dir = join(kernelStateDir(), 'mandates');
  noLink(dir);
  return dir;
}
function pathFor(name: string): string {
  mandateName(name);
  const path = join(directory(), `${name}.json`);
  noLink(path);
  return path;
}
function read(name: string): KernelMandate {
  const record: unknown = JSON.parse(readFileSync(pathFor(name), 'utf8'));
  if (!plain(record)) throw new Error('委任範本格式錯誤');
  keys(record, ['name', 'input', 'approval', 'limits']);
  if (record.name !== name) throw new Error('委任範本名稱與檔名不符');
  inputShape(record.input);
  if (!plain(record.limits)) throw new Error('委任範本缺少 limits');
  keys(record.limits, ['maxRunsPerDay', 'maxInputTokensPerDay']);
  limit('maxRunsPerDay', record.limits.maxRunsPerDay as number);
  limit('maxInputTokensPerDay', record.limits.maxInputTokensPerDay as number);
  if (record.approval !== null) {
    const approval = record.approval;
    if (!plain(approval)) throw new Error('委任範本核准格式錯誤');
    keys(approval, ['digest', 'approvedAt', 'expiresAt']);
    if (typeof approval.digest !== 'string' || !/^[a-f0-9]{64}$/.test(approval.digest) ||
      typeof approval.approvedAt !== 'string' || typeof approval.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(approval.approvedAt)) || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) throw new Error('委任範本核准格式錯誤');
  }
  return record as unknown as KernelMandate;
}
function view(record: KernelMandate): KernelMandateView {
  return { ...record, digest: aiCliKernelMandateDigest(record), status: aiCliKernelMandateState(record) };
}
function write(record: KernelMandate): KernelMandateView {
  atomicWrite(pathFor(record.name), JSON.stringify(record, null, 2) + '\n');
  return view(record);
}
/** 同名寫入互斥；中斷留下的鎖交由人對帳，不猜測、不重試。 */
function mutate<T>(name: string, action: () => T): T {
  const path = pathFor(name);
  mkdirSync(directory(), { recursive: true });
  const lock = `${path}.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  try { return action(); }
  finally { closeSync(fd); rmSync(lock); }
}

export function aiCliKernelMandateSave(request: { name: string; input: KernelStartInput; maxRunsPerDay?: number; maxInputTokensPerDay?: number }): KernelMandateView {
  mandateName(request.name);
  inputShape(request.input);
  // 使用既有驗證與預設值，但不保存 run 專用的分支、回復點 ref 或到期時間。
  const contract = buildContract(request.input, new Date(), { runId: 'kr-20000101-000000-0000', worktree: join(directory(), 'validation-only') });
  const input: KernelStartInput = {
    goal: contract.goal, workFolder: contract.workFolder, template: contract.template,
    model: contract.worker.model, effort: contract.worker.effort, decideModel: contract.decide.model, decideEffort: contract.decide.effort,
    workerModels: contract.allowedWorkerModels, budget: contract.budget, allowUnverifiedBoundary: contract.allowUnverifiedBoundary,
    ...(contract.develop ? {
      testCommand: contract.develop.testCommand,
      ...(contract.develop.setupCommand ? { setupCommand: contract.develop.setupCommand } : {}),
      allowedPaths: request.input.allowedPaths ?? [], mandateHours: request.input.mandateHours ?? 24, checkpoint: contract.develop.checkpoint!.mode,
    } : {}),
  };
  const record: KernelMandate = {
    name: request.name, input, approval: null,
    limits: { maxRunsPerDay: limit('maxRunsPerDay', request.maxRunsPerDay ?? 1), maxInputTokensPerDay: limit('maxInputTokensPerDay', request.maxInputTokensPerDay ?? 2000000) },
  };
  return mutate(record.name, () => write(record));
}

/** 只有 CLI 暴露核准；worker 即使允許巢狀派工也不能寫入人工同意。 */
export function aiCliKernelMandateApprove(request: { name: string; acknowledgeUnisolated?: boolean; days?: number }): KernelMandateView {
  if (process.env.AI_CLI_WORKER === '1') throw new Error('worker 不能核准委任範本；請由人使用 CLI 決定');
  const days = request.days ?? 30;
  const now = Date.now();
  const expires = now + days * 86400000;
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(new Date(expires).getTime()) || new Date(expires).getTime() <= now) throw new Error('days 必須是有效的正數天數');
  return mutate(request.name, () => {
    const record = read(request.name);
    buildContract(record.input, new Date(), { runId: 'kr-20000101-000000-0000', worktree: join(directory(), 'validation-only') });
    if (record.input.template === 'develop' && request.acknowledgeUnisolated !== true) throw new Error('develop 必須加 --acknowledge-unisolated：worker 權限等於你本人，未隔離');
    record.approval = { digest: aiCliKernelMandateDigest(record), approvedAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString() };
    return write(record);
  });
}
export function aiCliKernelMandateShow(request: { name: string }): KernelMandateView { return view(read(request.name)); }
export function aiCliKernelMandateList(): KernelMandateView[] {
  let names: string[];
  try { names = readdirSync(directory()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(name => name.endsWith('.json')).sort().map(name => aiCliKernelMandateShow({ name: name.slice(0, -5) }));
}
export function aiCliKernelMandateRevoke(request: { name: string }): KernelMandateView {
  return mutate(request.name, () => { const record = read(request.name); record.approval = null; return write(record); });
}
