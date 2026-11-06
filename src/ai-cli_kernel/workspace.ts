/**
 * develop 範本的工作區：每個 run 一個 worktree 和分支。
 *
 * worker 拿的是全權限，所以這裡做不到隔離，能做的是把交付關在一條分支上，並且事後查核。
 * 「事後」是重點：改到範圍外的東西會被抓到、不會被 commit，但已經發生的副作用撤不回來。
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sameIdentity } from '../core/job-store.js';
import { lookupIdentities } from '../core/live-jobs.js';
import type { CheckHandle, DevelopSpec, WorkspaceOps, WorkspaceState } from './types.js';

const exec = promisify(execFile);
const TAIL_BYTES = 8192;

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function mustGit(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.status !== 0) throw new Error(`git ${args[0]} 失敗：${(result.stderr || result.stdout || String(result.error ?? '')).trim().slice(0, 600)}`);
  return result.stdout;
}

/** 建委任書時用。不是 git repo 回 null。 */
export function describeRepo(folder: string): { root: string; prefix: string; head: string; dirty: number } | null {
  const root = git(folder, 'rev-parse', '--show-toplevel');
  const prefix = git(folder, 'rev-parse', '--show-prefix');
  const head = git(folder, 'rev-parse', 'HEAD');
  const status = git(folder, 'status', '--porcelain=v1');
  if (root.status !== 0 || prefix.status !== 0 || head.status !== 0 || status.status !== 0) return null;
  return { root: resolve(root.stdout.trim()), prefix: prefix.stdout.trim(), head: head.stdout.trim(), dirty: status.stdout.split('\n').filter(Boolean).length };
}

/** 使用者給的路徑是相對 workFolder。轉成相對 repo 根目錄，才能和 git 回報的路徑比。 */
export function normalizeAllowedPaths(paths: readonly string[], prefix: string): string[] {
  return paths.map(raw => {
    const path = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path) throw new Error('allowedPaths 不能有空字串');
    if (isAbsolute(raw) || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) throw new Error(`allowedPaths 只能是工作目錄內的相對路徑：${raw}`);
    return path === '.' ? prefix : `${prefix}${path}`;
  });
}

/** 回傳不在允許範圍內的路徑。'src/' 和 'src' 都涵蓋整個目錄；空字串涵蓋全部。 */
export function outOfScope(paths: readonly string[], allowed: readonly string[]): string[] {
  if (allowed.length === 0) return [];
  return paths.filter(path => !allowed.some(entry => entry === '' || path === entry.replace(/\/$/, '') || path.startsWith(entry.endsWith('/') ? entry : `${entry}/`)));
}

/** `git status -z`：重新命名的項目後面多一段原路徑，兩個都算改過。 */
export function parseStatusZ(text: string): string[] {
  const parts = text.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') { i += 1; if (parts[i]) paths.push(parts[i]); }
  }
  return paths;
}

function sameDir(a: string, b: string): boolean {
  const normalize = (path: string) => { const real = realpathSync(path); return process.platform === 'win32' ? real.toLowerCase() : real; };
  return normalize(a) === normalize(b);
}

/** 會丟改動的操作前都要過這關：只能是這個 run 自己的 linked worktree，絕不能是使用者的主目錄。 */
function assertOwnWorktree(spec: DevelopSpec): void {
  if (!existsSync(spec.worktree)) throw new Error(`worktree 不存在：${spec.worktree}`);
  const top = mustGit(spec.worktree, 'rev-parse', '--show-toplevel').trim();
  if (!sameDir(top, spec.worktree)) throw new Error(`${spec.worktree} 不是 worktree 的根目錄（實際是 ${top}）`);
  if (sameDir(spec.worktree, spec.repoRoot)) throw new Error('worktree 不能是 repo 主目錄');
  const gitDir = resolve(spec.worktree, mustGit(spec.worktree, 'rev-parse', '--git-dir').trim());
  const commonDir = resolve(spec.worktree, mustGit(spec.worktree, 'rev-parse', '--git-common-dir').trim());
  if (sameDir(gitDir, commonDir)) throw new Error(`${spec.worktree} 不是 linked worktree，拒絕操作`);
}

function readTail(path: string): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  return buffer.toString('utf8');
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') { await exec('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }).catch(() => undefined); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已經不在了 */ } }
}

export const realWorkspace: WorkspaceOps = {
  /** 可以重複呼叫：當在中間時，下次會接著用已經開好的 worktree。 */
  prepare(spec) {
    if (existsSync(join(spec.worktree, '.git'))) {
      assertOwnWorktree(spec);
      return;
    }
    mustGit(spec.repoRoot, 'worktree', 'prune');
    const branchExists = git(spec.repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${spec.branch}`).status === 0;
    mustGit(spec.repoRoot, 'worktree', 'add', ...(branchExists ? [spec.worktree, spec.branch] : ['-b', spec.branch, spec.worktree, spec.baseCommit]));
    assertOwnWorktree(spec);
  },

  inspect(spec): WorkspaceState {
    const branch = git(spec.worktree, 'symbolic-ref', '--short', '-q', 'HEAD');
    const head = mustGit(spec.worktree, 'rev-parse', 'HEAD').trim();
    const dirty = parseStatusZ(mustGit(spec.worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'));
    const committed = mustGit(spec.worktree, 'diff', '--name-only', '-z', spec.baseCommit, 'HEAD').split('\0').filter(Boolean);
    return {
      branch: branch.status === 0 ? branch.stdout.trim() : null, head, dirty,
      changed: [...new Set([...committed, ...dirty])],
      ancestorOk: git(spec.worktree, 'merge-base', '--is-ancestor', spec.baseCommit, 'HEAD').status === 0,
    };
  },

  /** hooks 照常跑：kernel 不替使用者跳過 repo 自己的規矩。 */
  commit(spec, message) {
    assertOwnWorktree(spec);
    mustGit(spec.worktree, 'add', '-A');
    mustGit(spec.worktree, 'commit', '-m', message);
    return mustGit(spec.worktree, 'rev-parse', 'HEAD').trim();
  },

  /** 測試的副產物不能混進下一次 commit。不帶 -x：node_modules 這類被忽略的東西要留著。 */
  restore(spec) {
    assertOwnWorktree(spec);
    mustGit(spec.worktree, 'reset', '--hard', 'HEAD');
    mustGit(spec.worktree, 'clean', '-fd');
  },

  /** 主 repo 的 ref，不含這個 run 自己的分支。push 成功時 remote-tracking ref 也會動，看得出來。 */
  refs(spec) {
    return mustGit(spec.repoRoot, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags')
      .split('\n').filter(line => line && !line.endsWith(` refs/heads/${spec.branch}`)).sort();
  },

  diffStat(spec) {
    return mustGit(spec.worktree, 'diff', '--stat', spec.baseCommit, 'HEAD').trimEnd();
  },

  diffText(spec, maxChars) {
    const text = mustGit(spec.worktree, 'diff', spec.baseCommit, 'HEAD');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（diff 太長，只附前 ${maxChars} 字元）` : text;
  },

  async startCheck(command, cwd, logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a', 0o600);
    // 輸出直接寫檔不走 pipe：runner 當掉時指令不會因為 pipe 斷掉而異常。
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    closeSync(fd);
    const pid = child.pid;
    if (!pid) throw new Error(`無法啟動指令：${command}`);
    let settled: { exitCode: number | null } | null = null;
    const done = new Promise<void>(resolve => {
      child.once('exit', code => { settled = { exitCode: code }; resolve(); });
      child.once('error', () => { settled = { exitCode: null }; resolve(); });
    });
    const identity = (await lookupIdentities([pid]).catch(() => new Map())).get(pid);
    const handle: CheckHandle = {
      pid, started: identity?.started ?? '', name: identity?.name ?? '',
      async wait(ms) {
        if (!settled) await Promise.race([done, new Promise(resolve => setTimeout(resolve, ms))]);
        return settled ? { exitCode: (settled as { exitCode: number | null }).exitCode, tail: readTail(logPath) } : null;
      },
      async kill() {
        await killTree(pid);
        await Promise.race([done, new Promise(resolve => setTimeout(resolve, 10000))]);
      },
      tail: () => readTail(logPath),
    };
    return handle;
  },

  async stopOrphanCheck(check) {
    const live = (await lookupIdentities([check.pid]).catch(() => null))?.get(check.pid);
    // pid 不在、或已經被別的程序重用，都不是我們要找的那個。
    if (!live || !sameIdentity(check, live)) return true;
    await killTree(check.pid);
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = (await lookupIdentities([check.pid]).catch(() => null))?.get(check.pid);
      if (!current || !sameIdentity(check, current)) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  },
};

/** 使用者看完結果後清掉 worktree。分支只有已合併才刪，沒合併的留著，不替人丟工作。 */
export function cleanupWorkspace(spec: DevelopSpec): { worktreeRemoved: boolean; branchRemoved: boolean; detail: string } {
  if (existsSync(spec.worktree)) assertOwnWorktree(spec);
  const removal = existsSync(spec.worktree) ? git(spec.repoRoot, 'worktree', 'remove', spec.worktree) : { status: 0, stderr: '', stdout: '' };
  if (removal.status !== 0) return { worktreeRemoved: false, branchRemoved: false, detail: `worktree 沒有移除：${String(removal.stderr).trim().slice(0, 400)}` };
  git(spec.repoRoot, 'worktree', 'prune');
  const branch = git(spec.repoRoot, 'branch', '-d', spec.branch);
  return branch.status === 0
    ? { worktreeRemoved: true, branchRemoved: true, detail: `worktree 和分支 ${spec.branch} 都移除了` }
    : { worktreeRemoved: true, branchRemoved: false, detail: `worktree 移除了。分支 ${spec.branch} 還沒合併所以留著；確定不要的話自己執行 git branch -D ${spec.branch}` };
}
