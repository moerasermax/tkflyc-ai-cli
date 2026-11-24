/** 以 Planner 的 marker／GitHub origin 辨識專案，離線時使用同身分的本機快取。 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const plannerUnconfigured = Symbol('Planner 未設定');
const staleLockMs = 10_000;

function canonical(path) {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

export function pathKey(path) {
  return process.platform === 'win32' ? normalize(path).toLowerCase() : path;
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
      const id = root === dir ? own : marker(root) ?? own;
      if ((id !== null && !uuid.test(id)) || (id === null && pathKey(root) === pathKey(canonical(home)))) return null;
      const remoteUrl = id ? null : origin(root);
      return id || remoteUrl ? { root, checkoutRoot: dir, id, remoteUrl } : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readJson(path) {
  try { return JSON.parse(read(path).replace(/^\uFEFF/u, '')); } catch { return null; }
}

function* detectedEnvFiles(home) {
  for (const settingsPath of [join(home, '.claude', 'settings.json'), join(home, '.codex', 'hooks.json')]) {
    for (const groups of Object.values(readJson(settingsPath)?.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!Array.isArray(group?.hooks)) continue;
        for (const hook of group.hooks) {
          for (const command of [hook?.command, hook?.commandWindows]) {
            if (typeof command !== 'string') continue;
            for (const arg of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"';|&]+)/gu)) {
              const path = (arg[1] ?? arg[2] ?? arg[3]).replace(/^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/])/iu, () => home);
              if (isAbsolute(path) && /[\\/]tkflyc-planner[\\/]mcp[\\/]session-(?:start|end)-hook\.mjs$/iu.test(path)) {
                yield join(dirname(dirname(path)), '.env.local');
              }
            }
          }
        }
      }
    }
  }
}

function* envFiles(env, home) {
  if (env.PLANNER_ENV_FILE) yield env.PLANNER_ENV_FILE;
  if (env.PLANNER_ROOT) yield join(env.PLANNER_ROOT, '.env.local');
  const config = readJson(join(home, '.ai-cli', 'project-flow', 'config.json'));
  if (typeof config?.plannerEnvFile === 'string' && config.plannerEnvFile) yield config.plannerEnvFile;
  if (typeof config?.plannerRoot === 'string' && config.plannerRoot) yield join(config.plannerRoot, '.env.local');
  yield* detectedEnvFiles(home);
}

function readEnv(path) {
  const file = new Map();
  for (const line of read(path).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=(.*)$/u.exec(line);
    if (match) file.set(match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return file;
}

function credentials(env, home) {
  const envToken = env.PLANNER_TOKEN?.trim() || env.PLANNER_API_TOKENS?.split(',')[0].trim();
  if (envToken && env.PLANNER_URL) return { token: envToken, url: env.PLANNER_URL.replace(/\/+$/, '') };
  let token = envToken;
  let url = env.PLANNER_URL;
  for (const path of envFiles(env, home)) {
    const file = readEnv(path);
    const fileToken = file.get('PLANNER_TOKEN') || file.get('PLANNER_API_TOKENS')?.split(',')[0].trim();
    const fileUrl = file.get('PLANNER_URL') || (file.get('PORT') && 'http://127.0.0.1:' + file.get('PORT'));
    if (!(token || fileToken) || (token && !fileUrl && !fileToken)) continue;
    token ||= fileToken;
    url ||= fileUrl;
    break;
  }
  if (!token) throw plannerUnconfigured;
  url ||= 'http://127.0.0.1:3600';
  return { token, url: url.replace(/\/+$/, '') };
}

export async function queryPlanner(candidate, env = process.env, home = homedir()) {
  const { token, url } = credentials(env, home);
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
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleLockMs) rmSync(lock, { force: true });
        else await delay(25);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      descriptor = openSync(lock, 'wx', 0o600);
    }
    const current = cacheEntries(path);
    const rootKey = pathKey(entry.root);
    const entries = current.filter(item => typeof item?.root === 'string' && pathKey(item.root) !== rootKey);
    if (!entry.id && current.length === entries.length) return;
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
  if (!candidate) {
    if (lookup === queryPlanner) {
      try { credentials(env, home); } catch (error) {
        if (error === plannerUnconfigured) return { plannerUnconfigured: true };
      }
    }
    return null;
  }
  const path = join(home, '.ai-cli', 'project-flow', 'cache.json');
  const key = candidate.id ?? candidate.remoteUrl;
  try {
    const id = await lookup(candidate, env, home);
    const entry = { root: candidate.root, key, id: id?.toLowerCase() ?? null, at: new Date().toISOString() };
    // 已查證無此專案時只撤銷舊資料，INIT 不替陌生資料夾建快取。
    if (entry.id || existsSync(path)) await storeEntry(path, entry);
    return entry.id ? { ...candidate, id: entry.id } : null;
  } catch (error) {
    const rootKey = pathKey(candidate.root);
    const entry = cacheEntries(path).find(item => typeof item?.root === 'string' && pathKey(item.root) === rootKey && item.key === key);
    if (!uuid.test(entry?.id ?? '') || !Number.isFinite(Date.parse(entry.at))) {
      return error === plannerUnconfigured ? { plannerUnconfigured: true } : null;
    }
    return { ...candidate, id: entry.id, cachedAt: new Date(entry.at).toISOString() };
  }
}
