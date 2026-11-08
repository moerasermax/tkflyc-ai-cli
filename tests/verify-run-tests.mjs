/**
 * `tools/run-tests.mjs`（npm test 的 runner）本身的驗證。
 *
 * 在系統暫存目錄放幾支假的 verify 腳本，用 --manifest／--tests-dir（或對應環境變數）
 * 指給 runner 跑，檢查：一支失敗後面照跑、彙總表、exit code、signal 結束算 FAIL、
 * 防漏加（未列入清單／清單列了但不存在）。不 build、不碰 dist、不碰使用者目錄，
 * 只會結束 runner 自己啟動的假測試行程（逾時那一支）。
 *
 * 用法：node tests/verify-run-tests.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(ROOT, 'tools', 'run-tests.mjs');

let failures = 0;
function ok(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const TMP = mkdtempSync(join(tmpdir(), 'ai-cli-run-tests-'));

const FAKES = {
  'verify-a.mjs': `console.log('MARK-A');`,
  'verify-b.mjs': `console.log('MARK-B'); process.exit(3);`,
  'verify-c.mjs': `console.log('MARK-C');`,
  'verify-hang.mjs': `console.log('MARK-HANG'); setInterval(() => {}, 1000);`,
  'verify-selfkill.mjs': `process.kill(process.pid, 'SIGKILL');`,
  'verify-preload.mjs': `console.log('PRELOAD=' + (globalThis.__runTestsPreload ?? 'none'));`,
  'verify-filters.mjs': `if (['KERNEL_EVIDENCE_TEST_FILTER', 'KERNEL_BASE_ARCHIVE_TEST_FILTER', 'KERNEL_CONCURRENCY_TEST_FILTER'].some(key => process.env[key])) process.exit(7); console.log('FILTERS-CLEAR');`,
};

/** 建一個情境：tests 目錄放 files 指定的假測試，寫清單，跑 runner，回傳輸出。 */
function scenario(name, files, manifest, { viaEnv = false, envOverrides = {} } = {}) {
  const dir = join(TMP, name);
  const testsDir = join(dir, 'tests');
  mkdirSync(testsDir, { recursive: true });
  for (const f of files) writeFileSync(join(testsDir, f), FAKES[f] ?? `console.log('MARK-${f}');`);
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const env = { ...process.env, ...envOverrides };
  delete env.AI_CLI_TEST_MANIFEST;
  delete env.AI_CLI_TESTS_DIR;
  const args = [RUNNER];
  if (viaEnv) Object.assign(env, { AI_CLI_TEST_MANIFEST: manifestPath, AI_CLI_TESTS_DIR: testsDir });
  else args.push('--manifest', manifestPath, '--tests-dir', testsDir);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const tail = (out) => JSON.stringify(out.slice(-400));
const summaryLine = (out, verdict, file) => new RegExp(`^\\s*${verdict}\\s+${file.replace('.', '\\.')}\\s`, 'm').test(out);

try {
  console.log('情境 1：中間一支失敗');
  {
    const r = scenario('mid-fail', ['verify-a.mjs', 'verify-b.mjs', 'verify-c.mjs'], {
      tests: ['verify-a.mjs', 'verify-b.mjs', 'verify-c.mjs'],
    });
    ok('中間一支失敗時整體 exit 1', r.status === 1, `status=${r.status} ${tail(r.out)}`);
    ok('中間一支失敗後，後面的測試照跑', r.out.includes('MARK-C') && summaryLine(r.out, 'PASS', 'verify-c.mjs'), tail(r.out));
    ok('彙總表標出失敗那支（FAIL）並附 exit code', summaryLine(r.out, 'FAIL', 'verify-b.mjs') && /verify-b\.mjs.*exit 3/.test(r.out), tail(r.out));
    ok('彙總表把前面通過的那支標成 PASS', summaryLine(r.out, 'PASS', 'verify-a.mjs'), tail(r.out));
  }

  console.log('情境 2：全部通過（含排除清單與 nodeArgs，走環境變數）');
  {
    const preload = join(TMP, 'preload.mjs');
    writeFileSync(preload, `globalThis.__runTestsPreload = 'yes';`);
    const r = scenario(
      'all-pass',
      ['verify-a.mjs', 'verify-c.mjs', 'verify-preload.mjs', 'verify-manual.mjs'],
      {
        tests: ['verify-a.mjs', { file: 'verify-preload.mjs', nodeArgs: ['--import', pathToFileURL(preload).href] }, 'verify-c.mjs'],
        excluded: { 'verify-manual.mjs': '測試用的排除項' },
      },
      { viaEnv: true }
    );
    ok('全部通過時 exit 0', r.status === 0, `status=${r.status} ${tail(r.out)}`);
    ok('排除清單裡的腳本不會被執行', !r.out.includes('MARK-verify-manual.mjs'), tail(r.out));
    ok('清單項目的 nodeArgs 有帶給子行程', r.out.includes('PRELOAD=yes'), tail(r.out));
  }

  console.log('情境：正式 runner 不繼承突變的定向篩選');
  {
    const r = scenario('filters', ['verify-filters.mjs'], { tests: ['verify-filters.mjs'] }, {
      envOverrides: { KERNEL_EVIDENCE_TEST_FILTER: 'narrow', KERNEL_BASE_ARCHIVE_TEST_FILTER: 'narrow', KERNEL_CONCURRENCY_TEST_FILTER: 'narrow' },
    });
    ok('正式 runner 清除所有定向篩選，仍完整驗收', r.status === 0 && r.out.includes('FILTERS-CLEAR'), tail(r.out));
  }

  console.log('情境 3：被 signal 結束');
  {
    const posix = process.platform !== 'win32';
    const files = ['verify-hang.mjs', 'verify-c.mjs', ...(posix ? ['verify-selfkill.mjs'] : [])];
    const r = scenario('signal', files, {
      tests: [{ file: 'verify-hang.mjs', timeoutMs: 1500 }, ...(posix ? ['verify-selfkill.mjs'] : []), 'verify-c.mjs'],
    });
    ok('被 signal 結束的一支算 FAIL（逾時由 runner 結束）', summaryLine(r.out, 'FAIL', 'verify-hang.mjs') && /verify-hang\.mjs.*SIG/.test(r.out), tail(r.out));
    if (posix) ok('被 signal 結束的一支算 FAIL（自己收到 SIGKILL）', summaryLine(r.out, 'FAIL', 'verify-selfkill.mjs') && /verify-selfkill\.mjs.*SIGKILL/.test(r.out), tail(r.out));
    ok('有一支被 signal 結束時整體 exit 1', r.status === 1, `status=${r.status} ${tail(r.out)}`);
    ok('被 signal 結束後，後面的測試照跑', r.out.includes('MARK-C'), tail(r.out));
  }

  console.log('情境 4：有未列入清單的 verify 腳本');
  {
    const r = scenario('unlisted', ['verify-a.mjs', 'verify-c.mjs', 'verify-stray.mjs'], {
      tests: ['verify-a.mjs', 'verify-c.mjs'],
    });
    ok('有未列入清單的 verify-*.mjs 時報錯 exit 1', r.status === 1 && r.out.includes('verify-stray.mjs'), `status=${r.status} ${tail(r.out)}`);
    ok('未列入清單時開跑前就停，一支都不跑', !r.out.includes('MARK-A'), tail(r.out));
  }

  console.log('情境 5：清單列了但檔案不存在');
  {
    const r = scenario('missing', ['verify-a.mjs'], { tests: ['verify-a.mjs', 'verify-ghost.mjs'] }, { viaEnv: true });
    ok('清單列了但檔案不存在時報錯 exit 1', r.status === 1 && r.out.includes('verify-ghost.mjs'), `status=${r.status} ${tail(r.out)}`);
    ok('檔案不存在時開跑前就停，一支都不跑', !r.out.includes('MARK-A'), tail(r.out));
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nverify-run-tests：全部通過' : `\nverify-run-tests：${failures} 項失敗`);
process.exitCode = failures === 0 ? 0 : 1;
