/**
 * 子孫程序追蹤（src/core/process-tree.ts）、JobStore 的保留標記，與 kernel 執行器的 isGone／kill。
 *
 * 全部用假的程序表，不啟動任何程序，也不對任何真實 pid 送訊號（終止函式一律注入假的）：
 *   1. surveyTree 純函式：Windows 與 POSIX 兩套認親規則。重點是「沒有直接證據就不列為可終止」。
 *   2. 列舉的三種狀態（存在／確定不存在／未知）、追蹤缺口、逐筆核對身分的終止。
 *   3. runner 的追蹤器：紀錄怎麼累積、失敗怎麼記、收尾的時間上限。
 *   4. kernel 的 FileJobExecutor：假的 job 目錄，驗「還活著／pid 被重用／查不了／證據不足」。
 *   5. JobStore 回收遇到保留標記。
 * 真的程序那一段在 verify-process-tree-live.mjs。
 *
 * 失敗印 stdout 的 `FAIL <名稱>`，供 tools/mutation-test.mjs 指認。
 */
import '../tools/stubs/catalog-test-env.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminatePosixMember, treeTermination, compareStarted, parsePsTable, readProcTable, surveyTree, startTreeTracker, readTreeRecord, terminateTreeMembers, treeGap, TREE_FILE, TREE_GAP_SLACK_MS } from '../dist/core/process-tree.js';
import { posixFinishedReply, posixTerminationReply, jobResult, JobStore, collectStoreFiles, JOB_HOLD_FILE, RETENTION_MS } from '../dist/core/job-store.js';
import { parsePsIdentities, jobStateDir } from '../dist/core/live-jobs.js';
import { finishJobReport } from '../dist/core/job-runner.js';
import { FileJobExecutor } from '../dist/ai-cli_kernel/executor.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-tree-'));
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

/* ---- 1. surveyTree：假程序表 ---- */
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = seconds => T0 + seconds * 1000;
const iso = seconds => new Date(at(seconds)).toISOString();
const row = (pid, ppid, bornSec, extra = {}) => ({ pid, ppid, started: iso(bornSec), name: `p${pid}`, ...extra });
const member = (pid, bornSec, extra = {}) => ({ pid, started: iso(bornSec), name: `p${pid}`, ...extra });
const snap = (rows, extra = {}) => ({ rows, unknown: [], complete: true, ...extra });
const record = (platform, root, members = [], extra = {}) => ({ version: 2, platform, root: { since: root.started || iso(0), ...root }, members, scans: 1, failed: 0, intervalMs: 5000, maxGapMs: 0, ...extra });
const survey = (rec, rows, beforeSec, extra = {}) => surveyTree(rec, Array.isArray(rows) ? snap(rows) : rows, { before: at(beforeSec), now: at(beforeSec + 1), ...extra });
const has = (result, pid) => result.record.members.find(item => item.pid === pid);
const sure = (result, pid) => !!has(result, pid) && !has(result, pid).loose && !has(result, pid).weak;

{
  // worker(100) 活著（runner 握著它），A(200) 是它的子程序，B(300) 是 A 的子程序。
  const result = survey(record('win32', member(100, 0)), [row(100, 1, 0), row(200, 100, 1), row(300, 200, 2), row(999, 1, 1)], 5, { rootAlive: true });
  check('Windows：父程序活著時沿 ParentProcessId 找到子與孫，列為確定', sure(result, 200) && sure(result, 300) && !has(result, 999), result.record.members);
  check('存活清單不含 worker 本身', result.alive.map(item => item.pid).sort().join() === '200,300');
}
{
  // A 已經死了但當初記過：B 的 ParentProcessId 仍指向 A。這只是間接跡象，不能拿來殺。
  const result = survey(record('win32', member(100, 0), [member(200, 1)]), [row(100, 1, 0), row(300, 200, 2)], 10, { rootAlive: true });
  check('Windows：父程序已經不在時，留下的孤兒只列為不確定', has(result, 300)?.loose === true, result.record.members);
  check('確認不在的成員記下 gone', has(result, 200)?.gone === iso(11));
  check('不確定的成員也算還活著（會擋住判定）', result.alive.some(item => item.pid === 300));
}
{
  // 稽核舉的交錯：第 5 秒還看得到 A；A 結束後 pid 被別人（X）拿去，X 在第 7 秒生了 B 就結束；第 10 秒只剩 B。
  // X 不在表裡，排除不了這次重用。時間窗再短也不能推定 B 是 A 生的。
  const result = survey(record('win32', member(100, 0), [member(200, 1)]), [row(300, 200, 7)], 9);
  check('Windows：時間窗再短也不推定是子孫，只列為不確定', has(result, 300)?.loose === true, result.record.members);
  // 不確定成員還活著時，它生的子程序也只能是不確定。
  const inherited = survey(result.record, [row(300, 200, 7), row(400, 300, 8)], 20);
  check('不確定成員的子孫沿用不確定', has(inherited, 400)?.loose === true, inherited.record.members);
}
{
  // A 的 pid 被別的程序 X 重用（60 秒出生）。70 秒出生、ppid 指向那個 pid 的是 X 生的，不是 A 生的。
  const result = survey(record('win32', member(100, 0), [member(200, 1)]), [row(200, 1, 60), row(310, 200, 70), row(320, 200, 3)], 100);
  check('Windows：pid 被重用後，新佔用者生的程序不算子孫', !has(result, 310), result.record.members);
  check('Windows：pid 被重用前就出生的孤兒列為不確定', has(result, 320)?.loose === true, result.record.members);
  check('pid 被重用（啟動時間不符）的成員不算還活著', !result.alive.some(item => item.pid === 200) && result.unknown.length === 0, result.alive);
}
{
  // A 在 10 秒時已確認不在。20 秒才出生的程序不可能是它生的。
  const result = survey(record('win32', member(100, 0), [member(200, 1, { gone: iso(10) })]), [row(330, 200, 20)], 12);
  check('Windows：父程序確認不在之後才出生的不算子孫', !has(result, 330), result.record.members);
  // 比父程序早出生的，是那個 pid 的前一任生的。
  const older = survey(record('win32', member(100, 0), [member(200, 10)]), [row(200, 1, 10), row(340, 200, 4)], 13);
  check('Windows：比父程序早出生的不算子孫', !has(older, 340), older.record.members);
}
{
  // 啟動時間的精度到 100 奈秒。父程序 K 在 .0000005 出生；.0000001 出生的是那個 pid 前一任留下的，差不到一毫秒。
  const k = { pid: 200, started: '2026-01-01T00:00:10.0000005Z', name: 'k' };
  const rows = [row(100, 1, 0), { pid: 200, ppid: 100, started: k.started, name: 'k' },
    { pid: 350, ppid: 200, started: '2026-01-01T00:00:10.0000001Z', name: 'old' }, { pid: 351, ppid: 200, started: '2026-01-01T00:00:10.0000009Z', name: 'new' }];
  const result = survey(record('win32', member(100, 0), [k]), rows, 20, { rootAlive: true });
  check('Windows：比父程序早不到一毫秒出生的也不算它生的（比較不壓成毫秒）', !has(result, 350) && sure(result, 351), result.record.members);
  check('啟動時間比較保留原始精度', compareStarted('2026-01-01T00:00:10.0000001Z', '2026-01-01T00:00:10.0000005Z') === -1
    && compareStarted('2026-01-01T00:00:10.0000005Z', '2026-01-01T00:00:10.0000005Z') === 0 && compareStarted('not a time', iso(1)) === null);
}
{
  // worker 一啟動就結束，runner 沒查到它的啟動時間。它不在了，留下的程序只能是不確定。
  const root = { pid: 100, started: '', name: '', gone: iso(3), since: iso(0) };
  const result = survey(record('win32', root, [], { ended: iso(3) }), [row(350, 100, 2), row(360, 100, 8)], 4);
  check('Windows：worker 已結束時，它直接生的程序也只列為不確定；結束後才出生的不算', has(result, 350)?.loose === true && !has(result, 360), result.record.members);
  // runner 還握著 worker 時，表裡那個 pid 就是 worker：補上啟動時間，它生的列為確定。
  const held = survey(record('win32', { pid: 100, started: '', name: '', since: iso(0) }), [row(100, 1, 1), row(370, 100, 2)], 4, { rootAlive: true });
  check('Windows：runner 握著 worker 時補上它的啟動時間，子程序列為確定', held.record.root.started === iso(1) && sure(held, 370), held.record);
}
{
  // 第一次只看到間接跡象（表裡剛好缺了 worker 那一列），下一次父程序活著、身分相符：升為確定。
  const first = survey(record('win32', member(100, 0)), [row(380, 100, 2)], 4, { rootAlive: true });
  const second = survey(first.record, [row(100, 1, 0), row(380, 100, 2)], 9, { rootAlive: true });
  check('先前不確定的成員拿到直接證據後升為確定', has(first, 380)?.loose === true && sure(second, 380), [first.record.members, second.record.members]);
}
{
  // 修剪：上一次列舉就確認不在的成員，這一次之後丟掉。
  const result = survey(record('win32', member(100, 0), [member(200, 1, { gone: iso(10) }), member(210, 1)]), [row(210, 100, 1)], 20);
  check('早已確認不在的成員會被修剪，還活著的留著', !has(result, 200) && !!has(result, 210), result.record.members);
}
{
  // 成員的 pid 還在，但讀不出啟動時間：不知道是不是它。不能當成不在了，也不能刪紀錄。
  const rec = record('win32', member(100, 0, { gone: iso(1) }), [member(200, 1), member(210, 1, { gone: iso(5) })]);
  const unreadable = survey(rec, snap([], { unknown: [{ pid: 200, ppid: 100 }, { pid: 500, ppid: 210 }] }), 20);
  check('讀不出身分的成員列為未知，不記 gone、不算還活著', unreadable.unknown.map(item => item.pid).join() === '200' && !has(unreadable, 200).gone && unreadable.alive.length === 0, unreadable);
  check('讀不出身分、父程序指向已知成員的 pid 列為無法核對', unreadable.unverified.join() === '500', unreadable.unverified);
  check('有讀不出身分的 pid 指向它時，已確認不在的成員不修剪', !!has(unreadable, 210), unreadable.record.members);
  // 整張表不完整：缺席不代表不存在。
  const partial = survey(rec, snap([], { complete: false }), 20);
  check('程序表不完整時，缺席的成員是未知而不是不在了，紀錄不修剪', partial.blind === true && partial.unknown.some(item => item.pid === 200) && !!has(partial, 210) && !has(partial, 200).gone, partial);
}
{
  // POSIX：runner 握著 worker 時，沿 ppid 找到的、同一個 group 的都是確定。
  const result = survey(record('linux', member(100, 0)), [row(100, 1, 0, { pgid: 100 }), row(200, 100, 1, { pgid: 100 }), row(300, 200, 2, { pgid: 300 }), row(250, 1, 2, { pgid: 100 })], 5, { rootAlive: true });
  check('POSIX：worker 活著時沿 ppid 找到子與孫（含自成 group 的），同 group 的孤兒也算確定', sure(result, 200) && sure(result, 300) && sure(result, 250), result.record.members);
  // worker 結束了，group 裡沒有任何已記錄的成員：group 編號可能已經被別人重用。「這是最後一次列舉」不是證據。
  const ended = survey(record('linux', member(100, 0, { gone: iso(5) })), [row(210, 1, 2, { pgid: 100 })], 6);
  check('POSIX：worker 結束後沒有已記錄成員可證明時，同 group 的孤兒只列為不確定', has(ended, 210)?.loose === true, ended.record.members);
  // group 裡還有一個當初記過、確定的成員活著：group 沒有斷過，新成員算確定。
  const proven = survey(record('linux', member(100, 0, { gone: iso(5) }), [member(210, 2)]), [row(210, 1, 2, { pgid: 100 }), row(220, 1, 30, { pgid: 100 })], 40);
  check('POSIX：group 裡有身分相符的已記錄成員活著，新成員算確定', sure(proven, 220), proven.record.members);
  // 只有不確定的成員活著，不能拿來證明。
  const weakProof = survey(record('linux', member(100, 0, { gone: iso(5) }), [member(210, 2, { loose: true })]), [row(210, 1, 2, { pgid: 100 }), row(220, 1, 30, { pgid: 100 })], 40);
  check('POSIX：不確定的成員不能用來證明 group 延續', has(weakProof, 220)?.loose === true, weakProof.record.members);
  // 已死成員的 pid 被重用：ppid 指向它的不是子孫。
  const reused = survey(record('linux', member(100, 0, { gone: iso(5) }), [member(200, 1)]), [row(200, 1, 60, { pgid: 200 }), row(240, 200, 61, { pgid: 200 })], 70);
  check('POSIX：已死成員的 pid 被重用後，新佔用者生的不算子孫', !has(reused, 240), reused.record.members);
  // POSIX 上讀不出身分的 pid 連 group 都不知道，可能就是留下來的孤兒。
  const blind = survey(record('linux', member(100, 0, { gone: iso(5) })), snap([], { unknown: [{ pid: 777, ppid: null }] }), 6);
  check('POSIX：有讀不出狀態的 pid 時，這張表不能證明沒有別的子孫', blind.blind === true);
}
{
  // macOS 的 ps 啟動時間只到秒。第一次看到它時還在它出生的那一秒內，之後同一秒被重用的 pid 分不出來。
  const lstart = seconds => new Date(at(seconds)).toUTCString().replace(/^(\w{3}), (\d\d) (\w{3}) (\d{4}) (\d\d:\d\d:\d\d) GMT$/, (_, day, date, month, year, time) => `${day} ${month} ${date.replace(/^0/, ' ')} ${time} ${year}`);
  const root = { pid: 100, started: lstart(0), name: 'worker', since: iso(0) };
  const rows = [{ pid: 100, ppid: 1, pgid: 100, started: lstart(0), name: 'worker' }, { pid: 200, ppid: 100, pgid: 100, started: lstart(10), name: 'same-second' }, { pid: 210, ppid: 100, pgid: 100, started: lstart(3), name: 'older' }];
  const result = surveyTree(record('darwin', root), snap(rows), { before: at(10) + 400, now: at(11), rootAlive: true });
  check('macOS：出生的那一秒內第一次看到的成員標成精度不足（只擋不殺），之後才看到的是確定', has(result, 200)?.weak === true && sure(result, 210), result.record.members);
  // 子程序自成一個 group：移除已核實的 group 錨點 210，才真的只剩精度不足的父程序 200。
  const child = surveyTree(result.record, snap([...rows, { pid: 300, ppid: 200, pgid: 300, started: lstart(20), name: 'child' }].filter(item => item.pid !== 100 && item.pid !== 210)), { before: at(30), now: at(31) });
  check('macOS：精度不足的成員生的子程序不算確定', has(child, 300)?.loose === true, child.record.members);
}
{
  const parsed = parsePsTable([
    '  501     1   501 Ss   Wed Nov 11 01:00:00 2026 /usr/local/bin/node',
    '  502   501   501 S    Wed Nov  1 01:00:05 2026 npm run test',
    '  503   501   501 Z    Wed Nov 11 01:00:06 2026 (node)',
    '  504   501 truncated',
    'garbage line',
    '',
  ].join('\n'));
  check('ps 輸出解析：取 pid／ppid／pgid／啟動時間，略過 zombie',
    parsed.rows.length === 2 && parsed.rows[0].pid === 501 && parsed.rows[0].pgid === 501 && parsed.rows[0].started === 'Wed Nov 11 01:00:00 2026' && parsed.rows[0].name === 'node'
    && parsed.rows[1].ppid === 501 && parsed.rows[1].started === 'Wed Nov  1 01:00:05 2026' && parsed.rows[1].name === 'npm run test', parsed.rows);
  check('ps 輸出解析：看不懂的行不略過，讀得出 pid 的列為未知，其餘讓整張表算不完整', parsed.unknown.length === 1 && parsed.unknown[0].pid === 504 && parsed.unknown[0].ppid === 501 && parsed.complete === false, parsed);
  check('ps 輸出解析：每一行都看得懂時表是完整的', parsePsTable('  501     1   501 Ss   Wed Nov 11 01:00:00 2026 node\n').complete === true);
}
{
  // Linux 的 /proc：只有 ENOENT／ESRCH 代表程序在列舉途中結束。
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const stat = (name, state, ppid, pgid, start) => `1 (${name}) ${state} ${ppid} ${pgid} ${Array.from({ length: 16 }, () => '0').join(' ')} ${start} 0`;
  const files = { 10: () => stat('node', 'S', 1, 10, 500), 11: () => fail('ENOENT'), 12: () => fail('ESRCH'), 13: () => fail('EACCES'), 14: () => fail('EIO'), 15: () => stat('dead', 'Z', 10, 10, 600), 16: () => 'not a stat line', 17: () => stat('paren) name', 'R', 10, 10, 700) };
  const table = readProcTable({ list: () => [...Object.keys(files), 'self', 'meminfo'], stat: pid => files[pid](), boot: () => 'boot-a' });
  check('/proc 讀取：正常的列取出 ppid／pgid／啟動時間，zombie 略過', table.rows.map(item => item.pid).join() === '10,17' && table.rows[0].started === 'boot-a:500' && table.rows[0].pgid === 10 && table.rows[1].name === 'paren) name' && table.boot === 'boot-a', table.rows);
  check('/proc 讀取：ENOENT／ESRCH 當成已結束，權限、I/O 與格式錯誤列為未知', table.unknown.map(item => item.pid).join() === '13,14,16' && table.unknown.every(item => item.ppid === null), table.unknown);
}
{
  const base = record('win32', member(100, 0), [], { ended: iso(10), sealed: true, maxGapMs: 6000 });
  check('追蹤缺口：正常的紀錄沒有缺口', treeGap(base) === null);
  check('追蹤缺口：runner 沒記到 worker 結束', /沒有記到 worker 結束/.test(treeGap({ ...base, ended: undefined, sealed: undefined }) ?? ''));
  check('追蹤缺口：worker 結束後沒有成功列舉過', treeGap({ ...base, sealed: undefined, failed: 3 }) !== null);
  check('追蹤缺口：存活期間太久沒有成功列舉', /沒有成功列舉/.test(treeGap({ ...base, maxGapMs: 5000 + TREE_GAP_SLACK_MS + 1 }) ?? '') && treeGap({ ...base, maxGapMs: 5000 + TREE_GAP_SLACK_MS }) === null);
}

/* FIX14: coarse identities need fresh ownership, not elapsed time alone. */
{
  const stamp = sec => new Date(at(sec)).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) (.+) GMT$/, (_, d, m, y, t) => `Thu ${m} ${d.padStart(2, ' ')} ${t} ${y}`);
  const root = { pid: 100, started: stamp(0), name: 'worker', since: iso(0) };
  const child = { pid: 200, ppid: 100, pgid: 200, started: stamp(10), name: 'detached' };
  const rows = [{ ...root, ppid: 1, pgid: 100 }, child];
  const first = surveyTree(record('darwin', root), snap(rows), { before: at(10) + 10, now: at(10) + 20, rootAlive: true });
  const within = surveyTree(first.record, snap(rows), { before: at(10) + 900, now: at(10) + 950, rootAlive: true });
  check('FIX14 same birth second remains weak despite live parent', has(within, 200)?.weak === true);
  const mature = surveyTree(first.record, snap(rows), { before: at(11), now: at(11) + 20, rootAlive: true });
  check('FIX14 fresh held parent after birth boundary promotes detached child', sure(mature, 200));
  const lost = surveyTree(first.record, snap([{ ...child, ppid: 1 }]), { before: at(20), now: at(21) });
  check('FIX14 elapsed time without fresh ownership cannot promote weak PID', has(lost, 200)?.weak === true);
  const reusedGroup = surveyTree(first.record, snap([{ ...child, ppid: 1, pgid: 100 }]), { before: at(20), now: at(21) });
  check('FIX14 dead group leader plus weak member cannot prove group ownership', has(reusedGroup, 200)?.weak === true);
  const newGroup = surveyTree(first.record, snap([{ ...rows[0], started: stamp(15) }, { ...child, ppid: 1, pgid: 100 }]), { before: at(20), now: at(21) });
  check('FIX14 reused leader PID cannot anchor a process group', has(newGroup, 200)?.weak === true);
  const anchored = surveyTree(mature.record, snap([{ ...child, ppid: 1, pgid: 100 }, { pid: 300, ppid: 1, pgid: 100, started: stamp(15), name: 'orphan' }]), { before: at(20), now: at(21) });
  check('FIX14 proven survivor anchors group after leader exits', sure(anchored, 300));
  const noRoot = surveyTree(first.record, snap([{ ...child, ppid: 1, pgid: 100 }]), { before: at(20), now: at(21), rootAlive: true });
  check('FIX14 missing worker row cannot prove group membership', has(noRoot, 200)?.weak === true);
}
{
  const base = record('linux', member(100, 0), [member(200, 1)], { ended: iso(10), sealed: true });
  const gone = treeTermination(base, snap([]));
  check('FIX14 complete sealed empty tree confirms termination', gone.confirmed && gone.reasons.length === 0);
  const cases = [treeTermination(base, snap([row(200, 1, 1)])), treeTermination(base, snap([row(100, 1, 0)])), treeTermination(base, snap([], { complete: false })), treeTermination(base, snap([], { unknown: [{ pid: 200, ppid: 1 }] })), treeTermination({ ...base, sealed: undefined }, snap([]))];
  check('FIX14 alive unknown incomplete or unsealed trees cannot confirm termination', cases.every(r => !r.confirmed && r.reasons.length > 0), cases);
  for (const [name, exit] of [['missing', undefined], ['legacy', { killed: true }], ['pending', { termination: { confirmed: true, pending: true, reasons: ['pending'] } }], ['survivor', { termination: cases[0] }]]) {
    const reply = posixTerminationReply(100, 'fixture', exit);
    check('FIX14 kill reply unconfirmed '+name, reply.status === 'termination_unconfirmed' && reply.terminationConfirmed === false && reply.terminationReasons.length > 0, reply);
  }
  check('FIX14 kill reply requires final descendant proof', posixTerminationReply(100, 'fixture', { termination: gone }).status === 'terminated');
  const parsed = parsePsIdentities('501 1 S Wed Nov 11 01:00:00 2026 /bin/node\n502 1 Z Wed Nov 11 01:00:00 2026 (node)\n503 1 X Wed Nov 11 01:00:00 2026 node\n504 1 S Wed Nov 11 01:00:00 2026 npm @scope/pkg');
  check('FIX14 BSD identity parser filters zombies and dead states', parsed.size === 2 && parsed.get(501)?.started === 'Wed Nov 11 01:00:00 2026' && parsed.get(504)?.name === 'npm @scope/pkg', [...parsed]);
}

{
  for (const [mode, expected] of [['ignores', 'SIGTERM,SIGKILL'], ['exits', 'SIGTERM'], ['reused', 'SIGTERM'], ['unknown', 'SIGTERM']]) {
    let calls = 0; const signals = [], pauses = [];
    const result = await terminatePosixMember(member(200, 1), async () => {
      calls++; if (calls > 1 && mode === 'unknown') throw Error('unavailable');
      return new Map(calls > 1 && mode === 'exits' ? [] : [[200, member(200, calls > 1 && mode === 'reused' ? 99 : 1)]]);
    }, Date.now() + 5000, (pid, kind) => signals.push(kind), async ms => pauses.push(ms));
    check('FIX14 POSIX bounded SIGTERM escalation '+mode, result && signals.join() === expected && pauses.length === 1 && pauses[0] <= 200 && calls === 2, { signals, pauses, calls });
  }
  const signals = []; await terminatePosixMember(member(200, 1, { weak: true }), async () => new Map([[200, member(200, 1)]]), Infinity, (pid, kind) => signals.push(kind), async () => {});
  check('FIX14 POSIX escalation never signals weak identities', signals.length === 0);
}
/* FIX15: real ps layouts and product completion/kill semantics, no OS signals. */
{
  for (const text of ['36924 36923 36924 S<s  Fri Nov 13 04:59:00 2026     /Users/…/node', '   7182    7175    7182 Ssl  Fri Nov 13 04:58:18 2026 node']) {
    const table = parsePsTable(text), row = table.rows[0];
    check('FIX15 CI ps table sample '+text.trim().split(' ')[0], table.complete && table.unknown.length === 0 && row?.name === 'node' && row.pgid === row.pid && row.ppid === row.pid - (row.pid === 7182 ? 7 : 1), table);
    const identity = parsePsIdentities(text.replace(/^(\s*\d+\s+\d+)\s+\d+/, '$1')).get(row.pid);
    check('FIX15 CI identity sample '+row.pid, identity?.started === row.started && identity.name === 'node' && identity.ppid === row.ppid, identity);
  }
  check('FIX15 old ps columns are rejected rather than misidentified', parsePsIdentities('2203 2202 Fri Oct  9 13:30:35 2026 npm test').size === 0);
}
{
  const directory = mkdtempSync(join(TEMP, 'fix15-finished-'));
  const base = { pid: 100, directory, meta: { jobId: 'fixture', tree: 1 }, status: 'completed' };
  writeFileSync(join(directory, 'exit.json'), JSON.stringify({ termination: { confirmed: true, reasons: [] } }));
  const lost = posixFinishedReply({ ...base, status: 'lost' });
  check('FIX15 lost status overrides stale termination proof', lost.status === 'lost' && lost.terminationConfirmed === false);
  for (const status of ['completed', 'failed']) {
    const legacy = posixFinishedReply({ ...base, status, meta: { jobId: 'fixture' } });
    check('FIX15 legacy finished status '+status+' does not claim tree termination', legacy.status === status && legacy.terminationConfirmed === false && legacy.terminationReasons.length > 0);
  }
  check('FIX15 tracked finished job still requires proof', posixFinishedReply(base).status === 'terminated');
  writeFileSync(join(directory, 'exit.json'), JSON.stringify({ termination: { confirmed: false, reasons: ['survivor'] } }));
  check('FIX15 tracked survivor remains unconfirmed', posixFinishedReply(base).status === 'termination_unconfirmed');
  // Exercise the actual POSIX JobStore.kill early branch on Windows, with all
  // process lookups and signals excluded. Restore the platform synchronously.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    for (const [status, tree, expected] of [['lost', 1, 'lost'], ['completed', undefined, 'completed'], ['completed', 1, 'termination_unconfirmed']]) {
      const store = Object.create(JobStore.prototype);
      Object.assign(store, { ready: Promise.resolve(), get: () => ({ ...base, status, meta: { jobId: 'fixture', tree, runner: { pid: 100, started: 'fixture' } } }), check: async () => {}, lookup: async () => { throw Error('must not query or signal'); } });
      const result = await store.kill(base.pid);
      check('FIX15 product kill preserves '+status+'/'+tree, result.status === expected && result.terminationConfirmed === false && !existsSync(join(directory, 'kill.json')), result);
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
}
{
  const report = { exitCode: 0, signal: null, endTime: new Date().toISOString(), killed: false, timedOut: false, termination: { confirmed: false, pending: true, reasons: ['pending'] } };
  for (const mode of ['natural', 'kill', 'timeout', 'unknown', 'failure', 'preexisting', 'windows']) {
    const directory = mkdtempSync(join(TEMP, 'fix15-report-')), file = join(directory, 'exit.json'), writes = [];
    const killed = mode === 'kill', timedOut = mode === 'timeout'; let observed, killedCalls = 0;
    if (mode === 'preexisting') writeFileSync(file, JSON.stringify({ ...report, endTime: 'independent-error', error: 'preserve me' }));
    const tracker = mode === 'windows' ? undefined : {
      seal: async () => { observed = existsSync(file); if (mode === 'failure') throw Error('injected seal failure'); return true; },
      killRecorded: async () => { killedCalls++; return 0; },
      confirmation: async () => { if (mode === 'failure') throw Error('injected table failure'); return { confirmed: mode !== 'unknown', reasons: mode === 'unknown' ? ['survivor'] : [] }; },
    };
    await finishJobReport(directory, { ...report, killed, timedOut }, tracker, (path, value) => { writes.push(value); writeFileSync(path, JSON.stringify(value)); });
    const final = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (mode === 'natural') check('FIX15 natural POSIX completion writes one final exit', writes.length === 1 && observed === false && final.termination?.confirmed && !final.termination?.pending, writes);
    if (killed || timedOut) check('FIX15 '+mode+' finishes descendant cleanup', killedCalls === 1);
    if (killed || timedOut) check('FIX15 '+mode+' retains pending then final proof', writes.length === 2 && observed === true && writes[0].termination.pending === true && final.termination?.confirmed && !final.termination?.pending, writes);
    if (mode === 'unknown' || mode === 'failure') check('FIX15 '+mode+' final exit cannot claim termination', writes.length === 1 && final.termination?.confirmed === false && final.termination.reasons.length > 0 && !final.termination?.pending, final);
    if (mode === 'preexisting') check('FIX15 finalizer preserves independent exit', writes.length === 0 && final.error === 'preserve me', final);
    if (mode === 'windows') check('FIX15 tracker-free Windows still writes once immediately', writes.length === 1);
  }
}

/* ---- 2. 終止：逐筆核對身分 ---- */
{
  const sent = [];
  const identities = new Map([[200, { pid: 200, started: iso(1), name: 'a' }], [230, { pid: 230, started: iso(99), name: 'reused' }]]);
  const lookups = [];
  const count = await terminateTreeMembers(
    [member(200, 1), member(210, 1, { loose: true }), member(220, 1, { weak: true }), member(230, 1), member(240, 1)],
    async pids => { lookups.push(pids.join()); return new Map(pids.filter(pid => identities.has(pid)).map(pid => [pid, identities.get(pid)])); },
    Infinity, pid => sent.push(pid));
  check('終止前逐筆重新核對身分：只送給 pid 與啟動時間都對得上的確定成員', count === 1 && sent.join() === '200', sent);
  check('終止時一次只查一個 pid，不確定與精度不足的成員連查都不查', lookups.join('|') === '200|230|240', lookups);
  const late = [];
  await terminateTreeMembers([member(200, 1)], async () => new Map([[200, identities.get(200)]]), Date.now() - 1, pid => late.push(pid));
  check('超過時間上限就不再送終止', late.length === 0);
  const throwing = [];
  await terminateTreeMembers([member(200, 1)], async () => { throw new Error('lookup unavailable'); }, Infinity, pid => throwing.push(pid));
  check('身分查不了時不送終止', throwing.length === 0);
}

/* ---- 3. runner 的追蹤器：假程序表 ---- */
{
  const directory = mkdtempSync(join(TEMP, 'tracker-'));
  const now = Date.now();
  const born = offset => new Date(now + offset).toISOString();
  let workerAlive = true, tables = 0;
  const table = async () => {
    tables++;
    return snap(workerAlive
      ? [{ pid: 100, ppid: 1, started: born(-50), name: 'worker' }, { pid: 200, ppid: 100, started: born(-10), name: 'child' }]
      : [{ pid: 200, ppid: 100, started: born(-10), name: 'child' }, { pid: 300, ppid: 100, started: born(-5), name: 'late' }], { boot: 'boot-a' });
  };
  const sent = [];
  const tracker = startTreeTracker({ directory, pid: 100, identity: { pid: 100, started: born(-50), name: 'worker' }, since: now - 100, alive: () => workerAlive,
    table, intervalMs: 20, platform: 'win32', send: pid => sent.push(pid),
    lookup: async pids => new Map(pids.map(pid => [pid, { pid, started: pid === 200 ? born(-10) : born(-5), name: 'x' }])) });
  const first = readTreeRecord(directory);
  check('追蹤器一啟動就先落一份紀錄（還沒列舉）', first && first !== 'corrupt' && first.root.pid === 100 && first.members.length === 0 && first.scans === 0, first);
  await until(() => { const rec = readTreeRecord(directory); return rec && rec !== 'corrupt' && rec.members.length > 0; }, 5000, 10);
  await until(() => tables >= 3, 5000, 10);
  const during = readTreeRecord(directory);
  check('worker 存活期間定期列舉，子程序以確定身分累積進紀錄', during !== 'corrupt' && during?.members.some(item => item.pid === 200 && !item.loose) && !during.sealed && during.boot === 'boot-a', during);
  workerAlive = false;
  tracker.ended();
  const sealed = await tracker.seal();
  const after = readTreeRecord(directory);
  check('worker 結束後補一次列舉並標記 sealed', sealed === true && after !== 'corrupt' && after?.sealed === true && typeof after.ended === 'string' && after.scans >= 2, after);
  check('worker 結束後才看到的程序只記成不確定：「最後一次列舉」不是證據', after !== 'corrupt' && after?.members.find(item => item.pid === 300)?.loose === true, after);
  check('正常追蹤的紀錄沒有缺口', after !== 'corrupt' && treeGap(after) === null, after);
  const stoppedAt = tables;
  await sleep(120);
  check('worker 結束後不再定期列舉', tables === stoppedAt, `${stoppedAt} → ${tables}`);
  const count = await tracker.killRecorded();
  check('終止時只砍確定還活著的子孫，不確定的不碰', count === 1 && sent.join() === '200', sent);
}
{
  // 列舉一直失敗：只記次數、不封存，收尾在時間上限內結束。
  const directory = mkdtempSync(join(TEMP, 'tracker-fail-'));
  let workerAlive = true, calls = 0;
  const sent = [];
  const tracker = startTreeTracker({ directory, pid: 100, identity: null, since: Date.now(), alive: () => workerAlive, intervalMs: 10, platform: 'win32', sealBudgetMs: 300, killBudgetMs: 200, send: pid => sent.push(pid),
    table: async ({ timeoutMs } = {}) => { calls++; await sleep(Math.min(timeoutMs ?? 50, 50)); throw new Error('enumeration unavailable'); } });
  await until(() => { const rec = readTreeRecord(directory); return rec && rec !== 'corrupt' && rec.failed >= 2; }, 5000, 10);
  workerAlive = false;
  const started = Date.now();
  const sealed = await tracker.seal();
  const elapsed = Date.now() - started;
  const rec = readTreeRecord(directory);
  check('列舉失敗只記次數，不標 sealed，也不讓追蹤器丟例外', sealed === false && rec !== 'corrupt' && rec?.failed >= 3 && rec.scans === 0 && !rec.sealed, rec);
  check('收尾有時間上限：列舉一直失敗也不會拖住 runner', elapsed < 1500, `${elapsed} ms`);
  check('沒有封存的紀錄算有追蹤缺口', rec !== 'corrupt' && treeGap(rec) !== null, rec);
  check('列舉失敗時不會去終止任何程序', await tracker.killRecorded() === 0 && sent.length === 0);
  // 留給第 4 段：把這份真的由追蹤器寫出來的失敗紀錄交給執行器。
  globalThis.failedTrackerRecord = rec;
}
{
  // 連續失敗要逐次拉長間隔，不能照原間隔一直打。
  const directory = mkdtempSync(join(TEMP, 'tracker-backoff-'));
  let calls = 0;
  const tracker = startTreeTracker({ directory, pid: 100, identity: null, since: Date.now(), alive: () => true, intervalMs: 20, platform: 'win32', sealBudgetMs: 50,
    table: async () => { calls++; throw new Error('enumeration unavailable'); } });
  await sleep(700);
  const during = calls;
  await tracker.seal();
  // 間隔 20、40、80、160、320…：700 毫秒內大約 5 次；不退避的話會有三十幾次。
  check('列舉連續失敗時逐次拉長間隔', during >= 3 && during <= 8, `${during} 次`);
}
{
  // 偶發失敗一次、馬上重試成功：不算缺口。
  const directory = mkdtempSync(join(TEMP, 'tracker-retry-'));
  let workerAlive = true, calls = 0;
  const tracker = startTreeTracker({ directory, pid: 100, identity: null, since: Date.now(), alive: () => workerAlive, intervalMs: 20, platform: 'win32',
    table: async () => { if (++calls === 2) throw new Error('transient'); return snap([]); } });
  await until(() => calls >= 4, 5000, 10);
  workerAlive = false;
  await tracker.seal();
  const rec = readTreeRecord(directory);
  check('偶發失敗在最大間隔內恢復不永久阻擋', rec !== 'corrupt' && rec?.failed === 1 && rec.sealed === true && treeGap(rec) === null, rec);
}
{
  // worker 活了很久，期間沒有一次列舉成功，結束後列舉才恢復：最後那一次補不回中間的歷史。
  const directory = mkdtempSync(join(TEMP, 'tracker-blind-'));
  let workerAlive = true;
  const tracker = startTreeTracker({ directory, pid: 100, identity: null, since: Date.now() - 60000, alive: () => workerAlive, intervalMs: 20, platform: 'win32',
    table: async () => { if (workerAlive) throw new Error('enumeration unavailable'); return snap([]); } });
  await sleep(100);
  workerAlive = false;
  const sealed = await tracker.seal();
  const rec = readTreeRecord(directory);
  check('存活期間從沒成功列舉過，結束後才成功：仍算追蹤缺口', sealed === true && rec !== 'corrupt' && rec?.sealed === true && treeGap(rec) !== null, rec);
  globalThis.blindTrackerRecord = rec;
}
{
  // 表不完整的那一次不算成功，但看到的成員照收。
  const directory = mkdtempSync(join(TEMP, 'tracker-partial-'));
  const now = Date.now();
  let workerAlive = true;
  const tracker = startTreeTracker({ directory, pid: 100, identity: { pid: 100, started: new Date(now - 50).toISOString(), name: 'worker' }, since: now - 100, alive: () => workerAlive, intervalMs: 20, platform: 'win32', sealBudgetMs: 200,
    table: async () => snap([{ pid: 100, ppid: 1, started: new Date(now - 50).toISOString(), name: 'worker' }, { pid: 200, ppid: 100, started: new Date(now - 10).toISOString(), name: 'child' }], { complete: false }) });
  await until(() => { const rec = readTreeRecord(directory); return rec && rec !== 'corrupt' && rec.failed >= 2; }, 5000, 10);
  workerAlive = false;
  const sealed = await tracker.seal();
  const rec = readTreeRecord(directory);
  check('程序表不完整的列舉不算成功、不能封存，但看到的成員照記', sealed === false && rec !== 'corrupt' && rec?.scans === 0 && !rec.sealed && rec.members.some(item => item.pid === 200), rec);
}

for (const loseParent of [false, true]) {
  const directory = mkdtempSync(join(TEMP, 'fix14-boundary-'));
  const stamp = ms => new Date(ms).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) (.+) GMT$/, (_, d, m, y, t) => `Thu ${m} ${d.padStart(2, ' ')} ${t} ${y}`);
  const worker = { pid: 100, started: stamp(Date.now() - 2000), name: 'worker' };
  let alive = true, calls = 0, child; const sent = [];
  const tracker = startTreeTracker({ directory, pid: 100, identity: worker, since: Date.now(), platform: 'darwin', intervalMs: 60000, alive: () => alive,
    table: async () => { calls++; child ??= { pid: 200, ppid: 100, pgid: 200, started: stamp(Date.now()), name: 'child' }; if (calls > 1 && loseParent) alive = false; return snap([...(alive ? [{ ...worker, ppid: 1, pgid: 100 }] : []), { ...child, ppid: alive ? 100 : 1 }]); },
    lookup: async () => new Map([[200, child]]), send: pid => sent.push(pid), killBudgetMs: 2000 });
  try {
    const began = Date.now(); await tracker.killRecorded();
    check('FIX14 bounded pre-kill rescan '+(loseParent ? 'losing owner stays blocked' : 'promotes owned child'), calls >= 2 && Date.now() - began < 2500 && (loseParent ? sent.length === 0 : sent.join() === '200'), { calls, sent });
  } finally { alive = false; tracker.ended(); await tracker.seal(); }
}

{
  const directory = mkdtempSync(join(TEMP, 'fix14-slow-table-'));
  const stamp = ms => new Date(ms).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) (.+) GMT$/, (_, d, m, y, t) => `Thu ${m} ${d.padStart(2, ' ')} ${t} ${y}`);
  const worker = { pid: 100, started: stamp(Date.now() - 2000), name: 'worker' };
  let calls = 0, alive = true, child; const sent = [];
  const tracker = startTreeTracker({ directory, pid: 100, identity: worker, since: Date.now(), platform: 'darwin', intervalMs: 60000, alive: () => alive,
    table: async () => { calls++; child ??= { pid: 200, ppid: 100, pgid: 200, started: stamp(Date.now()), name: 'child' }; if (calls === 1) await sleep(1010 - Date.now() % 1000); return snap([{ ...worker, ppid: 1, pgid: 100 }, child]); },
    lookup: async () => new Map([[200, child]]), send: pid => sent.push(pid), killBudgetMs: 3000 });
  try { await tracker.killRecorded(); check('FIX14 table crossing birth boundary still rescans', calls >= 2 && sent.join() === '200', { calls, sent }); }
  finally { alive = false; await tracker.seal(); }
}
{
  const directory = mkdtempSync(join(TEMP, 'fix14-confirm-history-'));
  let table = snap([]), calls = 0;
  const tracker = startTreeTracker({ directory, pid: 100, identity: member(100, 0), since: Date.now(), platform: 'linux', intervalMs: 60000, alive: () => false,
    table: async () => { calls++; return table; }, killBudgetMs: 200 });
  await tracker.seal(); table = snap([], { unknown: [{ pid: 200, ppid: 100 }] });
  const unknown = await tracker.confirmation(); table = snap([]);
  const later = await tracker.confirmation();
  check('FIX14 confirmation preserves newly unknown descendant history', !unknown.confirmed && !later.confirmed && readTreeRecord(directory)?.uncertainHistory === true, { unknown, later, calls });
}

/* ---- 4. kernel 執行器：假程序表＋假 job 目錄 ---- */
const GONE_PID = 2147480000; // 不會有程序用到的 pid：process.kill(pid, 0) 回 ESRCH。
const sealedRecord = (worker, members, extra = {}) => ({ ...record('win32', { ...worker, gone: iso(-10) }, members), ended: iso(-10), sealed: true, boot: 'boot-a', ...extra });
function fakeJob({ tree = true, members = [], treeContent, recordExtra = {} } = {}) {
  const jobId = randomUUID(), directory = join(jobStateDir(), 'jobs', jobId);
  mkdirSync(directory, { recursive: true });
  const runner = { pid: GONE_PID + 1, started: iso(-100), name: 'node' }, worker = { pid: GONE_PID + 2, started: iso(-90), name: 'node' };
  writeFileSync(join(directory, 'meta.json'), JSON.stringify({ version: 1, jobId, pid: runner.pid, agent: 'codex', resolvedModel: 'stub', task: 'tree fixture', workFolder: ROOT,
    startTime: new Date(Date.now() - 60000).toISOString(), source: 'cli', principal: null, server: null, runner, worker, recoverable: true, ...(tree ? { tree: 1 } : {}) }));
  // 結束時間用現在：太舊的話 JobStore 的回收會把這個假 job 目錄當成過期資料刪掉。
  writeFileSync(join(directory, 'exit.json'), JSON.stringify({ exitCode: 0, signal: null, endTime: new Date().toISOString(), timedOut: false, killed: false }));
  if (treeContent !== undefined) writeFileSync(join(directory, TREE_FILE), treeContent);
  else if (tree) writeFileSync(join(directory, TREE_FILE), JSON.stringify(sealedRecord(worker, members, recordExtra)));
  // tracked：kernel 把它當全權限 job 啟動的，要求子孫的證據齊全。
  return { job: { pid: runner.pid, jobId, tracked: true }, plain: { pid: runner.pid, jobId }, directory, runner, worker };
}
const executorWith = (table, extra = {}) => {
  const terminated = [];
  const executor = new FileJobExecutor({ platform: 'linux', table: async () => { if (table.value instanceof Error) throw table.value; return Array.isArray(table.value) ? snap(table.value, { boot: 'boot-a' }) : table.value; },
    terminate: async list => { terminated.push(...list.map(item => item.pid)); return list.length; }, runnerExitWaitMs: 0, ...extra });
  executor.service.killProcess = async () => ({ status: 'completed' });
  return { executor, terminated };
};
const held = fixture => existsSync(join(fixture.directory, JOB_HOLD_FILE));
{
  const { executor } = executorWith({ value: [] });
  const meta = { runner: { pid: process.pid, started: 'fixture', name: 'node' } };
  check('FIX14 complete table absence overrides kill-zero zombie liveness', (await executor.identitiesAlive(meta, snap([]))).runner === false);
  check('FIX14 unreadable or incomplete table keeps root uncertain', (await executor.identitiesAlive(meta, snap([], { unknown: [{ pid: process.pid, ppid: 1 }] }))).runner === true && (await executor.identitiesAlive(meta, snap([], { complete: false }))).runner === true);
  const fixture = fakeJob(); const store = new JobStore(jobStateDir());
  try {
    await store.ready; const job = store.get(fixture.job.pid, fixture.job.jobId);
    check('FIX14 job result does not claim descendants gone from legacy exit', jobResult(job).terminationConfirmed === false);
    const path = join(fixture.directory, 'exit.json'); const exit = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify({ ...exit, termination: { confirmed: false, reasons: ['descendant still alive'] } }));
    check('FIX14 job result exposes descendant termination reasons', jobResult(job).terminationReasons?.includes('descendant still alive'));
  } finally { store.dispose(); }
}

{
  const child = member(GONE_PID + 10, -50);
  const fixture = fakeJob({ members: [child] });
  const table = { value: [{ pid: child.pid, ppid: fixture.worker.pid, started: child.started, name: 'node' }] };
  const { executor, terminated } = executorWith(table);
  check('worker 已退出但記錄的子孫還活著，isGone 不得為 true', await executor.isGone(fixture.job) === false);
  const blockers = await executor.blockers(fixture.job);
  check('還活著的子孫 pid 會列在說明裡', blockers.length === 1 && blockers[0].includes(String(child.pid)), blockers);
  check('還不能確認消失時，在 job 目錄放保留標記', held(fixture));
  check('kill 會終止確定還活著的子孫', await executor.kill(fixture.job) === true && terminated.join() === String(child.pid), terminated);
  check('沒有 tracked 的 job，紀錄裡確定還活著的子孫一樣會擋', await executor.isGone(fixture.plain) === false);
  table.value = [];
  check('子孫都不在了才算消失', await executor.isGone(fixture.job) === true);
  check('確認消失後拿掉保留標記', !held(fixture));
}
{
  const child = member(GONE_PID + 11, -50);
  const fixture = fakeJob({ members: [child] });
  // 同一個 pid、啟動時間不同：原來的子孫已經結束，pid 被別的程序拿去用了。
  const { executor, terminated } = executorWith({ value: [{ pid: child.pid, ppid: 4, started: iso(-1), name: 'other' }] });
  check('子孫的 pid 被重用（啟動時間不符）視為已消失', await executor.isGone(fixture.job) === true);
  await executor.kill(fixture.job);
  check('pid 被重用時 kill 不會把新佔用者列入終止', terminated.length === 0, terminated);
}
{
  const child = member(GONE_PID + 12, -50);
  const fixture = fakeJob({ members: [child] });
  const { executor } = executorWith({ value: new Error('enumeration unavailable') });
  check('程序表列舉失敗時 isGone 不得為 true', await executor.isGone(fixture.job) === false);
  const blockers = await executor.blockers(fixture.job);
  check('列舉失敗的原因會列在說明裡', blockers.some(text => text.includes('列舉失敗')), blockers);
}
{
  const corrupt = fakeJob({ treeContent: '{壞掉的 json' });
  const missing = fakeJob();
  rmSync(join(missing.directory, TREE_FILE), { force: true });
  const { executor } = executorWith({ value: [] });
  check('子孫紀錄損毀時 isGone 不得為 true', await executor.isGone(corrupt.job) === false);
  check('meta 說有追蹤卻沒有子孫紀錄時 isGone 不得為 true', await executor.isGone(missing.job) === false);
  const legacy = fakeJob({ tree: false });
  check('舊 runner 啟動的 job（沒有追蹤旗標）照舊只看 runner 與 worker', await executor.isGone(legacy.job) === true);
}
{
  // 不確定的成員：擋「已消失」，但 kill 不碰它。
  const loose = member(GONE_PID + 13, -50, { loose: true });
  const fixture = fakeJob({ members: [loose] });
  const { executor, terminated } = executorWith({ value: [{ pid: loose.pid, ppid: 4, started: loose.started, name: 'node' }] });
  check('不確定的子孫還活著時 isGone 不得為 true', await executor.isGone(fixture.job) === false);
  await executor.kill(fixture.job);
  check('kill 不會終止親子關係不確定的程序', terminated.length === 0, terminated);
  check('不確定的子孫在說明裡標明不會自動終止', (await executor.blockers(fixture.job)).some(text => text.includes('親子關係不確定，不會自動終止')));
  const weak = member(GONE_PID + 17, -50, { weak: true });
  const weakFixture = fakeJob({ members: [weak] });
  const weakRun = executorWith({ value: [{ pid: weak.pid, ppid: 4, started: weak.started, name: 'node' }] });
  await weakRun.executor.kill(weakFixture.job);
  check('啟動時間精度不足的成員同樣只擋不殺', await weakRun.executor.isGone(weakFixture.job) === false && weakRun.terminated.length === 0 && (await weakRun.executor.blockers(weakFixture.job)).some(text => text.includes('精度不足')));
}
{
  // runner 還活著：終止子孫是 runner 的事，執行器不插手。
  const child = member(GONE_PID + 14, -50);
  const fixture = fakeJob({ members: [child] });
  const { executor, terminated } = executorWith({ value: [{ pid: fixture.runner.pid, ppid: 4, started: fixture.runner.started, name: 'node' }, { pid: child.pid, ppid: 4, started: child.started, name: 'node' }] });
  check('runner 還活著時 isGone 不得為 true', await executor.isGone(fixture.job) === false);
  await executor.kill(fixture.job).catch(() => false);
  check('runner 還活著時執行器不自己終止子孫', terminated.length === 0, terminated);
}
{
  // 重查時發現新的孤兒（父程序是記錄過、已經死掉的成員）：寫回紀錄、算還活著，但只是不確定，不會被砍。
  const now = Date.now();
  const parent = { pid: GONE_PID + 15, started: new Date(now - 60000).toISOString(), name: 'mid' };
  const fixture = fakeJob({ members: [parent] });
  const orphan = { pid: GONE_PID + 16, ppid: parent.pid, started: new Date(now - 30000).toISOString(), name: 'leaf' };
  const { executor, terminated } = executorWith({ value: [orphan] });
  check('重查時找到新孤兒，isGone 不得為 true', await executor.isGone(fixture.job) === false);
  const rewritten = readTreeRecord(fixture.directory);
  check('重查找到的新孤兒以不確定寫回 job 目錄的紀錄', rewritten !== 'corrupt' && rewritten?.members.find(item => item.pid === orphan.pid)?.loose === true, rewritten);
  await executor.kill(fixture.job);
  check('事後才找到的孤兒不會被自動終止', terminated.length === 0, terminated);
}
{
  // 追蹤缺口：把追蹤器真的寫出來的失敗紀錄（scans 0、failed > 0、沒有 sealed）交給執行器。現在程序表是好的、也看不到任何子孫。
  const failedRecord = globalThis.failedTrackerRecord;
  const fixture = fakeJob({ treeContent: JSON.stringify({ ...failedRecord, root: { ...failedRecord.root, pid: GONE_PID + 2 } }) });
  const { executor } = executorWith({ value: [] });
  check('追蹤全部失敗的紀錄交給執行器：看不到子孫也不得判定消失', failedRecord.scans === 0 && failedRecord.failed > 0 && !failedRecord.sealed && await executor.isGone(fixture.job) === false);
  check('說明寫明是追蹤缺口', (await executor.blockers(fixture.job)).some(text => text.includes('追蹤缺口')), await executor.blockers(fixture.job));
  check('有追蹤缺口時也保住 job 目錄', held(fixture));
  const blindRecord = globalThis.blindTrackerRecord;
  const blind = fakeJob({ treeContent: JSON.stringify({ ...blindRecord, root: { ...blindRecord.root, pid: GONE_PID + 2 } }) });
  check('存活期間沒有成功列舉、事後才封存的紀錄，同樣不得判定消失', await executor.isGone(blind.job) === false && (await executor.blockers(blind.job)).some(text => text.includes('追蹤缺口')));
  check('沒有 tracked 的 job 不因追蹤缺口卡住', await executor.isGone(fixture.plain) === true);
}
{
  // job 目錄被刪掉、而且從來沒查過：沒有紀錄就是無法確認，不能直接放行。
  const child = member(GONE_PID + 18, -50);
  const fixture = fakeJob({ members: [child] });
  rmSync(fixture.directory, { recursive: true, force: true });
  const { executor } = executorWith({ value: [{ pid: child.pid, ppid: 4, started: child.started, name: 'node' }] });
  check('全權限 job 的目錄不見了、又從沒查過：isGone 不得為 true', await executor.isGone(fixture.job) === false);
  check('目錄不見的原因會列在說明裡', (await executor.blockers(fixture.job)).some(text => text.includes('目錄不見了')));
  check('沒有 tracked 的 job（舊日誌、非全權限）目錄不在時照舊算消失', await executor.isGone(fixture.plain) === true);
}
{
  // 成員的 pid 還在但讀不出身分、或程序表不完整：未知不能轉成已消失。
  const child = member(GONE_PID + 19, -50);
  const fixture = fakeJob({ members: [child] });
  const unreadable = executorWith({ value: snap([], { boot: 'boot-a', unknown: [{ pid: child.pid, ppid: 4 }] }) });
  check('子孫的 pid 讀不出身分時 isGone 不得為 true，kill 也不碰它', await unreadable.executor.isGone(fixture.job) === false && (await unreadable.executor.kill(fixture.job), unreadable.terminated.length === 0));
  const kept = readTreeRecord(fixture.directory);
  check('讀不出身分時紀錄裡的成員留著', kept !== 'corrupt' && kept?.members.some(item => item.pid === child.pid && !item.gone), kept);
  // 紀錄裡沒有任何成員、現在也看不到子孫，但這張表不完整：不能據此說沒有子孫。
  const empty = fakeJob();
  const partial = executorWith({ value: snap([], { boot: 'boot-a', complete: false }) });
  check('程序表不完整時 isGone 不得為 true', await partial.executor.isGone(empty.job) === false && (await partial.executor.blockers(empty.job)).some(text => text.includes('程序表不完整')));
  // 有個 pid 讀不出身分，而它的父程序指向紀錄裡（已經不在）的成員：可能是子孫，記不下來，也不能放行。
  const parent = member(GONE_PID + 21, -50);
  const orphaned = fakeJob({ members: [parent] });
  const unverified = executorWith({ value: snap([], { boot: 'boot-a', unknown: [{ pid: GONE_PID + 22, ppid: parent.pid }] }) });
  check('讀不出身分又指向已知成員的 pid 會擋住 isGone', await unverified.executor.isGone(orphaned.job) === false && (await unverified.executor.blockers(orphaned.job)).some(text => text.includes(String(GONE_PID + 22))));
}
{
  // 機器重開過：紀錄裡的程序不可能還在，追蹤缺口也不必再管。
  const fixture = fakeJob({ members: [member(GONE_PID + 20, -50)], recordExtra: { sealed: undefined, ended: undefined } });
  const same = executorWith({ value: snap([], { boot: 'boot-a' }) });
  check('同一次開機、紀錄沒封存：不得判定消失', await same.executor.isGone(fixture.job) === false);
  const rebooted = executorWith({ value: snap([], { boot: 'boot-b' }) });
  check('開機識別變了（機器重開過）才放行沒封存的紀錄', await rebooted.executor.isGone(fixture.job) === true && !held(fixture));
  const unknownBoot = executorWith({ value: snap([]) });
  const again = fakeJob({ members: [], recordExtra: { sealed: undefined } });
  check('拿不到開機識別時不能當成重開過', await unknownBoot.executor.isGone(again.job) === false);
}
{
  // 啟動全權限 job 時就放保留標記，JobRef 帶 tracked；其他 job 不放。
  const executor = new FileJobExecutor({ platform: 'linux' });
  const made = [];
  executor.service = { startProcess: async () => { const jobId = randomUUID(); mkdirSync(join(jobStateDir(), 'jobs', jobId), { recursive: true }); made.push(jobId); return { pid: GONE_PID + 30, jobId }; } };
  const worktree = join(TEMP, 'wt');
  const write = await executor.start({ actionId: 'a1', kind: 'worker', mode: 'write', model: 'm', prompt: 'p', marker: 'K-a1', cwd: worktree }, { template: 'develop', workFolder: worktree, develop: { worktree } });
  const decide = await executor.start({ actionId: 'a2', kind: 'decide', model: 'm', prompt: 'p', marker: 'K-a2' }, { workFolder: worktree });
  check('啟動全權限 job 時放保留標記並標成 tracked', write.tracked === true && existsSync(join(jobStateDir(), 'jobs', made[0], JOB_HOLD_FILE)), write);
  check('非全權限 job 不放保留標記、不標 tracked', decide.tracked === undefined && !existsSync(join(jobStateDir(), 'jobs', made[1], JOB_HOLD_FILE)), decide);
  for (const jobId of made) rmSync(join(jobStateDir(), 'jobs', jobId), { recursive: true, force: true });
}

/* ---- 5. JobStore 回收遇到保留標記 ---- */
{
  const state = mkdtempSync(join(TEMP, 'gc-'));
  const fixture = (endTime, hold) => {
    const jobId = randomUUID(), directory = join(state, 'jobs', jobId);
    mkdirSync(directory, { recursive: true });
    const runner = { pid: GONE_PID + 40, started: iso(-100), name: 'node' };
    writeFileSync(join(directory, 'meta.json'), JSON.stringify({ version: 1, jobId, pid: runner.pid, agent: 'codex', resolvedModel: 'stub', task: 'gc fixture', workFolder: ROOT,
      startTime: new Date(endTime - 1000).toISOString(), source: 'cli', principal: null, server: null, runner, worker: null, recoverable: true, tree: 1 }));
    writeFileSync(join(directory, 'exit.json'), JSON.stringify({ exitCode: 0, signal: null, endTime: new Date(endTime).toISOString(), timedOut: false, killed: false }));
    if (hold) writeFileSync(join(directory, JOB_HOLD_FILE), '{}');
    return directory;
  };
  const now = Date.now();
  const heldDir = fixture(now - RETENTION_MS - 60000, true), freeDir = fixture(now - RETENTION_MS - 60000, false);
  await collectStoreFiles(state, now, async () => new Map());
  check('到期回收跳過有保留標記的 job 目錄，沒有標記的照常回收', existsSync(heldDir) && !existsSync(freeDir));
  const store = new JobStore(state, 'cli');
  await store.ready;
  store.collect(now, true);
  check('立即回收（cleanup_processes）也跳過有保留標記的 job 目錄', existsSync(heldDir));
  rmSync(join(heldDir, JOB_HOLD_FILE), { force: true });
  store.scan();
  store.collect(now, true);
  check('拿掉保留標記後就能回收', !existsSync(heldDir));
  store.dispose();
}

try { rmSync(TEMP, { recursive: true, force: true }); } catch { /* 暫存目錄留給系統清。 */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
