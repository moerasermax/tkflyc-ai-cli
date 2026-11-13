/** File-backed Lamport bakery mutex. Each contender owns a unique ticket, so a stale
 * collector can never unlink a successor's lock (unlike rename/unlink of one lockfile).
 * Tickets are published whole; even death during publication leaves no shared lock.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { mayBeAlive, sameIdentity } from '../core/job-store.js';
import { lookupIdentities, type ProcessIdentity } from '../core/live-jobs.js';
import { atomicWrite, kernelStateDir } from './journal.js';

interface Ticket { owner: ProcessIdentity; number: number; id: string }
/** Coordination contention is recoverable; a briefly unreadable ticket retains its filesystem cause. */
export class ProcessMutexBusy extends Error {
  constructor(readonly mutex: string, options?: ErrorOptions & { ticket?: string }) {
    const cause = options?.cause as NodeJS.ErrnoException | undefined;
    super(`${mutex} 協調忙碌，請重試（不會將 run 排入佇列）${cause ? `；${cause.code ?? 'UNKNOWN'} ${options?.ticket ?? cause.path ?? ''}` : ''}`, options);
    this.name = 'ProcessMutexBusy';
  }
}
/** Acquisition fails closed; release callers may defer while retaining the filesystem diagnosis. */
export class ProcessMutexReadError extends Error {
  readonly code: string | undefined;
  constructor(readonly mutex: string, readonly ticket: string, cause: NodeJS.ErrnoException) {
    super(`${mutex} 票券持續讀取失敗；${cause.code ?? 'UNKNOWN'} ${ticket}`, { cause });
    this.name = 'ProcessMutexReadError';
    this.code = cause.code;
  }
}
// 同程序跨呼叫辨識持續性讀取錯誤，避免 test-lock 永遠輪詢、marker check 永遠默默跳過。
// 成功／ENOENT 清除；最近 256 個錯誤 ticket 有界保存，程序重啟後觀察重新起算。
const ticketReadFailures = new Map<string, { code: string; since: number }>();
function ticketReadBusy(name: string, file: string, error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code!;
  const previous = ticketReadFailures.get(file);
  const failure = previous?.code === code ? previous : { code, since: performance.now() };
  ticketReadFailures.delete(file);
  ticketReadFailures.set(file, failure);
  if (ticketReadFailures.size > 256) ticketReadFailures.delete(ticketReadFailures.keys().next().value!);
  // 只按同 ticket／errno 的實際經過時間；並行呼叫的耗盡次數不能加速升級。
  if (performance.now() - failure.since >= 2000) throw new ProcessMutexReadError(name, file, error as NodeJS.ErrnoException);
  throw new ProcessMutexBusy(name, { cause: error, ticket: file });
}
export interface MutexRetryDeps {
  mutex: typeof withProcessMutex;
  sleep(ms: number): Promise<void>;
}
/** Three bounded 15s mutex attempts, separated by 1s; never retry other errors. */
export async function retryProcessMutex<T>(name: string, work: () => T | Promise<T>, deps: Partial<MutexRetryDeps> = {}): Promise<T> {
  const mutex = deps.mutex ?? withProcessMutex;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try { return await mutex(name, work); }
    catch (error) {
      if (!(error instanceof ProcessMutexBusy) || attempt >= 2) throw error;
      await sleep(1000);
    }
  }
}
/** Internal factory permits deterministic identity lookup tests without changing process-wide behavior. */
export function createProcessIdentityReader(lookup: typeof lookupIdentities): () => Promise<ProcessIdentity> {
  let self: ProcessIdentity | undefined;
  return async () => {
    if (self) return self;
    const identity = (await lookup([process.pid])).get(process.pid) ?? { pid: process.pid, started: '', name: 'node' };
    if (identity.started) self = identity;
    return identity;
  };
}
export const processIdentity = createProcessIdentityReader(lookupIdentities);
export async function identityAlive(owner: ProcessIdentity): Promise<boolean> {
  if (!mayBeAlive(owner.pid)) return false;
  if (owner.pid === process.pid) return !owner.started || sameIdentity(owner, await processIdentity());
  const live = (await lookupIdentities([owner.pid]).catch(() => new Map<number, ProcessIdentity>())).get(owner.pid);
  return live ? !owner.started || sameIdentity(owner, live) : mayBeAlive(owner.pid);
}

/** `maxWaitMs`（I3）：整次取得的等待上限，從呼叫起算，含第一次身分查詢；取不到就丟 ProcessMutexBusy，
 * 持續讀取失敗另丟 ProcessMutexReadError。finally 照常清掉自己的 ticket。
 * 不給就是原本的 15 秒。只放棄、不搶，所以不影響互斥正確性。 */
export async function withProcessMutex<T>(name: string, work: () => T | Promise<T>, deps: { now?: () => number; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number } = {}): Promise<T> {
  const startedAt = performance.now();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const bounded = deps.maxWaitMs === undefined ? undefined : now() + deps.maxWaitMs;
  const directory = join(kernelStateDir(), `${name}.tickets`);
  mkdirSync(directory, { recursive: true });
  const mine: Ticket = { owner: await processIdentity(), number: 0, id: `${process.pid}-${randomBytes(12).toString('hex')}` };
  const path = join(directory, `${mine.id}.json`);
  const choosing = join(directory, `${mine.id}.choosing.json`);
  const readPause = new Int32Array(new SharedArrayBuffer(4));
  const read = (): Ticket[] => {
    // 每次掃描所有 ticket 共用 80ms wall-clock 重試期限，I/O 與同步等待都消耗同一預算。
    // 有 maxWaitMs 時也不超過整次呼叫剩餘的等待預算；同步 syscall／OS 排程本身無法截斷。
    const readDeadline = Math.min(performance.now() + 80, deps.maxWaitMs === undefined ? Infinity : startedAt + deps.maxWaitMs);
    const tickets = new Map<string, Ticket>();
    for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      const ticketPath = join(directory, file);
      for (;;) {
        try {
          const contents = readFileSync(ticketPath, 'utf8');
          ticketReadFailures.delete(ticketPath);
          const ticket = JSON.parse(contents) as Ticket;
          if (!tickets.has(ticket.id) || tickets.get(ticket.id)!.number < ticket.number) tickets.set(ticket.id, ticket);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') { ticketReadFailures.delete(ticketPath); break; }
          if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
          // Windows 刪除中的 ticket 仍可能被列出，但最後一個 handle 關閉前無法重新開啟。
          // 不能將讀不到當不存在；短暫耗盡保留 cause，持續失敗以專用型別保留原始錯誤。
          const remaining = readDeadline - performance.now();
          if (remaining <= 0) ticketReadBusy(name, ticketPath, error);
          Atomics.wait(readPause, 0, 0, Math.min(5, remaining));
        }
      }
    }
    return [...tickets.values()];
  };
  const alive = new Map<string, boolean>();
  const stale = async (ticket: Ticket): Promise<boolean> => {
    if (alive.get(ticket.id) && !mayBeAlive(ticket.owner.pid)) alive.set(ticket.id, false);
    if (!alive.has(ticket.id)) alive.set(ticket.id, await identityAlive(ticket.owner));
    if (alive.get(ticket.id)) return false;
    rmSync(join(directory, `${ticket.id}.json`), { force: true });
    rmSync(join(directory, `${ticket.id}.choosing.json`), { force: true });
    return true;
  };
  try {
    // Publish each phase once. Replacing a ticket while Windows readers have it
    // open can fail with EPERM. Retain choosing until exit; readers prefer number.
    atomicWrite(choosing, JSON.stringify(mine)); // visible BEFORE reading the max.
    const others = read();
    // Windows identity lookup is expensive. Batch the initial snapshot; repeated
    // live-ticket checks use kill(0), with a fresh identity check on the next call.
    const lookup = lookupIdentities([...new Set(others.filter(ticket => ticket.id !== mine.id).map(ticket => ticket.owner.pid))]).catch(() => new Map<number, ProcessIdentity>());
    // Bounded callers do not wait out a slow identity lookup either: out of time, every ticket whose
    // pid exists counts as alive (never less safe, only more likely busy) and the deadline below gives up.
    const identities = bounded === undefined ? await lookup : await Promise.race([lookup, sleep(Math.max(0, bounded - now())).then(() => new Map<number, ProcessIdentity>())]);
    for (const ticket of others) {
      if (ticket.id === mine.id) continue;
      const live = identities.get(ticket.owner.pid);
      alive.set(ticket.id, live ? !ticket.owner.started || sameIdentity(ticket.owner, live) : mayBeAlive(ticket.owner.pid));
    }
    let maximum = 0;
    for (const ticket of others) if (ticket.id !== mine.id && !await stale(ticket)) maximum = Math.max(maximum, ticket.number);
    mine.number = maximum + 1;
    atomicWrite(path, JSON.stringify(mine));
    const deadline = bounded ?? now() + 15000;
    for (;;) {
      let blocked = false;
      for (const ticket of read()) {
        if (ticket.id === mine.id) continue;
        if (ticket.number !== 0 && (ticket.number > mine.number || ticket.number === mine.number && ticket.id > mine.id)) continue;
        // A dead holder is observed even if it was alive in the initial snapshot.
        if (await stale(ticket)) continue;
        blocked = true;
        break;
      }
      if (!blocked) return await work();
      if (now() >= deadline) throw new ProcessMutexBusy(name);
      await sleep(10);
    }
  } finally {
    rmSync(path, { force: true });
    rmSync(choosing, { force: true });
  }
}
