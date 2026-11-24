/** 驗證兩端 hook、Planner 快取、設定隔離與安裝流程。 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledPluginActions } from '../dist/core/updater.js';
import { loadSettings, parseSettings, SETTINGS } from '../plugins/ai-cli_project-flow/lib/config.mjs';
import { checkArchive, handleEvent, ruleContext } from '../plugins/ai-cli_project-flow/lib/flow.mjs';
import { queryPlanner } from '../plugins/ai-cli_project-flow/lib/project.mjs';
import { mergeHooks, planInstall } from '../plugins/ai-cli_project-flow/install/codex-install.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN = join(ROOT, 'plugins', 'ai-cli_project-flow');
const TEMP = mkdtempSync(join(realpathSync.native(process.env.PROJECT_FLOW_TEST_TMP || tmpdir()), 'ai-cli-project-flow-'));
const home = join(TEMP, 'home');
const state = join(home, '.ai-cli', 'project-flow');
const configTemplate = readFileSync(join(PLUGIN, 'templates', SETTINGS), 'utf8');
const readyTemplate = configTemplate
  .replace(/^S2:.*$/m, 'S2: "用 API 讀取，備援本機快照"')
  .replace(/^S4:.*$/m, 'S4: "editor-team"')
  .replace(/^S5:.*$/m, 'S5: "工作單依 WBS 編號"')
  .replace(/^S6:.*$/m, 'S6: "文件位於 docs，提交規則見 CONTRIBUTING.md"')
  .replace(/^S8:.*$/m, 'S8: "依 CI 跑自測，另由 API 模型獨立審查"')
  .replace(/^S10:.*$/m, 'S10: "以 progress.json 的完成工作單數計算"')
  .replace(/^S12:.*$/m, 'S12: "docs、inbox、archive"')
  .replace(/^limits:.*$/m, 'limits: "無上限"');
const skill = readFileSync(join(PLUGIN, 'skills', 'project-flow', 'SKILL.md'), 'utf8');
const alpha = '12345678-abcd-4321-abcd-123456789abc';
const beta = 'abcdefab-2345-4321-abcd-123456789abc';
const gamma = 'abcdefab-2345-4321-abcd-987654321abc';
const repo = join(TEMP, '雲端試算表');
const other = join(TEMP, '知識庫');
const unknown = join(TEMP, '未辨識');
const worktree = join(TEMP, '雲端 wt');
const nested = join(repo, '子目錄');
const env = { ...process.env, HOME: home, USERPROFILE: home, PLANNER_ROOT: '', PLANNER_ENV_FILE: '',
  PLANNER_TOKEN: '', PLANNER_API_TOKENS: '', PLANNER_URL: '', PROJECT_FLOW_PYTHON: '',
  AI_CLI_WORKER: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(TEMP, 'no-global-git') };
const lookup = async candidate => [alpha, beta].includes(candidate.id) ? candidate.id : null;
const online = { home, env, lookup };
const offline = { home, env, lookup() { throw new Error('mock offline'); } };
const checked = async (label, task) => {
  try { await task(); console.log('PASS ' + label); }
  catch (error) { console.error('FAIL ' + label); throw error; }
};

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function writeConfig(root, source, destination) {
  const body = readyTemplate.replace(/^S1:.*$/m, () => 'S1: ' + JSON.stringify(source))
    .replace(/^S11:.*$/m, () => 'S11: ' + JSON.stringify(destination));
  write(join(root, SETTINGS), body);
}

function adapter(name, payload, viaArg = false) {
  const json = JSON.stringify(payload);
  const args = [join(PLUGIN, 'adapters', name + '.mjs'), payload.hook_event_name];
  if (name === 'codex') args.push('--ai-cli-project-flow');
  if (viaArg) args.push(json);
  const output = execFileSync(process.execPath, args, { env, input: viaArg ? undefined : json,
    encoding: 'utf8', windowsHide: true });
  return JSON.parse(output);
}

try {
  mkdirSync(nested, { recursive: true });
  git(repo, 'init', '-q');
  write(join(repo, '.planner-id'), alpha + '\n');
  write(join(repo, 'main.mjs'), 'export const value = 1;\n');
  writeConfig(repo, '團隊 WBS 機密標記', '雲端專案專屬庫');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Project Flow', '-c', 'user.email=flow@example.invalid', 'commit', '-qm', 'fixture');
  git(repo, 'worktree', 'add', '--detach', worktree);
  write(join(other, '.planner-id'), beta + '\n');
  writeConfig(other, '知識庫進度私有標記', '家用知識庫 namespace-beta');
  write(join(unknown, '.planner-id'), gamma + '\n');

  await checked('Planner 身分共用主 repo，worktree 自有設定優先並標示回退來源', async () => {
    for (const cwd of [repo, nested]) {
      const result = await handleEvent('SessionStart', { cwd }, online);
      assert.match(result.context, /READY/);
      assert.ok(result.context.includes('專案根目錄 ' + JSON.stringify(realpathSync.native(repo))));
    }
    const localFile = join(worktree, SETTINGS);
    renameSync(localFile, join(TEMP, 'checkout-config.md'));
    const assertWorktree = (context, label, file) => {
      assert.match(context, /READY/);
      assert.ok(context.includes('專案根目錄 ' + JSON.stringify(realpathSync.native(worktree))));
      assert.ok(context.includes('設定檔（' + label + '） ' + JSON.stringify(file)));
    };
    assertWorktree((await handleEvent('SessionStart', { cwd: worktree }, online)).context,
      '主 repo 回退', join(realpathSync.native(repo), SETTINGS));
    write(localFile, configTemplate);
    assert.match((await handleEvent('SessionStart', { cwd: worktree }, online)).message, /INVALID.*仍為佔位值/);
    writeConfig(worktree, 'worktree 專屬來源', 'worktree 專屬庫');
    write(join(worktree, '.planner-id'), beta + '\n');
    const checkIdentity = { ...online, lookup(candidate) {
      assert.equal(candidate.id, alpha);
      assert.equal(candidate.root, realpathSync.native(repo));
      return alpha;
    } };
    const subdir = join(worktree, '子目錄');
    mkdirSync(subdir);
    assertWorktree((await handleEvent('SessionStart', { cwd: subdir }, checkIdentity)).context,
      '目前專案根', join(realpathSync.native(worktree), SETTINGS));
    write(join(nested, '.planner-id'), 'invalid');
    assert.match((await handleEvent('SessionStart', { cwd: nested }, online)).message, /INIT/);
  });

  await checked('Planner Gateway marker 與 GitHub origin 合約及短逾時', async () => {
    const fetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      const data = JSON.parse(options.body);
      requests.push(data);
      assert.equal(url, 'http://127.0.0.1:3600/gateway');
      assert.equal(options.headers.Authorization, 'Bearer fake-token');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ data: data.op === 'project.list' ? { projects: [{ id: alpha }] } : { id: beta } }) };
    };
    try {
      const envFile = join(TEMP, 'planner-fixture.env');
      write(envFile, 'PLANNER_TOKEN="fake-token"\n');
      const live = { home, env: { ...env, PLANNER_ENV_FILE: envFile, PLANNER_URL: 'http://127.0.0.1:3600/' }, lookup: queryPlanner };
      const remote = join(TEMP, 'remote');
      mkdirSync(remote);
      git(remote, 'init', '-q');
      git(remote, 'remote', 'add', 'origin', 'git@github.com:Example/Remote.git');
      writeConfig(remote, '遠端來源', '遠端命名空間');
      assert.match((await handleEvent('SessionStart', { cwd: repo }, live)).context, /READY/);
      assert.match((await handleEvent('SessionStart', { cwd: remote }, live)).context, /READY/);
      assert.deepEqual(requests, [{ op: 'project.list', data: {} },
        { op: 'project.resolveByRemote', data: { remoteUrl: 'github.com/example/remote' } }]);
      const start = performance.now();
      globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      const run = handleEvent('SessionStart', { cwd: remote }, live);
      const keepAlive = setTimeout(() => {}, 3100);
      try {
        assert.match((await run).context, /來自快取，快取時間/);
        assert.ok(performance.now() - start < 3000);
      } finally { clearTimeout(keepAlive); }
    } finally { globalThis.fetch = fetch; }
  });

  await checked('Planner 離線同身分快取含時間，未辨識不受設定檔影響', async () => {
    const cached = await handleEvent('SessionStart', { cwd: worktree }, offline);
    assert.match(cached.context, /READY.*來自快取，快取時間 \d{4}-\d\d-\d\dT/);
    writeConfig(unknown, '測試來源', '測試庫');
    assert.deepEqual(await handleEvent('SessionStart', { cwd: unknown }, offline),
      { message: '專案流程 INIT：此資料夾可初始化。' });
  });

  await checked('Planner 依環境、UTF-8 使用者設定與兩端 hook 探測，INIT 明示未設定', async () => {
    const fakeHome = join(TEMP, 'credential home');
    const config = join(fakeHome, '.ai-cli', 'project-flow', 'config.json');
    const gateway = 'http://127.0.0.1:3650';
    const targets = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      targets.push([url, options.headers.Authorization]);
      return { ok: true, json: async () => ({ data: { projects: [{ id: alpha }] } }) };
    };
    try {
      const start = (sessionEnv = env, cwd = repo) => handleEvent('SessionStart', { cwd }, { home: fakeHome, env: sessionEnv });
      assert.deepEqual(await start(), { message: '專案流程 INIT：Planner 未設定（看 README）。' });
      const plannerFile = (directory, token, port) => {
        const root = join(fakeHome, directory, 'tkflyc-planner');
        write(join(root, '.env.local'), 'PLANNER_TOKEN="' + token + '"\nPLANNER_URL=' + gateway.replace('3650', port) + '/\n');
        return root;
      };
      const codexRoot = plannerFile('柯德克斯 產品', 'fake-codex', '3651');
      const claudeRoot = plannerFile('克勞德 產品', 'fake-claude', '3652');
      const writeHook = (file, root, event, quote) => write(join(fakeHome, file), '\uFEFF' + JSON.stringify({
        hooks: { [event]: [{ hooks: [{ type: 'command',
          command: 'node ' + quote + join(root, 'mcp', event === 'SessionStart' ? 'session-start-hook.mjs' : 'session-end-hook.mjs') + quote }] }] },
      }));
      writeHook('.codex/hooks.json', codexRoot, 'SessionEnd', '"');
      assert.match((await start()).context, /READY/);
      writeHook('.claude/settings.json', claudeRoot, 'SessionStart', "'");
      assert.match((await start()).context, /READY/);
      const configRoot = plannerFile('設定 產品', 'fake-config-root', '3653');
      write(config, JSON.stringify({ plannerRoot: configRoot }));
      assert.match((await start()).context, /READY/);
      const configuredEnv = join(fakeHome, '手動.env');
      write(configuredEnv, 'PLANNER_TOKEN=fake-config-env\nPORT=3654\n');
      write(config, JSON.stringify({ plannerRoot: configRoot, plannerEnvFile: configuredEnv }));
      assert.match((await start()).context, /READY/);
      const overrideRoot = plannerFile('環境 產品', 'fake-override-file', '3655');
      assert.match((await start({ ...env, PLANNER_ROOT: overrideRoot, PLANNER_API_TOKENS: 'fake-override,ignore' })).context, /READY/);
      assert.match((await start({ ...env, PLANNER_URL: gateway, PLANNER_TOKEN: 'fake-direct' })).context, /READY/);
      assert.deepEqual(targets, [
        ['3651', 'fake-codex'], ['3652', 'fake-claude'], ['3653', 'fake-config-root'], ['3654', 'fake-config-env'],
        ['3655', 'fake-override'], ['3650', 'fake-direct'],
      ].map(([port, token]) => ['http://127.0.0.1:' + port + '/gateway', 'Bearer ' + token]));
      assert.doesNotMatch(readFileSync(join(fakeHome, '.ai-cli', 'project-flow', 'cache.json'), 'utf8'), /fake-|Bearer|365[0-5]/);
    } finally { globalThis.fetch = originalFetch; }
  });

  await checked('快取鎖超過 10 秒可回收，仍新鮮的鎖保留', async () => {
    const fakeHome = join(TEMP, 'cache lock home');
    const fakeCache = join(fakeHome, '.ai-cli', 'project-flow', 'cache.json');
    const lock = fakeCache + '.lock';
    write(lock, 'fixture');
    const start = () => handleEvent('SessionStart', { cwd: repo }, { ...online, home: fakeHome });
    assert.match((await start()).context, /READY/);
    assert.equal(readFileSync(lock, 'utf8'), 'fixture');
    assert.equal(existsSync(fakeCache), false);
    const expired = new Date(Date.now() - 20_000);
    utimesSync(lock, expired, expired);
    assert.match((await start()).context, /READY/);
    assert.equal(existsSync(lock), false);
    assert.match((await handleEvent('SessionStart', { cwd: repo }, { ...offline, home: fakeHome })).context, /來自快取/);
  });

  if (process.platform === 'win32') await checked('Windows 大小寫與分隔符差異命中並更新同一快取', async () => {
    const fakeHome = join(TEMP, 'cache casing home');
    const fakeCache = join(fakeHome, '.ai-cli', 'project-flow', 'cache.json');
    const alternate = realpathSync.native(repo).toUpperCase().replaceAll('\\', '/');
    write(fakeCache, JSON.stringify([{ root: alternate, key: alpha, id: alpha, at: '2026-01-02T00:00:00.000Z' }]));
    assert.match((await handleEvent('SessionStart', { cwd: repo }, { ...offline, home: fakeHome })).context,
      /來自快取.*2026-01-02T00:00:00.000Z/);
    assert.match((await handleEvent('SessionStart', { cwd: alternate }, { ...online, home: fakeHome })).context, /READY/);
    const [entry, ...remaining] = JSON.parse(readFileSync(fakeCache, 'utf8'));
    assert.equal(entry.root, realpathSync.native(repo));
    assert.deepEqual(remaining, []);
  });

  await checked('三態與頂端 schema，INIT 不建設定檔', async () => {
    const init = join(TEMP, 'no-config');
    write(join(init, '.planner-id'), alpha + '\n');
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).message, /INIT/);
    assert.equal(existsSync(join(init, SETTINGS)), false);
    writeConfig(init, '進度來源', '歸檔目的地');
    const valid = readFileSync(join(init, SETTINGS), 'utf8');
    write(join(init, SETTINGS), valid.replace(/^S8:.*\r?\n/m, ''));
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).message, /INVALID.*S8/);
    write(join(init, SETTINGS), valid.replace(/^S8:.*$/m, 'S8: [literal'));
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).message, /INVALID/);
    assert.throws(() => parseSettings('# 前置正文\n' + configTemplate), /頂端/);
    write(join(init, SETTINGS), configTemplate);
    const placeholders = await handleEvent('SessionStart', { cwd: init }, online);
    assert.match(placeholders.message, /INVALID.*佔位值：S1、S2、S4、S5、S6、S8、S10、S11、S12、limits/);
    assert.equal(placeholders.context, placeholders.message);
    assert.doesNotMatch(placeholders.context, /^R[1-8]\b/m);
    write(join(init, SETTINGS), valid.replace(/^S5:.*$/m, 'S5: "TODO"').replace(/^limits:.*$/m, 'limits: "先填 <...>"'));
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).message, /INVALID.*佔位值：S5、limits/);
    write(join(init, SETTINGS), valid);
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).context, /READY/);
  });

  await checked('兩個專案設定與離線快取隔離，開場只注入規則', async () => {
    await handleEvent('SessionStart', { cwd: other }, online);
    const configA = loadSettings(join(repo, SETTINGS)).values;
    const configB = loadSettings(join(other, SETTINGS)).values;
    assert.equal(configA.S1, '團隊 WBS 機密標記');
    assert.equal(configB.S1, '知識庫進度私有標記');
    assert.notEqual(configA.S11, configB.S11);
    for (const cwd of [repo, other]) {
      const start = await handleEvent('SessionStart', { cwd }, offline);
      assert.match(start.context, /READY.*來自快取/);
      for (const secret of [configA.S1, configB.S1, configA.S11, configB.S11]) {
        assert.ok(!start.context.includes(secret));
      }
    }
  });

  await checked('歸檔僅採全域 COMMAND，保留使用者原句且依 S11 分流', async () => {
    assert.equal(checkArchive('歸檔', home, env), '');
    const stub = join(home, '.claude', 'scripts', 'archive_trigger.py');
    write(stub, [
      'import os, sys',
      'if sys.argv[1:] != ["--check", os.environ["ARCHIVE_FIXTURE_PROMPT"]]:',
      '    sys.exit(71)',
      'mode = os.environ["ARCHIVE_FIXTURE_MODE"]',
      'if mode == "CRASH":',
      '    print("COMMAND")',
      '    raise RuntimeError("fixture crash")',
      'print(mode)',
      '',
    ].join('\n'));
    for (const result of ['ASK', 'NONE', 'COMMAND', 'CRASH']) {
      const prompt = result === 'NONE' ? '算了 先歸檔吧' : '歸檔 "原句" 與 \'引號\'\n下一行';
      const archiveEnv = { ...env, ARCHIVE_FIXTURE_PROMPT: prompt, ARCHIVE_FIXTURE_MODE: result };
      assert.equal(checkArchive(prompt, home, archiveEnv), result === 'CRASH' ? '' : result);
      const options = { ...online, env: archiveEnv };
      const a = await handleEvent('UserPromptSubmit', { cwd: repo, prompt }, options);
      const b = await handleEvent('UserPromptSubmit', { cwd: other, prompt }, options);
      if (result === 'COMMAND') {
        assert.match(a.context, /R6[\s\S]*R7[\s\S]*雲端專案專屬庫/);
        assert.match(b.context, /R6[\s\S]*R7[\s\S]*namespace-beta/);
        assert.doesNotMatch(a.context, /namespace-beta/);
        const inWorktree = await handleEvent('UserPromptSubmit', { cwd: worktree, prompt }, options);
        assert.match(inWorktree.context, /worktree 專屬庫/);
        assert.doesNotMatch(inWorktree.context, /雲端專案專屬庫/);
      } else {
        assert.deepEqual(a, {});
        assert.deepEqual(b, {});
      }
    }
    assert.equal(checkArchive('歸檔', home, { ...env, PROJECT_FLOW_PYTHON: join(TEMP, 'no-python') }), '');
  });

  await checked('worker 跳過 R1／R4／R2，Stop 放行', async () => {
    const worker = { ...online, env: { ...env, AI_CLI_WORKER: '1' } };
    const result = await handleEvent('SessionStart', { cwd: repo }, worker);
    assert.doesNotMatch(result.context, /^R[124]\b/m);
    assert.match(result.context, /^R3 .*anthropic-<模型>.*openai-<模型>/m);
    assert.deepEqual(await handleEvent('Stop', { cwd: repo, last_assistant_message: '完成' }, worker), {});
  });

  await checked('Stop 同指紋只擋一次，active、基準及已有證據放行', async () => {
    const payload = { cwd: worktree, session_id: 'stop-core', last_assistant_message: '已完成程式。' };
    await handleEvent('SessionStart', payload, online);
    assert.equal((await handleEvent('Stop', payload, online)).reason, null);
    write(join(worktree, 'untracked.mjs'), 'export const value = 2;\n');
    assert.deepEqual(await handleEvent('Stop', { ...payload, stop_hook_active: true }, online), {});
    assert.equal((await handleEvent('Stop', { cwd: worktree, session_id: payload.session_id }, online)).reason, null);
    const complete = ['測試輸出 npm test PASS', '獨立驗證 job abc-1 通過',
      '測試報告 reports/test.md', '量化進度已更新 3/5 60.00%'].join('\n');
    const missingPayload = { ...payload, last_assistant_message: complete.split('\n')[0] };
    const incomplete = await handleEvent('Stop', missingPayload, online);
    assert.match(incomplete.reason, /獨立驗證.*測試報告.*量化進度/);
    assert.doesNotMatch(incomplete.reason, /測試輸出/);
    assert.equal((await handleEvent('Stop', missingPayload, online)).reason, null);
    write(join(worktree, 'untracked.mjs'), 'export const value = 20;\n');
    assert.equal((await handleEvent('Stop', { ...payload, last_assistant_message: complete }, online)).reason, null);
    const worker = { ...online, env: { ...env, AI_CLI_WORKER: '1' } };
    write(join(worktree, 'untracked.mjs'), 'export const value = 3;\n');
    assert.deepEqual(await handleEvent('Stop', payload, worker), {});
    assert.match((await handleEvent('Stop', payload, online)).reason, /測試輸出/);
  });

  await checked('Stop 純文件只檢查進度，含程式或文件移成程式仍檢查完整證據', async () => {
    const payload = { cwd: worktree, session_id: 'stop-docs', last_assistant_message: '完成' };
    const progress = { ...payload, last_assistant_message: '量化進度已更新 3/5 60.00%' };
    write(join(worktree, 'main.mjs'), 'export const value = 88;\n'); // 開場前已有的程式改動。
    await handleEvent('SessionStart', payload, online);
    write(join(worktree, '操作文件.MD'), '# 文件\n');
    assert.equal((await handleEvent('Stop', progress, online)).reason, null);
    for (const name of ['guide.txt', 'guide.rst', 'guide.adoc', 'docs/figure.drawio']) write(join(worktree, name), '文件\n');
    git(worktree, 'add', '--', '操作文件.MD', 'guide.txt', 'guide.rst', 'guide.adoc', 'docs/figure.drawio');
    git(worktree, '-c', 'user.name=Project Flow', '-c', 'user.email=flow@example.invalid', 'commit', '-qm', 'docs fixture');
    const missing = (await handleEvent('Stop', payload, online)).reason;
    assert.match(missing, /量化進度/);
    assert.doesNotMatch(missing, /測試|獨立驗證/);
    assert.equal((await handleEvent('Stop', payload, online)).reason, null);
    git(worktree, 'mv', 'docs/figure.drawio', 'figure.mjs');
    assert.match((await handleEvent('Stop', progress, online)).reason, /測試輸出.*獨立驗證.*測試報告/);
    git(worktree, 'mv', 'figure.mjs', 'docs/figure.drawio');
    write(join(worktree, 'main.mjs'), 'export const value = 99;\n');
    const mixed = (await handleEvent('Stop', progress, online)).reason;
    assert.match(mixed, /測試輸出.*獨立驗證.*測試報告/);
    assert.doesNotMatch(mixed, /量化進度/);
  });

  await checked('Stop 清理超過 14 天的 checked 與 session 狀態', async () => {
    const stopDir = join(state, 'stop');
    const unusedScope = join(stopDir, 'f'.repeat(64));
    const expired = [join(unusedScope, 'session-' + 'a'.repeat(64)), join(unusedScope, 'checked-' + 'b'.repeat(64))];
    const recent = join(unusedScope, 'session-' + 'c'.repeat(64));
    const unrelated = join(unusedScope, 'session-keep');
    for (const file of [...expired, recent, unrelated]) write(file, '');
    const old = new Date(Date.now() - 15 * 86400_000);
    for (const file of [...expired, unrelated]) utimesSync(file, old, old);
    const almost = new Date(Date.now() - 13 * 86400_000);
    utimesSync(recent, almost, almost);
    await handleEvent('SessionStart', { cwd: worktree, session_id: 'cleanup' }, online);
    for (const file of expired) assert.equal(existsSync(file), false);
    for (const file of [recent, unrelated]) assert.equal(existsSync(file), true);
  });

  await checked('Claude 與 Codex 的 hook 輸出，Codex stdin 及 argv', () => {
    write(join(home, '.agents', 'skills', 'project-flow', 'SKILL.md'), skill);
    const start = { cwd: worktree, session_id: 'bridge', hook_event_name: 'SessionStart' };
    const claude = adapter('claude', start);
    const codex = adapter('codex', start);
    assert.equal(claude.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(claude.hookSpecificOutput.additionalContext, /READY.*來自快取/);
    assert.deepEqual(codex, claude);
    assert.deepEqual(adapter('codex', start, true), codex);
    for (const name of ['claude', 'codex']) {
      const stop = { ...start, hook_event_name: 'Stop', last_assistant_message: '完成' };
      write(join(worktree, 'untracked.mjs'), 'export const modifiedBy = ' + JSON.stringify(name) + ';\n');
      assert.deepEqual(adapter(name, { ...stop, stop_hook_active: true }), {});
      const blocked = adapter(name, stop);
      assert.deepEqual(Object.keys(blocked), ['decision', 'reason']);
      assert.equal(blocked.decision, 'block');
      assert.match(blocked.reason, /測試輸出.*獨立驗證.*測試報告.*量化進度/);
      assert.deepEqual(adapter(name, stop), {});
    }
    const init = { ...start, cwd: unknown };
    assert.match(adapter('claude', init).systemMessage, /INIT/);
    assert.match(adapter('codex', init, true).systemMessage, /INIT/);
  });

  await checked('正典缺段及 Codex 安裝副本分歧會警告', () => {
    assert.match(ruleContext(skill), /^R8 /m);
    assert.match(ruleContext(skill.replace('### R3 ', '### Q3 ')), /正典分歧/);
    assert.match(ruleContext(skill, { installedSkill: skill + '\n更新' }), /正典分歧/);
  });

  await checked('暫存 HOME 實際安裝、備份、重跑及移除，保留八支舊 hook', () => {
    const fakeHome = join(TEMP, 'fake home');
    const fake = { description: '原設定', hooks: Object.fromEntries(
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd'].map(event => [event,
        [{ matcher: '*', hooks: [0, 1].map(i => ({ type: 'command', command: 'old-' + event + i })) }]])) };
    fake.hooks.Stop = [];
    const raw = JSON.stringify(fake, null, 2) + '\n';
    const hooksPath = join(fakeHome, '.codex', 'hooks.json');
    const installer = join(PLUGIN, 'install', 'codex-install.mjs');
    write(hooksPath, raw);
    const installEnv = { ...env, HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: dirname(hooksPath) };
    const spawnOptions = { cwd: fakeHome, env: installEnv, encoding: 'utf8', windowsHide: true };
    const run = (...args) => execFileSync(process.execPath, [installer, ...args], spawnOptions);
    const assertInside = path => {
      const within = relative(realpathSync.native(TEMP), path);
      assert.ok(within && within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within), path);
    };
    const first = planInstall(fakeHome);
    mkdirSync(dirname(first.skillPath), { recursive: true });
    const actualHome = execFileSync(process.execPath, ['--input-type=module', '--eval',
      'import { homedir } from "node:os"; console.log(homedir())'], spawnOptions).trim();
    assert.equal(realpathSync.native(actualHome), realpathSync.native(fakeHome));
    assert.notEqual(realpathSync.native(actualHome), realpathSync.native(homedir()));
    for (const target of [first.hooksPath, first.skillPath, first.receiptPath]) {
      assertInside(target);
      assertInside(realpathSync.native(dirname(target)));
    }
    assert.match(run('--dry-run'), /預覽 安裝/);
    assert.equal(readFileSync(hooksPath, 'utf8'), raw);
    assert.equal(existsSync(first.skillPath), false);
    assert.equal(existsSync(first.receiptPath), false);
    const lock = join(dirname(hooksPath), '.ai-cli-project-flow-install.lock');
    write(lock, 'stale fixture');
    const locked = spawnSync(process.execPath, [installer], spawnOptions);
    assert.equal(locked.status, 1);
    assert.ok(locked.stderr.includes(lock));
    assert.equal(readFileSync(hooksPath, 'utf8'), raw);
    renameSync(lock, join(fakeHome, 'retired-install.lock'));
    const backups = () => readdirSync(dirname(hooksPath)).filter(name => /^hooks\.json\.project-flow-.+\.bak$/.test(name));
    assert.deepEqual(backups(), []);
    assert.match(run(), /hooks 備份/);
    assert.equal(backups().length, 1);
    assert.equal(readFileSync(join(dirname(hooksPath), backups()[0]), 'utf8'), raw);
    const installedHooks = readFileSync(hooksPath, 'utf8');
    const installedConfig = JSON.parse(installedHooks);
    assert.deepEqual(installedConfig, first.next);
    assert.equal(readFileSync(first.skillPath, 'utf8'), skill);
    assert.deepEqual(JSON.parse(readFileSync(first.receiptPath, 'utf8')), first.metadata);
    const hooks = Object.values(installedConfig.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
    assert.equal(hooks.length, 11);
    assert.equal(hooks.filter(hook => hook.command.startsWith('old-')).length, 8);
    for (const event of Object.keys(fake.hooks)) {
      assert.deepEqual(installedConfig.hooks[event].slice(0, fake.hooks[event].length), fake.hooks[event]);
    }
    assert.match(run(), /hooks 無變更，skill 無變更/);
    assert.equal(backups().length, 1);
    assert.equal(readFileSync(hooksPath, 'utf8'), installedHooks);
    assert.match(run('--uninstall', '--dry-run'), /預覽 移除/);
    assert.equal(readFileSync(hooksPath, 'utf8'), installedHooks);
    write(first.skillPath, first.desired + '\n本機註記');
    assert.equal(planInstall(fakeHome, { uninstall: true }).skillChanged, false);
    assert.throws(() => planInstall(fakeHome), /本機修改/);
    write(first.skillPath, first.desired);
    assert.match(run('--uninstall'), /hooks 備份/);
    assert.equal(backups().length, 2);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8')), fake);
    assert.equal(existsSync(first.skillPath), false);
    assert.equal(existsSync(first.receiptPath), false);
    assert.equal(existsSync(lock), false);
    const freshHome = join(TEMP, 'empty home');
    const fresh = planInstall(freshHome);
    write(fresh.hooksPath, JSON.stringify(fresh.next));
    write(fresh.receiptPath, JSON.stringify(fresh.metadata));
    assert.equal(planInstall(freshHome, { uninstall: true }).removeHooksFile, true);
  });

  await checked('Codex 單一 command 可執行含空白與中文路徑，也可替換舊 hook', () => {
    const adapterPath = join(TEMP, '空白 路徑', 'fake adapter.mjs');
    write(adapterPath, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const legacy = { hooks: { Stop: [{ hooks: [{ type: 'command',
      command: "'old-node' 'old-adapter' Stop --ai-cli-project-flow", commandWindows: '& old-node' }] }] } };
    const installed = mergeHooks(legacy, { adapterPath });
    assert.equal(installed.hooks.Stop.length, 1);
    const [hook] = installed.hooks.Stop[0].hooks;
    assert.deepEqual(Object.keys(hook), ['type', 'command', 'timeout']);
    assert.match(hook.command, /^node ".+空白 路徑.+fake adapter\.mjs" Stop --ai-cli-project-flow$/u);
    const run = (shell, args, extra = {}) => {
      const result = spawnSync(shell, args, { cwd: TEMP, env, encoding: 'utf8', windowsHide: true, ...extra });
      assert.equal(result.status, 0, shell + ': ' + (result.error ?? result.stderr));
      assert.deepEqual(JSON.parse(result.stdout), ['Stop', '--ai-cli-project-flow']);
    };
    if (process.platform === 'win32') {
      run('cmd.exe', ['/c', '"' + hook.command + '"'], { windowsVerbatimArguments: true });
      const encoded = Buffer.from(hook.command, 'utf16le').toString('base64');
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
      const gitBash = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe');
      if (existsSync(gitBash)) run(gitBash, ['-c', hook.command]);
    } else {
      run('sh', ['-c', hook.command]);
    }
  });

  const claude = join(TEMP, 'fake claude config');
  const installed = join(claude, 'plugins', 'installed_plugins.json');
  const pluginId = 'ai-cli_project-flow@tkflyc-ai-cli';
  const changed = ['"plugins/ai-cli_project-flow/templates/settings.md"'];
  const actions = () => bundledPluginActions(ROOT, changed, claude);
  write(installed, JSON.stringify({ version: 2, plugins: {} }));
  await checked('project-flow updater 獨立偵測外掛', () => {
    const notices = actions();
    assert.equal(notices.length, 1);
    assert.ok(notices[0].includes('claude plugin install ' + pluginId));
  });
  await checked('project-flow updater 使用專屬描述', () => {
    const [description] = actions();
    assert.match(description, /依 Planner 專案身分與專案設定/);
    assert.doesNotMatch(description, /輸入框上方/);
  });
  await checked('project-flow updater 提示安裝副本更新', () => {
    write(installed, JSON.stringify({ version: 2, plugins: { [pluginId]: [{ version: '0.0.9' }] } }));
    const [notice] = actions();
    assert.match(notice, /0\.0\.9/);
    assert.ok(notice.includes('claude plugin update ' + pluginId));
  });
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}
