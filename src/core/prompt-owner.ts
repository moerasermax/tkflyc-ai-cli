/**
 * 長 prompt 私有目錄的擁有者標記（目前只有 agy 用：`<state>/agy-prompts/agy-<uuid>/owner.json`）。
 *
 * TTL 不足以判斷「還有沒有人要讀」：`ai-cli exec` 或 POSIX legacy job 可能跑超過 24 小時，
 * 期間別的 job 觸發 GC 就會刪掉 vendor 還要讀的檔。所以目錄裡記一個擁有者——
 * 行程 PID＋OS 回報的建立時間（與 job 的 worker 身分同一套 lookupIdentities）——
 * GC 只回收「過了 TTL **而且**擁有者已確認不在（或 PID 被別的行程重用）」的目錄。
 * 查不到身分一律保留：寧可多留一天，不可刪掉正在用的。
 *
 * 三個檔：
 * - `owner.json`：目前的擁有者 `{ pid, started?, claimedAt }`。
 * - `owner-pending.json`：移交寫不進 owner.json（防毒鎖住、EPERM／EBUSY）時，另開新檔記下
 *   移交對象。GC 把兩份都當擁有者，**全部**確認不在才回收——移交沒確認就保守保留，
 *   但不是永遠：vendor 結束之後照常回收。
 * - 要刪目錄之前先 revoke（刪掉兩份標記）：刪目錄失敗留下的殘骸變成「無擁有者」，
 *   TTL 後就能回收，不會因為標記上的派工行程還活著而永遠留著。
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupIdentities, type IdentityLookup } from './live-jobs.js';

export const PROMPT_OWNER_FILE = 'owner.json';
export const PROMPT_OWNER_PENDING_FILE = 'owner-pending.json';
/** 行程建立時間晚於宣告時間超過這麼多，就不是當初宣告的那個行程（PID 被重用）。 */
const CLAIM_CLOCK_SLACK_MS = 2_000;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface PromptOwner { pid: number; started?: string; claimedAt?: number }

type Rename = (from: string, to: string) => void;

/** 原子寫 owner.json；被鎖（EPERM／EBUSY／EACCES）時比照 atomicJson 短重試，最多 250 ms。 */
export function writePromptOwner(dir: string, owner: PromptOwner, rename: Rename = renameSync): void {
  const target = join(dir, PROMPT_OWNER_FILE), temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(owner) + '\n', { mode: 0o600 });
    const deadline = performance.now() + 250;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; ; attempt++) {
      try { rename(temp, target); return; }
      catch (error) {
        const remaining = deadline - performance.now();
        if (!RETRYABLE.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 7 || remaining <= 0) throw error;
        Atomics.wait(sleeper, 0, 0, Math.min(10 * 2 ** attempt, 50, remaining));
      }
    }
  } finally { rmSync(temp, { force: true }); }
}

function readOwnerFile(path: string): PromptOwner | undefined {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : undefined;
  } catch { return undefined; }
}

export function readPromptOwner(dir: string): PromptOwner | undefined {
  return readOwnerFile(join(dir, PROMPT_OWNER_FILE));
}

/** owner.json 與 owner-pending.json 裡記的所有擁有者。 */
export function readPromptOwners(dir: string): PromptOwner[] {
  return [readOwnerFile(join(dir, PROMPT_OWNER_FILE)), readOwnerFile(join(dir, PROMPT_OWNER_PENDING_FILE))]
    .filter((owner): owner is PromptOwner => owner !== undefined);
}

/**
 * 同步寫下擁有者（之後的 GC 立刻看得到），讀回確認；再非同步補 OS 建立時間。
 * 寫不進或讀回不符時改寫 owner-pending.json（新檔名，不需覆蓋被鎖的檔），GC 會保守保留。
 * 回傳的 confirmed 表示 owner.json 已確定是這個 pid。
 */
export function claimPromptOwner(
  dir: string,
  pid: number,
  lookup: IdentityLookup = lookupIdentities,
  rename: Rename = renameSync
): { confirmed: boolean; done: Promise<void> } {
  const claimedAt = Date.now();
  let confirmed = false;
  try { writePromptOwner(dir, { pid, claimedAt }, rename); confirmed = readPromptOwner(dir)?.pid === pid; } catch { /* 下面改走 pending */ }
  if (!confirmed) {
    try { writeFileSync(join(dir, PROMPT_OWNER_PENDING_FILE), JSON.stringify({ pid, claimedAt }) + '\n', { mode: 0o600 }); } catch { /* 見檔頭：殘餘風險 */ }
    return { confirmed, done: Promise.resolve() };
  }
  const done = lookup([pid]).then((ids) => {
    const started = ids.get(pid)?.started;
    if (started && readPromptOwner(dir)?.pid === pid) writePromptOwner(dir, { pid, started, claimedAt }, rename);
  }).catch(() => undefined);
  return { confirmed, done };
}

/** 要刪目錄之前呼叫：刪掉兩份標記，刪目錄失敗的殘骸在 TTL 後就是無擁有者、可回收。 */
export function revokePromptOwners(dir: string): void {
  for (const name of [PROMPT_OWNER_FILE, PROMPT_OWNER_PENDING_FILE]) {
    try { rmSync(join(dir, name), { force: true }); } catch { /* 刪不掉就留給下一次 */ }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * 擁有者「已確認不在」才回 true。沒有標記（舊格式／已 revoke）視為不在；無法確認一律 false。
 *
 * 只有 PID、建立時間還沒補上而行程活著時：再查一次身分，**行程建立時間晚於宣告時間**就判定
 * PID 已被別的行程重用。不採「補寫 started」：PID 若已被重用，補寫會讓陌生行程永久成為擁有者。
 * 建立時間只認 ISO 8601（Windows）；macOS 的 lstart 與 Linux 的開機 ID＋ticks 換算不可靠，一律保留。
 */
export async function promptOwnerGone(
  owner: PromptOwner | undefined,
  lookup: IdentityLookup = lookupIdentities,
  isAlive: (pid: number) => boolean = alive
): Promise<boolean> {
  if (!owner) return true;
  if (!isAlive(owner.pid)) return true;
  if (!owner.started && typeof owner.claimedAt !== 'number') return false;
  let ids: Map<number, { started: string }>;
  try { ids = await lookup([owner.pid]); } catch { return false; }
  const current = ids.get(owner.pid);
  if (!current?.started) return false;
  if (owner.started) return current.started !== owner.started;
  // 只認 ISO 8601（Windows 的 CreationDate）。Date.parse 很寬鬆，Linux 的「開機 ID:ticks」也可能被解析成
  // 某個年份；換算不可靠就當成換算不了、保留。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(current.started)) return false;
  const born = Date.parse(current.started);
  return Number.isFinite(born) && born > owner.claimedAt! + CLAIM_CLOCK_SLACK_MS;
}

/** 目錄的所有擁有者（owner.json＋pending）都確認不在才回 true；一份標記都沒有也算不在。 */
export async function promptDirOwnersGone(
  dir: string,
  lookup: IdentityLookup = lookupIdentities,
  isAlive?: (pid: number) => boolean
): Promise<boolean> {
  const owners = readPromptOwners(dir);
  if (owners.length === 0) return true;
  for (const owner of owners) if (!(await promptOwnerGone(owner, lookup, isAlive))) return false;
  return true;
}
