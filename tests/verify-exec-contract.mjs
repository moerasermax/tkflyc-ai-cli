/**
 * `ai-cli exec` 前景契約 ＋ `lost` ≠ `failed` 的回歸測試。
 *
 * ── 這一支守什麼 ──────────────────────────────────────────────
 * exec 存在的理由是「呼叫端要自己擁有這個程序」。三條規則若破了，
 * 呼叫端會**在不知情的情況下**拿到錯的資訊：
 *
 *   1. 能力 fail-closed —— 沒有嚴格模式就拒絕，不退回權限旁路。
 *      破了的樣子：畫面說「唯讀」，程序其實全開。
 *   2. terminal frame 等三個 EOF —— child close / stdout / stderr。
 *      破了的樣子：最後幾個 byte 在「已完成」之後才到，而呼叫端
 *      已經把那次執行封存了。
 *   3. stdout 走 base64 —— 多位元字元跨 chunk 不得被切壞。
 *
 * 外加 S2c：PID 不見且沒有結束回報時必須是 `lost`，不是 `failed`。
 *
 * 用法：node verify-exec-contract.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'dist', 'bin', 'ai-cli.js');

const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  // 格式與其他 verify 腳本一致：tools/mutation-test.mjs 靠「含 `FAIL ` 的行」
  // 判定突變有沒有被對應斷言殺掉；印成 `[FAIL]` 會讓它一條都對不上。
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 跑一次 exec，回傳解析後的 frames。 */
function runExec(request) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'exec'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    // 每個 chunk 各自 toString 會切斷跨界的多位元組字元，改由 stream 內部處理。
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (err += c));
    child.on('close', (code) => {
      const frames = out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { parseError: line };
          }
        });
      resolve({ frames, stderr: err, code });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const load = (rel) => import(pathToFileURL(join(ROOT, 'dist', rel)).href);

console.log('== ai-cli exec 前景契約 ==');

const registry = await load('agents/registry.js');

// ── 1. 能力 fail-closed ───────────────────────────────────────
{
  const noStrict = await runExec({
    cwd: ROOT,
    model: 'or-some/model', // direct-api：沒有 buildStrictCommand
    prompt: 'hi',
    capabilities: ['fs/read'],
  });
  const terminal = noStrict.frames.at(-1);
  check(
    terminal?.type === 'terminal' && terminal.status === 'spawn-failed',
    '★ 沒有嚴格模式的 agent → 拒絕啟動（不退回權限旁路）',
    terminal?.detail ?? JSON.stringify(terminal)
  );
  check(
    typeof terminal?.detail === 'string' && terminal.detail.length > 0,
    '★ 拒絕時要說出為什麼（不是靜默失敗）'
  );

  const badCapability = await runExec({
    cwd: ROOT,
    model: 'opus',
    prompt: 'hi',
    capabilities: ['fs/write'], // claude 的嚴格模式給不出寫入保證
  });
  const t2 = badCapability.frames.at(-1);
  check(
    t2?.type === 'terminal' && t2.status === 'spawn-failed',
    '★ 給不出保證的能力 → 拒絕，而不是放寬',
    t2?.detail ?? ''
  );
}

// ── 1b. 明確的 unrestricted 模式（2026-08-17，OmniMesh 全權員工）──
//
// fail-closed 的預設**一個字都不動**：沒帶 `authority` 的請求與從前
// 完全一樣。新增的是一條**明確**的鬆綁：呼叫端寫出 `authority:
// 'unrestricted'`（它自己要對「這是人授權的」負責），exec 才用該
// vendor 的一般組裝（帶 `--dangerously-*`）。started frame 回報實際
// 生效的模式，讓呼叫端驗得到——版本不合時呼叫端據此拒絕解讀，
// 不會發生「以為全權、其實受限」或反過來的靜默錯位。
{
  // 語義衝突不猜：authority 與 capabilities 同時出現 → 拒絕
  const ambiguous = await runExec({
    cwd: ROOT,
    model: 'opus',
    prompt: 'hi',
    authority: 'unrestricted',
    capabilities: ['fs/read'],
  });
  const tAmb = ambiguous.frames.at(-1);
  check(
    tAmb?.type === 'terminal' &&
      tAmb.status === 'spawn-failed' &&
      // ★ 斷言到拒絕理由：機器上缺 CLI 也會 spawn-failed，那是假綠
      /authority/.test(tAmb.detail ?? ''),
    '★ authority 與 capabilities 同時出現 → 以「語義衝突」為由拒絕（不猜、不是碰巧缺 CLI）',
    tAmb?.detail ?? JSON.stringify(tAmb)
  );

  // 未知的 authority 值 → 拒絕（不是當成沒寫）
  const bogus = await runExec({
    cwd: ROOT,
    model: 'opus',
    prompt: 'hi',
    authority: 'yolo',
  });
  const tBogus = bogus.frames.at(-1);
  check(
    tBogus?.type === 'terminal' &&
      tBogus.status === 'spawn-failed' &&
      /authority/.test(tBogus.detail ?? ''),
    "★ authority 只認 'unrestricted' 字面值，其他值以此為由拒絕（不是當成沒寫）",
    tBogus?.detail ?? ''
  );

  // 決策邏輯直測（不 spawn、不花錢）：dist 匯出 planExec
  const execMod = await load('app/exec.js');
  check(
    typeof execMod.planExec === 'function',
    '★ exec 的決策邏輯（planExec）可直測——authority 分支不靠花錢的整跑驗',
  );
  if (typeof execMod.planExec === 'function') {
    const un = execMod.planExec({
      cwd: ROOT,
      model: 'opus',
      prompt: 'hi',
      authority: 'unrestricted',
    });
    check(
      un.authority === 'unrestricted' &&
        un.built.args.some((a) => /dangerous/i.test(a)),
      '★ unrestricted（claude）→ 一般組裝（帶旁路旗標），authority 回報 unrestricted',
      un.built.args.join(' ')
    );
    const unCodex = execMod.planExec({
      cwd: ROOT,
      model: 'codex/gpt-5.3-codex',
      prompt: 'hi',
      authority: 'unrestricted',
    });
    check(
      unCodex.authority === 'unrestricted' &&
        unCodex.built.args.includes('--dangerously-bypass-approvals-and-sandbox'),
      '★ unrestricted（codex）→ --dangerously-bypass-approvals-and-sandbox',
      unCodex.built.args.join(' ')
    );
    const scoped = execMod.planExec({
      cwd: ROOT,
      model: 'opus',
      prompt: 'hi',
      capabilities: ['fs/read'],
    });
    check(
      scoped.authority === 'scoped' &&
        scoped.built.args.every((a) => !/dangerous/i.test(a)),
      '★ 沒帶 authority → 嚴格路徑照舊（scoped、零危險旗標）',
      scoped.built.args.join(' ')
    );
    let threw = false;
    try {
      execMod.planExec({ cwd: ROOT, model: 'or-some/model', prompt: 'hi', capabilities: [] });
    } catch {
      threw = true;
    }
    check(threw, '★ 對照組：沒有嚴格模式的 agent 在**不帶 authority** 時仍被拒（fail-closed 沒動）');
  }

  // started frame 必須回報生效模式（呼叫端的唯一確認點）
  const { readFileSync } = await import('node:fs');
  const execSrc = readFileSync(join(ROOT, 'src', 'app', 'exec.ts'), 'utf-8');
  check(
    // 釘到**值的來源**而不是只釘欄位名：型別已經逼著 authority 必須存在
    // （拿掉就編不過），所以「有這個字」是白抓的。會出事的是欄位還在、
    // 值卻寫死成某個字面值——那樣呼叫端看到的模式與實際生效的不是同一件事。
    /type: 'started'[\s\S]{0,400}?authority: plan\.authority/.test(execSrc),
    '★ started frame 帶 authority 欄位（執行端回報實際生效的模式）'
  );
}

// ── 2. 嚴格模式**絕不**帶危險旗標 ─────────────────────────────
{
  for (const id of ['claude', 'codex', 'antigravity']) {
    const agent = registry.getAgent(id);
    check(
      typeof agent.buildStrictCommand === 'function',
      `${id} 有嚴格模式`
    );
    const strict = agent.buildStrictCommand(
      { cliPath: 'X', cwd: '.', prompt: 'p', resolvedModel: 'm', rawModel: 'm', reasoningEffort: '' },
      ['fs/read']
    );
    const dangerous = strict.args.filter((a) => /dangerous/i.test(a));
    check(
      dangerous.length === 0,
      `★ ${id} 的嚴格模式零危險旗標（一般模式有，這正是兩者的差別）`,
      dangerous.join(',')
    );
    // 對照：一般模式**應該**還帶著旁路（沒帶反而代表我改錯了地方）
    const normal = agent.buildCommand({
      cliPath: 'X',
      cwd: '.',
      prompt: 'p',
      resolvedModel: 'm',
      rawModel: 'm',
      reasoningEffort: '',
    });
    check(
      normal.args.some((a) => /dangerous/i.test(a)),
      `對照組：${id} 的一般模式仍帶旁路（確認我改的是新路徑，不是既有行為）`
    );
  }
}

// ── 3. 協定形狀 ───────────────────────────────────────────────
{
  // 用一個一定不存在的 CLI 觸發 spawn 失敗，驗 frame 結構而不花錢
  const previous = process.env.CLAUDE_CLI_NAME;
  process.env.CLAUDE_CLI_NAME = 'definitely-not-a-real-binary-xyz';
  const missing = await runExec({
    cwd: ROOT,
    model: 'opus',
    prompt: 'hi',
    capabilities: ['fs/read'],
  });
  if (previous === undefined) delete process.env.CLAUDE_CLI_NAME;
  else process.env.CLAUDE_CLI_NAME = previous;

  const last = missing.frames.at(-1);
  check(
    last?.type === 'terminal',
    '★ 任何結束路徑都必須以 terminal frame 收尾（呼叫端靠它判斷「說完了」）',
    JSON.stringify(last)
  );
  check(
    missing.frames.every((f) => f.v === 1),
    '每個 frame 都帶協定版本 v（呼叫端要能拒絕未知版本）'
  );
  const bad = missing.frames.filter((f) => f.parseError !== undefined);
  check(bad.length === 0, '★ stdout 只有合法 NDJSON（診斷訊息不得混進協定）', bad.length ? bad[0].parseError : '');
}

// ── 4. exec 不得用立即 process.exit（最後一個 frame 會掉） ────
{
  const { readFileSync } = await import('node:fs');
  const bin = readFileSync(join(ROOT, 'src', 'bin', 'ai-cli.ts'), 'utf-8');
  check(
    /isExec/.test(bin) && /process\.exitCode = exitCode/.test(bin),
    '★ exec 走 exitCode 而非立即 exit（stdout 是 pipe 時最後一個 frame 會掉）'
  );
}

// ── 5. S2c：lost ≠ failed ─────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'src', 'core', 'file-process-service.ts'), 'utf-8');
  check(
    /status: 'running' \| 'completed' \| 'failed' \| 'lost'/.test(src),
    "★ 狀態union 有 'lost'（沒收到結束回報 ≠ 失敗）"
  );
  check(
    !/proc\.status = 'failed';/.test(src),
    "★ 「PID 不見且無 exit-status」不得再寫成 failed",
  );
  check(
    /proc\.status = 'lost';/.test(src),
    '★ 該情境改記 lost（照實說「不知道」，而不是編一個結論）'
  );
  check(
    /status: 'lost', exitCode: SIGTERM_EXIT_CODE/.test(src),
    '★ 砍掉但沒拿到結束回報 → lost（「被砍」不等於「失敗」）'
  );
}

// ── 6. ai-cli 啟動的 vendor CLI 一律帶 worker 標記 ────────────
// 用實際子行程寫檔驗證；父行程不預設標記，並覆寫衝突值，避免只驗到繼承而假綠。
{
  const { mkdtempSync, chmodSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolve, basename } = await import('node:path');
  const { ProcessService } = await load('core/process-service.js');
  const { FileProcessService } = await load('core/file-process-service.js');
  const temp = mkdtempSync(join(tmpdir(), 'ai-cli-worker-env-'));
  const stubJs = join(ROOT, 'tools', 'stubs', 'worker-env.mjs');
  const stub = process.platform === 'win32' ? join(ROOT, 'tools', 'stubs', 'worker-env.cmd') : stubJs;
  if (process.platform !== 'win32') chmodSync(stub, 0o755);
  const keys = ['AI_CLI_WORKER', 'AI_CLI_WORKER_ENV_OUTPUT', 'AI_CLI_WORKER_ENV_SENTINEL', 'CODEX_CLI_NAME'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const assertEnv = (label, output) => {
    const received = JSON.parse(readFileSync(output, 'utf8'));
    check(received.worker === '1', `${label} 子行程收到 AI_CLI_WORKER=1`, JSON.stringify(received));
    check(received.inherited === 'keep-parent-env', `${label} 子行程保留其他環境變數`);
  };
  try {
    process.env.AI_CLI_WORKER_ENV_SENTINEL = 'keep-parent-env';
    for (const parentValue of [undefined, '0']) {
      if (parentValue === undefined) delete process.env.AI_CLI_WORKER;
      else process.env.AI_CLI_WORKER = parentValue;
      const label = `ProcessService（父值 ${parentValue ?? '未設定'}）`;
      const output = join(temp, `process-${parentValue ?? 'unset'}.json`);
      process.env.AI_CLI_WORKER_ENV_OUTPUT = output;
      const service = new ProcessService({ cliPaths: { codex: stub, claude: stub, antigravity: stub } });
      const run = service.startProcess({ model: 'gpt-6.1-sol', prompt: 'capture worker env', workFolder: ROOT });
      const [result] = await service.waitForProcesses([run.pid], 10);
      check(result.status === 'completed' && result.exitCode === 0, `${label} stub 成功結束`);
      assertEnv(label, output);
      check(process.env.AI_CLI_WORKER === parentValue, `${label} 不改父行程環境`);
    }

    // Windows 的 Node wrapper / POSIX 的 sh wrapper 必須把環境傳到真正的 CLI。
    const fileOutput = join(temp, 'detached.json');
    process.env.AI_CLI_WORKER_ENV_OUTPUT = fileOutput;
    const fileService = new FileProcessService({ stateDir: join(temp, 'state'), cliPaths: { codex: stub } });
    const fileRun = await fileService.startProcess({ model: 'gpt-6.1-sol', prompt: 'capture detached env', cwd: ROOT });
    const [fileResult] = await fileService.waitForProcesses([fileRun.pid], 10);
    check(fileResult.status === 'completed' && fileResult.exitCode === 0, 'FileProcessService wrapper stub 成功結束');
    assertEnv('FileProcessService wrapper', fileOutput);

    const discoveryOutput = join(temp, 'discovery.json');
    process.env.AI_CLI_WORKER_ENV_OUTPUT = discoveryOutput;
    const discovery = await registry.getAgent('antigravity').discoverModels(stub);
    check(discovery.models?.includes('gemini-worker-stub'), 'agy models stub 成功結束');
    assertEnv('agy models', discoveryOutput);

    // exec 在 Windows 不接受 .cmd shim；測試 runner 只替換 command builder 為 Node stub。
    // runExec 本身的 spawn、環境設定與 frame 契約照正式路徑執行。
    const execOutput = join(temp, 'exec.json');
    process.env.AI_CLI_WORKER_ENV_OUTPUT = execOutput;
    process.env.CODEX_CLI_NAME = process.execPath;
    const runner = join(temp, 'exec-stub-runner.mjs');
    writeFileSync(runner, `
import { getAgent } from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist', 'agents', 'registry.js')).href)};
import { runExec } from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist', 'app', 'exec.js')).href)};
getAgent('codex').buildCommand = (input) => ({
  cliPath: process.execPath, args: [${JSON.stringify(stubJs)}], cwd: input.cwd,
  agent: 'codex', prompt: input.prompt, stdinPrompt: input.prompt,
});
process.exitCode = await runExec();
`);
    const execResult = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolveResult({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ cwd: ROOT, model: 'codex/gpt-6.1-sol', prompt: 'capture exec env', authority: 'unrestricted' }));
    });
    const terminal = execResult.stdout.trim().split('\n').map((line) => JSON.parse(line)).at(-1);
    check(execResult.code === 0 && terminal?.type === 'terminal' && terminal.status === 'succeeded' && terminal.exitCode === 0,
      'exec stub 成功結束', execResult.stderr || JSON.stringify(terminal));
    assertEnv('exec', execOutput);
  } catch (error) {
    check(false, 'worker 環境測試完整執行', error.stack ?? String(error));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('ai-cli-worker-env-')) {
      throw new Error(`Unexpected worker test cleanup path: ${temp}`);
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

const passed = results.filter(([ok]) => ok).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
if (passed !== results.length) {
  for (const [ok, name] of results) if (!ok) console.log(`  FAILED: ${name}`);
  process.exitCode = 1;
}
