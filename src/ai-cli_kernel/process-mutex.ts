/** File-backed Lamport bakery mutex. Each contender owns a unique ticket, so a stale
 * collector can never unlink a successor's lock (unlike rename/unlink of one lockfile).
 * Tickets are published whole; even death during publication leaves no shared lock.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mayBeAlive, sameIdentity } from '../core/job-store.js';
import { lookupIdentities, type ProcessIdentity } from '../core/live-jobs.js';
import { atomicWrite, kernelStateDir } from './journal.js';

interface Ticket { owner: ProcessIdentity; number: number; id: string }
/** Coordination contention is recoverable; filesystem/work errors are not. */
export class ProcessMutexBusy extends Error {
  constructor(readonly mutex: string) {
    super(`${mutex} 協調忙碌，請重試（不會將 run 排入佇列）`);
    this.name = 'ProcessMutexBusy';
  }
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

export async function withProcessMutex<T>(name: string, work: () => T | Promise<T>, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const directory = join(kernelStateDir(), `${name}.tickets`);
  mkdirSync(directory, { recursive: true });
  const mine: Ticket = { owner: await processIdentity(), number: 0, id: `${process.pid}-${randomBytes(12).toString('hex')}` };
  const path = join(directory, `${mine.id}.json`);
  const choosing = join(directory, `${mine.id}.choosing.json`);
  const read = (): Ticket[] => {
    const tickets = new Map<string, Ticket>();
    for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      try {
        const ticket = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Ticket;
        if (!tickets.has(ticket.id) || tickets.get(ticket.id)!.number < ticket.number) tickets.set(ticket.id, ticket);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
    const identities = await lookupIdentities([...new Set(others.filter(ticket => ticket.id !== mine.id).map(ticket => ticket.owner.pid))]).catch(() => new Map<number, ProcessIdentity>());
    for (const ticket of others) {
      if (ticket.id === mine.id) continue;
      const live = identities.get(ticket.owner.pid);
      alive.set(ticket.id, live ? !ticket.owner.started || sameIdentity(ticket.owner, live) : mayBeAlive(ticket.owner.pid));
    }
    let maximum = 0;
    for (const ticket of others) if (ticket.id !== mine.id && !await stale(ticket)) maximum = Math.max(maximum, ticket.number);
    mine.number = maximum + 1;
    atomicWrite(path, JSON.stringify(mine));
    const deadline = now() + 15000;
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
