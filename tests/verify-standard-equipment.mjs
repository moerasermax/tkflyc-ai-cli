/** 標配提醒只讀暫存 HOME，握手使用真正的 MCP stdio 入口。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { declarationHash, getStandardEquipment } from '../dist/core/standard-equipment.js';
import { bundledPluginActions, omitStandardUpdateActions } from '../dist/core/updater.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const originalHome = homedir();
const sandbox = join(dirname(process.env.AI_CLI_STATE_DIR), 'equipment');
const home = join(sandbox, 'home');
const claude = join(home, '.claude');
const codex = join(home, '.codex');
const pluginDir = join(claude, 'plugins');
const installed = join(pluginDir, 'installed_plugins.json');
const hookPath = join(codex, 'hooks.json');
const config = join(codex, 'config.toml');
mkdirSync(pluginDir, { recursive: true });
mkdirSync(codex, { recursive: true });

function assertInside(base, path) {
  const rel = relative(realpathSync(base), realpathSync(path));
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'fixture 路徑必須在暫存目錄內：' + path);
}
assertInside(tmpdir(), home);
assertInside(home, claude);
assertInside(home, codex);
assert.notEqual(realpathSync(home), realpathSync(originalHome));
Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex });
assert.equal(homedir(), home, '測試的 HOME 必須指向 fixture');

const names = ['ai-cli-jobs', 'ai-cli_kernel_panel', 'ai-cli_project-flow'];
const jobs = 'ai-cli-jobs@tkflyc-ai-cli';
const versions = Object.fromEntries(names.map((name) => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'));
  return [name + '@tkflyc-ai-cli', [{ version: manifest.version, scope: 'user' }]];
}));
const setPlugins = (plugins) => writeFileSync(installed, JSON.stringify({ version: 2, plugins }));
const states = () => getStandardEquipment(ROOT);
const events = [['SessionStart', 'session_start'], ['UserPromptSubmit', 'user_prompt_submit'], ['Stop', 'stop']];
const commands = events.map(([event]) => 'node "D:/測試/adapters/codex.mjs" ' + event + ' --ai-cli-project-flow');
const declarations = () => Object.fromEntries(events.map(([event], index) =>
  [event, [{ hooks: [{ type: 'command', command: commands[index], timeout: 15 }] }]]));
const setHooks = (hooks = declarations()) => writeFileSync(hookPath, JSON.stringify({ hooks }));
function trust(index, { path = hookPath, suffix = '0:0', groupCommand = commands[index], enabled = true } = {}) {
  const event = events[index][1];
  const stable = JSON.stringify({ event_name: event, hooks: [{ async: false, command: groupCommand, timeout: 15, type: 'command' }] });
  const hash = createHash('sha256').update(stable).digest('hex');
  const key = path + ':' + event + ':' + suffix;
  const quoted = key.includes("'") ? JSON.stringify(key) : "'" + key + "'";
  return '[hooks.state.' + quoted + ']\ntrusted_hash = "sha256:' + hash + '"\nenabled = ' + enabled + '\n';
}
const allTrusted = () => '[hooks.state]\n' + events.map((_, index) => trust(index)).join('\n');
const fresh = () => {
  setPlugins(versions);
  setHooks();
  writeFileSync(config, allTrusted());
};
async function connect(name = 'claude-code', env = {}, check, preload) {
  const args = preload ? ['--import', 'data:text/javascript,' + encodeURIComponent(preload)] : [];
  const transport = new StdioClientTransport({
    command: process.execPath, args: [...args, join(ROOT, 'dist', 'server.js')], cwd: ROOT,
    env: { ...process.env, ...env }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
  const client = new Client({ name, version: '0.172.0' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    if (check) await check(client);
    return client.getInstructions();
  } catch (error) {
    if (stderr) error.message += '\n' + stderr;
    throw error;
  } finally { await client.close(); }
}

// 以原始命令和 Codex 寫入的雜湊驗證 Windows 正規化，核准索引改用暫存 hooks.json 路徑。
const codexGolden = [
  {
    event: "pre_tool_use", groupIndex: 0, handlerIndex: 0,
    matcher: "Bash|apply_patch|Edit|Write|Agent|Task|spawn_agent",
    handler: {
      type: "command",
      command: "pwsh -NoProfile -NonInteractive -File \"C:\\Users\\Moera\\.ai-governance\\global_guard.ps1\"",
      commandWindows: "pwsh -NoProfile -NonInteractive -File \"C:\\Users\\Moera\\.ai-governance\\global_guard.ps1\"",
      timeout: 5,
      statusMessage: "檢查全域安全與額度護欄",
    },
    hash: "sha256:ea878e9a9093a2790c5371a16e99510de93bcd8a661b50e9df18c608d1c335b7",
  },
  {
    event: "user_prompt_submit", groupIndex: 0, handlerIndex: 0,
    handler: {
      type: "command",
      command: "python3 \"$HOME/.claude/scripts/archive_trigger.py\"",
      commandWindows: "python \"C:\\Users\\Moera\\.claude\\scripts\\archive_trigger.py\"",
      timeout: 5,
      statusMessage: "檢查是否為歸檔指令",
    },
    hash: "sha256:cdad34d107c7ffd3229997ce72b9fe86b56aa9264a807ad2941f68e8c0aab7de",
  },
  {
    event: "user_prompt_submit", groupIndex: 1, handlerIndex: 0,
    handler: {
      type: "command",
      command: "python3 \"$HOME/.codex/user-acceptance-opening.py\" --event UserPromptSubmit",
      commandWindows: "python \"C:\\Users\\Moera\\.codex\\user-acceptance-opening.py\" --event UserPromptSubmit",
      timeout: 5,
      additionalContextLimit: 2000,
      statusMessage: "讀取使用者驗收流程",
    },
    hash: "sha256:2bda1dcbdc64ad74255557b7c59848f54a9943dec13b3c04fb0d665851772574",
  },
  {
    event: "session_start", groupIndex: 0, handlerIndex: 0,
    matcher: "startup|resume|clear|compact",
    handler: {
      type: "command",
      command: "node \"D:\\WorkSpace\\02_產品_products\\tkflyc\\planner\\tkflyc-planner\\mcp\\session-start-hook.mjs\"",
      commandWindows: "node \"D:\\WorkSpace\\02_產品_products\\tkflyc\\planner\\tkflyc-planner\\mcp\\session-start-hook.mjs\"",
      timeout: 15,
      statusMessage: "讀取 planner 提醒…",
    },
    hash: "sha256:7cd49f713b806d1be24ddc2300847e1250c3b04469649db2f4e915b7831c7ac9",
  },
  {
    event: "session_start", groupIndex: 0, handlerIndex: 1,
    matcher: "startup|resume|clear|compact",
    handler: {
      type: "command",
      command: "python3 \"$HOME/.codex/planner-opening.py\"",
      commandWindows: "python \"C:\\Users\\Moera\\.codex\\planner-opening.py\"",
      timeout: 5,
      statusMessage: "讀取目前專案的 Planner 開場規則",
    },
    hash: "sha256:a2bd5bbc1a1a04fec3e0c9a55c1e302dee3c1f6ce59996825e550be71a5719a0",
  },
  {
    event: "session_start", groupIndex: 1, handlerIndex: 0,
    matcher: "startup|resume|clear|compact",
    handler: {
      type: "command",
      command: "python3 \"$HOME/.codex/user-acceptance-opening.py\" --event SessionStart",
      commandWindows: "python \"C:\\Users\\Moera\\.codex\\user-acceptance-opening.py\" --event SessionStart",
      timeout: 5,
      additionalContextLimit: 2000,
      statusMessage: "載入本專案使用者驗收流程",
    },
    hash: "sha256:045884b60531f3afddaf3e6cde5cd1cf04ae20e3c37073530716d0cd2e770704",
  },
  {
    event: "session_start", groupIndex: 2, handlerIndex: 0,
    matcher: "startup|resume|clear|compact",
    handler: {
      type: "command",
      command: "python \"C:\\Users\\Moera\\.claude\\scripts\\aicli_model_policy.py\"",
      timeout: 5,
    },
    hash: "sha256:3b61f6ff186670bdee17fe3e08aa353c089a40506e0f9ba232d9e76336aac75d",
  },
  {
    event: "session_end", groupIndex: 0, handlerIndex: 0,
    handler: {
      type: "command",
      command: "node \"D:\\WorkSpace\\02_產品_products\\tkflyc\\planner\\tkflyc-planner\\mcp\\session-end-hook.mjs\"",
      commandWindows: "node \"D:\\WorkSpace\\02_產品_products\\tkflyc\\planner\\tkflyc-planner\\mcp\\session-end-hook.mjs\"",
      timeout: 3,
      statusMessage: "planner 入庫檢查…",
    },
    hash: "sha256:d740bc953a5ddb597c8759d5bc1f9045dcb1343a59c7a8a32832b3a690a7fabd",
  },
];
const relocatedHooks = join(codex, "golden-hooks.json");
const relocatedConfig = join(codex, "golden-config.toml");
writeFileSync(relocatedHooks, JSON.stringify(codexGolden.map(({ hash, ...entry }) => entry)));
writeFileSync(relocatedConfig, codexGolden.map(({ event, groupIndex, handlerIndex, hash }) =>
  "[hooks.state.'" + [relocatedHooks, event, groupIndex, handlerIndex].join(':') + "']\ntrusted_hash = \"" + hash + '"').join('\n\n'));
const trustHashes = [...readFileSync(relocatedConfig, "utf8").matchAll(/trusted_hash = "(sha256:[0-9a-f]{64})"/g)];
for (const [index, { event, groupIndex, handlerIndex, handler, matcher }] of JSON.parse(readFileSync(relocatedHooks, "utf8")).entries()) {
  assert.equal(declarationHash(event, handler, matcher, "win32"), trustHashes[index]?.[1],
    'Codex 0.172 本機 golden hash（已搬移 fixture） ' + [event, groupIndex, handlerIndex].join(':'));
}
console.log('Codex 0.172 本機 golden hash 8/8 相符');

// 最新、缺裝、版本過舊、紀錄缺漏各跑三個 Claude 外掛。
writeFileSync(join(pluginDir, 'known_marketplaces.json'), '{"tkflyc-ai-cli":{}}');
fresh();
assert.deepEqual(states().claude, []);
for (const name of names) {
  const id = name + '@tkflyc-ai-cli';
  const { [id]: dropped, ...rest } = versions;
  setPlugins(rest);
  const missing = states().claude;
  assert.equal(missing.length, 1, name + ' 缺裝提醒數');
  assert(missing[0].startsWith('【要問使用者】' + name) && missing[0].includes('這台機器還沒裝。'), name + ' 缺裝有提示');
  assert(missing[0].includes('claude plugin marketplace update tkflyc-ai-cli') &&
    missing[0].includes('claude plugin install ' + id));
  setPlugins({ ...rest, [id]: [{ ...dropped[0], version: '0.0.0' }] });
  assert(states().claude[0]?.includes('0.0.0（user）'), name + ' 舊版有提示');
  setPlugins({ ...rest, [id]: [{ scope: 'user' }] });
  assert(states().claude[0]?.includes('讀不到') && !states().claude[0]?.includes('這台機器還沒裝。'), name + ' 紀錄不明有提示');
}
setPlugins(Object.fromEntries(Object.keys(versions).map((id) => [id, [{ version: '0.0.0', scope: 'user' }]])));
const shipped = getStandardEquipment(sandbox).claude;
for (const [id, [{ version }]] of Object.entries(versions)) {
  assert(shipped.some((item) => item.includes('claude plugin update ' + id) && item.includes('標配版本 ' + version + '）')),
    id + ' 隨套件散布的版本與 manifest 相符');
}

const otherProject = join(home, '專案 A');
const installInProject = (projectPath, version = versions[jobs][0].version) => ({ scope: 'project', projectPath, version });
setPlugins({ ...versions, [jobs]: [installInProject(otherProject)] });
assert(states().claude[0]?.includes('只裝在 ' + otherProject + ' 範圍，目前專案還沒裝'), '安裝於其他專案仍提醒並註明範圍');
const project = join(home, '目前專案');
const childProjectDir = join(project, 'src', 'nested');
const sibling = join(home, '目前專案-其他');
const projectAlias = join(home, '專案連結');
mkdirSync(childProjectDir, { recursive: true });
mkdirSync(sibling);
symlinkSync(project, projectAlias, process.platform === 'win32' ? 'junction' : 'dir');
const originalCwd = process.cwd();
try {
  process.chdir(project);
  const currentProject = process.platform === 'win32' ? project.toUpperCase().replaceAll('\\', '/') + '/' : project + '/';
  setPlugins({ ...versions, [jobs]: [installInProject(currentProject)] });
  assert.deepEqual(states().claude, [], '目前 cwd 的專案安裝有效，Windows 忽略大小寫與分隔符');
  process.chdir(childProjectDir);
  assert.deepEqual(states().claude, [], '專案子目錄的安裝有效');
  setPlugins({ ...versions, [jobs]: [installInProject(projectAlias)] });
  assert.deepEqual(states().claude, [], '專案 junction 或 symlink 以 realpath 比對');
  process.chdir(sibling);
  assert(states().claude[0]?.includes('目前專案還沒裝'), '同名前綴的相鄰目錄不算專案子目錄');
} finally {
  process.chdir(originalCwd);
}
setPlugins({ ...versions, [jobs]: [...versions[jobs], installInProject(otherProject, '0.0.0')] });
assert.deepEqual(states().claude, [], 'user 安裝有效時不提醒其他專案的舊版');
for (const scope of ['managed', 'project']) {
  setPlugins({ ...versions, [jobs]: [{ scope, version: versions[jobs][0].version }] });
  assert.deepEqual(states().claude, [], `${scope} 沒有 projectPath 的範圍視為已安裝`);
}

const joiners = '專\u200c案\u200d名';
const injected = join(home, joiners + '\n\r\t\u0000\u0085\u2028\u2029\u202e\u2066\u2069' + '長'.repeat(250));
setPlugins({ ...versions, [jobs]: [installInProject(injected)] });
assert.match(states().claude[0], /只裝在 ([^\n]+) 範圍/u, '專案範圍顯示在同一行');
const displayed = /只裝在 (.+) 範圍/u.exec(states().claude[0])[1];
assert(displayed.length <= 120 && !/[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u.test(displayed), '專案範圍清除控制與 bidi 字元並限制長度');
assert(displayed.includes(joiners), '專案路徑保留 ZWNJ 與 ZWJ');
for (const version of ['0.0.0\n注入', '0.0.0\n', '0.0.0-rc', '0.0.0\u2028', '0.0.' + '9'.repeat(40)]) {
  setPlugins({ ...versions, [jobs]: [{ scope: 'user', version }] });
  const [action] = states().claude;
  assert(action?.includes('讀不到') && !action.includes('0.0.0'), '非 x.y.z 或過長的版本判定未知');
}

const emptyClaude = join(home, 'empty-claude');
mkdirSync(emptyClaude);
assertInside(home, emptyClaude);
process.env.CLAUDE_CONFIG_DIR = emptyClaude;
assert.equal(states().claude.filter((item) => item.includes('這台機器還沒裝。')).length, 3, 'Claude 設定目錄存在但沒有安裝紀錄視為未裝');
process.env.CLAUDE_CONFIG_DIR = join(emptyClaude, 'missing');
assert.equal(states().claude.filter((item) => item.includes('讀不到')).length, 3, 'Claude 設定目錄不存在判定未知');
process.env.CLAUDE_CONFIG_DIR = claude;

fresh();
writeFileSync(installed, '{');
assert.equal(states().claude.filter((item) => item.includes('讀不到')).length, 3, '損壞的 Claude 安裝紀錄判定未知');

fresh();
assert.deepEqual(states().codex, [], '三個 hook 俱全、雜湊相符時靜默');
if (process.platform === 'win32') {
  const alternatePath = hookPath.toUpperCase().replaceAll('\\', '/');
  writeFileSync(config, events.map((_, index) => trust(index, { path: alternatePath })).join('\n'));
  assert.deepEqual(states().codex, [], 'Windows 核准索引忽略 hooks.json 路徑大小寫與分隔符');
  writeFileSync(config, allTrusted());
}
const started = performance.now();
for (let i = 0; i < 20; i++) assert.deepEqual(states(), { claude: [], codex: [] });
console.log('標配檢查平均 ' + ((performance.now() - started) / 20).toFixed(2) + ' ms（暫存 HOME，20 次）');
const hooks = declarations();
hooks.Stop[0].hooks[0].command = commands[2].replace(' --ai-cli-project-flow', '');
setHooks(hooks);
assert(states().codex[0]?.includes('尚未安裝 Stop'), '少一個標記算缺裝');
const old = declarations();
old.Stop[0].hooks[0].timeout = 14;
setHooks(old);
assert(states().codex[0]?.includes('宣告過舊或與安裝器不同 Stop'), 'hook 舊版有提示');
setHooks();
writeFileSync(config, '');
assert(states().codex[0]?.includes('尚未信任 SessionStart、UserPromptSubmit、Stop'), '標記齊全但未信任有提示');
writeFileSync(config, trust(0, { groupCommand: commands[0].replace('D:/', 'C:/') }) +
  trust(1, { enabled: false, groupCommand: commands[1].replace('D:/', 'C:/') }) +
  trust(2, { path: join(home, 'other-hooks.json') }));
const [trustIssues] = states().codex;
assert(trustIssues?.includes('無法判斷，可能需要重新信任（/hooks 審查） SessionStart'), '雜湊不符仍提示信任');
assert(trustIssues?.includes('已停用 UserPromptSubmit'), '停用即使雜湊不符也單獨提醒');
assert(trustIssues?.includes('尚未信任 Stop'), '其他 hooks.json 的核准紀錄不能替代目前 hook');
writeFileSync(config, trust(0) + trust(1) + 'developer_instructions = """\n' + trust(2) + '"""\n');
assert(states().codex[0]?.includes('尚未信任 Stop'), '多行字串中的信任紀錄不採用');
writeFileSync(hookPath, '{');
assert(states().codex[0]?.includes('無法判斷是否已安裝'), '損壞的 Codex 紀錄判定未知');

fresh();
assert.equal(await connect('test-client'), undefined, '標配全好時 MCP 無 instructions');
setPlugins({});
setHooks({});
const any = await connect('test-client');
assert(any?.includes('Claude Code') && any.includes('的 Codex hook'), '未知客戶端分區列出');
const claudeInstructions = await connect();
assert(claudeInstructions?.includes('ai-cli_kernel_panel') && !claudeInstructions.includes('的 Codex hook'), 'Claude Code 握手只列 Claude Code');
assert.equal(await connect(), claudeInstructions, '下一個新 session 再次提醒');
const codexInstructions = await connect('codex-mcp-client');
assert(codexInstructions?.includes('codex-install.mjs" --dry-run') && codexInstructions.includes('/hooks') &&
  !codexInstructions.includes('claude plugin'), 'Codex 握手只列 Codex');
assert.equal(await connect('claude-code', { AI_CLI_WORKER: '1', AI_CLI_ALLOW_NESTED: '1' }), undefined, 'worker 握手無標配提醒');

// 以目錄取代紀錄檔，跨平台重現 readFile 或 open 的檔案系統錯誤。
const broken = join(home, 'unreadable');
mkdirSync(join(broken, 'claude', 'plugins', 'installed_plugins.json'), { recursive: true });
mkdirSync(join(broken, 'codex', 'hooks.json'), { recursive: true });
assertInside(home, broken);
const unknown = await connect('test-client', { CLAUDE_CONFIG_DIR: join(broken, 'claude'), CODEX_HOME: join(broken, 'codex') });
assert(unknown?.includes('無法判斷有沒有裝') && unknown.includes('無法判斷是否已安裝'), '讀檔例外仍能啟動並回未知');
assert(!unknown.includes('這台機器還沒裝。'), '讀檔例外不謊報缺裝');
assert.equal(unknown.match(/無法判斷有沒有裝/g)?.length, 3, '三個 Claude 外掛與 Codex 設定都讀不到');
assert(unknown.length <= 2000, '四項標配皆讀不到時 instructions 至多 2,000 字元');
console.log('四項標配皆讀不到時 instructions ' + unknown.length + ' 字元');

setPlugins({ [jobs]: Array.from({ length: 200 }, () => ({ scope: 'managed', version: '0.0.0' })) });
assert(states().claude[0].length > 2000, '測試資料可使完整提醒超過 2,000 字元');
const compact = await connect('test-client');
assert(compact && compact.length <= 2000 && names.every((name) => compact.includes(name)) &&
  compact.includes('ai-cli_project-flow 的 Codex hook') && compact.includes('/plugin') && compact.includes('/hooks') &&
  !compact.includes('0.0.0') && !compact.includes('claude plugin') && !compact.includes('--dry-run'),
  '超過 2,000 字元改用只列項目及查看方式的精簡提醒');
setPlugins({});

const throwingHome = (site) => `
  import os from 'node:os';
  import { syncBuiltinESMExports } from 'node:module';
  const getHome = os.homedir;
  os.homedir = () => {
    const framePrefix = 'at ' + ${JSON.stringify(site)} + ' (';
    if (new Error().stack?.split('\\n').some((frame) => frame.trimStart().startsWith(framePrefix))) {
      throw new Error('fixture: HOME 不可用');
    }
    return getHome();
  };
  syncBuiltinESMExports();
`;
const afterClaudeError = await connect('test-client', { CLAUDE_CONFIG_DIR: '' }, undefined, throwingHome('claudeConfigDir'));
assert(afterClaudeError?.includes('Claude Code 標配外掛無法判斷') && afterClaudeError.includes('尚未安裝 SessionStart'),
  'Claude 路徑解析例外仍能 initialize 並保留 Codex 缺裝結果');
const afterCodexError = await connect('test-client', {}, undefined, throwingHome('codexAction'));
assert(afterCodexError?.includes('ai-cli_kernel_panel') && afterCodexError.includes('這台機器還沒裝。') &&
  afterCodexError.includes('無法判斷是否已安裝或信任'),
  'Codex 路徑解析例外仍能 initialize 並保留 Claude 缺裝結果');

const sdkServer = pathToFileURL(join(ROOT, 'node_modules', '@modelcontextprotocol/sdk/dist/esm/server/index.js')).href;
const throwingInstructions = `
  import { Server } from ${JSON.stringify(sdkServer)};
  Server.prototype.getClientVersion = () => { throw new Error('fixture: 讀取客戶端版本失敗'); };
`;
let forwarded;
try {
  forwarded = await connect('codex-mcp-client', {}, undefined, throwingInstructions);
} catch (error) {
  assert.fail('transport.send 格式化例外仍送出不帶 instructions 的 initialize 回應。' + error.message);
}
assert.equal(forwarded, undefined, 'transport.send 格式化例外仍送出不帶 instructions 的 initialize 回應');

const touched = ['plugins/ai-cli_kernel_panel/.claude-plugin/plugin.json'];
assert.deepEqual(bundledPluginActions(ROOT, ['src/core/updater.ts'], claude), [], 'updater 未變更外掛目錄時不問');
const [kernel] = bundledPluginActions(ROOT, touched, claude);
assert(kernel?.includes('ai-cli_kernel_panel'), 'updater 變更 kernel 面板時提醒');
const other = '另一個更新後提醒';
const applied = 'ai-cli 已更新至最新版（0123456 → 89abcde，2 個 commit），請重新啟動 MCP（Claude Code：/mcp 重連）。' +
  '更新內容請至 https://example.invalid/compare/0123456...89abcde 查看\n0123457 feat: 更新外掛\n89abcde fix: 修正面板';
const count = (lead, n) => lead + '有 ' + n + ' 件事需要你在這台機器上動手：';
const newNotice = (actions) => [applied, count('這次更新', actions.length), ...actions].join('\n\n');
const pendingNotice = (actions) => [count('ai-cli 上次更新（0123456 → 89abcde）', actions.length), ...actions].join('\n\n');
const notice = newNotice([kernel, other]);
const shown = states().claude;
assert.equal(omitStandardUpdateActions(notice, shown), newNotice([other]), '當次更新去重重算件數並保留其他事項');
assert.equal(omitStandardUpdateActions(newNotice([kernel]), shown), applied, '當次更新全部去重刪除件數並保留 commit 清單');
assert.equal(omitStandardUpdateActions(pendingNotice([kernel, other]), shown), pendingNotice([other]),
  '上次更新去重重算件數並保留其他事項');
assert.equal(omitStandardUpdateActions(pendingNotice([kernel]), shown), '', '上次更新全部去重刪除整段');
assert.equal(omitStandardUpdateActions(notice, []), notice, '沒有開場提醒時保留 updater 原文');
mkdirSync(process.env.AI_CLI_STATE_DIR, { recursive: true });
writeFileSync(join(process.env.AI_CLI_STATE_DIR, 'update.json'), JSON.stringify({ notice }));
await connect('claude-code', { AI_CLI_UPDATE_REPO_ROOT: ROOT }, async (client) => {
  const result = await client.callTool({ name: 'models', arguments: {} }, undefined, { timeout: 20_000 });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.updateNotice, newNotice([other]), 'MCP models 去重保留其他事項');
});
console.log('PASS 標配檢查、MCP 握手、重複提醒與 updater 去重');
