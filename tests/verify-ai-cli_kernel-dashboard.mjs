/** 真正共用規則與控制器的故障測試；不依賴真 TTY、wt.exe 或 AI provider。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const load = name => import(pathToFileURL(join(ROOT, 'dist/ai-cli_kernel', name + '.js')).href);
const rules = await load('dashboard-rules');
const { DashboardController, perform } = await load('dashboard');
const view = await load('dashboard-view');
const terminal = await load('dashboard-terminal');
const { runKernelCli } = await load('cli');
let failures = 0, checks = 0;
async function test(name, fn) {
  checks++;
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.log('FAIL ' + name + ' — ' + error.stack); }
}
const id = 'kr-20261107-162917-235f', other = 'kr-20261107-172917-235f';
const commit = 'a'.repeat(40), releaseId = id + '-rel-0123456789abcdef';
function detail(state = 'completed', develop = true) {
  const d = rules.parseDetail({ runId: id, effectiveState: state, stateLabel: state, goal: '完整目標第一行\n第二行中文全部保留', template: develop ? 'develop' : 'readonly-audit',
    models: { decide: { model: 'test', effort: 'medium' }, worker: { model: 'test' } }, boundaryLabel: '未隔離',
    progress: { decides: { used: 1, max: 5 }, workerSteps: { used: 2, max: 6 }, inputTokens: { used: 1000, max: 1000000 }, activeMinutes: { used: 1, max: 90 } },
    develop: develop ? { repoRoot: '/repo', branch: 'feature', verifiedCommit: commit, testCommand: 'npm test', allowedPaths: ['src'], checkpoint: { ref: 'checkpoint' }, checkpointPrepared: { commit } } : null,
    steps: [{ id: 'one', title: '實作', status: 'passed' }], acceptance: { passed: true } });
  if (d.develop) { d.develop.currentBranch = 'master'; d.develop.defaultBranch = 'master'; }
  return d;
}
function fixture(d = detail()) {
  const calls = [];
  let current = d, snap = { ...rules.EMPTY, at: 123, triggersOn: false, runs: [{ runId: d.runId, state: d.state, label: d.label, goal: d.goal }] };
  const effects = {
    async snapshot() { calls.push('snapshot'); return structuredClone(snap); },
    async detail(runId) { calls.push(['detail', runId]); return structuredClone({ ...current, runId }); },
    async report(runId) { calls.push(['report', runId]); return Array.from({ length: 200 }, (_, i) => '報告 ' + i).join('\n'); },
    async execute(action) { calls.push(['execute', action.id]); return 'done'; },
    async createRelease() { calls.push('create'); return { id: releaseId }; },
    async runRelease(value) { calls.push(['release', value]); return { status: 'succeeded' }; },
    async triggers() { calls.push('triggers'); return snap.triggersOn; },
  };
  return { effects, calls, set detail(value) { current = value; }, get detail() { return current; }, set snap(value) { snap = value; }, get snap() { return snap; } };
}
const writes = calls => calls.filter(c => c === 'create' || Array.isArray(c) && ['execute', 'release'].includes(c[0]));

await test('操作規則：重要狀態、文字與 develop 承認參數', () => {
  for (const state of ['awaiting_approval', 'waiting_human', 'interrupted']) {
    const actions = rules.actionsFor(detail(state));
    assert.equal(actions[0].id, 'approve');
    assert.ok(actions[0].args.includes('--acknowledge-unisolated'));
    assert.ok(actions[0].warning.includes('沒有隔離'));
    assert.equal(actions[0].label, state === 'awaiting_approval' ? '核准' : '接回');
  }
  for (const state of ['running', 'stop_pending', 'version_drift', 'needs_reconcile']) {
    assert.deepEqual(rules.actionsFor(detail(state)).map(a => a.id), ['cancel']);
  }
  for (const state of ['completed', 'failed', 'cancelled', 'budget_exhausted']) {
    const actions = rules.actionsFor(detail(state));
    assert.ok(actions.some(a => a.id === 'rollback'));
    assert.ok(actions.some(a => a.id === 'cleanup'));
    assert.ok(actions.some(a => a.id === 'archive'));
    assert.ok(!actions.some(a => a.id === 'cancel'));
  }
  assert.deepEqual(rules.actionsFor(detail('completed', false)).map(a => a.id), ['archive']);
  assert.equal(rules.triggerAction(false).args.join(' '), 'triggers on');
  assert.equal(rules.triggerAction(true).id, 'triggers-off');
  assert.ok(rules.reasonLabel('unknown').includes('unknown'));
  assert.equal(rules.stepLabel('blocked'), '卡住');
  assert.equal(rules.shortState('completed', ''), '完成');
  assert.ok(rules.templateLabel('develop').includes('權限等於你本人'));
  assert.ok(rules.stateHelp(detail()).includes('成果還在分支上'));
  assert.ok(rules.progressLine(detail().progress).includes('worker 2/6'));
});
await test('沒有通過測試的 commit 就沒有合併推送', () => {
  const d = detail(); d.develop.verifiedCommit = null;
  assert.ok(!rules.actionsFor(d).some(a => a.isRelease));
  assert.ok(!rules.actionsFor(detail('failed')).some(a => a.isRelease));
});
await test('只有推到預設分支才帶 allow-default-branch', () => {
  const actions = rules.actionsFor(detail());
  assert.ok(!actions.find(a => a.id === 'merge').args.includes('--allow-default-branch'));
  assert.ok(!actions.find(a => a.id === 'push-branch').args.includes('--allow-default-branch'));
  assert.ok(actions.find(a => a.id === 'push-current').args.includes('--allow-default-branch'));
  const d = detail(); d.develop.currentBranch = 'integration';
  assert.ok(!rules.actionsFor(d).find(a => a.id === 'push-current').args.includes('--allow-default-branch'));
  d.develop.branch = 'master';
  assert.ok(rules.actionsFor(d).find(a => a.id === 'push-branch').args.includes('--allow-default-branch'));
});
await test('第一次按鍵與其他鍵不執行，n Esc 取消，只有 y 執行', async () => {
  for (const cancel of ['n', 'escape']) {
    const f = fixture(detail('running')), c = new DashboardController(f.effects); await c.refresh();
    await c.key('1'); assert.equal(c.pending.id, 'cancel');
    for (const key of ['1', 'g', 'r', 'q', 'ctrl+c', 't', 'down', 'Y', 'enter']) await c.key(key);
    assert.equal(c.selected, id); assert.equal(writes(f.calls).length, 0);
    await c.key(cancel); assert.equal(c.pending, null); assert.equal(writes(f.calls).length, 0);
    await c.key('1'); await c.key('y'); assert.deepEqual(writes(f.calls), [['execute', 'cancel']]);
  }
});
await test('確認不可見時 y 不放行', async () => {
  const f = fixture(), c = new DashboardController(f.effects); await c.refresh();
  await c.key('1'); await c.key('y', 10, false);
  assert.ok(c.pending); assert.equal(writes(f.calls).length, 0);
});
await test('commit 變更、操作失效及重新查詢失敗阻止執行', async () => {
  for (const mode of ['commit', 'state', 'query']) {
    const f = fixture(), c = new DashboardController(f.effects); await c.refresh(); await c.key('1');
    assert.equal(c.pending.commit, commit);
    if (mode === 'commit') f.detail.develop.verifiedCommit = 'b'.repeat(40);
    if (mode === 'state') f.detail.state = 'running';
    if (mode === 'query') f.effects.detail = async () => { throw new Error('查詢故障'); };
    await c.key('y'); assert.equal(writes(f.calls).length, 0); assert.ok(c.notice.includes('失敗'));
  }
  const f = fixture(detail('running')), c = new DashboardController(f.effects); await c.refresh(); await c.key('1');
  f.detail.state = 'completed'; await c.key('y'); assert.equal(writes(f.calls).length, 0);
});
await test('切換自動觸發也必須確認與重查', async () => {
  const f = fixture(), c = new DashboardController(f.effects); await c.refresh();
  await c.key('t'); assert.equal(c.pending.id, 'triggers-on'); assert.equal(writes(f.calls).length, 0);
  f.snap.triggersOn = true; await c.key('y'); assert.equal(writes(f.calls).length, 0);
  await c.key('t'); await c.key('y'); assert.deepEqual(writes(f.calls), [['execute', 'triggers-off']]);
});
await test('非放行操作亦綁定確認時的 commit', async () => {
  const f = fixture(), c = new DashboardController(f.effects); await c.refresh();
  const index = rules.actionsFor(c.detail).findIndex(a => a.id === 'cleanup');
  await c.key(String(index + 1)); assert.equal(c.pending.confirmedCommit, commit);
  f.detail.develop.verifiedCommit = 'c'.repeat(40); await c.key('y');
  assert.equal(writes(f.calls).length, 0); assert.ok(c.notice.includes('commit 已改變'));
});
await test('release create 先於 run，可靠 id 才執行，結果不明不重試', async () => {
  const f = fixture(); await perform(f.effects, rules.actionsFor(f.detail)[0]);
  assert.deepEqual(writes(f.calls), ['create', ['release', releaseId]]);
  for (const response of [null, {}, { id: '' }, { id: 'unknown' }, { id: other + '-rel-0123456789abcdef' }]) {
    const f = fixture(); f.effects.createRelease = async () => { f.calls.push('create'); return response; };
    await assert.rejects(perform(f.effects, rules.actionsFor(f.detail)[0]));
    assert.deepEqual(writes(f.calls), ['create']);
  }
  for (const stage of ['createRelease', 'runRelease']) {
    const f = fixture(), c = new DashboardController(f.effects);
    f.effects[stage] = async () => { f.calls.push(stage); throw new Error('結果不明'); };
    await c.refresh(); await c.key('1'); await c.key('y'); await c.key('y');
    assert.equal(f.calls.filter(c => c === stage).length, 1); assert.ok(c.notice.includes('不會自動重試'));
    if (stage === 'createRelease') assert.ok(!f.calls.some(c => Array.isArray(c) && c[0] === 'release'));
  }
});
await test('執行中防重入', async () => {
  const f = fixture(detail('running')), c = new DashboardController(f.effects); let complete;
  f.effects.execute = async a => { f.calls.push(['execute', a.id]); await new Promise(r => { complete = r; }); };
  await c.refresh(); await c.key('1'); const flight = c.key('y');
  await new Promise(setImmediate); assert.ok(c.busy); await c.key('1'); await c.key('y');
  let quit = false, result; const leaving = c.key('q').then(value => { result=value; quit=true; });
  await new Promise(setImmediate); assert.equal(quit,false);
  complete(); await Promise.all([flight,leaving]); assert.equal(writes(f.calls).length, 1); assert.equal(quit,true); assert.equal(result,'quit');
});
await test('chooseRun 手動固定、新開工自動追蹤、確認期間固定對象', async () => {
  const f = fixture(detail('running')); f.snap.runs.push({ runId: other, state: 'waiting_human', label: '等', goal: 'other' });
  const c = new DashboardController(f.effects); f.snap.active = id; await c.refresh(); assert.equal(c.interval, 5000);
  await c.key('down'); assert.equal(c.selected, other); await c.refresh(); assert.equal(c.selected, other);
  f.snap.active = other; await c.refresh(); assert.equal(c.selected, other);
  await c.key('up'); await c.key('1'); const captured = c.pending.runId;
  f.snap.active = id; await c.refresh(); assert.equal(c.selected, captured); assert.equal(c.pending.runId, captured);
  await c.key('escape'); assert.equal(c.selected, id);
  f.snap.active = null; await c.refresh(); assert.equal(c.interval, 30000);
  assert.equal(rules.chooseRun(id, true, id, { ...f.snap, active: other }).runId, other);
  assert.equal(rules.chooseRun(id, true, id, { ...f.snap, error: 'fail' }).runId, id);
});
await test('刷新失敗保留資料與成功時間，單飛且舊結果不覆蓋新選擇', async () => {
  const f = fixture(), c = new DashboardController(f.effects);
  f.snap.runs.push({ runId: other, state: 'running', label: '', goal: 'second' });
  await c.refresh(); const old = structuredClone(c.snapshot);
  f.effects.snapshot = async () => { throw new Error('讀取失敗'); }; await c.refresh();
  assert.equal(c.snapshot.at, old.at); assert.deepEqual(c.snapshot.runs, old.runs); assert.equal(c.detail.runId, id); assert.ok(c.snapshot.error.includes('讀取失敗'));
  let release, count = 0;
  f.effects.snapshot = async () => { count++; if (count === 1) await new Promise(r => { release = r; }); return structuredClone(f.snap); };
  const first = c.refresh(); const second = c.refresh(); const selecting = c.key('down');
  assert.equal(first, second); assert.equal(count, 1); release(); await Promise.all([first, second, selecting]);
  assert.equal(count, 2); assert.equal(c.selected, other); assert.equal(c.detail.runId, other);
  assert.equal(c.snapshot.error, null);
});
await test('中文寬度、ANSI 與 grapheme 裁切換行', () => {
  assert.equal(view.displayWidth('中A文'), 5); assert.equal(view.displayWidth('\x1b[31m中\x1b[0m'), 2);
  assert.equal(view.clipCells('中A文', 3), '中A'); assert.equal(view.clipCells('e\u0301中', 1), 'e\u0301');
  assert.equal(view.clipCells('👨‍👩‍👧‍👦中', 2), '👨‍👩‍👧‍👦');
  assert.deepEqual(view.wrapCells('中文AB', 4), ['中文', 'AB']);
  assert.ok(!view.clipCells('\x1b]0;fake\x07中文', 4).includes('\x1b'));
});
await test('確認指令保護 shell 展開與引號，畫面使用注入的 shell', async () => {
  const args = ['release', 'create', id, '--target', "feature/$value`whoami`'quoted"];
  assert.equal(view.commandLine(args), `ai-cli kernel release create ${id} --target 'feature/$value\`whoami\`'"'"'quoted'`);
  assert.equal(view.commandLine(args, 'powershell'), `ai-cli kernel release create ${id} --target 'feature/$value\`whoami\`''quoted'`);
  const c = new DashboardController(fixture().effects); await c.refresh();
  c.pending = { ...rules.actionsFor(c.detail)[0], args };
  const frame = view.renderDashboard(c, 200, 40, 'powershell');
  assert.ok(frame.text.includes(view.commandLine(args, 'powershell')));
  assert.equal(frame.confirmationFits, true);
});
await test('全部詳情標籤、完整目標、窄視窗、空清單與報告可捲動', async () => {
  const d = detail(), lines = view.detailLines(d, 24).join('\n');
  for (const label of ['編號','開始','目標','範本','狀態','說明','原因','細節','來源','工作目錄','模型','權限','進度','正在做','驗收','分支','測試指令','通過的 commit','可改路徑','回復點','下一步']) assert.ok(lines.includes(label + '：'), label);
  assert.ok(lines.replace(/\n/g, '').includes('完整目標第一行第二行中文全部保留'));
  const c = new DashboardController(fixture().effects); await c.refresh();
  for (const [columns, rows] of [[120,30], [30,20], [2,2], [10,1], [21,10]]) {
    const frame = view.renderDashboard(c, columns, rows);
    assert.ok(frame.text.split('\r\n').length <= rows);
    assert.ok(frame.text.split('\r\n').every(line => view.displayWidth(line) <= columns - 1));
  }
  const empty = new DashboardController(fixture().effects);
  assert.ok(view.renderDashboard(empty,80,24).text.includes('待歸檔：未知'));
  const noRuns = fixture(); noRuns.snap.runs=[];
  const knownEmpty = new DashboardController(noRuns.effects); await knownEmpty.refresh();
  assert.ok(view.renderDashboard(knownEmpty,80,24).text.includes('還沒有 run'));
  await c.key('r'); assert.ok(c.report.includes('報告 199')); await c.key('pagedown'); assert.ok(c.scroll > 0);
  assert.ok(view.renderDashboard(c,80,24).text.includes('報告 '));
  await c.key('escape'); assert.equal(c.report, null);
  await c.key('1'); assert.ok(view.confirmationLines(c.pending,80).join('\n').includes(commit));
  assert.equal(view.renderDashboard(c,21,10).confirmationFits, false);
});
await test('窄視窗每頁不跳行，完整目標各行均可閱讀，按鍵提示不被裁掉', async () => {
  const d = detail(); d.goal = Array.from({length:80},(_,i)=>`目標行-${String(i).padStart(3,'0')}`).join('\n');
  const c = new DashboardController(fixture(d).effects); await c.refresh();
  const seen = new Set();
  for (let page=0;page<150;page++) {
    const frame = view.renderDashboard(c,21,20); c.scroll = frame.scroll;
    for (const match of frame.text.matchAll(/目標行-(\d{3})/g)) seen.add(Number(match[1]));
    for (const key of ['j/k','1–9','t 觸發','f 執行','g 更新','q/Ctrl+C']) assert.ok(frame.text.includes(key),key);
    const old = c.scroll; await c.key('pagedown',frame.pageSize);
    const next = view.renderDashboard(c,21,20); c.scroll = next.scroll;
    if (old === c.scroll) break;
  }
  assert.equal(seen.size,80);
});

function fakeTerminal({ raw = false, paused = true, failInit = false } = {}) {
  const input = new EventEmitter(), output = new EventEmitter(), events = new EventEmitter();
  const writes = [], errors = [], modes = [];
  input.isTTY = output.isTTY = true; input.isRaw = raw; input.isPaused = () => paused;
  input.setRawMode = mode => { modes.push(mode); input.isRaw = mode; if (failInit && mode) throw new Error('raw 初始化失敗'); };
  input.resume = () => { paused = false; }; input.pause = () => { paused = true; };
  output.columns = 120; output.rows = 35;
  output.write = (text, cb) => { writes.push(text); if (cb) setImmediate(() => { writes.push('DRAINED'); cb(); }); return true; };
  return { input, output, events, error: text => errors.push(text), writes, errors, modes };
}
await test('輪詢依 active 切換 5 秒與 30 秒，cleanup 只清理自身 timer listener', async () => {
  const host = fakeTerminal(), f = fixture(); let serial = 0;
  const timers = new Map();
  host.clock = { setTimeout(fn,ms) { const id = ++serial; timers.set(id,{fn,ms}); return id; }, clearTimeout(id) { timers.delete(id); } };
  const external = () => {}; host.events.on('SIGTERM',external);
  const running = terminal.runDashboard(f.effects,host); await new Promise(setImmediate);
  assert.deepEqual([...timers.values()].map(t=>t.ms),[30000]);
  const fire = () => { const [id,t] = [...timers].find(([,t])=>t.ms !== 40); timers.delete(id); t.fn(); };
  f.snap.active = id; fire(); await new Promise(setImmediate);
  assert.deepEqual([...timers.values()].map(t=>t.ms),[5000]);
  f.snap.active = null; fire(); await new Promise(setImmediate);
  assert.deepEqual([...timers.values()].map(t=>t.ms),[30000]);
  host.input.emit('data','q'); assert.equal(await running,0); assert.equal(timers.size,0);
  assert.deepEqual(host.events.listeners('SIGTERM'),[external]); assert.equal(writes(f.calls).length,0);
});
await test('輪詢與連按 g 共用讀取後只留一個 timer，退出沒有殘留', async () => {
  const host = fakeTerminal(), f = fixture(); let serial = 0, release;
  const timers = new Map();
  host.clock = { setTimeout(fn,ms) { const id = ++serial; timers.set(id,{fn,ms}); return id; }, clearTimeout(id) { timers.delete(id); } };
  let reads = 0;
  f.effects.snapshot = async () => {
    if (++reads === 1) await new Promise(done => { release = done; });
    return structuredClone(f.snap);
  };
  const running = terminal.runDashboard(f.effects, host);
  try {
    host.input.emit('data', 'gg');
    assert.equal(reads, 1);
    release(); await new Promise(setImmediate);
    assert.equal(reads, 2);
    assert.equal([...timers.values()].filter(t => t.ms === 30000).length, 1);
  } finally { host.input.emit('data', 'q'); await running; }
  assert.equal(timers.size, 0);
});
await test('stdout callback 前不回傳，排空錯誤回報非零', async () => {
  let callback, settled = false;
  const flight = terminal.drainDashboardOutput({ write(text,cb) { assert.equal(text,''); callback=cb; } }).then(()=>{settled=true;});
  await new Promise(setImmediate); assert.equal(settled,false); callback(); await flight; assert.equal(settled,true);
  const host = fakeTerminal(), original = host.output.write;
  host.output.write = (text,cb) => text === '' ? setImmediate(()=>cb(new Error('pipe broken'))) : original(text,cb);
  const running = terminal.runDashboard(fixture().effects,host); host.events.emit('SIGTERM');
  assert.equal(await running,1); assert.ok(host.errors.some(s=>s.includes('排空失敗')));
});
await test('worker 與 stdin/stdout 非 TTY 拒絕，拒絕前不動終端機', async () => {
  for (const mode of ['worker','stdin','stdout']) {
    const host = fakeTerminal();
    if (mode === 'worker') host.worker = '1'; else host[mode === 'stdin' ? 'input' : 'output'].isTTY = false;
    // 若拒絕規則被突變移除，送 q 讓測試失敗而不掛住整個 harness。
    setImmediate(() => host.input.emit('data','q'));
    assert.equal(await terminal.runDashboard(fixture().effects,host),1);
    assert.equal(host.writes.length,0); assert.equal(host.modes.length,0); assert.ok(host.errors.length);
  }
});
await test('正常 Ctrl+C SIGTERM 例外及初始化失敗皆恢復終端機並排空 stdout', async () => {
  for (const mode of ['quit','ctrl+c','SIGTERM','exception','rejection','resize-error','init']) {
    const host = fakeTerminal({ failInit: mode === 'init' });
    const running = terminal.runDashboard(fixture().effects,host);
    if (mode !== 'init') {
      await new Promise(setImmediate);
      if (mode === 'quit') host.input.emit('data',Buffer.from('q'));
      if (mode === 'ctrl+c') host.input.emit('data',Buffer.from('\x03'));
      if (mode === 'SIGTERM') host.events.emit('SIGTERM');
      if (mode === 'exception') host.events.emit('uncaughtException',new Error('unexpected'));
      if (mode === 'rejection') host.events.emit('unhandledRejection',new Error('promise'));
      if (mode === 'resize-error') { const write = host.output.write; host.output.write = (...args) => { host.output.write = write; throw new Error('render'); }; host.output.emit('resize'); }
    }
    const code = await running;
    assert.equal(code, mode === 'quit' ? 0 : mode === 'ctrl+c' ? 130 : mode === 'SIGTERM' ? 143 : 1, mode);
    assert.equal(host.input.isRaw,false,mode); assert.equal(host.input.isPaused(),true,mode);
    assert.ok(host.writes.includes('DRAINED'),mode);
    if (mode !== 'init') assert.ok(host.writes.some(s => s.includes('\x1b[?1049l') && s.includes('\x1b[?25h')),mode);
    for (const emitter of [host.events,host.input,host.output]) assert.equal(emitter.eventNames().length,0,mode);
  }
  const host = fakeTerminal({ raw: true, paused: false }); const running = terminal.runDashboard(fixture().effects,host);
  host.events.emit('SIGINT'); assert.equal(await running,130); assert.equal(host.input.isRaw,true); assert.equal(host.input.isPaused(),false);
});
await test('初始化進入 alternate screen 後失敗仍復原，刷新失敗可繼續退出且不影響 run', async () => {
  const host = fakeTerminal(); const write = host.output.write;
  host.output.write = (...args) => { host.output.write = write; write(...args); throw new Error('alternate write failed'); };
  assert.equal(await terminal.runDashboard(fixture().effects,host),1);
  assert.ok(host.writes.some(s => s.includes('\x1b[?1049l'))); assert.equal(host.input.isRaw,false);
  const f = fixture(); f.effects.snapshot = async () => { throw new Error('offline'); };
  const next = fakeTerminal(); const running = terminal.runDashboard(f.effects,next); await new Promise(setImmediate);
  assert.ok(next.writes.some(s => s.includes('offline'))); next.input.emit('data','q');
  assert.equal(await running,0); assert.equal(writes(f.calls).length,0);
});
await test('resize 重畫中文寬度，退出時執行中的 run 不受影響', async () => {
  const f = fixture(detail('running')); f.snap.active=id; const host = fakeTerminal();
  const running = terminal.runDashboard(f.effects,host); await new Promise(setImmediate);
  try {
    const before = host.writes.length; host.output.columns=30; host.output.rows=20; host.output.emit('resize');
    assert.ok(host.writes.length>before);
    const painted = view.clean(host.writes.at(-1));
    assert.ok(painted.split(/\r?\n/).every(line=>view.displayWidth(line)<=29));
  } finally { host.input.emit('data','q'); await running; }
  assert.equal(await running,0); assert.equal(writes(f.calls).length,0);
});
await test('鍵盤解碼支援跨 chunk 方向鍵與 Esc，不把貼上和未知 CSI 當操作', () => {
  const keys = new terminal.DashboardKeys();
  assert.deepEqual(keys.feed('\x1b['),[]); assert.deepEqual(keys.feed('A'),['up']);
  assert.deepEqual(keys.feed('\x1b[5~\x1b[6~'),['pageup','pagedown']);
  assert.deepEqual(keys.feed('\x1b'),[]); assert.deepEqual(keys.flush(),['escape']);
  assert.deepEqual(keys.feed('\x1b[200~1yq\x1b[201~g'),['g']);
  assert.deepEqual(keys.feed('\x1b[9~'),[]);
});
await test('new-tab 使用完整參數陣列、含空白入口與工作目錄、不遞迴 new-tab', async () => {
  const calls = [], out = [], errors = [];
  const config = { platform: 'win32', env: { WT_SESSION: 'test' }, executable: 'C:/Program Files/node/node.exe', execArgs: ['--import','C:/Runtime Files/loader.mjs'], entry: join(ROOT,'entry with spaces.js'), cwd: 'C:/Work Space/repo',
    findWt: () => 'C:/Windows Apps/wt.exe', async launch(...args) { calls.push(args); return 0; } };
  assert.equal(await terminal.launchDashboardTab(config,{stdout:s=>out.push(s),stderr:s=>errors.push(s)}),0);
  assert.deepEqual(calls[0],[config.findWt(), ['-w','0','new-tab','--title','ai-cli_kernel','--startingDirectory',config.cwd,'--',config.executable,...config.execArgs,config.entry,'kernel','dashboard'],config.cwd]);
  assert.ok(!calls[0][1].includes('--new-tab')); assert.equal(errors.length,0);
  const relative = { ...config, entry: 'entry with spaces.js' };
  assert.equal(terminal.newTabArgs(relative).at(-3), join(config.cwd, relative.entry));
});
await test('new-tab worker 不繞過，非 Windows Terminal、wt 缺失、入口缺失與啟動失敗', async () => {
  for (const mode of ['worker','linux','outside-wt','missing-wt','missing-entry','error','nonzero']) {
    let launched = 0, searched = 0; const out = [], errors = [];
    const config = { platform: mode === 'linux' ? 'linux' : 'win32', env: { WT_SESSION: mode === 'outside-wt' ? '' : 'test', AI_CLI_WORKER: mode === 'worker' ? '1' : '' }, executable: '/node', execArgs: [], entry: mode === 'missing-entry' ? undefined : '/cli.js', cwd: ROOT,
      findWt() { searched++; return mode === 'missing-wt' ? null : '/wt.exe'; }, async launch() { launched++; if (mode === 'error') throw new Error('spawn failed'); return mode === 'nonzero' ? 9 : 0; } };
    const code = await terminal.launchDashboardTab(config,{stdout:s=>out.push(s),stderr:s=>errors.push(s)});
    assert.equal(code,['linux','outside-wt','missing-wt'].includes(mode) ? 2 : 1,mode);
    assert.equal(launched,['error','nonzero'].includes(mode) ? 1 : 0,mode);
    if (['worker','linux','outside-wt'].includes(mode)) assert.equal(searched,0,mode);
    if (['linux','outside-wt','missing-wt'].includes(mode)) assert.ok(out.join('').includes('ai-cli kernel dashboard'));
    assert.ok(errors.length,mode);
  }
});
await test('真實 CLI actions JSON 與 dashboard launcher 檢查次序', async () => {
  const api = await load('api');
  const created = await api.aiCliKernelStart({ goal: 'dashboard actions JSON fixture', workFolder: ROOT });
  let stdout = '', stderr = ''; const io = { stdout:s=>{stdout+=s;}, stderr:s=>{stderr+=s;} };
  assert.equal(await runKernelCli(['actions',created.runId,'--json'],io),0);
  const actions = JSON.parse(stdout); assert.equal(actions[0].id,'approve');
  for (const field of ['id','label','summary','warning','args','commit','isRelease']) assert.ok(field in actions[0]);
  stdout = ''; assert.equal(await runKernelCli(['actions',created.runId,'--json','value'],io),1);
  for (const args of [['dashboard'],['dashboard','--new-tab']]) {
    // 即使 worker 閘門被突變移除，也不能真的啟動本機的 Windows Terminal。
    const ran = spawnSync(process.execPath,[join(ROOT,'dist/bin/ai-cli.js'),'kernel',...args], { cwd: ROOT, env: { ...process.env, AI_CLI_WORKER:'1', WT_SESSION:'' }, encoding:'utf8',timeout:15000 });
    assert.equal(ran.status,1); assert.ok(ran.stderr.includes('AI_CLI_WORKER=1')); assert.ok(!ran.stdout.includes('\x1b[?1049h'));
  }
  const piped = spawnSync(process.execPath,[join(ROOT,'dist/bin/ai-cli.js'),'kernel','dashboard'], { cwd:ROOT, env:{...process.env,AI_CLI_WORKER:''},encoding:'utf8',timeout:15000 });
  assert.equal(piped.status,1); assert.ok(piped.stderr.includes('TTY'));
});
console.log(`dashboard: ${checks - failures}/${checks} PASS`);
process.exitCode = failures ? 1 : 0;
