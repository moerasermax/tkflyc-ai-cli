/**
 * query_usage（Codex）的回歸測試——重點是 **量不到額度時不能回 status ok**。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * 2026-10-06 實測（codex-cli 0.160.0、Windows 11、呼叫端以系統管理員權限執行）：
 * codex 互動模式要啟動共用背景 daemon，管理員權限下 daemon 拒絕啟動，TUI 只印一段錯誤。
 * query_usage 卻回 `status: "ok"`——raw 裡沒有任何額度數字，額度其實是 unknown。
 *
 * 這一支守三件事：
 *   1. 那段錯誤原文餵給解析器，結果不能是 ok，而且錯誤原文要留著；
 *      沒抓到額度面板（例：卡在 hook 信任畫面、逾時）也一樣不能是 ok
 *   2. 查額度的 TUI 帶 --no-daemon；舊版不認得時拿掉重跑一次
 *   3. 正常的額度面板仍是 ok（不能把修補做成「有 Error 字樣就判失敗」）
 *
 * 用假的 _run 取代 PTY，不啟動真實 codex。
 *
 * 用法：node verify-usage-parse.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const { parseCodexUsage, CodexUsageProvider, UsageService, isCodexTuiReady, codexStatusWrites } = await import(
  pathToFileURL(join(ROOT, 'dist', 'plugins', 'usage-service.js')).href
);

/** 假 PTY：依序吐出 outputs，並記下每次啟動帶的參數。 */
class FakeCodex extends CodexUsageProvider {
  constructor(outputs) {
    super('codex');
    this.outputs = [...outputs];
    this.calls = [];
  }
  _run(args) {
    this.calls.push([...args]);
    const next = this.outputs.shift() ?? '';
    const { output, timedOut = false } = typeof next === 'string' ? { output: next } : next;
    return Promise.resolve({ output, exitCode: null, signal: null, timedOut });
  }
}

async function queryWith(fake) {
  const svc = new UsageService({});
  svc.providers.set('codex', fake);
  return svc.queryProvider('codex', { refresh: true });
}

// 實測原文（2026-10-06，codex-cli 0.160.0，管理員權限）：TUI 開場畫面 + daemon 錯誤，沒有任何額度數字。
const ELEVATED_ERROR = [
  '>_ OpenAI Codex (v0.160.0)',
  'loading',
  'Hello again, carbon-based collaborator.',
  '› Ask Codex to do anything',
  '? for shortcuts',
  '',
  '',
  'Error: start the Windows daemon from a non-elevated terminal; shared clients must not inherit administrator privileges',
  'To work without the background server, rerun the same command with --no-daemon (including resume or fork and its arguments).',
].join('\r\n');

// clap 對不認得參數的實際輸出格式（同日以 `codex --definitely-not-a-flag` 取得）。
const OLD_CLI_REJECTS_FLAG = [
  "Error: unexpected argument '--no-daemon' found",
  '',
  "  tip: to pass '--no-daemon' as a value, use '-- --no-daemon'",
  '',
  'Usage: codex [OPTIONS] [PROMPT]',
].join('\r\n');

const RATE_PANEL = [
  '│  Model:        gpt-6.1-sol (reasoning medium)                     │',
  '│  5h limit:     [████████████░░░░░░░░] 61% left (resets 14:05)     │',
  '│  Weekly limit: [████░░░░░░░░░░░░░░░░] 22% left (resets 09:00 on 10 Oct) │',
].join('\r\n');

console.log('query_usage（Codex）：量不到就是 unknown，不能說成 ok\n');

// ── 1. 錯誤原文餵給解析器 ──────────────────────────────────────
const parsed = parseCodexUsage(ELEVATED_ERROR);
check(parsed?.type === 'error', '★ 管理員權限錯誤原文餵給解析器，結果不是 ok', `得到 type=${JSON.stringify(parsed?.type)}`);
check(
  typeof parsed?.error === 'string' && parsed.error.includes('non-elevated'),
  '錯誤原文有帶出來（error 欄位）',
  `得到 ${JSON.stringify(parsed?.error)}`
);
check(String(parsed?.raw).includes('--no-daemon'), 'raw 原文完整保留');

// ── 2. 經過 UsageService 的 status ─────────────────────────────
const elevatedFake = new FakeCodex([ELEVATED_ERROR]);
const elevated = await queryWith(elevatedFake);
check(elevated.status !== 'ok', '★ 量不到額度時 status 不是 ok', `得到 status=${JSON.stringify(elevated.status)}`);
check(String(elevated.error).includes('non-elevated'), 'status error 時 error 帶錯誤原文', `得到 ${JSON.stringify(elevated.error)}`);
check(String(elevated.usage?.raw).includes('non-elevated'), 'status error 時 usage.raw 仍保留（呼叫端要能讀原文）');

// ── 3. --no-daemon 與舊版退路 ──────────────────────────────────
check(
  elevatedFake.calls[0]?.includes('--no-daemon'),
  '★ 查額度的 TUI 第一次啟動帶 --no-daemon',
  `得到 ${JSON.stringify(elevatedFake.calls)}`
);
check(
  elevatedFake.calls.length === 1,
  '管理員權限的 daemon 錯誤不觸發重跑（它的文字本身就含 --no-daemon）',
  `啟動 ${elevatedFake.calls.length} 次`
);

const oldFake = new FakeCodex([OLD_CLI_REJECTS_FLAG, RATE_PANEL]);
const old = await queryWith(oldFake);
check(
  oldFake.calls.length === 2 && oldFake.calls[1].length === 0,
  '★ 舊版 codex 不認得 --no-daemon 時拿掉參數重跑一次',
  `得到 ${JSON.stringify(oldFake.calls)}`
);
check(old.status === 'ok' && old.usage?.type === 'rate_limits', '重跑後用的是第二次的額度面板', `得到 status=${old.status} type=${old.usage?.type}`);

// ── 4. 沒有錯誤字樣、也沒有額度數字 ────────────────────────────
// 實測原文（同日，帶 --no-daemon 之後）：hook 信任畫面擋住，/status 送不進去，60 秒逾時。
const HOOK_TRUST_SCREEN = [
  '>_ OpenAI Codex (v0.160.0)',
  '     loading',
  '  Shall we put some verbs after that cursor?',
  '› Ask Codex to do anything',
  "  ? for shortcuts~Hooks eed review2 hooks are new or changed.Hooks can run outside the sandbox after you trust them.› 1. Review hooks",
].join('\r\n');
const blocked = await queryWith(new FakeCodex([{ output: HOOK_TRUST_SCREEN, timedOut: true }]));
check(
  blocked.status !== 'ok',
  '★ 沒抓到額度面板（卡在互動畫面、逾時）時 status 不是 ok',
  `得到 status=${JSON.stringify(blocked.status)}`
);
check(String(blocked.error).includes('timed out'), '逾時有標在 error 裡', `得到 ${JSON.stringify(blocked.error)}`);
check(String(blocked.usage?.raw).includes('Hooks'), '卡住的畫面原文保留在 usage.raw');

// ── 5. 正常面板不能被誤判 ──────────────────────────────────────
const ok = await queryWith(new FakeCodex([RATE_PANEL]));
check(
  ok.status === 'ok' && ok.usage?.fiveHour?.percentRemaining === 61 && ok.usage?.weekly?.percentRemaining === 22,
  '正常額度面板仍是 ok，數字解析不變',
  `得到 status=${ok.status} 5h=${ok.usage?.fiveHour?.percentRemaining} weekly=${ok.usage?.weekly?.percentRemaining}`
);
const panelWithNoise = await queryWith(new FakeCodex([`Error: some MCP server failed to start\r\n${RATE_PANEL}`]));
check(
  panelWithNoise.status === 'ok' && panelWithNoise.usage?.type === 'rate_limits',
  '有額度數字時，畫面上別處的 Error 字樣不影響 ok',
  `得到 status=${panelWithNoise.status} type=${panelWithNoise.usage?.type}`
);

// ── 6. codex 0.160 的 TUI：就緒判斷與 /status 的送法 ─────────────────
// 實測畫面（2026-10-06，0.160.0，帶 --no-daemon、hook 已信任）：標題框一直停在 loading，
// 模型名在底部狀態列；舊的就緒判斷等不到「非 loading 的模型名」，永遠不送 /status。
const TUI_0160_READY = [
  '>_ OpenAI Codex (v0.160.0)',
  'loading',
  'Take your time. The cursor can wait.',
  '› Ask Codex to do anything',
  '? for shortcuts~GPT-6.1-Sol default·~high · ~',
].join('\n');
check(isCodexTuiReady(TUI_0160_READY, 2000), '★ 0.160 標題框停在 loading 時，提示列出現且靜止就算就緒');
check(!isCodexTuiReady(TUI_0160_READY, 500), '輸出還沒靜止時不送 /status');
check(!isCodexTuiReady(`${TUI_0160_READY}\nBooting MCP server: knowledge`, 2000), '還在啟動 MCP 時不送 /status');
check(isCodexTuiReady('╭──╮\n│ model:     gpt-6-astra   │\n╰──╯\n', 2000), '舊版 TUI：標題框換成真模型名仍算就緒');

check(
  JSON.stringify(codexStatusWrites(TUI_0160_READY)) === JSON.stringify(['/status', '\r']),
  '★ /status 與 Enter 分兩次寫（同一次寫入時 Enter 會被指令選單吞掉）',
  `得到 ${JSON.stringify(codexStatusWrites(TUI_0160_READY))}`
);
check(
  JSON.stringify(codexStatusWrites(`${TUI_0160_READY}\n›/status`)) === JSON.stringify(['\r']),
  '重試時 /status 還在輸入框，只補 Enter（不能變成 /status/status）'
);

// 同一次實測拿到的面板原文：Weekly limit 跟 Session 擠在同一行、% 與 left 之間沒有空白。
const PANEL_0160 = [
  'Account:                    Pro100',
  'Session:                    01a10f0d-a1dd-7040-b2a1-ececd0382a07  Weekly limit:               [████████████████░░░░]82%left (resets 12:30 AM on 13 Oct)',
  'Luna Reserve Weekly limit:  [███████████████████░]96%left (resets 3:00 AM on 7 Oct)',
].join('\n');
const panel = await queryWith(new FakeCodex([PANEL_0160]));
check(
  panel.status === 'ok' && panel.usage?.weekly?.percentRemaining === 82 && panel.usage?.weekly?.resetAt === '12:30 AM on 13 Oct',
  '★ 0.160 實測面板解得出 weekly 82% left 與重置時間',
  `得到 status=${panel.status} weekly=${JSON.stringify(panel.usage?.weekly)}`
);

const failed = results.filter(([ok]) => !ok).length;
if (failed > 0) {
  console.log(`\nFAIL: ${results.length - failed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\nPASS: ${results.length} passed, 0 failed`);
