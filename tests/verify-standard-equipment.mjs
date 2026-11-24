/** 標配提醒只讀暫存 HOME，握手使用真正的 MCP stdio 入口。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getStandardEquipment } from '../dist/core/standard-equipment.js';
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
async function connect(name = 'claude-code', env = {}, check) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, 'dist', 'server.js')], cwd: ROOT,
    env: { ...process.env, ...env }, stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name, version: '0.172.0' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    if (check) await check(client);
    return client.getInstructions();
  } finally { await client.close(); }
}

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
fresh();
writeFileSync(installed, '{');
assert.equal(states().claude.filter((item) => item.includes('讀不到')).length, 3, '損壞的 Claude 安裝紀錄判定未知');

fresh();
assert.deepEqual(states().codex, [], '三個 hook 俱全、雜湊相符時靜默');
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
assert(states().codex[0]?.includes('尚未信任或已停用 SessionStart、UserPromptSubmit、Stop'), '標記齊全但未信任有提示');
writeFileSync(config, trust(0, { groupCommand: commands[0].replace('D:/', 'C:/') }) + trust(1) + trust(2));
assert(states().codex[0]?.includes('尚未信任或已停用 SessionStart'), '雜湊不符仍提示信任');
writeFileSync(config, trust(0) + trust(1, { enabled: false }) + trust(2));
assert(states().codex[0]?.includes('尚未信任或已停用 UserPromptSubmit'), '已信任但停用仍提醒');
writeFileSync(config, trust(0) + trust(1) + 'developer_instructions = """\n' + trust(2) + '"""\n');
assert(states().codex[0]?.includes('尚未信任或已停用 Stop'), '多行字串中的信任紀錄不採用');
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

const touched = ['plugins/ai-cli_kernel_panel/.claude-plugin/plugin.json'];
assert.deepEqual(bundledPluginActions(ROOT, ['src/core/updater.ts'], claude), [], 'updater 未變更外掛目錄時不問');
const [kernel] = bundledPluginActions(ROOT, touched, claude);
assert(kernel?.includes('ai-cli_kernel_panel'), 'updater 變更 kernel 面板時提醒');
const other = '另一個更新後提醒';
const header = 'ai-cli 已更新至最新版\n這次更新有 2 件事需要你在這台機器上動手：';
const notice = [header, kernel, other].join('\n\n');
assert.equal(omitStandardUpdateActions(notice, states().claude), [header.replace('2 件', '1 件'), other].join('\n\n'),
  'updater 去重保留其他事項');
assert.equal(omitStandardUpdateActions(notice, []), notice, '沒有開場提醒時保留 updater 原文');
mkdirSync(process.env.AI_CLI_STATE_DIR, { recursive: true });
writeFileSync(join(process.env.AI_CLI_STATE_DIR, 'update.json'), JSON.stringify({ notice }));
await connect('claude-code', { AI_CLI_UPDATE_REPO_ROOT: ROOT }, async (client) => {
  const result = await client.callTool({ name: 'models', arguments: {} }, undefined, { timeout: 20_000 });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.updateNotice, [header.replace('2 件', '1 件'), other].join('\n\n'), 'MCP models 去重保留其他事項');
});
console.log('PASS 標配檢查、MCP 握手、重複提醒與 updater 去重');
