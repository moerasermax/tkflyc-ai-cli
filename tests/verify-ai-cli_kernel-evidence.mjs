/** A：證據、引用及標籤。只用暫存 git repo、假 executor 與固定測試輸出。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandResult, jsonResult, approvalDiagnostic } from './helpers/kernel-e2e-diagnostics.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// --source 配合 node --import tsx，讓 worker 不必重建 dist 也能驗證相同測試。
const source = process.argv.includes('--source');
const load = name => import(pathToFileURL(join(ROOT, source ? 'src' : 'dist', 'ai-cli_kernel', `${name}.${source ? 'ts' : 'js'}`)).href);
const stub = join(ROOT, 'tools', 'stubs', process.platform === 'win32' ? 'kernel-agent.cmd' : 'kernel-agent.mjs');
process.env.CODEX_CLI_NAME = stub;
process.env.CLAUDE_CLI_NAME = stub;
const { parseNameStatusZ, isTestPath, changedBaselineTests, boundedList, boundedStat, segmentedDiff, testSummary, kernelTestInventory, STAT_CHARS, FILE_LIST_CHARS, TEST_SUMMARY_CHARS } = await load('evidence');
const { realWorkspace } = await load('workspace');
const { checkCitations } = await load('verdict');
const { buildContract } = await load('templates');
const { buildWorkerPrompt } = await load('plan');
const { hasProbeEvidenceFormat, probeResultLabel, judgeFinishedProbe, claudeInitEvent, NO_EVIDENCE_FORMAT_HINT, boundaryKey } = await load('probe');
const { RunStore, newRunId, kernelRunDir, kernelStateDir, releaseActiveLock } = await load('journal');
const { runKernelLoop } = await load('loop');
const { aiCliKernelStatus, aiCliKernelApprove } = await load('api');
const { aiCliKernelHandleTool } = await load('mcp-tools');
const { runKernelCli } = await load('cli');
const { replayJournal } = await load('replay');
const { parseDetail } = await load('dashboard-rules');
const { detailLines } = await load('dashboard-view');

let passed = 0, failed = 0;
async function check(name, fn) {
  if (process.env.KERNEL_EVIDENCE_TEST_FILTER && !name.includes(process.env.KERNEL_EVIDENCE_TEST_FILTER)) return;
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}\n  ${error.stack}`); }
}
const temp = mkdtempSync(join(tmpdir(), 'kernel-evidence-'));
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const put = (folder, path, text = 'one\ntwo\n') => { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), text); };
function repo(name) {
  const folder = join(temp, name); mkdirSync(folder);
  git(folder, 'init', '-q');
  git(folder, 'config', 'user.name', 'fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  git(folder, 'config', 'core.autocrlf', 'false');
  put(folder, 'README.md'); git(folder, 'add', '-A'); git(folder, 'commit', '-q', '-m', 'base');
  return folder;
}
try {
  await check('E2E approval diagnostics preserve process and parse failures with bounded redacted state evidence', () => {
    const runId = 'kr-20261109-000000-abcd';
    const folder = join(temp, 'diagnostics');
    const run = join(folder, 'kernel', 'runs', runId);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'runner.json'), JSON.stringify({ pid: 123, started: 'fixture', token: 'private-runner-token' }));
    writeFileSync(join(run, 'journal.jsonl'), `${JSON.stringify({ seq: 1, type: 'state', state: 'running', detail: 'private-prompt' })}\n{`);
    const secret = 'fixture-sensitive-value';
    const result = jsonResult(commandResult({ status: null, signal: 'SIGTERM', error: Object.assign(new Error(`spawn failed API_KEY=${secret}`), { code: 'ETIMEDOUT', syscall: 'spawnSync' }),
      stdout: `{"context":"private-context","state":"running"} trailing ${secret}`, stderr: `Bearer ${secret}\npassword=unconfigured-password\n${'x'.repeat(20000)}\nlast-line` }, 180001.4));
    const diagnostic = approvalDiagnostic(result, runId, folder, { TEST_API_KEY: secret });
    assert.equal(diagnostic.code, null); assert.equal(diagnostic.signal, 'SIGTERM'); assert.equal(diagnostic.elapsedMs, 180001);
    assert.equal(diagnostic.spawnError.code, 'ETIMEDOUT'); assert.equal(diagnostic.parseError.name, 'SyntaxError');
    assert.equal(diagnostic.runId, runId); assert.equal(diagnostic.snapshot['runner.json'].pid, 123);
    assert.equal(diagnostic.snapshot['launcher.json'].readError.code, 'ENOENT');
    assert.equal(diagnostic.snapshot.journal.events[0].state, 'running');
    assert.equal(diagnostic.snapshot.journal.events[1].parseError.name, 'SyntaxError');
    assert.equal(diagnostic.stderr.truncated, true); assert.ok(diagnostic.stderr.text.length < 2100); assert.match(diagnostic.stderr.text, /last-line$/);
    const rendered = JSON.stringify(diagnostic);
    for (const hidden of [secret, 'unconfigured-password', 'private-context', 'private-prompt', 'private-runner-token']) assert.ok(!rendered.includes(hidden), hidden);
    assert.ok(rendered.length < 12000);
    const valid = jsonResult(commandResult({ status: 1, stdout: JSON.stringify({ state: 'running', context: 'private-context' }), stderr: '' }, 12));
    const observed = approvalDiagnostic(valid, runId, folder, {});
    assert.equal(observed.code, 1); assert.equal(observed.parseError, null); assert.equal(observed.returnedStatus.state, 'running');
    assert.ok(!JSON.stringify(observed).includes('private-context')); // Later state never changes the original code.
    assert.equal(approvalDiagnostic(valid, '../escape', folder, {}).snapshot.readError, 'missing or invalid runId');
    writeFileSync(join(run, 'journal.jsonl'), `${'{}\n'.repeat(6000)}${JSON.stringify({ seq: 2, type: 'state', state: 'completed' })}\n`);
    const tail = approvalDiagnostic(valid, runId, folder, {}).snapshot.journal;
    assert.equal(tail.truncated, true); assert.equal(tail.events.length, 12); assert.equal(tail.events.at(-1).state, 'completed');
    assert.equal(valid.code, 1); assert.equal(valid.data.state, 'running');
    const malformed = jsonResult(commandResult({ status: 0, stdout: 'private-unquoted-payload', stderr: '' }, 1));
    const malformedView = approvalDiagnostic(malformed, runId, folder, {});
    assert.ok(!JSON.stringify(malformedView.parseError).includes('private-unquoted-payload'));
  });
  await check('A1 NUL 清單保留 rename、空白、tab 與換行', () => {
    assert.deepEqual(parseNameStatusZ('A\0space name.ts\0R095\0tests/old\tname.ts\0tests/new\nname.ts\0D\0gone.ts\0M\0:(glob)*.ts\0'), [
      { status: 'A', path: 'space name.ts' }, { status: 'R095', oldPath: 'tests/old\tname.ts', path: 'tests/new\nname.ts' },
      { status: 'D', path: 'gone.ts' }, { status: 'M', path: ':(glob)*.ts' },
    ]);
    assert.throws(() => parseNameStatusZ('R100\0old.ts\0'));
  });
  await check('A1 diff 額度不變、測試優先、逐檔標明全部或部分省略', () => {
    const changes = [{ status: 'M', path: 'src/first.ts' }, { status: 'R100', oldPath: 'tests/old.test.ts', path: 'tests/new.test.ts' }, { status: 'D', path: 'gone.ts' }];
    const reads = [];
    const result = segmentedDiff(changes, 'x'.repeat(200), 30, c => { reads.push(c.path); return c.path.includes('test') ? 'T'.repeat(40) : 'S'.repeat(50); });
    assert.equal(result.diff, 'T'.repeat(30));
    assert.deepEqual(reads, ['tests/new.test.ts']);
    assert.match(result.files, /R100 "tests\/old.test.ts" -> "tests\/new.test.ts" \[diff 部分省略\]/);
    assert.match(result.files, /"src\/first.ts" \[diff 全部省略\]/);
    assert.match(result.files, /"gone.ts" \[diff 全部省略\]/);
    assert.equal(segmentedDiff(changes, 'fits', 30, () => assert.fail('不應逐檔取 diff')).diff, 'fits');
    const partial = segmentedDiff(changes, 'x'.repeat(200), 60, c => c.path.includes('test') ? 'T'.repeat(40) : 'S'.repeat(50));
    assert.equal(partial.diff, 'T'.repeat(40) + 'S'.repeat(20));
  });
  await check('A1 stat／檔案清單／測試輸出有獨立上限及總數截斷提示', () => {
    const stat = boundedStat('s'.repeat(STAT_CHARS + 500));
    assert.equal(stat.length, STAT_CHARS); assert.match(stat, /共 8500 字元，截斷/);
    const list = boundedList(Array.from({ length: 200 }, (_, i) => `M ${i}${'p'.repeat(200)}`), FILE_LIST_CHARS, '檔案');
    assert.ok(list.length <= FILE_LIST_CHARS); assert.match(list, /共 200 項.*截斷/);
    const many = segmentedDiff(Array.from({ length: 5000 }, (_, i) => ({ status: 'M', path: `${i}.ts` })), 'x'.repeat(20001), 20000, () => 'x');
    assert.ok(many.files.length <= FILE_LIST_CHARS); assert.match(many.files, /共 5000 項.*截斷/);
    const summary = testSummary(`${'long\n'.repeat(2000)}3 passed, 2 failed\n`);
    assert.ok(summary.length <= TEST_SUMMARY_CHARS); assert.match(summary, /通過 3、失敗 2/); assert.match(summary, /截斷/);
  });
  await check('A1 只認完整結尾摘要；未知、矛盾、舊小計皆未解析', () => {
    assert.match(testSummary('PASS a\nexit 0'), /^未解析/);
    assert.match(testSummary('3 passed, 0 failed\nnow running more'), /^未解析/);
    assert.match(testSummary('共 5 支：PASS 3、FAIL 1，總耗時 1.0s'), /^未解析/);
    assert.match(testSummary(undefined), /^未解析/);
    assert.match(testSummary('共 5 支：PASS 3、FAIL 2，總耗時 1.0s\n'), /通過 3、失敗 2（測試腳本）/);
    assert.match(testSummary('# tests 5\n# suites 1\n# pass 3\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 9.1'), /通過 3、失敗 1/);
    for (const tail of [
      '# tests 6\n# suites 1\n# pass 3\n# fail 1\n# skipped 1\n# duration_ms 9.1',
      '# tests 5\n# suites 1\n# pass 3\n# fail 1\n# skipped 2\n# duration_ms 9.1',
      '# tests 9007199254740992\n# suites 1\n# pass 3\n# fail 1\n# duration_ms 9.1',
    ]) assert.match(testSummary(tail), /^未解析/, tail);
    assert.match(testSummary('# tests 5\r\n# suites 1\r\n# pass 1\r\n# fail 1\r\n# cancelled 1\r\n# skipped 1\r\n# todo 1\r\n# duration_ms 9.1'), /通過 1、失敗 1/);
  });
  await check('F4 TAP optional counters appear once in Node order', () => {
    const prefix = '# tests 5\n# suites 1\n# pass 2\n# fail 1';
    const summary = counters => testSummary(`${prefix}${counters}\n# duration_ms 9.1`);
    for (const counters of ['\n# cancelled 1\n# skipped 1\n# todo 0', '\n# cancelled 2', '\n# skipped 2', '\n# todo 2', '\n# cancelled 1\n# todo 1']) {
      assert.match(summary(counters), /^通過 2、失敗 1/);
      assert.match(testSummary(`${prefix}${counters}\n# duration_ms 9.1`.replaceAll('\n', '\r\n')), /^通過 2、失敗 1/);
    }
    // All malformed examples still sum to tests=5; counting alone cannot reject them.
    for (const counters of [
      '\n# cancelled 1\n# cancelled 1', '\n# skipped 1\n# skipped 1', '\n# todo 1\n# todo 1',
      '\n# skipped 1\n# cancelled 1', '\n# todo 1\n# skipped 1', '\n# todo 1\n# cancelled 1',
      '\n# cancelled 0\n# skipped 1\n# todo 1\n# todo 0',
    ]) assert.match(summary(counters), /^未解析/, counters);
    assert.match(testSummary('# tests 3\n# suites 1\n# pass 2\n# fail 1\n# duration_ms 9.1'), /^通過 2、失敗 1/);
  });
  await check('A4 測試規則、來源 rename、排除新增與非測試', () => {
    for (const path of ['test/a.ts', 'a/tests/b.ts', '__tests__/a.ts', 'spec/c.ts', 'a.test.js', 'a.spec.ts', 'test_x.py', 'x_test.go']) assert.ok(isTestPath(path), path);
    for (const path of ['src/contest/a.ts', 'tests.ts', 'specimen/a.ts', 'test_x.ts', 'latest.js']) assert.ok(!isTestPath(path), path);
    const changes = [
      { status: 'M', path: 'tests/a.ts' }, { status: 'D', path: 'a.test.ts' }, { status: 'R100', oldPath: 'spec/old.ts', path: 'src/new.ts' },
      { status: 'A', path: 'tests/new.ts' }, { status: 'R100', oldPath: 'src/plain.ts', path: 'tests/moved.ts' }, { status: 'M', path: 'src/a.ts' },
    ];
    assert.deepEqual(changedBaselineTests(changes), changes.slice(0, 3));
    assert.match(kernelTestInventory([]), /共 0 個.*\n無\n/);
  });

  const tracked = repo('paths');
  put(tracked, 'src/deep/unique.ts');
  put(tracked, 'src/deep/中文.ts');
  for (let i = 0; i < 10; i++) put(tracked, `src/d${i}/same.ts`);
  put(tracked, 'ignored/untracked.ts');
  git(tracked, 'add', 'src'); git(tracked, 'commit', '-q', '-m', 'citations');
  await check('A2 唯一 git basename 候選可解析，保留所有行號與大小檢查', () => {
    assert.equal(checkCitations('unique.ts:2', tracked, 1).resolved, 1);
    assert.equal(checkCitations('中文.ts:2', tracked, 1).resolved, 1);
    assert.equal(checkCitations('錯誤unique.ts:2', tracked, 1).resolved, 1);
    for (const ref of ['unique.ts:0', 'unique.ts:99', 'unique.ts:2-1']) assert.ok(!checkCitations(ref, tracked, 1).passed, ref);
    put(tracked, 'src/deep/unique.ts', 'x'.repeat(20 * 1024 * 1024 + 1));
    assert.match(checkCitations('unique.ts:1', tracked, 1).findings.join(), /檔案太大/);
    put(tracked, 'src/deep/unique.ts');
    assert.ok(!checkCitations('untracked.ts:1', tracked, 1).passed);
  });
  await check('A2 多候選最多列 8 條，總數與截斷資訊供 decide 修正', () => {
    const result = checkCitations('same.ts:1', tracked, 1);
    assert.ok(!result.passed); assert.equal(result.resolved, 0);
    const detail = result.findings.find(f => f.includes('候選'));
    assert.match(detail, /10 個候選，列出 8 個，截斷 2 個/);
    assert.equal((detail.match(/"src\/d\d\/same.ts"/g) ?? []).length, 8);
    assert.ok(checkCitations('src/d9/same.ts:1', tracked, 1).passed);
  });
  await check('A2 非 repo 不掃描子目錄、repo 子目錄不越界找候選', () => {
    const plain = join(temp, 'plain'); put(plain, 'nested/only.ts');
    assert.ok(!checkCitations('only.ts:1', plain, 1).passed);
    assert.ok(checkCitations('nested/only.ts:1', plain, 1).passed);
    assert.ok(!checkCitations('same.ts:1', join(tracked, 'src/deep'), 1).passed);
    assert.ok(checkCitations('src/d9/same.ts:1', join(tracked, 'src'), 1).passed);
    assert.ok(!checkCitations('src/d9/same.ts:1', join(tracked, 'src/deep'), 1).passed);
    assert.match(checkCitations('same.ts:1', join(tracked, 'src'), 1).findings.join(), /"src\/d0\/same.ts"/);
  });
  await check('A2 相對／絕對逃逸不能經 basename 修正；junction 不能跳出工作目錄', () => {
    for (const ref of ['../unique.ts:1', '../../unique.ts:1', '/src/deep/unique.ts:1', 'C:/src/deep/unique.ts:1', 'C:\\src\\deep\\unique.ts:1']) {
      const r = checkCitations(ref, tracked, 1); assert.ok(!r.passed, ref); assert.match(r.findings.join(), /超出工作目錄/);
    }
    const external = join(temp, 'external'); put(external, 'jump.ts');
    symlinkSync(external, join(tracked, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    git(tracked, 'add', 'link');
    assert.ok(!checkCitations('link/jump.ts:1', tracked, 1).passed);
    assert.ok(!checkCitations('jump.ts:1', tracked, 1).passed);
    assert.ok(checkCitations('src/deep/unique.ts:1-2', tracked, 1).passed);
  });

  const changed = repo('changes');
  put(changed, 'tests/old name.test.ts', 'rename preserved\n'.repeat(50));
  put(changed, 'spec/deleted.ts', 'only in deleted test\n'); put(changed, 'test/changed.ts'); put(changed, 'kept.test.ts');
  git(changed, 'add', '-A'); git(changed, 'commit', '-q', '-m', 'existing tests');
  const baseCommit = git(changed, 'rev-parse', 'HEAD').trim();
  renameSync(join(changed, 'tests/old name.test.ts'), join(changed, 'tests/new name.test.ts'));
  rmSync(join(changed, 'spec/deleted.ts')); put(changed, 'test/changed.ts', 'assertion changed\n');
  put(changed, 'tests/new.test.ts', 'new test content\n'); put(changed, 'space & [x].txt', 'special path content\n'); put(changed, 'src/large.ts', 'const x = 0;\n'.repeat(2500));
  if (process.platform !== 'win32') put(changed, 'tests/quote"tab\tline\n.test.ts');
  git(changed, 'add', '-A'); git(changed, 'commit', '-q', '-m', 'delivery');
  const spec = { worktree: changed, baseCommit };
  const evidence = realWorkspace.reviewEvidence(spec, 20000);
  await check('A1/A4 真 git 證據含完整狀態、rename 路徑、獨立 stat 與基準測試清單', () => {
    assert.ok(evidence.diff.length <= 20000); assert.match(evidence.stat, /files changed/);
    assert.match(evidence.files, /R100 "tests\/old name.test.ts" -> "tests\/new name.test.ts"/);
    assert.match(evidence.files, /A "space & \[x\].txt"/);
    assert.match(evidence.files, /D "spec\/deleted.ts"/);
    assert.match(evidence.files, /M "test\/changed.ts"/);
    assert.match(evidence.files, /部分省略/);
    assert.ok(evidence.diff.includes('special path content'));
    assert.ok(evidence.diff.includes('rename from tests/old name.test.ts'));
    assert.deepEqual(evidence.baselineTests.map(c => c.oldPath ?? c.path).sort(), ['spec/deleted.ts', 'test/changed.ts', 'tests/old name.test.ts']);
    assert.ok(!evidence.baselineTests.some(c => c.path === 'tests/new.test.ts' || c.path === 'kept.test.ts'));
    assert.equal(realWorkspace.diffText(spec, 20000), evidence.diff);
  });

  const context = { runId: newRunId(), worktree: join(temp, 'unused-wt') };
  const contract = buildContract({ goal: 'evidence', workFolder: changed, template: 'develop', testCommand: 'fixture', checkpoint: 'off' }, new Date(), context);
  await check('A1/A2/A4 review 和 report 都含 kernel 證據；未解析不冒稱數量', () => {
    for (const report of [false, true]) {
      const prompt = buildWorkerPrompt(contract, { id: 'r', mode: 'read', title: 'review', prompt: 'check' }, 'K-test', report, { ...evidence, verification: { commit: 'abcdef', passed: true, tail: 'unknown output' } });
      for (const fragment of [evidence.stat, evidence.files, '未解析', '基準測試變更', 'tests/old name.test.ts', '沒有 shell']) assert.ok(prompt.includes(fragment), fragment);
      if (report) { assert.match(prompt, /從 repo 根目錄算起的完整相對路徑:行號/); assert.match(prompt, /為了讓既有測試通過而改動的斷言/); }
    }
  });
  await check('A3 單一 worker 模型提示沒有第二模型；多模型不冒稱單模型', () => {
    const notice = '驗收只代表 worker 寫的測試和既有測試通過，沒有第二個模型檢查';
    assert.ok(contract.develop.notices.includes(notice));
    const multi = buildContract({ goal: 'models', workFolder: changed, template: 'develop', testCommand: 'fixture', checkpoint: 'off', workerModels: ['grok-4.7'] }, new Date(), context);
    assert.ok(!multi.develop.notices.includes(notice));
    assert.ok(multi.develop.notices.some(n => n.includes('這家 CLI 還沒有探針證據格式')));
  });
  await check('A5 缺少格式與已支援格式的 FAIL/UNKNOWN 標籤不同（grok 沒有格式，codex／claude 有）', () => {
    assert.ok(hasProbeEvidenceFormat('codex')); assert.ok(hasProbeEvidenceFormat('claude')); assert.ok(!hasProbeEvidenceFormat('grok'));
    assert.match(probeResultLabel('grok', 'UNKNOWN'), /這家 CLI 還沒有探針證據格式/);
    assert.match(probeResultLabel('codex', 'FAIL'), /探針未通過或結果不明（FAIL）/);
    assert.match(probeResultLabel('codex', 'UNKNOWN'), /探針未通過或結果不明（UNKNOWN）/);
    assert.match(probeResultLabel('grok', 'FAIL'), /探針跑了但沒通過/);
    assert.match(probeResultLabel('codex', 'PASS'), /工具受限，非隔離/);
    assert.match(probeResultLabel('claude', 'PASS'), /工具受限，非隔離/);
    assert.match(probeResultLabel('claude', 'UNKNOWN'), /探針未通過或結果不明（UNKNOWN）/);
  });

  // K2：Claude 的證據是 stream-json 第一筆頂層 system/init。欄位照實測形狀合成，不含任何真實路徑。
  const allAbsent = { 'probe-write.txt': 'absent', 'probe-shell.txt': 'absent', 'probe-node.txt': 'absent', 'outside-fixture.txt': 'absent' };
  const claudeInit = (tools, mcpServers = []) => JSON.stringify({ type: 'system', subtype: 'init', cwd: 'fixture', session_id: 'fixture', tools, mcp_servers: mcpServers, model: 'fixture-model', permissionMode: 'default' });
  const assistantText = text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const claudeResult = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PROBE_DONE', permission_denials: [] });
  const claudeStream = (...lines) => `${lines.join('\n')}\n`;
  const judgeClaude = (stdout, overrides = {}) => {
    const reads = [];
    const judged = judgeFinishedProbe('claude', { seen: allAbsent, status: 'completed', exitCode: 0, ...overrides, log: (stream, from) => { reads.push(`${stream}:${from}`); return stream === 'stdout' ? stdout : ''; } });
    return { ...judged, reads };
  };
  await check('K2 Claude init 只有 Read／Glob／Grep、沒有 MCP、檔案都不在 → PASS，evidence 是 tools 原文', () => {
    const r = judgeClaude(claudeStream(claudeInit(['Glob', 'Grep', 'Read']), assistantText('寫入工具不存在。PROBE_DONE'), claudeResult));
    assert.equal(r.status, 'PASS'); assert.equal(r.evidence, '["Glob","Grep","Read"]'); assert.ok(!r.noAttempt);
    assert.deepEqual(r.reads, ['stdout:head']);
    assert.equal(judgeClaude(claudeStream(claudeInit(['Read']), claudeResult)).status, 'PASS');
    assert.equal(judgeClaude(claudeStream(claudeInit([]), claudeResult)).status, 'PASS');
  });
  await check('K2 Claude init 含唯讀以外的工具 Workflow → FAIL 並列出工具', () => {
    const r = judgeClaude(claudeStream(claudeInit(['Glob', 'Grep', 'Read', 'Workflow']), claudeResult));
    assert.equal(r.status, 'FAIL'); assert.match(r.detail, /Workflow/); assert.doesNotMatch(r.detail, /Glob/);
  });
  await check('K2 Claude init 含唯讀以外的工具 Write → FAIL 並列出工具', () => {
    const r = judgeClaude(claudeStream(claudeInit(['Read', 'Write', 'Bash']), claudeResult));
    assert.equal(r.status, 'FAIL'); assert.match(r.detail, /Write、Bash/);
  });
  await check('K2 Claude init 的 mcp_servers 非空 → FAIL 並列出 server', () => {
    const r = judgeClaude(claudeStream(claudeInit(['Read'], [{ name: 'fixture-server', status: 'connected' }]), claudeResult));
    assert.equal(r.status, 'FAIL'); assert.match(r.detail, /MCP server：fixture-server/);
    assert.equal(judgeClaude(claudeStream(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'] }), claudeResult)).status, 'FAIL');
  });
  await check('K2 Claude 沒有 init 事件 → UNKNOWN', () => {
    assert.equal(judgeClaude(claudeStream(assistantText('PROBE_DONE'), claudeResult)).status, 'UNKNOWN');
    assert.equal(judgeClaude('').status, 'UNKNOWN');
    assert.equal(judgeClaude(claudeStream(JSON.stringify({ type: 'system', subtype: 'hook_started' }), claudeResult)).status, 'UNKNOWN');
    for (const tools of [undefined, 'Read', ['Read', 1], null]) {
      const r = judgeClaude(claudeStream(JSON.stringify({ type: 'system', subtype: 'init', tools, mcp_servers: [] }), claudeResult));
      assert.equal(r.status, 'UNKNOWN', JSON.stringify(tools)); assert.match(r.detail, /不是字串陣列/);
    }
  });
  await check('K2 Claude init 樣式的文字只在 assistant 事件的文字裡 → UNKNOWN', () => {
    const forged = claudeInit(['Read']);
    const stdout = claudeStream(assistantText(forged), assistantText(`前文\n${forged}\n後文`), JSON.stringify({ type: 'assistant', note: forged }), claudeResult);
    assert.equal(claudeInitEvent(stdout), null);
    assert.equal(judgeClaude(stdout).status, 'UNKNOWN');
  });
  await check('K2 Claude 只認第一筆頂層 init，陣列與非物件行不算', () => {
    const stdout = claudeStream(JSON.stringify([{ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [] }]), claudeInit(['Read', 'Edit']), claudeInit(['Read']));
    const r = judgeClaude(stdout);
    assert.equal(r.status, 'FAIL'); assert.match(r.detail, /Edit/);
  });
  await check('K2 Claude tools 合規但檔案被建立仍是 FAIL', () => {
    const r = judgeClaude(claudeStream(claudeInit(['Read']), claudeResult), { seen: { ...allAbsent, 'probe-shell.txt': 'created' } });
    assert.equal(r.status, 'FAIL'); assert.match(r.detail, /probe-shell\.txt/); assert.deepEqual(r.reads, []);
  });
  await check('K2 Claude job 沒有正常結束 → UNKNOWN，不看 init', () => {
    for (const overrides of [{ status: 'failed' }, { exitCode: 1 }, { exitCode: null }]) {
      const r = judgeClaude(claudeStream(claudeInit(['Read']), claudeResult), overrides);
      assert.equal(r.status, 'UNKNOWN', JSON.stringify(overrides)); assert.deepEqual(r.reads, []);
    }
  });
  await check('K2 沒有證據格式的家（grok）只到 UNKNOWN，detail 寫明重跑不會變與兩個放行旗標', () => {
    const r = judgeFinishedProbe('grok', { seen: allAbsent, status: 'completed', exitCode: 0, log: () => assert.fail('沒有格式就不讀輸出') });
    assert.equal(r.status, 'UNKNOWN'); assert.ok(!r.noAttempt);
    assert.ok(r.detail.includes(NO_EVIDENCE_FORMAT_HINT));
    for (const fragment of ['最多到 UNKNOWN', '重跑不會變', 'allowUnverifiedBoundary', 'acknowledgeUnverifiedBoundary']) assert.ok(r.detail.includes(fragment), fragment);
    const ended = judgeFinishedProbe('grok', { seen: allAbsent, status: 'failed', exitCode: 1, log: () => '' });
    assert.ok(ended.detail.includes(NO_EVIDENCE_FORMAT_HINT));
    assert.equal(judgeFinishedProbe('grok', { seen: { ...allAbsent, 'probe-node.txt': 'created' }, status: 'completed', exitCode: 0, log: () => '' }).status, 'FAIL');
    assert.ok(!judgeClaude(claudeStream(assistantText('PROBE_DONE'))).detail.includes(NO_EVIDENCE_FORMAT_HINT));
  });
  await check('K2 Codex 判定照舊：拒絕紀錄齊全才 PASS，對不上是 noAttempt', () => {
    const codexSeen = { 'probe-write.txt': 'absent', 'probe-shell.txt': 'absent', 'probe-node.txt': 'absent', 'outside-x.txt': 'absent' };
    const stderr = [
      'codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox',
      "codex_core::tools::router: error=exec_command failed: 'x' > probe-shell.txt rejected: blocked by policy",
      "codex_core::tools::router: error=exec_command failed: node -e probe-node.txt rejected: blocked by policy",
      "codex_core::tools::router: error=exec_command failed: 'x' > ../outside-x.txt rejected: blocked by policy",
    ].join('\n');
    const pass = judgeFinishedProbe('codex', { seen: codexSeen, status: 'completed', exitCode: 0, log: (stream, from) => { assert.equal(from, 'tail'); return stream === 'stderr' ? stderr : ''; } });
    assert.equal(pass.status, 'PASS'); assert.match(pass.detail, /共 4 筆/);
    const none = judgeFinishedProbe('codex', { seen: codexSeen, status: 'completed', exitCode: 0, log: () => claudeStream(claudeInit(['Read'])) });
    assert.equal(none.status, 'UNKNOWN'); assert.equal(none.noAttempt, true);
  });

  await check('A4 驗收後 kernel 強制附加基準清單、略新段落不增驗收條件、重跑不重複', async () => {
    const folder = repo('integration'); put(folder, 'tests/existing.test.ts');
    git(folder, 'add', '-A'); git(folder, 'commit', '-q', '-m', 'existing test');
    const runId = newRunId(); const store = new RunStore(kernelRunDir(runId));
    const c = buildContract({ goal: 'fake integration', workFolder: folder, template: 'develop', checkpoint: 'off', testCommand: 'node -e "console.log(\'3 passed, 0 failed\')"' }, new Date(), { runId, worktree: join(store.dir, 'wt') });
    const digest = store.create(c);
    store.append({ type: 'approved', contractDigest: digest, kind: 'contract' }); store.append({ type: 'state', state: 'running' });
    const plan = JSON.stringify({ action: 'plan', steps: [{ id: 'w', title: 'write', mode: 'write', prompt: 'write' }, { id: 'r', title: 'review', mode: 'read', prompt: 'review' }, { id: 'p', title: 'report', mode: 'read', prompt: 'report' }], report_step: 'p' });
    const calls = []; const jobs = new Map();
    const ok = message => ({ status: 'completed', exitCode: 0, message, rawTail: '', usage: { input: 10, cached: 0, output: 5 } });
    const executor = {
      async start(action) { calls.push(action); const job = { jobId: `fixture-${calls.length}`, pid: 90000 + calls.length }; jobs.set(job.jobId, action); return job; },
      async poll(job) {
        assert.ok(calls.length <= 8, 'fake run must finish');
        const action = jobs.get(job.jobId); let message = '已完成。';
        if (action.kind === 'decide') message = plan;
        else if (action.mode === 'write') put(action.cwd, 'tests/existing.test.ts', 'updated assertion\n');
        else {
          assert.match(action.prompt, /通過 3、失敗 0/); assert.match(action.prompt, /M "tests\/existing.test.ts"/);
          message = '## 結論\n已完成變更，測試由 kernel 親自執行通過，保留原本的驗收條件。\n## 改動\n更新既有測試。\n## 尚待確認\n無\n';
        }
        return { state: 'finished', result: ok(message) };
      },
      async find() { return null; }, async kill() { return true; }, async isGone() { return true; },
    };
    const deps = { store, contract: c, executor, workspace: realWorkspace, boundary: async () => assert.fail('develop 不跑探針'), quota: async () => 80, agentFor: () => 'codex', versionId: () => 'fixture', snapshot: () => null, now: Date.now, sleep: () => new Promise(r => setImmediate(r)), pollMs: 1, killConfirmMs: 20, pid: process.pid };
    const writeVerdict = store.writeVerdict.bind(store);
    store.writeVerdict = () => { throw new Error('fixture crash after report'); };
    await assert.rejects(runKernelLoop(deps), /fixture crash after report/);
    assert.equal((readFileSync(store.reportPath, 'utf8').match(/## kernel 統計/g) ?? []).length, 1);
    store.writeVerdict = writeVerdict;
    assert.equal(await runKernelLoop(deps), 'completed');
    const report = readFileSync(store.reportPath, 'utf8');
    assert.match(report, /## kernel 統計\n基準已存在.*共 1 個/);
    assert.match(report, /- M "tests\/existing.test.ts"/);
    assert.equal((report.match(/## kernel 統計/g) ?? []).length, 1);
    assert.equal(await runKernelLoop(deps), 'completed'); assert.equal(readFileSync(store.reportPath, 'utf8'), report);
    assert.equal(calls.filter(a => a.kind === 'worker').length, 3);
  });

  await check('A5 status boundaryLabel 經 dashboard 顯示兩種原因（使用假 CLI）', async () => {
    for (const model of ['grok-4.7', 'gpt-6.1-sol']) {
      const c = buildContract({ goal: 'labels', workFolder: changed, model });
      const store = new RunStore(kernelRunDir(newRunId())); store.create(c);
      const status = await aiCliKernelStatus({ runId: store.runId });
      const expected = model === 'grok-4.7' ? /這家 CLI 還沒有探針證據格式/ : /探針未通過或結果不明/;
      assert.match(status.boundaryLabel, expected);
      const detail = parseDetail(status);
      assert.match(detailLines(detail, 180).join('\n'), expected);
    }
  });

  // K3：核准時的 acknowledgeUnverifiedBoundary。只放行 UNKNOWN（沒有證據），FAIL 一律擋；沒傳旗標時行為不變。
  // 探針結果直接寫進隔離的狀態目錄，codex 指向假 CLI；approve 的 launch 與額度都用替身，不會啟動 runner 或模型。
  const k3Folder = repo('k3-boundary');
  const k3Quota = async () => 80;
  const k3ProbeFile = () => join(kernelStateDir(), 'probes', `${boundaryKey('codex').key}.json`);
  const k3SetProbe = status => {
    mkdirSync(join(kernelStateDir(), 'probes'), { recursive: true });
    if (status) writeFileSync(k3ProbeFile(), JSON.stringify({ key: boundaryKey('codex').key, status, at: new Date().toISOString() }));
    else rmSync(k3ProbeFile(), { force: true });
  };
  const k3Awaiting = () => { const store = new RunStore(kernelRunDir(newRunId())); store.create(buildContract({ goal: 'K3 approve', workFolder: k3Folder })); return store; };
  const k3Approvals = store => store.read().filter(event => event.type === 'approved');
  const k3Done = async store => { store.append({ type: 'state', state: 'cancelled' }); await releaseActiveLock(store.runId); };
  const k3NoLaunch = async () => assert.fail('不該啟動 runner');
  await check('K3 UNKNOWN 不帶旗標：核准照舊被拒；PASS 不帶旗標照常開工、不記同意', async () => {
    k3SetProbe(null);
    const store = k3Awaiting();
    await assert.rejects(aiCliKernelApprove({ runId: store.runId }, { quota: k3Quota, launch: k3NoLaunch }), /探針結果是 UNKNOWN/);
    assert.equal(k3Approvals(store).length, 0);
    k3SetProbe('PASS');
    const pass = k3Awaiting(); let launches = 0;
    try {
      const status = await aiCliKernelApprove({ runId: pass.runId }, { quota: k3Quota, launch: async () => { launches++; } });
      assert.equal(launches, 1); assert.equal(status.state, 'running');
      assert.equal(k3Approvals(pass)[0].overrides, undefined);
      assert.doesNotMatch(status.boundaryLabel, /使用者核准時明確同意/);
    } finally { await k3Done(pass); k3SetProbe(null); }
  });
  await check('K3 UNKNOWN 加旗標：可以開工，approved 記 boundary_unverified，委任書 digest 不變', async () => {
    k3SetProbe(null);
    const store = k3Awaiting(); const digest = store.contractDigest(); let launches = 0;
    try {
      const status = await aiCliKernelApprove({ runId: store.runId, acknowledgeUnverifiedBoundary: true }, { quota: k3Quota, launch: async () => { launches++; } });
      assert.equal(launches, 1); assert.equal(status.state, 'running');
      const approved = k3Approvals(store);
      assert.equal(approved.length, 1); assert.deepEqual(approved[0].overrides, ['boundary_unverified']);
      assert.equal(approved[0].contractDigest, digest); assert.equal(store.contractDigest(), digest);
      assert.ok(replayJournal(store.read()).overrides.has('boundary_unverified'));
      assert.match(status.boundaryLabel, /未驗證（使用者核准時明確同意）/);
    } finally { await k3Done(store); }
  });
  // 斷言名稱不放「FAIL 」（FAIL 加空白）：突變 harness 會把含這段字的 PASS 行也當成失敗行，判不出是誰抓到的。
  await check('K3 探針結果FAIL＋旗標：核准委任書與接回停下的 run 都被拒，不記核准', async () => {
    k3SetProbe('FAIL');
    try {
      const store = k3Awaiting();
      await assert.rejects(aiCliKernelApprove({ runId: store.runId, acknowledgeUnverifiedBoundary: true }, { quota: k3Quota, launch: k3NoLaunch }), /不放行 FAIL/);
      assert.equal(k3Approvals(store).length, 0);
      const paused = k3Awaiting();
      paused.append({ type: 'approved', contractDigest: paused.contractDigest(), kind: 'contract' });
      paused.append({ type: 'state', state: 'waiting_human', reason: 'boundary_unverified', detail: 'fixture' });
      await assert.rejects(aiCliKernelApprove({ runId: paused.runId, acknowledgeUnverifiedBoundary: true }, { quota: k3Quota, launch: k3NoLaunch }), /不放行 FAIL/);
      assert.equal(k3Approvals(paused).length, 1);
    } finally { k3SetProbe(null); }
  });
  await check('K3 CLI 與 MCP 都把核准旗標傳進 approve；MCP schema 只多這個布林參數', async () => {
    k3SetProbe('FAIL');
    const previous = process.env.AI_CLI_KERNEL;
    try {
      const store = k3Awaiting();
      let err = '';
      const io = { stdout: () => {}, stderr: text => { err += text; } };
      assert.equal(await runKernelCli(['approve', store.runId, '--acknowledge-unverified-boundary'], io), 1);
      assert.match(err, /不放行 FAIL/);
      err = '';
      assert.equal(await runKernelCli(['approve', store.runId], io), 1);
      assert.match(err, /探針結果是 FAIL。請先執行/); assert.doesNotMatch(err, /不放行 FAIL/);
      process.env.AI_CLI_KERNEL = 'on';
      await assert.rejects(aiCliKernelHandleTool('ai-cli_kernel_approve', { runId: store.runId, acknowledgeUnverifiedBoundary: true }), /不放行 FAIL/);
      assert.equal(k3Approvals(store).length, 0);
      const { aiCliKernelToolDefinitions } = await load('mcp-tools');
      const props = aiCliKernelToolDefinitions().find(tool => tool.name === 'ai-cli_kernel_approve').inputSchema.properties;
      assert.deepEqual(Object.keys(props).sort(), ['acknowledgeUnisolated', 'acknowledgeUnverifiedBoundary', 'note', 'reconcile', 'runId']);
      assert.equal(props.acknowledgeUnverifiedBoundary.type, 'boolean');
      assert.match(props.acknowledgeUnverifiedBoundary.description, /FAIL/);
    } finally {
      if (previous === undefined) delete process.env.AI_CLI_KERNEL; else process.env.AI_CLI_KERNEL = previous;
      k3SetProbe(null);
    }
  });
  await check('K3 worker（AI_CLI_WORKER=1）帶核准旗標呼叫 approve 照舊被拒', async () => {
    k3SetProbe(null);
    const store = k3Awaiting();
    const previous = process.env.AI_CLI_WORKER;
    process.env.AI_CLI_WORKER = '1';
    try {
      await assert.rejects(aiCliKernelApprove({ runId: store.runId, acknowledgeUnverifiedBoundary: true }, { quota: k3Quota, launch: k3NoLaunch }), /AI_CLI_NESTED_DISPATCH_BLOCKED/);
    } finally { if (previous === undefined) delete process.env.AI_CLI_WORKER; else process.env.AI_CLI_WORKER = previous; }
    assert.equal(k3Approvals(store).length, 0);
  });

  // loop 派工前的邊界閘：approved 事件帶 boundary_unverified 時只放行 UNKNOWN。
  const K3_PLAN = JSON.stringify({ action: 'plan', steps: [{ id: 's1', title: '讀 README', prompt: '讀 README' }], report_step: 's1' });
  const K3_REPORT = '## 結論\n這是一份足夠長的報告內容，用來通過長度檢查，還要再多寫幾個字才夠八十個字元的最低要求，所以這裡繼續補上一些說明文字，確保長度足夠。\n\n## 發現\n- 第一行：README.md:1\n\n## 尚待確認\n無\n';
  const k3Executor = () => {
    const started = [], jobs = new Map();
    return {
      started,
      async start(action) { started.push(action); const job = { jobId: `k3-${started.length}`, pid: 91000 + started.length }; jobs.set(job.jobId, action); return job; },
      async poll(job) {
        assert.ok(started.length <= 6, 'fake run must finish');
        const action = jobs.get(job.jobId);
        return { state: 'finished', result: { status: 'completed', exitCode: 0, message: action.kind === 'decide' ? K3_PLAN : K3_REPORT, rawTail: '', usage: { input: 10, cached: 0, output: 5 } } };
      },
      async find() { return null; }, async kill() { return true; }, async isGone() { return true; },
    };
  };
  const k3LoopRun = overrides => {
    const contract = buildContract({ goal: 'K3 gate', workFolder: k3Folder });
    const store = new RunStore(kernelRunDir(newRunId())); const digest = store.create(contract);
    store.append({ type: 'approved', contractDigest: digest, kind: 'contract', ...(overrides ? { overrides } : {}) });
    store.append({ type: 'state', state: 'running' });
    return { store, contract };
  };
  const k3LoopDeps = (store, contract, executor, boundary) => ({ store, contract, executor, workspace: realWorkspace, boundary: async () => boundary, quota: async () => 80, agentFor: () => 'codex', versionId: () => 'fixture', snapshot: () => null, now: Date.now, sleep: () => new Promise(r => setImmediate(r)), pollMs: 1, killConfirmMs: 20, pid: process.pid });
  await check('K3 loop：核准時同意未驗證 → 探針 UNKNOWN 照派，裁決標籤 unverified_acknowledged_at_approval', async () => {
    const { store, contract } = k3LoopRun(['boundary_unverified']); const executor = k3Executor();
    assert.equal(await runKernelLoop(k3LoopDeps(store, contract, executor, 'UNKNOWN')), 'completed');
    assert.ok(executor.started.length >= 2);
    assert.equal(JSON.parse(readFileSync(store.verdictPath, 'utf8')).boundaryLabel, 'unverified_acknowledged_at_approval');
  });
  await check('K3 loop：核准時同意未驗證，探針結果FAIL仍停在 boundary_unverified、不派工', async () => {
    const { store, contract } = k3LoopRun(['boundary_unverified']); const executor = k3Executor();
    assert.equal(await runKernelLoop(k3LoopDeps(store, contract, executor, 'FAIL')), 'waiting_human');
    const view = replayJournal(store.read());
    assert.equal(view.reason, 'boundary_unverified'); assert.match(view.detail, /不包含 FAIL/);
    assert.equal(executor.started.length, 0);
  });
  await check('K3 loop：沒有核准同意時探針 UNKNOWN 照舊停下、不派工', async () => {
    const { store, contract } = k3LoopRun(); const executor = k3Executor();
    assert.equal(await runKernelLoop(k3LoopDeps(store, contract, executor, 'UNKNOWN')), 'waiting_human');
    assert.equal(replayJournal(store.read()).reason, 'boundary_unverified');
    assert.equal(executor.started.length, 0);
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
assert.ok(passed + failed > 0, 'refuse an empty test selection');
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
