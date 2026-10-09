// MCP server smoke test：對**每一個對外入口**跑 handshake + 呼叫工具。
//
// 為什麼三個入口都要跑：4.1.2 之前 `ai-cli mcp` 這條路徑一連上就自殺
// （runMcpServer 啟動完就 resolve，bin/ai-cli.ts 隨即 process.exit），
// 但這支腳本當時硬編 `C:\Users\Moera\...\dist\server.js`，只測得到其中一個入口，
// 於是那個 bug 從框架初版活到 4.1.1 都沒被抓到。典型的假綠燈。
// 路徑一律相對本檔解析，不要再寫死任何機器上的絕對路徑。
import '../tools/stubs/catalog-test-env.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const logs = [];
const log = (...a) => logs.push(a.join(' '));
process.on('exit', () => writeFileSync('mcp-test-out.txt', logs.join('\n') + '\n'));

const dist = (relative) => fileURLToPath(new URL(`../dist/${relative}`, import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
// 從 git URL 另外算一次 owner/repo：**不呼叫 src 的 normalizeRepositoryUrl**。
// 用同一段邏輯驗同一段邏輯等於沒驗（這個專案吃過三次這種假綠燈的虧）。
const PKG_SLUG = String(PKG.repository?.url ?? '').replace(/\.git$/, '').split('/').slice(-2).join('/');
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-mcp-smoke-'));
const stub = fileURLToPath(new URL(`../tools/stubs/agy-models-slow.${process.platform === 'win32' ? 'cmd' : 'mjs'}`, import.meta.url));
if (process.platform !== 'win32') chmodSync(stub, 0o755);
let passed = 0;
let failures = 0;
function check(ok, name, detail = '') {
  if (ok) passed++;
  else failures++;
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`;
  log(line);
  console.log(line);
}

/** 三個入口在對外行為上應完全等價。 */
const ENTRIES = [
  { name: 'dist/server.js', args: [dist('server.js')] },
  { name: 'dist/bin/ai-cli-mcp.js', args: [dist('bin/ai-cli-mcp.js')] },
  { name: 'dist/bin/ai-cli.js mcp', args: [dist('bin/ai-cli.js'), 'mcp'] },
];

const EXPECTED_TOOLS = [
  'run', 'list_processes', 'get_result', 'wait', 'peek', 'kill_process',
  'cleanup_processes', 'doctor', 'models', 'set_config', 'query_usage',
];

/**
 * 入口壞掉時實測是 202ms 內 reject（-32000 Connection closed），不是 hang。
 * 還是加一層 timeout：突變測試會把這支腳本跑很多次，任何一次 hang 都會讓整個
 * harness 卡死，而不是回報一個乾淨的 FAIL。
 */
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function checkEntry(entry) {
  log(`\n=== 入口：${entry.name} ===`);
  const index = ENTRIES.indexOf(entry);
  const trace = join(TEMP, `${index}-trace.jsonl`);
  const transport = new StdioClientTransport({ command: process.execPath, args: entry.args, env: {
    ...process.env,
    AI_CLI_AUTO_UPDATE: 'off',
    AGY_CLI_NAME: stub,
    AI_CLI_CATALOG_CACHE_PATH: join(TEMP, `${index}-cache.json`),
    AI_CLI_DISCOVER_TIMEOUT_MS: '15000',
    AGY_STUB_DELAY_MS: '2000',
    AGY_STUB_EMPTY: 'false',
    AGY_STUB_TRACE_PATH: trace,
  } });
  const client = new Client({ name: 'smoke-test', version: '1.0.0' }, { capabilities: {} });

  try {
  await withTimeout(client.connect(transport), 20000, `${entry.name} connect`);
  log('connected & initialized');

  const listStarted = performance.now();
  const tools = await withTimeout(client.listTools(), 10000, `${entry.name} tools/list`);
  const elapsed = performance.now() - listStarted;
  check(elapsed < 1000, `${entry.name} 冷啟動 tools/list < 1 秒`, `${elapsed.toFixed(1)} ms`);
  const names = tools.tools.map((t) => t.name);
  /*
    工具描述才是呼叫端**最先讀到**的東西。issue #12 的情境是「AI 查不到 fable → 判定不支援」，
    而一個只讀 run schema、從不呼叫 models 的呼叫端（很常見，因為 run 的描述已經把清單給它了）
    會原封不動再踩一次。所以「這不是 allowlist」必須出現在 run 自己的描述裡，不是只在 payload。
  */
  const descOf = (name) => tools.tools.find((t) => t.name === name)?.description ?? '';
  const runModelDesc =
    tools.tools.find((t) => t.name === 'run')?.inputSchema?.properties?.model?.description ?? '';
  check(/NOT an allowlist/i.test(descOf('run')) && /modelListCaveat/.test(descOf('run')),
    `${entry.name} run 描述講明候選清單不是 allowlist 並指向 modelListCaveat`, descOf('run').slice(0, 200));
  check(/NOT an allowlist/i.test(runModelDesc),
    `${entry.name} run 的 model 參數描述也講明不是 allowlist`, runModelDesc.slice(0, 200));
  check(/modelListCaveat/.test(descOf('models')),
    `${entry.name} models 描述指向 modelListCaveat`, descOf('models').slice(0, 200));
  log(`list_tools (${names.length}): ${names.join(', ')}`);

  const missing = EXPECTED_TOOLS.filter((e) => !names.includes(e));
  if (missing.length) throw new Error(`MISSING TOOLS: ${missing.join(', ')}`);
  log(`all ${EXPECTED_TOOLS.length} expected tools present`);

  const models = await withTimeout(client.callTool({ name: 'models', arguments: {} }), 10000, 'models');
  const modelsPayload = JSON.parse(models.content[0].text);
  log(`models agents = ${Object.keys(modelsPayload).filter((k) => Array.isArray(modelsPayload[k])).join(', ')}`);
  if (!modelsPayload.antigravity) throw new Error('antigravity missing!');
  check(modelsPayload.grok?.includes('grok-4.7'), 'models MCP payload includes Grok family');
  check(modelsPayload.catalogV2.agents.find((a) => a.agent === 'antigravity')?.source === 'vendor-cli',
    `${entry.name} models 等待 refresh 後回 vendor-cli`);
  await client.callTool({ name: 'models', arguments: {} });
  const events = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
  check(events.filter((e) => e.event === 'started').length === 1,
    `${entry.name} tools/list 背景與 models 單飛且 TTL 內不重查`);
  if (modelsPayload.gemini) throw new Error('gemini should NOT be present!');
  // 5.0.0 移除：kiro / forge 不得再出現在 models payload 或 alias 清單裡。
  for (const gone of ['kiro', 'forge']) {
    if (modelsPayload[gone]) throw new Error(`${gone} should NOT be present (removed in 5.0.0)!`);
  }
  if (modelsPayload.aliases.some((a) => a.name === 'kiro-ultra')) {
    throw new Error('kiro-ultra alias should NOT be present (removed in 5.0.0)!');
  }
  log('antigravity present; gemini/kiro/forge absent');

  // 身分：呼叫端只從 MCP 註冊看得到 `node .../dist/server.js`，認不出這是哪個
  // repo／npm 套件。2026-09-09 改名後，去查外部紀錄拿到的是改名前的答案。
  const identity = modelsPayload.server;
  check(identity?.name === PKG.name && identity?.version === PKG.version,
    `${entry.name} models 說得出自己的套件名與版本`,
    `name=${identity?.name} version=${identity?.version}`);
  check(identity !== undefined && 'note' in identity && identity.note === null,
    `${entry.name} server.note 永遠在，正常時為 null`,
    `note=${JSON.stringify(identity?.note)}`);
  check(typeof identity?.repository === 'string'
    && identity.repository.startsWith('https://')
    && !identity.repository.endsWith('.git')
    && identity.repository.endsWith(PKG_SLUG),
    `${entry.name} server.repository 是可瀏覽網址而不是 git URL`,
    `repository=${identity?.repository}`);

  const doctor = await client.callTool({ name: 'doctor', arguments: {} });
  const doctorPayload = JSON.parse(doctor.content[0].text);
  const avail = Object.keys(doctorPayload).filter((k) => k !== 'checks' && doctorPayload[k].available).join(', ');
  log(`doctor available CLIs = ${avail}`);
  check(JSON.stringify(doctorPayload.server) === JSON.stringify(modelsPayload.server),
    `${entry.name} doctor 與 models 回報同一個身分`,
    `doctor=${JSON.stringify(doctorPayload.server)}`);

  const list = await client.callTool({ name: 'list_processes', arguments: {} });
  log(`list_processes: ${list.content[0].text.trim()}`);

  log(`--- ${entry.name} OK ---`);
  check(true, `入口 ${entry.name} 的 MCP handshake 與工具呼叫`);
  } finally {
    await client.close();
  }
}

try {
for (const entry of ENTRIES) {
  try {
    await checkEntry(entry);
  } catch (error) {
    log(`!!! ${entry.name} FAILED: ${error.message}`);
    // 這一行必須進 stdout（而不是只進 mcp-test-out.txt）：tools/mutation-test.mjs
    // 是靠掃 stdout 裡含 "FAIL " 的行、再比對 mutations.json 的 expect 字串，
    // 才能判斷突變是「被我們指定的那條斷言殺掉」還是被別的斷言誤殺。
    check(false, `入口 ${entry.name} 的 MCP handshake 與工具呼叫`, error.message);
  }
}
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}
console.log(`PASS: ${passed} passed, ${failures} failed`);
log(`PASS: ${passed} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
