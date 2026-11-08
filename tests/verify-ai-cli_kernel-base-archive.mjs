/** B：只用隔離 git fixtures、假 CLI 與注入 executor，不呼叫 vendor。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = process.argv.includes('--source');
const moduleUrl = name => pathToFileURL(join(ROOT, source ? 'src' : 'dist', 'ai-cli_kernel', `${name}.${source ? 'ts' : 'js'}`)).href;
const load = name => import(moduleUrl(name));
const stub = join(ROOT, 'tools/stubs', process.platform === 'win32' ? 'kernel-agent.cmd' : 'kernel-agent.mjs');
process.env.CODEX_CLI_NAME = stub; process.env.CLAUDE_CLI_NAME = stub; process.env.AI_CLI_KERNEL = 'on';
const api = await load('api');
const { RunStore, kernelRunDir, newRunId, listRunIds } = await load('journal');
const { buildContract } = await load('templates');
const { realWorkspace, aiCliKernelResolveBaseRef, aiCliKernelRepoIdentity } = await load('workspace');
const { runKernelCli, formatStatus } = await load('cli');
const { aiCliKernelHandleTool: mcp, aiCliKernelToolDefinitions } = await load('mcp-tools');
const { runKernelLoop } = await load('loop');
const { replayJournal } = await load('replay');
const temp = mkdtempSync(join(tmpdir(), 'kernel-base-archive-'));
let passed = 0, failed = 0;
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
};
function repo(name) {
  const folder = join(temp, name); mkdirSync(folder);
  git(folder, 'init', '-q'); git(folder, 'config', 'user.name', 'fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(folder, 'base.txt'), 'base\n'); git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'base');
  const base = git(folder, 'rev-parse', 'HEAD');
  writeFileSync(join(folder, 'main.txt'), 'main\n'); git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'main');
  git(folder, 'branch', 'topic', base);
  return { folder, base, head: git(folder, 'rev-parse', 'HEAD') };
}
async function check(name, fn) { try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`); } }
async function start(folder, input = {}) {
  const status = await api.aiCliKernelStart({ goal: 'B fixture', workFolder: folder, template: 'develop', testCommand: 'fixture-test', checkpoint: 'local', ...input });
  const store = new RunStore(kernelRunDir(status.runId)); return { status, store, contract: store.readContract() };
}
async function cli(args) {
  let out = '', err = ''; const code = await runKernelCli(args, { stdout: s => out += s, stderr: s => err += s }); return { code, out, err };
}
function restartCleanup(runId) {
  return spawnSync(process.execPath, [...(source ? ['--import', 'tsx'] : []), '--input-type=module', '-e',
    `import { aiCliKernelCleanup } from ${JSON.stringify(moduleUrl('api'))}; try { console.log(JSON.stringify(await aiCliKernelCleanup({runId:${JSON.stringify(runId)}}))); } catch(e) { console.error(e.message); process.exitCode=1; }`],
  { encoding: 'utf8', windowsHide: true, env: process.env, timeout: 60000 });
}
function approveFixture(run) {
  run.store.append({ type: 'approved', kind: 'contract', contractDigest: run.store.contractDigest() }); run.store.append({ type: 'state', state: 'running' });
}
function loopDeps(run, responses, calls) {
  const jobs = new Map();
  let iterations = 0;
  const read = run.store.read.bind(run.store);
  run.store.read = () => {
    if (++iterations > 150) throw new Error(`fake loop exceeded 150 reads; tail=${JSON.stringify(read().slice(-3).map(e => ({ type: e.type, reason: e.reason })))}`);
    return read();
  };
  return {
    store: run.store, contract: run.contract, workspace: realWorkspace,
    executor: {
      async start(action) { assert.ok(calls.length < 5); calls.push(action); const job = { jobId: `fake-${calls.length}`, pid: 99000 + calls.length }; jobs.set(job.jobId, action); return job; },
      async poll(job) { return { state: 'finished', result: { status: 'completed', exitCode: 0, message: responses(jobs.get(job.jobId)), rawTail: '', usage: { input: 10, cached: 0, output: 2 } } }; },
      async find() { return null; }, async kill() { return true; }, async isGone() { return true; },
    },
    quota: async () => 80, boundary: async () => assert.fail('develop 不跑探針'), agentFor: () => 'codex', versionId: () => 'fixture',
    snapshot: () => null, now: Date.now, sleep: () => new Promise(r => setImmediate(r)), pollMs: 1, killConfirmMs: 10, pid: process.pid,
  };
}

try {
  const r = repo('main'), other = repo('other');
  const sub = join(r.folder, 'sub'); mkdirSync(sub);
  const summaryRun = await start(r.folder, { goal: '😀'.repeat(120) });
  summaryRun.store.append({ type: 'decide_processed', actionId: 'archive-fixture', ok: true, decision: 'plan', memories: [{ id: 'large-memory', text: 'M'.repeat(250000) }], plan: { planId: 'p', steps: [{ id: 's', title: 'step', prompt: 'reference' }], reportStep: 's' } });
  summaryRun.store.append({ type: 'workspace_observed', head: r.head, changedFiles: ['base.txt'], commits: [r.base, r.head], complete: true });
  summaryRun.store.append({ type: 'state', state: 'failed', reason: 'fixture-failed' });
  const subRun = await start(sub), otherRun = await start(other.folder);
  await check('B1 摘要固定欄位、Unicode 前80字、記憶數量、大小與 show 完整包', async () => {
    const full = await api.aiCliKernelArchiveShow({ runId: summaryRun.store.runId });
    const row = (await api.aiCliKernelArchiveList()).find(p => p.runId === full.runId);
    assert.deepEqual(Object.keys(row).sort(), ['runId', 'state', 'reason', 'goal', 'repo', 'branch', 'latestCommit', 'evidence', 'candidateMemories'].sort());
    assert.equal(row.state, 'failed'); assert.equal(row.reason, 'fixture-failed'); assert.equal(row.goal, '😀'.repeat(80));
    assert.equal(row.repo, summaryRun.contract.develop.repoRoot); assert.equal(row.branch, summaryRun.contract.develop.branch); assert.equal(row.latestCommit, r.head);
    assert.deepEqual(row.evidence, { journalSeq: full.evidence.journalSeq, releaseEvents: full.evidence.releaseEvents });
    assert.equal(row.candidateMemories, 1); assert.ok(JSON.stringify(row).length < 1600); assert.ok(JSON.stringify(full).length > 250000);
    assert.equal(full.candidateMemories[0].text.length, 250000); assert.equal(full.steps[0].title, 'step'); assert.deepEqual(full.changedFiles, ['base.txt']);
    const shown = await cli(['archive', 'show', full.runId, '--json']); assert.equal(shown.code, 0); assert.deepEqual(JSON.parse(shown.out), full);
    assert.deepEqual(await mcp('ai-cli_kernel_archive_show', { runId: full.runId }), full);
  });
  await check('B1 repo／原始 workFolder／交集篩選；CLI MCP API 一致且不夾完整包', async () => {
    const inputs = [{ repo: r.folder }, { workFolder: sub }, { repo: r.folder, workFolder: sub }, { repo: other.folder, workFolder: sub }];
    for (const input of inputs) {
      const result = await api.aiCliKernelArchiveList(input);
      const args = ['archive', 'list', '--json', ...Object.entries(input).flatMap(([k, v]) => [k === 'repo' ? '--repo' : '--work-folder', v])];
      const output = await cli(args); assert.equal(output.code, 0, output.err);
      assert.deepEqual(JSON.parse(output.out), result); assert.deepEqual(await mcp('ai-cli_kernel_archive_list', input), result);
      assert.ok(output.out.length < 6000); assert.ok(!output.out.includes('MMMMMMMM')); assert.ok(result.every(p => !('steps' in p)));
    }
    const filtered = await api.aiCliKernelArchiveList({ repo: r.folder });
    assert.equal(filtered.length, 2); assert.ok(!filtered.some(p => p.runId === otherRun.store.runId));
    assert.deepEqual((await api.aiCliKernelArchiveList({ workFolder: sub })).map(p => p.runId), [subRun.store.runId]);
    const plain = await cli(['archive', 'list']); assert.match(plain.out, /^待歸檔 3 筆/); assert.match(plain.out, /journalSeq/); assert.ok(plain.out.length < 6000);
    const schema = aiCliKernelToolDefinitions().find(t => t.name === 'ai-cli_kernel_archive_list').inputSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), ['repo', 'workFolder']); assert.equal(schema.additionalProperties, false);
  });
  await check('B1 篩選驗證一致，拒絕空白／相對路徑／非字串／額外參數', async () => {
    for (const input of [{ repo: '' }, { workFolder: ' ' }, { repo: '.' }, { workFolder: 2 }, { repo: null }, { command: 'write' }, { repo: temp }, { workFolder: join(r.folder, 'base.txt') }]) {
      await assert.rejects(api.aiCliKernelArchiveList(input)); await assert.rejects(mcp('ai-cli_kernel_archive_list', input));
    }
    for (const args of [['--repo'], ['--work-folder'], ['--repo', '.'], ['--work-folder', ''], ['--command', 'write'], ['--repo', temp]]) assert.equal((await cli(['archive', 'list', ...args])).code, 1);
    const deleted = join(temp, 'no-longer-present'); assert.deepEqual(await api.aiCliKernelArchiveList({ workFolder: deleted }), []);
  });
  await check('B1 正常非 git run 只符合原始目錄篩選，不會混入 repo 結果', async () => {
    const plain = join(temp, 'plain'); mkdirSync(plain);
    const store = new RunStore(kernelRunDir(newRunId())); store.create(buildContract({ goal: 'non-git audit', workFolder: plain }));
    assert.ok(!(await api.aiCliKernelArchiveList({ repo: r.folder })).some(p => p.runId === store.runId));
    const rows = await api.aiCliKernelArchiveList({ workFolder: plain }); assert.equal(rows.length, 1); assert.equal(rows[0].runId, store.runId);
    assert.deepEqual(await mcp('ai-cli_kernel_archive_list', { workFolder: plain }), rows);
  });
  await check('B2 本地分支／完整 ref／完整與縮寫 commit，無效或非 commit 拒絕', async () => {
    for (const ref of ['topic', 'refs/heads/topic', r.base, r.base.slice(0, 12)]) assert.equal(aiCliKernelResolveBaseRef(r.folder, ref).commit, r.base);
    const tree = git(r.folder, 'rev-parse', 'HEAD^{tree}'), blob = git(r.folder, 'rev-parse', 'HEAD:base.txt');
    git(r.folder, 'tag', 'light-tag', r.base); git(r.folder, 'tag', '-am', 'annotated', 'annotated-tag', r.base); git(r.folder, 'tag', '0'.repeat(12), r.base);
    const tagObject = git(r.folder, 'rev-parse', 'annotated-tag');
    for (const ref of ['', ' ', '--help', '-c', 'topic\0x', 'topic\n', 'missing', 'HEAD~1', 'topic^{commit}', tree, blob, tagObject, 'light-tag', 'annotated-tag', '0'.repeat(12), '0'.repeat(40), 3, null]) assert.throws(() => aiCliKernelResolveBaseRef(r.folder, ref), undefined, String(ref));
    writeFileSync(join(other.folder, 'foreign.txt'), 'foreign\n'); git(other.folder, 'add', '.'); git(other.folder, 'commit', '-qm', 'foreign');
    assert.throws(() => aiCliKernelResolveBaseRef(r.folder, git(other.folder, 'rev-parse', 'HEAD')));
    await assert.rejects(api.aiCliKernelStart({ goal: 'readonly', workFolder: r.folder, baseRef: 'topic' }), /只有 develop/);
    assert.equal((await cli(['start', '--goal', 'bad', '--cwd', r.folder, '--base-ref', 'topic'])).code, 1);
    await assert.rejects(mcp('ai-cli_kernel_start', { goal: 'bad', workFolder: r.folder, template: 'develop', testCommand: 'fake', baseRef: 3 }));
  });
  const selected = await start(r.folder, { baseRef: 'topic' });
  await check('B2 委任書顯示輸入與解析 commit，worktree／回復點綁 commit，主目錄保持原樣', async () => {
    const spec = selected.contract.develop;
    assert.equal(spec.baseRef, 'topic'); assert.equal(spec.baseCommit, r.base); assert.equal(spec.baseRefRef, 'refs/heads/topic'); assert.equal(selected.contract.workFolder, r.folder);
    assert.match(formatStatus(selected.status), new RegExp(`topic → ${r.base}`));
    writeFileSync(join(r.folder, 'uncommitted.txt'), 'private main state\n');
    assert.equal(realWorkspace.checkpointSnapshot(spec), r.base);
    realWorkspace.prepare(spec); assert.equal(git(spec.worktree, 'rev-parse', 'HEAD'), r.base);
    assert.ok(!existsSync(join(spec.worktree, 'main.txt'))); assert.ok(!existsSync(join(spec.worktree, 'uncommitted.txt')));
    assert.equal(git(r.folder, 'rev-parse', 'HEAD'), r.head); assert.ok(existsSync(join(r.folder, 'uncommitted.txt')));
    const fromCli = await cli(['start', '--goal', 'cli', '--cwd', r.folder, '--template', 'develop', '--test', 'fake', '--base-ref', r.base, '--json']);
    assert.equal(fromCli.code, 0, fromCli.err); assert.equal(JSON.parse(fromCli.out).develop.baseCommit, r.base); assert.equal(JSON.parse(fromCli.out).develop.baseRef, r.base);
    const fromMcp = await mcp('ai-cli_kernel_start', { goal: 'mcp', workFolder: r.folder, template: 'develop', testCommand: 'fake', baseRef: 'topic' });
    assert.equal(fromMcp.develop.baseCommit, r.base); assert.equal(fromMcp.develop.baseRef, 'topic');
  });
  await check('B2 分支在首次 runner 前移動，ref 閘仍綁建立時 commit', async () => {
    const run = await start(r.folder, { baseRef: 'topic', checkpoint: 'off' }); approveFixture(run);
    git(r.folder, 'update-ref', 'refs/heads/topic', r.head);
    const calls = [];
    const response = a => a.kind === 'decide' ? JSON.stringify({ action: 'plan', steps: [{ id: 'w', title: 'write', mode: 'write', prompt: 'fixture' }] }) : assert.fail('漂移不得派 worker');
    assert.equal(await runKernelLoop(loopDeps(run, response, calls)), 'waiting_human');
    assert.equal(replayJournal(run.store.read()).reason, 'repo_refs_changed'); assert.ok(calls.every(a => a.kind === 'decide'));
    assert.equal(git(run.contract.develop.worktree, 'rev-parse', 'HEAD'), r.base); assert.equal(run.store.readContract().develop.baseCommit, r.base);
    git(r.folder, 'update-ref', 'refs/heads/topic', r.base);
  });
  await check('B2 執行中 ref 移動仍阻擋，未給 baseRef 的既有 ref 閘未放寬', async () => {
    for (const explicit of [true, false]) {
      const run = await start(r.folder, { ...(explicit ? { baseRef: 'topic' } : {}), checkpoint: 'off' }); approveFixture(run);
      const calls = [];
      const response = action => {
        assert.equal(action.kind, 'decide', 'ref 移動後不應派 worker');
        git(r.folder, 'update-ref', 'refs/heads/topic', r.head);
        return JSON.stringify({ action: 'plan', steps: [{ id: 'w', title: 'write', mode: 'write', prompt: 'fixture' }] });
      };
      assert.equal(await runKernelLoop(loopDeps(run, response, calls)), 'waiting_human');
      assert.equal(replayJournal(run.store.read()).reason, 'repo_refs_changed'); assert.equal(calls.length, 1);
      git(r.folder, 'update-ref', 'refs/heads/topic', r.base);
    }
    const checkpointBranch = 'ai-cli_kernel/checkpoints/selected-base'; git(r.folder, 'branch', checkpointBranch, r.base);
    const selectedCheckpoint = await start(r.folder, { baseRef: checkpointBranch });
    assert.ok(realWorkspace.refs(selectedCheckpoint.contract.develop).includes(`${r.base} refs/heads/${checkpointBranch}`));
  });
  await check('B2 相同 commit 的其他 ref、直接 commit、不同行政 repo 不誤認依賴', async () => {
    const parent = await start(r.folder); git(r.folder, 'branch', parent.contract.develop.branch, r.head);
    realWorkspace.prepare(parent.contract.develop);
    git(r.folder, 'branch', 'same-commit-alias', r.head);
    const alias = await start(r.folder, { baseRef: 'same-commit-alias' });
    const hash = await start(r.folder, { baseRef: r.head });
    git(other.folder, 'fetch', '--no-tags', r.folder, r.head);
    git(other.folder, 'branch', parent.contract.develop.branch, r.head);
    const foreign = await start(other.folder, { baseRef: parent.contract.develop.branch });
    assert.equal(foreign.contract.develop.baseCommit, parent.contract.develop.baseCommit);
    for (const run of [alias, hash, foreign]) assert.ok(!Object.hasOwn(run.contract.develop, 'dependsOnRunId'));
    const dependent = await start(r.folder, { baseRef: `refs/heads/${parent.contract.develop.branch}` });
    assert.equal(dependent.contract.develop.dependsOnRunId, parent.store.runId);
    parent.store.append({ type: 'state', state: 'completed' });
    for (const state of ['awaiting_approval', 'running', 'waiting_human', 'version_drift', 'needs_reconcile', 'stop_pending']) {
      dependent.store.append({ type: 'state', state });
      await assert.rejects(api.aiCliKernelCleanup({ runId: parent.store.runId }), e => e.message.includes(dependent.store.runId) && /依賴/.test(e.message));
    }
    const restarted = restartCleanup(parent.store.runId); assert.equal(restarted.status, 1, restarted.stdout); assert.match(restarted.stderr, new RegExp(dependent.store.runId));
    assert.equal(git(r.folder, 'show-ref', '--verify', '--hash', `refs/heads/${parent.contract.develop.branch}`), r.head);
    assert.ok(existsSync(join(parent.contract.develop.worktree, '.git')));
    dependent.store.append({ type: 'state', state: 'cancelled' });
    const freed = restartCleanup(parent.store.runId); assert.equal(freed.status, 0, freed.stderr); assert.equal(JSON.parse(freed.stdout).worktreeRemoved, true);
    assert.ok(!existsSync(parent.contract.develop.worktree));
    assert.equal(readFileSync(dependent.store.contractPath, 'utf8').includes(parent.store.runId), true);
  });
  await check('B2 依賴建立與 cleanup 共用來源短鎖，鎖內拒絕且不留下半份契約', async () => {
    const parent = await start(r.folder); git(r.folder, 'branch', parent.contract.develop.branch, r.head);
    parent.store.append({ type: 'state', state: 'completed' });
    const count = listRunIds().length; let creating, cleaning;
    parent.store.withReleaseLock(() => {
      creating = start(r.folder, { baseRef: parent.contract.develop.branch });
      cleaning = api.aiCliKernelCleanup({ runId: parent.store.runId });
    });
    await assert.rejects(creating, /鎖/); await assert.rejects(cleaning, /鎖/);
    assert.equal(listRunIds().length, count); assert.ok(!existsSync(join(parent.store.dir, 'release.lock')));
    const child = await start(r.folder, { baseRef: parent.contract.develop.branch });
    await assert.rejects(api.aiCliKernelCleanup({ runId: parent.store.runId }), new RegExp(child.store.runId));
  });
  await check('B2 所有終止狀態解除 cleanup；同 repo linked worktree 身分與篩選', async () => {
    for (const state of ['completed', 'failed', 'cancelled', 'budget_exhausted']) {
      const parent = await start(r.folder); git(r.folder, 'branch', parent.contract.develop.branch, r.base);
      const child = await start(r.folder, { baseRef: parent.contract.develop.branch });
      parent.store.append({ type: 'state', state: 'completed' }); child.store.append({ type: 'state', state });
      assert.equal((await api.aiCliKernelCleanup({ runId: parent.store.runId })).worktreeRemoved, true);
    }
    const linked = selected.contract.develop.worktree;
    assert.equal(aiCliKernelRepoIdentity(linked), aiCliKernelRepoIdentity(r.folder));
    assert.deepEqual(await api.aiCliKernelArchiveList({ repo: linked }), await api.aiCliKernelArchiveList({ repo: r.folder }));
    const parent = await start(r.folder); git(r.folder, 'branch', parent.contract.develop.branch, r.base);
    const child = await start(linked, { baseRef: parent.contract.develop.branch }); assert.equal(child.contract.develop.dependsOnRunId, parent.store.runId);
  });
  await check('B2 省略 baseRef 保留舊契約欄位、HEAD、prefix、dirty snapshot 與安全拒絕', async () => {
    const run = await start(sub); const spec = run.contract.develop;
    assert.equal(spec.baseCommit, r.head); assert.equal(spec.prefix, 'sub/'); assert.equal(run.contract.workFolder, sub);
    for (const key of ['baseRef', 'baseRefRef', 'dependsOnRunId']) assert.ok(!Object.hasOwn(spec, key));
    assert.ok(!formatStatus(run.status).includes('基準輸入'));
    const snapshot = realWorkspace.checkpointSnapshot(spec); assert.notEqual(snapshot, r.head);
    assert.match(git(r.folder, 'ls-tree', '--name-only', snapshot), /uncommitted.txt/);
    const context = { runId: newRunId(), worktree: join(temp, 'compat-wt') };
    const original = buildContract({ goal: 'same', workFolder: r.folder, template: 'develop', testCommand: 'fake' }, new Date(), context);
    assert.equal(original.develop.baseCommit, r.head);
    assert.throws(() => realWorkspace.restore({ ...spec, worktree: r.folder }), /repo 主目錄|linked worktree/);
    await assert.rejects(api.aiCliKernelCleanup({ runId: run.store.runId }), /還沒結束/);
  });
} finally {
  // 全部都是本測試建立的隨機暫存根目錄。
  rmSync(temp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
