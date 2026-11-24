/**
 * 原始碼安裝的背景更新器。只依賴 Node 內建模組；更新子程序不能載入會被替換的
 * app / native addon。執行中的 MCP 繼續使用已載入的版本，下次啟動才生效。
 * 所有外部指令都有逾時，對外操作只回結構化結果，不把更新失敗變成服務失敗。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type UpdatePolicy = 'on' | 'check' | 'off';
export interface UpdateOptions { repoRoot?: string; force?: boolean }
export interface UpdateCommit { sha: string; subject: string }
export interface UpdateState {
  checkedAt: string | null;
  branch: string | null;
  local: string | null;
  remote: string | null;
  behind: number;
  available: boolean;
  lastApplied: { at: string; from: string; to: string; ok: boolean; commits: UpdateCommit[]; message: string } | null;
  notice: string | null;
  /** 已經在 run／models 回應裡送到呼叫端 AI 面前的那一則 notice；與 notice 相同才算送達。 */
  noticeDelivered: string | null;
  /** notice 是更新帶來的待辦（不是 check 政策的「有新版」），check 不得覆蓋它。 */
  noticeFromUpdate: boolean;
  /** 還沒交代完的範圍起點：上一批沒送達又來一次更新時，從這裡接著算，不從這次的 from 算。 */
  pendingFrom: string | null;
  /** 範圍終點。獨立記，不靠 lastApplied：更新失敗回滾會把 lastApplied 換成失敗紀錄（稽核第 2 輪）。 */
  pendingTo: string | null;
  /** 這個範圍裡已經送到模型面前過的事；去重要看累積的，不能只看目前這一則。 */
  shownActions: string[];
}
export interface CommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type UpdateResult = UpdateState & {
  supported: boolean;
  policy: UpdatePolicy;
  ok?: boolean;
  reason?: string;
  applied?: boolean;
  rolledBack?: boolean;
  log?: CommandResult[];
};

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MINUTE = 60_000;
const GIT_TIMEOUT = 20_000;
const emptyState = (): UpdateState => ({
  checkedAt: null, branch: null, local: null, remote: null, behind: 0,
  available: false, lastApplied: null, notice: null, noticeDelivered: null,
  noticeFromUpdate: false, pendingFrom: null, pendingTo: null, shownActions: [],
});
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const repoOf = (options: UpdateOptions): string => resolve(options.repoRoot || process.env.AI_CLI_UPDATE_REPO_ROOT || DEFAULT_ROOT);
const stateDir = (): string => process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
const statePath = (): string => join(stateDir(), 'update.json');
const lockPath = (): string => join(stateDir(), 'update.lock');

/**
 * 「程式碼過去了，但那台機器還不能用」的缺口。
 *
 * 自動更新帶得動 repo 裡的東西，帶不動每台機器自己的狀態——`providers.json` 的 API 金鑰
 * 不在版控裡，`~/.claude/plugins/` 的副本 `git pull` 也碰不到。這種事只有站在那台機器前
 * 的人做得到，而他不會知道要做，除非我們說。
 *
 * **key 是引入這件事的 commit。** 只有當這次更新真的包含那個 commit 時才附上提醒，
 * 所以每台機器只會看到一次——已經更新過的機器不會再被提醒，而這正是它跟「在提示裡
 * 寫一段固定文字」的差別：後者會變成每次更新都出現的永久噪音，然後被忽略。
 */
const POST_UPDATE_ACTIONS: ReadonlyArray<{ sha: string; action: string }> = [
  {
    sha: '4a06d74',
    action:
      '【要動手】程式碼修改驗證閘門已移除，但 Claude Code plugin 是安裝時複製到 ' +
      '~/.claude/plugins/ 的副本，git pull 碰不到它——不手動移除的話它會繼續用舊版判定擋你。\n' +
      '  在 Claude Code 輸入：/plugin uninstall ai-cli-verification-gate@ai-cli-mcp\n' +
      '                      /plugin marketplace remove ai-cli-mcp\n' +
      '  然後跑：node tools/check-gate-removed.mjs（檢查七處，全乾淨回 exit 0；只回報不改設定）',
  },
  {
    sha: '020984d',
    action:
      '【要動手，選用】派工建議表現在也有一份 Claude Code 的 SessionStart hook，' +
      '會在每個 session 開頭直接告訴模型「什麼情境派哪一顆」，不必等它想到要查 models。\n' +
      '  安裝（每台機器一次）：\n' +
      '    cp tools/hooks/aicli-model-policy.py ~/.claude/scripts/aicli_model_policy.py\n' +
      '    再到 ~/.claude/settings.json 的 hooks.SessionStart 加一筆 command hook 指向它\n' +
      '    （完整片段見 tools/hooks/aicli-model-policy.py 的檔頭）\n' +
      '  裝好之後它會隨 git pull 更新，內容改了不必重裝、也不必再動 settings.json。\n' +
      '  不裝也行：同一份建議在 mcp__ai-cli__models 的 dispatchGuidance / knownBadModels 裡，\n' +
      '  那個隨自動更新過去、不需要安裝。hook 的差別只是「不必等 AI 想到要查」。\n' +
      '  ai-cli 不會自己去改你的 settings.json——派工工具靜默改寫使用者的設定是壞設計。',
  },
  {
    sha: 'b8f7865',
    action:
      '【要動手，想用才需要】NVIDIA 免費 API（build.nvidia.com）現在接得上了，' +
      '但金鑰與設定不在版控裡，每台機器要自己加。\n' +
      '  編 ~/.local/share/ai-cli/providers.json，加一筆 nv：\n' +
      '    base_url: https://integrate.api.nvidia.com/v1\n' +
      '    api_key : 你自己的 nvapi- 金鑰（去 build.nvidia.com 申請，免費、不用信用卡）\n' +
      '    retry   : { "max_retries": 3, "initial_delay_ms": 1000 }\n' +
      '    model_extra_body: nemotron-3.5-lightning-30b-a3b → reasoning_effort "none"、' +
      'nemotron-3-ultra-550b-a55b → "medium"、muse-glimmer-30b → max_tokens 16384\n' +
      '  ⚠️ 那個檔是整份 fail-closed，任何一筆寫壞會連 openrouter/dashscope 一起掛，先備份。\n' +
      '  實測 10/10 的三顆：nv-openai/gpt-oss-20b（最快）、' +
      'nv-nvidia/nemotron-3.5-lightning-30b-a3b（1M context）、nv-meta/muse-glimmer-30b（較難的 coding）',
  },
];

/**
 * 這次更新帶進來的 commit 裡，有哪些需要人動手的後續。
 *
 * 用 startsWith 比對短 sha：`git log` 給的是完整 sha，而上面的表寫短碼比較好讀。
 */
export function postUpdateActions(commits: ReadonlyArray<{ sha: string }>): string[] {
  return POST_UPDATE_ACTIONS.filter(({ sha }) => commits.some((c) => c.sha.startsWith(sha))).map(
    ({ action }) => action
  );
}

/**
 * 隨 repo 散布、但每台機器要自己裝的 Claude Code 外掛。npm 套件不收 `plugins/`，
 * `git pull` 也碰不到 Claude Code 實際執行的 `~/.claude/plugins/cache/` 副本，
 * 所以外掛改版後，這台機器沒裝或裝舊版的話，要在更新提示裡請呼叫端 AI 問使用者。
 */
const BUNDLED_PLUGINS: ReadonlyArray<{ name: string; dir: string; marketplace: string; repo: string; label: string; description: string }> = [
  { name: 'ai-cli-jobs', dir: 'plugins/ai-cli-jobs', marketplace: 'tkflyc-ai-cli', repo: 'moerasermax/tkflyc-ai-cli', label: 'ai-cli-jobs 派工面板',
    description: '它會在 Claude Code 輸入框上方列出全機 ai-cli job。' },
  { name: 'ai-cli_kernel_panel', dir: 'plugins/ai-cli_kernel_panel', marketplace: 'tkflyc-ai-cli', repo: 'moerasermax/tkflyc-ai-cli', label: 'ai-cli_kernel_panel 核心控制面板',
    description: '它會顯示 kernel run 的狀態、進度和報告，並提供兩步確認的操作。' },
  { name: 'ai-cli_project-flow', dir: 'plugins/ai-cli_project-flow', marketplace: 'tkflyc-ai-cli', repo: 'moerasermax/tkflyc-ai-cli', label: 'ai-cli_project-flow 專案既定流程',
    description: '它會依 Planner 專案身分與專案設定載入流程規則。' },
];
// npm 套件不含 plugins/，用這版隨附的基準。原始碼安裝永遠優先使用 repo manifest。
const SHIPPED_PLUGIN_VERSIONS: Readonly<Record<string, string>> = {
  'ai-cli-jobs': '0.2.0',
  'ai-cli_kernel_panel': '0.1.0',
  'ai-cli_project-flow': '0.1.0',
};

function pluginVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 32 && /^\d+\.\d+\.\d+$/.test(value)
    && !/[\r\n]/.test(value) ? value : undefined;
}

function installationLabel(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 119) + '…' : clean;
}

/** 只比 `x.y.z`；任一邊解析不出來就當「不比」，不憑猜測叫人更新（稽核：亂碼版本曾被當成 0.0.0）。 */
function olderVersion(installed: string, latest: string): boolean {
  const parts = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1, 4).map(Number);
  const [a, b] = [parts(installed), parts(latest)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** installed_plugins.json 裡的一份安裝：版本，與它裝在哪（user，或 project 的路徑）。 */
export interface InstalledCopy { version: string; where: string }

/**
 * 一個外掛該不該問、問什麼。`installed` 為 null 表示讀不到安裝紀錄或紀錄有缺（不是「沒裝」）；
 * `knownMarketplace` 為 false 時安裝與更新都要先加 marketplace。
 */
export function pluginAction(plugin: { name: string; marketplace: string; repo: string; label: string; description?: string },
  latest: string, installed: readonly InstalledCopy[] | null, knownMarketplace: boolean, otherProject?: string): string | null {
  const id = `${plugin.name}@${plugin.marketplace}`;
  const ask = '（給呼叫端 AI：請先問使用者要不要做，使用者同意才執行；不同意就略過，不要自己裝。）';
  const add = knownMarketplace ? '' : `    claude plugin marketplace add ${plugin.repo}\n`;
  const update = `${add}    claude plugin marketplace update ${plugin.marketplace}\n    claude plugin update ${id}\n  做完要重開 Claude Code 才生效。`;
  const install = `${add}    claude plugin install ${id}\n  做完要重開 Claude Code 才生效。`;
  if (installed === null) {
    return `【要問使用者】${plugin.label}有新版 ${latest}，但讀不到這台機器的外掛安裝紀錄，無法判斷有沒有裝。${ask}\n` +
      `  已安裝的話，更新：\n${update}\n  沒裝而想裝的話：\n${install}`;
  }
  if (!installed.length) {
    const status = otherProject ? `只裝在 ${otherProject} 範圍，目前專案還沒裝。` : '這台機器還沒裝。';
    return `【要問使用者】${plugin.label}有新版 ${latest}，${status}${plugin.description ?? ''}` +
      `要不要安裝？${ask}\n  安裝：\n${install}`;
  }
  const stale = installed.filter((copy) => olderVersion(copy.version, latest));
  if (!stale.length) return null;
  // 多份安裝（user＋project）時說清楚是哪一份舊，使用者才知道要更新哪裡。
  return `【要問使用者】${plugin.label}有新版 ${latest}，這台機器裝的是 ${stale.map((c) => `${c.version}（${c.where}）`).join('、')}。` +
    `git pull 碰不到 Claude Code 執行的那份副本，要另外更新。要不要更新？${ask}\n  更新：\n${update}`;
}

/** 同步讀小型一般檔案；null 表示檔案不存在，undefined 表示無法確認內容。 */
export function readEquipmentFile(path: string): string | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    return offset === stat.size ? buffer.toString('utf8', 0, offset).replace(/^\uFEFF/, '') : undefined;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

function readPluginJson(path: string): Record<string, unknown> | null | undefined {
  const contents = readEquipmentFile(path);
  if (contents == null) return contents;
  try {
    const value = JSON.parse(contents);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  return undefined;
}

type ScopedCopy = InstalledCopy & { scope: string; projectPath?: string };

function installedCopies(plugins: unknown, id: string): ScopedCopy[] | null {
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return null;
  const entries = (plugins as Record<string, unknown>)[id];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return null;
  const copies: ScopedCopy[] = [];
  for (const copy of entries) {
    const version = pluginVersion(copy?.version);
    if (!version) return null;
    const projectPath = typeof copy.projectPath === 'string' && copy.projectPath ? copy.projectPath : undefined;
    const scope = typeof copy.scope === 'string' ? copy.scope : projectPath ? 'project' : 'user';
    const where = projectPath && scope !== 'user' ? `project：${installationLabel(projectPath)}` : installationLabel(scope);
    copies.push({ version, where, scope, projectPath });
  }
  return copies;
}

const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const scopePath = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

function claudePluginActions(root: string, claudeDir: string, plugins: typeof BUNDLED_PLUGINS, session: boolean): string[] {
  if (!plugins.length) return [];
  const record = readPluginJson(join(claudeDir, 'plugins', 'installed_plugins.json'));
  const missing = record === null && statSync(claudeDir, { throwIfNoEntry: false })?.isDirectory();
  const marketplaces = readPluginJson(join(claudeDir, 'plugins', 'known_marketplaces.json'));
  const cwd = session ? scopePath(process.cwd()) : undefined;
  const actions: string[] = [];
  for (const plugin of plugins) {
    const manifest = readPluginJson(join(root, plugin.dir, '.claude-plugin', 'plugin.json'));
    const latest = pluginVersion(manifest?.version) ?? (session ? SHIPPED_PLUGIN_VERSIONS[plugin.name] : undefined);
    if (!latest) continue;
    let installed = missing ? [] : installedCopies(record?.plugins, `${plugin.name}@${plugin.marketplace}`);
    let otherProject: string | undefined;
    if (cwd !== undefined && installed) {
      const active = installed.filter(({ scope, projectPath }) => scope === 'user'
        || (projectPath && isAbsolute(projectPath) && scopePath(projectPath) === cwd));
      if (!active.length && installed.length) {
        const scopes = installed.map(({ projectPath }) => projectPath && isAbsolute(projectPath) ? installationLabel(projectPath) : '');
        if (scopes.every(Boolean)) otherProject = installationLabel([...new Set(scopes)].join('、'));
        else installed = null;
      }
      if (installed) installed = active;
    }
    const known = !!marketplaces && Object.hasOwn(marketplaces, plugin.marketplace);
    const action = pluginAction(plugin, latest, installed, known, otherProject);
    if (!action) continue;
    if (!session) {
      actions.push(action);
      continue;
    }
    const current = action.replace(`有新版 ${latest}`, `（標配版本 ${latest}）`);
    actions.push(known ? current.replace('    claude plugin install',
      `    claude plugin marketplace update ${plugin.marketplace}\n    claude plugin install`) : current);
  }
  return actions;
}

/** 讀這次更新動到的外掛；讀不到 repo 版本就不問。 */
export function bundledPluginActions(root: string, changedFiles: readonly string[], claudeDir = claudeConfigDir()): string[] {
  if (!existsSync(claudeDir)) return [];
  // git 對含非 ASCII 字元的路徑可能在開頭加雙引號。
  const changed = BUNDLED_PLUGINS.filter((plugin) =>
    changedFiles.some((name) => name.replace(/^"/, '').startsWith(`${plugin.dir}/`)));
  return claudePluginActions(root, claudeDir, changed, false);
}

export function standardClaudeActions(root: string): string[] {
  return claudePluginActions(root, claudeConfigDir(), BUNDLED_PLUGINS, true);
}

/** MCP 開場已交代的標配，從工具回應與 logging 的更新通知去重，保留更新狀態原文。 */
export function omitStandardUpdateActions(notice: string, shown: readonly string[]): string {
  const labels = BUNDLED_PLUGINS.filter(({ label }) => shown.some((item) => item.startsWith(`【要問使用者】${label}`)))
    .map(({ label }) => `【要問使用者】${label}有新版 `);
  if (!labels.length) return notice;
  const sections = notice.split('\n\n');
  const countAt = sections.findIndex((part) => /^(?:這次更新|ai-cli 上次更新（[^\n]+）)有 \d+ 件事需要你在這台機器上動手：$/.test(part));
  if (countAt < 0) return notice;
  const actions = sections.slice(countAt + 1);
  const pending = actions.filter((action) => !labels.some((label) => action.startsWith(label)));
  if (pending.length === actions.length) return notice;
  const header = sections.slice(0, countAt);
  if (pending.length) header.push(sections[countAt]!.replace(/有 \d+ 件事/, `有 ${pending.length} 件事`));
  return [...header, ...pending].join('\n\n');
}

export function getUpdatePolicy(): UpdatePolicy {
  const value = process.env.AI_CLI_AUTO_UPDATE;
  return value === 'off' || value === 'check' ? value : 'on';
}

export function updateCheckIntervalMs(): number {
  const seconds = Number(process.env.AI_CLI_UPDATE_CHECK_INTERVAL_SEC ?? 3600);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= Math.floor(2_147_483_647 / 1000)
    ? seconds * 1000 : 3_600_000;
}

function unsupportedReason(options: UpdateOptions): string | null {
  const root = repoOf(options);
  return existsSync(join(root, '.git')) && existsSync(join(root, 'package.json'))
    ? null : '此安裝不支援原始碼更新：repo 根目錄必須有 .git 與 package.json';
}

function readState(): UpdateState {
  try {
    const value = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
    const state = emptyState();
    for (const key of ['checkedAt', 'branch', 'local', 'remote', 'notice', 'noticeDelivered', 'pendingFrom', 'pendingTo'] as const) {
      if (typeof value[key] === 'string') state[key] = value[key];
    }
    state.noticeFromUpdate = value.noticeFromUpdate === true;
    if (Array.isArray(value.shownActions) && value.shownActions.every((a: unknown) => typeof a === 'string')) state.shownActions = value.shownActions;
    if (Number.isSafeInteger(value.behind) && value.behind >= 0) state.behind = value.behind;
    state.available = value.available === true;
    const last = value.lastApplied;
    if (last && ['at', 'from', 'to', 'message'].every((k) => typeof last[k] === 'string')
      && typeof last.ok === 'boolean' && Array.isArray(last.commits)
      && last.commits.every((c: UpdateCommit) => c && typeof c.sha === 'string' && typeof c.subject === 'string')) {
      state.lastApplied = last;
    }
    return state;
  } catch { return emptyState(); }
}

function writeState(state: UpdateState): string | null {
  const temp = `${statePath()}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    renameSync(temp, statePath());
    return null;
  } catch (error) { return `無法寫入更新狀態：${messageOf(error)}`; }
  finally { try { unlinkSync(temp); } catch {} }
}

/** 同步讀狀態，doctor/models/run 不因更新而等待 git 或網路。 */
export function getUpdateStatus(options: UpdateOptions = {}): UpdateResult {
  try {
    const reason = unsupportedReason(options);
    return reason ? { ...emptyState(), supported: false, policy: getUpdatePolicy(), reason }
      : { ...readState(), supported: true, policy: getUpdatePolicy() };
  } catch (error) {
    return { ...emptyState(), supported: false, policy: getUpdatePolicy(), reason: messageOf(error) };
  }
}

/**
 * 給 run／models 的回應用：讀取不清除（只有新版啟動時才清除），但記下這則已送到呼叫端 AI 面前。
 * 背景通知（stderr／logging）模型看不到，不能用這個，否則沒人看過的提示會被當成送達。
 */
export function consumeNotice(options: UpdateOptions = {}): string | null {
  const status = getUpdateStatus(options);
  if (status.supported && status.notice !== null && status.noticeDelivered !== status.notice) {
    // 寫不進去只代表下次啟動會多問一次，不影響這次回應。
    writeState({ ...readState(), noticeDelivered: status.notice });
  }
  return status.notice;
}

/**
 * 上次更新帶進來、要人動手的事，由**現在這版**的程式重算。
 *
 * 寫更新提示的是更新前就載入的舊版 updater（更新子程序刻意不載入會被替換的程式），所以新加的
 * 判斷在「帶進它的那次更新」不會生效——首次帶入面板提問的那次更新就沒問（稽核：Codex gpt-6.1-sol）。
 */
async function pendingActions(root: string, from: string, to: string, shown: readonly string[]): Promise<string[] | null> {
  const diff = await spawnUpdateCommand(root, 'git', ['diff', '--name-only', `${from}..${to}`], GIT_TIMEOUT);
  const log = await spawnUpdateCommand(root, 'git', ['log', '--format=%H', `${from}..${to}`], GIT_TIMEOUT);
  // 算不出來就回 null，呼叫端保留原狀；當成「沒有變更」會把還沒交代的事清掉（稽核第 2 輪）。
  if (!diff.ok || !log.ok) return null;
  const commits = log.stdout.split(/\r?\n/).filter(Boolean).map((sha) => ({ sha }));
  return [...postUpdateActions(commits), ...bundledPluginActions(root, diff.stdout.split(/\r?\n/))]
    .filter((action) => !shown.includes(action));
}

/**
 * 這則 notice 若是更新帶來的待辦，回傳它涵蓋的範圍；不是（沒有 notice，或是 check 政策的「有新版」）回 null。
 * 舊版 updater 不寫 noticeFromUpdate／pendingFrom／pendingTo，就看 notice 是不是上次成功更新的訊息本身，範圍取那次更新。
 */
function pendingRange(state: UpdateState): { from: string; to: string } | null {
  const last = state.lastApplied?.ok ? state.lastApplied : null;
  if (state.notice === null || !(state.noticeFromUpdate || state.notice === last?.message)) return null;
  const from = state.pendingFrom ?? last?.from;
  const to = state.pendingTo ?? last?.to;
  return from && to ? { from, to } : null;
}

/** shell 只用於 Windows npm.cmd；參數均為程式內固定值，git 參數不經 shell。 */
export function spawnUpdateCommand(root: string, binary: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const result: CommandResult = { command: [binary, ...args].join(' '), ok: false, code: null, stdout: '', stderr: '', timedOut: false };
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolveResult(result); } };
    try {
      const npmOnWindows = process.platform === 'win32' && binary === 'npm';
      const child = spawn(npmOnWindows ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe') : binary,
        npmOnWindows ? ['/d', '/s', '/c', `"npm.cmd ${args.join(' ')}"`] : args, {
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          windowsVerbatimArguments: npmOnWindows, detached: process.platform !== 'win32',
          // 煙霧測試不啟動下一輪更新、不替仍在執行的 server 清提示；git 不等待登入互動。
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', AI_CLI_UPDATE_SKIP_STARTUP: '1' },
        });
      child.stdout.setEncoding('utf8').on('data', (s: string) => { result.stdout = (result.stdout + s).slice(-1_048_576); });
      child.stderr.setEncoding('utf8').on('data', (s: string) => { result.stderr = (result.stderr + s).slice(-1_048_576); });
      child.on('error', (error) => { result.stderr += messageOf(error); finish(); });
      child.on('close', (code) => { result.code = code; result.ok = code === 0 && !result.timedOut; finish(); });
      timer = setTimeout(() => {
        result.timedOut = true;
        result.stderr += `\n指令逾時（${timeoutMs} ms）`;
        try {
          if (process.platform === 'win32' && child.pid) {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            const killTimer = setTimeout(() => { killer.kill(); child.kill(); finish(); }, 5000);
            killer.on('error', () => { clearTimeout(killTimer); child.kill(); finish(); });
            killer.on('close', () => { clearTimeout(killTimer); finish(); });
          } else { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill(); }
        } catch { child.kill(); finish(); }
      }, timeoutMs);
    } catch (error) { result.stderr = messageOf(error); finish(); }
  });
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function lockIsLive(): boolean {
  try {
    const lock = JSON.parse(readFileSync(lockPath(), 'utf8'));
    const at = typeof lock.at === 'number' ? lock.at : Date.parse(lock.at);
    return Number.isFinite(at) && Date.now() - at < 30 * MINUTE && isAlive(lock.pid);
  } catch {
    // 剛 wx 成功的 writer 可能還沒寫完 pid。新空檔也要視為持鎖，不能立即搶走。
    try { return Date.now() - statSync(lockPath()).mtimeMs < 30 * MINUTE; } catch { return false; }
  }
}

function acquireLock(): { release?: () => void; reason?: string } {
  const token = randomUUID();
  try {
    mkdirSync(stateDir(), { recursive: true });
    // wx 是跨 process 的仲裁；不能先 exists 再普通 write。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath(), 'wx');
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })); }
        finally { closeSync(fd); }
        return { release: () => {
          try { if (JSON.parse(readFileSync(lockPath(), 'utf8')).token === token) unlinkSync(lockPath()); } catch {}
        } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (lockIsLive()) return { reason: '另一個 ai-cli 更新程序仍在執行（update.lock）' };
        try { unlinkSync(lockPath()); } catch {}
      }
    }
    return { reason: '無法取得 update.lock' };
  } catch (error) { return { reason: `無法取得 update.lock：${messageOf(error)}` }; }
}

async function branchOf(root: string): Promise<string> {
  if (process.env.AI_CLI_UPDATE_BRANCH) return process.env.AI_CLI_UPDATE_BRANCH;
  const upstream = await spawnUpdateCommand(root, 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], GIT_TIMEOUT);
  return upstream.ok && upstream.stdout.trim().includes('/') ? upstream.stdout.trim().split('/').slice(1).join('/') : 'master';
}

async function changesUrl(root: string, branch: string): Promise<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (typeof pkg.homepage === 'string' && pkg.homepage.trim()) return pkg.homepage.trim();
  } catch {}
  const remote = await spawnUpdateCommand(root, 'git', ['remote', 'get-url', 'origin'], GIT_TIMEOUT);
  const match = remote.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `https://github.com/${match[1]}/${match[2]}/blob/${branch}/CHANGELOG.md` : 'CHANGELOG.md';
}

export async function checkForUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const status = getUpdateStatus(options);
  if (!status.supported || status.policy === 'off') return status;
  if (!options.force && status.checkedAt && Date.now() - Date.parse(status.checkedAt) < updateCheckIntervalMs()) return status;
  if (lockIsLive()) return { ...status, reason: '更新進行中，稍後再檢查' };
  const log: CommandResult[] = [];
  try {
    const root = repoOf(options);
    const branch = await branchOf(root);
    for (const args of [['check-ref-format', '--branch', branch], ['fetch', 'origin', branch, '--quiet']]) {
      const result = await spawnUpdateCommand(root, 'git', args, GIT_TIMEOUT);
      log.push(result);
      if (!result.ok) return { ...getUpdateStatus(options), ok: false, reason: `更新檢查失敗：${result.stderr.trim()}`, log };
    }
    const values: string[] = [];
    for (const args of [['rev-parse', 'HEAD'], ['rev-parse', `origin/${branch}`], ['rev-list', '--count', `HEAD..origin/${branch}`]]) {
      const result = await spawnUpdateCommand(root, 'git', args, GIT_TIMEOUT);
      log.push(result);
      if (!result.ok) return { ...getUpdateStatus(options), ok: false, reason: `更新檢查失敗：${result.stderr.trim()}`, log };
      values.push(result.stdout.trim());
    }
    const [local, remote, count] = values;
    const behind = Number(count);
    const url = status.policy === 'check' && behind > 0 ? await changesUrl(root, branch) : null;
    if (lockIsLive()) return { ...getUpdateStatus(options), reason: '更新進行中，稍後再檢查' };
    // 網路等待後重讀，保留別的 process 剛寫入的成功紀錄與提示。
    const state: UpdateState = { ...readState(), checkedAt: new Date().toISOString(), branch, local, remote, behind, available: behind > 0 };
    // 更新帶來的待辦（含新版啟動重建的那則）不能被「有新版／沒新版」的檢查結果蓋掉。
    const pendingRestart = pendingRange(state) !== null;
    if (status.policy === 'check' && !pendingRestart) {
      state.notice = url ? `ai-cli 有新版（${local.slice(0, 7)} → ${remote.slice(0, 7)}，${behind} 個 commit），AI_CLI_AUTO_UPDATE=check 僅檢查；設為 on 後執行 ai-cli update。更新內容請至 ${url} 查看` : null;
      state.noticeFromUpdate = false;
    }
    const reason = writeState(state);
    return { ...getUpdateStatus(options), ok: !reason, ...(reason ? { reason } : {}) };
  } catch (error) { return { ...getUpdateStatus(options), ok: false, reason: messageOf(error), log }; }
}

export async function applyUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const status = getUpdateStatus(options);
  const log: CommandResult[] = [];
  const refused = (reason: string): UpdateResult => ({ ...getUpdateStatus(options), applied: false, reason, log });
  if (!status.supported) return { ...status, applied: false };
  if (status.policy !== 'on') return refused(`AI_CLI_AUTO_UPDATE=${status.policy}，不套用更新`);
  let release: (() => void) | undefined;
  let prev: string | undefined;
  let target = '';
  let branch = '';
  let mutated = false;
  const root = repoOf(options);
  const run = async (binary: string, args: string[], timeout = GIT_TIMEOUT) => {
    const result = await spawnUpdateCommand(root, binary, args, timeout);
    log.push(result);
    return result;
  };
  const must = async (binary: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> => {
    const result = await run(binary, args, timeout);
    if (!result.ok) {
      if (binary === 'npm' && args[0] === 'install' && /EPERM|EBUSY/i.test(result.stderr) && /node-pty/i.test(result.stderr)) {
        throw new Error('其他 ai-cli server 仍在執行，鎖住原生模組；關閉後再更新');
      }
      throw new Error(`${result.command} 失敗：${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return result.stdout.trim();
  };
  try {
    branch = await branchOf(root);
    await must('git', ['check-ref-format', '--branch', branch]);
    const preflight = async (): Promise<string | null> => {
      const dirty = await must('git', ['status', '--porcelain', '--untracked-files=no']);
      if (dirty) return '有未 commit 的追蹤檔改動，拒絕更新';
      const current = await must('git', ['branch', '--show-current']);
      if (current !== branch) return `目前分支 ${current || '(detached HEAD)'} 不是 ${branch}，拒絕更新`;
      const ancestor = await run('git', ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]);
      if (!ancestor.ok) return '本機含非遠端祖先的 commit，無法 fast-forward，拒絕更新';
      return null;
    };
    const reason = await preflight();
    if (reason) return refused(reason);
    const lock = acquireLock();
    if (!lock.release) return refused(lock.reason!);
    release = lock.release;
    // 在取得鎖之後重新驗證，不能用等待前讀到的 HEAD 當回滾點。
    const changed = await preflight();
    if (changed) return refused(changed);
    prev = await must('git', ['rev-parse', 'HEAD']);
    target = await must('git', ['rev-parse', `origin/${branch}`]);
    if (prev === target) return refused('ai-cli 已是最新版');
    mutated = true;
    // 明確關閉使用者 pull.rebase；只允許 fast-forward，不能把本機 commit 改寫。
    await must('git', ['-c', 'pull.rebase=false', 'pull', '--ff-only', 'origin', branch], MINUTE);
    target = await must('git', ['rev-parse', 'HEAD']);
    const files = (await must('git', ['diff', '--name-only', `${prev}..HEAD`])).split(/\r?\n/);
    if (files.some((name) => name === 'package.json' || name === 'package-lock.json')) {
      await must('npm', ['install', '--no-audit', '--no-fund'], 10 * MINUTE);
    } else { await must('npm', ['run', 'build'], 5 * MINUTE); }
    await must(process.execPath, [join(root, 'dist/bin/ai-cli.js'), 'doctor'], GIT_TIMEOUT);
    const commits = (await must('git', ['log', '--format=%H%x09%s', `${prev}..${target}`])).split(/\r?\n/).filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
    // 上一批要動手的事還沒送到模型面前就又更新：從上一批的起點接著算，不能被這次的提示蓋掉（稽核第 2 輪）。
    const before = readState();
    const range = pendingRange(before);
    const carried = range !== null && before.noticeDelivered !== before.notice && range.to === prev;
    const actionsFrom = carried ? range.from : prev;
    const shownActions = carried ? before.shownActions : [];
    const actions = (actionsFrom === prev ? null : await pendingActions(root, actionsFrom, target, shownActions))
      ?? [...postUpdateActions(commits), ...bundledPluginActions(root, files)].filter((action) => !shownActions.includes(action));
    const notice = `ai-cli 已更新至最新版（${prev.slice(0, 7)} → ${target.slice(0, 7)}，${commits.length} 個 commit），請重新啟動 MCP（Claude Code：/mcp 重連）。更新內容請至 ${await changesUrl(root, branch)} 查看\n${commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n')}${actions.length ? `\n\n這次更新有 ${actions.length} 件事需要你在這台機器上動手：\n\n${actions.join('\n\n')}` : ''}`;
    const state: UpdateState = { ...readState(), checkedAt: new Date().toISOString(), branch,
      local: target, remote: target, behind: 0, available: false,
      lastApplied: { at: new Date().toISOString(), from: prev, to: target, ok: true, commits, message: notice },
      notice, noticeDelivered: null, noticeFromUpdate: true, pendingFrom: actionsFrom, pendingTo: target, shownActions,
    };
    const writeError = writeState(state);
    if (writeError) throw new Error(writeError);
    return { ...getUpdateStatus(options), applied: true, log };
  } catch (error) {
    let reason = messageOf(error);
    if (!mutated || !prev) return refused(reason);
    const reset = await run('git', ['reset', '--hard', prev], MINUTE);
    const rebuild = await run('npm', ['run', 'build'], 5 * MINUTE);
    const rolledBack = reset.ok && rebuild.ok;
    if (!rolledBack) reason += '；回滾或重新建置失敗，請查看 log 並手動修復';
    const current = readState();
    // 失敗紀錄會取代 lastApplied；待辦的範圍原本可能只由它推得（舊版 updater 寫的），先明確記下來。
    const kept = pendingRange(current);
    const state: UpdateState = { ...current, branch, local: reset.ok ? prev : target, remote: target,
      ...(kept ? { noticeFromUpdate: true, pendingFrom: kept.from, pendingTo: kept.to } : {}),
      available: true, lastApplied: { at: new Date().toISOString(), from: prev, to: target, ok: false, commits: [], message: reason } };
    const writeError = writeState(state);
    if (writeError) reason += `；${writeError}`;
    return { ...getUpdateStatus(options), applied: false, rolledBack, reason, log };
  } finally { release?.(); }
}

/** 每個 process 只認第一次啟動的 HEAD，舊 server 不得因磁碟更新而冒充新版。 */
const startupChecks = new Map<string, Promise<UpdateResult>>();
export function clearNoticeOnStartup(options: UpdateOptions = {}): Promise<UpdateResult> {
  const status = getUpdateStatus(options);
  if (!status.supported || process.env.AI_CLI_UPDATE_SKIP_STARTUP === '1') return Promise.resolve(status);
  const key = `${repoOf(options)}\n${statePath()}`;
  const existing = startupChecks.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const head = await spawnUpdateCommand(repoOf(options), 'git', ['rev-parse', 'HEAD'], GIT_TIMEOUT);
    if (head.ok && !lockIsLive()) {
      const state = readState();
      // 只有「這次真的清掉提示」才回報已是最新版；之後每次啟動都安靜，
      // 否則框架自動呼叫的 CLI（exec 等）每次都會在 stderr 多一行（獨立稽核 @gemini-3.1-pro 註記）。
      const headSha = head.stdout.trim();
      const range = pendingRange(state);
      // 更新失敗回滾時 lastApplied 是失敗紀錄，待辦仍要照 pendingTo 認得（稽核第 2 輪）。
      if (state.notice !== null && ((state.lastApplied?.ok && state.lastApplied.to === headSha) || range?.to === headSha)) {
        // 要動手的事由新版重算；已經在 run／models 回應裡送到模型面前的才算交代過。
        // 沒送到就重開的話，原本會連同提問一起清掉（稽核：DeepSeek V4.1 Flash）。
        const delivered = state.noticeDelivered === state.notice;
        // check 政策的「有新版」不是待辦（range 為 null），照舊清掉；待辦則重算，算不出來就整份保留原狀。
        const recomputed = range ? await pendingActions(repoOf(options), range.from, range.to, []) : [];
        // 算不出來時保留原狀，除非已送達而且起點 commit 已不存在：那是永久失敗，不清就每次啟動都卡著、每個回應都重送。
        // 起點還在就當暫時失敗（例如逾時）：已送達的原文可能是舊版 updater 寫的、漏了新版才認得的提問，不能清（稽核第 4 輪）。
        if (recomputed === null) {
          const probe = delivered ? await spawnUpdateCommand(repoOf(options), 'git', ['cat-file', '-e', `${range!.from}^{commit}`], GIT_TIMEOUT) : null;
          // cat-file 自己逾時或起不來不算「不存在」：只認 git 跑完並明確回報找不到（exit 128）（稽核第 4 輪複核）。
          const fromGone = probe !== null && !probe.timedOut && probe.code !== null && probe.code !== 0;
          if (!fromGone) return getUpdateStatus(options);
        }
        const all = recomputed ?? [];
        const shown = [...state.shownActions, ...(delivered ? all.filter((action) => state.notice!.includes(action)) : [])];
        const pending = all.filter((action) => !shown.includes(action));
        // 等 git 的期間別的程序可能更新過或記了送達：狀態變了就不寫，交給下次啟動，不拿舊快照蓋掉新資料。
        const latest = readState();
        if (lockIsLive() || latest.notice !== state.notice || latest.noticeDelivered !== state.noticeDelivered
          || latest.lastApplied?.to !== state.lastApplied?.to || latest.pendingTo !== state.pendingTo) return getUpdateStatus(options);
        const notice = range && pending.length
          ? `ai-cli 上次更新（${range.from.slice(0, 7)} → ${range.to.slice(0, 7)}）有 ${pending.length} 件事需要你在這台機器上動手：\n\n${pending.join('\n\n')}`
          : null;
        // 舊版 server 只認「notice 等於 lastApplied.message」，寫狀態時又會丟掉新欄位：message 同步成這則，
        // 同機還沒重開的舊 server 做 check 時才不會清掉它，新版下次啟動也還認得（稽核第 2 輪）。
        const lastApplied = notice && latest.lastApplied?.ok ? { ...latest.lastApplied, message: notice } : latest.lastApplied;
        const next: UpdateState = { ...latest, lastApplied, notice, noticeDelivered: null, noticeFromUpdate: notice !== null,
          pendingFrom: notice ? range!.from : null, pendingTo: notice ? range!.to : null, shownActions: notice ? shown : [] };
        // 內容沒變（沒人送達、重算結果相同）就不寫也不回報（稽核第 2 輪）。
        if (JSON.stringify(next) === JSON.stringify(latest)) return getUpdateStatus(options);
        const writeError = writeState(next);
        // 只有真的清掉提示才回報已是最新版；保留待辦時安靜。
        return { ...getUpdateStatus(options), ...(writeError || notice === null ? { reason: writeError ?? `ai-cli 已是最新版 ${headSha.slice(0, 7)}` } : {}) };
      }
    }
    return getUpdateStatus(options);
  })().catch((error) => ({ ...getUpdateStatus(options), reason: messageOf(error) }));
  startupChecks.set(key, pending);
  return pending;
}

/** bin 的 update 快速入口，不 import app，確保更新途中只使用已載入的程式碼。 */
export async function runUpdateCli(argv: string[], output = {
  stdout: (text: string) => { process.stdout.write(text); },
}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    output.stdout('Usage: ai-cli update [--check] [--json]\nCheck origin and apply a fast-forward update; policy on/check/off is respected.\n');
    return 0;
  }
  const checked = await checkForUpdate({ force: true });
  const result = !argv.includes('--check') && checked.supported && checked.ok !== false && checked.available && checked.policy === 'on'
    ? await applyUpdate() : checked;
  output.stdout(argv.includes('--json') ? `${JSON.stringify(result)}\n`
    : `${result.reason || result.notice || (result.available ? `ai-cli 有新版（${result.behind} 個 commit）` : result.policy === 'off' ? 'ai-cli 自動更新已停用' : 'ai-cli 已是最新版')}\n`);
  return result.ok === false || result.applied === false || !result.supported ? 1 : 0;
}

/** transport 連線後呼叫。計時器不撐住 server，更新本體在隔離的 CLI 子程序執行。 */
export function scheduleBackgroundUpdates(notify: (message: string) => Promise<void>, options: UpdateOptions = {}): () => void {
  let stopped = false;
  let busy = false;
  let lastNotice: string | null = null;
  const report = async (message: string) => { if (!stopped) { try { await notify(message); } catch {} } };
  const startup = clearNoticeOnStartup(options).then(async (state) => {
    if (state.reason?.startsWith('ai-cli 已是最新版')) await report(state.reason);
  });
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await startup;
      const checked = await checkForUpdate(options);
      if (!stopped && checked.policy === 'on' && checked.available && checked.ok !== false) {
        // 執行目前安裝的 bin；AI_CLI_UPDATE_REPO_ROOT 僅讓測試指向暫存 clone。
        const child = await spawnUpdateCommand(repoOf(options), process.execPath,
          [join(DEFAULT_ROOT, 'dist/bin/ai-cli.js'), 'update', '--json'], 23 * MINUTE);
        if (!child.ok) {
          let reason = child.stderr.trim();
          try { reason = JSON.parse(child.stdout).reason || reason; } catch {}
          await report(`ai-cli 自動更新未套用：${reason || '更新子程序失敗'}`);
        }
      }
      // 背景通知模型看不到，只讀不標記送達（見 consumeNotice）。
      const notice = getUpdateStatus(options).notice;
      if (notice && notice !== lastNotice) { lastNotice = notice; await report(notice); }
    } catch (error) { await report(`ai-cli 更新檢查失敗：${messageOf(error)}`); }
    finally { busy = false; }
  };
  let interval: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, updateCheckIntervalMs());
    interval.unref();
  }, 3000);
  first.unref();
  return () => { stopped = true; clearTimeout(first); clearInterval(interval); };
}
