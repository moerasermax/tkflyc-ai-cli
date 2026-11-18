/**
 * #25：exe 輔助程式用不了時改走的 PowerShell host，必須和 exe（WindowlessHost.Main）語意一致：
 * - 前景：腳本照跑、exit code 原樣傳回；逾時回 124 並終止整個私有 Job（含子孫）；
 *   呼叫者（requester）消失時也終止整個 Job。
 * - 背景（broker）：立刻返回，子行程在中介行程結束後仍存活。
 * - ensureWindowlessRoot：PowerShell 模式只建立／驗證私有目錄，不編 exe。
 * - 產生的 host 腳本前景／背景兩種都能被 PowerShell 剖析。
 *
 * 用 AI_CLI_WINDOWLESS_HOST=powershell 強制走這條路徑（windowlessHostMode 每次呼叫都讀環境變數）。
 */
import '../tools/stubs/catalog-test-env.mjs';
import cp from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
}

if (process.platform !== 'win32') {
  console.log('SKIP Windows only');
  process.exit(0);
}

process.env.AI_CLI_WINDOWLESS_HOST = 'powershell';
const host = await import('../dist/core/win-job-host.js');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
check('強制模式下 windowlessHostMode 回 powershell', host.windowlessHostMode() === 'powershell');

mkdirSync(join(ROOT, '.tmp'), { recursive: true });
const work = mkdtempSync(join(ROOT, '.tmp', 'pshost-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  // ---- ensureWindowlessRoot 不編 exe：全新子行程（同一行程裡快取已暖，測不到 bootstrap）----
  {
    const { directory, target } = host.windowlessHostPath();
    const saved = existsSync(target) ? target + '.pshost-saved-' + randomUUID() : null;
    if (saved) renameSync(target, saved);
    try {
      const probe = join(work, 'root-probe.mjs');
      writeFileSync(probe, `process.env.AI_CLI_WINDOWLESS_HOST='powershell';const h=await import(${JSON.stringify(new URL('../dist/core/win-job-host.js', import.meta.url).href)});console.log(await h.ensureWindowlessRoot());`);
      const r = cp.spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 120000, windowsHide: true });
      const root = r.stdout.trim().split(/\r?\n/).pop();
      check('PowerShell 模式的 ensureWindowlessRoot 回傳私有目錄', r.status === 0 && root === directory && existsSync(directory), (r.stdout + r.stderr).slice(0, 400));
      check('PowerShell 模式不編 exe', !existsSync(target));
    } finally {
      if (saved && !existsSync(target)) renameSync(saved, target);
      if (saved) rmSync(saved, { force: true });
    }
  }

  // ---- 剖析 ----
  for (const background of [false, true]) {
    const file = join(work, `parse-${background}.ps1`);
    writeFileSync(file, host.powerShellHostScript(join(work, 'x.ps1'), background, process.pid, 1000));
    const r = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e);$e.Count`], { encoding: 'utf8', windowsHide: true });
    check(`host 腳本可剖析（${background ? '背景' : '前景'}）`, r.stdout.trim() === '0', r.stdout + r.stderr);
  }

  // ---- 前景：成功與 exit code ----
  {
    const marker = join(work, 'ok.txt');
    const script = join(work, 'ok.ps1');
    writeFileSync(script, `Set-Content -LiteralPath '${marker}' -Value 'ran'\r\nexit 0\r\n`);
    await host.runWindowless(script);
    check('前景腳本有執行（DETACHED 的 powershell 不會執行；這條防的就是那個假成功）', existsSync(marker));
    const bad = join(work, 'bad.ps1');
    writeFileSync(bad, 'exit 7\r\n');
    let message = '';
    try { await host.runWindowless(bad); } catch (e) { message = String(e.message); }
    check('腳本的 exit code 原樣傳回（7）', message.startsWith('Windowless PowerShell failed (7)'), message);
  }

  // ---- 前景：逾時終止整個 Job ----
  {
    const pidFile = join(work, 'timeout-child.txt');
    const script = join(work, 'timeout.ps1');
    writeFileSync(script, `$c=Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru\r\nSet-Content -LiteralPath '${pidFile}' -Value $c.Id\r\nStart-Sleep -Seconds 120\r\n`);
    let message = '';
    try { await host.runWindowless(script, {}, false, 5000); } catch (e) { message = String(e.message); }
    check('逾時回 124', message.startsWith('Windowless PowerShell failed (124)'), message);
    await sleep(1500);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    check('逾時後腳本的子孫也被終止', pid > 0 && !alive(pid), String(pid));
  }

  // ---- 前景：呼叫者消失就終止整個 Job ----
  {
    const pidFile = join(work, 'orphan-child.txt');
    const script = join(work, 'orphan.ps1');
    writeFileSync(script, `$c=Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru\r\nSet-Content -LiteralPath '${pidFile}' -Value $c.Id\r\nStart-Sleep -Seconds 120\r\n`);
    const requester = join(work, 'requester.mjs');
    writeFileSync(requester, `process.env.AI_CLI_WINDOWLESS_HOST='powershell';const h=await import(${JSON.stringify(new URL('../dist/core/win-job-host.js', import.meta.url).href)});await h.runWindowless(${JSON.stringify(script)},{},false,40000).catch(()=>{});`);
    const child = cp.spawn(process.execPath, [requester], { stdio: 'ignore', windowsHide: true });
    const until = Date.now() + 30000;
    while (!existsSync(pidFile) && Date.now() < until) await sleep(200);
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0;
    check('呼叫者還在時腳本子孫在跑', pid > 0 && alive(pid), String(pid));
    child.kill('SIGKILL');
    const gone = Date.now() + 10000;
    while (pid > 0 && alive(pid) && Date.now() < gone) await sleep(200);
    check('呼叫者被殺後腳本子孫在 10 秒內被終止', pid > 0 && !alive(pid), String(pid));
  }

  // ---- 背景 ----
  {
    const marker = join(work, 'bg.txt');
    const script = join(work, 'bg.ps1');
    writeFileSync(script, `Start-Sleep -Seconds 3\r\nSet-Content -LiteralPath '${marker}' -Value 'bg'\r\n`);
    await host.runWindowless(script, {}, true);
    check('背景模式立刻返回（腳本還沒寫檔）', !existsSync(marker));
    const until = Date.now() + 20000;
    while (!existsSync(marker) && Date.now() < until) await sleep(200);
    check('背景腳本在中介行程結束後仍跑完', existsSync(marker));
  }

  // ---- broker 整合：bridge 的呼叫者身分（行程鏈 bridge ← powershell ← 中介 ← 呼叫者）與 Job 終止 ----
  // 用獨立的測試 broker；閒置時間給足，PowerShell host 每次呼叫約 3 秒，不能沿用 10 秒閒置的假設。
  {
    const { WinJobClient } = await import('../dist/core/win-job-client.js');
    const { readBroker } = await import('../dist/core/containment-store.js');
    const { powershell, nativeScript } = await import('../dist/core/win-job-broker.js');
    const config = { name: 'TkflycAiCliContainmentBroker-test-' + randomUUID(), directory: join(work, 'registry'), idleMs: 120000 };
    const client = new WinJobClient(config);
    let broker;
    try {
      const ref = await client.prepare(randomUUID());
      broker = readBroker(config);
      const pidFile = join(work, 'grand.pid');
      const grandFile = join(work, 'grand.cjs');
      writeFileSync(grandFile, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},120000)`);
      const runner = join(work, 'runner.mjs');
      writeFileSync(runner, `process.env.AI_CLI_WINDOWLESS_HOST='powershell';const {WinJobClient}=await import(${JSON.stringify(new URL('../dist/core/win-job-client.js', import.meta.url).href)});const {spawn}=await import('node:child_process');await new WinJobClient(${JSON.stringify(config)}).register(${JSON.stringify(ref)});const c=spawn(process.execPath,[${JSON.stringify(grandFile)}],{detached:true,windowsHide:true,stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),1500);`);
      const r = cp.spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 120000, windowsHide: true });
      check('runner 經 PowerShell host 完成 register（呼叫者身分被 broker 接受）', r.status === 0, (r.stdout + r.stderr).slice(0, 800));
      const until = Date.now() + 20000;
      while (!existsSync(pidFile) && Date.now() < until) await sleep(200);
      const grand = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0;
      const active = await client.inspect(ref);
      check('runner 結束後 job 仍 active（孫行程在 Job 裡）', active.state === 'active' && active.activeProcesses > 0 && grand > 0 && alive(grand), JSON.stringify(active));
      const done = await client.terminate(ref);
      check('terminate 讓 job drained', done.state === 'drained', JSON.stringify(done));
      await sleep(1000);
      check('terminate 之後孫行程已終止', grand > 0 && !alive(grand), String(grand));
    } finally {
      if (broker?.pid) await powershell(nativeScript(`[AiCliContainment]::StopFixture(${broker.pid},'${broker.started}')`)).catch(() => {});
    }
  }

} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `FAIL: ${failed} failed` : 'PASS: all checks passed');
process.exit(failed ? 1 : 0);
