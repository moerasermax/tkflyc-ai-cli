/**
 * 突變清單（`tools/mutations.json`）自身的健康檢查。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * 2026-10-03 發現 5 筆突變**永遠套用不了**，跑到就是 ERROR：4 筆的 `from` 片段內含 CRLF
 * （而 harness 當時只正規化原始碼、不正規化片段），1 筆的片段早就被重構掉了。
 *
 * 它們之所以潛伏那麼久，不是因為 harness 不報——ERROR 會逐筆印、也會讓整支以非零碼收場——
 * 而是因為**那兩支腳本的突變平時沒人跑**：突變測試要先開 worktree、建 node_modules junction，
 * 每一筆還各跑一次 `tsc`，所以實務上只會針對「這次改到的檔案」跑相關的幾支。
 * 於是「某筆突變從加進來那天起就沒測到任何東西」這件事，可以安靜地活很久。
 *
 * 這一支把「清單本身對不對」從突變測試裡拆出來，變成 `npm test` 的一部分：
 * 純讀檔、不建置、不需要 worktree、不碰使用者目錄，所以每次都跑得起。
 * 它**不驗**斷言殺不殺得掉突變（那只有真的跑 harness 才知道），
 * 只驗「這筆突變至少還套得上、而且套得到唯一的那一處」。
 *
 * ★ 為什麼要求「恰好一次」而不是「至少一次」：harness 用的是 `String.replace`，
 *   它只換第一個命中。片段在檔案裡出現兩次時，改到的是哪一處取決於檔案順序——
 *   那個突變驗的就不是你以為的那一段，而且同樣沒有任何訊號。
 *   解法是把片段往外擴到唯一（連上一行，或連著它所屬的結構）。
 *
 * 用法：node verify-mutation-manifest.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 原始碼與比對片段都要在 LF 空間比——與 tools/mutation-test.mjs 的 toLf 同語意。 */
const toLf = (text) => text.replace(/\r\n/g, '\n');

const MANIFEST = join(ROOT, 'tools', 'mutations.json');
const mutations = JSON.parse(readFileSync(MANIFEST, 'utf-8'));

console.log(`突變清單：${mutations.length} 筆`);

check(Array.isArray(mutations) && mutations.length > 0, '清單是非空陣列');

// ---- 欄位齊全 ----
// `to` 刻意允許空字串：那是「把這幾行刪掉」的突變（例如把 'ELOOP' 從集合裡拿掉），
// 完全合法。只有 name/file/from/expect 不能為空。"to 有沒有改到東西" 由下面的 from !== to 守。
const REQUIRED_NONEMPTY = ['name', 'file', 'from', 'expect'];
const missingFields = mutations
  .map((m, i) => {
    const miss = REQUIRED_NONEMPTY.filter((k) => typeof m[k] !== 'string' || m[k].length === 0);
    if (typeof m.to !== 'string') miss.push('to(非字串)');
    return miss.length ? `#${i} ${m.name ?? '(無名)'} 缺 ${miss.join('/')}` : null;
  })
  .filter(Boolean);
check(missingFields.length === 0, '每筆都有 name/file/from/expect，且 to 是字串', missingFields.join(' | '));

// ---- 名稱唯一（harness 的報表與 CHANGELOG 都靠名稱指認） ----
const dupNames = [...new Set(mutations.map((m) => m.name).filter((n, i, a) => a.indexOf(n) !== i))];
check(dupNames.length === 0, '突變名稱不重複', dupNames.join(' | '));

// ---- to 必須真的改變了什麼 ----
const noop = mutations.filter((m) => m.from === m.to).map((m) => m.name);
check(noop.length === 0, '每筆的 to 都與 from 不同（否則什麼都沒改壞）', noop.join(' | '));

// ---- 目標檔存在 ----
const sources = new Map();
const readSource = (file) => {
  if (!sources.has(file)) {
    const path = join(ROOT, file);
    sources.set(file, existsSync(path) ? toLf(readFileSync(path, 'utf-8')) : null);
  }
  return sources.get(file);
};
const missingFiles = [...new Set(mutations.filter((m) => readSource(m.file) === null).map((m) => m.file))];
check(missingFiles.length === 0, '每筆的目標檔都存在', missingFiles.join(' | '));

// ---- ★ 片段恰好命中一次 ----
const hitCounts = mutations.map((m) => {
  const src = readSource(m.file);
  if (src === null) return { m, hits: null };
  return { m, hits: src.split(toLf(m.from)).length - 1 };
});
const zeroHit = hitCounts.filter((x) => x.hits === 0).map((x) => `${x.m.name}（${x.m.file}）`);
const multiHit = hitCounts
  .filter((x) => x.hits !== null && x.hits > 1)
  .map((x) => `${x.m.name}（${x.m.file} ×${x.hits}）`);
check(
  zeroHit.length === 0,
  '★ 每筆的 from 片段都還存在於原始碼（不存在＝這筆什麼都沒測）',
  zeroHit.join(' | ')
);
check(
  multiHit.length === 0,
  '★ 每筆的 from 片段都只命中一處（replace 只換第一個，多處＝測到的不是你以為的那段）',
  multiHit.join(' | ')
);

// ---- script 要指向真的存在的 verify 腳本 ----
const DEFAULT_SCRIPT = 'verify-alias-config.mjs';
const badScript = [
  ...new Set(
    mutations
      .map((m) => m.script ?? DEFAULT_SCRIPT)
      .filter((s) => !existsSync(join(ROOT, 'tests', s)))
  ),
];
check(badScript.length === 0, '每筆的 script 都指向存在的 verify 腳本', badScript.join(' | '));

// ---- 這裡刻意**不**檢查 expect 是不是對應腳本裡的字面子字串 ----
// 有些斷言名稱是迴圈裡的模板字串（`${model} 列在已知模型清單`），字面值不存在於原始碼，
// 靜態檢查會產生大量假警報。而 expect 帶不帶「★」也無所謂：check() 印的是 `FAIL ${name}`，
// 名稱本身就含星號，所以帶星號的 expect 一樣命中。
// 「expect 有沒有對到該抓的那條斷言」只有實跑 harness 才判得出來
// （verdict 是 KILLED 還是 KILLED(其他斷言)），那不是這一支的職責。

const failed = results.filter(([ok]) => !ok).length;
if (failed > 0) {
  console.log(`\nFAIL: ${results.length - failed} passed, ${failed} failed`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: ${results.length} passed, 0 failed`);
}
