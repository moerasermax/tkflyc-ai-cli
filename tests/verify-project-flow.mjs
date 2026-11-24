/** 驗證兩端 hook、Planner 快取、設定隔離與安裝規劃。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, parseSettings, SETTINGS } from '../plugins/ai-cli_project-flow/lib/config.mjs';
import { checkArchive, handleEvent, ruleContext } from '../plugins/ai-cli_project-flow/lib/flow.mjs';
import { queryPlanner } from '../plugins/ai-cli_project-flow/lib/project.mjs';
import { planInstall } from '../plugins/ai-cli_project-flow/install/codex-install.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN = join(ROOT, 'plugins', 'ai-cli_project-flow');
const TEMP = mkdtempSync(join(realpathSync(tmpdir()), 'ai-cli-project-flow-'));
const home = join(TEMP, 'home');
const configTemplate = readFileSync(join(PLUGIN, 'templates', SETTINGS), 'utf8');
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
  PLANNER_TOKEN: '', PLANNER_API_TOKENS: '', AI_CLI_WORKER: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(TEMP, 'no-global-git') };
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
  const body = configTemplate.replace('進度來源種類與位置', source)
    .replace('歸檔流程文件、知識庫與命名空間', destination);
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

  await checked('Planner marker 的根、子目錄與 worktree 回指同一根', async () => {
    for (const cwd of [repo, nested, worktree]) {
      const result = await handleEvent('SessionStart', { cwd }, online);
      assert.match(result.context, /READY/);
      assert.ok(result.context.includes(JSON.stringify(realpathSync(repo))));
    }
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

  await checked('三態與頂端 schema，INIT 不建設定檔', async () => {
    const init = join(TEMP, 'no-config');
    write(join(init, '.planner-id'), alpha + '\n');
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).message, /INIT/);
    assert.equal(existsSync(join(init, SETTINGS)), false);
    write(join(init, SETTINGS), configTemplate.replace(/^S8:.*\r?\n/m, ''));
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).message, /INVALID.*S8/);
    write(join(init, SETTINGS), configTemplate.replace(/^S8:.*$/m, 'S8: [literal'));
    assert.match((await handleEvent('SessionStart', { cwd: init }, online)).message, /INVALID/);
    assert.throws(() => parseSettings('# 前置正文\n' + configTemplate), /頂端/);
    write(join(init, SETTINGS), configTemplate);
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
    for (const result of ['ASK', 'NONE', 'COMMAND']) {
      const prompt = '算了 先歸檔吧';
      const archiveCheck = text => { assert.equal(text, prompt); return result; };
      const a = await handleEvent('UserPromptSubmit', { cwd: repo, prompt }, { ...online, archiveCheck });
      const b = await handleEvent('UserPromptSubmit', { cwd: other, prompt }, { ...online, archiveCheck });
      if (result === 'COMMAND') {
        assert.match(a.context, /R6[\s\S]*R7[\s\S]*雲端專案專屬庫/);
        assert.match(b.context, /R6[\s\S]*R7[\s\S]*namespace-beta/);
        assert.doesNotMatch(a.context, /namespace-beta/);
      } else {
        assert.deepEqual(a, {});
        assert.deepEqual(b, {});
      }
    }
    assert.equal(checkArchive('歸檔', home, env), '');
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
    const complete = ['測試輸出 npm test PASS', '獨立驗證 job abc-1 通過',
      '測試報告 reports/test.md', '量化進度已更新 3/5 60.00%'].join('\n');
    assert.equal((await handleEvent('Stop', { ...payload, last_assistant_message: complete }, online)).reason, null);
    assert.equal((await handleEvent('Stop', payload, online)).reason, null);
    write(join(worktree, 'untracked.mjs'), 'export const value = 20;\n');
    const incomplete = await handleEvent('Stop', { ...payload, last_assistant_message: complete.split('\n')[0] }, online);
    assert.match(incomplete.reason, /獨立驗證.*測試報告.*量化進度/);
    assert.doesNotMatch(incomplete.reason, /測試輸出/);
    assert.equal((await handleEvent('Stop', payload, online)).reason, null);
    const worker = { ...online, env: { ...env, AI_CLI_WORKER: '1' } };
    write(join(worktree, 'untracked.mjs'), 'export const value = 3;\n');
    assert.deepEqual(await handleEvent('Stop', payload, worker), {});
    assert.match((await handleEvent('Stop', payload, online)).reason, /測試輸出/);
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
      const blocked = adapter(name, stop, name === 'codex');
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

  await checked('安裝 dry-run 規劃保留八支舊 hook，冪等且可還原', () => {
    const fakeHome = join(TEMP, 'fake home');
    const fake = { description: '原設定', hooks: Object.fromEntries(
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd'].map(event => [event,
        [{ matcher: '*', hooks: [0, 1].map(i => ({ type: 'command', command: 'old-' + event + i })) }]])) };
    fake.hooks.Stop = [];
    const raw = JSON.stringify(fake, null, 2);
    const hooksPath = join(fakeHome, '.codex', 'hooks.json');
    write(hooksPath, raw);
    const first = planInstall(fakeHome);
    assert.equal(readFileSync(hooksPath, 'utf8'), raw);
    assert.equal(existsSync(first.skillPath), false);
    assert.equal(existsSync(first.receiptPath), false);
    assert.equal(first.next.description, fake.description);
    const hooks = Object.values(first.next.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
    assert.equal(hooks.length, 11);
    assert.equal(hooks.filter(hook => hook.command.startsWith('old-')).length, 8);
    for (const event of Object.keys(fake.hooks)) {
      assert.deepEqual(first.next.hooks[event].slice(0, fake.hooks[event].length), fake.hooks[event]);
    }
    write(hooksPath, JSON.stringify(first.next));
    write(first.skillPath, first.desired);
    write(first.receiptPath, JSON.stringify(first.metadata));
    const second = planInstall(fakeHome);
    assert.equal(second.hooksChanged, false);
    assert.equal(second.skillChanged, false);
    assert.deepEqual(second.next, first.next);
    const undo = planInstall(fakeHome, { uninstall: true });
    assert.deepEqual(undo.next, fake);
    assert.equal(undo.skillChanged, true);
    assert.equal(undo.receiptChanged, true);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8')), first.next);
    write(first.skillPath, first.desired + '\n本機註記');
    assert.equal(planInstall(fakeHome, { uninstall: true }).skillChanged, false);
    assert.throws(() => planInstall(fakeHome), /本機修改/);
    const freshHome = join(TEMP, 'empty home');
    const fresh = planInstall(freshHome);
    write(fresh.hooksPath, JSON.stringify(fresh.next));
    write(fresh.receiptPath, JSON.stringify(fresh.metadata));
    assert.equal(planInstall(freshHome, { uninstall: true }).removeHooksFile, true);
  });
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}
