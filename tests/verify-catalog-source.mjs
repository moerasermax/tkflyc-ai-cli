/**
 * 模型目錄的**出處標示**回歸測試。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * 2026-07-31 發生過一次具體的誤導：有人照 `agents/antigravity.ts` 的
 * 註解斷定「agy 不支援 --model」並當成事實轉述。實測 v1.1.9 早就支援，
 * 而且模型從 4 個變成 11 個。
 *
 * 根因不是註解沒更新，而是**硬編清單沒有標明自己是硬編的**。
 * 這一支守的就是那個標示：
 *
 *   1. 每一筆目錄項目都必須有 source / verifiedAt / billingRoute
 *   2. 沒快取且查不到 vendor 才降級；磁碟舊值必須標 vendor-cli-cached
 *   3. doctor 不得再輸出「看起來像答案的非答案」
 *   4. 同步路徑不 spawn、不等網路；refresh 單飛、TTL、錯誤及 kill 用本機 stub 驗證
 * 全程使用暫存快取與 CLI stub，不呼叫真實 vendor。
 *
 * 用法：node verify-catalog-source.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-catalog-source-'));
const CACHE = join(TEMP, 'catalog-cache.json');
const envKeys = ['AI_CLI_CATALOG_CACHE_PATH', 'AGY_CLI_NAME', 'AI_CLI_DISCOVER_TIMEOUT_MS',
  'AGY_STUB_DELAY_MS', 'AGY_STUB_EMPTY', 'AGY_STUB_TRACE_PATH'];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.AI_CLI_CATALOG_CACHE_PATH = CACHE;
const stub = (name) => {
  const path = join(ROOT, 'tools/stubs', `${name}.${process.platform === 'win32' ? 'cmd' : 'mjs'}`);
  if (process.platform !== 'win32') chmodSync(path, 0o755);
  return path;
};
const slowStub = stub('agy-models-slow');
const errorStub = stub('agy-models-error');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowOf = (catalog) => catalog.agents.find((a) => a.agent === 'antigravity');
const modelsOf = (catalog) => catalog.entries.filter((e) => e.agent === 'antigravity').map((e) => e.model);
const fixture = ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'];
const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  // 格式與其他 verify 腳本一致：tools/mutation-test.mjs 靠「含 `FAIL ` 的行」
  // 判定突變有沒有被對應斷言殺掉。印成 `[FAIL]` 會讓它一條都對不上。
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const load = (rel) => import(pathToFileURL(join(ROOT, 'dist', rel)).href);

console.log('== 模型目錄的出處標示 ==');

const { buildCatalogV2, clearCatalogCache, refreshCatalogV2, FRESH_TTL_MS } = await load('models/catalog-v2.js');
const { getModelsPayload, isKnownModelTarget, resolveModelAlias } = await load('models/catalog.js');
const { selectModels } = await import('../tools/acceptance/worker-identity-logic.mjs');
const fallback = ['agy', 'agy-default', 'gemini-3.1-pro-high', 'gemini-3.8-flash-high'];
const sameModels = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const registry = await load('agents/registry.js');
const { buildDoctorStatus, inspectCliBinary } = await load('core/binary-resolver.js');
const agy = registry.getAgent('antigravity');
const realDiscover = agy.discoverModels;
const hadAgy = inspectCliBinary(agy.binary).available;
process.env.AGY_CLI_NAME = slowStub;
process.env.AGY_STUB_DELAY_MS = '0';
process.env.AI_CLI_DISCOVER_TIMEOUT_MS = '15000';
delete process.env.AGY_STUB_EMPTY;
delete process.env.AGY_STUB_TRACE_PATH;
agy.discoverModels = async () => null;

try {

// ── 1. 每一筆都要說得出出處 ───────────────────────────────────
{
  const catalog = buildCatalogV2();
  check(catalog.entries.length > 0, '目錄不是空的', `${catalog.entries.length} 筆`);

  const missing = catalog.entries.filter(
    (e) =>
      !e.id ||
      !e.displayName ||
      !['vendor-cli', 'vendor-cli-cached', 'builtin-fallback'].includes(e.source) ||
      !['subscription-cli', 'metered-api'].includes(e.billingRoute) ||
      typeof e.verifiedAt !== 'string' ||
      Number.isNaN(Date.parse(e.verifiedAt))
  );
  check(
    missing.length === 0,
    '★ 每一筆都有 source / verifiedAt / billingRoute（缺一就不該出現在目錄裡）',
    missing.length ? JSON.stringify(missing[0]) : ''
  );

  const bad = catalog.entries.filter((e) => e.id !== `${e.agent}/${e.model}`);
  check(bad.length === 0, 'id 是穩定的 {agent}/{model}，不是顯示名', bad.length ? bad[0].id : '');

  // agents 摘要與 entries 的 source 必須一致——分開講會讓兩者漂移
  const bySummary = new Map(catalog.agents.map((a) => [a.agent, a.source]));
  const inconsistent = catalog.entries.filter((e) => bySummary.get(e.agent) !== e.source);
  check(
    inconsistent.length === 0,
    'agents 摘要與每一筆 entry 的 source 一致',
    inconsistent.length ? inconsistent[0].id : ''
  );
  check(catalog.agents.every((a) => Number.isFinite(Date.parse(a.verifiedAt))
    && catalog.entries.filter((e) => e.agent === a.agent).every((e) => e.verifiedAt === a.verifiedAt)),
  'agents[].verifiedAt 是有效時間且與 entries 一致');
}

// ── 2. 計費路徑必須分得出來 ───────────────────────────────────
{
  const catalog = buildCatalogV2();
  const metered = catalog.entries.filter((e) => e.billingRoute === 'metered-api');
  check(
    metered.length > 0 && metered.every((e) => e.agent === 'direct-api'),
    '★ direct-api 標成 metered-api（按量計費的 API 金鑰，與訂閱額度是不同的錢）',
    `${metered.length} 筆`
  );
  const subs = catalog.entries.filter((e) => e.agent !== 'direct-api');
  check(
    subs.every((e) => e.billingRoute === 'subscription-cli'),
    '走各自 CLI 登入的標成 subscription-cli',
    ''
  );
}

// ── 3. 同步讀取、單飛 refresh、磁碟快取與真實 discover 的錯誤路徑 ──
{
  check(typeof realDiscover === 'function', 'antigravity 有 discoverModels（動態查詢能力）');
  await refreshCatalogV2(); // 收掉前兩節已排出的背景查詢，才換 stub。
  let calls = 0;
  process.env.AGY_STUB_DELAY_MS = '1500'; // 若同步路徑退化成直接 spawnSync，仍要抓得到阻塞。
  agy.discoverModels = async () => { calls++; await delay(1500); return fixture; };
  clearCatalogCache({ disk: true });
  const started = performance.now();
  const cold = buildCatalogV2();
  const elapsed = performance.now() - started;
  check(elapsed < 200, '同步 buildCatalogV2 不阻塞（<200 ms）', `${elapsed.toFixed(1)} ms`);
  check(calls === 0, '同步 buildCatalogV2 不呼叫 discoverModels／spawn');
  check(rowOf(cold).source === 'builtin-fallback' && rowOf(cold).discoveryNote.includes('查詢中'),
    '冷啟動尚無快取 → builtin-fallback 並說明查詢中');
  check(sameModels(getModelsPayload().antigravity, fallback), '尚無快取時頂層使用目前後備清單');
  const flight = refreshCatalogV2();
  check(flight === refreshCatalogV2({ force: true }), '背景與明確 refresh 共用同一個 Promise（單飛）');
  const fresh = await flight;
  process.env.AGY_STUB_DELAY_MS = '0';
  check(calls === 1 && rowOf(fresh).source === 'vendor-cli', 'refresh 成功 → vendor-cli 且只查一次');
  check(rowOf(buildCatalogV2()).source === 'vendor-cli', '隨後同步讀到記憶體 vendor-cli');
  const payload = getModelsPayload();
  check(sameModels(payload.antigravity, ['agy', 'agy-default', 'gemini-3.8-flash-high']),
    '成功查詢的頂層清單不混入 vendor 未列出的後備模型');
  check(!payload.antigravity.includes('gemini-3.5-flash-high'), '成功查詢的頂層清單不含退役模型');
  const defaults = selectModels(payload, { families: ['antigravity'] }).map(e => e.model);
  check(sameModels(defaults, payload.antigravity) && !defaults.includes('gemini-3.5-flash-high'),
    '驗收預設清單使用 vendor 候選且不含退役模型');
  check(!payload.antigravity.includes('gemini-3.1-pro-high')
    && isKnownModelTarget('gemini-3.1-pro-high')
    && registry.selectAgentForModel('gemini-3.1-pro-high').id === 'antigravity'
    && registry.selectAgentForModel(resolveModelAlias('agy-ultra')).id === 'antigravity',
    '候選清單移除名稱不影響明確模型路由與 alias');
  const verifiedAt = rowOf(fresh).verifiedAt;
  check(rowOf(buildCatalogV2()).verifiedAt === verifiedAt, '記憶體 verifiedAt 不假裝是現在');
  const persisted = JSON.parse(readFileSync(CACHE, 'utf8')).antigravity;
  check(JSON.stringify(persisted.models) === JSON.stringify(fixture)
    && persisted.verifiedAt === verifiedAt && persisted.cliPath === slowStub,
  '磁碟每個 agent 儲存 models / verifiedAt / cliPath');
  await refreshCatalogV2();
  check(calls === 1, '10 分鐘內 refresh 不重查');
  agy.discoverModels = async () => { calls++; return fixture; };
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + FRESH_TTL_MS + 1;
    await refreshCatalogV2();
    check(calls === 2, '記憶體超過 10 分鐘 refresh 會重查');
  } finally { Date.now = realNow; }
  await refreshCatalogV2({ force: true });
  check(calls === 3, 'force:true 忽略記憶體 TTL');

  // 模擬新 process：留下步驟 2 的磁碟原值，只清記憶體。失敗不能蓋掉它。
  writeFileSync(CACHE, JSON.stringify({ antigravity: persisted }));
  agy.discoverModels = async () => null;
  clearCatalogCache();
  const cached = buildCatalogV2();
  check(rowOf(cached).source === 'vendor-cli-cached', '磁碟快取必須標 vendor-cli-cached（不是 vendor-cli）');
  check(rowOf(cached).verifiedAt === verifiedAt && rowOf(cached).discoveryNote.includes('快取'),
    '新 process 保留原 verifiedAt 並說明快取');
  check(sameModels(getModelsPayload().antigravity, ['agy', 'agy-default', 'gemini-3.8-flash-high']),
    '成功磁碟快取的頂層清單不混入後備模型');
  const failedCached = await refreshCatalogV2({ force: true });
  check(rowOf(failedCached).source === 'vendor-cli-cached'
    && JSON.stringify(modelsOf(failedCached)) === JSON.stringify(fixture)
    && rowOf(failedCached).discoveryNote.includes('查詢失敗'),
  '查詢失敗保留磁碟快取與失敗原因', rowOf(failedCached).discoveryNote);
  check(JSON.stringify(JSON.parse(readFileSync(CACHE, 'utf8')).antigravity) === JSON.stringify(persisted),
    '失敗不覆寫磁碟 models 或 verifiedAt');

  clearCatalogCache({ disk: true });
  const after = await refreshCatalogV2({ force: true });
  const agyAfter = after.agents.find((a) => a.agent === 'antigravity');
  const entriesAfter = after.entries.filter((e) => e.agent === 'antigravity');
  const failedPayload = getModelsPayload();
  check(sameModels(failedPayload.antigravity, fallback), '查詢失敗且無快取時頂層保留後備清單');
  check(!selectModels(failedPayload, { families: ['antigravity'] }).some(e => e.model === 'gemini-3.5-flash-high'),
    '後備驗收預設清單不含退役模型');

  check(
    agyAfter.source === 'builtin-fallback',
    '★ 沒有快取且查不到 vendor → 降級成 builtin-fallback（不得繼續宣稱 vendor-cli）',
    agyAfter.source
  );
  check(
    entriesAfter.every((e) => e.source === 'builtin-fallback'),
    '★ 降級要落到每一筆 entry，不是只改摘要',
    ''
  );
  check(
    typeof agyAfter.discoveryNote === 'string' && agyAfter.discoveryNote.length > 0,
    '★ 降級時要說出為什麼（discoveryNote 非空）',
    agyAfter.discoveryNote ?? '(null)'
  );

  for (const [name, changed] of [
    ['cliPath 改變不用舊快取', { ...persisted, cliPath: `${slowStub}.old` }],
    ['30 天以上的快取不用', { ...persisted, verifiedAt: new Date(Date.now() - 31 * 86400000).toISOString() }],
    ['未來時間的快取不用', { ...persisted, verifiedAt: new Date(Date.now() + 86400000).toISOString() }],
  ]) {
    clearCatalogCache();
    writeFileSync(CACHE, JSON.stringify({ antigravity: changed }));
    check(rowOf(buildCatalogV2()).source === 'builtin-fallback', name);
    await refreshCatalogV2();
  }
  for (const invalid of ['{bad json', '[]', '{"antigravity":{"models":[3]}}']) {
    clearCatalogCache();
    writeFileSync(CACHE, invalid);
    check(rowOf(buildCatalogV2()).source === 'builtin-fallback', `壞快取忽略：${invalid}`);
    await refreshCatalogV2();
  }
  clearCatalogCache();
  writeFileSync(CACHE, JSON.stringify({ antigravity: persisted }));
  process.env.AGY_CLI_NAME = join(TEMP, 'missing-agy');
  const missing = rowOf(buildCatalogV2());
  check(missing.source === 'builtin-fallback' && !missing.binaryFound && missing.discoveryNote.includes('找不到'),
    'CLI 不存在時不沿用快取且說明原因');
  process.env.AGY_CLI_NAME = slowStub;

  agy.discoverModels = async () => fixture;
  await refreshCatalogV2({ force: true });
  const memoryTime = rowOf(buildCatalogV2()).verifiedAt;
  agy.discoverModels = async () => { throw new Error('injected rejection'); };
  const failedMemory = rowOf(await refreshCatalogV2({ force: true }));
  check(failedMemory.source === 'vendor-cli' && failedMemory.verifiedAt === memoryTime
    && failedMemory.discoveryNote.includes('injected rejection'), '失敗／reject 保留記憶體成功值與原因');

  // 不替換 discoverModels：用 AGY_CLI_NAME 經過真實 spawn + 計時 + kill + parser。
  agy.discoverModels = realDiscover;
  /*
    逾時門檻**不能寫死**，要從這台機器的實際啟動成本推出來。

    spawn 一次 stub（win32 是 .cmd → cmd.exe → node.exe）的成本差到一個數量級：
    開發機實測 68–80 ms，另一台消費端機器 763–886 ms。寫死 500 ms 的後果不是
    「測試比較嚴」，是**這題什麼都沒驗到**——門檻在 node 開機完成前就觸發，
    stub 連 trace('started') 都來不及寫，events 是空的、pid 是 undefined，
    於是「有沒有殺掉子程序」根本無從判斷，而失敗訊息卻會指向產品。
    （把 500 改成 1500 只是把同一個坑推給下一台更慢的機器。）
  */
  process.env.AGY_STUB_DELAY_MS = '0';
  const baselineStarted = performance.now();
  const baseline = await realDiscover(inspectCliBinary(agy.binary).resolvedPath);
  const spawnCostMs = performance.now() - baselineStarted;
  // 量測本身要成功。快速失敗（stub 路徑不對、chmod 沒生效…）量到的是失敗路徑的成本，
  // max(500, …) 就把門檻退回 500——正好回到這次要修掉的狀態，而且沒有任何訊號。
  check(baseline.models !== null, '門檻量測本身要成功（否則量到的是失敗路徑的成本）', JSON.stringify(baseline));
  const timeoutMs = Math.max(500, Math.ceil(spawnCostMs * 3));
  const stubDelayMs = timeoutMs * 4; // 維持原本 500:2000 的 1:4 比例
  process.env.AGY_STUB_DELAY_MS = String(stubDelayMs);
  process.env.AI_CLI_DISCOVER_TIMEOUT_MS = String(timeoutMs);
  const trace = join(TEMP, 'timeout-trace.jsonl');
  process.env.AGY_STUB_TRACE_PATH = trace;
  const timeoutStarted = performance.now();
  const timeoutWallStart = Date.now(); // 與 stub 的 trace 時間戳同基準（stub 用 Date.now）
  const timeoutResult = await realDiscover(inspectCliBinary(agy.binary).resolvedPath);
  check(timeoutResult.models === null && timeoutResult.note?.includes('逾時') && timeoutResult.note.includes(String(timeoutMs)),
    '真實 discover 逾時回 null 與逾時原因', JSON.stringify(timeoutResult));
  check(performance.now() - timeoutStarted < stubDelayMs * 0.7, '逾時結果不等 stub 自己結束');
  await delay(Math.max(0, stubDelayMs + 300 - (performance.now() - timeoutStarted)));
  const events = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const startedEvent = events.find((e) => e.event === 'started');
  const pid = startedEvent?.pid;
  /*
    前提先驗，而且要驗「**在門檻觸發前**就啟動了」，不是只驗「曾經啟動過」。

    只看 started 存不存在不夠：trace 是等 stub delay 過完才一次讀的，子程序若在
    門檻觸發之後才真正跑起來（Windows 上 kill 掉 .cmd 外殼後，內層 node.exe 仍可能
    稍後啟動並寫下 started），事後看一樣有 event，而下一條斷言會照樣過——
    測到的就不是它想測的東西了。所以 trace 帶時間戳，這裡比對它落不落在門檻內。
  */
  check(Boolean(startedEvent) && startedEvent.t - timeoutWallStart < timeoutMs,
    `逾時 kill 測試的前提：stub 在門檻觸發前就啟動（門檻 ${timeoutMs} ms、實測啟動成本 ${Math.round(spawnCostMs)} ms）`,
    JSON.stringify({ timeoutMs, startedAfterMs: startedEvent ? startedEvent.t - timeoutWallStart : null, events }));
  let alive = false;
  try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* 已終止 */ }
  // 條件式：**只有在 stub 真的跑起來時**才問「它被殺掉了嗎」。
  // 否則前提不成立那次會同時噴兩條 FAIL，其中一條說是門檻問題、另一條照樣指向產品——
  // 而上面那條前提斷言存在的意義就是不要再指錯方向。
  check(!startedEvent || (!alive && !events.some((e) => e.event === 'completed')),
    '逾時必須 kill 子程序（不能留到它印出模型）', JSON.stringify(events));
  delete process.env.AGY_STUB_TRACE_PATH;
  clearCatalogCache({ disk: true });
  check(rowOf(await refreshCatalogV2({ force: true })).discoveryNote.includes('逾時'),
    '真實逾時原因進 catalog.discoveryNote');
  process.env.AGY_CLI_NAME = errorStub;
  // 逾時預算到此為止。下面兩題測的是「非零退出時 stderr 第一行怎麼取」，跟逾時無關；
  // 沿用上面那個緊門檻會讓它們跟 node 啟動成本賽跑並固定輸掉，回傳逾時訊息而不是
  // stderr 內容——測到的是門檻，不是它想測的行為。（原本要到再下一段才還原，太晚。）
  process.env.AI_CLI_DISCOVER_TIMEOUT_MS = '15000';
  // 直接驗「還原」這件事本身。靠「stderr 取值會不會失敗」來守是不可靠的：
  // 在快機器上就算沿用了緊門檻，error stub 仍可能在預算內跑完，回歸就悄悄溜過去。
  check(Number(process.env.AI_CLI_DISCOVER_TIMEOUT_MS) >= 15000,
    '非零退出那兩題不得沿用逾時預算（門檻必須已還原）', String(process.env.AI_CLI_DISCOVER_TIMEOUT_MS));
  clearCatalogCache({ disk: true });
  const errorResult = await realDiscover(inspectCliBinary(agy.binary).resolvedPath);
  check(errorResult.models === null && errorResult.note === 'Error: Eligibility check failed: stub network unavailable',
    '真實 discover 非零退出取 stderr 第一行非空文字', JSON.stringify(errorResult));
  check(rowOf(await refreshCatalogV2({ force: true })).discoveryNote.includes('Eligibility check failed'),
    'Eligibility check failed 進 catalog.discoveryNote');
  const missingResult = await realDiscover(join(TEMP, 'missing-agy'));
  check(missingResult.models === null && Boolean(missingResult.note), '真實 spawn error 永不 reject');
  process.env.AGY_CLI_NAME = slowStub;
  process.env.AGY_STUB_DELAY_MS = '0';
  process.env.AI_CLI_DISCOVER_TIMEOUT_MS = '15000';
  process.env.AGY_STUB_EMPTY = 'true';
  const emptyResult = await realDiscover(slowStub);
  check(emptyResult.models === null && emptyResult.note === '輸出裡沒有模型 id', '真實空輸出回 null 與原因');
  delete process.env.AGY_STUB_EMPTY;
  clearCatalogCache();

  // 保留有 agy / 沒有 agy 的分支；可重現測試仍把實際執行路徑指向本機 stub。
  // 真實 discover 不替換，trace 證明真的帶 models 參數啟動 CLI，絕不連 vendor。
  if (hadAgy) {
    const successTrace = join(TEMP, 'success-trace.jsonl');
    process.env.AGY_STUB_TRACE_PATH = successTrace;
    const agyBefore = rowOf(await refreshCatalogV2({ force: true }));
    const invoked = existsSync(successTrace) && readFileSync(successTrace, 'utf8').includes('"args":["models"]');
    check(
      agyBefore.source === 'vendor-cli' && invoked,
      '★ 有 agy 時真的去問了 CLI（不是照抄靜態清單）',
      agyBefore.source
    );
    const restored = buildCatalogV2().agents.find((a) => a.agent === 'antigravity');
    check(restored.source === 'vendor-cli', '還原後回到 vendor-cli', restored.source);
    delete process.env.AGY_STUB_TRACE_PATH;
  } else {
    console.log('  [SKIP] 這台機器沒有 agy，跳過「真的問到 vendor」的斷言');
  }

  const cli = await promisify(execFile)(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), 'models'], {
    env: { ...process.env, AI_CLI_AUTO_UPDATE: 'off', AI_CLI_CATALOG_CACHE_PATH: join(TEMP, 'cli-cache.json') }, timeout: 10000,
  });
  const cliPayload = JSON.parse(cli.stdout);
  check(sameModels(cliPayload.antigravity, ['agy', 'agy-default', 'gemini-3.8-flash-high', 'gemini-3.1-pro-high'])
    && !selectModels(cliPayload).some(e => e.model === 'gemini-3.5-flash-high'),
    'CLI stub 成功查詢與驗收預設清單不含退役模型');
  check(rowOf(cliPayload.catalogV2).source === 'vendor-cli', 'ai-cli models 等待 refresh 後回 payload');

  // ★ stdout 排空回歸測試。
  //
  // 曾經：`bin/ai-cli.ts` 對 exec/update 以外的子命令直接 `process.exit()`，
  // 而 stdout 是 pipe 時寫入非同步——macOS 的 pipe buffer 8 KiB，`models`
  // 的 payload 超過它，呼叫端就拿到在第 8192 位元組切斷的殘缺 JSON。
  // 上面那條 JSON.parse 會炸，但錯誤訊息（position 8192）看不出根因，
  // 所以這裡把「守的是什麼」明講出來。
  //
  // 先確認這次真的走到 8 KiB 以上，否則這條測試等於沒測到東西——
  // 這比讓它靜靜地通過誠實。
  const bytes = Buffer.byteLength(cli.stdout, 'utf8');
  if (bytes <= 8192) {
    console.log(`  [SKIP] models payload 只有 ${bytes} bytes，未超過 pipe buffer，這次沒測到截斷`);
  } else {
    check(
      cli.stdout.trimEnd().endsWith('}'),
      `★ 大於 pipe buffer 的 stdout 要完整排空才退出（${bytes} bytes）`,
      `尾端：${JSON.stringify(cli.stdout.slice(-40))}`
    );
  }
}

// ── 3b. ★ 加了 --model 之後，既有 alias 不得因此壞掉 ──────────
//
// 這條差點變成「修一個誤會、製造另一個」：alias `agy-ultra` 解析成
// `Gemini 3.1 Pro (High)`（agy settings.json 的顯示寫法），而 CLI 的
// --model 只吃 `gemini-3.1-pro-high`。原樣傳會讓每一次 agy 呼叫都失敗。
{
  const agy = registry.getAgent('antigravity');
  const build = (model) =>
    agy.buildCommand({
      cliPath: 'agy.exe',
      cwd: '.',
      prompt: 'hi',
      resolvedModel: model,
      rawModel: model,
      reasoningEffort: '',
    });
  const modelArg = (model) => {
    const args = build(model).args;
    const i = args.indexOf('--model');
    return i >= 0 ? args[i + 1] : null;
  };

  check(
    modelArg('Gemini 3.1 Pro (High)') === 'gemini-3.1-pro-high',
    '★ 舊顯示寫法要正規化成 CLI 吃得下的 id（否則既有 alias 全部失效）',
    String(modelArg('Gemini 3.1 Pro (High)'))
  );
  check(modelArg('gemini-3.6-flash-high') === 'gemini-3.6-flash-high', '真實 id 原樣傳');
  check(modelArg('agy') === null, "'agy' 是框架 alias 不是模型名 → 不傳 --model");
  check(
    modelArg('這不是模型名') === null,
    '★ 認不出來就不傳（寧可回到 CLI 預設，也不要送一個必定失敗的值）'
  );
  check(
    agy.matchesModel('gemini-3.6-flash-high') && agy.matchesModel('Gemini 3.1 Pro (High)'),
    '新舊兩種寫法都路由到 antigravity'
  );
  check(
    !agy.matchesModel('claude-sonnet-4-6') && !agy.matchesModel('gpt-oss-120b-medium'),
    '★ agy 代理的 claude/gpt 模型**不**靠名字認領（會把人送到錯的 CLI）'
  );
}

// ── 3c. ★ `agy models` 的真實輸出要解析得出來 ─────────────────
//
// 2026-08-22：discoverModels 從 2026-07-31 上線起**沒有成功過一次**。
// 舊解析規則是「整行不含空白才算模型 id」，而 agy v1.1.17 的真實輸出是
// `<id>\t<顯示名稱>`——顯示名稱必然帶空白，於是每一行都被濾掉、永遠回 null。
// 目錄誠實地降級成 builtin-fallback，所以它看起來像「agy 查不到」而不像 bug。
// 上一節（3）只驗「查不到時要誠實降級」，驗不到「查得到時解析對不對」——
// 因為它把 discoverModels 換成 stub。這一節用**錄下來的真實輸出**補上那個洞。
{
  const { parseAgyModelsOutput, matchesAgyModel } = await load('agents/antigravity.js');

  // agy v1.1.17 `agy models` 的原樣輸出：開頭一行狀態訊息，其餘 tab 分隔
  const REAL_OUTPUT = [
    'Fetching available models...',
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    '',
  ].join('\n');

  const parsed = parseAgyModelsOutput(REAL_OUTPUT);
  check(
    Array.isArray(parsed) && parsed.length === 4,
    '★ 帶顯示名稱的行要解析得出 id（舊規則在這一行就回 null）',
    JSON.stringify(parsed)
  );
  check(parsed?.includes('gemini-3.1-pro-high'), 'tab 後面的顯示名稱不影響 id');
  check(
    !parsed?.some((m) => m.toLowerCase().startsWith('fetching')),
    "狀態訊息行不會被當成模型名"
  );
  check(
    parseAgyModelsOutput('\u001b[32mgemini-3.6-flash-low\u001b[0m\tGemini 3.6 Flash (Low)')?.[0] ===
      'gemini-3.6-flash-low',
    '上了色的輸出也解析得出來（ANSI 不得讓整行消失）'
  );
  check(
    parseAgyModelsOutput('Fetching available models...\n') === null,
    '★ 只有狀態訊息時回 null（不得回半套清單）'
  );
  check(
    parsed?.includes('claude-sonnet-4-6'),
    '解析階段不預先過濾——先看得見全部，取捨是下一步的事'
  );

  // 取捨不在 discoverModels（那一層說實話），而在目錄層的 routable 標記。
  clearCatalogCache();
  const catalog = await refreshCatalogV2({ force: true });
  const agyEntries = catalog.entries.filter((e) => e.agent === 'antigravity');
  const agyRow = catalog.agents.find((a) => a.agent === 'antigravity');

  check(
    agyEntries.length > 0 && agyEntries.every((e) => typeof e.routable === 'boolean'),
    '★ 每一筆都說得出自己能不能派工（routable 是 boolean，不是 undefined）'
  );

  const routable = agyEntries.filter((e) => e.routable).map((e) => e.model);
  const blocked = agyEntries.filter((e) => !e.routable).map((e) => e.model);

  const misrouted = routable.filter((m) => registry.selectAgentForModel(m).id !== 'antigravity');
  check(
    misrouted.length === 0,
    '★ 標成 routable 的每一個都真的路由回 agy（列得出來就要叫得動）',
    misrouted.join(', ')
  );
  check(
    blocked.every((m) => registry.selectAgentForModel(m).id !== 'antigravity'),
    '★ 標成不可路由的，實際上確實路由不回 agy（標示與現實一致）',
    blocked.join(', ')
  );
  check(
    routable.every((m) => matchesAgyModel(m)),
    'routable 由 agent 自己的 matchesModel 推得，不是另寫一套規則'
  );

  // run 的候選名單（舊的字串陣列）：只放可路由的，而且要吃得到實查結果
  const payload = getModelsPayload();
  check(
    payload.antigravity.every((m) => matchesAgyModel(m)),
    '★ run 的候選名單只放可路由的名字（列出來就要叫得動）',
    payload.antigravity.join(', ')
  );
  check(
    payload.antigravity.includes('agy') && payload.antigravity.includes('agy-default'),
    '★ 框架 alias 不因為改讀實查結果而消失（vendor 永遠不會回報它們）'
  );

  if (agyRow.source === 'vendor-cli') {
    check(
      blocked.length > 0,
      '★ vendor 回報但本框架路由不到的名字要「列出來並標明」，不得靜默扣掉',
      `不可路由：${blocked.join(', ') || '(無)'}`
    );
    check(
      routable.every((m) => payload.antigravity.includes(m)),
      '★ 實查到的可路由模型都要進 run 的候選名單（不能停在靜態清單）',
      payload.antigravity.join(', ')
    );
  } else {
    console.log('  [SKIP] 這一輪沒問到 vendor，跳過「實查結果要進候選名單」的斷言');
  }
}

// ── 4. 既有形狀不得被破壞 ─────────────────────────────────────
{
  const payload = getModelsPayload();
  for (const key of ['aliases', 'claude', 'codex', 'antigravity', 'direct-api', 'userConfig']) {
    check(payload[key] !== undefined, `models payload 保留既有欄位：${key}`);
  }
  check(payload.catalogV2 !== undefined, 'catalogV2 以新欄位加上去（不取代舊欄位）');
}

// ── 5. doctor 不得輸出看起來像答案的非答案 ────────────────────
{
  const configs = registry
    .listAgents()
    .filter((a) => a.binary)
    .map((a) => ({ id: a.id, config: a.binary }));
  const doctor = buildDoctorStatus(configs);
  check(
    doctor.checks.loginState === null && doctor.checks.termsAcceptance === null,
    '★ 沒檢查的項目回 null，不是 false（false 讀起來像「檢查過而且是否定的」）',
    JSON.stringify(doctor.checks)
  );
  const everyAvailable = configs.every((c) => doctor[c.id].available);
  check(
    doctor.checks.binaryAvailability === everyAvailable,
    '★ binaryAvailability 由實際結果推導，不是寫死的 true',
    `${doctor.checks.binaryAvailability} vs 實際 ${everyAvailable}`
  );
}

console.log('== server 身分：repository 正規化的範圍 ==');
{
  const { normalizeRepositoryUrl } = await load('core/identity.js');
  // 認得出來的形狀要正規化成可瀏覽網址
  check(
    normalizeRepositoryUrl('git+https://github.com/o/r.git') === 'https://github.com/o/r',
    'git+https 形式正規化成可瀏覽網址',
    normalizeRepositoryUrl('git+https://github.com/o/r.git')
  );
  // 認不出來的形狀要「原樣」回傳——半套正規化（只剝 .git）會產出既不能 clone
  // 也不能貼進瀏覽器的字串，比不處理更糟。
  for (const raw of ['git@github.com:o/r.git', 'github:o/r', 'o/r', 'git+ssh://git@github.com/o/r.git']) {
    check(normalizeRepositoryUrl(raw) === raw, `認不出的形狀原樣回傳：${raw}`, String(normalizeRepositoryUrl(raw)));
  }
  check(normalizeRepositoryUrl(undefined) === null, 'repository 缺欄位回 null');
  check(normalizeRepositoryUrl('') === null, 'repository 空字串回 null');
}

} catch (error) {
  check(false, 'catalog 測試流程不得拋例外', error.stack ?? String(error));
} finally {
  // 先收掉背景單飛再清除，避免下一輪或 exit 後才回寫暫存目錄。
  await refreshCatalogV2();
  clearCatalogCache({ disk: true });
  agy.discoverModels = realDiscover;
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  rmSync(TEMP, { recursive: true, force: true });
}
const passed = results.filter(([ok]) => ok).length;
const failed = results.length - passed;
console.log(`PASS: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
