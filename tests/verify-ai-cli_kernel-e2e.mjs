/**
 * ai-cli_kernel 端到端：真的走 CLI、runner、JobStore，只把 vendor CLI 換成 stub，不花額度。
 * 重點是真的殺掉 runner 再接回，確認 job 沒有被重派。
 */
import '../tools/stubs/catalog-test-env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'dist', 'bin', 'ai-cli.js');
const SERVER = join(ROOT, 'dist', 'server.js');
const stub = join(ROOT, 'tools', 'stubs', process.platform === 'win32' ? 'kernel-agent.cmd' : 'kernel-agent.mjs');
if (process.platform !== 'win32') chmodSync(stub, 0o755);
const WORK = mkdtempSync(join(tmpdir(), 'kernel-e2e-work-'));
writeFileSync(join(WORK, 'README.md'), 'line one\nline two\n');
const LOG = join(mkdtempSync(join(tmpdir(), 'kernel-e2e-log-')), 'stub.log');
const STATE = mkdtempSync(join(tmpdir(), 'kernel-e2e-state-'));
const CONFIG = mkdtempSync(join(tmpdir(), 'kernel-e2e-config-'));
const providers = join(CONFIG, 'providers.json');
writeFileSync(providers, '{"providers":{}}');

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (condition) passed++;
  else { failed++; if (detail !== '') console.log(`  ${String(detail).replace(/\s+/g, ' ').slice(0, 800)}`); }
}
const baseEnv = {
  ...process.env, AI_CLI_STATE_DIR: STATE, AI_CLI_CONFIG_DIR: CONFIG, AI_CLI_PROVIDERS_PATH: providers, AI_CLI_AUTO_UPDATE: 'off', AI_CLI_BREAKER_DISABLED: 'true',
  CODEX_CLI_NAME: stub, KERNEL_STUB_LOG: LOG, AI_CLI_KERNEL_QUOTA_TIMEOUT_MS: '500',
};
delete baseEnv.AI_CLI_WORKER;
function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, 'kernel', ...args], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 180000, windowsHide: true });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}
function json(args, env) {
  const result = cli([...args, '--json'], env);
  try { return { ...result, data: JSON.parse(result.out) }; } catch { return { ...result, data: null }; }
}
const logCount = kind => existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(line => line === kind).length : 0;
const START = ['start', '--goal', '檢查 README', '--cwd', WORK, '--max-steps', '3', '--max-decides', '3'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const help = cli(['help']);
  check('help 列出動作', help.code === 0 && help.out.includes('approve') && help.out.includes('probe'), help.err);

  /* ---- 委任書與探針 ---- */
  const created = json(START);
  check('start 只建立委任書，不執行', created.code === 0 && created.data?.state === 'awaiting_approval' && logCount('decide') === 0, created.out + created.err);
  const runId = created.data?.runId;
  const blocked = cli(['approve', runId]);
  check('探針沒跑過不能核准', blocked.code === 1 && blocked.err.includes('probe'), blocked.out + blocked.err);

  const silent = json(['probe', '--agent', 'codex'], { KERNEL_STUB_MODE: 'probe-silent' });
  check('沒有工具層拒絕的痕跡只算 UNKNOWN', silent.data?.status === 'UNKNOWN', silent.out + silent.err);
  const partial = json(['probe', '--agent', 'codex'], { KERNEL_STUB_MODE: 'probe-partial' });
  check('只有部分目標被擋只算 UNKNOWN', partial.data?.status === 'UNKNOWN', partial.out + partial.err);
  const word = json(['probe', '--agent', 'codex'], { KERNEL_STUB_MODE: 'probe-readonly-word' });
  check('讀取指令含 read-only 字樣只算 UNKNOWN', word.data?.status === 'UNKNOWN', word.out + word.err);
  const patchOnly = json(['probe', '--agent', 'codex'], { KERNEL_STUB_MODE: 'probe-patch-only' });
  check('只重試編輯工具、沒有試 shell 只算 UNKNOWN', patchOnly.data?.status === 'UNKNOWN', patchOnly.out + patchOnly.err);
  const bad = json(['probe', '--agent', 'codex'], { KERNEL_STUB_MODE: 'probe-fail' });
  check('真的寫出檔案就是 FAIL', bad.code === 2 && bad.data?.status === 'FAIL', bad.out + bad.err);
  const still = cli(['approve', runId]);
  check('探針 FAIL 時不能核准', still.code === 1, still.out);
  const good = json(['probe', '--agent', 'codex']);
  check('被工具擋下而且檔案不存在才是 PASS', good.data?.status === 'PASS', good.out + good.err);
  const changed = cli(['approve', runId], { KERNEL_STUB_VERSION: 'kernel-stub 2.0.0' });
  check('CLI 版本變了，舊的 PASS 立刻失效', changed.code === 1 && changed.err.includes('UNKNOWN'), changed.out + changed.err);

  const before = logCount('probe');
  const flaky = json(['probe', '--agent', 'codex'], { KERNEL_STUB_MODE: 'probe-silent' });
  check('模型沒有嘗試時自動再跑一次，但只多一次', logCount('probe') === before + 2, `${before} -> ${logCount('probe')}`);
  check('沒結論的探針不會蓋掉之前的 PASS', flaky.data?.status === 'UNKNOWN' && flaky.data?.detail?.includes('仍然有效'), flaky.out + flaky.err);
  const retried = json(['probe', '--agent', 'codex'], { KERNEL_STUB_MODE: 'probe-flaky', KERNEL_STUB_FLAG: join(CONFIG, 'flaky.flag') });
  check('第一次沒嘗試、第二次被擋下，結果是 PASS', retried.data?.status === 'PASS', retried.out + retried.err);

  /* ---- 正常流程 ---- */
  const approved = json(['approve', runId]);
  check('核准後開始執行', approved.code === 0 && ['running', 'completed'].includes(approved.data?.state), approved.out + approved.err);
  const done = json(['wait', runId, '--timeout', '120']);
  check('走到 completed', done.data?.state === 'completed', done.out + done.err);
  const result = json(['result', runId]);
  check('result 拿得到報告和裁決', result.data?.report?.includes('README.md:1') && result.data?.verdict?.delivery?.ok === true, result.out);
  check('額度量不到時裁決前有記錄', done.data?.progress?.quotaUnknownDispatches >= 1, JSON.stringify(done.data?.progress));
  check('用量有記到', done.data?.progress?.inputTokens?.used === 2000, JSON.stringify(done.data?.progress));
  check('結案後不能再核准', cli(['approve', runId]).code === 1);

  /* ---- 真的殺掉 runner 再接回 ---- */
  const beforeDecide = logCount('decide'), beforeWorker = logCount('worker');
  const second = json(START);
  const secondId = second.data?.runId;
  const started = json(['approve', secondId], { KERNEL_STUB_DELAY_MS: '6000' });
  check('第二個 run 開始執行', started.code === 0, started.out + started.err);
  // 等到 worker 真的開始跑。
  let current = null;
  for (let i = 0; i < 100; i++) {
    current = json(['status', secondId]).data;
    if (current?.currentAction?.kind === 'worker' && current?.currentAction?.job) break;
    await sleep(300);
  }
  check('worker 正在執行', current?.currentAction?.kind === 'worker', JSON.stringify(current?.currentAction));

  /* 一次一個 */
  const third = json(START);
  const thirdBlocked = cli(['approve', third.data?.runId]);
  check('受治理任務一次只能跑一個', thirdBlocked.code === 1 && thirdBlocked.err.includes(secondId), thirdBlocked.out + thirdBlocked.err);
  cli(['cancel', third.data?.runId]);

  const runner = JSON.parse(readFileSync(join(current.runDir, 'runner.json'), 'utf8'));
  process.kill(runner.pid, 'SIGKILL');
  await sleep(500);
  const interrupted = json(['status', secondId]);
  check('runner 被殺之後判定為中斷', interrupted.data?.effectiveState === 'interrupted', interrupted.out);
  const resumed = json(['approve', secondId]);
  check('中斷的 run 可以接回', resumed.code === 0, resumed.out + resumed.err);
  const resumedDone = json(['wait', secondId, '--timeout', '120']);
  check('接回後走到 completed', resumedDone.data?.state === 'completed', resumedDone.out);
  check('接回時沒有重派 decide', logCount('decide') === beforeDecide + 1, `${beforeDecide} -> ${logCount('decide')}`);
  check('接回時沒有重派 worker', logCount('worker') === beforeWorker + 1, `${beforeWorker} -> ${logCount('worker')}`);

  /* ---- 取消 ---- */
  const toCancel = json(START);
  const cancelStarted = json(['approve', toCancel.data?.runId], { KERNEL_STUB_DELAY_MS: '30000' });
  check('要取消的 run 開始執行', cancelStarted.code === 0, cancelStarted.err);
  for (let i = 0; i < 100; i++) {
    const s = json(['status', toCancel.data?.runId]).data;
    if (s?.currentAction?.kind === 'worker' && s?.currentAction?.job) break;
    await sleep(300);
  }
  const cancelled = json(['cancel', toCancel.data?.runId]);
  check('取消後確認程序停了才回報已取消', cancelled.data?.state === 'cancelled', cancelled.out + cancelled.err);
  const afterCancel = json(START);
  const relock = json(['approve', afterCancel.data?.runId]);
  check('取消後鎖有釋放', relock.code === 0, relock.err);
  json(['wait', afterCancel.data?.runId, '--timeout', '120']);

  /* ---- 防遞迴 ---- */
  const nested = cli(START, { AI_CLI_WORKER: '1' });
  check('worker 不能再開 run', nested.code === 1 && nested.err.includes('AI_CLI_NESTED_DISPATCH_BLOCKED'), nested.out + nested.err);

  /* ---- MCP ---- */
  const callMcp = async (env, requests, finish = child => child.kill()) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const responses = new Map();
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { const message = JSON.parse(line); if (message.id) responses.set(message.id, message); } catch { /* 略過非 JSON */ }
      }
    });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kernel-e2e', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    requests.forEach((request, i) => send({ jsonrpc: '2.0', id: i + 2, ...request }));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && responses.size < requests.length + 1) await sleep(50);
    finish(child);
    return requests.map((_, i) => responses.get(i + 2));
  };
  const [offTools] = await callMcp({}, [{ method: 'tools/list' }]);
  const offNames = (offTools?.result?.tools ?? []).map(tool => tool.name);
  check('預設關閉時 MCP 工具清單沒有變', offNames.length === 12 && !offNames.some(name => name.startsWith('ai-cli_kernel_')), offNames.join(','));
  const enable = cli(['enable']);
  check('enable 寫入開關', enable.code === 0, enable.err);
  const [onTools, statusCall] = await callMcp({}, [{ method: 'tools/list' }, { method: 'tools/call', params: { name: 'ai-cli_kernel_status', arguments: { runId } } }]);
  const onNames = (onTools?.result?.tools ?? []).map(tool => tool.name);
  check('開啟後多出帶前綴的工具，原生工具都還在', onNames.length === 18 && offNames.every(name => onNames.includes(name)) && onNames.filter(name => !offNames.includes(name)).every(name => name.startsWith('ai-cli_kernel_')), onNames.join(','));
  const statusText = statusCall?.result?.content?.[0]?.text ?? '';
  check('MCP 查得到 CLI 建立的 run', statusText.includes(runId) && statusText.includes('completed'), statusText.slice(0, 300));

  /* ---- 關掉 Claude Code：MCP server 整棵行程樹被砍，run 要繼續跑 ---- */
  const survivor = json(START);
  const treeKill = child => {
    // Claude Code 在 Windows 上退出時對 server 做 taskkill /T /F，連子行程一起砍。
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  };
  const workersBefore = logCount('worker');
  const [approveCall] = await callMcp({ KERNEL_STUB_DELAY_MS: '8000' }, [{ method: 'tools/call', params: { name: 'ai-cli_kernel_approve', arguments: { runId: survivor.data?.runId } } }], treeKill);
  check('MCP 核准成功', (approveCall?.result?.content?.[0]?.text ?? '').includes('running'), JSON.stringify(approveCall).slice(0, 300));
  const afterKill = json(['wait', survivor.data?.runId, '--timeout', '120']);
  check('server 整棵行程樹被砍之後，run 仍然跑到完成', afterKill.data?.state === 'completed', afterKill.out + afterKill.err);
  check('沒有因為 server 被砍而重派 worker', logCount('worker') === workersBefore + 1, `${workersBefore} -> ${logCount('worker')}`);

  /* ---- develop：真的走 CLI、runner、git worktree ---- */
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const REPO = mkdtempSync(join(tmpdir(), 'kernel-e2e-repo-'));
  git(REPO, 'init', '-q');
  git(REPO, 'config', 'user.name', 'kernel test');
  git(REPO, 'config', 'user.email', 'kernel-test@example.invalid');
  writeFileSync(join(REPO, 'README.md'), 'line one\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-q', '-m', 'init');
  const baseHead = git(REPO, 'rev-parse', 'HEAD');
  const TEST = `node -e "process.exit(require('fs').readFileSync('feature.txt','utf8').trim()==='good'?0:1)"`;
  const DEV = ['start', '--template', 'develop', '--goal', '加 feature.txt', '--cwd', REPO, '--test', TEST, '--max-steps', '4', '--max-decides', '4'];

  const noTest = cli(['start', '--template', 'develop', '--goal', 'x', '--cwd', REPO]);
  check('develop 沒給測試指令就建不了委任書', noTest.code === 1 && noTest.err.includes('testCommand'), noTest.out + noTest.err);
  const devCreated = cli(DEV);
  check('委任書講清楚未隔離、分支和測試', devCreated.code === 0 && devCreated.out.includes('未隔離') && devCreated.out.includes('ai-cli_kernel/') && devCreated.out.includes('--acknowledge-unisolated'), devCreated.out + devCreated.err);
  check('人看得到 kernel 會自己跑 reset --hard', devCreated.out.includes('git reset --hard'), devCreated.out);
  const devId = json(['status']).data?.runs?.[0]?.runId;
  const noAck = cli(['approve', devId]);
  check('沒有明確承認未隔離就不能核准', noAck.code === 1 && noAck.err.includes('--acknowledge-unisolated'), noAck.out + noAck.err);
  const argsBefore = { decide: logCount('args:decide:strict'), write: logCount('args:write:bypass') };
  const devStarted = json(['approve', devId, '--acknowledge-unisolated']);
  check('承認後開始執行，而且探針不擋', devStarted.code === 0, devStarted.out + devStarted.err);
  const devDone = json(['wait', devId, '--timeout', '120']);
  check('develop 跑到 completed', devDone.data?.state === 'completed', devDone.out);
  const devSpec = devDone.data?.develop;
  check('改動在 run 自己的分支上', git(REPO, 'show', `${devSpec?.branch}:feature.txt`) === 'good');
  check('主目錄完全沒被動到', !existsSync(join(REPO, 'feature.txt')) && git(REPO, 'rev-parse', 'HEAD') === baseHead && git(REPO, 'status', '--porcelain') === '');
  check('只有 write 步驟拿到全權限旗標', logCount('args:write:bypass') === argsBefore.write + 1 && logCount('args:decide:strict') === argsBefore.decide + 1 && logCount('args:decide:bypass') === 0 && logCount('args:worker:bypass') === 0, readFileSync(LOG, 'utf8').slice(-400));
  const devResult = json(['result', devId]);
  check('報告附上 kernel 產生的交付段落', (devResult.data?.report ?? '').includes('交付（由 kernel 產生）') && (devResult.data?.verdict?.develop?.testPassedOn ?? 'x') === git(REPO, 'rev-parse', devSpec?.branch), devResult.out);
  const running = cli(['cleanup', json(['start', '--goal', '檢查', '--cwd', WORK]).data?.runId]);
  check('唯讀的 run 沒有 worktree 可以清', running.code === 1 && running.err.includes('develop'), running.err);
  const cleaned = cli(['cleanup', devId]);
  check('清理移除 worktree，沒合併的分支留著', cleaned.code === 0 && cleaned.out.includes('留著') && !existsSync(devSpec?.worktree ?? 'x') && git(REPO, 'rev-parse', devSpec?.branch).length > 0, cleaned.out + cleaned.err);

  /** stub 量不到額度，派工幾次就會照規則停下來問人。這裡像真人一樣回答後接著走。 */
  const waitThroughQuota = (runId, env = {}) => {
    let seen = 0;
    for (;;) {
      const result = json(['wait', runId, '--timeout', '120']);
      if (result.data?.reason !== 'quota_unknown' || result.data?.state !== 'waiting_human') return { ...result, quotaStops: seen };
      seen += 1;
      json(['approve', runId], env);
    }
  };
  const writesBeforeFix = logCount('write');
  const fixRun = json([...DEV]);
  json(['approve', fixRun.data?.runId, '--acknowledge-unisolated'], { KERNEL_STUB_MODE: 'dev-fix' });
  const fixDone = waitThroughQuota(fixRun.data?.runId, { KERNEL_STUB_MODE: 'dev-fix' });
  check('測試失敗後 kernel 會回去問 decide，修好才完成', fixDone.data?.state === 'completed' && logCount('write') === writesBeforeFix + 2 && fixDone.data?.develop?.testFailures === 1, fixDone.out);
  check('額度量不到時 develop 一樣會停下來問人，不會一直派', fixDone.quotaStops >= 1, fixDone.quotaStops);
  cli(['cleanup', fixRun.data?.runId]);

  const scoped = json([...DEV, '--allow-path', 'src']);
  json(['approve', scoped.data?.runId, '--acknowledge-unisolated']);
  const scopedDone = waitThroughQuota(scoped.data?.runId);
  check('改到範圍外會失敗，不會交付', scopedDone.data?.state === 'failed' && scopedDone.data?.reason === 'repeated_failure:scope_violation' && !existsSync(scopedDone.data?.runDir ? join(scopedDone.data.runDir, 'report.md') : 'x'), scopedDone.out);
  check('範圍外的改動沒有進分支', git(REPO, 'rev-parse', scopedDone.data?.develop?.branch) === baseHead);

  const killed = json([...DEV]);
  const writesBeforeKill = logCount('write');
  json(['approve', killed.data?.runId, '--acknowledge-unisolated'], { KERNEL_STUB_DELAY_MS: '6000' });
  let killedStatus = null;
  for (let i = 0; i < 100; i++) {
    killedStatus = json(['status', killed.data?.runId]).data;
    if (killedStatus?.currentAction?.kind === 'worker' && killedStatus?.currentAction?.job) break;
    await sleep(300);
  }
  const killedRunner = JSON.parse(readFileSync(join(killedStatus.runDir, 'runner.json'), 'utf8'));
  process.kill(killedRunner.pid, 'SIGKILL');
  await sleep(500);
  const reattached = json(['approve', killed.data?.runId]);
  check('寫到一半 runner 被殺，接回不用再承認一次', reattached.code === 0, reattached.out + reattached.err);
  check('接回時等到新 runner 起來才回報，不會被舊的 runner.json 騙到', reattached.data?.effectiveState === 'running', reattached.data?.effectiveState);
  const reattachedDone = json(['wait', killed.data?.runId, '--timeout', '120']);
  check('接回後走到 completed', reattachedDone.data?.state === 'completed', reattachedDone.out);
  check('接回時沒有重派會寫檔的 worker', logCount('write') === writesBeforeKill + 1, `${writesBeforeKill} -> ${logCount('write')}`);
  check('接回後改動只 commit 一次', git(REPO, 'rev-list', '--count', `${baseHead}..${reattachedDone.data?.develop?.branch}`) === '1');

  const toolText = reply => reply?.result?.content?.[0]?.text ?? JSON.stringify(reply ?? null);
  const [viaMcp] = await callMcp({}, [{ method: 'tools/call', params: { name: 'ai-cli_kernel_start', arguments: { goal: '加 feature.txt', workFolder: REPO, template: 'develop', testCommand: TEST, allowedPaths: ['feature.txt'], workerModels: ['sonnet'] } } }]);
  const mcpRun = /kr-\d{8}-\d{6}-[0-9a-f]{4}/.exec(toolText(viaMcp))?.[0];
  const mcpStatus = json(['status', mcpRun]).data;
  check('MCP 帶得到 develop 的參數', mcpStatus?.develop?.testCommand === TEST && mcpStatus?.develop?.allowedPaths?.join() === 'feature.txt' && mcpStatus?.models?.allowedWorkers?.includes('sonnet'), toolText(viaMcp));
  const [mcpNoAck] = await callMcp({}, [{ method: 'tools/call', params: { name: 'ai-cli_kernel_approve', arguments: { runId: mcpRun } } }]);
  check('MCP 沒傳 acknowledgeUnisolated 也不能核准', toolText(mcpNoAck).includes('--acknowledge-unisolated') && json(['status', mcpRun]).data?.state === 'awaiting_approval', toolText(mcpNoAck));
  const [mcpAck] = await callMcp({}, [{ method: 'tools/call', params: { name: 'ai-cli_kernel_approve', arguments: { runId: mcpRun, acknowledgeUnisolated: true } } }]);
  check('MCP 明確承認才開始執行', toolText(mcpAck).includes('running') || toolText(mcpAck).includes('completed'), toolText(mcpAck));
  const mcpDone = waitThroughQuota(mcpRun);
  check('透過 MCP 核准的 develop 一樣跑到完成', mcpDone.data?.state === 'completed', mcpDone.out);
} catch (error) {
  check('測試沒有丟例外', false, error.stack);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
