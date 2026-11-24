/** 以 Planner 的 marker／GitHub origin 辨識專案，離線時使用同身分的本機快取。 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function mainRepo(dir) {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(read(join(dir, '.git')))?.[1].trim();
  if (!gitdir) return dir;
  const resolved = resolve(dir, gitdir).replaceAll('\\', '/');
  const cut = resolved.toLowerCase().lastIndexOf('/.git/worktrees/');
  return cut < 0 ? dir : canonical(resolved.slice(0, cut));
}

function origin(root) {
  const config = read(join(root, '.git', 'config'));
  const section = /^\s*\[remote "origin"\]\s*([^\[]*)/m.exec(config)?.[1] ?? '';
  const url = /^\s*url\s*=\s*(\S+)\s*$/m.exec(section)?.[1] ?? '';
  const repo = /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/)([^/]+\/[^/]+)\/?$/i.exec(url)?.[1];
  return repo ? ('github.com/' + repo.replace(/\.git$/i, '')).toLowerCase() : null;
}

function marker(root) {
  const path = join(root, '.planner-id');
  if (!existsSync(path)) return null;
  return read(path).trim().toLowerCase();
}

export function locateProject(cwd, home = homedir()) {
  let dir = canonical(cwd);
  for (let i = 0; i < 40; i++) {
    const own = marker(dir);
    const isRepo = existsSync(join(dir, '.git'));
    if (own !== null && !uuid.test(own)) return null;
    if (own !== null || isRepo) {
      const root = isRepo ? mainRepo(dir) : dir;
      const id = own ?? marker(root);
      if ((id !== null && !uuid.test(id)) || (id === null && root === canonical(home))) return null;
      const remoteUrl = id ? null : origin(root);
      return id || remoteUrl ? { root, id, remoteUrl } : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function credentials(env) {
  const envFile = env.PLANNER_ENV_FILE || (env.PLANNER_ROOT && join(env.PLANNER_ROOT, '.env.local'));
  const file = new Map();
  for (const line of (envFile ? read(envFile) : '').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (match) file.set(match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  const token = env.PLANNER_TOKEN || file.get('PLANNER_TOKEN')
    || (env.PLANNER_API_TOKENS || file.get('PLANNER_API_TOKENS'))?.split(',')[0].trim();
  const url = env.PLANNER_URL || file.get('PLANNER_URL')
    || 'http://127.0.0.1:' + (file.get('PORT') || '3600');
  if (!token) throw new Error('Planner 未設定');
  return { token, url: url.replace(/\/+$/, '') };
}

export async function queryPlanner(candidate, env = process.env) {
  const { token, url } = credentials(env);
  const op = candidate.id ? 'project.list' : 'project.resolveByRemote';
  const response = await fetch(url + '/gateway', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ op, data: candidate.id ? {} : { remoteUrl: candidate.remoteUrl } }),
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  });
  if (!candidate.id && response.status === 404) return null;
  if (!response.ok) throw new Error('Planner HTTP ' + response.status);
  const { data } = await response.json();
  if (candidate.id) {
    if (!Array.isArray(data?.projects)) throw new Error('Planner 專案清單格式錯誤');
    return data.projects.find(project => typeof project?.id === 'string' && project.id.toLowerCase() === candidate.id)?.id ?? null;
  }
  if (!uuid.test(data?.id ?? '')) throw new Error('Planner 專案身分格式錯誤');
  return data.id;
}

function cacheEntries(path) {
  try {
    const entries = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(entries) ? entries : [];
  } catch { return []; }
}

async function storeEntry(path, entry) {
  const lock = path + '.lock';
  const temporary = path + '.' + randomUUID();
  let descriptor;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { descriptor = openSync(lock, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(25);
      descriptor = openSync(lock, 'wx', 0o600);
    }
    const current = cacheEntries(path);
    if (!entry.id && !current.some(item => item?.root === entry.root)) return;
    const entries = current.filter(item => item?.root !== entry.root);
    writeFileSync(temporary, JSON.stringify([...entries, entry]) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // 無法更新快取時，本次仍可使用 Planner 已確認的身分。
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
        rmSync(lock, { force: true });
        rmSync(temporary, { force: true });
      } catch { /* 清理失敗也不影響本次已確認的身分。 */ }
    }
  }
}

export async function identifyProject(cwd, { home = homedir(), env = process.env, lookup = queryPlanner } = {}) {
  const candidate = locateProject(cwd, home);
  if (!candidate) return null;
  const path = join(home, '.ai-cli', 'project-flow', 'cache.json');
  const key = candidate.id ?? candidate.remoteUrl;
  try {
    const id = await lookup(candidate, env);
    const entry = { root: candidate.root, key, id: id?.toLowerCase() ?? null, at: new Date().toISOString() };
    // 已查證無此專案時只撤銷舊資料，INIT 不替陌生資料夾建快取。
    if (entry.id || existsSync(path)) await storeEntry(path, entry);
    return entry.id ? { root: entry.root, id: entry.id } : null;
  } catch {
    const entry = cacheEntries(path).find(item => item?.root === candidate.root && item.key === key);
    if (!uuid.test(entry?.id ?? '') || !Number.isFinite(Date.parse(entry.at))) return null;
    return { root: candidate.root, id: entry.id, cachedAt: new Date(entry.at).toISOString() };
  }
}
