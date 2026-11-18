/**
 * #25 端到端：模擬 McAfee 個人版——輔助程式目錄裡只要出現 .exe（既有的 ai-cli-windowless-host.exe、
 * bootstrap 現場編出的 <GUID>.exe）就立刻搬進隔離區。不設 AI_CLI_WINDOWLESS_HOST、不手動放行，
 * 一個完整的 durable job（launcher → runner → containment register → worker → exit → drained）仍要跑完。
 *
 * 證明的是「exe 被砍時 ai-cli 會自己改走系統 PowerShell host」這條自動路徑；強制模式的語意等價
 * 另見 verify-win-pshost.mjs。真的 McAfee（含它的 AMSI 掃描）無法在 CI 重現。
 */
import '../tools/stubs/catalog-test-env.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
}
if (process.platform !== 'win32') {
  console.log('SKIP Windows only');
  process.exit(0);
}
delete process.env.AI_CLI_WINDOWLESS_HOST; // 一般模式：要測的是自動切換

const { windowlessHostPath, windowlessHostMode } = await import('../dist/core/win-job-host.js');
const { JobStore } = await import('../dist/core/job-store.js');
const { WinJobClient } = await import('../dist/core/win-job-client.js');
const { readBroker } = await import('../dist/core/containment-store.js');
const { powershell, nativeScript } = await import('../dist/core/win-job-broker.js');

const helperDir = windowlessHostPath().directory;
// 隔離區要和輔助程式在同一顆磁碟（跨磁碟 rename 會 EXDEV）。
const quarantine = join(helperDir, '..', 'ai-cli-av-quarantine-' + randomUUID());
mkdirSync(quarantine, { recursive: true });
const quarantined = [];
const sweep = () => {
  let names = [];
  try { names = readdirSync(helperDir); } catch { return; }
  for (const name of names) {
    if (!/\.exe$/i.test(name)) continue;
    try { renameSync(join(helperDir, name), join(quarantine, `${quarantined.length}-${name}`)); quarantined.push(name); } catch { /* 編譯中或剛被搬走 */ }
  }
};
const watcher = setInterval(sweep, 20);
sweep();

mkdirSync(resolve('.tmp'), { recursive: true });
const dir = mkdtempSync(resolve('.tmp/av-quarantine-'));
const config = { name: 'TkflycAiCliContainmentBroker-test-' + randomUUID(), directory: join(dir, 'registry'), idleMs: 60000 };
process.env.AI_CLI_CONTAINMENT_TEST = JSON.stringify(config);
const store = new JobStore(join(dir, 'state'), 'cli');
let job;
try {
  await store.ready;
  job = await store.start({ cliPath: process.execPath, args: ['-e', 'console.log("WORKER-RAN-UNDER-AV")'], cwd: dir, agent: 'grok', resolvedModel: 'stub', prompt: 'av quarantine' });
  const end = Date.now() + 150000;
  while (!existsSync(join(job.directory, 'exit.json')) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  const exit = existsSync(join(job.directory, 'exit.json')) ? JSON.parse(readFileSync(join(job.directory, 'exit.json'), 'utf8')) : null;
  const stdout = existsSync(join(job.directory, 'stdout.log')) ? readFileSync(join(job.directory, 'stdout.log'), 'utf8') : '';
  const runnerError = existsSync(join(job.directory, 'runner-error.json')) ? readFileSync(join(job.directory, 'runner-error.json'), 'utf8').slice(0, 600) : '';
  check('防毒一直隔離 exe 時 job 仍正常結束（exit 0）', exit?.exitCode === 0 && !exit.killed && !exit.timedOut, JSON.stringify(exit) + ' ' + runnerError);
  check('worker 真的執行了', stdout.includes('WORKER-RAN-UNDER-AV'), stdout.slice(0, 200) + runnerError);
  check('假防毒確實隔離了 exe（不是剛好沒碰到）', quarantined.length > 0, String(quarantined.length));
  check('這個行程自動改用 PowerShell host', windowlessHostMode() === 'powershell', windowlessHostMode());
  const meta = JSON.parse(readFileSync(join(job.directory, 'meta.json'), 'utf8'));
  const done = await new WinJobClient(config).terminate(meta.containment);
  check('包容紀錄 drained（worker 子孫已確認結束）', done.state === 'drained', JSON.stringify(done));
} catch (error) {
  check('AV 隔離情境沒有丟例外', false, String(error?.stack ?? error).slice(0, 800));
} finally {
  clearInterval(watcher);
  store.dispose();
  const owner = readBroker(config);
  if (owner) await powershell(nativeScript(`[AiCliContainment]::StopFixture(${owner.pid},'${owner.started}')`)).catch(() => {});
  rmSync(quarantine, { recursive: true, force: true });
}
console.log(failed ? `FAIL: ${failed} failed` : 'PASS: all checks passed');
process.exit(failed ? 1 : 0);
