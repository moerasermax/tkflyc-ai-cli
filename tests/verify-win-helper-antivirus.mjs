/**
 * #25：防毒刪掉現場編譯的 windowless 輔助程式時，錯誤要講得出原因與檔案路徑；
 * 失敗留下的 <GUID>.exe／.exe.cs 要清掉；doctor 要回報輔助程式的路徑與狀態。
 *
 * 防毒本身無法在 CI 重現，所以分幾種驗法：
 * - 分類函式（全平台）：哪些失敗該提示防毒、哪些不該（不亂指防毒）。
 * - 殘留清理（Windows）：埋舊／新 GUID 檔與非 GUID 檔，強制重編，看誰被清。
 * - 啟動時（Windows）：把 spawn 換成替身——非同步 ENOENT 且檔案真的不見、同步丟出 EPERM 且檔案還在。
 * - doctor（Windows）：函式不查防毒時沒有 antivirus 欄位；CLI doctor 會查。
 */
import '../tools/stubs/catalog-test-env.mjs';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ANTIVIRUS_BLOCKED_HINT,
  ANTIVIRUS_HINT,
  VANISHED_MARKER,
  ensureWindowlessHost,
  runWindowless,
  windowlessBootstrapError,
  windowlessHostPath,
  windowlessSpawnError,
} from '../dist/core/win-job-host.js';
import { getWindowlessHelperStatus } from '../dist/core/doctor.js';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
}

// ---- 1. 分類函式 ----
const target = 'C:\\x\\ai-cli-windowless-host.exe';
{
  const m = windowlessBootstrapError(0, '', target, false).message;
  check('bootstrap 成功但目標不見時提示防毒並印出完整路徑', m.includes(ANTIVIRUS_HINT) && m.includes(target), m);
  check('提示防毒時仍保留原本的錯誤前綴', m.includes('PowerShell/Add-Type or private helper ACL unavailable (0)'), m);
}
{
  const m = windowlessBootstrapError(1, `${VANISHED_MARKER}: C:\\x\\a.exe is gone before install`, target, false).message;
  check('bootstrap 印出消失標記時提示防毒', m.includes(ANTIVIRUS_HINT), m);
}
{
  const m = windowlessBootstrapError(1, 'helper root ACL mismatch', target, false).message;
  check('其他失敗不亂指防毒（ACL 不符照原訊息）', !m.includes('antivirus') && m.startsWith('PowerShell/Add-Type or private helper ACL unavailable (1)'), m);
}
{
  const m = windowlessBootstrapError(1, 'Exception calling "Move": access denied (helper vanished in path text)', target, false).message;
  check('一般文字碰巧含 helper vanished 不算消失標記', !m.includes('antivirus'), m);
}
{
  const e = (code) => Object.assign(new Error('spawn x ' + code), { code });
  check('spawn ENOENT 且檔案不在＝missing', windowlessSpawnError(e('ENOENT'), target, false).message.startsWith(`Windowless helper missing (ENOENT): ${target}`));
  check('spawn EPERM 且檔案還在＝blocked，不說檔案不見', (() => { const m = windowlessSpawnError(e('EPERM'), target, true).message; return m.includes(ANTIVIRUS_BLOCKED_HINT) && !m.includes(ANTIVIRUS_HINT); })());
  const other = e('EMFILE');
  check('與防毒無關的 spawn 錯誤原樣回傳', windowlessSpawnError(other, target, false) === other);
}
{
  const { directory, target: t } = windowlessHostPath();
  check('windowlessHostPath 的目標在它回報的目錄裡', dirname(t) === directory && t.endsWith('ai-cli-windowless-host.exe'), t);
}

if (process.platform !== 'win32') {
  check('非 Windows 的 doctor 不回報輔助程式', getWindowlessHelperStatus(true) === undefined);
} else {
  // ---- 2. 殘留清理 ----
  const helper = await ensureWindowlessHost();
  check('ensureWindowlessHost 與 windowlessHostPath 指向同一個檔', helper === windowlessHostPath().target, helper);
  const root = dirname(helper);
  const saved = helper + '.av-saved-' + randomUUID();
  renameSync(helper, saved); // 強制下一次 ensure 重編（同 verify-win-job-fix1 的做法）
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  const staleExe = join(root, randomUUID() + '.exe');
  const staleCs = join(root, randomUUID() + '.exe.cs');
  const freshCs = join(root, randomUUID() + '.exe.cs');
  const keepTxt = join(root, 'av-test-keep-' + randomUUID() + '.txt');
  const keepExe = join(root, 'av-test-keep-' + randomUUID() + '.exe'); // 舊的非 GUID .exe：regex 放太寬就會被刪
  for (const f of [staleExe, staleCs, freshCs, keepTxt, keepExe]) writeFileSync(f, 'x');
  for (const f of [staleExe, staleCs, keepTxt, keepExe]) utimesSync(f, old, old);
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.exe(\.cs)?$/i;
  // 先前的編譯（含舊版程式碼：它從不刪 .cs）可能留下不到一小時的檔，所以比對前後差集，不看絕對數量。
  const before = new Set(readdirSync(root).filter((n) => guid.test(n)));
  try {
    const rebuilt = await ensureWindowlessHost();
    check('重編後輔助程式存在', rebuilt === helper && existsSync(helper));
    check('超過一小時的 GUID 殘留被清掉', !existsSync(staleExe) && !existsSync(staleCs));
    check('一小時內的 GUID 檔保留（可能是另一個行程正在編）', existsSync(freshCs));
    check('非 GUID 檔不受影響（含舊的 .exe）', existsSync(keepTxt) && existsSync(keepExe));
    const leftovers = readdirSync(root).filter((n) => guid.test(n) && !before.has(n));
    check('這次編譯沒有留下自己的 .exe／.cs', leftovers.length === 0, leftovers.join(','));
  } finally {
    // 重編失敗時把原本的輔助程式還回去，不要讓後面的測試或正在跑的 server 少一個檔。
    if (!existsSync(helper) && existsSync(saved)) renameSync(saved, helper);
    for (const f of [freshCs, keepTxt, keepExe, saved]) rmSync(f, { force: true });
  }

  // ---- 3. 啟動時：exe 用不了就改走 PowerShell host（每個情境一個子行程，模式切換是行程層級）----
  const scenario = (name) => {
    const fixture = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'fixtures', 'win-host-fallback.mjs');
    const r = cp.spawnSync(process.execPath, [fixture, name, root], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    try { return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { return { raw: (r.stdout + r.stderr).slice(0, 600) }; }
  };
  {
    const r = scenario('enoent');
    check('啟動時輔助程式被刪（ENOENT）→ 改走 PowerShell host，腳本照樣執行', r.first === 'resolved' && r.ranAfterFirst === true && r.modeAfterFirst === 'powershell' && r.intercepted === 1, JSON.stringify(r));
  }
  {
    const r = scenario('eperm');
    check('spawn 同步丟出 EPERM（被封鎖）→ 改走 PowerShell host，腳本照樣執行', r.first === 'resolved' && r.ranAfterFirst === true && r.modeAfterFirst === 'powershell' && r.intercepted === 1, JSON.stringify(r));
  }
  {
    const r = scenario('vanish-after-exit');
    check('exe 啟動後被殺且檔案不見 → 這次失敗不重跑、保留可重送的錯誤前綴', typeof r.first === 'string' && r.first.startsWith('Windowless PowerShell failed (1)') && r.first.includes('disappeared during launch') && r.ranAfterFirst === false, JSON.stringify(r));
    check('之後的呼叫改走 PowerShell host 並成功', r.modeAfterFirst === 'powershell' && r.ranAfterSecond === true && r.intercepted === 1, JSON.stringify(r));
  }
  {
    const r = scenario('kill-error');
    check('已啟動的 exe 在逾時 kill 時丟錯 → 回報逾時，不改走 PowerShell host、不重跑', typeof r.first === 'string' && r.first.includes('Windowless host deadline') && r.ranAfterFirst === false && r.modeAfterFirst === 'compiled' && r.intercepted === 1, JSON.stringify(r));
  }
  check('各情境之後輔助程式仍在（子行程有還原）', existsSync(helper));

  // ---- 4. doctor ----
  const status = getWindowlessHelperStatus(false);
  check('doctor 回報輔助程式路徑與存在狀態；沒查防毒時沒有 antivirus 欄位', status?.path === helper && status.exists === true && !('antivirus' in status), JSON.stringify(status));
  const cli = cp.spawnSync(process.execPath, [join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'dist', 'bin', 'ai-cli.js'), 'doctor'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  let helperRow;
  try { helperRow = JSON.parse(cli.stdout).windowlessHelper; } catch { helperRow = undefined; }
  check('CLI doctor 會查防毒（antivirus 欄位存在：陣列或 null）', !!helperRow && 'antivirus' in helperRow && (helperRow.antivirus === null || Array.isArray(helperRow.antivirus)), cli.stdout.slice(0, 300) + cli.stderr.slice(0, 300));
}

console.log(failed ? `FAIL: ${failed} failed` : 'PASS: all checks passed');
process.exit(failed ? 1 : 0);
