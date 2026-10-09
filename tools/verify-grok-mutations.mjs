/** 未 commit 工作樹的 Grok 手動突變；外部備份、逐筆還原、不使用 git。 */
import './stubs/catalog-test-env.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const backup = mkdtempSync(join(tmpdir(), 'ai-cli-grok-mutations-'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/mutations.json')));
const mutations = manifest.filter(m => m.name.startsWith('Grok:'));
const build = () => execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, stdio: 'pipe' });
let failed = 0;
try {
  if (!mutations.length) throw Error('No Grok mutations');
  for (const [index, mutation] of mutations.entries()) {
    const path = join(ROOT, mutation.file), original = readFileSync(path);
    writeFileSync(join(backup, String(index)), original);
    const text = original.toString('utf8');
    if (text.split(mutation.from).length !== 2) throw Error('Mutation must match exactly once: ' + mutation.name);
    try {
      writeFileSync(path, text.replace(mutation.from, mutation.to)); build();
      const result = spawnSync(process.execPath, [join(ROOT, 'tests/verify-grok.mjs'), mutation.section], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
      const killed = result.status !== 0 && result.stdout?.includes('FAIL ' + mutation.expect);
      console.log(`${killed ? 'KILLED' : 'FAILED'} ${mutation.name}`);
      if (!killed) { failed++; console.log(result.stdout, result.stderr); }
    } finally { writeFileSync(path, original); build(); }
  }
} finally { rmSync(backup, { recursive: true, force: true }); }
console.log(`grok mutations: ${mutations.length - failed}/${mutations.length} killed`);
if (failed) process.exitCode = 1;
