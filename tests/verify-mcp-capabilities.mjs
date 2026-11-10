/**
 * MCP `run` 的唯讀能力：schema、轉送、fail-closed。
 *
 * ── 為什麼需要這一支 ──────────────────────────────────────────
 * `ai-cli exec` 從一開始就有嚴格模式（claude `--allowedTools Read,Glob,Grep`、
 * codex `--sandbox read-only`），但那條路只有 exec 走得到。MCP `run` 一律走
 * 一般組裝，也就是帶著 `--dangerously-skip-permissions` /
 * `--dangerously-bypass-approvals-and-sandbox`。
 *
 * 於是任何透過 MCP 使用這個框架的呼叫端——例如 TKFLYC Launcher 的「唯讀回合」——
 * 就算自己不做 git 快照，模型仍然有完整的檔案寫入能力。**「我不做快照」不等於
 * 「它不會寫檔」**：那樣做出來的唯讀回合，實際上是一個沒有回復點的可寫回合，
 * 比什麼都不做更糟。
 *
 * 這一支釘住三件事：
 *   1. schema 真的收 capabilities（不是只有文件寫了）
 *   2. 給了就走 strict、沒給維持原樣（不能改變既有呼叫端的行為）
 *   3. 空陣列 ≠ 沒給；agent 沒有 strict builder 時**拒絕**而不是退回
 *
 * 用法：node verify-mcp-capabilities.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const builder = await import(pathToFileURL(join(ROOT, 'dist', 'core', 'command-builder.js')).href);
const plan = (extra) =>
  builder.buildCliCommand({
    workFolder: ROOT,
    prompt: 'hi',
    cliPaths: { claude: 'claude', codex: 'codex' },
    ...extra,
  });

console.log('MCP run 的唯讀能力（capabilities → strict builder）\n');

// 1. 沒給 capabilities → 一般模式。這是既有行為，不能被這次的改動動到。
{
  const built = plan({ model: 'opus' });
  check(
    built.args.includes('--dangerously-skip-permissions'),
    '不給 capabilities → 一般組裝（既有行為不變）',
    built.args.join(' ')
  );
}

// 2. 給了 → strict。claude 應該拿到 allowedTools 而且完全沒有 dangerous 旗標。
{
  const built = plan({ model: 'opus', capabilities: ['fs/read', 'analysis/produce'] });
  const noDanger = built.args.every((a) => !/dangerous/i.test(a));
  check(
    noDanger && built.args.includes('--allowedTools'),
    '★ capabilities → strict builder（claude：有 allowedTools、零危險旗標）',
    built.args.join(' ')
  );
}

// 2b. claude strict 的第一層是 --tools 白名單，不是黑名單。
//     黑名單會過期：只靠它時 init 事件還列著 20 個工具（Workflow、CronCreate、WebFetch……）。
//     期望值刻意寫成字面值，不從 dist 匯入——拿受測的那份清單驗它自己，等於沒驗。
{
  const built = plan({ model: 'opus', capabilities: ['fs/read', 'analysis/produce'] });
  const args = built.args;
  check(args.includes('--restricted'), '★ claude strict 帶 --restricted', args.join(' '));
  const i = args.indexOf('--tools');
  check(
    i >= 0 && args.indexOf('--tools', i + 1) < 0 && args[i + 1] === 'Read,Glob,Grep',
    '★ claude strict 的 --tools 白名單剛好是唯讀三件',
    i >= 0 ? `--tools ${args[i + 1]}` : '沒有 --tools'
  );
  check(
    i >= 0 && typeof args[i + 2] === 'string' && args[i + 2].startsWith('--'),
    '★ claude strict 的 --tools 值後面緊接另一個旗標（variadic 不吃到位置參數）',
    i >= 0 ? `下一個參數：${args[i + 2]}` : '沒有 --tools'
  );
  check(
    args.includes('--disallowedTools'),
    '★ claude strict 保留 --disallowedTools 第二層',
    args.join(' ')
  );
  check(args.every((a) => !/dangerous/i.test(a)), 'claude strict 白名單版零危險旗標', args.join(' '));

  // 其他旗標的行為不能因為加了白名單而改變：續接、effort、-p、model 的順序與值。
  const resumed = plan({ model: 'haiku', session_id: 'strict-claude', reasoning_effort: 'low', capabilities: ['fs/read'] });
  check(
    JSON.stringify(resumed.args.slice(resumed.args.indexOf('--strict-mcp-config'))) === JSON.stringify([
      '--strict-mcp-config', '--disable-slash-commands', '--output-format', 'stream-json', '--verbose',
      '-r', 'strict-claude', '--fork-session', '--effort', 'low', '-p', '--model', 'haiku',
    ]) && resumed.stdinPrompt === 'hi' && !resumed.args.includes('hi'),
    'claude strict 其餘旗標不變（MCP／slash／輸出格式／續接／effort／-p／model，prompt 走 stdin）',
    resumed.args.join(' ')
  );

  // 單一來源：探針要 import 這份清單判斷 init 事件的 tools。
  const claudeMod = await import(pathToFileURL(join(ROOT, 'dist', 'agents', 'claude.js')).href);
  check(
    JSON.stringify(claudeMod.CLAUDE_READ_ONLY_TOOLS) === JSON.stringify(['Read', 'Glob', 'Grep'])
      && JSON.stringify(claudeMod.claudeStrictTools(['fs/read', 'analysis/produce'])) === JSON.stringify(['Read', 'Glob', 'Grep']),
    'claude 唯讀工具清單有匯出成單一來源'
  );

  let refused = false;
  try { plan({ model: 'opus', capabilities: ['fs/read', 'fs/write'] }); }
  catch (error) { refused = /拒絕啟動/.test(error.message); }
  check(refused, '★ claude strict 對不到的能力仍拒絕啟動（不放寬）');
}

// 2c. 工具集為空（純產出、空陣列）：variadic 旗標不能帶空字串值。
//     Windows 經 cmd.exe 時空字串參數會消失，旗標就把下一個旗標吃成值——
//     2026-09-16 實測過 --allowedTools 空值吃掉整組 --disallowedTools、寫入完全擋不住。
for (const capabilities of [['analysis/produce'], []]) {
  const built = plan({ model: 'opus', capabilities });
  const args = built.args;
  const label = JSON.stringify(capabilities);
  check(
    args.every((a) => a !== ''),
    `★ claude strict 零工具時沒有空字串參數（${label}）`,
    args.join(' ')
  );
  check(
    args.includes('--tools=') && !args.includes('--tools') && !args.includes('--allowedTools'),
    `★ claude strict 零工具時以 --tools= 停用全部工具（${label}）`,
    args.join(' ')
  );
  check(
    args.includes('--restricted') && args.includes('--disallowedTools')
      && args.every((a) => !/dangerous/i.test(a)),
    `★ claude strict 零工具時仍有 --restricted 與黑名單、零危險旗標（${label}）`,
    args.join(' ')
  );
}

// 3. codex 的 read-only sandbox。
{
  const built = plan({ model: 'gpt-5.3-codex', capabilities: ['fs/read'] });
  const noDanger = built.args.every((a) => !/dangerous/i.test(a));
  const idx = built.args.indexOf('--sandbox');
  check(
    noDanger && idx >= 0 && built.args[idx + 1] === 'read-only',
    '★ capabilities → strict builder（codex：--sandbox read-only、零危險旗標）',
    built.args.join(' ')
  );
  check(!built.args.includes('--ephemeral'), '★ codex strict 新開保留 session（無 --ephemeral）');
  // Windows 使用 OS 唯讀沙箱；提示只進 stdin，原 prompt 不變。
  check(
    built.prompt === 'hi'
      && (process.platform === 'win32'
        ? built.stdinPrompt.startsWith('【ai-cli 唯讀模式（Windows）】') && built.stdinPrompt.endsWith('\n\nhi')
        : built.stdinPrompt === 'hi'),
    '★ codex strict 在 Windows 的 stdin 前綴讀檔提示（OS 沙箱），其他平台原樣',
    JSON.stringify({ platform: process.platform, prompt: built.prompt, stdin: built.stdinPrompt?.slice(0, 40) })
  );
}

// 續接使用 resume 接受的 TOML 設定；不能繼承一般 session 的可寫權限。
{
  const built = plan({ model: 'gpt-6.1-sol', session_id: 'strict-session', reasoning_effort: 'low', capabilities: ['fs/read', 'analysis/produce'] });
  const i = built.args.indexOf("sandbox_mode='read-only'");
  check(
    built.args.slice(0, 3).join(' ') === 'exec resume strict-session'
      && !built.args.includes('--sandbox') && i > 0 && built.args[i - 1] === '-c'
      && built.args.every(a => !/dangerous/i.test(a))
      && !built.args.includes('--ephemeral') && built.args.includes('--ignore-user-config')
      && built.args.includes('--skip-git-repo-check') && built.args.includes('--json') && built.args.at(-1) === '-',
    '★ codex strict 續接以 TOML 單引號設定唯讀、無 --sandbox、保留 session',
    built.args.join(' ')
  );
  for (const sessionId of [undefined, 'normal-session']) {
    const normal = plan({ model: 'gpt-6.1-sol', session_id: sessionId, reasoning_effort: 'low' });
    check(
      JSON.stringify(normal.args) === JSON.stringify([
        'exec', ...(sessionId ? ['resume', sessionId] : []),
        '-c', 'model_reasoning_effort=low', '--model', 'gpt-6.1-sol',
        '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', '-',
      ]) && normal.stdinPrompt === 'hi',
      `★ codex 一般模式完整 argv 不變（${sessionId ? '續接' : '新開'}）`,
      normal.args.join(' ')
    );
  }
  let refused = false;
  try { plan({ model: 'gpt-6.1-sol', session_id: 'strict-session', capabilities: ['fs/write'] }); }
  catch (error) { refused = /拒絕啟動/.test(error.message); }
  check(refused, '★ codex strict 續接不支援能力仍 fail-closed');
}

// issue24：只組 argv／解析合成事件，不啟動 CLI 或模型。
const { codexAgent, codexSandboxWarning, CODEX_WINDOWS_READ_ONLY_HINT } = await import(pathToFileURL(join(ROOT, 'dist/agents/codex.js')).href);
const commandEvent = (output, extra = {}) => ({ type: 'item.completed', item: { type: 'command_execution', command: 'Get-Content target.txt', aggregated_output: output, exit_code: 1, ...extra } });
const sandboxErrors = ['CreateProcessAsUserW failed: 5', 'helper_unknown_error', 'setup refresh had errors', 'windows sandbox failed'];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
try {
  for (const platform of ['win32', 'linux', 'darwin']) {
    Object.defineProperty(process, 'platform', { value: platform });
    for (const sessionId of [undefined, 'strict-session']) {
      const built = codexAgent.buildStrictCommand({ cliPath: 'codex', cwd: ROOT, prompt: 'hi', resolvedModel: 'codex', rawModel: 'codex', reasoningEffort: 'low', sessionId }, ['fs/read']);
      const label = sessionId ? '續接' : '新開';
      const idx = built.args.indexOf("windows.sandbox='elevated'");
      check(built.args.includes('--ignore-rules') && built.args.includes('--ignore-user-config') && built.strict === true,
        `issue24 strict ${label} 忽略規則並標記 strict（${platform}）`);
      check(platform === 'win32' ? idx > 0 && built.args[idx - 1] === '-c' : !built.args.some(a => a.includes('windows.sandbox')),
        `issue24 strict ${label} 僅 Windows 使用 elevated（${platform}）`);
      check(platform === 'win32' ? built.stdinPrompt === CODEX_WINDOWS_READ_ONLY_HINT + '\n\nhi' : built.stdinPrompt === 'hi',
        `issue24 strict ${label} 提示僅進 Windows stdin（${platform}）`);
    }
  }
} finally { Object.defineProperty(process, 'platform', platformDescriptor); }
check(['OS 唯讀沙箱', '--ignore-rules', '讀檔可正常使用', '回報原始錯誤', '不要換寫法無限重試', '不要要求提權'].every(x => CODEX_WINDOWS_READ_ONLY_HINT.includes(x))
  && !/沒有沙箱|安全清單|不要用管線|cmd \/c/.test(CODEX_WINDOWS_READ_ONLY_HINT), 'issue24 提示說明 OS 沙箱與錯誤處置');
const withPlatform = (platform, fn) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try { Object.defineProperty(process, 'platform', { value: platform }); return fn(); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
};
withPlatform('win32', () => {
check(sandboxErrors.every(error => ['output', 'itemError', 'eventError'].every(location => {
  const event = commandEvent(location === 'output' ? error : '', location === 'itemError' ? { error: { message: error } } : {});
  if (location === 'eventError') { event.type = 'item.failed'; event.error = { message: error }; }
  const warning = codexSandboxWarning(event, true);
  const parsed = codexAgent.parseOutput(JSON.stringify(event), '', 0, { strict: true });
  return warning?.code === 'windows_sandbox_unavailable' && warning.detail.includes(error) && parsed?.sandbox_warning?.code === warning.code;
})), 'issue24 strict 解析四種沙箱初始化錯誤（含工具 error、vendor exit 0）');
check([false, undefined].every(strict => sandboxErrors.every(error => !codexSandboxWarning(commandEvent(error), strict)
  && !codexAgent.parseOutput(JSON.stringify(commandEvent(error)), '', 0, { strict })?.sandbox_warning)), 'issue24 一般與舊 job 不加沙箱警示');
check([
  { type: 'item.completed', item: { type: 'agent_message', text: sandboxErrors.join(' '), aggregated_output: sandboxErrors.join(' ') } },
  { type: 'item.completed', item: { type: 'reasoning', text: sandboxErrors.join(' ') } },
  commandEvent('ok', { command: sandboxErrors.join(' '), exit_code: 0 }),
  { ...commandEvent(sandboxErrors[0]), type: 'item.started' },
  commandEvent('PermissionDenied: Access to the path canary.txt is denied'),
].every(event => !codexSandboxWarning(event, true)), 'issue24 模型文字、command、未完成事件與正常寫入拒絕不冒充啟動失敗');
check(!codexAgent.parseOutput('invalid json\nnull', '', 0, { strict: true })?.sandbox_warning,
  'issue24 損毀輸出不捏造沙箱警示');
check(sandboxErrors.every(error => !codexSandboxWarning(commandEvent(error, { exit_code: 0 }), true)
  && !codexAgent.parseOutput(JSON.stringify(commandEvent(error, { exit_code: 0 })), '', 0, { strict: true })?.sandbox_warning),
  'issue24-audit F1 成功讀檔或 echo 含錯誤字樣不警示');
check(sandboxErrors.every(error => !codexSandboxWarning(commandEvent('x'.repeat(300) + error), true)),
  'issue24-audit F1 輸出後段錯誤字樣不警示');
check(sandboxErrors.every(error => codexSandboxWarning(commandEvent(error, { exit_code: undefined }), true)?.code === 'windows_sandbox_unavailable'),
  'issue24-audit F1 缺 exit_code 的初始化錯誤仍警示');
});
check(['linux', 'darwin'].every(platform => withPlatform(platform, () => sandboxErrors.every(error =>
  !codexSandboxWarning(commandEvent(error), true)
  && !codexAgent.parseOutput(JSON.stringify(commandEvent(error)), '', 0, { strict: true })?.sandbox_warning))),
  'issue24-audit F1 非 Windows 不警示');
check(!/elevated|windows\.sandbox/.test(CODEX_WINDOWS_READ_ONLY_HINT), 'issue24-audit F4 模型提示不提 elevated 設定');
// 用持久化合成 job 驗證重啟後增量解析、截尾及 compact/verbose，不啟動 runner。
const { JobStore, jobResult } = await import(pathToFileURL(join(ROOT, 'dist/core/job-store.js')).href);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'issue24-results-'));
try {
// 攔截 spawn 前的 launch spec，驗證真實啟動資料；不啟動 runner 或模型。
const metadataStore = new JobStore(fixtureRoot, 'cli', true, async () => new Map());
await metadataStore.ready;
const originalSpawn = childProcess.spawn;
const launchMetas = [];
let intercepted = 0;
try {
  childProcess.spawn = (_command, args) => {
    if (!/job-(?:launcher|runner)\.js$/.test(args[0])) throw new Error('unexpected fixture launch');
    launchMetas.push(JSON.parse(readFileSync(join(args[1], 'launch.tmp'), 'utf8')).meta);
    throw new Error('issue24 fixture stopped before spawn');
  };
  syncBuiltinESMExports();
  for (const strict of [true, false]) {
    const cmd = plan({ model: 'codex', ...(strict ? { capabilities: ['fs/read'] } : {}) });
    try { await metadataStore.start(cmd); }
    catch (error) { if (error.message.includes('issue24 fixture stopped before spawn')) intercepted++; }
  }
} finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
check(intercepted === 2 && launchMetas[0]?.strict === true && launchMetas[1] && !Object.hasOwn(launchMetas[1], 'strict'),
  'issue24 啟動 metadata 保存 strict 身分');
for (const strict of [true, false, undefined]) {
  const jobId = randomUUID(), directory = join(fixtureRoot, 'jobs', jobId), pid = 98760 + (strict === true ? 1 : strict === false ? 2 : 3);
  mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  const meta = { version: 1, jobId, pid, agent: 'codex', resolvedModel: 'codex', task: 'fixture', workFolder: fixtureRoot,
    startTime: now, source: 'cli', principal: null, server: null, recoverable: true, runner: { pid, started: now }, worker: null, ...(strict === undefined ? {} : { strict }) };
  writeFileSync(join(directory, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(directory, 'stdout.log'), JSON.stringify(commandEvent(sandboxErrors[0])) + '\n'
    + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture '.repeat(1400) } }) + '\n');
  writeFileSync(join(directory, 'exit.json'), JSON.stringify({ exitCode: 0, signal: null, endTime: now, timedOut: false, killed: false }));
  const store = new JobStore(fixtureRoot, 'cli', true, async () => new Map());
  await store.ready;
  const job = store.get(pid, jobId);
  const compact = jobResult(job), verbose = jobResult(job, true);
  check([compact, verbose].every(result => strict === true && process.platform === 'win32'
    ? result.status === 'failed' && result.exitCode === 0 && result.agentOutput?.sandbox_warning?.detail.includes(sandboxErrors[0]) && result.agentOutput?.message.startsWith('fixture')
    : result.status === 'completed' && !result.agentOutput?.sandbox_warning),
    `issue24 持久化 job 警示跨截尾並反映狀態（${strict === true ? 'strict' : strict === false ? 'normal' : 'legacy'}）`);
}
} finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
check(!existsSync(fixtureRoot), 'issue24-audit F5 合成結果目錄於 finally 清除');
check(['src/app/mcp.ts', 'src/app/cli.ts'].every(file => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const descriptions = file.endsWith('mcp.ts') ? text.split('\n').filter(line => line.includes('codex gets') || line.includes('description: `AI Agent Runner:')) : [text];
  return descriptions.length === (file.endsWith('mcp.ts') ? 2 : 1) && descriptions.every(description => description.includes('--ignore-rules') && /windows.sandbox.*elevated/i.test(description) && description.includes('sandbox_warning'));
}), 'issue24 MCP 與 CLI 說明包含規則隔離、elevated 與警示');

// 4. 空陣列 ≠ 沒給。折成同一件事，等於讓要求限制的呼叫端拿到全開權限而不自知。
{
  const built = plan({ model: 'opus', capabilities: [] });
  check(
    built.args.every((a) => !/dangerous/i.test(a)),
    '★ 空陣列仍走 strict（[] 是「什麼都不給」，不是「沒有意見」）',
    built.args.join(' ')
  );
}

// 5. fail-closed：沒有 strict builder 的 agent 要拒絕，不得退回一般模式。
{
  let threw = false;
  let message = '';
  try {
    plan({ model: 'or-some/model', capabilities: ['fs/read'] });
  } catch (error) {
    threw = true;
    message = error.message;
  }
  check(
    threw && /嚴格模式/.test(message),
    '★ 沒有 strict builder 的 agent → 拒絕啟動（不退回權限旁路）',
    message
  );
}

// 6. schema 真的收這個欄位——文件寫了但 schema 沒收，呼叫端會靜默失去限制。
{
  const mcpSrc = readFileSync(join(ROOT, 'src', 'app', 'mcp.ts'), 'utf-8');
  const declared = /capabilities:\s*\{\s*\n\s*type:\s*'array'/.test(mcpSrc);
  const forwarded = /capabilities:\s*\(toolArguments\.capabilities as unknown\[\]\)/.test(mcpSrc);
  check(declared, 'run 的 inputSchema 宣告了 capabilities');
  check(
    forwarded,
    '★ handler 真的把它轉送給 startProcess（宣告了卻沒轉送＝呼叫端以為有限制）'
  );
}

// 7. 兩條啟動路徑都要支援。只有一條擋得住，呼叫端要看運氣。
{
  const ps = readFileSync(join(ROOT, 'src', 'core', 'process-service.ts'), 'utf-8');
  const fps = readFileSync(join(ROOT, 'src', 'core', 'file-process-service.ts'), 'utf-8');
  check(
    /capabilities\?: readonly string\[\]/.test(ps) && /capabilities\?: readonly string\[\]/.test(fps),
    '★ process-service 與 file-process-service 都收 capabilities'
  );
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
