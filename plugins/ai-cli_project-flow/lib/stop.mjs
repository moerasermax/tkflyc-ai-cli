/** 保守地檢查回覆中的收尾證據。只有可比較的 Git 狀態才會攔一次。 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { pathKey } from './project.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const docExtensions = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.asciidoc']);
const docDirectory = 'docs/';
const stateTtlMs = 14 * 24 * 60 * 60 * 1000;
const hashPattern = /^[\da-f]{64}$/;
const stateFilePattern = /^(?:checked|session)-[\da-f]{64}$/;
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames'];
const worktreeDiffOptions = [...diffOptions, '--ignore-submodules=all'];

function git(cwd, ...args) {
  return execFileSync('git', ['--no-pager', ...args], {
    cwd, timeout: 1500, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function pathsFromGit(output) {
  return output.toString().split('\0').filter(Boolean);
}

export function fingerprintChanges(head, diff, tracked, entries) {
  // Git 以相同次序列檔名與 patch。用 latin1 保留 patch 裡可能存在的非 UTF-8 位元組。
  const patches = diff.toString('latin1').split(/^(?=diff --git )/m).filter(Boolean);
  const value = hash(JSON.stringify([head, hash(diff), entries]));
  const changes = tracked.length === patches.length
    ? [...tracked.map((name, index) => [name, hash(patches[index])]), ...entries]
    : null;
  return { value, changes };
}

function fingerprint(cwd) {
  try {
    const root = realpathSync.native(git(cwd, 'rev-parse', '--show-toplevel').toString().trimEnd());
    const head = git(root, 'rev-parse', '--verify', 'HEAD').toString().trim();
    const diff = git(root, 'diff', ...worktreeDiffOptions, '--binary', 'HEAD', '--');
    const tracked = pathsFromGit(git(root, 'diff', ...worktreeDiffOptions, '--name-only', '-z', 'HEAD', '--'));
    const names = pathsFromGit(git(root, 'ls-files', '--others', '--exclude-standard', '-z'));
    if (names.length > 500) return null;
    const entries = [];
    let bytes = 0;
    for (const name of names) {
      const path = join(root, name);
      const fromRoot = relative(root, realpathSync.native(path));
      if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) return null;
      const stat = lstatSync(path);
      bytes += stat.size;
      if (!stat.isFile() || bytes > 8 * 1024 * 1024) return null;
      entries.push([name, hash(readFileSync(path))]);
    }
    return { root, head, ...fingerprintChanges(head, diff, tracked, entries) };
  } catch {
    return null;
  }
}

function readBaseline(path) {
  const text = readFileSync(path, 'utf8');
  if (hashPattern.test(text)) return { value: text }; // 先前版本只存指紋。
  const baseline = JSON.parse(text);
  return hashPattern.test(baseline?.value ?? '') && /^[\da-f]{40}(?:[\da-f]{24})?$/.test(baseline.head)
    && (baseline.changes === null || Array.isArray(baseline.changes)) ? baseline : null;
}

function changedPaths(baseline, current) {
  const before = new Map(baseline.changes);
  const after = new Map(current.changes);
  const names = new Set([...before.keys(), ...after.keys()]);
  const changed = [...names].filter(name => before.get(name) !== after.get(name));
  if (baseline.head !== current.head) {
    const raw = pathsFromGit(git(current.root, 'diff', ...diffOptions, '--ignore-submodules=none',
      '--raw', '-z', baseline.head, current.head, '--'));
    for (let i = 0; i < raw.length; i += 2) {
      const [beforeMode, afterMode] = raw[i].slice(1).split(' ');
      if (beforeMode === '160000' || afterMode === '160000') return { changed: true, onlyDocs: false };
      changed.push(raw[i + 1]);
    }
  }
  return { changed: changed.length > 0, onlyDocs: changed.every(documentation) };
}

function documentation(name) {
  const lower = name.toLowerCase();
  return lower.startsWith(docDirectory) || docExtensions.has(extname(lower));
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
  const rootKey = pathKey(current.root);
  const scope = join(stateDir, 'stop', hash(JSON.stringify([project.id, rootKey])));
  // Windows 上保留舊版以原始路徑命名的狀態，直到其自然過期。
  const legacyScope = rootKey === current.root ? null
    : join(stateDir, 'stop', hash(JSON.stringify([project.id, current.root])));
  return { ...current, scope, legacyScope, sessionFile: 'session-' + hash(payload.session_id) };
}

function pruneScope(scope, cutoff) {
  try {
    for (const file of readdirSync(scope, { withFileTypes: true })) {
      if (!file.isFile() || !stateFilePattern.test(file.name)) continue;
      const path = join(scope, file.name);
      try {
        if (lstatSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch { /* 其他 hook 可能已清掉同一個狀態檔。 */ }
    }
  } catch { /* 狀態目錄可能尚未建立。 */ }
}

export function rememberBaseline(payload, project, stateDir) {
  const cutoff = Date.now() - stateTtlMs;
  const stopDir = join(stateDir, 'stop');
  try {
    for (const scope of readdirSync(stopDir, { withFileTypes: true })) {
      if (scope.isDirectory() && hashPattern.test(scope.name)) pruneScope(join(stopDir, scope.name), cutoff);
    }
  } catch { /* 尚無舊狀態。 */ }
  const current = snapshot(payload, project, stateDir);
  if (!current) return;
  try {
    if (current.legacyScope && existsSync(join(current.legacyScope, current.sessionFile))) return;
    mkdirSync(current.scope, { recursive: true, mode: 0o700 });
    const { value, head, changes } = current;
    writeOnce(join(current.scope, current.sessionFile), JSON.stringify({ value, head, changes }));
  } catch { /* 不能建立基準就不擋。 */ }
}

export function stopReason(payload, project, stateDir) {
  if (payload.stop_hook_active === true || typeof payload.last_assistant_message !== 'string'
      || !payload.last_assistant_message.trim()) return null;
  const current = snapshot(payload, project, stateDir);
  if (!current) return null;
  pruneScope(current.scope, Date.now() - stateTtlMs);
  if (current.legacyScope) pruneScope(current.legacyScope, Date.now() - stateTtlMs);
  let onlyDocs = false;
  try {
    const baselinePath = join(current.scope, current.sessionFile);
    const baseline = readBaseline(current.legacyScope && !existsSync(baselinePath)
      ? join(current.legacyScope, current.sessionFile) : baselinePath);
    if (!baseline || baseline.value === current.value) return null;
    if (baseline.changes && current.changes) {
      const comparison = changedPaths(baseline, current);
      if (!comparison.changed) return null;
      onlyDocs = comparison.onlyDocs;
    }
  } catch { return null; }
  const required = onlyDocs ? evidence.slice(-1) : evidence;
  const missing = required.filter(([, pattern]) => !pattern.test(payload.last_assistant_message)).map(([label]) => label);
  const checked = 'checked-' + current.value;
  if (current.legacyScope && existsSync(join(current.legacyScope, checked))) return null;
  if (!writeOnce(join(current.scope, checked), '') || !missing.length) return null;
  return '專案流程看到本批 Git 改動的回覆仍缺以下證據：' + missing.join('、')
    + '。請補上實際結果與路徑，或說明哪些未完成、原因與卡關。';
}
