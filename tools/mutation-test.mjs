/**
 * 突變測試：把每一個修補逐一改壞，確認「對應的斷言真的會 FAIL」。
 *
 * 這是在驗證**測試本身有沒有在測東西**。一個突變如果 SURVIVED（測試仍全過），
 * 代表那條斷言是假綠燈 —— 產品程式碼壞掉了它卻不吭聲。
 * 這個專案已經吃過三次假綠燈的虧（見 CHANGELOG 4.0.0 / 4.1.0），所以有這支工具。
 *
 * 用法：
 *   git worktree add --detach <某處>/mut HEAD
 *   # 建 node_modules junction（Windows）：
 *   #   New-Item -ItemType Junction -Path <某處>\mut\node_modules -Target <repo>\node_modules
 *   node tools/mutation-test.mjs <某處>/mut
 *   node tools/mutation-test.mjs <某處>/mut --script verify-update.mjs
 *   # 收尾先移除 node_modules junction 本身，再移除 worktree 目錄。
 *
 * 突變清單在 tools/mutations.json。新增一項修補時，順手加一個對應突變 ——
 * 如果它 SURVIVED，代表你的測試沒有真的在保護那段程式碼。
 *
 * 每個突變可用 `script` 欄位指定由哪一支 verify 腳本負責抓（預設
 * verify-alias-config.mjs）。那支腳本必須把失敗訊息印到 **stdout** 且含 "FAIL "，
 * 裡面要包含該突變 `expect` 的字串，否則會被判成 KILLED(其他斷言)。
 *
 * 在獨立的 git worktree 上跑，不碰主工作目錄。
 * test-env 與各 verify 腳本將設定、快取、狀態全部指向暫存目錄。
 */

import './stubs/catalog-test-env.mjs';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: node mutation-test.mjs <worktree-path>');

const CONFIG = join(process.env.AI_CLI_CONFIG_DIR, 'config.json');
const CONFIG_BAK = join(ROOT, '..', 'config.json.mutbak');

/** 每個突變：改壞一處，期待某條斷言失敗。 */
const selectedScript = process.argv.includes('--script') ? process.argv[process.argv.indexOf('--script') + 1] : undefined;
const MUTATIONS = JSON.parse(readFileSync(new URL('./mutations.json', import.meta.url), 'utf-8'))
  .filter((mutation) => !selectedScript || (mutation.script ?? 'verify-alias-config.mjs') === selectedScript);
if (!MUTATIONS.length) throw new Error('沒有符合的突變，拒絕空跑');

/**
 * 一律用 process.execPath 直接跑 .js/.mjs，**不要碰 npm.cmd**：
 * Node 20+ 之後 execFileSync 不能直接 spawn .cmd（EINVAL），
 * 那會讓每個突變都因為「指令根本沒跑起來」而回非零 → 全部被誤判成 KILLED。
 * （第一版 harness 就是這樣，12 個突變全是假 KILLED。）
 */
function exec(cmd, args) {
  try {
    return {
      code: 0,
      out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }),
    };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** 跑 node 腳本。 */
const run = (args) => exec(process.execPath, args);

const TSC = join('node_modules', 'typescript', 'bin', 'tsc');
/** 建置。harness 刻意不走 npm.cmd（見上方檔頭），直接呼叫 tsc。 */
const buildAll = () => run([TSC]);
const results = [];

/**
 * 每個突變由哪一支 verify 腳本負責抓。預設 verify-alias-config.mjs（既有 19 個突變
 * 都在它的守備範圍）。
 *
 * 為什麼需要這個欄位：harness 原本寫死只跑 verify-alias-config.mjs，所以任何斷言
 * 落在別支腳本的突變都會被判成 SURVIVED —— 那是 harness 自己的假綠燈，而不是
 * 測試真的沒在測。4.1.2 修 `ai-cli mcp` 啟動即自殺時就撞到這件事：那條斷言在
 * verify-mcp.mjs，而 verify-alias-config 走的是 ai-cli-mcp.js 入口，根本碰不到。
 */
const scriptOf = (mutation) => mutation.script ?? 'verify-alias-config.mjs';
const SCRIPTS = [...new Set(MUTATIONS.map(scriptOf))];

// 全新的機器上這個檔還不存在（使用者從沒改過設定），直接 copyFileSync 會 ENOENT
// 整支腳本當場掛掉。那種情況下「還原」的正確語意是把測試順手產生的檔案刪掉，
// 而不是複製一份不存在的備份回去。
const hadConfig = existsSync(CONFIG);
if (hadConfig) {
  copyFileSync(CONFIG, CONFIG_BAK);
  console.log(`使用者 config 已備份到 ${CONFIG_BAK}\n`);
} else {
  console.log(`使用者 config 不存在（${CONFIG}），收尾時會刪掉測試產生的那份\n`);
}

// worktree 一開始可能就有未提交的改動（例如刻意把待驗證的檔案複製進去），
// 所以收尾比對的是「跟開跑時一不一樣」，而不是「是不是空的」。
const baselineStatus = exec('git', ['status', '--short']).out.trim();

// 先確認基準是綠的：基準就紅的話，後面每個突變都會「被殺」而毫無意義。
{
  const build = buildAll();
  if (build.code !== 0) {
    console.error('基準建置失敗，中止：', build.out.slice(-500));
    process.exit(1);
  }
  for (const script of SCRIPTS) {
    const base = run([join('tests', script)]);
    if (base.code !== 0) {
      console.error(`基準 ${script} 未通過，中止：`, base.out.slice(-800));
      process.exit(1);
    }
    console.log(`基準 ${script}：PASS`);
  }
  console.log('');
}

/**
 * 把 CRLF 收成 LF。**原始碼與比對片段都要過這一關。**
 *
 * ★ 2026-10-03：原本只正規化原始碼、`mutation.from` 卻原樣比對，於是任何從 CRLF 工作區
 *   複製出來的片段永遠對不上——判 ERROR，而那個突變等於什麼都沒測。實際有 4 筆長期如此
 *   （全在 verify-extra-body.mjs 底下）。這個 repo 的 `src/` 工作區含 CRLF
 *   （`git ls-files --eol` 實測 w/crlf），而既有做法又是「從當前原始碼取出實際片段」，
 *   所以光把那 4 筆資料改成 LF 無法避免復發——根因是這個不對稱，要修在這裡。
 *   `to` 也要正規化：否則 `to` 內含 CRLF 時會把 CRLF 寫進已經正規化成 LF 的檔案，變成混合 EOL。
 */
const toLf = (text) => text.replace(/\r\n/g, '\n');

for (const [i, mutation] of MUTATIONS.entries()) {
  const path = join(ROOT, mutation.file);
  // 原始 bytes 要原封保留，收尾才寫得回去：比對與替換在 LF 空間做，**還原時寫回原始 bytes**。
  // （寫回正規化後的內容會讓整個 worktree 因為 EOL 變更而變髒，
  // 而最後那句「worktree 應為空」原本又沒真的執行 git，兩個錯湊成一個假綠燈。）
  const originalBytes = readFileSync(path);
  const normalized = toLf(originalBytes.toString('utf-8'));
  const from = toLf(mutation.from);
  const to = toLf(mutation.to);
  if (!normalized.includes(from)) {
    results.push({ ...mutation, verdict: 'ERROR', detail: '找不到要替換的原始碼片段' });
    console.log(`[${i + 1}/${MUTATIONS.length}] ERROR   ${mutation.name} — 片段不存在`);
    continue;
  }

  writeFileSync(path, normalized.replace(from, to));
  const build = buildAll();
  const { code, out } =
    build.code !== 0 ? { code: -1, out: `BUILD FAILED\n${build.out}` } : run([join('tests', scriptOf(mutation))]);
  writeFileSync(path, originalBytes);

  // 期待：這個突變讓測試失敗，而且失敗的是我們指定的那條斷言。
  const failedLines = out
    .split('\n')
    .filter((line) => line.includes('FAIL '))
    .join(' | ');
  const killedByExpected = failedLines.includes(mutation.expect);
  const verdict =
    code === -1
      ? 'BUILD_FAILED'
      : code === 0
        ? 'SURVIVED'
        : killedByExpected
          ? 'KILLED'
          : 'KILLED(其他斷言)';
  results.push({ ...mutation, verdict, detail: failedLines.slice(0, 200) });
  console.log(
    `[${i + 1}/${MUTATIONS.length}] ${verdict.padEnd(16)} ${mutation.name}` +
      (verdict.startsWith('KILLED') ? `\n${' '.repeat(23)}↳ ${failedLines.slice(0, 160)}` : '')
  );
}

// 每輪都還原了原始碼，最後再確認 worktree 是乾淨的。
// 一定要用 exec() 而不是 run()：run() 只吃一個參數陣列，
// `run('git', [...])` 會把第二個參數整個丟掉、命令根本沒跑，
// 然後印出空字串當成「worktree 乾淨」—— 這正是這支工具在抓的那種假綠燈。
// 最後一個突變還原 src 之後，建置產物仍停在那個突變的狀態。
// 重建一次讓產物回到基準，否則下面的「worktree 應乾淨」會對著自己造成的差異報警。
buildAll();
const status = exec('git', ['status', '--short']);
if (hadConfig) copyFileSync(CONFIG_BAK, CONFIG);
else rmSync(CONFIG, { force: true });

console.log('\n================ 突變測試結果 ================');
const survived = results.filter((r) => r.verdict === 'SURVIVED');
const errored = results.filter((r) => r.verdict === 'ERROR' || r.verdict === 'BUILD_FAILED');
const killedByOther = results.filter((r) => r.verdict === 'KILLED(其他斷言)');
console.log(`總計 ${results.length}：KILLED ${results.length - survived.length - errored.length}` +
  `（其中 ${killedByOther.length} 是被其他斷言抓到）、SURVIVED ${survived.length}、ERROR ${errored.length}`);
for (const r of survived) console.log(`  SURVIVED（假綠燈！）: ${r.name} — 期待 "${r.expect}" 失敗但測試全過`);
for (const r of errored) console.log(`  ERROR: ${r.name} — ${r.detail}`);
for (const r of killedByOther) console.log(`  KILLED(其他斷言): ${r.name} — 期待 "${r.expect}"，實際 ${r.detail}`);
// worktree 沒還原乾淨 = 這一輪的結果不可信（後面的突變是疊在殘留改動上跑的），
// 所以它必須跟 SURVIVED 一樣讓整支腳本以非零碼收場。
const dirty = status.code !== 0 || status.out.trim() !== baselineStatus;
console.log(
  `\nworktree git status（應與開跑時相同）: ${
    status.code !== 0 ? `<git 執行失敗 code=${status.code}>` : JSON.stringify(status.out.trim())
  }`
);
if (dirty) {
  console.log(`  ↳ 與開跑時不同（開跑時：${JSON.stringify(baselineStatus)}）`);
  console.log('  ↳ worktree 沒有還原乾淨，本輪結果不可信');
}
process.exitCode = survived.length > 0 || errored.length > 0 || dirty ? 1 : 0;
