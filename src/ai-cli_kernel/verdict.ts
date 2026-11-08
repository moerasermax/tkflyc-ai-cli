/**
 * 裁決：失敗分類與驗收檢查。
 *
 * 授權、執行、交付是三個獨立判斷，不能互相代替：exit 0 只說明程序正常結束，
 * 不代表有交付；模型自己說完成了也不算。這裡的檢查都是確定性的，不呼叫模型。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { digestText } from './journal.js';
import type { AcceptanceCheck, FailureClass, GitSnapshot, RawJobResult } from './types.js';

const PATTERNS: Array<[FailureClass, RegExp]> = [
  ['quota', /quota exceeded|insufficient[_ ]quota|out of credits|usage limit|hit your .*limit|limit reached|額度已用完/i],
  ['rate_limited', /\b429\b|rate.?limit|too many requests|請求過於頻繁/i],
  ['auth', /not logged in|\b401\b|unauthorized|please run .*login|authentication failed/i],
  ['model_unavailable', /model is not supported|requires a newer version|model metadata for .* not found|invalid model selection|no such model/i],
];

const REFUSAL = /blocked by policy|請(直接)?貼上|paste (the|your) file|cannot access (the )?files?|無法讀取(任何)?檔案|尚未讀到/i;

/** 把 job 的結束狀態分類。ok 表示「程序正常結束而且有內容」，還不等於通過驗收。 */
export function classifyJobResult(result: RawJobResult): { ok: boolean; failureClass: FailureClass | null; detail: string } {
  const message = result.message ?? '';
  const haystack = `${message}\n${result.rawTail ?? ''}`;
  if (result.status === 'lost') return { ok: false, failureClass: 'lost', detail: 'job 消失，沒有留下結束回報' };
  const failedExit = result.status !== 'completed' || (result.exitCode !== 0 && result.exitCode !== null);
  // 成功結束時，報告內文可能正在討論限流，不能因為提到這些字就判失敗。
  if (failedExit || !message.trim()) {
    for (const [failureClass, pattern] of PATTERNS) {
      if (pattern.test(haystack)) return { ok: false, failureClass, detail: haystack.match(pattern)?.[0] ?? failureClass };
    }
  }
  if (failedExit) return { ok: false, failureClass: 'process_failed', detail: `status=${result.status} exit=${result.exitCode}` };
  if (!message.trim()) return { ok: false, failureClass: 'empty_output', detail: 'exit 0 但沒有回覆內容' };
  return { ok: true, failureClass: null, detail: '' };
}

const CITATION = /(?<![\w.\-\\/:])((?:[A-Za-z]:)?[\\/]?(?:[\w.\-一-鿿]+[\\/])*[\w.\-一-鿿]+\.[A-Za-z0-9]+):(\d+)(?:[-–](\d+))?/g;

function outside(folder: string, target: string): boolean {
  const rel = relative(folder, target);
  return rel.startsWith('..') || isAbsolute(rel);
}

/** 只問 git 的 index，不遞迴掃目錄，也不把 repo 以外的父目錄當候選。 */
interface TrackedCitationFile { repoPath: string; target: string }
function trackedFiles(folder: string): TrackedCitationFile[] {
  const git = (...args: string[]) => spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (git('rev-parse', '--is-inside-work-tree').stdout?.trim() !== 'true') return [];
  const prefixResult = git('rev-parse', '--show-prefix');
  if (prefixResult.status !== 0) return [];
  const prefix = prefixResult.stdout.replace(/\r?\n$/, '');
  const result = git('ls-files', '--cached', '--full-name', '-z', '--');
  if (result.status !== 0) return [];
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
    .filter(path => path.startsWith(prefix))
    .map(repoPath => ({ repoPath, target: resolve(folder, repoPath.slice(prefix.length)) }))
    .filter(file => !outside(folder, file.target));
}

/** 確定性地檢查報告引用的 `路徑:行號` 真的存在。模型編出來的引用過不了這關。 */
export function checkCitations(message: string, workFolder: string, minCount: number): { passed: boolean; findings: string[]; resolved: number } {
  const findings: string[] = [];
  const seen = new Set<string>();
  let resolved = 0;
  const unresolved: string[] = [];
  let tracked: TrackedCitationFile[] | undefined;
  for (const match of message.matchAll(CITATION)) {
    const [, rawPath, startLine, endLine] = match;
    if (/^\d+(\.\d+)+$/.test(rawPath)) continue; // 127.0.0.1:8080 這類不是檔案。
    const citation = `${rawPath}:${startLine}`;
    if (seen.has(citation)) continue;
    seen.add(citation);
    // 中文句子可能直接黏著路徑（見README.md:1）：原樣找不到就去掉開頭的中文再試一次。
    const normalized = rawPath.replace(/\\/g, '/');
    const stripped = normalized.replace(/^[一-鿿]+/, '');
    let target = resolve(workFolder, !existsSync(resolve(workFolder, normalized)) && stripped ? stripped : normalized);
    // 先拒絕原始逃逸路徑，才可能做 basename 修正。
    if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || outside(workFolder, target)) { unresolved.push(`${citation}（超出工作目錄）`); continue; }
    if (!existsSync(target)) {
      tracked ??= trackedFiles(workFolder);
      const candidatesFor = (name: string) => tracked!.filter(file => posix.basename(file.repoPath) === name);
      // 中文可能是檔名的一部分；先試完整 basename，再試既有的句首中文剝除規則。
      const rootRelative = tracked.find(file => file.repoPath === normalized || file.repoPath === stripped);
      const exact = candidatesFor(posix.basename(normalized));
      const candidates = rootRelative ? [rootRelative] : exact.length ? exact : candidatesFor(posix.basename(stripped || normalized));
      if (candidates.length > 1) {
        findings.push(`${citation}（同 basename 有 ${candidates.length} 個候選，列出 ${Math.min(8, candidates.length)} 個${candidates.length > 8 ? `，截斷 ${candidates.length - 8} 個` : ''}）：${candidates.slice(0, 8).map(file => JSON.stringify(file.repoPath)).join('、')}。請改用從 repo 根目錄算起的完整相對路徑:行號。`);
        unresolved.push(`${citation}（多候選，不能自動選擇）`); continue;
      }
      if (candidates.length === 1) target = candidates[0].target;
    }
    if (!existsSync(target) || !statSync(target).isFile()) { unresolved.push(`${citation}（檔案不存在）`); continue; }
    // 在範圍內的相對路徑仍可能經 symlink/junction 跳出去；fallback 也過同一關。
    if (outside(realpathSync.native(workFolder), realpathSync.native(target))) { unresolved.push(`${citation}（超出工作目錄）`); continue; }
    // 太大的檔案不讀，但也不能當作核對過。
    if (statSync(target).size > 20 * 1024 * 1024) { unresolved.push(`${citation}（檔案太大，無法核對）`); continue; }
    const lineCount = readFileSync(target, 'utf8').split('\n').length;
    const lastLine = Number(endLine ?? startLine);
    if (Number(startLine) < 1 || lastLine < Number(startLine) || lastLine > lineCount) { unresolved.push(`${citation}（行號超出範圍，檔案共 ${lineCount} 行）`); continue; }
    resolved += 1;
  }
  if (unresolved.length > 0) findings.push(`有 ${unresolved.length} 個引用對不上：${unresolved.slice(0, 8).join('；')}`);
  if (resolved < minCount) findings.push(`可驗證的引用只有 ${resolved} 個，至少要 ${minCount} 個`);
  return { passed: findings.length === 0, findings, resolved };
}

export function evaluateChecks(checks: AcceptanceCheck[], message: string, workFolder: string): { passed: boolean; findings: string[] } {
  const findings: string[] = [];
  for (const check of checks) {
    switch (check.type) {
      case 'message_nonempty':
        if (!message.trim()) findings.push('回覆是空的');
        break;
      case 'min_length':
        if (message.trim().length < check.chars) findings.push(`回覆太短：${message.trim().length} 字，至少要 ${check.chars} 字`);
        break;
      case 'no_refusal':
        // 只有回覆很短時才算放棄。長報告可能正在討論這些字眼。
        if (message.trim().length < 800 && REFUSAL.test(message)) findings.push(`回覆像是放棄或被拒絕：${message.match(REFUSAL)?.[0]}`);
        break;
      case 'required_sections':
        for (const pattern of check.patterns) if (!new RegExp(pattern, 'm').test(message)) findings.push(`缺少必要段落：${pattern}`);
        break;
      case 'citations_resolve':
        findings.push(...checkCitations(message, workFolder, check.minCount).findings);
        break;
    }
  }
  return { passed: findings.length === 0, findings };
}

/** 工作目錄快照，用來獨立核對「唯讀」這個說法。不是 git repo 時回 null。 */
export function gitSnapshot(dir: string): GitSnapshot | null {
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) return null;
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  if (status.status !== 0) return null;
  // 只看狀態文字不夠：已經是修改狀態的檔案再被改一次，狀態文字完全一樣。所以連內容差異一起算。
  const diff = git('diff', 'HEAD', '--binary');
  if (diff.status !== 0) return null;
  // index 另外算：只改暫存區、工作樹剛好和 HEAD 一樣時，diff HEAD 看不出來。
  const staged = git('diff', '--cached', '--binary');
  if (staged.status !== 0) return null;
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z');
  if (untracked.status !== 0) return null;
  const untrackedState = untracked.stdout.split('\0').filter(Boolean).map(path => {
    try { const stat = statSync(resolve(dir, path)); return `${path}:${stat.size}:${stat.mtimeMs}`; }
    catch { return `${path}:gone`; }
  }).join('\n');
  const lines = status.stdout.split('\n').filter(Boolean);
  return { head: head.stdout.trim(), statusDigest: digestText(`${status.stdout}\0${diff.stdout}\0${staged.stdout}\0${untrackedState}`), dirtyEntries: lines.length };
}

export function snapshotsEqual(a: GitSnapshot | null, b: GitSnapshot | null): boolean {
  return !!a && !!b && a.head === b.head && a.statusDigest === b.statusDigest;
}
