/** 手動 dashboard 突變：以未提交快照執行原樣 harness，不建分支或修改主原始碼。 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const script = 'verify-ai-cli_kernel-dashboard.mjs';
const selected = JSON.parse(readFileSync(join(ROOT, 'tools/mutations.json'), 'utf8')).filter(m => m.script === script);
if (!selected.length) throw new Error('沒有 dashboard 突變，拒絕空跑');
for (const m of selected) {
  const source = readFileSync(join(ROOT, m.file), 'utf8').replace(/\r\n/g, '\n');
  if (source.split(m.from.replace(/\r\n/g, '\n')).length !== 2) throw new Error(`片段不是唯一：${m.name}`);
}
const evidence = join(ROOT, 'docs/ai-cli_kernel/dashboard-evidence.log');
mkdirSync(evidence, { recursive: true });
const home = mkdtempSync(join(evidence, 'run-'));
const snapshot = join(home, 'snapshot'), scratch = join(home, 'temp');
mkdirSync(scratch);
for (const path of ['src', 'tools/stubs']) cpSync(join(ROOT, path), join(snapshot, path), { recursive: true });
for (const path of ['package.json', 'tsconfig.json', 'tools/mutation-test.mjs', `tests/${script}`]) {
  mkdirSync(dirname(join(snapshot, path)), { recursive: true });
  cpSync(join(ROOT, path), join(snapshot, path));
}
writeFileSync(join(snapshot, 'tools/mutations.json'), JSON.stringify(selected, null, 2));
const originals = new Map([...new Set(selected.map(m => m.file))].map(path => [path, readFileSync(join(snapshot, path))]));
const link = join(snapshot, 'node_modules');
symlinkSync(join(ROOT, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
let result;
try {
  const run = spawnSync(process.execPath, [join(snapshot, 'tools/mutation-test.mjs'), snapshot, '--script', script], {
    cwd: ROOT, env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
    encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = (run.stdout ?? '') + (run.stderr ?? '');
  writeFileSync(join(home, 'harness.log'), output);
  const killed = [...output.matchAll(/^\[\d+\/\d+\] KILLED\s+/gm)].length;
  const restored = [...originals].every(([path, bytes]) => readFileSync(join(snapshot, path)).equals(bytes));
  result = {
    platform: process.platform, node: process.version, total: selected.length, killed, restored, exitCode: run.status,
    valid: run.status === 0 && killed === selected.length && restored && !/KILLED\(其他斷言\)|SURVIVED（|BUILD_FAILED|\] ERROR/.test(output),
    error: run.error?.message,
    testSha256: createHash('sha256').update(readFileSync(join(ROOT, `tests/${script}`))).digest('hex'),
    harnessSha256: createHash('sha256').update(readFileSync(join(ROOT, 'tools/mutation-test.mjs'))).digest('hex'),
    mutations: selected.map(m => m.name),
  };
  console.log(output);
} finally {
  unlinkSync(link); // 只解除連結，不遞迴刪除目標。
  if (!existsSync(join(ROOT, 'node_modules/typescript/package.json'))) throw new Error('主相依套件檢查失敗');
  writeFileSync(join(home, 'result.json'), JSON.stringify(result ?? { valid: false, error: '未完成' }, null, 2) + '\n');
  console.log(`evidence: ${relative(ROOT, home)}`);
}
process.exitCode = result?.valid ? 0 : 1;
