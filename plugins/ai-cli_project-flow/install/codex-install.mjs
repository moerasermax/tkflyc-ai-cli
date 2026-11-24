/** 結構化合併使用者層 Codex hooks，並同步原生 skill。 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, constants, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const events = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const marker = '--ai-cli-project-flow';
const adapter = fileURLToPath(new URL('../adapters/codex.mjs', import.meta.url));
const sourceSkill = fileURLToPath(new URL('../skills/project-flow/SKILL.md', import.meta.url));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = text => createHash('sha256').update(text).digest('hex');

function hookFor(event, path) {
  if (/["$%!\x60\r\n]/u.test(path)) throw new Error('外掛路徑含 shell 展開字元，請改用可供各 shell 共用的安裝路徑');
  const script = process.platform === 'win32' ? path.replaceAll('\\', '/') : path.replaceAll('\\', '\\\\');
  return { type: 'command', command: 'node "' + script + '" ' + event + ' ' + marker, timeout: 15 };
}

export function mergeHooks(original, { uninstall = false, emptyEvents = [], hadHooks = true,
  adapterPath = adapter } = {}) {
  if (!record(original) || (Object.hasOwn(original, 'hooks') && !record(original.hooks))) {
    throw new Error('hooks.json 根節點及 hooks 必須是物件');
  }
  const next = structuredClone(original);
  const hooks = next.hooks ?? {};
  for (const event of events) {
    if (!Object.hasOwn(hooks, event) && uninstall) continue;
    const groups = Object.hasOwn(hooks, event) ? hooks[event] : [];
    if (!Array.isArray(groups)) throw new Error(event + ' 必須是 matcher 群組陣列');
    const kept = groups.flatMap(group => {
      if (!Array.isArray(group?.hooks)) return [group];
      const items = group.hooks.filter(hook => hook?.type !== 'command' || typeof hook.command !== 'string'
        || !hook.command.endsWith(' ' + event + ' ' + marker));
      if (items.length === group.hooks.length) return [group];
      return items.length ? [{ ...group, hooks: items }] : [];
    });
    if (!uninstall) kept.push({ hooks: [hookFor(event, adapterPath)] });
    if (kept.length || emptyEvents.includes(event) || !groups.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length || (!uninstall || (next.hooks && hadHooks))) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

function optional(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function replaceFile(path, value) {
  const temp = path + '.project-flow-' + randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temp, value, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

/** dry-run 與實際執行共用同一個唯讀規劃程序。 */
export function planInstall(home, { uninstall = false, source = sourceSkill } = {}) {
  const hooksPath = join(home, '.codex', 'hooks.json');
  const skillPath = join(home, '.agents', 'skills', 'project-flow', 'SKILL.md');
  const receiptPath = join(dirname(skillPath), '.ai-cli-project-flow.json');
  const current = optional(hooksPath);
  const original = current === null ? {} : JSON.parse(current.replace(/^\uFEFF/, ''));
  const existing = optional(skillPath);
  const receiptText = optional(receiptPath);
  const receipt = receiptText === null ? null : JSON.parse(receiptText);
  if (receiptText !== null && (!record(receipt) || receipt.owner !== marker
      || !Array.isArray(receipt.emptyEvents) || typeof receipt.hadHooks !== 'boolean' || typeof receipt.hadFile !== 'boolean'
      || typeof receipt.skillDigest !== 'string' || !/^[\da-f]{64}$/.test(receipt.skillDigest))) {
    throw new Error('project-flow 安裝紀錄格式錯誤');
  }
  if (!uninstall && existing !== null && !receipt) throw new Error('project-flow skill 已存在，請先確認歸屬');
  const before = receipt ?? { owner: marker, hadFile: current !== null, hadHooks: Object.hasOwn(original ?? {}, 'hooks'),
    emptyEvents: events.filter(event => Array.isArray(original?.hooks?.[event]) && !original.hooks[event].length) };
  const desired = uninstall ? null : readFileSync(source, 'utf8');
  const skillEdited = existing !== null && receipt !== null && digest(existing) !== receipt.skillDigest && existing !== desired;
  if (!uninstall && skillEdited) throw new Error('已安裝的 project-flow skill 有本機修改，請先確認如何保留');
  const metadata = uninstall ? before : { ...before, skillDigest: digest(desired) };
  const next = mergeHooks(original, { uninstall, ...metadata });
  return { current, original, next, hooksPath, skillPath, receiptPath, receipt, metadata, desired, uninstall,
    hooksChanged: JSON.stringify(original) !== JSON.stringify(next),
    removeHooksFile: uninstall && receipt?.hadFile === false && current !== null && Object.keys(next).length === 0,
    skillChanged: uninstall ? receipt !== null && existing !== null && !skillEdited : existing !== desired,
    skillEdited,
    receiptChanged: uninstall ? receipt !== null : receipt?.skillDigest !== metadata.skillDigest };
}

function report(plan, dry) {
  console.log((dry ? '預覽' : '執行') + ' ' + (plan.uninstall ? '移除' : '安裝')
    + '，hooks ' + (plan.hooksChanged || plan.removeHooksFile ? '有變更' : '無變更')
    + '，skill ' + (plan.skillChanged ? '有變更' : '無變更'));
  if (plan.skillEdited) console.log('保留有本機修改的 project-flow skill。');
}

function apply(plan) {
  if ((plan.hooksChanged || plan.removeHooksFile) && plan.current !== null) {
    const backup = plan.hooksPath + '.project-flow-' + randomUUID() + '.bak';
    copyFileSync(plan.hooksPath, backup, constants.COPYFILE_EXCL);
    console.log('hooks 備份 ' + backup);
  }
  if (plan.uninstall) {
    if (plan.removeHooksFile) unlinkSync(plan.hooksPath);
    else if (plan.hooksChanged) replaceFile(plan.hooksPath, JSON.stringify(plan.next, null, 2) + '\n');
    if (plan.skillChanged) unlinkSync(plan.skillPath);
    if (plan.receiptChanged) unlinkSync(plan.receiptPath);
  } else {
    if (!plan.receipt) replaceFile(plan.receiptPath, JSON.stringify(plan.metadata) + '\n');
    if (plan.skillChanged) replaceFile(plan.skillPath, plan.desired);
    if (plan.receipt && plan.receiptChanged) replaceFile(plan.receiptPath, JSON.stringify(plan.metadata) + '\n');
    if (plan.hooksChanged) replaceFile(plan.hooksPath, JSON.stringify(plan.next, null, 2) + '\n');
    console.log('重開 Codex 並用 /hooks 信任 project-flow hooks。');
  }
}

function main(args) {
  if (args.some(arg => arg !== '--dry-run' && arg !== '--uninstall')) {
    throw new Error('用法 node codex-install.mjs [--dry-run] [--uninstall]');
  }
  const home = homedir();
  const options = { uninstall: args.includes('--uninstall') };
  if (!options.uninstall) {
    // PowerShell 對帶引號的執行檔路徑需要呼叫運算子。共用命令以 PATH 找 node。
    const node = spawnSync('node', ['--version'], { encoding: 'utf8', timeout: 1500, windowsHide: true });
    if (node.status !== 0) throw new Error('PATH 找不到可執行的 node，請確認啟動 Codex 的環境可執行 node --version');
  }
  if (args.includes('--dry-run')) {
    report(planInstall(home, options), true);
    return;
  }
  const codexDir = join(home, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const lock = join(codexDir, '.ai-cli-project-flow-install.lock');
  let descriptor;
  try { descriptor = openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('安裝鎖已存在 ' + lock + '。請先確認有無其他安裝程序正在執行。');
  }
  try {
    const plan = planInstall(home, options);
    report(plan, false);
    apply(plan);
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
