/**
 * ai-cli_kernel 的終態關卡（issue #17 審查找到的取消競態）：全權限 worker 的程序沒確認消失，
 * run 不得進終態、不得 cleanup、不得放棄動作。全部用假執行器，不啟動 vendor、不花額度。
 *
 * 對應設計的 T1～T12。獨立成一支是因為 verify-ai-cli_kernel.mjs 跑一次要十幾分鐘，
 * 突變測試每一筆都要重跑整支，放在那裡等於沒人會實跑。
 * 失敗印 stdout 的 `FAIL <名稱>`，供 tools/mutation-test.mjs 指認。
 */
import '../tools/stubs/catalog-test-env.mjs';
import { installClaudeQuotaStub } from './helpers/claude-quota-stub.mjs';
installClaudeQuotaStub();
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const load = name => import(pathToFileURL(join(ROOT, 'dist', 'ai-cli_kernel', `${name}.js`)).href);
const { RunStore, kernelRunDir, newRunId, releaseActiveLock } = await load('journal');
const { replayJournal } = await load('replay');
const { runKernelLoop: rawLoop } = await load('loop');
const { buildContract: buildContractRaw } = await load('templates');
const { cancelWithoutRunner, aiCliKernelCleanup, aiCliKernelApprove } = await load('api');
const { settleRunnerRun } = await load('runner-settle');
const { realWorkspace } = await load('workspace');
const { FileJobExecutor } = await load('executor');
const { KernelUntrackedStartError } = await load('types');
const { isFullPermission, unsettledFullPermission, fullPermissionRecords, confirmFullPermissionGone } = await load('full-permission');

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (condition) passed++;
  else { failed++; if (detail !== '') console.log(`  ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/\s+/g, ' ').slice(0, 600)}`); }
}
const rejecting = async promise => { try { await promise; return null; } catch (error) { return error; } };

/** 程式壞掉時迴圈可能停不下來。這裡擋住，讓斷言照常失敗，而不是整支測試卡死。 */
class Runaway extends Error {}
const runKernelLoop = deps => rawLoop(deps).catch(error => { if (error instanceof Runaway) return 'runaway'; throw error; });

class FakeExecutor {
  constructor() { this.started = []; this.killed = []; this.gone = true; this.findResult = null; this.finds = 0; this.onPoll = null; this.polls = 0; }
  async start(action) { this.started.push(action); const error = this.startError?.(action); if (error) throw error; return { pid: 10000 + this.started.length, jobId: `job-${this.started.length}` }; }
  async poll(job) {
    if (++this.polls > 300) throw new Runaway('迴圈失控');
    return this.onPoll?.(job) ?? { state: 'running' };
  }
  async find() { this.finds++; return this.findResult; }
  async kill(job) { this.killed.push(job.jobId); return true; }
  async isGone() { if (this.gone instanceof Error) throw this.gone; return this.gone; }
  async blockers() { return this.gone === true ? [] : ['子孫 pid 4343（node）']; }
}

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-terminal-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'kernel test');
  git(dir, 'config', 'user.email', 'kernel-test@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'README.md'), 'line one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const REPO = newRepo();
// 這支測的不是選模型：一律明示同一個模型。
const MODEL = 'gpt-6.1-sol';
function newDevRun({ approvedDigest } = {}) {
  const runId = newRunId();
  const dir = kernelRunDir(runId);
  const contract = buildContractRaw({ goal: '加功能', workFolder: REPO, template: 'develop', testCommand: 'node -e "process.exit(0)"', model: MODEL, decideModel: MODEL }, new Date(), { runId, worktree: join(dir, 'wt') });
  const store = new RunStore(dir);
  const digest = store.create(contract);
  store.append({ type: 'approved', contractDigest: approvedDigest ?? digest, kind: 'contract' });
  store.append({ type: 'state', state: 'running' });
  return { store, contract, spec: contract.develop };
}
const JOB = { pid: 4242, jobId: 'job-w' };
const OUTCOME = { ok: true, failureClass: null, detail: '', jobStatus: 'completed', exitCode: 0, messageFile: null, messageChars: 0, messagePreview: '', usage: null };
/**
 * 把日誌做成當機現場：計畫已定、工作區已備妥、寫入步驟的意圖已記。
 * stage：'intent'＝只有意圖；'started'＝job 已啟動；'result'＝job 已回結果、判定還沒落盤（競態的那一格）。
 */
function writeRun(stage, options = {}) {
  const run = newDevRun(options);
  const { store, spec } = run;
  store.append({ type: 'decide_processed', actionId: 'a0', ok: true, decision: 'plan', plan: { planId: 'p1', steps: [{ id: 'p1-s1', title: 't', prompt: 'p', mode: 'write' }], reportStep: 'p1-s1' } });
  store.append({ type: 'workspace_ready', head: spec.baseCommit });
  store.append({ type: 'action_intent', action: { actionId: 'a1', kind: 'worker', stepId: 'p1-s1', model: MODEL, prompt: 'p', marker: 'K-x-a1', mode: 'write', cwd: spec.worktree } });
  if (stage !== 'intent') store.append({ type: 'action_started', actionId: 'a1', job: JOB });
  if (stage === 'result') store.append({ type: 'action_result', actionId: 'a1', outcome: OUTCOME });
  return run;
}
const view = store => replayJournal(store.read());
const wroteCancelled = store => store.read().some(event => event.type === 'state' && event.reason === 'user_cancelled');
/** 這些情境都不該碰到工作目錄；碰到就丟例外讓測試失敗。 */
const untouchedWorkspace = { refs: () => [], inspect: () => { throw new Error('不該動到工作目錄'); } };
const deps = (run, executor, overrides = {}) => ({
  store: run.store, contract: run.contract, executor, boundary: async () => 'PASS', quota: async () => 80, agentFor: () => 'codex', versionId: () => 'v1',
  snapshot: () => null, now: () => Date.now(), sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 1, killConfirmMs: 20, pid: process.pid,
  workspace: untouchedWorkspace, ...overrides,
});
const alive = () => { const executor = new FakeExecutor(); executor.gone = false; return executor; };

/* ---- 共用函式本身 ---- */
{
  const write = { actionId: 'a1', kind: 'worker', mode: 'write', model: 'm', prompt: 'p', marker: 'K-a1' };
  check('全權限的定義：只有 write 模式的 worker', isFullPermission(write) && !isFullPermission({ ...write, mode: 'read' }) && !isFullPermission({ ...write, mode: undefined }) && !isFullPermission({ ...write, kind: 'decide' }));
  const timing = { now: () => Date.now(), sleep: async () => {}, pollMs: 1, confirmMs: 5 };
  const gone = new FakeExecutor();
  check('確認消失：有 job 而且 isGone 為 true 才算過', await confirmFullPermissionGone([{ spec: write, job: JOB, processed: false }], { executor: gone, ...timing }, { kill: false }) === null && gone.killed.length === 0);
  await confirmFullPermissionGone([{ spec: write, job: JOB, processed: false }], { executor: gone, ...timing }, { kill: true });
  check('確認消失：kill 為真時先送終止', gone.killed.join() === 'job-w');
  const still = alive();
  const block = await confirmFullPermissionGone([{ spec: write, job: JOB, processed: false }], { executor: still, ...timing }, { kill: false });
  check('確認消失：逾時仍沒消失就擋下，說明含 jobId、pid 與還活著的程序', block?.reason === 'worker_still_alive' && block.jobId === 'job-w' && block.pid === 4242 && block.detail.includes('job-w') && block.detail.includes('4242') && block.detail.includes('子孫 pid 4343'), block);
  const noJob = new FakeExecutor();
  check('確認消失：沒 job 也沒結果時用 marker 查，確定沒啟動才算過', await confirmFullPermissionGone([{ spec: write, processed: false }], { executor: noJob, ...timing }, { kill: true }) === null && noJob.finds === 1);
  noJob.findResult = 'unknown';
  check('確認消失：查不了有沒有啟動就擋下', (await confirmFullPermissionGone([{ spec: write, processed: false }], { executor: noJob, ...timing }, { kill: true }))?.reason === 'cannot_verify_start');
  const found = alive(); found.findResult = JOB;
  check('確認消失：用 marker 查到 job 就照有 job 處理', (await confirmFullPermissionGone([{ spec: write, processed: false }], { executor: found, ...timing }, { kill: true }))?.jobId === 'job-w' && found.killed.join() === 'job-w');
  const failedStart = new FakeExecutor(); failedStart.findResult = 'unknown';
  check('確認消失：啟動失敗（有結果、沒 job）沒有程序可查', await confirmFullPermissionGone([{ spec: write, outcome: { ...OUTCOME, ok: false }, processed: false }], { executor: failedStart, ...timing }, { kill: true }) === null && failedStart.finds === 0);
}

/* ---- T1／T7／T8：結果已落盤、程序還活著，此時取消 ---- */
{
  const run = writeRun('result');
  run.store.requestCancel();
  const executor = alive();
  const state = await runKernelLoop(deps(run, executor));
  const now = view(run.store);
  check('T1 結果已落盤但程序還活著時取消，停在 stop_pending 而不是 cancelled', state === 'stop_pending' && now.state === 'stop_pending' && now.reason === 'worker_still_alive' && !wroteCancelled(run.store), `${state} ${now.reason}`);
  check('T1 取消時會先試著停掉那個 job', executor.killed.includes('job-w'), executor.killed);
  check('T1 stop_pending 的說明印出 jobId 與 pid，供人處理', !!now.detail?.includes('job-w') && now.detail.includes('4242'), now.detail);
  // T8：在 stop_pending 上再 cancel 一次是重查，不是直接放行。
  await cancelWithoutRunner(run.store, alive(), 5);
  check('T8 stop_pending 上再取消，程序還活著就維持 stop_pending', view(run.store).state === 'stop_pending' && !wroteCancelled(run.store), view(run.store).state);
  await cancelWithoutRunner(run.store, new FakeExecutor(), 5);
  check('T8 確認程序消失後再取消才變成 cancelled', view(run.store).state === 'cancelled' && wroteCancelled(run.store), view(run.store).state);
}
{
  const run = writeRun('result');
  run.store.requestCancel();
  const state = await runKernelLoop(deps(run, new FakeExecutor()));
  check('T1 對照：程序確認消失時取消照常變成 cancelled', state === 'cancelled' && wroteCancelled(run.store), state);
}
{
  // T7：isGone 查不了（丟例外）不能當成消失。
  const run = writeRun('result');
  run.store.requestCancel();
  const executor = new FakeExecutor();
  executor.gone = new Error('enumeration unavailable');
  const state = await runKernelLoop(deps(run, executor));
  check('T7 isGone 查不了（丟例外）時不得進終態', state === 'stop_pending' && view(run.store).reason === 'worker_still_alive' && !wroteCancelled(run.store), `${state} ${view(run.store).reason}`);
}

/* ---- T2：runner 不在時取消 ---- */
{
  const run = writeRun('result');
  await cancelWithoutRunner(run.store, alive(), 5);
  check('T2 runner 不在時取消，程序還活著同樣停在 stop_pending', view(run.store).state === 'stop_pending' && view(run.store).reason === 'worker_still_alive' && !wroteCancelled(run.store), view(run.store).state);
}

/* ---- T3：取消發生在等待 job 的輪詢中，結果尚未落盤 ---- */
{
  const run = writeRun('started');
  const executor = new FakeExecutor();
  executor.onPoll = () => { run.store.requestCancel(); return { state: 'running' }; };
  const state = await runKernelLoop(deps(run, executor));
  check('T3 輪詢中取消：先停掉 job、確認消失後才是 cancelled', state === 'cancelled' && executor.killed.includes('job-w') && view(run.store).actions.get('a1')?.outcome?.failureClass === 'cancelled', `${state} ${executor.killed}`);
  const stuck = writeRun('started');
  const stubborn = alive();
  stubborn.onPoll = () => { stuck.store.requestCancel(); return { state: 'running' }; };
  const stuckState = await runKernelLoop(deps(stuck, stubborn));
  check('T3 輪詢中取消但停不掉：stop_pending，不記取消結果', stuckState === 'stop_pending' && !view(stuck.store).actions.get('a1')?.outcome && !wroteCancelled(stuck.store), stuckState);
}

/* ---- T4：只有還沒啟動的動作 ---- */
{
  const run = writeRun('intent');
  run.store.requestCancel();
  const executor = new FakeExecutor();
  const state = await runKernelLoop(deps(run, executor));
  check('T4 只有尚未啟動的動作：確認沒啟動後放棄並取消', state === 'cancelled' && !!view(run.store).actions.get('a1')?.abandoned && executor.started.length === 0, state);
  const offline = writeRun('intent');
  await cancelWithoutRunner(offline.store, new FakeExecutor(), 5);
  check('T4 runner 不在時也一樣：確認沒啟動後放棄並取消', view(offline.store).state === 'cancelled' && !!view(offline.store).actions.get('a1')?.abandoned, view(offline.store).state);
  const unknown = writeRun('intent');
  const blind = new FakeExecutor(); blind.findResult = 'unknown';
  await cancelWithoutRunner(unknown.store, blind, 5);
  check('T4 查不了有沒有啟動時不算取消完成', view(unknown.store).state === 'stop_pending' && view(unknown.store).reason === 'cannot_verify_start', view(unknown.store).state);
}

/* ---- T5：狀態已經被寫成終態，job 還活著 ---- */
{
  const run = writeRun('result');
  realWorkspace.prepare(run.spec);
  // 舊版留下的日誌：程序還活著就寫了 cancelled。
  run.store.append({ type: 'state', state: 'cancelled', reason: 'user_cancelled' });
  const error = await rejecting(aiCliKernelCleanup({ runId: run.store.runId }, { executor: alive() }));
  check('T5 已是 cancelled 但全權限 job 還活著，cleanup 拒絕', /拒絕 cleanup/.test(error?.message ?? '') && error.message.includes('job-w'), error?.message);
  check('T5 被拒絕時 worktree 原封不動', existsSync(run.spec.worktree));
  const probe = alive();
  await rejecting(aiCliKernelCleanup({ runId: run.store.runId }, { executor: probe }));
  check('T5 cleanup 只查不砍', probe.killed.length === 0, probe.killed);
  const result = await aiCliKernelCleanup({ runId: run.store.runId }, { executor: new FakeExecutor() });
  check('T5 對照：程序確認消失後 cleanup 照常拆 worktree', result.worktreeRemoved === true && !existsSync(run.spec.worktree), result);
}
{
  // 已結清（判定落盤）的動作 cleanup 也要查：它的子孫可能後來才被發現還活著。
  const run = writeRun('result');
  run.store.append({ type: 'step_checked', actionId: 'a1', stepId: 'p1-s1', passed: false, failureClass: 'check_failed', findings: ['x'] });
  run.store.append({ type: 'state', state: 'failed', reason: 'decide_gave_up' });
  const error = await rejecting(aiCliKernelCleanup({ runId: run.store.runId }, { executor: alive() }));
  check('T5 cleanup 連已結清的全權限動作也查', /拒絕 cleanup/.test(error?.message ?? ''), error?.message);
}

/* ---- T6：runner 收尾（kernel 自己丟例外） ---- */
{
  const run = writeRun('result');
  let released = 0;
  const executor = alive();
  const state = await settleRunnerRun(run.store, executor, async () => { throw new Error('loop bug'); }, async () => { released++; }, { confirmMs: 5, pollMs: 1 });
  const now = view(run.store);
  check('T6 kernel 例外而全權限 worker 還活著：stop_pending，不寫成可 cleanup 的 failed', state === 'stop_pending' && now.state === 'stop_pending' && now.reason === 'worker_still_alive', `${state} ${now.reason}`);
  check('T6 錯誤內容留在 stop_pending 的說明裡，名額不釋放', !!now.detail?.includes('loop bug') && now.detail.includes('job-w') && released === 0 && executor.killed.includes('job-w'), now.detail);
  // 使用者決定：之後 cancel 確認消失，最後顯示已取消。
  await cancelWithoutRunner(run.store, new FakeExecutor(), 5);
  check('T6 之後取消並確認消失，最後是 cancelled，錯誤仍留在日誌', view(run.store).state === 'cancelled' && run.store.read().some(event => event.type === 'state' && event.state === 'stop_pending' && event.detail?.includes('loop bug')));
  const clean = writeRun('result');
  let cleanReleased = 0;
  const cleanState = await settleRunnerRun(clean.store, new FakeExecutor(), async () => { throw new Error('loop bug'); }, async () => { cleanReleased++; }, { confirmMs: 5, pollMs: 1 });
  check('T6 對照：worker 確認消失時照舊寫 failed／kernel_error 並釋放名額', cleanState === 'failed' && view(clean.store).reason === 'kernel_error' && cleanReleased === 1, `${cleanState} ${view(clean.store).reason}`);
}

/* ---- T9：委任書 digest 不符 ---- */
{
  const run = writeRun('result', { approvedDigest: 'not-the-contract-digest' });
  const executor = alive();
  const state = await runKernelLoop(deps(run, executor));
  check('T9 委任書不符而全權限 worker 還活著：stop_pending，不是 failed', state === 'stop_pending' && view(run.store).state === 'stop_pending' && view(run.store).detail?.includes('contract_mismatch'), `${state} ${view(run.store).detail}`);
  const clean = writeRun('result', { approvedDigest: 'not-the-contract-digest' });
  const cleanState = await runKernelLoop(deps(clean, new FakeExecutor()));
  check('T9 對照：worker 確認消失時照舊是 failed／contract_mismatch', cleanState === 'failed' && view(clean.store).reason === 'contract_mismatch', cleanState);
}

/* ---- T10：needs_reconcile 下放棄 ---- */
{
  const run = writeRun('started');
  run.store.append({ type: 'state', state: 'needs_reconcile', reason: 'job_record_missing' });
  let launches = 0;
  const admission = { quota: async () => 80, agentFor: () => 'codex', launch: async () => { launches++; } };
  const error = await rejecting(aiCliKernelApprove({ runId: run.store.runId, reconcile: 'abandon' }, { ...admission, executor: alive() }));
  check('T10 全權限 job 還活著時 --reconcile abandon 被拒絕', /拒絕 --reconcile abandon/.test(error?.message ?? '') && error.message.includes('job-w') && launches === 0, error?.message);
  check('T10 被拒絕時狀態與動作都不變', view(run.store).state === 'needs_reconcile' && !view(run.store).actions.get('a1')?.abandoned);
  try {
    await aiCliKernelApprove({ runId: run.store.runId, reconcile: 'abandon' }, { ...admission, executor: new FakeExecutor() });
    check('T10 對照：job 確認消失後可以放棄並接回', !!view(run.store).actions.get('a1')?.abandoned && view(run.store).state === 'running' && launches === 1, view(run.store).state);
  } finally { await releaseActiveLock(run.store.runId).catch(() => {}); }
}

/* 無 job 的 abandon 也要查 marker；完成待確認可以安全接續。 */
{
  const run = writeRun('intent');
  run.store.append({type:'state',state:'needs_reconcile',reason:'cannot_verify_start'});
  const executor = new FakeExecutor(); executor.find = async () => 'unknown';
  let launches=0;
  const admission={quota:async()=>80,agentFor:()=> 'codex',launch:async()=>{launches++}};
  const error=await rejecting(aiCliKernelApprove({runId:run.store.runId,reconcile:'abandon'},{...admission,executor}));
  check('abandon without job must find and block unknown start', /拒絕 --reconcile abandon/.test(error?.message??'') && launches===0 && !view(run.store).actions.get('a1').abandoned);
}
{
  const run = writeRun('result');
  run.store.append({type:'state',state:'stop_pending',reason:'completion_pending'});
  let launches=0;
  const admission={quota:async()=>80,agentFor:()=> 'codex',launch:async()=>{launches++}};
  const error=await rejecting(aiCliKernelApprove({runId:run.store.runId},{...admission,executor:alive()}));
  check('completion pending cannot resume while members unknown', !!error && launches===0 && view(run.store).state==='stop_pending');
  try {
    await aiCliKernelApprove({runId:run.store.runId},{...admission,executor:new FakeExecutor()});
    check('completion pending resumes original result after drain', launches===1 && view(run.store).state==='running' && !!view(run.store).actions.get('a1').outcome && !wroteCancelled(run.store));
  } finally { await releaseActiveLock(run.store.runId).catch(()=>{}); }
}

/* ---- T11：原始碼斷言 ---- */
{
  const source = name => readFileSync(join(ROOT, 'src', 'ai-cli_kernel', name), 'utf8').replace(/\r\n/g, '\n');
  const loop = source('loop.ts');
  const literalTerminal = loop.match(/setState\(\s*'(?:completed|failed|cancelled|budget_exhausted)'/g) ?? [];
  const stateWrites = loop.match(/type: 'state'/g) ?? [];
  const guard = /const setState = [^\n]*\n\s*if \(isTerminalState\(state\)\) throw /.test(loop);
  const gate = /const enterTerminal = [^\n]*\n\s*if \(!await settleFullPermission\(state, reason, detail\)\) return 'stop_pending';\n\s*commit\(\{ type: 'state'/.test(loop);
  check('T11 loop 內的終態只由 enterTerminal 寫入（原始碼斷言）', literalTerminal.length === 0 && stateWrites.length === 2 && guard && gate, JSON.stringify({ literalTerminal, stateWrites: stateWrites.length, guard, gate }));
  // 「是不是全權限」只有 isFullPermission 一個判斷點：這三支不再各自比對 'write'。
  const scattered = ['api.ts', 'executor.ts', 'runner-settle.ts'].filter(name => /mode\s*[!=]==\s*'write'/.test(source(name)));
  check('T11 取消、cleanup、執行器都透過 isFullPermission 判斷全權限', scattered.length === 0 && /isFullPermission\(record\.spec\) && record\.job && !await confirmWorkerGone/.test(loop), scattered);
}

/* ---- T12：舊日誌 replay ---- */
{
  const at = '2026-01-01T00:00:00.000Z';
  const legacy = [
    { type: 'created', contractDigest: 'd' }, { type: 'approved', contractDigest: 'd', kind: 'contract' }, { type: 'state', state: 'running' },
    { type: 'runner_started', pid: 1, versionId: 'v', token: 't' }, { type: 'baseline', git: null },
    { type: 'action_intent', action: { actionId: 'a1', kind: 'worker', stepId: 's1', model: 'm', prompt: 'p', marker: 'K-a1', mode: 'write' } },
    { type: 'action_started', actionId: 'a1', job: JOB }, { type: 'action_result', actionId: 'a1', outcome: OUTCOME },
    { type: 'state', state: 'cancelled', reason: 'user_cancelled' },
  ].map((event, index) => ({ ...event, seq: index + 1, at }));
  const replayed = replayJournal(legacy);
  const action = replayed.actions.get('a1');
  check('T12 舊日誌 replay 結果不變：狀態、原因、動作與計數照舊',
    replayed.state === 'cancelled' && replayed.reason === 'user_cancelled' && action?.processed === false && action.outcome?.ok === true && action.job?.jobId === 'job-w'
    && replayed.counters.workerSteps === 1 && replayed.counters.unknownUsage === 1 && replayed.runnerToken === 't' && replayed.lastSeq === legacy.length, replayed.state);
  check('T12 舊日誌裡這種動作會被 cleanup 的檢查涵蓋', fullPermissionRecords(replayed).length === 1 && unsettledFullPermission(replayed).length === 1);
  const processed = replayJournal([...legacy.slice(0, 8), { type: 'step_checked', actionId: 'a1', stepId: 's1', passed: true, findings: [], seq: 9, at }]);
  check('T12 判定落盤的全權限動作算結清，但 cleanup 仍會查', unsettledFullPermission(processed).length === 0 && fullPermissionRecords(processed).length === 1);
}

/* ---- 出口 #11：啟動後拿不到 jobId ---- */
{
  // 不會有程序用到的 pid：真的去查也只會得到「不存在」。service 只是 TypeScript 層的 private，這裡換成假的。
  const PID = 2147480777;
  const DECIDE = { actionId: 'a1', kind: 'decide', model: MODEL, prompt: 'p', marker: 'K-a1' };
  const identity = { pid: PID, started: '2026-01-01T00:00:00.0000000Z', name: 'node' };
  const startWith = async ({ killProcess, lookup }) => {
    const sent = [];
    const executor = new FileJobExecutor({ platform: 'linux', lookup, untrackedConfirmMs: 60, send: pid => sent.push(pid) });
    const killed = [];
    executor.service = { startProcess: async () => ({ pid: PID }), killProcess: async pid => { killed.push(pid); return killProcess(); } };
    return { executor, killed, sent, error: await rejecting(executor.start(DECIDE, { workFolder: REPO })) };
  };
  // 送出終止、也確認它不在了：單純的啟動失敗，沒有東西要追。
  const gone = await startWith({ killProcess: async () => ({ status: 'terminated' }), lookup: async () => new Map() });
  check('拿不到 jobId 且無身分時不盲殺，錯誤訊息帶 pid', gone.killed.length === 0 && gone.error?.message.includes(`pid ${PID}`), `${gone.killed} ${gone.error?.message}`);
  check('確認程序不在了，才算單純的啟動失敗（不留待查的身分）', !(gone.error instanceof KernelUntrackedStartError) && /已確認終止/.test(gone.error?.message ?? ''), gone.error?.message);
  // 終止失敗、程序還活著：不能只在訊息裡提一句，要留下可以重查的身分。
  let current = identity;
  const alive = await startWith({ killProcess: async () => { throw new Error('kill failed'); }, lookup: async () => new Map(current ? [[PID, current]] : []) });
  check('終止失敗而程序還活著：錯誤帶著 pid＋啟動時間，供之後重查', alive.error instanceof KernelUntrackedStartError && alive.error.job.pid === PID && alive.error.job.jobId === '' && alive.error.job.untracked?.started === identity.started, alive.error?.message);
  check('拿不到 jobId 的程序還活著時 isGone 為 false，說明帶 pid', await alive.executor.isGone(alive.error.job) === false && (await alive.executor.blockers(alive.error.job)).some(text => text.includes(String(PID))));
  await alive.executor.kill(alive.error.job);
  check('身分對得上時，kill 會對那個程序送終止', alive.sent.length === 2 && alive.sent.every(pid => pid === PID), alive.sent);
  // 查到那個 pid 上有程序，但當初沒記到啟動時間：分不出是不是它。不能當作消失，也不能對它送終止。
  const blank = { pid: PID, jobId: '', untracked: { started: '' } };
  check('查到程序但當初沒記到啟動時間：不能當作消失', await alive.executor.isGone(blank) === false);
  alive.sent.length = 0;
  await alive.executor.kill(blank);
  current = { ...identity, started: '2026-01-01T00:00:09.0000000Z' };
  check('那個 pid 換成別的程序（啟動時間不符）才算消失', await alive.executor.isGone(alive.error.job) === true);
  await alive.executor.kill(alive.error.job);
  check('查不出身分、或 pid 已經換人時不會被送終止', alive.sent.length === 0, alive.sent);
  // killProcess 說還在跑。
  current = identity;
  const running = await startWith({ killProcess: async () => ({ status: 'running' }), lookup: async () => new Map([[PID, identity]]) });
  check('終止後仍回報執行中：同樣留下待查的身分', running.error instanceof KernelUntrackedStartError && running.error.job.untracked?.started === identity.started);
  // pid 還在、卻查不到它的身分（身分查詢一無所獲）：不能當作消失。用測試自己的 pid 當「一定存在的 pid」；終止函式是假的，不會真的送出。
  const selfSent = [];
  const selfExecutor = new FileJobExecutor({ platform: 'linux', lookup: async () => new Map(), untrackedConfirmMs: 60, send: pid => selfSent.push(pid) });
  selfExecutor.service = { startProcess: async () => ({ pid: process.pid }), killProcess: async () => ({ status: 'terminated' }) };
  const unknown = await rejecting(selfExecutor.start(DECIDE, { workFolder: REPO }));
  check('pid 還在但查不出身分：留下待查紀錄，isGone 為 false', unknown instanceof KernelUntrackedStartError && unknown.job.untracked?.started === '' && await selfExecutor.isGone(unknown.job) === false);
  await selfExecutor.kill(unknown.job);
  check('pid 還在但查不出身分時不會被送終止', selfSent.length === 0, selfSent);
}

/* ---- 出口 #11 接到 loop：待查的身分記進日誌，擋住之後的關卡 ---- */
{
  const devRun = () => {
    const run = newDevRun();
    run.store.append({ type: 'decide_processed', actionId: 'a0', ok: true, decision: 'plan', plan: { planId: 'p1', steps: [{ id: 'p1-s1', title: 't', prompt: 'p', mode: 'write' }, { id: 'p1-s2', title: 'r', prompt: 'p' }], reportStep: 'p1-s2' } });
    run.store.append({ type: 'workspace_ready', head: run.spec.baseCommit });
    return run;
  };
  const workspace = run => ({ refs: () => [], inspect: () => ({ branch: run.spec.branch, head: run.spec.baseCommit, dirty: [], changed: [], ancestorOk: true }) });
  const UNTRACKED = { pid: 5151, jobId: '', untracked: { started: 's' } };
  const run = devRun();
  const executor = alive();
  executor.startError = action => action.kind === 'worker' ? new KernelUntrackedStartError('拿不到 jobId，終止未確認', UNTRACKED) : null;
  const state = await runKernelLoop(deps(run, executor, { workspace: workspace(run) }));
  const action = view(run.store).actions.get('a1');
  check('啟動後追不到又沒確認停掉的程序，身分記成這個動作的 job', action?.job?.pid === 5151 && action.job.untracked?.started === 's' && action.outcome?.failureClass === 'start_failed', action);
  check('那個程序還活著時 run 停在 stop_pending，不往下走', state === 'stop_pending' && view(run.store).reason === 'worker_still_alive' && view(run.store).detail?.includes('5151'), `${state} ${view(run.store).detail}`);
  // 對照：確定沒有程序的啟動失敗（普通的 Error）不留 job，照舊記成步驟失敗。
  const plain = devRun();
  const plainExecutor = new FakeExecutor();
  plainExecutor.startError = action => action.kind === 'worker' ? new Error('啟動失敗，已確認終止') : null;
  await runKernelLoop(deps(plain, plainExecutor, { workspace: workspace(plain) }));
  const failedAction = view(plain.store).actions.get('a1');
  check('對照：確定沒有程序的啟動失敗不留 job，照舊判成步驟失敗', !failedAction?.job && failedAction?.processed === true && view(plain.store).stepResults.get('p1-s1')?.failureClass === 'start_failed', failedAction);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
