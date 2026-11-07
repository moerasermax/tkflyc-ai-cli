/**
 * develop 範本的工作區：每個 run 一個 worktree 和分支。
 *
 * worker 拿的是全權限，所以這裡做不到隔離，能做的是把交付關在一條分支上，並且事後查核。
 * 「事後」是重點：改到範圍外的東西會被抓到、不會被 commit，但已經發生的副作用撤不回來。
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mayBeAlive, sameIdentity } from '../core/job-store.js';
import { lookupIdentities } from '../core/live-jobs.js';
import type { CheckHandle, CheckpointRecord, CheckpointSpec, DevelopSpec, WorkspaceOps, WorkspaceState, ReleaseWorkspaceOps } from './types.js';

const exec = promisify(execFile);
const TAIL_BYTES = 8192;

/** UTF-8 最多四個 bytes 一字元；只讀有界前綴，context 不把 stderr 當成資料。 */
function contextPrefix(path: string, chars: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(chars * 4);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, size).toString('utf8').slice(0, chars);
  } finally { closeSync(fd); }
}

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

/** 遠端只選已設定的 origin，不把其他使用者分支當備份目的地。 */
export function aiCliKernelCheckpointSpec(repoRoot: string, runId: string, mode?: string): CheckpointSpec {
  if (mode !== undefined && !['push', 'local', 'off'].includes(mode)) throw new Error('checkpoint 必須是 push、local 或 off');
  const origin = git(repoRoot, 'remote', 'get-url', 'origin').status === 0;
  const selected = (mode ?? (origin ? 'push' : 'local')) as CheckpointSpec['mode'];
  if (selected === 'push' && !origin) throw new Error('checkpoint push 需要 origin 遠端');
  const ref = `ai-cli_kernel/checkpoints/${runId}`;
  mustGit(repoRoot, 'check-ref-format', `refs/heads/${ref}`);
  return { mode: selected, remote: selected === 'push' ? 'origin' : null, ref };
}

function checkpointName(spec: DevelopSpec): string {
  const ref = spec.checkpoint?.ref;
  if (!ref?.startsWith('ai-cli_kernel/checkpoints/')) throw new Error('不是 kernel 的回復點 ref');
  mustGit(spec.repoRoot, 'check-ref-format', `refs/heads/${ref}`);
  return `refs/heads/${ref}`;
}

/** 只建新分支，既有同名分支即拒絕；不 checkout、不 reset。 */
export function aiCliKernelRestoreCheckpointBranch(spec: DevelopSpec, checkpoint: CheckpointRecord, runId: string, apply: boolean): { branch: string; commit: string; command: string; applied: boolean } {
  if (!realWorkspace.checkpointValid(spec, checkpoint)) throw new Error('回復點 ref 已變動或 commit 不存在，拒絕 rollback');
  const branch = `restore/${runId}`;
  mustGit(spec.repoRoot, 'check-ref-format', `refs/heads/${branch}`);
  if (apply) mustGit(spec.repoRoot, 'branch', branch, checkpoint.commit);
  return { branch, commit: checkpoint.commit, command: `git switch -c ${branch} ${checkpoint.commit}`, applied: apply };
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
  const repoCommonDir = resolve(spec.repoRoot, mustGit(spec.repoRoot, 'rev-parse', '--git-common-dir').trim());
  if (!sameDir(commonDir, repoCommonDir)) throw new Error(`${spec.worktree} 不屬於 ${spec.repoRoot}，拒絕操作`);
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

export const realWorkspace: WorkspaceOps & ReleaseWorkspaceOps = {
  releaseBranchHead(spec) {
    mustGit(spec.repoRoot, 'check-ref-format', `refs/heads/${spec.branch}`);
    const head = mustGit(spec.repoRoot, 'show-ref', '--verify', '--hash', `refs/heads/${spec.branch}`).trim();
    mustGit(spec.repoRoot, 'merge-base', '--is-ancestor', spec.baseCommit, head);
    return head;
  },

  releaseTarget(spec, action, target, remote) {
    mustGit(spec.repoRoot, 'check-ref-format', `refs/heads/${target}`);
    if (target.startsWith('-')) throw new Error('target 不能是 git 選項');
    if (action === 'merge') return mustGit(spec.repoRoot, 'show-ref', '--verify', '--hash', `refs/heads/${target}`).trim();
    if (!remote) throw new Error('push 缺少 remote');
    const lines = mustGit(spec.repoRoot, 'ls-remote', '--heads', remote, `refs/heads/${target}`).trim().split('\n').filter(Boolean);
    const found = lines.find(line => line.split(/\s+/)[1] === `refs/heads/${target}`);
    return found ? found.split(/\s+/)[0] : null;
  },

  releaseRemoteUrl(spec, remote) {
    if (!remote || remote.startsWith('-') || /[\s\x00-\x1f]/.test(remote)) throw new Error('remote 必須是已設定的遠端名稱');
    // git push 用 pushurl；多目的地會產生部分成功，因此拒絕。
    const urls = mustGit(spec.repoRoot, 'remote', 'get-url', '--push', '--all', remote).trim().split('\n');
    const fetchUrl = mustGit(spec.repoRoot, 'remote', 'get-url', remote).trim();
    if (urls.length !== 1 || urls[0] !== fetchUrl) throw new Error('放行需要單一且與查詢相同的遠端 URL');
    return urls[0];
  },

  releaseDefaultBranch(spec, remote) {
    const output = mustGit(spec.repoRoot, 'ls-remote', '--symref', remote, 'HEAD');
    const ref = output.match(/^ref: refs\/heads\/(.+)\s+HEAD\s*$/m)?.[1];
    if (!ref) throw new Error('無法確認遠端預設分支，拒絕 push 放行');
    return ref;
  },

  releaseMergeReady(spec, target) {
    const branch = mustGit(spec.repoRoot, 'symbolic-ref', '-q', 'HEAD').trim();
    if (branch !== `refs/heads/${target}`) throw new Error(`merge 要求 repo 目前就在 target ${target}，不會自動切換分支`);
    if (mustGit(spec.repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all')) throw new Error('merge 要求工作樹與 index 乾淨（含未追蹤檔案）');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      const path = mustGit(spec.repoRoot, 'rev-parse', '--git-path', name).trim();
      if (existsSync(resolve(spec.repoRoot, path))) throw new Error('repo 有尚未結束的 git 操作，拒絕 merge');
    }
  },

  releaseExecute(spec, release) {
    // merge 永遠作用在目前所在的分支，指令本身綁不了目標。檢查之後有人切分支的話，會合併到人沒同意的地方，所以動手前最後再確認一次。
    if (release.action === 'merge' && git(spec.repoRoot, 'symbolic-ref', '-q', 'HEAD').stdout.trim() !== `refs/heads/${release.target}`) {
      return { status: 'failed', detail: `repo 已經不在 ${release.target}，沒有執行 merge。這次放行已用掉，確認後請重新建立。` };
    }
    const result = release.action === 'merge'
      ? git(spec.repoRoot, 'merge', '--ff-only', release.commit)
      : git(spec.repoRoot, '-c', `remote.${release.remote!}.mirror=false`, 'push', '--no-follow-tags', '--no-mirror', '--recurse-submodules=no', release.remote!, `${release.commit}:refs/heads/${release.target}`);
    // push 非零也可能是遠端成功後斷線；merge hook 也可能在更新 ref 後失敗。保守記 unknown。
    return result.status === 0 && !result.error
      ? { status: 'succeeded', detail: `${release.action} 完成：${release.commit}` }
      : { status: 'unknown', detail: `結果不明，絕不自動重試：${String(result.stderr || result.stdout || result.error).slice(0, 600)}` };
  },

  checkpointSnapshot(spec) {
    const ref = checkpointName(spec);
    const existing = git(spec.repoRoot, 'show-ref', '--verify', '--hash', ref);
    if (existing.status === 0) {
      const commit = existing.stdout.trim();
      mustGit(spec.repoRoot, 'cat-file', '-e', `${commit}^{commit}`);
      // 尚未落盤的舊 ref 只能是基準本身或以基準為單一 parent 的快照。
      const parents = mustGit(spec.repoRoot, 'rev-list', '--parents', '-n', '1', commit).trim().split(' ');
      if (commit !== spec.baseCommit && (parents.length !== 2 || parents[1] !== spec.baseCommit)) throw new Error('既有回復點和基準不符');
      return commit;
    }
    const head = mustGit(spec.repoRoot, 'rev-parse', 'HEAD').trim();
    if (head !== spec.baseCommit) throw new Error('來源 HEAD 和委任書基準不符，請重新建立委任書');
    const dir = mkdtempSync(join(tmpdir(), 'ai-cli_kernel-index-'));
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index'), GIT_TERMINAL_PROMPT: '0' };
    const indexed = (...args: string[]) => {
      const result = spawnSync('git', ['-C', spec.repoRoot, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024, env });
      if (result.status !== 0) throw new Error(`回復點 git ${args[0]} 失敗：${(result.stderr || String(result.error ?? '')).slice(0, 600)}`);
      return result.stdout.trim();
    };
    try {
      indexed('read-tree', 'HEAD');
      indexed('add', '-A');
      const tree = indexed('write-tree');
      if (tree === mustGit(spec.repoRoot, 'rev-parse', 'HEAD^{tree}').trim()) return head;
      return indexed('commit-tree', tree, '-p', head, '-m', `ai-cli_kernel checkpoint ${spec.checkpoint!.ref}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },

  checkpointRef(spec, commit) {
    const ref = checkpointName(spec);
    mustGit(spec.repoRoot, 'cat-file', '-e', `${commit}^{commit}`);
    const existing = git(spec.repoRoot, 'show-ref', '--verify', '--hash', ref);
    if (existing.status === 0) {
      if (existing.stdout.trim() !== commit) throw new Error('回復點 ref 已變動');
      return;
    }
    // 空 old-value 表示 ref 必須不存在，不能覆寫同時被人建立的分支。
    mustGit(spec.repoRoot, 'update-ref', ref, commit, '');
  },

  checkpointValid(spec, checkpoint) {
    if (checkpoint.ref !== spec.checkpoint?.ref) return false;
    const result = git(spec.repoRoot, 'show-ref', '--verify', '--hash', checkpointName(spec));
    return result.status === 0 && result.stdout.trim() === checkpoint.commit && git(spec.repoRoot, 'cat-file', '-e', `${checkpoint.commit}^{commit}`).status === 0;
  },

  checkpointSecretPaths(spec, commit) {
    // 推上去的不只有這次沒 commit 的改動：還沒上遠端的 commit 都會跟著出去。已經在遠端的，推不推都一樣。
    const remote = spec.checkpoint?.remote;
    const paths = mustGit(spec.repoRoot, 'log', '--no-renames', '--format=', '--name-only', '-z', commit, '--not', ...(remote ? [`--remotes=${remote}`] : [spec.baseCommit]));
    return [...new Set(paths.split('\0').map(path => path.trim()).filter(Boolean))].filter(path => {
      // .env.example 這類範本本來就是要進版控的，擋了每個專案都開不了工。
      return path.split('/').some(name => /^\.env(?:\.(?!example$|sample$|template$)|$)|\.(?:pem|key)$|^id_rsa$|^credentials|secret/i.test(name));
    });
  },

  pushCheckpoint(spec, commit) {
    const remote = spec.checkpoint?.remote;
    if (!remote || remote.startsWith('-')) throw new Error('回復點沒有有效遠端');
    const ref = checkpointName(spec);
    // push 完但事件沒落盤時，先查遠端，不能再推一次或覆寫別人的變更。
    const remoteRef = mustGit(spec.repoRoot, 'ls-remote', '--heads', remote, ref).trim();
    if (remoteRef) {
      if (remoteRef.split(/\s/)[0] !== commit) throw new Error('遠端回復點已指向其他 commit');
      return;
    }
    // 明確關掉會擴大範圍的設定：使用者的 push.followTags、mirror 不能讓回復點多推東西出去。
    mustGit(spec.repoRoot, '-c', `remote.${remote}.mirror=false`, 'push', '--no-follow-tags', '--no-mirror', '--recurse-submodules=no', remote, `${commit}:${ref}`);
  },

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
    // --no-renames：重新命名偵測開著時只會列出新路徑，把範圍外的檔案搬進範圍內就查不到來源端了。
    const committed = mustGit(spec.worktree, 'diff', '--no-renames', '--name-only', '-z', spec.baseCommit, 'HEAD').split('\0').filter(Boolean);
    return {
      branch: branch.status === 0 ? branch.stdout.trim() : null, head, dirty,
      changed: [...new Set([...committed, ...dirty])],
      ancestorOk: git(spec.worktree, 'merge-base', '--is-ancestor', spec.baseCommit, 'HEAD').status === 0,
    };
  },

  commitHistory(spec) {
    return mustGit(spec.worktree, 'rev-list', '--reverse', `${spec.baseCommit}..HEAD`, '--').split('\n').filter(Boolean);
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
      .split('\n').filter(line => {
        const ref = line.slice(line.indexOf(' ') + 1);
        return line && ref !== `refs/heads/${spec.branch}` && !ref.startsWith('refs/heads/ai-cli_kernel/checkpoints/') && !/^refs\/remotes\/[^/]+\/ai-cli_kernel\/checkpoints\//.test(ref);
      }).sort();
  },

  diffStat(spec) {
    return mustGit(spec.worktree, 'diff', '--stat', spec.baseCommit, 'HEAD').trimEnd();
  },

  diffText(spec, maxChars) {
    const text = mustGit(spec.worktree, 'diff', spec.baseCommit, 'HEAD');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（diff 太長，只附前 ${maxChars} 字元）` : text;
  },

  startCheck(command, cwd, logPath, outputChars) {
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a', 0o600);
    const stderrPath = outputChars !== undefined ? `${logPath}.stderr` : logPath;
    const errFd = outputChars !== undefined ? openSync(stderrPath, 'a', 0o600) : fd;
    // 輸出直接寫檔不走 pipe：runner 當掉時指令不會因為 pipe 斷掉而異常。
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', fd, errFd], detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    closeSync(fd);
    if (errFd !== fd) closeSync(errFd);
    const pid = child.pid;
    if (!pid) throw new Error(`無法啟動指令：${command}`);
    let settled: { exitCode: number | null } | null = null;
    const done = new Promise<void>(resolve => {
      child.once('exit', code => { settled = { exitCode: code }; resolve(); });
      child.once('error', () => { settled = { exitCode: null }; resolve(); });
    });
    const handle: CheckHandle = {
      pid,
      // 身分查詢有逾時，機器忙的時候會失敗。多試幾次，真的查不到就老實回空的，由呼叫端當成「認不出來」。
      async identify() {
        for (let attempt = 0; attempt < 3; attempt++) {
          const identity = (await lookupIdentities([pid]).catch(() => new Map())).get(pid);
          if (identity?.started) return { started: identity.started, name: identity.name };
          if (settled) break;
        }
        return { started: '', name: '' };
      },
      async wait(ms) {
        if (!settled) await Promise.race([done, new Promise(resolve => setTimeout(resolve, ms))]);
        return settled ? { exitCode: (settled as { exitCode: number | null }).exitCode, tail: readTail(stderrPath), ...(outputChars !== undefined ? { output: contextPrefix(logPath, outputChars) } : {}) } : null;
      },
      async kill() {
        await killTree(pid);
        await Promise.race([done, new Promise(resolve => setTimeout(resolve, 10000))]);
        return settled !== null;
      },
      tail: () => readTail(logPath),
    };
    return handle;
  },

  async stopOrphanCheck(check) {
    const lookup = async () => (await lookupIdentities([check.pid]).catch(() => new Map())).get(check.pid);
    const live = await lookup();
    // 身分查詢失敗也會查不到。pid 還在就不能說它停了，不然舊程序會和接手的人同時動工作目錄。
    if (!live) return !mayBeAlive(check.pid);
    // 當初沒查到身分：認不出來，不能殺（可能是別人的程序），也不能說它停了。
    if (!check.started) return false;
    // 已經被別的程序重用了，不是我們要找的那個。
    if (!sameIdentity(check, live)) return true;
    await killTree(check.pid);
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await lookup();
      if (current ? !sameIdentity(check, current) : !mayBeAlive(check.pid)) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  },
};

/** 使用者看完結果後清掉 worktree。分支只有已合併才刪，沒合併的留著，不替人丟工作。 */
export function cleanupWorkspace(spec: DevelopSpec): { worktreeRemoved: boolean; branchRemoved: boolean; detail: string } {
  // 上次刪到一半：git 已經取消登記，資料夾還在。這時 git 會往上找到別的 repo（家目錄也可能是），絕不能再當成 worktree 操作。
  const halfRemoved = () => existsSync(spec.worktree) && !existsSync(join(spec.worktree, '.git'));
  if (existsSync(spec.worktree) && !halfRemoved()) {
    assertOwnWorktree(spec);
    const removal = git(spec.repoRoot, 'worktree', 'remove', spec.worktree);
    if (removal.status !== 0 && !halfRemoved()) return { worktreeRemoved: false, branchRemoved: false, detail: `worktree 沒有移除：${String(removal.stderr).trim().slice(0, 400)}` };
  }
  git(spec.repoRoot, 'worktree', 'prune');
  const branch = git(spec.repoRoot, 'branch', '-d', spec.branch);
  if (halfRemoved()) {
    return { worktreeRemoved: false, branchRemoved: branch.status === 0, detail: `worktree 已從 git 移除，但這個資料夾有檔案刪不掉（可能被其他程式占用）：${spec.worktree}。確認沒有程式在用之後，請自己刪除。${branch.status === 0 ? '' : `分支 ${spec.branch} 還沒合併所以留著。`}` };
  }
  return branch.status === 0
    ? { worktreeRemoved: true, branchRemoved: true, detail: `worktree 和分支 ${spec.branch} 都移除了` }
    : { worktreeRemoved: true, branchRemoved: false, detail: `worktree 移除了。分支 ${spec.branch} 還沒合併所以留著；確定不要的話自己執行 git branch -D ${spec.branch}` };
}
