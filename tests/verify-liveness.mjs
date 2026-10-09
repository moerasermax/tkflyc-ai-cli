/**
 * 不打真實 vendor：用慢速 NDJSON stub 驗證 MCP stdio JSON-RPC、file 跨行程讀取及 CLI exit code。
 * job 暫存檔在 repo/dist；設定與更新狀態由 test-env 隔離，完全不碰使用者目錄。
 * 失敗必須印 stdout 的 `FAIL <名稱>`，供 tools/mutation-test.mjs 指認對應斷言。
 */
import '../tools/stubs/catalog-test-env.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(ROOT, 'dist', 'verify-liveness-'));
const CONFIG = join(process.env.AI_CLI_CONFIG_DIR, 'config.json');
const backup = existsSync(CONFIG) ? readFileSync(CONFIG) : null;
if (backup) writeFileSync(join(TEMP, 'config.backup'), backup);
const stub = join(ROOT, 'tools', 'stubs', process.platform === 'win32' ? 'slow-agent.cmd' : 'slow-agent.mjs');
if (process.platform !== 'win32') chmodSync(stub, 0o755);
const providers = join(TEMP, 'providers.json');
writeFileSync(providers, '{"providers":{}}');
const envOverrides = {
  AI_CLI_AUTO_UPDATE: 'off',
  CODEX_CLI_NAME: stub, CLAUDE_CLI_NAME: stub, AGY_CLI_NAME: stub,
  SLOW_AGENT_TOTAL_SEC: '6', AI_CLI_BREAKER_DISABLED: 'true', AI_CLI_PROVIDERS_PATH: providers,
};
const previousEnv = Object.fromEntries(Object.keys(envOverrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, envOverrides);
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (condition) passed++;
  else {
    failed++;
    if (detail) console.log(`  ${String(detail).replace(/\s+/g, ' ').slice(0, 700)}`);
  }
}

async function attempt(name, fn) {
  try { return await fn(); }
  catch (error) { check(name, false, error.stack ?? error); return null; }
}

function restoreConfig() {
  if (backup !== null) writeFileSync(CONFIG, backup);
  else rmSync(CONFIG, { force: true });
}
const onSignal = () => { restoreConfig(); process.exit(130); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

function decode(response) {
  if (response?.error || response?.result?.isError) return null;
  return JSON.parse(response.result.content[0].text);
}

function runningChecks(prefix, result) {
  check(`${prefix} running`, result?.status === 'running', JSON.stringify(result));
  check(`${prefix} alive`, result?.liveness?.alive === true);
  check(`${prefix} elapsed >= 1`, result?.liveness?.elapsedSec >= 1);
  check(`${prefix} stdout bytes`, result?.liveness?.stdoutBytes > 0);
  check(`${prefix} sinceLastOutputSec is numeric`, typeof result?.liveness?.sinceLastOutputSec === 'number');
  check(`${prefix} event summary`, /thread\.started|reasoning/.test(result?.liveness?.lastEvent ?? ''));
  check(`${prefix} event count`, result?.liveness?.eventCount >= 1);
  check(`${prefix} hint`, typeof result?.liveness?.hint === 'string' && result.liveness.hint.length > 0);
}

function terminalChecks(prefix, result) {
  check(`${prefix} completed`, result?.status === 'completed', JSON.stringify(result));
  check(`${prefix} no liveness or timedOut`, !!result && !('liveness' in result) && !('timedOut' in result));
  check(`${prefix} PONG`, result?.agentOutput?.message === 'PONG');
}

// Windows CIM／runner 冷啟動可超過一秒；先由獨立 log 證明 stub 已輸出，再驗一秒 wait。
async function stubOutputReady(state, jobId) {
  const path = join(state, 'jobs', jobId, 'stdout.log'), deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes('thread.started')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Stub first output did not arrive');
}

async function mcpChecks() {
  const child = spawn(process.execPath, [join(ROOT, 'dist/bin/ai-cli-mcp.js')], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = once(child, 'close');
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.resolve(message);
      } catch { /* 啟動文字不是 JSON-RPC。 */ }
    }
  });
  child.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error(`MCP closed: ${stderr}`));
  });
  child.stdin.on('error', () => {});
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}: ${stderr}`)); }, 35000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); pending.delete(id); resolve(value); },
      reject: (error) => { clearTimeout(timer); pending.delete(id); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = (name, args = {}) => send('tools/call', { name, arguments: args });
  let pid;
  try {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-liveness', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const run = decode(await call('run', { model: 'gpt-5.5', prompt: 'Reply PONG', workFolder: ROOT }));
    pid = run?.pid;
    check('MCP run uses codex stub', Number.isSafeInteger(pid) && run.agent === 'codex', JSON.stringify(run));
    if (!pid) return;
    await stubOutputReady(process.env.AI_CLI_STATE_DIR, run.jobId);
    const first = await call('wait', { pids: [pid], timeout: 1 });
    check('MCP timeout is not an error', !first.error && !first.result?.isError, JSON.stringify(first));
    const results = decode(first);
    check('MCP wait retains array', Array.isArray(results));
    check('MCP timeout tagged', results?.[0]?.timedOut === true);
    runningChecks('MCP wait', results?.[0]);
    const listed = decode(await call('list_processes')).find((item) => item.pid === pid);
    check('MCP list timing and event', typeof listed?.elapsedSec === 'number' && typeof listed?.sinceLastOutputSec === 'number' && !!listed?.lastEvent && listed.liveness?.alive === true);
    const current = decode(await call('get_result', { pid }));
    runningChecks('MCP get_result', current);
    check('MCP get_result timeout tag does not leak', !('timedOut' in current));
    const last = decode(await call('wait', { pids: [pid], timeout: 30 }));
    terminalChecks('MCP wait final', last?.[0]);
    terminalChecks('MCP get_result final', decode(await call('get_result', { pid, verbose: true })));
    const ended = decode(await call('list_processes')).find((item) => item.pid === pid);
    check('MCP list terminal duration', ended?.elapsedSec >= 6 && !('liveness' in ended) && !('lastEvent' in ended));
    const missing = await call('wait', { pids: [pid, 2147483647], timeout: 1 });
    check('MCP missing pid remains error', !!missing.error && /not found/.test(missing.error.message));
    console.log(`MCP sample: ${JSON.stringify(results?.[0])}`);
  } finally {
    // 即使突變使第一個 wait 失敗，也等 stub 自行結束；不留下背景 node 子樹。
    if (pid && child.exitCode === null) await call('wait', { pids: [pid], timeout: 30 }).catch(() => {});
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    await closed;
    clearTimeout(timer);
  }
}

function cli(args, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), ...args], {
      cwd: ROOT, env: { ...process.env, AI_CLI_STATE_DIR: stateDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${args}`)); }, 35000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function fileChecks(FileProcessService) {
  // CIM 與多次跨行程 CLI 冷啟動也算在 stub 壽命內，留足觀察 running 的時間。
  const oldTotal = process.env.SLOW_AGENT_TOTAL_SEC;
  process.env.SLOW_AGENT_TOTAL_SEC = '18';
  const stateDir = join(TEMP, 'state');
  const options = { stateDir, cliPaths: { codex: stub } };
  const service = new FileProcessService(options);
  const run = await service.startProcess({ cwd: ROOT, model: 'gpt-5.5', prompt: 'Reply PONG' });
  // 刻意換一個 service：不能只靠寫入端的記憶體計數。
  const reader = new FileProcessService(options);
  try {
    const first = await attempt('File timeout is not an error', () => reader.waitForProcesses([run.pid], 1));
    check('File wait retains array and timedOut', Array.isArray(first) && first[0]?.timedOut === true);
    runningChecks('File wait', first?.[0]);
    const current = await reader.getProcessResult(run.pid, true);
    runningChecks('File get_result', current);
    check('File get_result timeout tag does not leak', !('timedOut' in current));
    const list = await reader.listProcesses();
    check('File list timing and event', list[0]?.elapsedSec >= 1 && typeof list[0]?.sinceLastOutputSec === 'number' && !!list[0]?.lastEvent && list[0]?.liveness?.alive === true);
    const polled = await cli(['wait', String(run.pid), '--timeout', '1'], stateDir);
    check('CLI timeout exits 3', polled.code === 3, JSON.stringify(polled));
    const polledJson = await attempt('CLI timeout emits JSON', () => JSON.parse(polled.stdout));
    check('CLI timeout JSON running + liveness', polledJson?.[0]?.timedOut === true && polledJson[0].liveness?.alive === true);
    const cliResult = await cli(['result', String(run.pid)], stateDir);
    check('CLI result cross-process liveness', cliResult.code === 0 && JSON.parse(cliResult.stdout).liveness?.stdoutBytes > 0);
    terminalChecks('File wait final', (await reader.waitForProcesses([run.pid], 30))[0]);
    const finalCli = await cli(['wait', String(run.pid), '--timeout', '1'], stateDir);
    check('CLI terminal exits 0', finalCli.code === 0);
    terminalChecks('CLI terminal JSON', JSON.parse(finalCli.stdout)[0]);
    const ended = (await new FileProcessService(options).listProcesses())[0];
    check('File list terminal duration', ended?.elapsedSec >= 6 && !('liveness' in ended));
    const badCli = await cli(['wait', '2147483647', '--timeout', '1'], stateDir);
    check('CLI unknown pid exits 1', badCli.code === 1 && /not found/.test(badCli.stderr));
    let missing = false;
    try { await reader.waitForProcesses([run.pid, 2147483647], 1); } catch (error) { missing = /not found/.test(error.message); }
    check('File missing pid remains error', missing);
    console.log(`File sample: ${JSON.stringify(first?.[0])}`);
  } finally {
    await service.waitForProcesses([run.pid], 30).catch(() => {});
    service.dispose(); reader.dispose();
    process.env.SLOW_AGENT_TOTAL_SEC = oldTotal;
  }
}

async function edgeChecks(ProcessService, FileProcessService, buildLiveness, emptyOutputStats, LivenessEventExtractor, PeekEventExtractor) {
  const now = Date.now();
  const ago = (seconds) => new Date(now - seconds * 1000).toISOString();
  const stats = emptyOutputStats();
  check('hint starting up', buildLiveness(stats, ago(29), true, now).hint === 'starting up');
  check('hint silent alive at 30 seconds', buildLiveness(stats, ago(30), true, now).hint === 'alive but silent for 30s since start — keep waiting or peek');
  stats.lastOutputAt = ago(119);
  check('hint recent output', buildLiveness(stats, ago(200), true, now).hint === 'still working; last output 119s ago — keep waiting');
  stats.lastOutputAt = ago(120);
  check('hint reasoning silence at 120 seconds', buildLiveness(stats, ago(200), true, now).hint === 'no output for 120s but the process is alive; codex/claude emit nothing while reasoning — keep waiting or peek');
  check('liveness preserves false', buildLiveness(stats, ago(200), false, now).alive === false);

  const extractor = new LivenessEventExtractor('codex');
  const text = JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '思考中' } }) + '\n';
  const bytes = Buffer.from(text);
  const cut = bytes.indexOf(Buffer.from('思')) + 1;
  check('split NDJSON is not an event yet', extractor.push(bytes.subarray(0, cut)).length === 0);
  check('split UTF-8 reasoning preserved', extractor.push(bytes.subarray(cut))[0] === 'item.completed reasoning: 思考中');
  check('invalid and empty events ignored', extractor.push('\nnull\n[]\n{bad}\n{}\n').length === 0);
  const command = extractor.push(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'echo\n' + 'x'.repeat(300) } }) + '\n')[0];
  check('command summary bounded and one line', command.includes('item.started command_execution: echo ') && command.length <= 120 && !command.includes('\n'));
  const mcp = extractor.push('{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"search"}}\n')[0];
  check('codex MCP tool event', mcp === 'item.completed mcp_tool_call: search');
  const claude = new LivenessEventExtractor('claude');
  const events = claude.push('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}\n{"type":"result"}\n');
  check('claude assistant tool name and result', events[0] === 'assistant tool_use Read' && events[1] === 'result');
  const direct = new LivenessEventExtractor('direct-api');
  check('direct API event type', direct.push('{"type":"tool_use","tool":"read_file"}\n')[0] === 'tool_use');
  const agy = new LivenessEventExtractor('antigravity');
  agy.push('\u001b[3');
  check('agy strips split ANSI and caps text', agy.push('1m' + 'a'.repeat(90) + '\u001b[0m\r\n')[0] === 'a'.repeat(80));
  const peek = new PeekEventExtractor('codex');
  check('peek still excludes reasoning', peek.push(text).length === 0);
  check('peek still emits agent message', peek.push('{"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}\n')[0]?.text === 'PONG');
  const toolPeek = new PeekEventExtractor('codex', { includeToolCalls: true });
  check('peek malformed tool shape remains ignored', toolPeek.push('{"type":"item.started","item":{"type":"mcp_tool_call","tool":123}}\n').length === 0);

  // 用實際存活的測試 runner PID 與合成 log 控制時間，驗證讀端不把空檔 mtime 當成輸出。
  const stateDir = join(TEMP, 'edges');
  const fixtureDir = join(stateDir, 'cwds', 'fixture', String(process.pid));
  mkdirSync(fixtureDir, { recursive: true });
  const stdoutPath = join(fixtureDir, 'stdout.log');
  const stderrPath = join(fixtureDir, 'stderr.log');
  writeFileSync(stdoutPath, '');
  writeFileSync(stderrPath, '');
  const meta = { pid: process.pid, prompt: 'fixture', workFolder: ROOT, cwdKey: 'fixture', toolType: 'codex',
    startTime: ago(240), stdoutPath, stderrPath, status: 'running' };
  const metaPath = join(fixtureDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify(meta)); // 也測舊 meta 沒有 liveness 欄位。
  const reader = new FileProcessService({ stateDir, cliPaths: { codex: stub } });
  const silent = await reader.getProcessResult(process.pid);
  check('File never output remains null', silent.liveness?.sinceLastOutputSec === null && silent.liveness?.eventCount === 0);
  writeFileSync(stderrPath, 'warning 中文');
  utimesSync(stderrPath, new Date(ago(150)), new Date(ago(150)));
  const warning = await reader.getProcessResult(process.pid);
  check('File stderr bytes and old output', warning.liveness?.stderrBytes === Buffer.byteLength('warning 中文') && warning.liveness.sinceLastOutputSec >= 150 && /no output/.test(warning.liveness.hint));
  const many = Array.from({ length: 500 }, (_, n) => JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: `tick ${n}` } })).join('\n') + '\n';
  writeFileSync(stdoutPath, many + '{"type":');
  const longLog = await reader.getProcessResult(process.pid);
  check('File eventCount scans beyond tail', longLog.liveness.eventCount === 500 && longLog.liveness.lastEvent.includes('tick 499'));
  appendFileSync(stdoutPath, '"turn.started"}\n');
  const appended = await reader.getProcessResult(process.pid);
  const reread = await reader.getProcessResult(process.pid);
  check('File appended half-line counted once', appended.liveness.eventCount === 501 && reread.liveness.eventCount === 501 && reread.liveness.lastEvent === 'turn.started');
  const fresh = await new FileProcessService({ stateDir, cliPaths: { codex: stub } }).getProcessResult(process.pid);
  check('File fresh reader matches event count', fresh.liveness.eventCount === 501 && fresh.liveness.lastEvent === 'turn.started');

  // 模擬既有 PTY 短暫競態：OS PID 已消失，onExit 還沒寫 metadata。
  // 不靠時間運氣，也不能把 alive 寫死 true；移除 PTY guard 後仍沿用 lost 語意。
  const missingPid = 2147483647;
  writeFileSync(metaPath, JSON.stringify({ ...meta, pid: missingPid }));
  reader.ptyManagedPids.add(missingPid);
  const disappeared = await reader.getProcessResult(missingPid);
  check('File disappeared process alive is false', disappeared.status === 'running' && disappeared.liveness?.alive === false);
  reader.ptyManagedPids.delete(missingPid);
  const lost = await reader.getProcessResult(missingPid);
  check('File disappeared without report stays lost', lost.status === 'lost' && !('liveness' in lost));

  const service = new ProcessService({ cliPaths: { codex: stub, claude: stub, antigravity: stub } });
  const run = service.startProcess({ model: 'gpt-5.5', prompt: 'Memory counters', workFolder: ROOT });
  const entry = service.findProcess(run.pid);
  try {
    const originalListeners = entry.process.listenerCount('close');
    for (let n = 0; n < 12; n++) await service.waitForProcesses([run.pid, run.pid], 0.001).catch(() => {});
    check('repeated waits release listeners', entry.process.listenerCount('close') === originalListeners);
    appendFileSync(join(entry.directory, 'stderr.log'), Buffer.from('警告'));
    check('Memory stderr counts UTF-8 bytes', service.getProcessResult(run.pid).liveness.stderrBytes === Buffer.byteLength('警告'));
    check('Memory stderr updates last output', typeof service.getProcessResult(run.pid).liveness.sinceLastOutputSec === 'number');
    const { getAgent } = await import('../dist/agents/registry.js');
    const directAgent = getAgent('direct-api');
    const originalRunDirect = directAgent.runDirect;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    try {
      directAgent.runDirect = async (_cmd, io) => {
        io.stdout('{"type":"tool_use","tool":"read_file"}\n');
        io.stderr('warning 中文');
        await gate;
        io.stdout('{"type":"message","content":"PONG"}\n');
      };
      const directRun = service.startDirectProcess({ agent: 'direct-api', cwd: ROOT, prompt: 'fake direct transport' });
      const directLive = service.getProcessResult(directRun.pid);
      check('Memory direct transport liveness', directLive.liveness?.alive === true && directLive.liveness.eventCount === 1 && directLive.liveness.lastEvent === 'tool_use');
      check('Memory direct transport stderr bytes', directLive.liveness?.stderrBytes === Buffer.byteLength('warning 中文'));
      release();
      terminalChecks('Memory direct final', (await service.waitForProcesses([directRun.pid], 1))[0]);
      const mixed = await service.waitForProcesses([directRun.pid, run.pid], 0.001).catch(() => null);
      check('mixed wait tags only running items', mixed?.[0]?.status === 'completed' && !('timedOut' in mixed[0]) && !('liveness' in mixed[0]) && mixed?.[1]?.timedOut === true);
      directAgent.runDirect = async () => { throw new Error('fake direct failure'); };
      const failedRun = service.startDirectProcess({ agent: 'direct-api', cwd: ROOT, prompt: 'fake direct failure' });
      const [failure] = await service.waitForProcesses([failedRun.pid], 1);
      check('failed process has no liveness or timedOut', failure.status === 'failed' && !('liveness' in failure) && !('timedOut' in failure));
    } finally {
      release();
      directAgent.runDirect = originalRunDirect;
    }
    await service.waitForProcesses([run.pid], 30);
    let missing = false;
    try { await service.waitForProcesses([run.pid, missingPid], 1); } catch (error) { missing = /not found/.test(error.message); }
    check('Memory missing pid remains error', missing);
  } finally {
    await service.waitForProcesses([run.pid], 30).catch(() => {});
  }
}

try {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, '{}\n');
  const { ProcessService } = await import('../dist/core/process-service.js');
  const { FileProcessService } = await import('../dist/core/file-process-service.js');
  const { buildLiveness, emptyOutputStats } = await import('../dist/core/liveness.js');
  const { LivenessEventExtractor, PeekEventExtractor } = await import('../dist/core/peek-extractor.js');
  await attempt('MCP checks', mcpChecks);
  await attempt('File checks', () => fileChecks(FileProcessService));
  await attempt('edge checks', () => edgeChecks(ProcessService, FileProcessService, buildLiveness, emptyOutputStats, LivenessEventExtractor, PeekEventExtractor));
} catch (error) {
  check('liveness harness', false, error.stack ?? error);
} finally {
  restoreConfig();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  check('user config restored byte-for-byte', backup === null ? !existsSync(CONFIG) : readFileSync(CONFIG).equals(backup));
  rmSync(TEMP, { recursive: true, force: true });
}
console.log(`PASS: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
