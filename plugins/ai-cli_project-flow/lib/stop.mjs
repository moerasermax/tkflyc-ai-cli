/** 保守地檢查回覆中的收尾證據。只有可比較的 Git 狀態才會攔一次。 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');

function git(cwd, ...args) {
  return execFileSync('git', ['--no-pager', ...args], {
    cwd, timeout: 1500, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fingerprint(cwd) {
  try {
    const root = realpathSync(git(cwd, 'rev-parse', '--show-toplevel').toString().trimEnd());
    const head = git(root, 'rev-parse', '--verify', 'HEAD').toString().trim();
    const diff = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--binary', 'HEAD', '--');
    const names = git(root, 'ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean);
    const entries = [];
    let bytes = 0;
    for (const name of names) {
      const path = join(root, name);
      const fromRoot = relative(root, realpathSync(path));
      if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) return null;
      const stat = lstatSync(path);
      bytes += stat.size;
      if (!stat.isFile() || bytes > 8 * 1024 * 1024 || names.length > 500) return null;
      entries.push([name, hash(readFileSync(path))]);
    }
    return { root, value: hash(JSON.stringify([head, hash(diff), entries])) };
  } catch {
    return null;
  }
}

const evidence = [
  ['測試輸出（R3）', /(?:測試|tests?|驗證指令)[^\n]{0,80}(?:通過|成功|失敗|PASS(?:ED)?|FAIL(?:ED)?|exit(?: code)?\s*[=:]?\s*\d)|\b\d+\s+(?:passed|failed)\b|(?:未跑|未執行|不能測|無法測)[^\n]{0,40}(?:因為|原因|由於|僅改文件)/iu],
  ['獨立驗證（R3）', /(?:獨立(?:驗證|稽核|審查)|independent (?:review|verification))[^\n]{0,100}(?:job[\s#:-]+[\w-]{4,}|已通過|已確認|已完成|發現|passed|findings?)/iu],
  ['測試報告路徑（R5）', /(?:測試報告|test report)[^\n]{0,200}\.(?:md|docx?|pdf|html?|txt|xlsx?)\b|(?:測試報告|test[-_ ]reports?)[/\\][^\n]+\.(?:md|docx?|pdf|html?|txt|xlsx?)\b/iu],
  ['量化進度更新（R6）', /(?:量化進度|進度(?:資料|更新)|progress)[^\n]{0,120}(?:已更新|已寫入|updated|\d+\s*\/\s*\d+|\d+(?:\.\d+)?%)/iu],
];

function writeOnce(path, value) {
  try {
    writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function snapshot(payload, project, stateDir) {
  if (typeof payload.session_id !== 'string' || !payload.session_id) return null;
  const current = fingerprint(payload.cwd);
  if (!current) return null;
  const scope = join(stateDir, 'stop', hash(JSON.stringify([project.id, current.root])));
  return { ...current, scope, baseline: join(scope, 'session-' + hash(payload.session_id)) };
}

export function rememberBaseline(payload, project, stateDir) {
  const current = snapshot(payload, project, stateDir);
  if (!current) return;
  try {
    mkdirSync(current.scope, { recursive: true, mode: 0o700 });
    writeOnce(current.baseline, current.value);
  } catch { /* 不能建立基準就不擋。 */ }
}

export function stopReason(payload, project, stateDir) {
  if (payload.stop_hook_active === true || typeof payload.last_assistant_message !== 'string'
      || !payload.last_assistant_message.trim()) return null;
  const missing = evidence.filter(([, pattern]) => !pattern.test(payload.last_assistant_message)).map(([label]) => label);
  const current = snapshot(payload, project, stateDir);
  if (!current) return null;
  try {
    const baseline = readFileSync(current.baseline, 'utf8');
    if (!/^[\da-f]{64}$/.test(baseline) || baseline === current.value) return null;
  } catch { return null; }
  if (!writeOnce(join(current.scope, 'checked-' + current.value), '') || !missing.length) return null;
  return '專案流程看到本批 Git 改動的回覆仍缺以下證據：' + missing.join('、')
    + '。請補上實際結果與路徑，或說明哪些未完成、原因與卡關。';
}
