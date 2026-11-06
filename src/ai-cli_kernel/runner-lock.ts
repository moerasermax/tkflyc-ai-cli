/**
 * 同一個 run 只能有一個 runner。
 *
 * 這道鎖在極端的時間差下仍可能被搶（接管過期鎖無法做到完全原子），所以它不是唯一防線：
 * 真正的保證是 loop.ts 的 fencing token，兩個 runner 同時活著時只有最後啟動的算數。
 */
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { sameIdentity } from '../core/job-store.js';
import type { IdentityLookup, ProcessIdentity } from '../core/live-jobs.js';
import type { RunStore } from './journal.js';

export async function acquireRunnerLock(store: RunStore, self: ProcessIdentity, lookup: IdentityLookup): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(store.runnerLockPath, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(self)); } finally { closeSync(fd); }
      writeFileSync(store.runnerPath, JSON.stringify(self) + '\n', { mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holderText = '';
      let holder: ProcessIdentity | null = null;
      try { holderText = readFileSync(store.runnerLockPath, 'utf8'); holder = JSON.parse(holderText); } catch { /* 殘缺的鎖視同過期 */ }
      if (holder) {
        const live = (await lookup([holder.pid])).get(holder.pid);
        if (live && (!holder.started || sameIdentity(holder, live))) return false; // 已經有 runner 在跑。
      }
      // 查身分的這段時間，鎖可能已經被別人換新。rename 只有一個人會成功，搶到後核對內容；
      // 不是原本判定過期的那一份，就用 wx 放回去（放不回去代表又有人建了新的），然後放棄。
      const claimed = `${store.runnerLockPath}.${process.pid}.claimed`;
      try { renameSync(store.runnerLockPath, claimed); }
      catch (renameError) { if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw renameError; }
      const claimedText = readFileSync(claimed, 'utf8');
      rmSync(claimed, { force: true });
      if (claimedText !== holderText) {
        try {
          const fd = openSync(store.runnerLockPath, 'wx', 0o600);
          try { writeSync(fd, claimedText); } finally { closeSync(fd); }
        } catch { /* 已經有新的鎖，交給 fencing token */ }
        return false;
      }
    }
  }
  return false;
}

/** 只清掉自己的標記。舊 runner 退出時不可以刪掉接手者的鎖。 */
export function releaseRunnerLock(store: RunStore, self: ProcessIdentity): void {
  const isMine = (path: string): boolean => {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity;
      return holder.pid === self.pid && holder.started === self.started;
    } catch { return false; }
  };
  if (isMine(store.runnerLockPath)) rmSync(store.runnerLockPath, { force: true });
  if (isMine(store.runnerPath)) rmSync(store.runnerPath, { force: true });
}
