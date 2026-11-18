/**
 * verify-win-helper-antivirus.mjs 的子行程情境。改走 PowerShell host 之後同一個行程不會切回來，
 * 所以每個情境各開一個行程。輸出一行 JSON。
 *
 *   node win-host-fallback.mjs <enoent|eperm|vanish-after-exit|kill-error> <工作目錄>
 *
 * - kill-error：exe 已啟動，逾時時 kill() 同步發出 EPERM → 回報逾時、不改走、不重跑。
 *
 * - enoent：ensure 之後、spawn 之前輔助程式被刪（非同步 ENOENT）→ 應改走 PowerShell host，腳本照樣執行。
 * - eperm：spawn 同步丟出 EPERM（檔案還在，被封鎖）→ 同上。
 * - vanish-after-exit：exe 啟動後非 0 結束而且檔案不見（執行掃描殺掉並移除）→ 這次失敗、不重跑，下一次改走 PowerShell host。
 */
import '../../tools/stubs/catalog-test-env.mjs';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureWindowlessHost, runWindowless, windowlessHostMode } from '../../dist/core/win-job-host.js';

const [scenario, dir] = process.argv.slice(2);
const result = { scenario };
const helper = await ensureWindowlessHost();
const away = helper + '.fallback-away-' + randomUUID();
const marker = join(dir, `${scenario}-${randomUUID()}.txt`);
const script = join(dir, `${scenario}-${randomUUID()}.ps1`);
writeFileSync(script, `Set-Content -LiteralPath '${marker}' -Value 'ran'\r\nexit 0\r\n`);
const original = cp.spawn;
let intercepted = 0;
cp.spawn = (file, args, options) => {
  if (file !== helper) return original(file, args, options);
  intercepted++;
  if (scenario === 'eperm') throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  if (scenario === 'kill-error') {
    // 已啟動、一直不結束；逾時時 kill() 同步發出 EPERM（Node 的 ChildProcess.kill 失敗時就是這樣）。
    const child = new EventEmitter();
    child.kill = () => { child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' })); return false; };
    setImmediate(() => child.emit('spawn'));
    return child;
  }
  renameSync(helper, away); // 模擬防毒移除
  const child = new EventEmitter();
  child.kill = () => true;
  if (scenario === 'enoent') setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${helper} ENOENT`), { code: 'ENOENT' })));
  else setImmediate(() => child.emit('close', 1));
  return child;
};
syncBuiltinESMExports();
try {
  try { await runWindowless(script, {}, false, scenario === 'kill-error' ? 1000 : 45000); result.first = 'resolved'; }
  catch (error) { result.first = String(error?.message ?? error); }
  result.ranAfterFirst = existsSync(marker);
  result.modeAfterFirst = windowlessHostMode();
  if (scenario === 'vanish-after-exit') {
    await runWindowless(script); // 應改走 PowerShell host
    result.ranAfterSecond = existsSync(marker);
  }
  result.intercepted = intercepted;
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  cp.spawn = original;
  syncBuiltinESMExports();
  if (!existsSync(helper) && existsSync(away)) renameSync(away, helper);
  for (const f of [away, marker, script]) rmSync(f, { force: true });
}
console.log(JSON.stringify(result));
