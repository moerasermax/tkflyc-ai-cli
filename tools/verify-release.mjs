/**
 * 發版前檢查：掛在 package.json 的 prepublishOnly，`npm publish` 會先跑它，任何一項不過就擋下發佈。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * 這個專案發版出過兩種事故，都是「打包出去的東西」跟「以為要發的東西」不一致：
 *   - npm 上的 6.0.0 是從比 tag v6.0.0 多 13 個 commit 的工作樹發出去的（已 deprecate）。
 *   - 2026-10-06 發 6.4.0 時，ai-cli 派的 agent 把備份與 log 寫進 dist/，dist 被 .gitignore、
 *     git status 看不到，但 package.json 的 files 收整個 dist，tarball 多了 19 個檔；那次只因
 *     npm 沒登入而失敗，才沒發出去。當時的檢查只看了 NOTICE 與版本號，沒逐檔核對清單。
 *
 * 檢查項目：
 *   1. 工作樹乾淨（追蹤中的檔案沒有未提交的改動）
 *   2. HEAD 就是 tag v<package.json 版本> 指向的 commit
 *   3. 打包清單逐檔核對：dist/ 底下每個檔都必須是某支 src/*.ts 編譯出來的 .js / .js.map
 *      （連「原始碼刪了、dist 還留著舊 .js」也抓得到）；其餘只能是 files 列出的文件
 *   4. NOTICE 在套件裡（CLAUDE.md 紅線 1）
 *
 * 用法：
 *   node tools/verify-release.mjs           發版前（prepublishOnly 會自動跑）
 *   node tools/verify-release.mjs --no-tag  開發中先核對打包內容，跳過 1、2
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const noTag = process.argv.includes('--no-tag');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const results = [];
function check(ok, name, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

// npm 底下跑時用同一支 npm（npm_execpath），單獨執行時退回 PATH 上的 npm。
function npm(args) {
  const viaNpm = process.env.npm_execpath;
  const r = viaNpm
    ? spawnSync(process.execPath, [viaNpm, ...args], { cwd: ROOT, encoding: 'utf8' })
    // Windows 的 npm 是 .cmd，要經過 shell；參數都是本檔寫死的字串，組成單一命令即可（避開 DEP0190）。
    : process.platform === 'win32'
      ? spawnSync(`npm ${args.join(' ')}`, { cwd: ROOT, encoding: 'utf8', shell: true })
      : spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  return r;
}

console.log(`發版檢查 ${pkg.name}@${pkg.version}${noTag ? '（--no-tag：跳過工作樹與 tag 檢查）' : ''}\n`);

if (!noTag) {
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  check(dirty === '', '工作樹乾淨（追蹤中的檔案沒有未提交的改動）', dirty ? dirty.split('\n').slice(0, 5).join(' | ') : '');
  const tag = `v${pkg.version}`;
  let tagCommit = '';
  try { tagCommit = git('rev-parse', `${tag}^{}`); } catch { /* tag 不存在 */ }
  const head = git('rev-parse', 'HEAD');
  check(tagCommit !== '' && tagCommit === head, `★ HEAD 就是 ${tag} 指向的 commit`,
    tagCommit ? `HEAD=${head.slice(0, 7)} ${tag}=${tagCommit.slice(0, 7)}` : `${tag} 不存在（先跑 npm version）`);
}

// prepublishOnly 在 prepare（build）之前執行，所以這裡先 build，再用 --ignore-scripts 打包核對，
// 核對的才是真正會發出去的 dist。
const build = npm(['run', 'build']);
check(build.status === 0, 'build 成功', build.status === 0 ? '' : (build.stderr || build.stdout).slice(-300));

const pack = npm(['pack', '--dry-run', '--json', '--ignore-scripts']);
let files = [];
try { files = JSON.parse(pack.stdout)[0].files.map((f) => f.path.replace(/\\/g, '/')); } catch { /* 下面會判 FAIL */ }
check(files.length > 0, 'npm pack --dry-run 拿得到打包清單', files.length ? `${files.length} 個檔案` : (pack.stderr || '').slice(-300));

const allowedTop = new Set(['package.json', ...pkg.files.filter((f) => !f.startsWith('dist'))]);
const unexpected = files.filter((f) => {
  if (allowedTop.has(f)) return false;
  const m = f.match(/^dist\/(.+)\.js(\.map)?$/);
  return !m || !existsSync(join(ROOT, 'src', `${m[1]}.ts`));
});
check(unexpected.length === 0, '★ 打包清單沒有多餘的檔案（dist 只能是 src 編譯出來的 .js / .js.map）',
  unexpected.length ? unexpected.slice(0, 10).join(', ') + (unexpected.length > 10 ? ` …共 ${unexpected.length} 個` : '') : '');
check(files.includes('NOTICE'), 'NOTICE 在套件裡（紅線 1：不可移出 files）');

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\nFAIL: ${results.length - failed} passed, ${failed} failed——不要發佈` : `\nPASS: ${results.length} passed, 0 failed`);
process.exitCode = failed ? 1 : 0;
