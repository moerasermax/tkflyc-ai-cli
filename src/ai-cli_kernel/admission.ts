/** Machine-wide admission. Configuration is local, human-owned, never a mandate/MCP input. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, digestText, kernelRunDir, kernelStateDir, RunStore } from './journal.js';
import { openActions, replayJournal } from './replay.js';
import { isTerminalState, type KernelContract } from './types.js';
import { agentForModel, readQuota } from './runtime.js';
import { identityAlive, processIdentity, withProcessMutex } from './process-mutex.js';
import type { ProcessIdentity } from '../core/live-jobs.js';

export interface ConcurrencyConfig { maxRuns: number; claudeMinRemainingPercent: number; codexMinRemainingPercent: number }
export const DEFAULT_CONCURRENCY: ConcurrencyConfig = { maxRuns: 3, claudeMinRemainingPercent: 10, codexMinRemainingPercent: 20 };
export function validateConcurrencyConfig(value: unknown): ConcurrencyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('並行設定必須是物件');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!Object.hasOwn(DEFAULT_CONCURRENCY, key)) throw new Error(`未知並行設定：${key}`);
  const config = { ...DEFAULT_CONCURRENCY, ...raw } as ConcurrencyConfig;
  if (!Number.isInteger(config.maxRuns) || config.maxRuns < 1 || config.maxRuns > 3) throw new Error('maxRuns 只能是 1～3，硬上限 3');
  for (const key of ['claudeMinRemainingPercent', 'codexMinRemainingPercent'] as const) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < 0 || config[key] > 100) throw new Error(`${key} 必須是 0～100`);
  }
  return config;
}
export function readConcurrencyConfig(): ConcurrencyConfig {
  try { return validateConcurrencyConfig(JSON.parse(readFileSync(join(kernelStateDir(), 'concurrency.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONCURRENCY }; throw error; }
}

interface RepoKeys { repo: string; common: string; origin: string | null }
export interface ActiveRun { runId: string; repo: string; models: { decide: string; worker: string; allowedWorkers: string[] }; acquiredAt: string }
interface Slot extends ActiveRun { keys: RepoKeys; codex: boolean; owner: ProcessIdentity }
const slotsDir = () => join(kernelStateDir(), 'active-runs');
const slotPath = (runId: string) => { kernelRunDir(runId); return join(slotsDir(), `${runId}.json`); };
const pathKey = (path: string) => { const real = realpathSync.native(path); return process.platform === 'win32' ? real.toLowerCase() : real; };
function git(folder: string, ...args: string[]) {
  return spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
}
/** Compare transports/scp spellings of the same host/path; persist only a hash, never URL credentials. */
export function normalizedOrigin(raw: string, folder: string): string {
  const scp = !isAbsolute(raw) && !/^[a-z]:/i.test(raw) ? raw.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/i) : null;
  let key: string;
  if (raw.includes('://')) {
    const url = new URL(raw);
    if (url.protocol === 'file:') key = `file:${pathKey(fileURLToPath(url))}`;
    else key = `${url.hostname.toLowerCase()}${url.port && !['22', '80', '443', '9418'].includes(url.port) ? `:${url.port}` : ''}/${decodeURIComponent(url.pathname).replace(/^\/+/, '')}`;
  } else if (scp) key = `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, '')}`;
  else key = `file:${pathKey(resolve(folder, raw))}`;
  return digestText(key.replace(/\/+$/, '').replace(/\.git$/i, ''));
}
function repoKeys(contract: KernelContract): RepoKeys {
  const folder = contract.develop?.repoRoot ?? contract.workFolder;
  const common = git(folder, 'rev-parse', '--git-common-dir');
  if (common.status !== 0) {
    if (contract.develop || common.error || !/not a git repository/i.test(common.stderr ?? '')) throw new Error('無法確認 git repo 身分');
    const real = pathKey(folder);
    return { repo: real, common: real, origin: null };
  }
  const real = pathKey(resolve(folder, common.stdout.trim()));
  const origin = git(folder, 'remote', 'get-url', 'origin');
  if (origin.status !== 0 && (origin.error || !/No such remote/i.test(origin.stderr ?? ''))) throw new Error('無法讀取 origin 身分（URL 已隱去）');
  let normalized: string | null = null;
  try { normalized = origin.status === 0 ? normalizedOrigin(origin.stdout.trim(), folder) : null; }
  catch { throw new Error('無法正規化 origin 身分（URL 已隱去）'); }
  return { repo: real, common: real, origin: normalized };
}
function models(contract: KernelContract): ActiveRun['models'] {
  return { decide: contract.decide.model, worker: contract.worker.model, allowedWorkers: contract.allowedWorkerModels };
}
function usesCodex(contract: KernelContract, agentFor = agentForModel): boolean {
  return [contract.decide.model, contract.worker.model, ...contract.allowedWorkerModels].some(model => agentFor(model) === 'codex');
}
function liveState(runId: string): ReturnType<typeof replayJournal> | null {
  const store = new RunStore(kernelRunDir(runId));
  if (!existsSync(store.contractPath)) return null;
  const view = replayJournal(store.read());
  return isTerminalState(view.state) ? null : view;
}
function storedSlots(): Slot[] {
  if (!existsSync(slotsDir())) return [];
  return readdirSync(slotsDir()).filter(file => /^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}\.json$/.test(file)).flatMap(file => {
    try { return [JSON.parse(readFileSync(join(slotsDir(), file), 'utf8')) as Slot]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  });
}
function legacySlot(): Slot | null {
  let legacy: { runId: string; at?: string };
  try { legacy = JSON.parse(readFileSync(join(kernelStateDir(), 'active.lock'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const view = liveState(legacy.runId);
  if (!view || view.state === 'awaiting_approval') return null;
  const contract = new RunStore(kernelRunDir(legacy.runId)).readContract();
  const keys = repoKeys(contract);
  return { runId: legacy.runId, keys, repo: keys.repo, models: models(contract), codex: usesCodex(contract), acquiredAt: legacy.at ?? '', owner: { pid: 0, started: '', name: 'legacy' } };
}
/** Legacy readActiveRun also exposes the short, not-yet-approved reservation window. */
export function readReservedRun(): string | null { return storedSlots()[0]?.runId ?? null; }
export function readActiveRuns(): ActiveRun[] {
  const slots = storedSlots().filter(slot => { const view = liveState(slot.runId); return view && view.state !== 'awaiting_approval'; });
  const legacy = legacySlot();
  if (legacy && !slots.some(slot => slot.runId === legacy.runId)) slots.push(legacy);
  return slots.sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.runId.localeCompare(b.runId)).map(({ runId, repo, models, acquiredAt }) => ({ runId, repo, models, acquiredAt }));
}
export function releaseRunSlot(runId: string): void { rmSync(slotPath(runId), { force: true }); }
/** A launcher can outlive its approving process. Fence a delayed runner against
 * reclamation before it creates runner.json; keep the per-run lock unchanged. */
export async function claimRunnerSlot(store: RunStore, claim: () => Promise<boolean>): Promise<boolean> {
  return withProcessMutex('admission', async () => {
    if (!readActiveRuns().some(slot => slot.runId === store.runId)) return false;
    return claim();
  });
}
export class AdmissionBlocked extends Error {
  constructor(readonly reason: 'same_repo' | 'slots_full' | 'claude_quota' | 'codex_quota', readonly heldBy: string[], detail: string) {
    super(`${detail}；佔用 run：${heldBy.join('、')}`);
  }
}
export interface AdmissionDeps { quota?(agent: string): Promise<number | null>; agentFor?(model: string): string }
const validPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Caller supplies the durable approved/running writes; no runner starts until this returns.
 * Only short coordination waits happen here; a blocked admission is rejected, never queued.
 */
export async function admitRun(store: RunStore, start: () => void, deps: AdmissionDeps = {}): Promise<void> {
  const quota = deps.quota ?? readQuota;
  const [claude, codex] = await Promise.all(['claude', 'codex'].map(agent => quota(agent).catch(() => null)));
  await withProcessMutex('admission', async () => {
    const config = readConcurrencyConfig(); // validate every entry, including existing-slot resume.
    const contract = store.readContract(), keys = repoKeys(contract);
    const all = storedSlots();
    const active: Slot[] = [];
    for (const slot of all) {
      const view = liveState(slot.runId);
      // Paused/interrupted runs keep their place. Reclaim a dead admission process's
      // pre-run crash window only when there are no potentially live child actions.
      const runnerPath = join(kernelRunDir(slot.runId), 'runner.json');
      const abandoned = view && view.state === 'running' && !view.openCheck && !openActions(view).length && !existsSync(runnerPath) && !await identityAlive(slot.owner);
      if (!view || view.state === 'awaiting_approval' || abandoned) { releaseRunSlot(slot.runId); continue; }
      active.push(slot);
    }
    const legacy = legacySlot();
    if (legacy && !active.some(slot => slot.runId === legacy.runId)) active.push(legacy);
    if (!legacy) rmSync(join(kernelStateDir(), 'active.lock'), { force: true });
    const current = replayJournal(store.read());
    if (isTerminalState(current.state) || store.cancelRequested()) throw new Error('run 已結束或取消，拒絕取得名額');
    const own = active.find(slot => slot.runId === store.runId);
    const others = active.filter(slot => slot.runId !== store.runId);
    const same = others.filter(slot => slot.keys.common === keys.common || keys.origin && slot.keys.origin === keys.origin);
    if (same.length) throw new AdmissionBlocked('same_repo', same.map(slot => slot.runId), '同 repo 同時最多一個 run');
    const held = others.map(slot => slot.runId);
    if (!own && others.length >= config.maxRuns) throw new AdmissionBlocked('slots_full', held, `全機名額已滿（上限 ${config.maxRuns}，硬上限 3）`);
    if (!own && others.length && (!validPercent(claude) || claude < config.claudeMinRemainingPercent)) throw new AdmissionBlocked('claude_quota', held, `Claude 週額度${validPercent(claude) ? `剩 ${claude}% < ${config.claudeMinRemainingPercent}%` : '未知'}，全機退回 1 名額`);
    const codexRun = usesCodex(contract, deps.agentFor);
    const codexHolders = others.filter(slot => slot.codex);
    if (!own && codexRun && codexHolders.length && (!validPercent(codex) || codex < config.codexMinRemainingPercent)) throw new AdmissionBlocked('codex_quota', codexHolders.map(slot => slot.runId), `Codex 週額度${validPercent(codex) ? `剩 ${codex}% < ${config.codexMinRemainingPercent}%` : '未知'}，不能同時兩個用到 Codex 的 run`);
    mkdirSync(slotsDir(), { recursive: true });
    const slot: Slot = { runId: store.runId, repo: keys.repo, keys, models: models(contract), codex: codexRun, acquiredAt: own?.acquiredAt ?? new Date().toISOString(), owner: await processIdentity() };
    atomicWrite(slotPath(store.runId), JSON.stringify(slot));
    try { start(); }
    catch (error) { if (!own) releaseRunSlot(store.runId); throw error; }
  });
}
