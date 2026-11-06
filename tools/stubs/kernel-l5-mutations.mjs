/**
 * L5 定向突變：只複製工作快照，不建／切分支；沿用未修改的 mutation-test.mjs。
 * 斷言從正式 verify 腳本擷取，沒有另一套測試實作。完整驗證仍由原腳本負責。
 * 證據與暫存均留在 docs/ai-cli_kernel/*.log，node_modules 連結只用 unlink 收尾。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = join(ROOT, 'docs', 'ai-cli_kernel', 'l5-mutations.log');
mkdirSync(evidence, { recursive: true });
const home = mkdtempSync(join(evidence, 'run-'));
const snapshot = join(home, 'snapshot');
const scratch = join(home, 'scratch');
mkdirSync(scratch);
const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch, GIT_CEILING_DIRECTORIES: scratch };
const read = path => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const source = read('tests/verify-ai-cli_kernel.mjs');
const slice = (text, begin, end) => {
  const a = text.indexOf(begin), b = text.indexOf(end, a + begin.length);
  if (a < 0 || b <= a || text.indexOf(begin, a + begin.length) >= 0) throw new Error(`區段定位失敗：${begin}`);
  return text.slice(a, b);
};
const prelude = source.slice(0, source.indexOf('/* ---- 完整流程 ---- */'));
const helpers = slice(source, 'const { realWorkspace, outOfScope', '\n{\n  const repo = newRepo();\n  const ctx');
const bare = slice(source, 'function bareOrigin(repo) {', 'function continueCheckpoint(');
const mandates = slice(source, '/* ---- L5 第一部分：', '/* ---- L5 主動觸發與排程：');
const triggers = slice(source, '/* ---- L5 主動觸發與排程：', '/* ---- 命名與依賴方向 ---- */');
const prefix = triggers.slice(0, triggers.indexOf('  clear(); rmSync(switchPath'));
const end = '\n  setEnabled(false); clear();\n}\n';
const summary = '\nconsole.log(`\\n${passed} passed, ${failed} failed`);\nprocess.exit(failed ? 1 : 0);\n';
const options = process.argv.slice(2);
if (options.length && (options.length !== 2 || options[0] !== '--name' || !options[1])) throw new Error('用法：node tools/stubs/kernel-l5-mutations.mjs [--name 名稱子字串]');
const all = JSON.parse(read('tools/mutations.json')).filter(item => /^kernel (mandate|triggers|schedule|L5 收尾)：/.test(item.name) && (!options.length || item.name.includes(options[1])));
if (!all.length) throw new Error('沒有 L5 突變，拒絕空跑');
const groups = [
  { name: 'mandates', mutations: all.filter(item => item.file.endsWith('/mandates.ts')), body: mandates },
  { name: 'triggers', mutations: all.filter(item => item.file.endsWith('/triggers.ts') && !item.name.includes('Codex 專案 hook')), body: triggers.slice(0, triggers.indexOf('  const remote = bareOrigin(repo);')) + end },
  { name: 'hooks-integration', mutations: all.filter(item => item.name.includes('Codex 專案 hook')), body: triggers },
  { name: 'schedule', mutations: all.filter(item => item.file.endsWith('/schedule.ts')), body: prefix + "  clear(); setEnabled(true); saveApproved();\n" + triggers.slice(triggers.indexOf('  // 所有 schedule 呼叫')) },
];
if (groups.reduce((n, group) => n + group.mutations.length, 0) !== all.length) throw new Error('突變未完整分組');
for (const path of ['src', 'tools/stubs']) cpSync(join(ROOT, path), join(snapshot, path), { recursive: true });
for (const path of ['package.json', 'tsconfig.json', 'tools/mutation-test.mjs']) cpSync(join(ROOT, path), join(snapshot, path));
mkdirSync(join(snapshot, 'tests'));
const link = join(snapshot, 'node_modules');
symlinkSync(join(ROOT, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
const originals = new Map([...new Set(all.map(item => item.file))].map(path => [path, readFileSync(join(snapshot, path))]));
const results = [];
try {
  for (const group of groups) {
    if (!group.mutations.length) continue;
    writeFileSync(join(snapshot, 'tools', 'mutations.json'), JSON.stringify(group.mutations, null, 2));
    writeFileSync(join(snapshot, 'tests', 'verify-ai-cli_kernel.mjs'), prelude + helpers + bare + group.body + summary);
    const result = spawnSync(process.execPath, [join(snapshot, 'tools', 'mutation-test.mjs'), snapshot, '--script', 'verify-ai-cli_kernel.mjs'], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 1800000, maxBuffer: 8 * 1024 * 1024 });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    writeFileSync(join(home, `${group.name}.log`), output);
    const killed = [...output.matchAll(/^\[\d+\/\d+\] KILLED\s+/gm)].length;
    const restored = [...originals].every(([path, bytes]) => readFileSync(join(snapshot, path)).equals(bytes));
    const valid = result.status === 0 && killed === group.mutations.length && !/KILLED\(其他斷言\)|SURVIVED（|BUILD_FAILED|\] ERROR/.test(output) && restored;
    results.push({ group: group.name, total: group.mutations.length, killed, restored, exitCode: result.status, valid, error: result.error?.message });
    console.log(JSON.stringify(results.at(-1)));
    if (!valid) { console.log(output.slice(-4000)); process.exitCode = 1; break; }
  }
} finally {
  unlinkSync(link); // 只解除連結，絕不遞迴刪除相依套件。
  if (!existsSync(join(ROOT, 'node_modules', 'typescript', 'package.json'))) throw new Error('主工作目錄相依套件檢查失敗');
  const report = { testSha256: createHash('sha256').update(source).digest('hex'), extractedFrom: 'tests/verify-ai-cli_kernel.mjs', harness: 'tools/mutation-test.mjs (unmodified copy)', groups: results };
  writeFileSync(join(home, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`evidence: ${relative(ROOT, home)}`);
}
