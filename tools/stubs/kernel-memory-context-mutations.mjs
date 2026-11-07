/**
 * L5 記憶定向突變：擷取正式驗證區段，在授權的 .log 目錄測未提交快照。
 * 不 commit、不建立分支；沿用正式 mutation-test harness，不複製另一套斷言。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = join(ROOT, 'docs', 'ai-cli_kernel', 'memory-mutations.log');
mkdirSync(evidence, { recursive: true });
const home = mkdtempSync(join(evidence, 'run-'));
const snapshot = join(home, 'snapshot');
const scratchRoot = join(ROOT, 'docs', 'ai-cli_kernel', 't.log');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, 'm-'));
const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch, GIT_CEILING_DIRECTORIES: scratch };
const read = path => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const source = read('tests/verify-ai-cli_kernel.mjs');
const slice = (begin, end) => {
  const a = source.indexOf(begin), b = source.indexOf(end, a + begin.length);
  if (a < 0 || b <= a) throw new Error(`區段定位失敗：${begin}`);
  return source.slice(a, b);
};
const prelude = source.slice(0, source.indexOf('/* ---- 完整流程 ---- */'));
const devHelpers = slice('const { realWorkspace, outOfScope', '\n{\n  const repo = newRepo();\n  const ctx');
const block = slice('/* ---- L5 記憶與外部唯讀資料 ---- */', '/* ---- L5 第一部分：');
const helpers = block.slice(0, block.indexOf('\n{\n'));
const fake = block.slice(block.indexOf('function fakeContext('), block.indexOf('\n}\n', block.indexOf('function fakeContext(')) + 3);
const cases = [...block.matchAll(/^\{\n[\s\S]*?^\}\n/gm)].map(match => match[0]);
const options = process.argv.slice(2);
if (options.length && (options.length !== 2 || options[0] !== '--name')) throw new Error('用法：node tools/stubs/kernel-memory-context-mutations.mjs [--name 名稱子字串]');
const mutations = JSON.parse(read('tools/mutations.json')).filter(item => item.name.startsWith('kernel memory-context：') && (!options.length || item.name.includes(options[1])));
if (!mutations.length) throw new Error('沒有匹配突變，拒絕空跑');
const groups = new Map();
for (const mutation of mutations) {
  const test = cases.find(test => test.includes(mutation.expect));
  if (!test) throw new Error(`找不到正式斷言：${mutation.expect}`);
  if (!groups.has(test)) groups.set(test, []);
  groups.get(test).push(mutation);
}
for (const path of ['src', 'tools/stubs']) cpSync(join(ROOT, path), join(snapshot, path), { recursive: true });
for (const path of ['package.json', 'tsconfig.json', 'tools/mutation-test.mjs']) cpSync(join(ROOT, path), join(snapshot, path));
mkdirSync(join(snapshot, 'tests'));
const link = join(snapshot, 'node_modules');
symlinkSync(join(ROOT, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
const originals = new Map([...new Set(mutations.map(item => item.file))].map(path => [path, readFileSync(join(snapshot, path))]));
const results = [];
try {
  let index = 0;
  for (const [test, group] of groups) {
    index++;
    writeFileSync(join(snapshot, 'tools', 'mutations.json'), JSON.stringify(group, null, 2));
    writeFileSync(join(snapshot, 'tests', 'verify-ai-cli_kernel.mjs'), prelude + devHelpers + helpers + fake + test + '\nconsole.log(`${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);\n');
    const result = spawnSync(process.execPath, [join(snapshot, 'tools', 'mutation-test.mjs'), snapshot, '--script', 'verify-ai-cli_kernel.mjs'], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 1800000, maxBuffer: 4 * 1024 * 1024 });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    writeFileSync(join(home, `group-${index}.log`), output);
    const killed = [...output.matchAll(/^\[\d+\/\d+\] KILLED\s+/gm)].length;
    const restored = [...originals].every(([path, bytes]) => readFileSync(join(snapshot, path)).equals(bytes));
    const valid = result.status === 0 && killed === group.length && !/KILLED\(其他斷言\)|SURVIVED（|BUILD_FAILED|\] ERROR/.test(output) && restored;
    console.log(`group ${index}: ${valid ? 'PASS' : 'FAIL'} (${killed}/${group.length} expected kills)`);
    results.push({ group: index, total: group.length, killed, restored, valid, exitCode: result.status, mutations: group.map(item => item.name), error: result.error?.message });
    if (!valid) { console.log(output.slice(-4000)); break; }
  }
  for (const [path, bytes] of originals) if (!readFileSync(join(snapshot, path)).equals(bytes)) throw new Error(`快照未還原：${path}`);
} finally {
  unlinkSync(link);
  if (!existsSync(join(ROOT, 'node_modules', 'typescript', 'package.json'))) throw new Error('相依套件檢查失敗');
  writeFileSync(join(home, 'result.json'), JSON.stringify({ testSha256: createHash('sha256').update(source).digest('hex'), extractedFrom: 'tests/verify-ai-cli_kernel.mjs', harness: 'tools/mutation-test.mjs (unmodified copy)', groups: results }, null, 2) + '\n');
}
writeFileSync(join(home, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`evidence: ${relative(ROOT, home)}`);
process.exit(results.length === groups.size && results.every(item => item.valid) ? 0 : 1);
