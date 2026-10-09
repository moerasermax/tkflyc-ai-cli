/** 未 commit 稽核修補的四筆手動突變；逐筆恢復原始 bytes，備份只放系統暫存。 */
import './stubs/catalog-test-env.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const backup = mkdtempSync(join(tmpdir(), 'ai-cli-audit-mutations-'));
const mutations = JSON.parse(readFileSync(join(ROOT, 'tools/mutations.json'))).filter(m => m.name.startsWith('6.8 audit:'));
const build = () => { const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, encoding: 'utf8' }); if (result.status) throw Error(result.stdout + result.stderr); };
let killed = 0;
try {
  if (mutations.length !== 4) throw Error('Expected four audit mutations');
  for (const [index, m] of mutations.entries()) {
    const path = join(ROOT, m.file), original = readFileSync(path); writeFileSync(join(backup, String(index)), original);
    const source = original.toString('utf8').replace(/\r\n/g, '\n'); if (source.split(m.from).length !== 2) throw Error('Expected unique current source: ' + m.name);
    try {
      writeFileSync(path, source.replace(m.from, m.to)); build();
      const result = spawnSync(process.execPath, [join(ROOT, 'tests', m.script)], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
      const output = result.stdout + result.stderr;
      if (result.status !== 0 && output.includes('FAIL ' + m.expect)) { killed++; console.log('KILLED ' + m.name); }
      else console.log('FAILED ' + m.name + '\n' + output);
    } finally { writeFileSync(path, original); build(); }
  }
} finally {
  if (dirname(resolve(backup)) !== resolve(tmpdir()) || !backup.startsWith(join(tmpdir(), 'ai-cli-audit-mutations-'))) throw Error('Unexpected backup directory');
  rmSync(backup, { recursive: true, force: true });
}
console.log(`audit mutations: ${killed}/4 killed`); if (killed !== 4) process.exitCode = 1;
