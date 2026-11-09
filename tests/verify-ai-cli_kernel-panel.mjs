/** 正式 plugin 的無 vendor 回歸；編譯實際 TSX 並執行 hook，CI 不需要 claude CLI。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { actionsFor, parseDetail } from '../dist/ai-cli_kernel/dashboard-rules.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN = join(ROOT, 'plugins/ai-cli_kernel_panel');
const source = readFileSync(join(PLUGIN, 'hooks/register.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { fileName: 'register.tsx', compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
}, reportDiagnostics: true });
assert.equal(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
const id = 'kr-1', commit = 'a'.repeat(40);
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const atoms = new Map(), hooks = new Map(), calls = [], reads = [], opened = [];
  const raw = { runId: id, effectiveState: 'completed', stateLabel: '完成', goal: '目標：測試', template: 'develop',
    develop: { repoRoot: 'D:/repo with spaces', branch: 'feature', verifiedCommit: commit, testCommand: 'npm test',
      checkpointResult: {}, notices: [], allowedPaths: [] } };
  const d = parseDetail(raw); d.develop.currentBranch = 'master'; d.develop.defaultBranch = 'master';
  const state = { raw, actions: actionsFor(d), global: { active: null, activeRuns: [], runs: [{ runId: id, effectiveState: 'completed', goal: '測試' }] },
    result: { exitCode: 0, stdout: '', stderr: '' }, ...options };
  const sdk = {
    atom(ref, initial) { const token = ref.key; atoms.set(token, initial); return token; },
    async read(_, token) { return atoms.get(token); },
    async update(_, token, fn) { atoms.set(token, fn(atoms.get(token))); },
  };
  const exports = {};
  const React = { createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) }; } };
  new Function('require', 'exports', 'React', compiled.outputText)(name => { assert.equal(name, 'claude-code'); return sdk; }, exports, React);
  exports.register((name, filter, handler) => hooks.set(name, typeof filter === 'function' ? filter : handler));
  const env = { USERPROFILE: 'D:/test home', AI_CLI_REPO: 'D:/repo with spaces', ...options.env };
  const $ = {
    env: { async get(name) { return env[name]; } },
    fs: { async read(path) {
      reads.push(path);
      if (path.endsWith('/dist/bin/ai-cli.js')) {
        if (state.missing?.includes(path) || state.missingAll) throw Error('ENOENT fixture');
        return '// fake binary';
      }
      return '{"enabled":false}';
    } },
    process: { async run(argv, settings) {
      calls.push([...argv]); assert.ok(settings.timeoutMs > 0); assert.equal(argv[0], 'node');
      if (state.spawnError) throw Error(state.spawnError);
      const args = argv.slice(3), done = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
      if (args[0] === 'dashboard') return state.result;
      if (args[0] === 'status') return done(args[1] === '--json' ? state.global : state.raw);
      if (args[0] === 'actions') return done(state.actions);
      if (args[0] === 'release' && args[1] === 'create') return done(state.created ?? { id: 'rel-1' });
      return { exitCode: 0, stdout: 'succeeded', stderr: '' };
    } },
    clock: { async now() { return 1000; }, every() { return { cancel() {} }; } },
    command: { async register() {} },
    ui: { async open(value) { opened.push(value); return { isPlaced: true }; }, async panes() { return []; }, async status() {},
      resolve() { return { Box: 'Box', Text: 'Text', Button: 'Button' }; } },
  };
  const command = args => hooks.get('command.run')($, { args });
  const render = () => hooks.get('ui.render')($, { props: { bodyColumns: 80, isFocused: true } });
  function nodes(tree) { return tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes)] : []; }
  async function press(key) {
    const node = nodes(await render()).find(node => node.props.key === key);
    assert.ok(node, 'missing button ' + key); node.props.onPress();
  }
  const effects = () => calls.filter(argv => !['status', 'actions', 'dashboard'].includes(argv[3]));
  return { $, exports, state, atoms, calls, reads, opened, command, render, nodes, press, effects };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(setImmediate); }
  assert.fail('plugin did not settle');
}

await check('manifest 與 marketplace 正式註冊', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json')));
  assert.equal(manifest.name, 'ai-cli_kernel_panel'); assert.equal(manifest.version, '0.1.0');
  assert.equal(JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'))).plugins.find(p => p.name === manifest.name).source, './plugins/ai-cli_kernel_panel');
  assert.deepEqual(JSON.parse(readFileSync(join(PLUGIN, 'hooks/hooks.json'))).modules, ['./register.tsx']);
});
await check('/kernel 透過真正 command hook 開新分頁，不開側邊面板；空白與 shell 字元都是單一 argv', async () => {
  const f = fixture({ env: { AI_CLI_REPO: 'D:/repo space/$x;name' } });
  assert.equal((await f.command('')).text, '已在新分頁打開');
  assert.deepEqual(f.calls[0], ['node', 'D:/repo space/$x;name/dist/bin/ai-cli.js', 'kernel', 'dashboard', '--new-tab']);
  assert.equal(f.opened.length, 0);
});
await check('非零退出完整呈現兩個 stream、尾行、退出原因與可貼指令', async () => {
  const f = fixture({ result: { exitCode: 9, stdout: 'one\ntwo\nthree\nfour\n', stderr: 'failure\nlast reason\n' } });
  const { text } = await f.command('');
  for (const part of ['結束碼 9', f.state.result.stdout, f.state.result.stderr, 'ai-cli kernel dashboard --new-tab', '/kernel side']) assert.ok(text.includes(part));
  assert.equal(f.calls.length, 1); assert.equal(f.opened.length, 0);
});
await check('spawn 例外也保留原始錯誤且不重試', async () => {
  const f = fixture({ spawnError: 'spawn node ENOENT' });
  assert.ok((await f.command('')).text.includes('spawn node ENOENT')); assert.equal(f.calls.length, 1);
});
await check('未知參數只顯示用法，不讀檔、不呼叫 CLI、不開面板', async () => {
  for (const arg of ['unknown', 'side extra', '--help']) {
    const f = fixture(); assert.match((await f.command(arg)).text, /用法.*\/kernel side/);
    assert.equal(f.calls.length, 0); assert.equal(f.opened.length, 0); assert.equal(f.reads.length, 0);
  }
});
await check('/kernel side 開啟並聚焦原 session 面板，查詢真實 actions JSON', async () => {
  const f = fixture(); assert.match((await f.command(' side ')).text, /已打開/);
  assert.deepEqual(f.opened, [{ id: 'ai-cli_kernel_panel', title: 'ai-cli_kernel', focus: true }]);
  assert.ok(f.calls.some(argv => JSON.stringify(argv.slice(3)) === JSON.stringify(['actions', id, '--json'])));
  assert.ok(!f.calls.some(argv => argv[3] === 'dashboard'));
  assert.deepEqual(f.atoms.get('available'), clone(f.state.actions));
});
await check('有效 AI_CLI_REPO 優先、無效時回家目錄、只有家目錄與兩者皆不可用', async () => {
  let f = fixture(); assert.equal(await f.exports.resolvePaths(f.$), 'D:/repo with spaces/dist/bin/ai-cli.js'); assert.equal(f.reads.length, 1);
  f = fixture({ missing: ['D:/repo with spaces/dist/bin/ai-cli.js'] });
  assert.equal(await f.exports.resolvePaths(f.$), 'D:/test home/ai-cli-mcp-source/dist/bin/ai-cli.js'); assert.equal(f.reads.length, 2);
  f = fixture({ env: { AI_CLI_REPO: undefined, USERPROFILE: undefined, HOME: '/test home' } });
  assert.equal(await f.exports.resolvePaths(f.$), '/test home/ai-cli-mcp-source/dist/bin/ai-cli.js');
  f = fixture({ missingAll: true }); const text = (await f.command('')).text;
  for (const part of ['AI_CLI_REPO', '$env:AI_CLI_REPO', 'dist/bin/ai-cli.js', 'ENOENT fixture']) assert.ok(text.includes(part));
  assert.equal(f.calls.length, 0);
  f = fixture({ missingAll: true, env: { AI_CLI_REPO: undefined } });
  await assert.rejects(f.exports.resolvePaths(f.$), /AI_CLI_REPO/);
});
await check('activeRuns 多筆完整顯示，新版空陣列不回退，舊版才 fallback', async () => {
  const f = fixture(), parse = f.exports.parseSnapshot;
  let snap = parse({ active: 'stale', activeRuns: [{ runId: 'one' }, { runId: 'two' }] }, false, 1);
  assert.deepEqual(snap.activeRuns, ['one', 'two']); assert.equal(snap.active, 'one');
  assert.equal(f.exports.summaryLine(snap), 'kernel 2 執行中');
  f.atoms.set('snapshot', snap); assert.ok(JSON.stringify(await f.render()).includes('one、two'));
  snap = parse({ active: 'stale', activeRuns: [] }, false, 1);
  assert.equal(snap.active, null); assert.deepEqual(snap.activeRuns, []); assert.equal(f.exports.summaryLine(snap), undefined);
  assert.deepEqual(parse({ active: 'old' }, false, 1).activeRuns, ['old']);
  assert.deepEqual(parse({ active: { runId: 'old' } }, false, 1).activeRuns, ['old']);
});
await check('CLI actions 原樣整合，錯誤 schema 關閉操作，空陣列沒有本地 fallback', async () => {
  const f = fixture(); assert.equal(f.exports.actionsFor, undefined);
  assert.deepEqual(f.exports.parseActions(clone(f.state.actions), id), clone(f.state.actions));
  for (const bad of [{ actions: [] }, [{}], [{ ...f.state.actions[0], runId: 'other' }], [{ ...f.state.actions[0], args: 'shell string' }]]) assert.throws(() => f.exports.parseActions(bad, id));
  assert.deepEqual(f.exports.parseActions([], id), []);
  await f.command('side');
  f.atoms.set('available', [{ ...f.state.actions[0], runId: 'other' }]);
  assert.ok(!f.nodes(await f.render()).some(node => node.props.key === 'merge'), '不能在目前 run 顯示另一筆 run 的操作');
  f.state.actions = {}; await f.command('side'); assert.deepEqual(f.atoms.get('available'), []);
});
await check('第一次按鍵只開確認，y 重查 status/commit 與 actions，再先 create 後 run', async () => {
  const f = fixture(); await f.command('side'); const before = f.calls.length;
  await f.press('merge'); assert.equal(f.calls.length, before); assert.equal(f.effects().length, 0);
  assert.equal(f.atoms.get('confirm').confirmedCommit, commit);
  await f.press('confirm-yes'); await until(() => f.atoms.get('notice')?.kind === 'ok');
  assert.deepEqual(f.calls.slice(before, before + 4).map(argv => argv.slice(3)), [
    ['status', id, '--json'], ['actions', id, '--json'], f.state.actions[0].args, ['release', 'run', 'rel-1'],
  ]);
  assert.equal(f.effects().length, 2);
});
await check('按 n 取消不執行，第一次操作與確認畫面都不造成副作用', async () => {
  const f = fixture(); await f.command('side'); await f.press('merge'); await f.press('confirm-no');
  assert.equal(f.atoms.get('confirm'), null); assert.equal(f.effects().length, 0);
});
await check('y 時 commit 改變拒絕所有 release 指令', async () => {
  const f = fixture(); await f.command('side'); await f.press('merge'); f.state.raw.develop.verifiedCommit = 'b'.repeat(40);
  await f.press('confirm-yes'); await until(() => f.atoms.get('notice')?.kind === 'error');
  assert.match(f.atoms.get('notice').text, /commit 已經變了/); assert.equal(f.effects().length, 0);
});
await check('y 時操作消失、參數變動或警告變動均拒絕', async () => {
  for (const change of [f => { f.state.actions = []; }, f => { f.state.actions[0].args.push('--changed'); }, f => { f.state.actions[0].warning = '新警告'; }]) {
    const f = fixture(); await f.command('side'); await f.press('merge'); change(f);
    await f.press('confirm-yes'); await until(() => f.atoms.get('notice')?.kind === 'error');
    assert.match(f.atoms.get('notice').text, /確認內容已經變了/); assert.equal(f.effects().length, 0);
  }
});
await check('release create 沒有 id 時不執行 release run，亦不重試', async () => {
  const f = fixture({ created: {} }); await f.command('side'); await f.press('merge'); await f.press('confirm-yes');
  await until(() => f.atoms.get('notice')?.kind === 'error'); assert.equal(f.effects().length, 1);
});
await check('非 release 操作仍需兩步確認，使用 CLI 的原始 args', async () => {
  const f = fixture(); f.state.raw.effectiveState = 'awaiting_approval'; f.state.raw.develop.verifiedCommit = null;
  f.state.actions = actionsFor(parseDetail(f.state.raw)); await f.command('side'); await f.press('approve');
  assert.equal(f.effects().length, 0); await f.press('confirm-yes'); await until(() => f.atoms.get('notice')?.kind === 'ok');
  assert.deepEqual(f.effects()[0].slice(3), ['approve', id, '--acknowledge-unisolated']);
});
console.log(`kernel panel: ${checks}/${checks} PASS`);
