/**
 * agy 在 Windows 依版本選 spawn 模式＋長 prompt 改走檔案＋durable 結果帶出續接警告。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * 2026-11-20 實測：ConPTY 寬 200 欄，會在第 200 格插入 `\r\n` 並重複斷點字元。
 * agy `--output-format json` 是一整行，長回覆（12,431 字元、含全形字）被切斷後
 * parseOutput 退回 text fallback：message 變成原始 JSON，session_id 與 usage 遺失。
 * 同日實測 agy 1.5.13 非 TTY 也能輸出，所以新版改走管線，舊版保留 ConPTY。
 *
 * 守的事：
 *   1. 版本解析與門檻（只認整段就是版本號的輸出；量不到＝ConPTY；輸出超限＝量不到）
 *   2. resolver：只探測 `C:\…`／UNC 絕對路徑；快取綁執行檔身分、探測前後身分要一致；
 *      Windows 快取鍵正規化；並行共用；舊版結論過期後重問；逾時用 child handle 結束
 *   3. resolveSpawnMode 只在 win32 用 agent 的 resolver，失敗退回靜態 win32SpawnMode
 *   4. 長 prompt：命令列放不下時 argv 只剩指示＋--add-dir，檔案逐字等於原 prompt（prompt_file 同）；
 *      私有目錄在 state 底下、搬移重試／複製退路、啟動前失敗清掉、TTL GC（含 store 回收）
 *   5. 警告：durable 預設結果帶出 stderr 的 `warning:`（有上限）；嚴格模式固定那行排除；
 *      只有警告時 raw 輸出照回；非 agy agent 不收
 *   6. peek／liveness 對單行 JSON 只取 response、限長
 *   7. win32 端到端：stub 接收**正式 builder 產生的 argv**，經 FileProcessService 與
 *      ProcessService（MCP run）→ JobStore → runner
 *
 * 不呼叫真實 agy。
 *
 * 用法：node tests/verify-agy-pipe-mode.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync as renameSyncReal, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (rel) => import(pathToFileURL(join(ROOT, 'dist', ...rel.split('/'))).href);
const agy = await load('agents/antigravity.js');
const { resolveSpawnMode } = await load('agents/spawn-mode.js');
const { getAgent } = await load('agents/registry.js');
const { buildCliCommand, discardTemporaryPrompt, handOffTemporaryPrompt } = await load('core/command-builder.js');
const { readPromptOwner, promptOwnerGone, claimPromptOwner, PROMPT_OWNER_FILE, PROMPT_OWNER_PENDING_FILE } = await load('core/prompt-owner.js');
const { truncateWarning, WARNING_MAX_CHARS } = await load('core/warning-text.js');
const { lookupIdentities } = await load('core/live-jobs.js');
const { WORKER_CONTEXT, withWorkerContext } = await load('core/worker-context.js');
const { agyPeekText, AGY_PEEK_TEXT_MAX_LENGTH, PeekEventExtractor, LivenessEventExtractor } = await load('core/peek-extractor.js');
const { buildProcessResult } = await load('core/process-result.js');
const { movePromptDirectory, collectStoreFiles, directorySize } = await load('core/job-store.js');

const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-agy-pipe-'));
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e?.stack ?? e)); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ABS = (name) => join(TEMP, name); // resolver 只探測絕對路徑

// ── 1. 版本解析與門檻 ─────────────────────────────────────────
await test('agy 版本達門檻（等於或高於 1.5.13）判定可走管線', () => {
  for (const v of ['1.5.13', '1.5.13\n', '  1.5.13\r\n', '1.5.14', '1.6.0', '2.0.0', '1.10.0']) {
    assert.equal(agy.agyVersionSupportsPipe(v), true, JSON.stringify(v));
  }
});
await test('agy 版本低於門檻判定不可走管線', () => {
  for (const v of ['1.5.12', '1.4.99', '0.99.99', '1.1.26']) {
    assert.equal(agy.agyVersionSupportsPipe(v), false, JSON.stringify(v));
  }
});
await test('agy 版本量不到（空、雜訊、非實測格式）判定不可走管線', () => {
  for (const v of [null, '', 'garbage', 'v1.5.13', 'agy 1.6.0', '1.6.0-beta', '1.6', '1.5.13\n1.5.13', 'v22.19.0']) {
    assert.equal(agy.agyVersionSupportsPipe(v), false, JSON.stringify(v));
  }
});

// ── 2. resolver 與快取 ────────────────────────────────────────
function fakeProbe(answers) {
  const calls = [];
  const probe = async (cliPath) => { calls.push(cliPath); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  return { probe, calls };
}
const fixedIdentity = () => 'id';

await test('agy resolver 新版走 pipe、舊版與 unknown 走 pty', async () => {
  for (const [answer, mode] of [['1.5.13', 'pipe'], ['1.5.12', 'pty'], [null, 'pty'], [new Error('boom'), 'pty']]) {
    const { probe } = fakeProbe([answer]);
    const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity });
    assert.equal(await resolve(ABS('agy.exe')), mode, String(answer));
  }
});
await test('agy resolver 對非絕對路徑一律 pty 且不查版本', async () => {
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity });
  assert.equal(await resolve('agy'), 'pty');
  assert.equal(await resolve('agy.exe'), 'pty');
  assert.deepEqual(calls, []);
});
await test('agy resolver 對 drive-relative 路徑一律 pty 且不查版本', async () => {
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.13', '1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity, platform: 'win32' });
  assert.equal(await resolve('\\agy\\bin\\agy.exe'), 'pty');
  assert.equal(await resolve('/agy/bin/agy.exe'), 'pty');
  assert.equal(await resolve('C:agy.exe'), 'pty');
  assert.deepEqual(calls, []);
  assert.equal(await resolve('C:\\agy\\bin\\agy.exe'), 'pipe');
  assert.equal(await resolve('\\\\server\\share\\agy.exe'), 'pipe');
  assert.equal(agy.agyProbeablePath('/usr/local/bin/agy', 'linux'), true);
  assert.equal(agy.agyProbeablePath('agy', 'linux'), false);
});
await test('agy resolver 對 .cmd／.bat 一律 pty 且不查版本', async () => {
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity });
  assert.equal(await resolve(ABS('agy.cmd')), 'pty');
  assert.equal(await resolve(ABS('AGY.BAT')), 'pty');
  assert.deepEqual(calls, []);
});
await test('agy resolver 量不到執行檔身分時 pty 且不查版本', async () => {
  const { probe, calls } = fakeProbe(['1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe });
  assert.equal(await resolve(ABS('no-such-agy.exe')), 'pty');
  assert.deepEqual(calls, []);
});
await test('agy resolver 版本快取：同一 cliPath 只問一次、並行共用同一次查詢', async () => {
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.13', '1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity });
  const a = ABS('a.exe'), b = ABS('b.exe');
  const modes = await Promise.all([resolve(a), resolve(a), resolve(a)]);
  assert.deepEqual(modes, ['pipe', 'pipe', 'pipe']);
  assert.equal(await resolve(a), 'pipe');
  assert.deepEqual(calls, [a]);
  assert.equal(await resolve(b), 'pipe');
  assert.deepEqual(calls, [a, b], '不同 cliPath 各自查詢');
});
await test('agy resolver Windows 快取鍵不分大小寫與分隔符', async () => {
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity, platform: 'win32' });
  assert.equal(await resolve('C:\\Tools\\Agy\\agy.exe'), 'pipe');
  assert.equal(await resolve('c:/tools/agy/AGY.EXE'), 'pipe');
  assert.equal(calls.length, 1);
});
await test('agy resolver 舊版結論過期後重問（自動更新後可切到 pipe）', async () => {
  let t = 1_000;
  const { probe, calls } = fakeProbe(['1.5.12', '1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity, now: () => t, recheckMs: 60_000 });
  assert.equal(await resolve(ABS('a.exe')), 'pty');
  t += 59_000;
  assert.equal(await resolve(ABS('a.exe')), 'pty');
  assert.equal(calls.length, 1, '期限內不重問');
  t += 2_000;
  assert.equal(await resolve(ABS('a.exe')), 'pipe');
  assert.equal(calls.length, 2);
});
await test('agy resolver 身分不變時新版結論不按時間過期', async () => {
  let t = 0;
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.12']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: fixedIdentity, now: () => t, recheckMs: 1 });
  assert.equal(await resolve(ABS('a.exe')), 'pipe');
  t += 24 * 3600_000;
  assert.equal(await resolve(ABS('a.exe')), 'pipe');
  assert.equal(calls.length, 1);
});
await test('agy resolver 同路徑換成舊版後從 pipe 回到 pty', async () => {
  // 真的檔案、真的 stat：換內容（size／mtime 改變）就是換了一支執行檔。
  const exe = ABS('swap-agy.exe');
  writeFileSync(exe, 'new-version-binary');
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.12']);
  const resolve = agy.createAgySpawnModeResolver({ probe });
  assert.equal(await resolve(exe), 'pipe');
  assert.equal(await resolve(exe), 'pipe');
  assert.equal(calls.length, 1, '身分不變不重問');
  writeFileSync(exe, 'old');
  assert.equal(await resolve(exe), 'pty');
  assert.equal(calls.length, 2);
});
await test('agy resolver 探測期間執行檔被換掉不寫快取', async () => {
  const ids = ['before', 'after', 'after', 'after'];
  const { probe, calls } = fakeProbe(['1.5.13', '1.5.13']);
  const resolve = agy.createAgySpawnModeResolver({ probe, identity: () => ids.shift() });
  assert.equal(await resolve(ABS('toctou.exe')), 'pty', '探測前後身分不同：不擔保');
  assert.equal(await resolve(ABS('toctou.exe')), 'pipe', '下一次以新身分重問');
  assert.equal(calls.length, 2);
});

// ── 實際 spawn 的版本探測（用 node.exe 冒充，不碰 agy）──────────
await test('agy 版本探測：成功時回 stdout 原文', async () => {
  const out = await agy.probeAgyVersion(process.execPath, 10_000);
  assert.equal(out?.trim(), process.version);
});
await test('agy 版本探測：分段輸出照樣接起來', async () => {
  const out = await agy.probeAgyVersion(process.execPath, 10_000,
    ['-e', 'process.stdout.write("1.5.");setTimeout(()=>process.stdout.write("13\\n"),200)']);
  assert.equal(out?.trim(), '1.5.13');
  assert.equal(agy.agyVersionSupportsPipe(out), true);
});
await test('agy 版本探測：輸出超過收集上限一律 unknown', async () => {
  const out = await agy.probeAgyVersion(process.execPath, 10_000,
    ['-e', 'process.stdout.write("1.5.13");setTimeout(()=>process.stdout.write(" ".repeat(5000)+"x"),100)']);
  assert.equal(out, null);
});
await test('agy 版本探測：執行檔不存在回 null', async () => {
  assert.equal(await agy.probeAgyVersion(join(TEMP, 'no-such-agy.exe'), 5_000), null);
});
await test('agy 版本探測：逾時立刻回 null 並結束子行程', async () => {
  const marker = join(TEMP, 'probe-survived.txt');
  const started = Date.now();
  const out = await agy.probeAgyVersion(process.execPath, 300,
    ['-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`]);
  assert.equal(out, null);
  assert.ok(Date.now() - started < 1_200, `took ${Date.now() - started} ms`);
  await sleep(2_500);
  assert.equal(existsSync(marker), false, '逾時後子行程必須已被結束');
});
await test('agy 版本探測：非零退出回 null', async () => {
  assert.equal(await agy.probeAgyVersion(process.execPath, 10_000, ['-e', 'console.log("1.5.13");process.exit(3)']), null);
});

// ── 3. resolveSpawnMode（core 讀取的入口）────────────────────
await test('resolveSpawnMode 在 win32 採用 agent 的版本判斷', async () => {
  const def = { win32SpawnMode: 'pty', resolveWin32SpawnMode: async () => 'pipe' };
  assert.equal(await resolveSpawnMode(def, 'x', 'win32'), 'pipe');
});
await test('resolveSpawnMode 版本判斷拋例外時退回靜態 win32SpawnMode', async () => {
  const def = { win32SpawnMode: 'pty', resolveWin32SpawnMode: async () => { throw new Error('boom'); } };
  assert.equal(await resolveSpawnMode(def, 'x', 'win32'), 'pty');
});
await test('resolveSpawnMode 非 win32 不呼叫版本判斷', async () => {
  let called = false;
  const def = { win32SpawnMode: 'pty', resolveWin32SpawnMode: async () => { called = true; return 'pty'; } };
  assert.equal(await resolveSpawnMode(def, 'x', 'linux'), 'pipe');
  assert.equal(await resolveSpawnMode({ ...def, spawnMode: 'direct' }, 'x', 'darwin'), 'direct');
  assert.equal(called, false);
});
await test('antigravity 定義：保守退路是 pty、有版本判斷、管線不經 cmd.exe', () => {
  const def = getAgent('antigravity');
  assert.equal(def.win32SpawnMode, 'pty');
  assert.equal(typeof def.resolveWin32SpawnMode, 'function');
  assert.equal(def.win32DirectExec, true);
});

// ── 4. 長 prompt 改走檔案 ─────────────────────────────────────
// 4 萬個全形字：UTF-16 4 萬單位（> Windows 門檻）、UTF-8 12 萬 bytes（> POSIX 門檻）。
const LONG_PROMPT = '長 prompt 測試「引號"與反斜線\\」\n' + '測'.repeat(40_000) + '\nEND-OF-PROMPT';
const AGY_EXE = join(TEMP, 'agy.exe');
const builtFor = (extra) => buildCliCommand({ workFolder: ROOT, model: 'agy-default', cliPaths: { antigravity: AGY_EXE }, ...extra });
const cleanupBuilt = (cmd) => { if (cmd.temporaryPromptDir) rmSync(cmd.temporaryPromptDir, { recursive: true, force: true }); };
function assertPromptFileCommand(cmd, expected, label) {
  try {
    assert.ok(cmd.temporaryPromptDir, `${label}: 必須建立私有 prompt 目錄`);
    assert.equal(dirname(cmd.temporaryPromptDir), agy.agyPromptRoot(), `${label}: 目錄在 state 底下的 agy-prompts`);
    assert.ok(agy.agyPromptRoot().startsWith(process.env.AI_CLI_STATE_DIR), `${label}: 不用共用的 tmp`);
    const addDir = cmd.args.indexOf('--add-dir');
    assert.equal(cmd.args[addDir + 1], cmd.temporaryPromptDir, `${label}: --add-dir 指向私有目錄`);
    const p = cmd.args[cmd.args.indexOf('-p') + 1];
    const file = join(cmd.temporaryPromptDir, agy.AGY_PROMPT_FILE_NAME);
    assert.equal(p, withWorkerContext(agy.agyPromptFileInstruction(file)), `${label}: -p 只剩身分鎖＋指示`);
    assert.equal(readFileSync(file, 'utf8'), expected, `${label}: 檔案逐字等於原 prompt`);
    assert.ok(cmd.args.every(a => !a.includes('測測測測測測測測')), `${label}: argv 不可再含原文`);
    assert.ok(agy.estimateWin32CommandLine(cmd.cliPath, cmd.args) < agy.AGY_WIN32_COMMAND_LINE_LIMIT, `${label}: 命令列回到門檻內`);
    assert.ok(!ROOT.startsWith(cmd.temporaryPromptDir) && !cmd.temporaryPromptDir.startsWith(ROOT), `${label}: 不可寫進 workFolder`);
  } finally { cleanupBuilt(cmd); }
}
await test('agy 長 prompt 超過門檻時 argv 只含短指示＋--add-dir，檔案逐字等於原 prompt', () => {
  assertPromptFileCommand(builtFor({ prompt: LONG_PROMPT }), LONG_PROMPT, 'prompt');
});
await test('agy 長 prompt 經 prompt_file 也走同一條', () => {
  const file = join(TEMP, 'long-prompt.txt');
  writeFileSync(file, LONG_PROMPT);
  assertPromptFileCommand(builtFor({ prompt_file: file }), LONG_PROMPT, 'prompt_file');
});
await test('agy 長 prompt 嚴格模式也走同一條', () => {
  const cmd = builtFor({ prompt: LONG_PROMPT, capabilities: ['fs/read'] });
  assert.ok(cmd.args.includes('--sandbox'));
  assertPromptFileCommand(cmd, LONG_PROMPT, 'strict');
});
await test('agy 短 prompt 行為不變（-p 帶原文、沒有 --add-dir）', () => {
  const cmd = builtFor({ prompt: '短的 prompt "q"', session_id: 'sess-1' });
  assert.equal(cmd.temporaryPromptDir, undefined);
  assert.ok(!cmd.args.includes('--add-dir'));
  assert.deepEqual(cmd.args.slice(-2), ['-p', withWorkerContext('短的 prompt "q"')]);
  assert.equal(cmd.args[cmd.args.indexOf('--conversation') + 1], 'sess-1');
});
await test('agy 命令列估計把引號與反斜線算兩倍、門檻依平台', () => {
  assert.equal(agy.estimateWin32CommandLine('C:\\a.exe', ['ab']), 8 + 3 + 2 + 3); // exe 路徑本身不跳脫
  assert.equal(agy.estimateWin32CommandLine('x', ['"\\']), 1 + 3 + 2 + 3 + 2);
  const near = 'a'.repeat(agy.AGY_WIN32_COMMAND_LINE_LIMIT);
  assert.equal(agy.agyPromptNeedsFile('x', ['-p', near], 'win32'), true);
  assert.equal(agy.agyPromptNeedsFile('x', ['-p', 'a'.repeat(20_000)], 'win32'), false);
  assert.equal(agy.agyPromptNeedsFile('x', ['-p', '測'.repeat(30_000)], 'linux'), false, '9 萬 bytes 低於 POSIX 門檻');
  assert.equal(agy.agyPromptNeedsFile('x', ['-p', '測'.repeat(40_000)], 'linux'), true);
});
const makePromptDir = (ageMs) => {
  const dir = join(agy.agyPromptRoot(), `agy-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, agy.AGY_PROMPT_FILE_NAME), 'x');
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
  return dir;
};
await test('agy prompt 目錄 TTL 清理：過期的刪、新的留、symlink 與無關名稱跳過', async () => {
  const old = makePromptDir(agy.AGY_PROMPT_TTL_MS + 60_000), fresh = makePromptDir(1_000);
  const other = join(agy.agyPromptRoot(), 'not-a-prompt-dir'); mkdirSync(other, { recursive: true });
  const outside = join(TEMP, 'outside-target'); mkdirSync(outside, { recursive: true }); writeFileSync(join(outside, 'keep.txt'), 'keep');
  const link = join(agy.agyPromptRoot(), `agy-${randomUUID()}`);
  let linked = false;
  try { symlinkSync(outside, link, 'junction'); linked = true; } catch { /* 無權建立連結：只略過這一段 */ }
  if (linked) { const when = new Date(Date.now() - agy.AGY_PROMPT_TTL_MS * 2); try { utimesSync(link, when, when); } catch {} }
  await agy.collectAgyPromptDirs();
  assert.equal(existsSync(old), false, '過期的要刪');
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(other), true);
  assert.equal(existsSync(join(outside, 'keep.txt')), true, 'symlink 指向的內容不可被刪');
  if (linked) rmSync(link, { force: true, recursive: false });
  rmSync(fresh, { recursive: true, force: true });
});
// 寫 owner.json 會更新目錄 mtime：寫完再把時間調回去。
const writeOwner = (dir, owner) => { writeFileSync(join(dir, PROMPT_OWNER_FILE), JSON.stringify(owner)); const when = new Date(Date.now() - agy.AGY_PROMPT_TTL_MS - 60_000); utimesSync(dir, when, when); };
await test('agy prompt 目錄 TTL 清理只回收擁有者已確認不在的', async () => {
  const OLD = agy.AGY_PROMPT_TTL_MS + 60_000;
  const self = (await lookupIdentities([process.pid])).get(process.pid);
  const live = makePromptDir(OLD); writeOwner(live, { pid: process.pid, started: self?.started });
  const noStarted = makePromptDir(OLD); writeOwner(noStarted, { pid: process.pid });
  const dead = makePromptDir(OLD); writeOwner(dead, { pid: 4_000_000_000 % 2_147_483_647, started: 'x' });
  const reused = makePromptDir(OLD); writeOwner(reused, { pid: process.pid, started: 'not-the-same-process' });
  const unknown = makePromptDir(OLD); writeOwner(unknown, { pid: 424242, started: 's' });
  const failing = async (pids) => { if (pids.includes(424242)) throw new Error('lookup failed'); return lookupIdentities(pids); };
  await agy.collectAgyPromptDirs(Date.now(), failing, (pid) => pid === 424242 || pid === process.pid);
  assert.ok(self?.started, '本行程身分要查得到');
  assert.equal(existsSync(live), true, '擁有者還在：即使過了 TTL 也保留');
  assert.equal(existsSync(noStarted), true, '只有 PID、行程還在：無法確認身分就保留');
  assert.equal(existsSync(dead), false, '擁有者已不在：回收');
  assert.equal(existsSync(reused), false, 'PID 被別的行程重用：回收');
  assert.equal(existsSync(unknown), true, '身分查詢失敗：保留');
  for (const dir of [live, noStarted, unknown]) rmSync(dir, { recursive: true, force: true });
  assert.equal(await promptOwnerGone(undefined), true, '沒有標記（舊格式）視為不在');
});
await test('agy prompt 目錄交給 vendor 後擁有者改成子行程、錯誤路徑不再刪', async () => {
  const cmd = builtFor({ prompt: LONG_PROMPT });
  const dir = cmd.temporaryPromptDir;
  try {
    assert.equal(readPromptOwner(dir)?.pid, process.pid, '交出去之前擁有者是派工行程');
    handOffTemporaryPrompt(cmd, process.ppid);
    assert.equal(cmd.temporaryPromptDir, undefined);
    assert.equal(readPromptOwner(dir)?.pid, process.ppid);
    discardTemporaryPrompt(cmd);
    assert.equal(existsSync(join(dir, agy.AGY_PROMPT_FILE_NAME)), true, '移交後的錯誤路徑不可刪 vendor 要讀的檔');
    for (let i = 0; i < 50 && !readPromptOwner(dir)?.started; i++) await sleep(100);
    assert.ok(readPromptOwner(dir)?.started, '非同步補上 OS 建立時間');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const lockedRename = (code, times) => { let n = 0; return (from, to) => { if (n++ < times) { const e = new Error(code); e.code = code; throw e; } return renameSyncReal(from, to); }; };
const backdate = (dir) => { const when = new Date(Date.now() - agy.AGY_PROMPT_TTL_MS - 60_000); utimesSync(dir, when, when); };
await test('agy prompt 目錄刪不掉時先撤銷擁有者，殘骸過了 TTL 就能回收', async () => {
  const failRemove = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
  // discard 路徑
  const discarded = makePromptDir(0);
  claimPromptOwner(discarded, process.pid);
  discardTemporaryPrompt({ temporaryPromptDir: discarded }, failRemove);
  assert.equal(existsSync(discarded), true, '刪除失敗：目錄還在');
  assert.equal(existsSync(join(discarded, PROMPT_OWNER_FILE)), false, 'discard 刪目錄之前要先撤銷擁有者');
  // 搬移改走複製的路徑
  const source = makePromptDir(0), target = join(TEMP, 'revoked-' + randomUUID());
  claimPromptOwner(source, process.pid);
  movePromptDirectory(source, target, lockedRename('EXDEV', 1), undefined, failRemove);
  assert.equal(existsSync(join(target, agy.AGY_PROMPT_FILE_NAME)), true);
  assert.equal(existsSync(join(source, PROMPT_OWNER_FILE)), false, '搬移複製後刪來源之前要先撤銷擁有者');
  backdate(discarded); backdate(source);
  await agy.collectAgyPromptDirs();
  assert.equal(existsSync(discarded), false, '撤銷後的殘骸過了 TTL 回收（擁有者本行程仍活著）');
  assert.equal(existsSync(source), false);
});
await test('agy 擁有者移交被鎖時短重試並讀回確認', async () => {
  const dir = makePromptDir(0);
  const claim = claimPromptOwner(dir, process.ppid, undefined, lockedRename('EBUSY', 2));
  assert.equal(claim.confirmed, true);
  assert.equal(readPromptOwner(dir)?.pid, process.ppid);
  assert.equal(existsSync(join(dir, PROMPT_OWNER_PENDING_FILE)), false);
  await claim.done; rmSync(dir, { recursive: true, force: true });
});
await test('agy 擁有者移交一直寫不進時保守保留，移交對象結束後才回收', async () => {
  const dir = makePromptDir(0);
  claimPromptOwner(dir, 111111);                                       // 派工行程（之後會結束）
  const claim = claimPromptOwner(dir, 222222, undefined, lockedRename('EPERM', 99)); // vendor
  assert.equal(claim.confirmed, false);
  assert.equal(readPromptOwner(dir)?.pid, 111111, 'owner.json 沒換成功');
  assert.equal(JSON.parse(readFileSync(join(dir, PROMPT_OWNER_PENDING_FILE), 'utf8')).pid, 222222, '移交對象記在 pending');
  backdate(dir);
  await agy.collectAgyPromptDirs(Date.now(), async () => new Map(), (pid) => pid === 222222);
  assert.equal(existsSync(dir), true, '派工行程已不在、但移交未確認的 vendor 還在：保留');
  await agy.collectAgyPromptDirs(Date.now(), async () => new Map(), () => false);
  assert.equal(existsSync(dir), false, '兩個擁有者都不在：回收');
});
await test('agy 只有 PID 的擁有者：行程建立時間晚於宣告時間就判定 PID 已被重用', async () => {
  const self = (await lookupIdentities([process.pid])).get(process.pid);
  const iso = process.platform === 'win32';
  assert.ok(self?.started, '查得到本行程身分');
  if (iso) {
    // Windows 的 CreationDate 是 ISO 8601，可比較。
    const born = Date.parse(self.started);
    assert.equal(await promptOwnerGone({ pid: process.pid, claimedAt: born - 60_000 }), true, '宣告早於這個行程誕生：不是原擁有者');
    assert.equal(await promptOwnerGone({ pid: process.pid, claimedAt: born + 60_000 }), false, '宣告晚於誕生：是原擁有者');
  } else {
    // macOS／Linux 的 started 不是 ISO：換算不可靠，一律保留。
    assert.equal(await promptOwnerGone({ pid: process.pid, claimedAt: 0 }), false, '非 ISO 平台：保留');
  }
  const unparseable = async (pids) => new Map(pids.map(pid => [pid, { pid, started: 'boot-id:12345', name: 'x' }]));
  assert.equal(await promptOwnerGone({ pid: process.pid, claimedAt: 0 }, unparseable), false, '建立時間換算不了：保留');
  assert.equal(await promptOwnerGone({ pid: process.pid }), false, '沒有宣告時間的舊標記：保留');
});
await test('agy 警告截斷保留結尾，續接失敗仍認得出來', () => {
  const longId = 'x'.repeat(3000);
  const resume = `warning: conversation "${longId}" not found`;
  const cut = truncateWarning(resume);
  assert.ok(cut.length <= WARNING_MAX_CHARS, String(cut.length));
  assert.ok(cut.endsWith('" not found') && cut.includes('…'), cut.slice(-40));
  assert.equal(agy.isAgyResumeWarning(cut), true);
  const stderr = [...Array.from({ length: 30 }, (_, i) => `warning: noise ${i}`), resume].join('\n');
  const parsed = getAgent('antigravity').parseOutput(JSON.stringify({ response: 'ok' }), stderr);
  assert.ok(parsed.warnings[0].endsWith('" not found'), 'parseOutput 端：' + parsed.warnings[0].slice(-40));
  assert.ok(parsed.warnings[0].length <= WARNING_MAX_CHARS);
});
await test('agy 建立長 prompt 時順手清掉過期目錄（沒有 JobStore 的機器）', async () => {
  const stale = makePromptDir(agy.AGY_PROMPT_TTL_MS + 60_000);
  const cmd = builtFor({ prompt: LONG_PROMPT });
  try {
    for (let i = 0; i < 100 && existsSync(stale); i++) await sleep(100);
    assert.equal(existsSync(stale), false, '建立時觸發的清理已回收過期且無擁有者的目錄');
    assert.equal(existsSync(cmd.temporaryPromptDir), true, '剛建立的不受影響');
  } finally { cleanupBuilt(cmd); }
});
await test('agy 相對 AI_CLI_STATE_DIR 也建立絕對路徑的 prompt 目錄', () => {
  const savedState = process.env.AI_CLI_STATE_DIR, savedCwd = process.cwd();
  process.chdir(TEMP); process.env.AI_CLI_STATE_DIR = 'rel-state';
  let cmd;
  try { cmd = builtFor({ prompt: LONG_PROMPT }); }
  finally { process.chdir(savedCwd); process.env.AI_CLI_STATE_DIR = savedState; }
  try {
    assert.ok(isAbsolute(cmd.temporaryPromptDir), cmd.temporaryPromptDir);
    assert.ok(cmd.temporaryPromptDir.startsWith(resolvePath(TEMP, 'rel-state')), '以建立當下的 cwd 解析');
    assert.equal(cmd.args[cmd.args.indexOf('--add-dir') + 1], cmd.temporaryPromptDir);
    assert.equal(readFileSync(join(cmd.temporaryPromptDir, agy.AGY_PROMPT_FILE_NAME), 'utf8'), LONG_PROMPT, '換回原 cwd 後仍讀得到');
  } finally { cleanupBuilt(cmd); }
});
await test('agy prompt 目錄 TTL 清理掛在 store 回收裡', async () => {
  const dir = makePromptDir(1_000);
  await collectStoreFiles(join(TEMP, 'empty-store'), Date.now() + agy.AGY_PROMPT_TTL_MS + 60_000, async () => new Map());
  assert.equal(existsSync(dir), false);
});
await test('agy prompt 目錄搬移：被鎖時短重試、持續被鎖改複製、跨磁碟改複製', () => {
  const fail = (code, times) => { let n = 0; return (from, to) => { if (n++ < times) { const e = new Error(code); e.code = code; throw e; } return renameSyncReal(from, to); }; };
  for (const [label, rename] of [['EBUSY 兩次後成功', fail('EBUSY', 2)], ['EPERM 一直失敗', fail('EPERM', 99)], ['EXDEV', fail('EXDEV', 99)]]) {
    const source = makePromptDir(0), target = join(TEMP, 'moved-' + randomUUID());
    movePromptDirectory(source, target, rename);
    assert.equal(readFileSync(join(target, agy.AGY_PROMPT_FILE_NAME), 'utf8'), 'x', label);
    assert.equal(existsSync(source), false, `${label}: 原目錄已不存在`);
  }
  assert.throws(() => movePromptDirectory(makePromptDir(0), join(TEMP, 'x'), fail('ENOENT', 1)), /ENOENT/);
});
await test('agy prompt 目錄跨磁碟複製失敗不留部分副本', () => {
  const parent = join(TEMP, 'partial-' + randomUUID()); mkdirSync(parent);
  const source = makePromptDir(0), target = join(parent, 'prompt-dir');
  const exdev = () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; };
  const brokenCopy = (from, to) => { mkdirSync(to); writeFileSync(join(to, 'half'), 'x'); throw new Error('disk full'); };
  assert.throws(() => movePromptDirectory(source, target, exdev, brokenCopy), /disk full/);
  assert.deepEqual(readdirSync(parent), [], '目標與暫存副本都不可留下');
  assert.equal(existsSync(join(source, agy.AGY_PROMPT_FILE_NAME)), true, '來源保留給呼叫端清理');
  rmSync(source, { recursive: true, force: true });
});
await test('已結束 job 容量計入 prompt-dir 內的檔案', () => {
  const job = join(TEMP, 'size-job'); mkdirSync(join(job, 'prompt-dir'), { recursive: true });
  writeFileSync(join(job, 'stdout.log'), 'a'.repeat(100));
  writeFileSync(join(job, 'prompt-dir', agy.AGY_PROMPT_FILE_NAME), 'b'.repeat(5000));
  assert.equal(directorySize(job), 5100);
});
await test('agy 啟動前失敗（熔斷器）清掉私有 prompt 目錄', async () => {
  const { FileProcessService } = await load('core/file-process-service.js');
  const def = getAgent('antigravity'), original = def.buildCommand; let built;
  def.buildCommand = (input) => (built = original(input));
  try {
    const service = new FileProcessService({ stateDir: join(TEMP, 'breaker-state'), cliPaths: { antigravity: AGY_EXE },
      breaker: { check() { throw new Error('breaker tripped'); } } });
    try { await assert.rejects(service.startProcess({ model: 'agy-default', cwd: ROOT, prompt: LONG_PROMPT }), /breaker tripped/); }
    finally { service.dispose(); }
    assert.ok(built?.temporaryPromptDir);
    assert.equal(existsSync(built.temporaryPromptDir), false);
  } finally { def.buildCommand = original; }
});

// ── 5. 警告 ───────────────────────────────────────────────────
const HARMLESS = 'warning: --mode plan has no effect while slash command expansion is disabled.';
await test('agy durableWarning 只收 warning: 行', () => {
  assert.equal(agy.agyDurableWarning('warning: conversation "x" not found\r\n'), 'warning: conversation "x" not found');
  assert.equal(agy.agyDurableWarning('TTY=false\n'), null);
  assert.equal(agy.agyDurableWarning('本文裡提到 warning: 不算\n'), null);
});
await test('agy 嚴格模式固定出現的 --mode plan 警告不算警告', () => {
  assert.equal(agy.agyDurableWarning(HARMLESS + '\n'), null);
  const parsed = getAgent('antigravity').parseOutput(HARMLESS + '\n' + JSON.stringify({ response: 'ok', conversation_id: 'c' }) + '\n', HARMLESS + '\n');
  assert.equal(parsed.warnings, undefined, JSON.stringify(parsed));
});
await test('agy parseOutput 也掃 stderr 的 warning（有上限）', () => {
  const stderr = ['warning: conversation "x" not found', HARMLESS, 'noise',
    ...Array.from({ length: 30 }, (_, i) => `warning: w${i} ` + 'z'.repeat(i === 0 ? 1500 : 0))].join('\n');
  const parsed = getAgent('antigravity').parseOutput(JSON.stringify({ response: 'ok', conversation_id: 'c' }), stderr);
  assert.equal(parsed.warnings[0], 'warning: conversation "x" not found');
  assert.equal(parsed.warnings.length, agy.AGY_WARNING_MAX_COUNT);
  assert.equal(parsed.warnings[1].length, agy.AGY_WARNING_MAX_CHARS);
  assert.deepEqual(getAgent('antigravity').parseOutput('', 'warning: only\n'), { warnings: ['warning: only'] });
});
await test('agy stdout 只有嚴格模式那行時不當成回覆', () => {
  assert.equal(getAgent('antigravity').parseOutput(HARMLESS + '\n', 'fatal: vendor exploded\n'), null);
  assert.deepEqual(getAgent('antigravity').parseOutput(HARMLESS + '\r\n', 'warning: w\nfatal: x\n'), { warnings: ['warning: w'] });
  const r = buildProcessResult({ pid: 1, agent: 'antigravity', status: 'failed', exitCode: 1, stdout: HARMLESS, stderr: 'fatal: vendor exploded' },
    getAgent('antigravity').parseOutput(HARMLESS, 'fatal: vendor exploded'), false);
  assert.equal(r.stderr, 'fatal: vendor exploded', JSON.stringify(r));
  assert.equal(r.agentOutput, undefined);
});
await test('agy 續接失敗警告不會被上限擠掉', () => {
  const stderr = [...Array.from({ length: 30 }, (_, i) => `warning: noise ${i}`), 'warning: conversation "late" not found'].join('\n');
  const parsed = getAgent('antigravity').parseOutput(JSON.stringify({ response: 'ok' }), stderr);
  assert.equal(parsed.warnings.length, agy.AGY_WARNING_MAX_COUNT);
  assert.equal(parsed.warnings[0], 'warning: conversation "late" not found');
});
await test('只有 warnings 的 raw 退路保留 agentOutput.session_id', () => {
  const r = buildProcessResult({ pid: 1, agent: 'claude', status: 'failed', exitCode: 1, stdout: 'x', stderr: 'boom' },
    { session_id: 's-1', usage: { input_tokens: 1, output_tokens: 2 }, warnings: ['warning: w'] }, false);
  assert.equal(r.stderr, 'boom');
  assert.deepEqual(r.agentOutput, { session_id: 's-1', usage: { input_tokens: 1, output_tokens: 2 }, warnings: ['warning: w'] });
  assert.equal(r.session_id, 's-1');
});
await test('只有 warnings 的結果照回 raw 輸出並附 agentOutput.warnings', () => {
  const r = buildProcessResult({ pid: 1, agent: 'antigravity', status: 'failed', exitCode: 1, stdout: '', stderr: 'fatal: boom\nwarning: w' },
    { warnings: ['warning: w'] }, false);
  assert.equal(r.stderr, 'fatal: boom\nwarning: w', JSON.stringify(r));
  assert.deepEqual(r.agentOutput, { warnings: ['warning: w'] });
});

// ── 6. peek／liveness ────────────────────────────────────────
const bigEnvelope = JSON.stringify({ conversation_id: 'c', response: '致 User\n---\n' + '字'.repeat(5000) + '\n---', usage: {} });
await test('agy peek 對單行 JSON 只取 response 並限長', () => {
  const text = agyPeekText(bigEnvelope);
  assert.ok(text.startsWith('致 User'), text.slice(0, 20));
  assert.ok(!text.includes('conversation_id'));
  assert.ok(text.length <= AGY_PEEK_TEXT_MAX_LENGTH + 40, String(text.length));
  assert.match(text, /…\[truncated: \d+ chars\]$/);
  assert.equal(agyPeekText('一般文字行'), '一般文字行');
  assert.equal(agyPeekText('{不是 JSON'), '{不是 JSON');
});
await test('agy PeekEventExtractor／LivenessEventExtractor 接線只看到 response', () => {
  const half = Math.floor(bigEnvelope.length / 2);
  const peek = new PeekEventExtractor('antigravity');
  const events = [...peek.push(bigEnvelope.slice(0, half)), ...peek.push(bigEnvelope.slice(half) + '\n'), ...peek.flush()];
  assert.equal(events.length, 1, JSON.stringify(events).slice(0, 200));
  assert.ok(events[0].text.startsWith('致 User') && events[0].text.length <= AGY_PEEK_TEXT_MAX_LENGTH + 40);
  const live = new LivenessEventExtractor('antigravity');
  const summaries = [...live.push(Buffer.from(bigEnvelope + '\n')), ...live.flush()];
  assert.equal(summaries.length, 1);
  assert.ok(summaries[0].startsWith('致 User') && !summaries[0].includes('conversation_id'), summaries[0]);
});

// ── 7. 長的單行 JSON＋win32 端到端 ─────────────────────────────
const BODY = Array.from({ length: 60 }, (_, i) => `第${i}段：全形字測試，ＡＢＣ　function_call_${i}() 檢查換行不會切斷。`).join('\n');
const USAGE = { input_tokens: 1234, output_tokens: 5678, thinking_tokens: 90 };
await test('長的單行 JSON（超過 200 欄、含全形字）解析得出 message／session_id／usage', () => {
  const line = JSON.stringify({ conversation_id: 'pipe-session-0001', status: 'SUCCESS', response: `致 User\n---\n${BODY}\n---\n`, usage: USAGE });
  assert.ok(line.length > 2000 && !line.includes('\n'));
  const parsed = getAgent('antigravity').parseOutput(line + '\n', '');
  assert.equal(parsed.session_id, 'pipe-session-0001');
  assert.equal(parsed.message, BODY);
  assert.equal(parsed.usage.input_tokens, 1234);
});

if (process.platform === 'win32') {
  const { FileProcessService } = await load('core/file-process-service.js');
  const { ProcessService } = await load('core/process-service.js');
  const { JobStore, jobResult, mayBeAlive } = await load('core/job-store.js');
  const state = join(TEMP, 'state');
  const stub = join(TEMP, 'agy-stub.mjs');
  // stub 收到的就是正式 builder 的 argv（只在最前面插入 stub 路徑）。回覆本文帶 TTY／ARGV／FILE；
  // 有 --conversation 時在 **stderr** 印續接失敗警告（2026-11-20 實測 agy 1.5.13 的位置）。
  // prompt 帶 MANY_WARNINGS → stderr 印 25 筆警告（第一筆 1,500 字）；帶 NO_JSON → 只有 stderr、exit 1。
  writeFileSync(stub, `import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
const dir = at('--add-dir');
const promptFile = dir ? readFileSync(dir + '\\\\' + ${JSON.stringify(agy.AGY_PROMPT_FILE_NAME)}, 'utf8') : undefined;
const p = at('-p') ?? '';
if (p.includes('MANY_WARNINGS')) for (let i = 0; i < 25; i++) process.stderr.write('warning: w' + i + ' ' + (i === 0 ? 'z'.repeat(1500) : '') + '\\n');
if (at('--conversation')) process.stderr.write('warning: conversation "' + at('--conversation') + '" not found\\n');
if (p.includes('NO_JSON')) { process.stderr.write('warning: about to fail\\nfatal: vendor exploded\\n'); process.exit(1); }
process.stderr.write(${JSON.stringify(JSON.stringify({ response: 'stderr json must not win', conversation_id: 'stderr-session' }))} + '\\n');
const body = 'TTY=' + (process.stdout.isTTY === true) + '\\nARGV=' + JSON.stringify(argv) + '\\nFILE=' + (promptFile === undefined ? 'none' : JSON.stringify(promptFile)) + '\\n' + ${JSON.stringify(BODY)};
process.stdout.write(JSON.stringify({ conversation_id: 'pipe-session-0001', status: 'SUCCESS', response: '致 User\\n---\\n' + body + '\\n---\\n',
  num_turns: 1, usage: ${JSON.stringify(USAGE)} }) + '\\n');
`);
  const def = getAgent('antigravity');
  const original = { buildCommand: def.buildCommand, resolve: def.resolveWin32SpawnMode };
  let lastBuilt;
  def.buildCommand = (input) => {
    const cmd = lastBuilt = original.buildCommand(input);
    return { ...cmd, cliPath: process.execPath, args: [stub, ...cmd.args] };
  };
  const until = async (fn, timeout = 30_000) => {
    const end = Date.now() + timeout;
    while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await sleep(100); }
  };
  const decode = (result) => {
    const message = result.agentOutput?.message ?? '';
    const argv = JSON.parse(/^ARGV=(.*)$/m.exec(message)?.[1] ?? 'null');
    const file = /^FILE=(.*)$/m.exec(message)?.[1];
    return { message, argv, tty: /^TTY=(.*)$/m.exec(message)?.[1], file: file === 'none' || file === undefined ? undefined : JSON.parse(file) };
  };
  const runWith = async (version, options) => {
    def.resolveWin32SpawnMode = agy.createAgySpawnModeResolver({ probe: async () => version });
    const service = new FileProcessService({ stateDir: state, cliPaths: { antigravity: AGY_EXE }, breaker: { check() {} } });
    try {
      const start = await service.startProcess({ model: 'agy-default', cwd: ROOT, ...options });
      assert.ok(start.jobId, 'win32 agy 必須進 JobStore（可接回）：' + JSON.stringify(start));
      const dir = join(state, 'jobs', start.jobId);
      await until(() => existsSync(join(dir, 'exit.json')));
      await until(() => !mayBeAlive(start.pid), 10_000);
      const exit = JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8'));
      const stdout = readFileSync(join(dir, 'stdout.log'), 'utf8');
      const store = new JobStore(state, 'cli', true); await store.ready;
      let result;
      try { result = jobResult(store.get(start.pid), false); } finally { store.dispose(); }
      return { dir, exit, stdout, result, ...decode(result) };
    } finally { service.dispose(); }
  };
  const assertDefaultResult = (r, label) => {
    assert.equal(r.exit.exitCode, 0, `${label}: ${JSON.stringify(r.exit)}`);
    assert.ok(r.message.endsWith(BODY), `${label}: 預設結果的 message 完整`);
    assert.equal(r.result.session_id, 'pipe-session-0001', `${label}: 預設結果的 session_id（stderr 的 JSON 不可蓋掉）`);
    assert.equal(r.result.agentOutput?.usage?.input_tokens, 1234, `${label}: 預設結果的 usage`);
    assert.equal(r.result.agentOutput?.usage?.output_tokens, 5678, `${label}: 預設結果的 usage`);
  };
  try {
    await test('win32 agy 新版經 runner 走管線：stdout 非 TTY、正式 argv、預設結果完整', async () => {
      const prompt = '短的 prompt：含 "引號" 與 %PATH% & | 符號';
      const r = await runWith('1.5.13', { prompt });
      assert.equal(r.tty, 'false', 'pipe 模式 stdout 不可是 TTY');
      assert.deepEqual(r.argv.slice(-2), ['-p', withWorkerContext(prompt)], '-p 逐字等於正式 builder 的 prompt');
      assert.ok(r.argv.includes('--output-format') && r.argv.includes('--dangerously-skip-permissions'));
      assert.equal(r.file, undefined);
      assert.equal(r.result.agentOutput?.warnings, undefined, 'stderr 的非 warning 行不算警告');
      assertDefaultResult(r, 'pipe');
    });
    await test('win32 agy MCP run（ProcessService）新版也走管線並可接回', async () => {
      def.resolveWin32SpawnMode = agy.createAgySpawnModeResolver({ probe: async () => '1.5.13' });
      const service = new ProcessService({ cliPaths: { antigravity: AGY_EXE } });
      try {
        const start = await service.startProcess({ workFolder: ROOT, model: 'agy-default', prompt: 'mcp route' });
        assert.ok(start.jobId, JSON.stringify(start));
        const [result] = await service.waitForProcesses([start.pid], 60, false);
        assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 400));
        const d = decode(result);
        assert.equal(d.tty, 'false');
        assert.deepEqual(d.argv.slice(-2), ['-p', withWorkerContext('mcp route')]);
        assert.equal(result.session_id, 'pipe-session-0001');
      } finally { service.dispose(); }
    });
    await test('win32 agy 續接失敗警告出現在預設結果', async () => {
      const r = await runWith('1.5.13', { prompt: 'resume', session_id: 'stale-session-42' });
      assert.equal(r.argv[r.argv.indexOf('--conversation') + 1], 'stale-session-42', '--conversation 帶續接 ID');
      assert.deepEqual(r.result.agentOutput?.warnings, ['warning: conversation "stale-session-42" not found'], JSON.stringify(r.result.agentOutput));
      assertDefaultResult(r, 'resume');
    });
    await test('win32 agy stderr 警告有上限（20 筆、每筆 1,000 字）', async () => {
      const longId = 'late-resume-' + 'y'.repeat(1500);
      const r = await runWith('1.5.13', { prompt: 'MANY_WARNINGS', session_id: longId });
      const warnings = r.result.agentOutput?.warnings ?? [];
      assert.equal(warnings.length, 20);
      assert.ok(warnings[0].startsWith('warning: conversation "late-resume-') && warnings[0].endsWith('" not found'), '續接失敗在 25 筆雜訊之後仍保留（超長 id 截斷後仍認得出）：' + warnings[0].slice(-40));
      assert.ok(warnings[0].length <= 1000);
      assert.ok(warnings.some(w => w.length === 1000), '每筆 1,000 字上限');
      assertDefaultResult(r, 'many');
    });
    await test('win32 agy 只有警告沒有 JSON、exit 1 時 raw stderr 仍回報', async () => {
      const r = await runWith('1.5.13', { prompt: 'NO_JSON' });
      assert.equal(r.exit.exitCode, 1);
      assert.match(r.result.stderr ?? '', /fatal: vendor exploded/, JSON.stringify(r.result).slice(0, 400));
      assert.deepEqual(r.result.agentOutput?.warnings, ['warning: about to fail']);
    });
    await test('win32 agy 長 prompt 經 runner：--add-dir 指向 job 目錄、檔案逐字等於原 prompt', async () => {
      const r = await runWith('1.5.13', { prompt: LONG_PROMPT, session_id: 'long-resume-7' });
      const shared = join(r.dir, 'prompt-dir');
      assert.equal(r.argv[r.argv.indexOf('--add-dir') + 1], shared, '--add-dir 已改指 job 目錄內的副本');
      const p = r.argv[r.argv.indexOf('-p') + 1];
      assert.equal(p, withWorkerContext(agy.agyPromptFileInstruction(join(shared, agy.AGY_PROMPT_FILE_NAME))));
      assert.equal(r.file, LONG_PROMPT, 'agent 執行時讀到的檔案逐字等於原 prompt');
      assert.ok(p.startsWith(WORKER_CONTEXT));
      assert.equal(existsSync(lastBuilt.temporaryPromptDir), false, '搬移後原目錄已不存在');
      assert.equal(r.argv[r.argv.indexOf('--conversation') + 1], 'long-resume-7', '長 prompt＋續接組合');
      assert.deepEqual(r.result.agentOutput?.warnings, ['warning: conversation "long-resume-7" not found']);
      assertDefaultResult(r, 'long');
    });
    await test('win32 agy 舊版經 runner 仍走 ConPTY', async () => {
      const r = await runWith('1.5.12', { prompt: 'old', session_id: 'pty-resume-9' });
      assert.equal(r.exit.exitCode, 0, JSON.stringify(r.exit));
      assert.ok(r.stdout.includes('TTY=true'), '舊版必須保留 ConPTY：' + r.stdout.slice(0, 80));
      // ConPTY 把 stderr 併進 stdout：續接警告要從 stdout 的非 JSON 行收。
      assert.deepEqual(r.result.agentOutput?.warnings, ['warning: conversation "pty-resume-9" not found'], JSON.stringify(r.result.agentOutput ?? r.result).slice(0, 300));
    });
  } finally {
    def.buildCommand = original.buildCommand;
    def.resolveWin32SpawnMode = original.resolve;
  }
  await test('非 agy agent 的 stderr warning 不收進 warnings', async () => {
    const claude = getAgent('claude'), saved = claude.buildCommand;
    const stub2 = join(TEMP, 'claude-stub.mjs');
    writeFileSync(stub2, `process.stderr.write('warning: claude-side diagnostic\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude ok', session_id: 'c-1' }) + '\\n');`);
    claude.buildCommand = (input) => ({ cliPath: process.execPath, args: [stub2], cwd: input.cwd, agent: 'claude', prompt: input.prompt, resolvedModel: input.resolvedModel });
    const service = new FileProcessService({ stateDir: state, cliPaths: { claude: process.execPath }, breaker: { check() {} } });
    try {
      const start = await service.startProcess({ model: 'sonnet', cwd: ROOT, prompt: 'x' });
      const dir = join(state, 'jobs', start.jobId);
      await until(() => existsSync(join(dir, 'exit.json')));
      const store = new JobStore(state, 'cli', true); await store.ready;
      let result;
      try { result = jobResult(store.get(start.pid), false); } finally { store.dispose(); }
      assert.equal(result.agentOutput?.warnings, undefined, JSON.stringify(result).slice(0, 300));
    } finally { service.dispose(); claude.buildCommand = saved; }
  });
} else {
  console.log('SKIP win32 runner 管線端到端（非 Windows：agy 在 POSIX 本來就走管線）');
}

try { rmSync(TEMP, { recursive: true, force: true }); } catch { /* 防毒或 handle 尚未釋放；留給 tmp 清理 */ }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exitCode = failed ? 1 : 0;
