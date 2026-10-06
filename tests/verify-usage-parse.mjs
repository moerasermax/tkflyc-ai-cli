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

// codex 的 query 會先讀 session 檔；不隔離的話會讀到這台機器真正的 ~/.codex，
// 測試結果就取決於最近有沒有人用過 codex。指向空的暫存目錄。
import { mkdtempSync, mkdirSync, writeFileSync as writeFile, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'ai-cli-codex-home-'));

const { parseCodexUsage, parseClaudeUsage, parseAgyUsage, renderTerminal, readCodexSessionRateLimits, CodexUsageProvider, UsageService, isCodexTuiReady, codexStatusWrites } = await import(
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

// ── 7. 0.160 用游標移動排版：還原後才解得出 model / account ───────────
// 實測原始位元組（2026-10-06）：`ESC[1C` 代替空格、`ESC[列;1H` 代替換行。直接清 ANSI 會變成
// `Pro100`、`Model:` 黏到上一行行尾，model / account 都解成 null。
const E = '\u001b';
const PANEL_0160_RAW =
  `for up-to-date${E}[12;3Hinformation on rate limits and credits${E}[m${E}[2m` +
  `${E}[14;1H  Model:                      ${E}[22mGPT-6.1-Sol${E}[2m (reasoning high, summaries auto)\r\n` +
  `  Permissions:                ${E}[22mWorkspace${E}[1C(Ask${E}[1Cfor${E}[1Capproval)${E}[2m\r\n` +
  `  Account:                    ${E}[22mPro${E}[1C100${E}[2m\r\n` +
  `  Session:                    ${E}[22m01a10f38-c3ae-77d2-b220-3c47c3de74fd${E}[2m` +
  `${E}[23;1H  Weekly limit:               ${E}[22m[████████████████░░░░]${E}[1C80%${E}[1Cleft${E}[2m (resets 12:30 AM on 13 Oct)\r\n`;
const rawParsed = parseCodexUsage(PANEL_0160_RAW);
check(rawParsed?.model === 'GPT-6.1-Sol', '★ 游標定位還原成換行後，model 解得出來', `得到 ${JSON.stringify(rawParsed?.model)}`);
check(rawParsed?.account === 'Pro 100', '★ 游標右移還原成空格後，account 照畫面原樣是 "Pro 100"', `得到 ${JSON.stringify(rawParsed?.account)}`);
check(
  rawParsed?.weekly?.percentRemaining === 80 && rawParsed?.weekly?.resetAt === '12:30 AM on 13 Oct',
  '原始位元組的面板，weekly 數字與重置時間不受還原影響',
  `得到 ${JSON.stringify(rawParsed?.weekly)}`
);
check(String(rawParsed?.raw).includes('Ask for approval'), 'raw 原文的空格也還原了（可讀）');

const viaQuery = await queryWith(new FakeCodex([PANEL_0160_RAW]));
check(
  viaQuery.usage?.model === 'GPT-6.1-Sol' && viaQuery.usage?.account === 'Pro 100',
  '經過 query 的完整路徑，model / account 也解得出來（query 先清 ANSI，不能在那之前漏掉還原）',
  `得到 model=${JSON.stringify(viaQuery.usage?.model)} account=${JSON.stringify(viaQuery.usage?.account)}`
);

const sameRow = parseCodexUsage(`${E}[5;1H  Weekly limit:${E}[5;30H[████]${E}[1C64%${E}[1Cleft (resets 1:00 AM)`);
check(
  sameRow?.weekly?.percentRemaining === 64,
  '同一列內的游標跳躍只補空格，不會把 Weekly limit 跟數字拆到兩行',
  `得到 ${JSON.stringify(sameRow?.weekly)}`
);

const oldAccount = parseCodexUsage('Account: user@example.com (Plus)\n5h limit: [██] 70% left (resets 14:00)');
check(
  oldAccount?.account === 'user@example.com' && oldAccount?.plan === 'Plus',
  '舊版「email (方案)」格式照舊：account 是 email、plan 是括號內容',
  `得到 account=${JSON.stringify(oldAccount?.account)} plan=${JSON.stringify(oldAccount?.plan)}`
);

// ── 8. 模擬終端機：跳過的格子保留原字、局部改寫 ───────────────────
// claude 實測（2026-10-06）：`Current sess␛[1Con` 是「i 沒變所以跳過」，不是空格；
// `␛[29;12H29` 回頭只改寫 `Resets 1:30pm` 的分鐘數。
const CLAUDE_USAGE_RAW =
  `${E}[27;3HCurrent session${E}[28;3H███${E}[47X${E}[47C 6% used${E}[29;3HResets 1:30pm (Asia/Taipei)` +
  `${E}[27;3HCurrent sess${E}[1Con${E}[22m${E}[K${E}[29;12H29` +
  `${E}[31;3HCurrent week (all models)${E}[32;3H█████████████████████▌${E}[28X${E}[29C43%${E}[1Cused` +
  `${E}[33;3HResets Oct 11, 1pm (Asia/Taipei)` +
  `${E}[35;3HCurrent week (Fable)${E}[36;3H${E}[50X${E}[50C 0% used${E}[37;3HResets Oct 11, 1pm (Asia/Taipei)`;
const screen = renderTerminal(CLAUDE_USAGE_RAW);
check(screen.includes('Current session') && !screen.includes('sess on'), '★ ESC[nC 是跳過格子、保留原字（不能當成空格）', JSON.stringify(screen.split('\n').find((l) => l.includes('Current sess'))));
check(screen.includes('Resets 1:29pm'), '回頭局部改寫的字蓋在原位（1:30 → 1:29）');
check(renderTerminal('寬字元ABC') === '寬字元ABC' && renderTerminal(`abcdef${E}[3D${E}[K`) === 'abc', '中日韓字佔兩格、ESC[K 清到行尾');

const claude = parseClaudeUsage(CLAUDE_USAGE_RAW);
check(
  claude?.sessionPercent === 6 && claude?.weekAllModelsPercent === 43 && claude?.sessionResetAt === '1:29pm (Asia/Taipei)',
  '★ claude 實測畫面解得出 session 與本週百分比（原本全部是 null 卻回 ok）',
  `得到 session=${claude?.sessionPercent} week=${claude?.weekAllModelsPercent} reset=${JSON.stringify(claude?.sessionResetAt)}`
);
check(
  claude?.additionalLimits?.length === 1 && claude.additionalLimits[0].label === 'Fable' && claude.additionalLimits[0].percentUsed === 0,
  'claude 模型專屬的週額度列進 additionalLimits',
  `得到 ${JSON.stringify(claude?.additionalLimits)}`
);

const claudeEmpty = parseClaudeUsage('❯ /usage\n\nLoading usage data…');
check(claudeEmpty?.type === 'error', '★ claude 一個額度數字都沒有時回 type error（量不到不是 ok）', `得到 ${JSON.stringify(claudeEmpty?.type)}`);
const claudeSvc = new UsageService({});
claudeSvc.providers.set('claude', { query: async () => parseClaudeUsage('❯ /usage\n\nLoading usage data…') });
const claudeResult = await claudeSvc.queryProvider('claude', { refresh: true });
check(claudeResult.status === 'error' && String(claudeResult.usage?.raw).includes('Loading'), 'claude 量不到時 status 是 error、raw 保留', `得到 status=${claudeResult.status}`);

const panelLuna = parseCodexUsage(PANEL_0160);
check(
  panelLuna?.additionalLimits?.length === 1 && panelLuna.additionalLimits[0].label === 'Luna Reserve Weekly' && panelLuna.additionalLimits[0].percentRemaining === 96,
  'codex 主額度以外的額度行列進 additionalLimits（Luna Reserve Weekly 96%）',
  `得到 ${JSON.stringify(panelLuna?.additionalLimits)}`
);

// agy 1.2.17 實測面板（按群組列，標籤寫明 Remaining）。
const AGY_PANEL = [
  'GEMINI MODELS',
  'Models within this group: Gemini Flash, Gemini Pro',
  'Weekly Limit Remaining',
  '[██████████████████████████████████████████████████] 99.86%',
  'Refreshes in 164h 50m',
  'Five Hour Limit Remaining',
  '[██████████████████████████████████████████████████] 99.16%',
  'Refreshes in 1h 50m',
  'CLAUDE AND GPT MODELS',
  'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
  'Weekly Limit Remaining',
  '[██████████████████████████████████████████████████] 100.00%',
  'Quota available',
].join('\n');
const agy = parseAgyUsage(AGY_PANEL);
const g0 = agy?.models?.[0];
check(
  g0?.model === 'GEMINI MODELS' && g0?.percentRemaining === 99.86 && g0?.percentUsed === 0.14 && g0?.basis === 'remaining',
  '★ agy「Limit Remaining 99.86%」是剩餘量，不能放進 percentUsed（原本讀反）',
  `得到 ${JSON.stringify(g0)}`
);
check(
  agy?.models?.[2]?.model === 'CLAUDE AND GPT MODELS' && agy?.models?.[2]?.limit === 'Weekly Limit Remaining',
  'agy 的 model 是群組名稱、limit 是原本的標籤'
);

// ── 9. codex 讀 session 檔的 rate_limits（不開 TUI）──────────────────
// 實測格式（2026-10-06，~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl 的 token_count 事件）。
const now = Date.now();
const day = new Date(now);
const sessHome = mkdtempSync(join(tmpdir(), 'ai-cli-codex-sess-'));
const dayDir = join(sessHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
mkdirSync(dayDir, { recursive: true });
const rlEvent = (ts) => JSON.stringify({
  timestamp: new Date(ts).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: {}, rate_limits: {
    limit_id: 'codex', primary: { used_percent: 21.0, window_minutes: 10080, resets_at: 1791822646 },
    secondary: null, plan_type: 'prolite',
  } },
});
const sessFile = join(dayDir, 'rollout-test.jsonl');
writeFile(sessFile, `{"type":"session_meta","payload":{}}\n${rlEvent(now - 60_000)}\n`);
const fromFile = readCodexSessionRateLimits(sessHome, now);
check(
  fromFile?.source === 'session-file' && fromFile?.weekly?.percentUsed === 21 && fromFile?.weekly?.percentRemaining === 79 && fromFile?.plan === 'prolite',
  '★ 從 session 檔讀到週額度與 plan（不用開 TUI）',
  `得到 ${JSON.stringify({ source: fromFile?.source, weekly: fromFile?.weekly, plan: fromFile?.plan })}`
);
check(fromFile?.weekly?.resetAt === new Date(1791822646 * 1000).toISOString() && typeof fromFile?.asOf === 'string', 'session 檔結果附重置時間與資料時間（asOf）');

writeFile(sessFile, `${rlEvent(now - 20 * 60_000)}\n`);
utimesSync(sessFile, new Date(now - 20 * 60_000), new Date(now - 20 * 60_000));
check(readCodexSessionRateLimits(sessHome, now) === null, '★ session 檔的資料超過 10 分鐘就不用（不能把舊數字當現況）');
check(readCodexSessionRateLimits(sessHome, now, Number.POSITIVE_INFINITY)?.plan === 'prolite', '不限時間時仍讀得到 plan（給 TUI 結果補方案用）');

// provider：有新鮮的 session 檔就不開 TUI；refresh（fresh: true）一律走 TUI；TUI 結果沒有 plan 時從 session 檔補。
writeFile(sessFile, `${rlEvent(now - 30_000)}\n`);
utimesSync(sessFile, new Date(now), new Date(now));
process.env.CODEX_HOME = sessHome;
const quick = new FakeCodex([RATE_PANEL]);
const quickResult = await quick.query();
check(quick.calls.length === 0 && quickResult?.source === 'session-file', '★ 有新鮮的 session 檔時不開 TUI', `啟動 ${quick.calls.length} 次、source=${quickResult?.source}`);
const forced = new FakeCodex([RATE_PANEL]);
const forcedResult = await forced.query({ fresh: true });
check(forced.calls.length === 1 && forcedResult?.type === 'rate_limits' && forcedResult?.source === undefined, 'refresh=true 一律走 TUI', `啟動 ${forced.calls.length} 次`);
check(forcedResult?.plan === 'prolite', 'TUI 面板沒有方案時，從 session 檔補 plan', `得到 ${JSON.stringify(forcedResult?.plan)}`);
const svcFresh = new UsageService({});
const svcFake = new FakeCodex([RATE_PANEL]);
svcFresh.providers.set('codex', svcFake);
await svcFresh.queryProvider('codex', { refresh: true });
check(svcFake.calls.length === 1, 'UsageService 的 refresh=true 會傳到 provider（強制走 TUI）', `啟動 ${svcFake.calls.length} 次`);
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'ai-cli-codex-home-'));

const failed = results.filter(([ok]) => !ok).length;
if (failed > 0) {
  console.log(`\nFAIL: ${results.length - failed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\nPASS: ${results.length} passed, 0 failed`);
