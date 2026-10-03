/**
 * alias 熱切換（config.json aliasModel + set_config 工具）回歸測試。
 *
 * 覆蓋兩層：
 *   1. 純邏輯：resolveModelAlias / isKnownModelTarget 的邊界（含稽核抓出的 prototype key、
 *      alias 當 target、direct-api 空 model 等案例）。
 *   2. 端到端：起一個真的 MCP server（stdio JSON-RPC），驗 set_config 的驗證、寫入、
 *      unset、未知欄位保留，以及「同一個 process 內改設定，組出的指令立刻跟著變」。
 *
 * 設定、狀態、快取都由 test-env 指向暫存目錄，不碰真實使用者檔案。
 * 用法：node verify-alias-config.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = join(process.env.AI_CLI_CONFIG_DIR, 'config.json');

/**
 * fs 刻意走 createRequire 而**不是** `import ... from 'node:fs'`。
 *
 * 靜態 import 會讓 node:fs 的 ESM facade 在這一刻實體化並把 `readFileSync` 綁死；
 * 之後再換掉 `fs.readFileSync`，dist 裡的模組拿到的仍是原函式，計數器就永遠是 0。
 * （這個 0 會讓下面「只讀一次」的斷言直接 FAIL 而不是假通過 —— 是刻意的：
 * 計數器壞掉時要看得出來。）
 */
const fs = createRequire(import.meta.url)('node:fs');
const { copyFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } = fs;
/** 原始實作：測試自己的讀取不該被計進去。 */
const readFileSync = fs.readFileSync;
const configReadCount = { n: 0 };
/**
 * 要注入的讀取錯誤 code（null = 不注入）。
 *
 * 注入必須做在**這個包裝函式裡面**：dist 模組在載入時就把 fs.readFileSync 綁成
 * 目前這個包裝，事後再換掉 fs.readFileSync 它們是看不到的
 * ——那樣寫出來的「注入測試」會變成什麼都沒注入的假綠燈（實際踩過）。
 */
const injected = { code: null };
fs.readFileSync = function (path, ...rest) {
  if (String(path) === CONFIG) {
    configReadCount.n += 1;
    if (injected.code) {
      throw Object.assign(new Error(`${injected.code}: injected read failure`), {
        code: injected.code,
      });
    }
  }
  return readFileSync.call(this, path, ...rest);
};
const BACKUP = `${CONFIG}.verify-alias-backup`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 走目前（已被包裝的）實作讀檔 —— 用來自我檢查注入機制是不是真的生效。 */
const readFileSyncViaPatched = (path) => fs.readFileSync(path, 'utf-8');

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const writeConfig = (obj) => {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, `${JSON.stringify(obj, null, 2)}\n`);
};

/** 暫存 config 也要無條件還原，避免一個注入情境影響後面的斷言。 */
function restoreConfig(hadConfig) {
  // 測試中途會把 config.json 換成「同名目錄」來製造讀取錯誤。如果那段沒清乾淨就跳出來，
  // 這裡的 copyFileSync 會拿到 EISDIR 而拋錯 —— 還原失敗，使用者的設定就只剩備份檔了。
  // 所以還原前一律先強制清掉殘留的目錄。
  try {
    if (existsSync(CONFIG) && fs.statSync(CONFIG).isDirectory()) {
      rmSync(CONFIG, { recursive: true, force: true });
    }
  } catch {
    /* 清不掉就讓下面的還原自己去報錯，不要在這裡吞掉原始問題 */
  }
  if (hadConfig) {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, CONFIG);
      rmSync(BACKUP);
    }
  } else if (existsSync(CONFIG)) {
    // 原本沒有這個檔，就不能把測試寫出來的那份留在使用者機器上。
    rmSync(CONFIG);
  }
}

async function main(baseConfig) {
  const catalog = await load('dist/models/catalog.js');
  const { buildCliCommand } = await load('dist/core/command-builder.js');

  // ---- 1. 純邏輯：isKnownModelTarget ----
  console.log('\n[1] isKnownModelTarget 邊界');
  check('接受既有 model', catalog.isKnownModelTarget('gpt-5.6-terra'));
  check('接受 pattern 命中的新 model', catalog.isKnownModelTarget('gpt-9-future'));
  check('接受 direct-api provider-prefixed', catalog.isKnownModelTarget('or-qwen/qwen3-max'));
  check('拒絕完全不認得的名稱', !catalog.isKnownModelTarget('totally-bogus'));
  // 以下三項是獨立稽核（@codex）抓出來的洞：
  check('拒絕 alias 名稱當 target', !catalog.isKnownModelTarget('agy-ultra'));
  check('拒絕空 direct-api model（or-）', !catalog.isKnownModelTarget('or-'));
  check('拒絕空 direct-api model（ds-）', !catalog.isKnownModelTarget('ds-'));

  // ---- 2. 純邏輯：resolveModelAlias ----
  console.log('\n[2] resolveModelAlias 邊界');
  writeConfig(baseConfig);
  check('無覆寫時走內建表', catalog.resolveModelAlias('codex-ultra') === 'gpt-6-astra');
  check('非 alias 原樣回傳', catalog.resolveModelAlias('opus') === 'opus');
  // 2026-10-03 新增的 codex-ultracode：和 codex-ultra 同一顆旗艦，差別只在 effort 到 ultra。
  // `ultra` 是 codex 的 effort 級別名、不是 model，所以不改 codex-ultra 的語意（破壞性），
  // 而是純加法補上「gpt-6-astra + ultra」這個在此之前沒有任何 alias 的最強組合。
  check(
    'codex-ultracode 解析到旗艦 gpt-6-astra',
    catalog.resolveModelAlias('codex-ultracode') === 'gpt-6-astra',
    catalog.resolveModelAlias('codex-ultracode')
  );
  check('codex-ultracode 路由到 codex', catalog.resolveAgentIdForModel(catalog.resolveModelAlias('codex-ultracode')) === 'codex');
  check('codex-ultracode 被認得是內建 alias（set_config 才設得動它）', catalog.isBuiltinAlias('codex-ultracode'));
  check(
    'codex-ultracode 不能自己當 alias target（alias 只解析一層）',
    !catalog.isKnownModelTarget('codex-ultracode')
  );
  check(
    'codex-ultra 的語意沒被動到（仍是 max，不是 ultra）',
    catalog.MODEL_ALIAS_DETAILS.find((a) => a.name === 'codex-ultra')?.defaultReasoningEffort === 'max'
  );
  // ★ 兩份寫死的 alias effort 表必須一致：
  //   user-config.ts 的 BUILTIN_ALIAS_REASONING 是**執行期真正送出的值**，
  //   catalog.ts 的 MODEL_ALIAS_DETAILS.defaultReasoningEffort 只進 models payload 顯示。
  //   漏改一邊的後果是「畫面上寫 ultra、實際送 max」——而且兩邊都不會報錯。
  {
    const uc = await load('dist/core/user-config.js');
    const mismatched = catalog.MODEL_ALIAS_DETAILS.filter(
      (a) => (a.defaultReasoningEffort ?? null) !== (uc.BUILTIN_ALIAS_REASONING[a.name] ?? null)
    ).map((a) => `${a.name}: payload=${a.defaultReasoningEffort} runtime=${uc.BUILTIN_ALIAS_REASONING[a.name]}`);
    check(
      '★ MODEL_ALIAS_DETAILS 與 BUILTIN_ALIAS_REASONING 的預設 effort 完全一致',
      mismatched.length === 0,
      mismatched.join(' | ')
    );
  }
  const proto = catalog.resolveModelAlias('constructor');
  check('prototype key 不會回傳函式', typeof proto === 'string' && proto === 'constructor',
    `got ${typeof proto}`);


  // ---- 派工建議表（呼叫端是 AI，它讀的是工具回傳，不是 README）----
  {
    const p = catalog.getModelsPayload();
    check('models 帶 dispatchGuidance', Array.isArray(p.dispatchGuidance) && p.dispatchGuidance.length > 0);
    check('models 帶 knownBadModels', Array.isArray(p.knownBadModels) && p.knownBadModels.length > 0);
    check(
      '每筆建議都有 situation / model / note',
      p.dispatchGuidance.every((g) => g.situation && g.model && g.note),
      JSON.stringify(p.dispatchGuidance.filter((g) => !(g.situation && g.model && g.note)))
    );
    // note 寫「為什麼」而不只是「用哪個」：沒有理由的建議會在情況變了之後被照抄，
    // 而讀的人不知道它已經不成立。
    check(
      '每筆建議的 note 都不是空話（至少 10 字）',
      p.dispatchGuidance.every((g) => g.note.length >= 10)
    );
    check(
      '每筆 knownBadModels 都說得出原因',
      p.knownBadModels.every((b) => b.model && b.reason && b.reason.length >= 10)
    );
    check(
      // 名稱刻意不寫死型號：這一列的模型會隨 vendor 換代而改（2026-10-03 已從
      // gpt-5.6-sol 換成 gpt-6.1-sol），而對應突變的 expect 必須是這個名稱的子字串。
      '★ 日常派工建議與模型政策一致（現行 workhorse + 日常 effort，不是一開始就 astra）',
      // 必須綁 situation：只比對 model + effort 的話，把這組設定搬到別的情境、
      // 而「日常派工」那列改錯，斷言照樣會過（2026-10-03 稽核指出的既有覆蓋缺口）。
      p.dispatchGuidance.some(
        (g) => g.situation === '日常派工' && g.model === 'gpt-6.1-sol' && g.reasoningEffort === 'medium'
      ),
      JSON.stringify(p.dispatchGuidance[0])
    );
    check(
      '★ 已知不能用的模型沒有同時出現在建議表裡',
      !p.dispatchGuidance.some((g) => p.knownBadModels.some((b) => g.model === b.model)),
      '建議表不可推薦已知不能用的模型'
    );

    // ---- 清單的語意：兩個方向都不是保證 ----
    // knownBadModels 顧的是「清單有但不能用」；這裡顧的是另一半——
    // 「不在清單但能用」。2026-09-11 有呼叫端因為 fable 不在陣列裡就判定不支援，
    // 繞去找替代方案，而正確答案是直接派。清單沒說自己不是全集，讀的人就當它是。
    check(
      '★ models 帶 modelListCaveat（清單不是 allowlist，要工具自己講）',
      Boolean(p.modelListCaveat?.notAnAllowlist && p.modelListCaveat?.notAGuarantee && p.modelListCaveat?.authority),
      JSON.stringify(p.modelListCaveat)
    );
    check(
      '★ caveat 要講出 catch-all 這個機制（含 matchesModel 永遠回 true），不能只說「可能不完整」',
      // 這裡必須用 ?.：欄位消失正是上一條在守的回歸，直接取值會 TypeError 讓整支中斷，
      // 後面的斷言一條都不會跑，而 harness 只看 stdout 有沒有 FAIL 行，看不出這件事。
      //
      // ★ 為什麼要同時要求 'matchesModel'：原本只檢查有沒有 'catch-all' 或 'fallback'
      //   這兩個關鍵字，而 2026-10-03 改寫 notAnAllowlist 時在**另一句**（講 set_config
      //   的那段）寫進了「catch-all」三個字——於是「把講機制那一行換成『這份清單可能
      //   不完整』」的突變當場 SURVIVED：關鍵字被另一句餵飽，斷言分不出機制還在不在。
      //   改成連 'matchesModel' 一起要求，才真的釘在「說出機制」而不是「出現某個詞」。
      Boolean(
        p.modelListCaveat?.notAnAllowlist?.includes('matchesModel') &&
          (p.modelListCaveat?.notAnAllowlist?.includes('catch-all') ||
            p.modelListCaveat?.notAnAllowlist?.includes('fallback'))
      ),
      p.modelListCaveat?.notAnAllowlist
    );
    // fable 是實際踩到的那一筆：claude --help 列它是合法別名，實測派得動。
    check(
      '★ claude 清單含 fable',
      p.claude.includes('fable'),
      JSON.stringify(p.claude)
    );
  }

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.6-terra' } });
  check('config 覆寫優先於內建表', catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-terra');

  // 快取不可以用 mtime 當鍵：同一毫秒內的兩次寫入 mtime 會相同，讀到的就是過期設定。
  // 這裡把兩次寫入的 mtime 直接鎖成同一個值，讓「同毫秒」這個競態變成必然而非碰運氣。
  // 兩份設定刻意**等長**：長度不同的話，「用檔案長度當快取鍵」這種同樣有問題的實作
  // 也能矇混過關（突變測試證實過）。等長 + 同 mtime，就只剩「真的比對內容」能通過。
  const PINNED_MTIME = 1_700_000_000;
  utimesSync(CONFIG, PINNED_MTIME, PINNED_MTIME);
  catalog.resolveModelAlias('codex-ultra'); // 讓這個 mtime 進快取
  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.3-codex' } });
  utimesSync(CONFIG, PINNED_MTIME, PINNED_MTIME);
  check(
    'mtime 與長度都相同，仍要讀到新內容',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-5.3-codex',
    `got ${catalog.resolveModelAlias('codex-ultra')}`
  );

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.6-terra' } });

  // **暫時性**讀檔失敗（鎖檔、防毒掃描）必須沿用上一次成功的設定，不能靜默退回內建值 ——
  // 否則撞上那一瞬間，這次 run 就會悄悄換成別的 model。
  //
  // 這裡用注入的 EBUSY 而不是「把 config.json 換成目錄」：目錄會得到 EISDIR，
  // 而 EISDIR 是結構性錯誤（見下一條），分類不同。注入也讓這條斷言不依賴平台行為。
  check('先確認覆寫已生效', catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-terra');
  const withReadError = (code, fn) => {
    injected.code = code;
    try {
      return fn();
    } finally {
      injected.code = null;
    }
  };
  // 先確認注入真的有效，否則下面每一條「注入」斷言都可能是什麼都沒發生的假綠燈。
  check(
    '讀取錯誤注入機制本身有效',
    withReadError('EBUSY', () => {
      try {
        readFileSyncViaPatched(CONFIG);
        return false;
      } catch (error) {
        return error.code === 'EBUSY';
      }
    })
  );
  check(
    '暫時性讀檔失敗（EBUSY）維持 last-good 設定',
    withReadError('EBUSY', () => catalog.resolveModelAlias('codex-ultra')) === 'gpt-5.6-terra',
    `got ${withReadError('EBUSY', () => catalog.resolveModelAlias('codex-ultra'))}`
  );

  // 結構性錯誤（路徑被同名目錄佔住 / symlink 迴圈 / 路徑過長）不會自己好，
  // 沿用 last-good 只會讓一份永遠讀不到的設定無限期存活 —— 要退回內建值。
  // 先用注入逐一驗每個 code，再用「真的換成目錄」驗一次端到端。
  //
  // 每一輪都要**先把 last-good 重新建立起來**：結構性分支會清掉快取，
  // 所以第一個 code 跑完之後 cache 就是空的 —— 後面的 code 就算被錯分成「暫時性」，
  // 也會因為沒有 last-good 可用而一樣回內建值，斷言便分辨不出對錯（突變測試證實過）。
  for (const code of ['EISDIR', 'ELOOP', 'ENAMETOOLONG']) {
    writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.6-terra' } });
    catalog.resolveModelAlias('codex-ultra'); // 讓 terra 成為 last-good
    check(
      `結構性讀檔失敗（${code}）退回內建值`,
      withReadError(code, () => catalog.resolveModelAlias('codex-ultra')) === 'gpt-6-astra',
      `got ${withReadError(code, () => catalog.resolveModelAlias('codex-ultra'))}`
    );
  }
  rmSync(CONFIG);
  mkdirSync(CONFIG);
  try {
    check(
      '結構性讀檔失敗（EISDIR）退回內建值',
      catalog.resolveModelAlias('codex-ultra') === 'gpt-6-astra',
      `got ${catalog.resolveModelAlias('codex-ultra')}`
    );
  } finally {
    rmSync(CONFIG, { recursive: true });
  }

  // 相對地，「檔案真的不存在」是使用者的意思，必須退回內建值而不是沿用 last-good。
  check(
    '檔案不存在時退回內建值',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-6-astra',
    `got ${catalog.resolveModelAlias('codex-ultra')}`
  );

  // UTF-8 BOM：Windows 記事本與 PowerShell 5.1 的 Set-Content 都會寫出帶 BOM 的檔案，
  // JSON.parse 看到開頭的 U+FEFF 會直接丟 SyntaxError → 整份設定靜默失效。
  writeFileSync(
    CONFIG,
    `﻿${JSON.stringify({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.4' } }, null, 2)}\n`
  );
  check(
    '帶 UTF-8 BOM 的設定檔仍然生效',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-5.4',
    `got ${catalog.resolveModelAlias('codex-ultra')}`
  );

  // 解析失敗之後，cache 必須被清掉：否則接下來一次讀檔失敗會把這份「使用者已經改壞、
  // 語意上作廢」的舊設定當成 last-good 復活。
  writeFileSync(CONFIG, '{ this is not json');
  check('壞掉的 JSON 退回內建值', catalog.resolveModelAlias('codex-ultra') === 'gpt-6-astra');
  check(
    '壞掉的 JSON 之後遇到暫時性讀檔失敗，不會復活舊設定',
    withReadError('EBUSY', () => catalog.resolveModelAlias('codex-ultra')) === 'gpt-6-astra',
    `got ${withReadError('EBUSY', () => catalog.resolveModelAlias('codex-ultra'))}`
  );

  // 寫入端：**暫時性**讀取失敗時絕不能拿空基底覆寫下去（那會吃掉整份設定與未知欄位）。
  // 這條走 in-process 而不是 MCP，因為 MCP server 是另一個 process，注入不到它的 fs。
  {
    const userConfig = await load('dist/core/user-config.js');
    writeConfig({ ...baseConfig, keepThis: 'important' });
    const before = readFileSync(CONFIG, 'utf-8');
    let thrown = null;
    try {
      withReadError('EBUSY', () => userConfig.updateUserConfig((raw) => (raw.touched = true)));
    } catch (error) {
      thrown = error;
    }
    check(
      '暫時性讀取失敗時 updateUserConfig 拒絕寫入',
      thrown !== null && /Refusing to update/.test(String(thrown?.message)),
      `thrown=${thrown?.message?.slice(0, 100)}`
    );
    check('拒絕寫入後原檔一個 byte 都沒動', readFileSync(CONFIG, 'utf-8') === before);

    // 讀取端與寫入端的「拿不到」判準必須分開：
    // 讀取端把 EISDIR/ELOOP/ENAMETOOLONG 也算成結構性 → 退回內建值（對）；
    // 但寫入端只有 ENOENT（真的沒這個檔）才能用空基底 —— 其餘代表「路徑上有東西、
    // 只是我讀不到」，拿空基底寫下去就會蓋掉還在的資料。
    for (const code of ['EISDIR', 'ELOOP', 'ENAMETOOLONG']) {
      let err = null;
      try {
        withReadError(code, () => userConfig.updateUserConfig((raw) => (raw.touched = true)));
      } catch (error) {
        err = error;
      }
      check(
        `寫入端不把 ${code} 當成「檔案不存在」`,
        err !== null && /Refusing to update/.test(String(err?.message)),
        `thrown=${err?.message?.slice(0, 80)}`
      );
    }
    check('這幾輪拒絕之後原檔仍未被動過', readFileSync(CONFIG, 'utf-8') === before);
  }

  // 陣列的 typeof 也是 'object'：不擋的話 Object.entries 會解出 "0"/"1" 這種垃圾 alias。
  writeConfig({ ...baseConfig, aliasModel: ['gpt-5.4', 'opus'] });
  check(
    'aliasModel 是陣列時整個忽略',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-6-astra' &&
      catalog.resolveModelAlias('0') === '0',
    `got ${catalog.resolveModelAlias('0')}`
  );

  // 根節點是陣列、以及 aliasReasoningEffort 是陣列，也都要整個忽略。
  writeFileSync(CONFIG, JSON.stringify([{ aliasModel: { 'codex-ultra': 'gpt-5.4' } }], null, 2));
  check('根節點是陣列時整份忽略', catalog.resolveModelAlias('codex-ultra') === 'gpt-6-astra');
  // 光看 alias 值分不出來（陣列本來就取不到欄位，兩種實作都回內建值）——
  // 要看 status：有擋才會是 error/parse，沒擋的話會被當成「成功解析出一份空設定」。
  check(
    '根節點是陣列時 status 回報 parse 錯誤',
    catalog.getModelsPayload().userConfig.status?.state === 'error',
    JSON.stringify(catalog.getModelsPayload().userConfig.status)
  );
  writeConfig({ aliasReasoningEffort: ['high', 'low'] });
  check(
    'aliasReasoningEffort 是陣列時整個忽略',
    catalog.getModelsPayload().userConfig.aliasReasoningEffort === undefined,
    JSON.stringify(catalog.getModelsPayload().userConfig.aliasReasoningEffort)
  );

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.6-terra' } });

  // ---- 3. 熱切換真的影響組出來的指令 ----
  console.log('\n[3] 同一個 process 內熱切換');
  const build = () =>
    buildCliCommand({
      prompt: 'hi',
      workFolder: ROOT,
      model: 'codex-ultra',
      cliPaths: { codex: 'codex', claude: 'claude', antigravity: 'agy' },
    });

  let cmd = build();
  check('切換後帶新 --model', cmd.args.includes('gpt-5.6-terra'), JSON.stringify(cmd.args));

  // ---- 3b. 已移除的 agent（kiro / forge）名稱必須明確報錯 ----
  //
  // 這組斷言防的是**靜默路由**：claude 的 matchesModel 是 catch-all 永遠回 true，
  // 所以少了 command-builder 那道攔截，`kiro` 會被 claude 悄悄接走並正常回答，
  // 呼叫端完全不知道自己跑的根本不是 Kiro。所以這裡不只檢查「有沒有丟錯」，
  // 還要檢查「沒有被路由到 claude」。
  console.log('\n[3b] 已移除的 kiro / forge 名稱');
  for (const gone of ['kiro', 'kiro-default', 'kiro-ultra', 'kiro-glm-5', 'forge']) {
    let threw = false;
    let routedTo = null;
    try {
      const built = buildCliCommand({
        prompt: 'hi',
        workFolder: ROOT,
        model: gone,
        cliPaths: { codex: 'codex', claude: 'claude', antigravity: 'agy' },
      });
      routedTo = built.agent;
    } catch (error) {
      threw = /removed in 5\.0\.0/.test(error.message);
    }
    check(
      `已移除的 model 被明確拒絕：${gone}`,
      threw,
      routedTo ? `未報錯，反而被靜默路由到 ${routedTo}` : '報錯訊息未說明已移除'
    );
  }

  // 一次高階操作只准讀一次設定檔。讀兩次的話，中間被改動就會組出
  // 「A 版 alias + B 版 reasoning」這種兩邊都不對的指令 —— 讀取次數就是這件事的代理指標。
  const countConfigReads = (fn) => {
    const before = configReadCount.n;
    fn();
    return configReadCount.n - before;
  };
  const buildReads = countConfigReads(build);
  check('一次 buildCliCommand 只讀一次設定檔', buildReads === 1, `read ${buildReads} times`);
  const payloadReads = countConfigReads(() => catalog.getModelsPayload());
  check('一次 getModelsPayload 只讀一次設定檔', payloadReads === 1, `read ${payloadReads} times`);

  // 已經有 snapshot 時就完全不該再讀 —— set_config 靠這個把「寫入後回報」的那次讀取也省掉，
  // 順便保證回報的就是本次寫入的結果，而不是中途被別人改過的版本。
  const snapshot = (await load('dist/core/user-config.js')).loadUserConfigSnapshot();
  const reusedReads = countConfigReads(() => catalog.getModelsPayload(snapshot));
  check(
    '傳入 snapshot 時 getModelsPayload 完全不讀檔',
    reusedReads === 0,
    `read ${reusedReads} times`
  );

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'opus' } });
  cmd = build();
  check('跨 agent 重指會換 agent', cmd.agent === 'claude', `agent=${cmd.agent}`);

  // 設定檔給 codex-ultra 的 effort 是 ultra、又把它重指到 claude → ultra 對 claude 不成立 →
  // 指令不帶 --effort；payload 也不能回報 ultra。兩邊必須一致（獨立稽核 @codex-gpt-6-astra 抓到
  // payload 那邊只看 supported、不看 allowed）。不沿用 baseConfig：使用者自己的預設可能是 claude
  // 吃得下的值，會遮掉這個案例。
  writeConfig({ aliasModel: { 'codex-ultra': 'opus' }, aliasReasoningEffort: { 'codex-ultra': 'ultra' } });
  cmd = build();
  const repointed = catalog.getModelsPayload().aliases.find((a) => a.name === 'codex-ultra');
  check(
    '重指到 claude 時 ultra 不送出也不回報（payload 與指令一致）',
    cmd.agent === 'claude' &&
      !cmd.args.includes('--effort') &&
      repointed.defaultReasoningEffort === undefined,
    `args=${JSON.stringify(cmd.args)} reported=${repointed.defaultReasoningEffort}`
  );

  writeConfig(baseConfig);
  cmd = build();
  check('移除覆寫後退回內建', cmd.agent === 'codex' && cmd.args.includes('gpt-6-astra'));

  // ---- 3c. gpt-6-astra 與 ultra / max effort（2026-09-05 加入）----
  //
  // 這組斷言釘三件事：(1) codex 真的把 ultra / max 送進指令；(2) claude 不收 ultra，
  // 而且錯誤是「agent 專屬」的那種（不是被全域集合擋下，那樣訊息會誤導成值本身不存在）；
  // (3) 設定檔給的 ultra 落到 claude 時靜默略過而不是讓整個 run 失敗——README 承諾過這件事。
  console.log('\n[3c] gpt-6-astra 與 ultra / max effort');
  const buildWith = (model, reasoning_effort) =>
    buildCliCommand({
      prompt: 'hi',
      workFolder: ROOT,
      model,
      reasoning_effort,
      cliPaths: { codex: 'codex', claude: 'claude', antigravity: 'agy' },
    });
  // 明確指定的 effort 不合法時 buildCliCommand 會拋例外。這裡要把它變成 FAIL 而不是讓整支
  // 腳本中斷——中斷會讓後面的斷言（包括第 4 節的 set_config）一條都跑不到，突變測試就會
  // 把「該抓到的斷言」誤判成「被其他斷言抓到」（實測過）。
  const tryBuild = (model, reasoning_effort) => {
    try {
      return { cmd: buildWith(model, reasoning_effort) };
    } catch (error) {
      return { error: error.message };
    }
  };
  check('gpt-6-astra 列在已知模型清單', catalog.listKnownModels().includes('gpt-6-astra'));
  check('gpt-6-astra 路由到 codex', catalog.resolveAgentIdForModel('gpt-6-astra') === 'codex');
  // 內建預設要在「沒有任何使用者設定」下看，否則會被使用者自己的 defaultReasoningEffort 蓋掉。
  writeConfig({});
  cmd = build();
  check(
    'codex-ultra 內建預設為 max（送出 --model gpt-6-astra 與 model_reasoning_effort=max）',
    cmd.args.includes('model_reasoning_effort=max') && cmd.args.includes('gpt-6-astra'),
    JSON.stringify(cmd.args)
  );
  // ★ codex-ultracode 的重點是「不必手動帶 effort 也會送出 ultra」——
  //   這條才是它和 codex-ultra 的實際差別。payload 寫得再對，送出的值錯了就沒意義。
  {
    const uc = buildWith('codex-ultracode', undefined);
    check(
      '★ codex-ultracode 不帶 effort 時送出 --model gpt-6-astra 與 model_reasoning_effort=ultra',
      uc.agent === 'codex' &&
        uc.args.includes('gpt-6-astra') &&
        uc.args.includes('model_reasoning_effort=ultra'),
      JSON.stringify(uc.args)
    );
  }
  let built = tryBuild('gpt-6-astra', 'ultra');
  check(
    'codex 明確指定 ultra 會送出 model_reasoning_effort=ultra',
    !!built.cmd && built.cmd.args.includes('model_reasoning_effort=ultra'),
    built.error ?? JSON.stringify(built.cmd.args)
  );
  built = tryBuild('gpt-6-astra', 'max');
  check(
    'codex 明確指定 max 會送出 model_reasoning_effort=max',
    !!built.cmd && built.cmd.args.includes('model_reasoning_effort=max'),
    built.error ?? JSON.stringify(built.cmd.args)
  );
  // 2026-09-26 補的兩個 GPT-6 家族成員（codex-cli 0.155.1 的 models_cache.json）：
  // sol 到 ultra、luna 到 max。清單與路由是兩件事——`gpt-` 前綴本來就會路由到 codex，
  // 清單管的是「models 有沒有把它當候選講出來」，所以兩件都要釘。
  for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
    check(`${model} 列在已知模型清單`, catalog.listKnownModels().includes(model));
    check(`${model} 路由到 codex`, catalog.resolveAgentIdForModel(model) === 'codex');
  }
  built = tryBuild('gpt-6-sol', 'ultra');
  check(
    'gpt-6-sol 明確指定 ultra 會送出 --model gpt-6-sol 與 model_reasoning_effort=ultra',
    !!built.cmd && built.cmd.args.includes('gpt-6-sol') && built.cmd.args.includes('model_reasoning_effort=ultra'),
    built.error ?? JSON.stringify(built.cmd.args)
  );
  built = tryBuild('gpt-6-luna', 'max');
  check(
    'gpt-6-luna 明確指定 max 會送出 --model gpt-6-luna 與 model_reasoning_effort=max',
    !!built.cmd && built.cmd.args.includes('gpt-6-luna') && built.cmd.args.includes('model_reasoning_effort=max'),
    built.error ?? JSON.stringify(built.cmd.args)
  );
  // 2026-10-03 依 codex-cli 0.160.0 所用的 models_cache.json：補 priority 1 的
  // gpt-6.1-sol，並把五個已不在 vendor 目錄的舊名稱移出清單。
  // （不引用 fetched_at：那個欄位每隔幾分鐘就被重抓。當日讀三次內容相同。）
  check('gpt-6.1-sol 列在已知模型清單', catalog.listKnownModels().includes('gpt-6.1-sol'));
  check('gpt-6.1-sol 路由到 codex', catalog.resolveAgentIdForModel('gpt-6.1-sol') === 'codex');
  built = tryBuild('gpt-6.1-sol', 'ultra');
  check(
    'gpt-6.1-sol 明確指定 ultra 會送出 --model gpt-6.1-sol 與 model_reasoning_effort=ultra',
    !!built.cmd && built.cmd.args.includes('gpt-6.1-sol') && built.cmd.args.includes('model_reasoning_effort=ultra'),
    built.error ?? JSON.stringify(built.cmd.args)
  );
  // 清單依 vendor priority 排序：gpt-6.1-sol 是 priority 1，排在 gpt-6-astra 之前。
  {
    const codexNames = catalog.listKnownModels().filter((m) => m.startsWith('gpt-'));
    check(
      'codex 清單依 vendor priority 把 gpt-6.1-sol 排在 gpt-6-astra 之前',
      codexNames.indexOf('gpt-6.1-sol') >= 0 &&
        codexNames.indexOf('gpt-6.1-sol') < codexNames.indexOf('gpt-6-astra'),
      JSON.stringify(codexNames)
    );
  }
  // ★ 排序 ≠ 強度。gpt-6.1-sol 是 vendor 的 priority 1，但它是 workhorse
  //   （"near-Astra performance at a lower cost"），旗艦仍是 gpt-6-astra。
  //   所以 codex-ultra 不可以因為「有更新的名字」就改指過去。
  check(
    'codex-ultra 仍指向旗艦 gpt-6-astra，不因 gpt-6.1-sol 較新而改指',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-6-astra',
    catalog.resolveModelAlias('codex-ultra')
  );
  // vendor 標 visibility: "hide" 的內部條目不該出現在對外候選清單。
  for (const hidden of ['gpt-reserve', 'codex-auto-review']) {
    check(
      `${hidden} 不列在已知模型清單（vendor 標 visibility: hide）`,
      !catalog.listKnownModels().includes(hidden)
    );
  }
  // ★ 移出清單 ≠ 擋下來。這五個已不在 vendor 目錄，所以不再當候選廣告出去，
  //   但 matchesModel 是 startsWith('gpt-')，明確指定仍然會路由到 codex，
  //   也仍然設得成 alias target。兩件事分開釘，避免日後有人誤以為移除就等於封鎖。
  for (const gone of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2']) {
    check(`${gone} 已不在已知模型清單`, !catalog.listKnownModels().includes(gone));
    check(`${gone} 移出清單後仍路由到 codex（移除不等於擋下）`, catalog.resolveAgentIdForModel(gone) === 'codex');
    check(`${gone} 移出清單後仍設得成 alias target`, catalog.isKnownModelTarget(gone));
  }
  let claudeErr = '';
  try {
    buildWith('sonnet', 'ultra');
  } catch (error) {
    claudeErr = error.message;
  }
  check(
    'claude 明確指定 ultra 被拒絕（agent 專屬錯誤）',
    /Claude reasoning_effort supports only/.test(claudeErr),
    claudeErr ? `got: ${claudeErr}` : '未報錯'
  );
  writeConfig({ defaultReasoningEffort: 'ultra' });
  cmd = buildWith('sonnet', undefined);
  check(
    '設定檔的 ultra 落到 claude 時靜默略過（不帶 --effort）',
    cmd.agent === 'claude' && !cmd.args.includes('--effort'),
    JSON.stringify(cmd.args)
  );
  cmd = buildWith('gpt-5.5', undefined);
  check(
    '設定檔的 ultra 落到 codex 時照送',
    cmd.agent === 'codex' && cmd.args.includes('model_reasoning_effort=ultra'),
    JSON.stringify(cmd.args)
  );
  writeConfig(baseConfig);

  // ---- 4. 端到端 set_config ----
  console.log('\n[4] set_config 端到端（真的起一個 MCP server）');
  // 這一段刻意不沿用使用者的 baseConfig：斷言會比對「退回內建值」，
  // 沿用的話結果會被使用者自己的 defaultReasoningEffort 影響而變得不可預期。
  writeConfig({ myCustomThing: { keep: 'me' } });
  await mcpChecks();

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

async function mcpChecks() {
  const child = spawn(process.execPath, [join(ROOT, 'dist/bin/ai-cli-mcp.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* 非 JSON 行（啟動訊息）略過 */
      }
    }
  });

  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = (name, args) => send('tools/call', { name, arguments: args });
  const aliasOf = (res, name) =>
    JSON.parse(res.result.content[0].text).aliases.find((a) => a.name === name);

  try {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify', version: '0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const tools = await send('tools/list', {});
    check('set_config 已註冊', tools.result.tools.some((t) => t.name === 'set_config'));

    let res = await call('set_config', { alias_model: { 'codex-ultra': 'gpt-5.6-terra' } });
    const row = aliasOf(res, 'codex-ultra');
    check('set_config 寫入生效', row.resolvesTo === 'gpt-5.6-terra' && row.source === 'config');
    check('回報內建原值', row.builtinResolvesTo === 'gpt-6-astra');

    const onDisk = JSON.parse(readFileSync(CONFIG, 'utf-8'));
    check('保留設定檔中的未知欄位', onDisk.myCustomThing?.keep === 'me');

    res = await call('set_config', { alias_model: { 'codex-ultra': 'totally-bogus' } });
    check('拒絕未知 model', !!res.error);
    res = await call('set_config', { alias_model: { 'codex-ultra': 'or-' } });
    check('拒絕空 direct-api model', !!res.error);
    res = await call('set_config', { alias_model: { 'codex-ultra': 'agy-ultra' } });
    check('拒絕 alias 當 target', !!res.error);
    res = await call('set_config', { alias_model: { 'nope-ultra': 'gpt-5.4' } });
    check('拒絕未知 alias', !!res.error);
    res = await call('set_config', { alias_model: { constructor: 'opus' } });
    check('拒絕 prototype key 當 alias', !!res.error);
    // __proto__ 與 constructor 不同：普通 {} 的 out['__proto__'] = 字串會被 Object.prototype
    // 的 setter 無聲吃掉，key 根本不會出現在 own properties，驗證迴圈掃不到 → 假成功。
    // **一定要用 computed key**：物件字面值裡的 `{ __proto__: 'opus' }` 是在設定原型，
    // 不會產生 own property，JSON.stringify 出來是 `{}` —— 那樣等於根本沒把 __proto__
    // 送出去，測到的是「拒絕空 map」而不是 prototype 防禦（獨立稽核 @gemini-3.1-pro 抓到）。
    res = await call('set_config', { alias_model: { ['__proto__']: 'opus' } });
    check(
      '拒絕 __proto__ 當 alias（且是以「未知 alias」為由）',
      !!res.error && /Unknown alias/.test(JSON.stringify(res.error)),
      JSON.stringify(res.error ?? res.result)?.slice(0, 200)
    );
    res = await call('set_config', { alias_model: {} });
    check('拒絕空的 alias_model（假成功）', !!res.error);
    res = await call('set_config', {});
    check('拒絕空的變更', !!res.error);
    res = await call('set_config', { alias_reasoning_effort: { 'codex-ultra': 'nonsense' } });
    check('拒絕不合法的 reasoning effort', !!res.error);
    // ultra 是 2026-09-05 才進全域集合的；set_config 的驗證走 ALLOWED_REASONING_EFFORTS，
    // 少了它會把「合法的新值」當成打錯字拒絕。
    res = await call('set_config', { default_reasoning_effort: 'ultra' });
    check(
      'set_config 接受 ultra 為全域預設',
      !res.error && !!res.result,
      JSON.stringify(res.error ?? '').slice(0, 200)
    );
    res = await call('set_config', { unset: ['defaultReasoningEffort'] });
    check('unset defaultReasoningEffort 成功', !res.error && !!res.result);

    // 設定檔已經壞掉時，set_config 絕對不能拿空基底套上 patch 寫回去 ——
    // 那會把使用者原本的內容整份吃掉。必須明確失敗、原檔一個 byte 都不許動。
    const corrupted = '{ "aliasModel": { "codex-ultra": "gpt-5.4" }, oops';
    writeFileSync(CONFIG, corrupted);
    res = await call('set_config', { alias_model: { 'claude-ultra': 'haiku' } });
    check('設定檔壞掉時 set_config 明確失敗', !!res.error);
    check(
      '設定檔壞掉時不覆寫原檔',
      readFileSync(CONFIG, 'utf-8') === corrupted,
      `file changed to: ${readFileSync(CONFIG, 'utf-8').slice(0, 60)}`
    );

    // parser 會忽略陣列型的 aliasModel，但 set_config 若直接 spread 它，
    // `{ ...['a','b'] }` 會生出 "0"/"1" 兩個 key 寫回磁碟 ——
    // 那些垃圾就從「被忽略」升級成「parser 認可的 alias」。
    writeConfig({ aliasModel: ['gpt-5.4', 'opus'] });
    res = await call('set_config', { alias_model: { 'claude-ultra': 'haiku' } });
    const afterArray = JSON.parse(readFileSync(CONFIG, 'utf-8'));
    check(
      'set_config 不會把陣列 aliasModel 轉成數字 alias',
      !!res.result &&
        !Object.prototype.hasOwnProperty.call(afterArray.aliasModel ?? {}, '0') &&
        afterArray.aliasModel?.['claude-ultra'] === 'haiku',
      JSON.stringify(afterArray.aliasModel)
    );

    writeConfig({ myCustomThing: { keep: 'me' } });

    // alias 指到不支援 reasoning 的 agent 時，不該回報一個不會生效的 effort
    res = await call('set_config', { alias_model: { 'codex-ultra': 'agy' } });
    const agyRow = aliasOf(res, 'codex-ultra');
    check('跨 agent 後 agent 欄位跟著變', agyRow.agent === 'antigravity', `agent=${agyRow.agent}`);
    check(
      '不支援 reasoning 就不回報 effort',
      agyRow.defaultReasoningEffort === undefined,
      `got ${agyRow.defaultReasoningEffort}`
    );

    // unset 一個 alias 必須同時清掉 model 與 reasoning 兩種覆寫（README 這樣寫）：
    // 先把兩種都設起來，再 unset，然後檢查兩者都回到內建值。
    res = await call('set_config', {
      alias_model: { 'codex-ultra': 'gpt-5.4' },
      alias_reasoning_effort: { 'codex-ultra': 'low' },
    });
    check(
      'unset 前兩種覆寫都生效',
      aliasOf(res, 'codex-ultra').resolvesTo === 'gpt-5.4' &&
        aliasOf(res, 'codex-ultra').defaultReasoningEffort === 'low',
      JSON.stringify(aliasOf(res, 'codex-ultra'))
    );

    res = await call('set_config', { unset: ['codex-ultra'] });
    const back = aliasOf(res, 'codex-ultra');
    check('unset 退回內建', back.resolvesTo === 'gpt-6-astra' && back.source === 'builtin');
    check(
      'unset 同時清掉 reasoning 覆寫',
      back.defaultReasoningEffort === 'max',
      `got ${back.defaultReasoningEffort}`
    );
  } finally {
    child.kill();
  }
}

// 備份與還原包在 try/finally 外層：任何一步拋例外（import 失敗、spawn 失敗、
// JSON parse 失敗）都不能把暫存 config.json 留在測試中途的狀態。
const hadConfig = existsSync(CONFIG);
if (hadConfig) copyFileSync(CONFIG, BACKUP);
const baseConfig = hadConfig ? JSON.parse(readFileSync(CONFIG, 'utf-8')) : {};

// finally 對 Ctrl-C 沒有保護力。這支測試動的是隔離的暫存設定檔，
// 被中斷時至少要把它還原回去再走。
let restored = false;
const restoreOnce = () => {
  if (restored) return;
  restored = true;
  restoreConfig(hadConfig);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    restoreOnce();
    process.exit(130);
  });
}

try {
  await main(baseConfig);
} finally {
  restoreOnce();
}
