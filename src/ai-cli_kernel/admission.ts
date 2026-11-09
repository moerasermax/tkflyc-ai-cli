/** Machine-wide admission. Configuration is local, human-owned, never a mandate/MCP input. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, digestText, kernelRunDir, kernelStateDir, RunStore } from './journal.js';
import { openActions, replayJournal } from './replay.js';
import { isTerminalState, type KernelContract } from './types.js';
import { agentForModel, readQuota } from './runtime.js';
import { identityAlive, processIdentity, withProcessMutex, retryProcessMutex, type MutexRetryDeps } from './process-mutex.js';
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
/** keys 為 null 只出現在舊版 run 的 legacy 名額紀錄：repo 判斷不了，同 repo 判斷時保守當成和每個 run 同 repo。 */
interface Slot extends ActiveRun { keys: RepoKeys | null; codex: boolean; owner: ProcessIdentity; legacy?: true }
const slotsDir = () => join(kernelStateDir(), 'active-runs');
const slotPath = (runId: string) => { kernelRunDir(runId); return join(slotsDir(), `${runId}.json`); };
/** 舊版 run 的名額紀錄。檔名刻意不符合新版名額的格式，storedSlots／readReservedRun 不會把它當成新版名額。 */
const legacyRecordPath = (runId: string) => { kernelRunDir(runId); return join(slotsDir(), `${runId}.legacy.json`); };
const RUN_ID = /^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
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
/** 不是有效 run id（舊版標記被手動改壞等）就當成不存在，不讓整個 admission 因此丟例外。 */
function liveState(runId: string): ReturnType<typeof replayJournal> | null {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return null;
  const store = new RunStore(kernelRunDir(runId));
  if (!existsSync(store.contractPath)) return null;
  const view = replayJournal(store.read());
  return isTerminalState(view.state) ? null : view;
}
function readSlotFiles(pattern: RegExp): Slot[] {
  if (!existsSync(slotsDir())) return [];
  return readdirSync(slotsDir()).filter(file => pattern.test(file)).flatMap(file => {
    try { return [JSON.parse(readFileSync(join(slotsDir(), file), 'utf8')) as Slot]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  });
}
function storedSlots(): Slot[] { return readSlotFiles(/^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}\.json$/); }
function legacyRecords(): Slot[] { return readSlotFiles(/^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}\.legacy\.json$/); }
/** Only inside the admission mutex. A legacy record lives while its run is non-terminal
 * and has not been converted to a new-format slot; otherwise it is reclaimed here. */
function liveLegacyRecords(): Slot[] {
  return legacyRecords().filter(record => {
    if (liveState(record.runId) && !existsSync(slotPath(record.runId))) return true;
    rmSync(legacyRecordPath(record.runId), { force: true });
    return false;
  });
}
const legacyPath = () => join(kernelStateDir(), 'active.lock');
type Marker = { runId: string; at?: string };
function readLegacyLock(): Marker | null {
  try { return JSON.parse(readFileSync(legacyPath(), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const LEGACY_OWNER: ProcessIdentity = { pid: 0, started: '', name: 'legacy' };
/** 舊版 run 的名額資料。repo 判斷不了時 keys 記 null，同 repo 判斷保守當成同 repo：
 * 舊版自己就只允許全機一個 run，這樣擋不會比舊版寬。 */
function describeLegacy(runId: string, at: string | undefined): Slot | null {
  if (!liveState(runId)) return null;
  const contract = new RunStore(kernelRunDir(runId)).readContract();
  let keys: RepoKeys | null;
  try { keys = repoKeys(contract); } catch { keys = null; }
  return { runId, keys, repo: keys?.repo ?? '(unknown)', models: models(contract), codex: usesCodex(contract), acquiredAt: at ?? '', owner: LEGACY_OWNER, legacy: true };
}
function legacySlot(slots: Slot[]): Slot | null {
  const legacy = readLegacyLock();
  if (!legacy || slots.some(slot => slot.runId === legacy.runId)) return null;
  return describeLegacy(legacy.runId, legacy.at);
}
/** Record a live run that has no new-format slot as a legacy reservation, so admission counts it
 * independently of the marker. Returns whether such a record now exists. */
function recordLegacy(marker: Marker): boolean {
  if (!liveState(marker.runId) || existsSync(slotPath(marker.runId))) return false;
  if (existsSync(legacyRecordPath(marker.runId))) return true;
  const record = describeLegacy(marker.runId, marker.at);
  if (!record) return false;
  mkdirSync(slotsDir(), { recursive: true });
  atomicWrite(legacyRecordPath(marker.runId), JSON.stringify(record));
  return true;
}
/** Move the marker aside atomically and return what it held. Never overwrite in place:
 * an old launcher may have won wx after our last read, and an overwrite would lose it.
 * A half-written old marker (wx then write) is re-read briefly before giving up on it. */
function takeMarker(): Marker | null {
  const aside = `${legacyPath()}.${process.pid}.${randomBytes(4).toString('hex')}.taken`;
  try { renameSync(legacyPath(), aside); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    for (let attempt = 0; ; attempt++) {
      try { return JSON.parse(readFileSync(aside, 'utf8')) as Marker; }
      catch (error) {
        if (!(error instanceof SyntaxError) || attempt >= 50) return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally { rmSync(aside, { force: true }); }
}
function putMarker(marker: Marker): boolean {
  try {
    const fd = openSync(legacyPath(), 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ runId: marker.runId, at: marker.at })); fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
/**
 * Only called inside the admission mutex. The old release deletes active.lock whenever the
 * runId matches, so while any new-format slot exists the marker must name one of `targets`
 * (never a legacy run). Without targets it may keep naming a live legacy run; otherwise it is
 * pointed back at a live legacy record, or removed when stale (terminal/missing/released).
 * Markers are displaced by rename, never overwritten, and every displaced live run without
 * a new-format slot becomes a legacy record. `blockAwaiting` keeps the c646 rule for an old
 * launcher's approval window: refuse and leave its marker alone — unless this call already
 * displaced a live legacy run, in which case the newcomer is recorded too so nothing is lost.
 */
function reconcileLegacyMarker(targets: Slot[], released: ReadonlySet<string> = new Set(), blockAwaiting = false): void {
  const ids = new Set(targets.map(slot => slot.runId));
  let captured = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const marker = readLegacyLock();
    const foreign = marker && !ids.has(marker.runId) && !released.has(marker.runId) ? liveState(marker.runId) : null;
    if (foreign?.state === 'awaiting_approval' && blockAwaiting && !captured) {
      throw new AdmissionBlocked('slots_full', [marker!.runId], `舊版正在核准，保留 active.lock；可用 ai-cli kernel cancel ${marker!.runId} 釋放`);
    }
    let want: Marker | null;
    if (targets.length) want = marker && ids.has(marker.runId) ? marker : { runId: targets[0].runId, at: targets[0].acquiredAt };
    else if (foreign) want = marker;
    else {
      const record = liveLegacyRecords().find(slot => !released.has(slot.runId));
      want = record ? { runId: record.runId, at: record.acquiredAt || undefined } : null;
    }
    if ((marker?.runId ?? null) === (want?.runId ?? null)) return;
    if (marker) {
      const taken = takeMarker();
      if (taken && taken.runId !== want?.runId && !ids.has(taken.runId) && !released.has(taken.runId) && recordLegacy(taken)) captured = true;
    }
    if (!want) continue;
    // Re-read after publishing: anything else found there is handled by the next pass.
    if (putMarker(want) && readLegacyLock()?.runId === want.runId) return;
  }
  throw new Error('active.lock 持續被其他程序改動，放棄協調');
}
/** Legacy readActiveRun also exposes the short, not-yet-approved reservation window. */
export function readReservedRun(): string | null { return storedSlots()[0]?.runId ?? null; }
export function readActiveRuns(): ActiveRun[] {
  const all = storedSlots();
  const slots = all.filter(slot => { const view = liveState(slot.runId); return view && view.state !== 'awaiting_approval'; });
  for (const record of legacyRecords()) {
    if (!all.some(slot => slot.runId === record.runId) && liveState(record.runId)) slots.push(record);
  }
  const legacy = legacySlot([...all, ...slots]);
  if (legacy) slots.push(legacy);
  return slots.sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.runId.localeCompare(b.runId)).map(({ runId, repo, models, acquiredAt }) => ({ runId, repo, models, acquiredAt }));
}
/** Bounded retries (retryProcessMutex). `keep` runs inside the admission mutex, so a
 * runner claiming its slot cannot interleave between the check and the removal. */
export async function releaseRunSlot(runId: string, deps: Partial<MutexRetryDeps> = {}, keep?: () => boolean | Promise<boolean>): Promise<void> {
  await retryProcessMutex('admission', async () => {
    if (keep && await keep()) return;
    rmSync(slotPath(runId), { force: true });
    rmSync(legacyRecordPath(runId), { force: true });
    const remaining = storedSlots().filter(slot => { const view = liveState(slot.runId); return view && view.state !== 'awaiting_approval'; });
    // The last release also reclaims a marker naming a terminal/missing run; otherwise old
    // launchers would stay blocked by it until some later admission happened to run.
    reconcileLegacyMarker(remaining, new Set([runId]));
  }, deps);
}
/** A launcher can outlive its approving process. Fence a delayed runner against
 * reclamation before it creates runner.json; keep the per-run lock unchanged. */
export async function claimRunnerSlot(store: RunStore, claim: () => Promise<boolean>, deps: Partial<MutexRetryDeps> = {}): Promise<boolean> {
  return retryProcessMutex('admission', async () => {
    if (!readActiveRuns().some(slot => slot.runId === store.runId)) return false;
    return claim();
  }, deps);
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
    const reclaimed = new Set<string>();
    for (const slot of all) {
      const view = liveState(slot.runId);
      // Paused/interrupted runs keep their place. Reclaim a dead admission process's
      // pre-run crash window only when there are no potentially live child actions.
      const runnerPath = join(kernelRunDir(slot.runId), 'runner.json');
      const abandoned = view && view.state === 'running' && !view.openCheck && !openActions(view).length && !existsSync(runnerPath) && !await identityAlive(slot.owner);
      if (!view || view.state === 'awaiting_approval' || abandoned) { rmSync(slotPath(slot.runId), { force: true }); reclaimed.add(slot.runId); continue; }
      active.push(slot);
    }
    const candidate: Slot = { runId: store.runId, repo: keys.repo, keys, models: models(contract), codex: usesCodex(contract, deps.agentFor), acquiredAt: active.find(slot => slot.runId === store.runId)?.acquiredAt ?? new Date().toISOString(), owner: await processIdentity() };
    let own: Slot | undefined = active.find(slot => slot.runId === store.runId);
    try {
      // Publish compatibility exclusion BEFORE a new slot/start. A pending legacy
      // launcher may acquire wx at any time, including during identity lookup.
      // The candidate is a target, so a marker naming this run while it has no slot file
      // (crash after the marker write, before the slot write) is treated as our own
      // leftover, not as an old launcher approving it.
      reconcileLegacyMarker([...active, candidate], reclaimed, true);
      // Legacy runs are counted from their own records, independent of the marker.
      const occupied = [...active, ...liveLegacyRecords().filter(record => !active.some(slot => slot.runId === record.runId))];
      own = occupied.find(slot => slot.runId === store.runId);
      const current = replayJournal(store.read());
      if (isTerminalState(current.state) || store.cancelRequested()) throw new Error('run 已結束或取消，拒絕取得名額');
      const others = occupied.filter(slot => slot.runId !== store.runId);
      // A legacy run whose repo could not be determined (keys null) conflicts with every repo.
      const same = others.filter(slot => !slot.keys || slot.keys.common === keys.common || keys.origin && slot.keys.origin === keys.origin);
      if (same.length) throw new AdmissionBlocked('same_repo', same.map(slot => slot.runId), '同 repo 同時最多一個 run');
      const held = others.map(slot => slot.runId);
      if (!own && others.length >= config.maxRuns) throw new AdmissionBlocked('slots_full', held, `全機名額已滿（上限 ${config.maxRuns}，硬上限 3）`);
      if (!own && others.length && (!validPercent(claude) || claude < config.claudeMinRemainingPercent)) throw new AdmissionBlocked('claude_quota', held, `Claude 週額度${validPercent(claude) ? `剩 ${claude}% < ${config.claudeMinRemainingPercent}%` : '未知'}，全機退回 1 名額`);
      const codexRun = usesCodex(contract, deps.agentFor);
      const codexHolders = others.filter(slot => slot.codex);
      if (!own && codexRun && codexHolders.length && (!validPercent(codex) || codex < config.codexMinRemainingPercent)) throw new AdmissionBlocked('codex_quota', codexHolders.map(slot => slot.runId), `Codex 週額度${validPercent(codex) ? `剩 ${codex}% < ${config.codexMinRemainingPercent}%` : '未知'}，不能同時兩個用到 Codex 的 run`);
      mkdirSync(slotsDir(), { recursive: true });
      const slot: Slot = { ...candidate, acquiredAt: own?.acquiredAt || candidate.acquiredAt };
      atomicWrite(slotPath(store.runId), JSON.stringify(slot));
      start();
      // A legacy run resumed by this version now holds a new-format slot instead.
      rmSync(legacyRecordPath(store.runId), { force: true });
    } catch (error) {
      // A legacy own keeps its legacy record, not the slot written for this attempt.
      if (!own || own.legacy) rmSync(slotPath(store.runId), { force: true });
      if (!own) reclaimed.add(store.runId);
      reconcileLegacyMarker(active, reclaimed);
      throw error;
    }
  });
}
