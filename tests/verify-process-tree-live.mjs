/**
 * 子孫程序追蹤的真機驗收：真的 runner、真的程序，不啟動任何模型。
 *
 * 用 JobStore 啟動假 worker（tools/stubs/tree-worker.mjs），它在背景啟動孫程序：
 *   (a) worker 活過幾次列舉才結束，孫程序留下來：列舉時父程序活著，記成確定；isGone 為 false，kill 之後消失、轉 true。
 *   (b) worker 一啟動孫程序就結束：只有事後的間接跡象，記成不確定；擋住 isGone，但 kill 不會碰它，人處理後才放行。
 *   (c) worker 還活著時，中間程序留下孤兒後結束，再終止 job：runner 補砍已記錄的孤兒。
 * 判活一律用程序表裡的身分（pid＋啟動時間），不用 kill(pid, 0)；清理也先核對身分。
 * 認親規則本身（假程序表）在 verify-process-tree.mjs。
 *
 * 失敗印 stdout 的 `FAIL <名稱>`，供 tools/mutation-test.mjs 指認。
 */
import '../tools/stubs/catalog-test-env.mjs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTreeRecord, listProcessTable, treeGap } from '../dist/core/process-tree.js';
import { JobStore } from '../dist/core/job-store.js';
import { jobStateDir, lookupIdentities } from '../dist/core/live-jobs.js';
import { powershell, nativeScript } from '../dist/core/win-job-broker.js';
import { FileJobExecutor } from '../dist/ai-cli_kernel/executor.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-tree-live-'));
let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (condition) passed++;
  else { failed++; if (detail !== '') console.log(`  ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/\s+/g, ' ').slice(0, 800)}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 30000, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() >= deadline) return null; await sleep(step); }
}

{
  const stateDir = jobStateDir();
  // 判活和正式程式用同一套：整張程序表裡有 pid 與啟動時間都相符的那一列才算活著（zombie 不在表裡）。
  const aliveNow = async identity => !!identity && (await listProcessTable()).rows.some(item => item.pid === identity.pid && item.started === identity.started);
  const identify = async pid => (await until(async () => (await lookupIdentities([pid])).get(pid) ?? null, 10000, 200)) ?? null;
  const leftovers = [];
  const LINGER_MS = 8000;
  process.env.AI_CLI_TREE_SCAN_MS = '500';
  const store = new JobStore(stateDir, 'cli');
  await store.ready;
  const launch = async (name, spec, agent) => {
    const specFile = join(TEMP, `${name}.json`), childFile = join(TEMP, `${name}.pid`);
    writeFileSync(specFile, JSON.stringify({ ...spec, childFile }));
    // agent 只決定啟動方式：codex 在 Windows 經 cmd.exe 包一層（和真的 CLI 一樣），grok 直接執行。
    const job = await store.start({ cliPath: process.execPath, args: [join(ROOT, 'tools', 'stubs', 'tree-worker.mjs'), specFile], cwd: ROOT, agent, resolvedModel: 'stub', prompt: `tree ${name}` });
    const pid = Number(await until(() => existsSync(childFile) && readFileSync(childFile, 'utf8').trim(), 20000));
    // 留下身分（pid＋啟動時間）：之後判活、收尾清理都靠它，不對裸 pid 動手。
    const grandchild = pid ? await identify(pid) : null;
    if (grandchild) leftovers.push(grandchild);
    // tracked：照 kernel 對全權限 job 的要求查（子孫的證據要齊全）。
    return { job, grandchild, ref: { pid: job.pid, jobId: job.meta.jobId, tracked: true } };
  };
  const recordOf = job => readTreeRecord(job.directory);
  const sealedRecord = job => until(() => { const rec = recordOf(job); return rec && rec !== 'corrupt' && rec.sealed ? rec : null; }, 40000);
  const describe = rec => JSON.stringify(rec?.members.map(item => ({ pid: item.pid, name: item.name, loose: item.loose ?? false })));
  /** runner 與 worker 都確定不在了（身分對不上表裡任何一列）。之後 isGone 還是 false，擋住它的就只可能是子孫。 */
  const runnerAndWorkerGone = job => until(async () => {
    const meta = JSON.parse(readFileSync(join(job.directory, 'meta.json'), 'utf8'));
    for (const identity of [meta.runner, meta.worker]) if (identity && await aliveNow(identity)) return null;
    return true;
  }, 40000, 300);
  /** 只在身分還對得上時才送終止。 */
  const terminateVerified = async identity => { if (await aliveNow(identity)) { try { process.kill(identity.pid, 'SIGKILL'); } catch { /* 已經不在。 */ } } };
  const executor = new FileJobExecutor();
  try {
    if (process.platform === 'win32') {
      for (const agent of ['grok', 'codex']) {
        const {job, grandchild, ref} = await launch('containment-'+agent, {mode:'child', lingerMs:0}, agent);
        await store.wait([job.pid], 45);
        check('Windows '+agent+' job PID tree has no visible top-level window',JSON.parse(await powershell(nativeScript(`[AiCliContainment]::VisibleWindows([int[]]@(${process.pid},${job.pid},${grandchild?.pid||process.pid}))`))).length===0);
        check('Windows '+agent+' instant child remains alive after natural completion', await aliveNow(grandchild));
        check('Windows '+agent+' uses containment without tree polling', !!job.meta.containment && !existsSync(join(job.directory, 'tree.json')));
        check('Windows '+agent+' live orphan blocks isGone', await executor.isGone(ref) === false);
        const before = readFileSync(join(job.directory, 'exit.json'), 'utf8');
        const result = await store.kill(job.pid);
        check('Windows '+agent+' completed job kill drains orphan', result.status === 'terminated' && !(await aliveNow(grandchild)), result);
        check('Windows '+agent+' natural result preserved after kill', before === readFileSync(join(job.directory, 'exit.json'), 'utf8'));
        check('Windows '+agent+' drained proof permits isGone', await executor.isGone(ref));
        store.collect(Date.now()+3600000,true);
        check('Windows '+agent+' proof survives log GC', !existsSync(job.directory) && await executor.isGone(ref));
      }
    } else {
    {
      // (a) worker 活過幾次列舉才結束；孫程序留下來。存活時間抓寬一點：CI 上 PowerShell 冷啟動一次列舉可能要幾秒。
      const { job, grandchild, ref } = await launch('linger', { mode: 'child', lingerMs: LINGER_MS }, 'codex');
      await store.wait([job.pid], 60);
      const rec = await sealedRecord(job);
      console.log(`INFO (a) worker pid ${rec?.root.pid}，孫程序 pid ${grandchild?.pid}，紀錄：${describe(rec)}，列舉 ${rec?.scans} 次、失敗 ${rec?.failed} 次，最長間隔 ${rec?.maxGapMs} ms`);
      check('真機：父程序活著時看到的孫程序以確定身分記進紀錄', !!rec?.members.some(item => item.pid === grandchild?.pid && item.started === grandchild.started && !item.loose && !item.weak), rec);
      check('真機：正常跑完的 job 紀錄沒有追蹤缺口', !!rec && treeGap(rec) === null, rec);
      check('真機：孫程序此時確實還活著', await aliveNow(grandchild));
      check('真機：runner 與 worker 都已消失', await runnerAndWorkerGone(job) === true);
      const blockers = await executor.blockers(ref);
      console.log(`INFO (a) 擋住的原因：${JSON.stringify(blockers)}`);
      check('真機：runner 與 worker 消失後 isGone 仍為 false，擋住的只有那個孫程序', await executor.isGone(ref) === false && blockers.length === 1 && blockers[0].includes(`子孫 pid ${grandchild?.pid}`), blockers);
      await executor.kill(ref);
      check('真機：kill 之後孫程序消失', await until(async () => !(await aliveNow(grandchild)), 15000, 300) === true);
      check('真機：孫程序消失後 isGone 轉為 true', await until(() => executor.isGone(ref), 15000, 300) === true);
    }
    {
      // (b) worker 一啟動孫程序就結束：沒有任何一次列舉看到「父程序活著」，只有事後的間接跡象。直接執行（不經 cmd.exe），worker 就是孫程序的父程序。
      const { job, grandchild, ref } = await launch('instant', { mode: 'child', lingerMs: 0 }, 'grok');
      await store.wait([job.pid], 30);
      const rec = await sealedRecord(job);
      console.log(`INFO (b) worker pid ${rec?.root.pid}（啟動時間${rec?.root.started ? '有查到' : '沒查到'}），孫程序 pid ${grandchild?.pid}，紀錄：${describe(rec)}`);
      check('真機：worker 立刻結束時，它留下的程序只記成不確定', rec?.members.find(item => item.pid === grandchild?.pid)?.loose === true, rec);
      await runnerAndWorkerGone(job);
      const blockers = await executor.blockers(ref);
      console.log(`INFO (b) 擋住的原因：${JSON.stringify(blockers)}`);
      if (process.platform !== 'win32' && !blockers.some(text => text.includes(`子孫 pid ${grandchild?.pid}`))) {
        // CI 診斷：擋住的不是那個孫程序時，印出 runner／worker 在 ps 與程序表裡的狀態。
        const meta = JSON.parse(readFileSync(join(job.directory, 'meta.json'), 'utf8'));
        const pids = [meta.runner?.pid, meta.worker?.pid, grandchild?.pid].filter(Boolean);
        try { const { execFileSync } = await import('node:child_process'); console.log('DIAG (b) ps ' + JSON.stringify(execFileSync('ps', ['-o', 'pid=,ppid=,stat=,comm=', '-p', pids.join(',')], { encoding: 'utf8' }))); } catch (e) { console.log('DIAG (b) ps failed ' + JSON.stringify(String(e.stdout ?? e.message))); }
        console.log('DIAG (b) meta ' + JSON.stringify({ runner: meta.runner, worker: meta.worker }) + ' table ' + JSON.stringify((await listProcessTable()).rows.filter(item => pids.includes(item.pid))) + ' identities ' + JSON.stringify([...(await lookupIdentities(pids)).values()]));
      }
      check('真機：不確定的程序擋住 isGone，說明標明不會自動終止', await executor.isGone(ref) === false && blockers.some(text => text.includes(`子孫 pid ${grandchild?.pid}`) && text.includes('不會自動終止')), blockers);
      await executor.kill(ref);
      await sleep(1500);
      check('真機：kill 不會終止不確定的程序', await aliveNow(grandchild) && await executor.isGone(ref) === false);
      // 人確認過之後自己結束它（這裡由測試代勞，照樣先核對身分），再查一次就放行。
      await terminateVerified(grandchild);
      check('真機：人處理掉那個程序之後 isGone 轉為 true', await until(() => executor.isGone(ref), 15000, 300) === true && !(await aliveNow(grandchild)));
    }
    {
      // (c) worker 還活著時，中間程序留下孤兒後結束。終止 job：worker 那棵樹砍不到孤兒，要靠紀錄補砍。
      const { job, grandchild, ref } = await launch('orphan', { mode: 'orphan', lingerMs: LINGER_MS }, 'codex');
      const recorded = await until(() => { const rec = recordOf(job); return rec && rec !== 'corrupt' && rec.members.some(item => item.pid === grandchild?.pid && !item.loose) ? rec : null; }, 20000);
      check('真機：worker 還活著時，孤兒已經以確定身分記在紀錄裡', !!recorded, recordOf(job));
      await sleep(LINGER_MS + 1000); // 等中間程序結束，孫程序成為孤兒。
      check('真機：中間程序結束後孤兒還活著', await aliveNow(grandchild));
      const killed = await store.kill(job.pid);
      console.log(`INFO (c) 孤兒 pid ${grandchild?.pid}，kill 回傳 ${JSON.stringify(killed)}`);
      check('真機：終止執行中的 job 會連同已記錄的孤兒一起砍掉', await until(async () => !(await aliveNow(grandchild)), 30000, 300) === true);
      check('真機：終止後 isGone 轉為 true', await until(() => executor.isGone(ref), 30000, 300) === true);
    }
    {
      const snapshot = await listProcessTable();
      const self = snapshot.rows.find(item => item.pid === process.pid);
      console.log(`INFO 程序表：${snapshot.rows.length} 列、讀不出身分 ${snapshot.unknown.length} 個、完整 ${snapshot.complete}、開機識別 ${snapshot.boot ? '有' : '沒有'}`);
      check('真機：程序表列得到自己，有啟動時間與父程序，而且是完整的', !!self && !!self.started && Number.isInteger(self.ppid) && snapshot.complete === true, self);
    }
    }
  } finally {
    // 收尾清理也核對身分：這些 pid 可能早就結束、又被別的程序拿去用了。
    for (const identity of leftovers) await terminateVerified(identity).catch(() => {});
    store.dispose();
    delete process.env.AI_CLI_TREE_SCAN_MS;
  }
}

try { rmSync(TEMP, { recursive: true, force: true }); } catch { /* 暫存目錄留給系統清。 */ }
console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
