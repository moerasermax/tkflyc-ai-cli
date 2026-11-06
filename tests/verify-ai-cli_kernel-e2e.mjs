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
  const callMcp = async (env, requests) => {
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
    child.kill();
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
} catch (error) {
  check('測試沒有丟例外', false, error.stack);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
