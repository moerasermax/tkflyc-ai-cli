/**
 * `npm test` 的入口：依序跑完清單上每一支 verify 腳本，最後印彙總表。
 *
 * ── 為什麼不再用 `&&` 串接（issue #14）────────────────────────────
 * 3.1.0 起 `test` 是一長串 `node tests/verify-*.mjs && ...`，第一支失敗就中止。
 * 結果 CI 的一張紅燈只告訴你「第一個」壞掉的地方，排在後面的十幾支完全沒跑、狀態不明
 * （#13 的 verify-usage-parse 一壞，後面 15 支全被跳過）。現在每一支都會跑到，
 * 任何一支 FAIL 時整體仍以 exit 1 結束——CI 擋不擋的行為不變，只是看得到全貌。
 *
 * ── 規則 ────────────────────────────────────────────────────────
 * - **一律依序執行，刻意不提供並行。** 幾支測試（verify-update、verify-liveness 等）各自開暫存
 *   bare origin 與 A/B clone，並行時會在 `spawnSync git` 上 ETIMEDOUT（CLAUDE.md 紅線 8）。
 * - 子行程 stdio 直接繼承，CI log 即時看得到輸出。
 * - 以下都算 FAIL：exit 非 0、被 signal 結束（status 為 null）、spawn 失敗。
 * - **防漏加**：開跑前掃測試目錄的 `verify-*.mjs`，不在 TESTS 也不在 EXCLUDED 的檔案直接報錯；
 *   TESTS 列了但檔案不存在也報錯。新增測試時把檔名加進下面的 TESTS 即可。
 *
 * 用法：
 *   node tools/run-tests.mjs                                   # 正式清單（npm test 用這個）
 *   node tools/run-tests.mjs --manifest <清單.json> --tests-dir <目錄>
 *   環境變數 AI_CLI_TEST_MANIFEST／AI_CLI_TESTS_DIR 同上（參數優先）。
 *   替代清單格式：{ "tests": [ "verify-a.mjs", { "file": "verify-b.mjs", "nodeArgs": [...], "timeoutMs": 1000 } ],
 *                  "excluded": { "verify-c.mjs": "理由" } }
 *   這兩個開關給 tests/verify-run-tests.mjs 用假測試驗證 runner 本身。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 正式清單，照這個順序跑。字串＝直接 `node tests/<檔名>`；物件可帶 `nodeArgs`（放在腳本路徑前）
 * 與 `timeoutMs`（逾時由 runner 以 SIGTERM 結束、算 FAIL；不給就不設上限）。
 * 子行程 cwd 一律是 repo 根目錄，所以 `--import ./tools/...` 這種相對路徑照常可用。
 */
const TESTS = [
  'verify-breaker.mjs',
  'verify-rate.mjs',
  'verify-direct-api.mjs',
  'verify-extra-body.mjs',
  { file: 'verify-alias-config.mjs', nodeArgs: ['--import', './tools/stubs/catalog-test-env.mjs'] },
  'verify-catalog-source.mjs',
  'verify-agy-parse.mjs',
  'verify-usage-parse.mjs',
  'verify-codex-app-server.mjs',
  'verify-codex-usage-schema.mjs',
  'verify-job-usage.mjs',
  'verify-exec-contract.mjs',
  'verify-mcp-capabilities.mjs',
  'verify-mcp-system-prompt.mjs',
  'verify-mcp.mjs',
  'verify-liveness.mjs',
  'verify-update.mjs',
  'verify-worker-identity.mjs',
  'verify-worker-guards.mjs',
  'verify-jobs.mjs',
  'verify-durable-jobs.mjs',
  'verify-grok.mjs',
  'verify-usage-update.mjs',
  'verify-restart-recovery.mjs',
  'verify-durable-audit.mjs',
  'verify-principal-process.mjs',
  'verify-adopt.mjs',
  'verify-pty-jobs.mjs',
  'verify-launcher-jobs.mjs',
  'verify-ai-cli_kernel.mjs',
  'verify-ai-cli_kernel-e2e.mjs',
  'verify-run-tests.mjs',
  'verify-mutation-manifest.mjs',
];

/** 刻意不進 `npm test` 的 verify 腳本。新增一支卻不想進 npm test，就要在這裡寫理由。 */
const EXCLUDED = {
  'verify-e2e.mjs': '會真的呼叫 claude／codex／agy 三家 CLI、消耗額度，只在需要驗證端到端行為時手動跑',
  'verify-strict-behaviour.mjs': '手動輔助：用真模型探針驗唯讀旗標的實際行為（npm run verify:strict-behaviour）',
};

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const manifestPath = argValue('--manifest') ?? process.env.AI_CLI_TEST_MANIFEST;
const testsDir = resolve(argValue('--tests-dir') ?? process.env.AI_CLI_TESTS_DIR ?? join(ROOT, 'tests'));
const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf-8')) : { tests: TESTS, excluded: EXCLUDED };
const entries = (manifest.tests ?? []).map((t) => (typeof t === 'string' ? { file: t } : t));
const excluded = manifest.excluded ?? {};

// ---- 開跑前檢查清單：任何一項不對就不跑，直接 exit 1 ----
const problems = [];
const listed = entries.map((e) => e.file);
const dupes = [...new Set(listed.filter((f, i) => listed.indexOf(f) !== i))];
if (dupes.length > 0) problems.push(`清單重複列出：${dupes.join(', ')}`);
const both = listed.filter((f) => Object.hasOwn(excluded, f));
if (both.length > 0) problems.push(`同時在清單與排除清單：${both.join(', ')}`);
const missing = listed.filter((f) => !existsSync(join(testsDir, f)));
if (missing.length > 0) problems.push(`清單列了但檔案不存在：${missing.join(', ')}`);
const onDisk = existsSync(testsDir) ? readdirSync(testsDir).filter((f) => /^verify-.*\.mjs$/.test(f)) : [];
const unlisted = onDisk.filter((f) => !listed.includes(f) && !Object.hasOwn(excluded, f));
if (unlisted.length > 0) {
  problems.push(`未列入清單的 verify 腳本：${unlisted.join(', ')}（加進 tools/run-tests.mjs 的 TESTS，或寫理由放進 EXCLUDED）`);
}
if (entries.length === 0) problems.push('清單是空的，拒絕空跑');
if (problems.length > 0) {
  console.log(`run-tests：清單檢查失敗（${testsDir}）`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}

// ---- 依序執行 ----
const results = [];
for (const [i, entry] of entries.entries()) {
  console.log(`\n▶ [${i + 1}/${entries.length}] ${entry.file}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [...(entry.nodeArgs ?? []), join(testsDir, entry.file)], {
    cwd: ROOT,
    stdio: 'inherit',
    ...(entry.timeoutMs ? { timeout: entry.timeoutMs } : {}),
  });
  const ms = Date.now() - started;
  // status 為 null（被 signal 結束）與 spawn 失敗都不是 0，一律算 FAIL。
  const ok = !r.error && r.status === 0;
  const reason = ok
    ? ''
    : r.status === null && r.signal
      ? `被 ${r.signal} 結束${r.error?.code === 'ETIMEDOUT' ? `（逾時 ${entry.timeoutMs}ms）` : ''}`
      : r.error
        ? `spawn 失敗：${r.error.code ?? r.error.message}`
        : `exit ${r.status}`;
  const result = { file: entry.file, ok, ms, reason };
  results.push(result);
}

// ---- 彙總表 ----
const failed = results.filter((r) => !r.ok);
const width = Math.max(...results.map((r) => r.file.length));
console.log('\n================ npm test 彙總 ================');
for (const r of results) {
  const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(width)}  ${secs}${r.reason ? `  ${r.reason}` : ''}`);
}
const total = results.reduce((sum, r) => sum + r.ms, 0);
console.log(`共 ${results.length} 支：PASS ${results.length - failed.length}、FAIL ${failed.length}，總耗時 ${(total / 1000).toFixed(1)}s`);
process.exitCode = failed.length > 0 ? 1 : 0;
