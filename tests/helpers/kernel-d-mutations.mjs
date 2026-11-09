/** D targeted mutations, using an unmodified copy of tools/mutation-test.mjs.
 * Run: node tests/helpers/kernel-d-mutations.mjs [--name substring]
 * Logs live in os.tmpdir(). The unmodified harness requires a Git parent for snapshots;
 * the disposable in-repo snapshot is removed in finally, including failures.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--name' && args[1], 'usage: [--name substring]');
const mutations = JSON.parse(readFileSync(join(ROOT, 'tools/mutations.json'), 'utf8'))
  .filter(m => args.length ? /^kernel (?:D|F1F3|F2F4)：/.test(m.name) && m.name.includes(args[1]) : m.name.startsWith('kernel D：'));
assert.ok(mutations.length, 'refuse an empty selection');
const groups = new Map();
for (const mutation of mutations) {
  const filter = mutation.expect;
  const key = JSON.stringify([mutation.script, filter]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(mutation);
}
const stage = mkdtempSync(join(tmpdir(), 'kernel-mutations-'));
const logPath = join(stage, 'mutations.log');
console.log(`Mutation evidence: ${logPath}`);
// Verified limitation: mutation-test.mjs rejects a snapshot outside a Git repo
// at its final status.code check, even with all expected kills. Keep only this
// disposable snapshot under the repo; logs and test fixtures stay in os.tmpdir().
const snapshotRoot = mkdtempSync(join(ROOT, 'docs/ai-cli_kernel/.d-mut-'));
const snapshot = join(snapshotRoot, 'snapshot'), link = join(snapshot, 'node_modules');
const results = [];
let log = `D targeted mutations: isolated snapshot; unmodified existing harness; selection ${JSON.stringify(args)}.\n`;
const distStamp = () => existsSync(join(ROOT, 'dist/ai-cli_kernel'))
  ? readdirSync(join(ROOT, 'dist/ai-cli_kernel')).map(name => { const s = statSync(join(ROOT, 'dist/ai-cli_kernel', name)); return `${name}:${s.size}:${s.mtimeMs}`; }).sort().join('\n') : 'missing';
const before = distStamp();
const sanitize = text => {
  for (const [path, label] of [[stage, '<evidence>'], [snapshotRoot, '<validation>'], [ROOT, '<workspace>']]) {
    for (const spelling of [path, path.replace(/\\/g, '/'), path.replace(/\\/g, '\\\\')]) text = text.split(spelling).join(label);
  }
  // The existing harness prints only the last 800 characters on baseline errors;
  // remove even a partial stack path whose drive/prefix was already cut off.
  return text.replace(/[^\s()]*[/\\]snapshot[/\\]/g, '<validation>/snapshot/');
};
log = sanitize(log);
try {
  mkdirSync(join(snapshot, 'tools'), { recursive: true });
  for (const dir of ['src', 'tests', 'tools/stubs']) cpSync(join(ROOT, dir), join(snapshot, dir), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'tools/mutation-test.mjs', 'tools/run-tests.mjs']) cpSync(join(ROOT, file), join(snapshot, file));
  symlinkSync(realpathSync(join(ROOT, 'node_modules')), link, process.platform === 'win32' ? 'junction' : 'dir');
  const temp = join(stage, 'temp'); mkdirSync(temp);
  for (const [key, selected] of groups) {
    const [script, filter] = JSON.parse(key);
    writeFileSync(join(snapshot, 'tools/mutations.json'), JSON.stringify(selected, null, 2));
    console.log(`Checking ${script}${filter ? ` / ${filter}` : ''}: ${selected.length} mutations`);
    const r = spawnSync(process.execPath, [join(snapshot, 'tools/mutation-test.mjs'), snapshot, '--script', script], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 8 * 1024 * 1024,
      // Non-git fixtures must not discover a parent repo. The snapshot is a sibling of temp.
      env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, GIT_CEILING_DIRECTORIES: temp, KERNEL_CONCURRENCY_TEST_FILTER: filter, KERNEL_EVIDENCE_TEST_FILTER: filter, KERNEL_BASE_ARCHIVE_TEST_FILTER: filter },
    });
    const output = sanitize(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    const killed = (output.match(/\[\d+\/\d+\] KILLED\s+/g) ?? []).length;
    const valid = r.status === 0 && killed === selected.length && !/KILLED\(其他斷言\)|SURVIVED（|BUILD_FAILED|\] ERROR/.test(output);
    const result = { script, filter, total: selected.length, killed, valid, exitCode: r.status, error: r.error?.code ?? null, mutations: selected.map(m => m.name) };
    results.push(result);
    log += `\n${JSON.stringify(result)}\n${output}\n`;
    writeFileSync(logPath, log);
    console.log(`${valid ? 'PASS' : 'FAIL'} ${script}: expected kills ${killed}/${selected.length}`);
    // A broken baseline invalidates mutation evidence; do not repeat it for every group.
    if (/基準.*(?:未通過|建置失敗)/.test(output)) break;
  }
} finally {
  // Never recursively remove a directory while it contains a node_modules junction.
  if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) {
    assert.ok(lstatSync(link).isSymbolicLink(), 'refuse to delete a non-link node_modules');
    unlinkSync(link);
  }
  assert.ok(existsSync(join(ROOT, 'node_modules/typescript/package.json')), 'shared dependencies intact');
  const rel = relative(resolve(ROOT, 'docs/ai-cli_kernel'), resolve(snapshotRoot));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/') && !rel.includes('\\'), 'cleanup stays in validation root');
  rmSync(snapshotRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const distUnchanged = distStamp() === before;
  log += `\nLive dist unchanged: ${distUnchanged}; snapshot removed; shared dependencies intact; log retained in os.tmpdir().\n`;
  writeFileSync(logPath, log);
  assert.ok(distUnchanged, 'live dist must remain unchanged');
}
console.log(`D mutation groups: ${results.filter(r => r.valid).length}/${groups.size}; expected kills: ${results.reduce((n, r) => n + r.killed, 0)}/${mutations.length}`);
process.exitCode = results.length !== groups.size || results.some(r => !r.valid) ? 1 : 0;
