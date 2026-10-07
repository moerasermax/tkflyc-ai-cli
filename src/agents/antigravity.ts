/**
 * Antigravity CLI (agy) — Google Gemini 後繼 CLI (2026/05)。
 *
 * 關鍵：agy.exe 在 stdout 不是 TTY 時會靜默不輸出。所以 win32 必須走 ConPTY
 * （spawnMode pty）。
 *
 * ★ 2026-07-31 更正：舊註解寫「模型由 CLI 內部決定，不接受 --model flag」，
 *   那是 v1.0.x 的事實。v1.1.9 實測有 `--model`、`--output-format
 *   text|json|stream-json`、`--sandbox`、`--mode plan`、
 *   `--disable-slash-commands`，而且 `agy models` 回 11 個模型。
 *   模型清單改為向 CLI 動態查詢，靜態清單降級為標示過的後備值。
 *
 * 行為 1:1 還原 dist：cli-builder.js antigravity 分支 + parsers.js parseAntigravityOutput
 * + process-service.js _startAntigravityPty。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { withWorkerContext } from '../core/worker-context.js';
import { buildWorkerEnv } from '../core/worker-env.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand, ModelDiscoveryResult } from './types.js';

/**
 * 靜態後備清單。**只有在問不到 `agy models` 時才會被用到。**
 *
 * ★ 這份清單曾經是錯的，而且錯得沒有人看得出來：它宣稱 agy 只有四個
 *   模型、且「不接受 --model」。實測 v1.1.9 有 11 個模型（id 形如
 *   `gemini-3.6-flash-high`，還包含 `claude-sonnet-4-6`、
 *   `gpt-oss-120b-medium`——agy 自己就代理多家），而且 `--model` 早就支援。
 *
 *   所以現在的第一來源是 `discoverModels()` 去問 CLI，
 *   而這份清單對外一律標成 `builtin-fallback`。
 *   保留 'agy'/'agy-default' 是為了讓既有的 alias 路由不斷。
 */
const ANTIGRAVITY_FALLBACK_MODELS = [
  'agy',
  'agy-default',
  'gemini-3.1-pro-high',
  'gemini-3.5-flash-high',
] as const;

/**
 * `agy models` 是網路呼叫，會先做 loadCodeAssist eligibility check。
 * 2026-09-05 agy 1.1.26 暖機八次：1739 / 1755 / 1762 / 1838 / 1906 /
 * 2487 / 2729 / 3972 ms；網路尾延遲可能超過舊的 5 秒上限，並非本機讀設定。
 * 非同步 + 快取才是避免卡住 MCP 的解法；15 秒只限制背景／明確查詢的等待。
 */
const DISCOVER_TIMEOUT_MS = 15_000;

/** Windows 的 .cmd 有 shell 子層，必須連子程序一起終止。 */
function killDiscovery(child: ChildProcess): void {
  if (!child.pid) return;
  const killParent = (): void => {
    try { child.kill('SIGKILL'); } catch { /* 已退出或 OS 拒絕；不可讓計時器拋例外。 */ }
  };
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', killParent);
      killer.on('exit', (code) => { if (code !== 0) killParent(); });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    killParent();
  }
}

/** agy 的模型 id：小寫英數開頭，只含小寫英數、點與連字號。與 normalizeAgyModel 同一套。 */
const AGY_MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * 解析 `agy models` 的 stdout。
 *
 * ★ 2026-08-22 修正：舊版用「整行不含空白」當過濾條件，但 v1.1.17 的真實輸出是
 *   `<id>\t<顯示名稱>`（`gemini-3.1-pro-high\tGemini 3.1 Pro (High)`），顯示名稱必然
 *   帶空白 —— 於是**每一行都被濾掉**，discoverModels 永遠回 null，目錄永遠降級成
 *   builtin-fallback。降級本身標示得誠實，所以它看起來像「agy 查不到」而不像 bug。
 *
 *   現在改成取每行第一個空白分隔欄位，且必須長得像模型 id。開頭那行
 *   `Fetching available models...` 的第一欄是 `Fetching`，大寫開頭，自動出局。
 */
export function parseAgyModelsOutput(stdout: string): readonly string[] | null {
  if (typeof stdout !== 'string') return null;
  const ids = stdout
    .split(/\r?\n/)
    /*
      先剝掉 ANSI 跳脫序列。有些 CLI 即使輸出到 pipe 也會上色，而帶了跳脫字元的
      id 會通不過下面的樣式檢查、整行被丟掉——那正是這次要修掉的靜默失敗形狀。
    */
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter((id) => AGY_MODEL_ID.test(id));
  return ids.length > 0 ? [...new Set(ids)] : null;
}

/**
 * 問 agy 現在支援哪些模型。
 *
 * 失敗一律回 models: null（CLI 不在、逾時、非零退出、輸出空）與原因——
 * **不得回半套清單**，那會讓呼叫端以為問到了。
 */
function discoverModels(cliPath: string): Promise<ModelDiscoveryResult> {
  return new Promise((resolve) => {
    const configured = Number(process.env.AI_CLI_DISCOVER_TIMEOUT_MS);
    const timeoutMs = Number.isInteger(configured) && configured > 0 && configured <= 2_147_483_647
      ? configured : DISCOVER_TIMEOUT_MS;
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (models: readonly string[] | null, note: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ models, note });
    };
    try {
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
      child = spawn(needsShell ? (process.env.ComSpec || 'cmd.exe') : cliPath,
        needsShell ? ['/d', '/s', '/c', `""${cliPath}" models"`] : ['models'], {
          env: buildWorkerEnv(),
          windowsHide: true,
          windowsVerbatimArguments: needsShell,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (data: string) => { if (!settled) stdout += data; });
      child.stderr!.on('data', (data: string) => { if (!settled) stderr += data; });
      child.on('error', (error) => finish(null, error.message));
      timer = setTimeout(() => {
        killDiscovery(child);
        finish(null, `\`agy models\` 逾時（>${timeoutMs} ms）`);
      }, timeoutMs);
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(null, stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
            ?? `\`agy models\` 非零退出（${code}）`);
          return;
        }
        /*
          **agy 說什麼就回報什麼**，不在這裡過濾。

          2026-08-22 的第一版把「本框架路由不到的名字」（agy 代理的 `claude-sonnet-4-6`、
          `claude-opus-4-6-thinking`、`gpt-oss-120b-medium`）在這裡就濾掉了。動機沒錯
          ——照單全收會讓 `run` 的候選名單多出「列得出來、選了卻被 claude 的 catch-all
          接走」的選項——但做法錯了：目錄標著 `vendor-cli`（意思是「這一輪問過 CLI」），
          實際上卻默默少三筆，而「少了」這件事在輸出裡完全看不見。
          那正是 catalog-v2 這一層存在的理由所要防的病，只是換了個位置發作。

          現在改成：這一層說實話，「能不能派工」由目錄層的 `routable` 標記表達。
        */
        const models = parseAgyModelsOutput(stdout);
        finish(models, models === null ? '輸出裡沒有模型 id' : null);
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
    }
  });
}

/**
 * 把本框架用的模型名正規化成 agy CLI 的 `--model` 值。
 *
 * `Gemini 3.1 Pro (High)` → `gemini-3.1-pro-high`
 * `gemini-3.6-flash-high` → 原樣
 * `agy` / `agy-default`   → null（那是本框架的 alias，不是模型）
 * 認不出來的             → null（不傳 --model，回到 CLI 預設）
 *
 * 回 null 是刻意的保守：送一個 CLI 不認得的值會讓整個呼叫失敗，
 * 而不傳只是回到舊行為。**寧可少一個選項，不要多一個必定錯的呼叫。**
 */
export function normalizeAgyModel(model: string): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (trimmed === 'agy' || trimmed === 'agy-default') return null;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  // agy 的模型 id 只由小寫英數、點與連字號組成。其餘一律不傳。
  return AGY_MODEL_ID.test(normalized) ? normalized : null;
}

/**
 * 能力 → 這個 vendor 的嚴格限制。
 *
 * **給不出保證就丟例外**（fail-closed）。放寬是最糟的失敗方式：
 * 呼叫端以為有限制、畫面上寫著有限制，而程序其實全開。
 */
const AGY_SAFE_CAPABILITIES = new Set(['fs/read', 'analysis/produce']);

function buildStrictCommand(
  input: BuildCommandInput,
  capabilities: readonly string[]
): BuiltCommand {
  const { cliPath, cwd, resolvedModel, sessionId } = input;
  const prompt = withWorkerContext(input.prompt);
  for (const capability of capabilities) {
    if (!AGY_SAFE_CAPABILITIES.has(capability)) {
      throw new Error(
        `agy 的嚴格模式無法保證能力「${capability}」——拒絕啟動（不放寬）。`
      );
    }
  }
  /*
    與 buildCommand 的差別：**沒有 --dangerously-skip-permissions**。
      --sandbox                 終端限制
      --mode plan               不改檔案
      --disable-slash-commands  不展開使用者的 slash/skill

    ★ 誠實的邊界：agy 的 --help 沒有列出 --sandbox / --mode plan 的
      精確允許集合，也沒有等同 claude --allowedTools 的工具白名單。
      所以這裡只接受**唯讀類**能力；任何其他能力一律拒絕，
      而不是假設 plan 模式擋得住。
  */
  /*
    ★ 2026-09-10 對照實驗：**`--mode plan` 擋不住檔案寫入**，這三個旗標的組合
      給不出「不改檔案」的保證。原始證據（同一個 prompt「建立 probe.txt，直接動手做」，
      gemini-3.8-flash-low，各跑到模型自己結束、不是 timeout）：

        A  --sandbox --mode plan                            → 模型呼叫寫入工具，檔案建出來了
        B  --sandbox --mode plan --disable-slash-commands   → 同上，行為一模一樣

      B 另外會印 `warning: --mode plan has no effect while slash command expansion
      is disabled.`——一度以為那就是缺口，拿掉 --disable-slash-commands 就能換回
      「不改檔案」。**A 組推翻了這個推論**：plan 生效與否，模型照樣寫得出檔案。

      真正擋下來的是 `--sandbox`：兩組的檔案都落在 agy 自己的
      `~/.gemini/antigravity-cli/brain/<conversation_id>/`，**cwd 兩次都是空的**。
      第三組直接叫它寫一個 cwd 以外的絕對路徑，被 vendor 的工具層自己擋掉並回報：

        `write_to_file` 工具僅允許在指定工作區或 Artifact 路徑
        （…\brain\<conversation_id>\）內操作，無法直接將檔案寫入外部絕對路徑 …

      所以這裡的保證是「**寫不出 brain 目錄**」，不是「不寫檔」。
      對唯讀能力（fs/read、analysis/produce）而言這仍然成立——使用者的檔案動不到——
      但保證來自 vendor 的沙箱，不是來自 plan 模式。上面那段「不假設 plan 模式擋得住」
      的判斷是對的，這裡只是把它從推測換成實測。

      既然 plan 換不到東西，就把 --disable-slash-commands 保留——
      它至少擋掉 prompt 裡的 slash/skill 展開，是真的有作用的那一個。
  */
  const args = ['--sandbox', '--mode', 'plan', '--disable-slash-commands', '--output-format', 'json'];
  if (sessionId) args.push('--conversation', sessionId);
  const cliModel = normalizeAgyModel(resolvedModel);
  if (cliModel !== null) args.push('--model', cliModel);
  args.push('-p', prompt);
  return { cliPath, args, cwd, agent: 'antigravity', prompt, resolvedModel };
}

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, resolvedModel, sessionId } = input;
  const prompt = withWorkerContext(input.prompt);
  // - agy 用 --print (-p) 做非互動單次模式
  // - --dangerously-skip-permissions 自動核准工具呼叫
  // - cwd 自動作為 workspace
  // --output-format json：conversation_id 與 usage 只有這個格式拿得到（見 parseOutput）。
  const args = ['--dangerously-skip-permissions', '--output-format', 'json'];
  if (sessionId) {
    args.push('--conversation', sessionId);
  }
  /*
    ★ `--model` 曾經被註解成「不支援」，那是 v1.0.x 的事實，
      到 v1.1.9 已經不成立（`agy --help` 有 --model）。

      但**不能把 resolvedModel 原樣傳過去**：既有的 alias
      （`agy-ultra` → `Gemini 3.1 Pro (High)`）用的是 agy settings.json
      的顯示寫法，而 CLI 的 `--model` 只吃 `gemini-3.1-pro-high` 這種 id。
      原樣傳會讓每一次 agy 呼叫都失敗。先正規化，認不出來就**不傳**
      ——回到「由 CLI 決定」的舊行為，而不是送一個必定錯的值。
  */
  const cliModel = normalizeAgyModel(resolvedModel);
  if (cliModel !== null) {
    args.push('--model', cliModel);
  }
  args.push('-p', prompt);
  return { cliPath, args, cwd, agent: 'antigravity', prompt, resolvedModel };
}

/** `致 User\n---\n<body>\n---` 這個信封；剝不掉就原樣回。 */
function unwrapAgyBody(text: string): string {
  const trimmed = text.trim();
  const blockMatch = trimmed.match(/^致\s*User\s*\r?\n---\r?\n([\s\S]+?)\r?\n---\s*$/);
  return blockMatch ? blockMatch[1].trim() : trimmed;
}

/** agy 未回報快取；缺欄位保持 unknown，不補造 0。 */
function normalizeJobUsage(raw: any) {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!raw || !valid(raw.input_tokens) || !valid(raw.output_tokens)) return undefined;
  return {
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
    ...(valid(raw.thinking_tokens) ? { reasoning_output_tokens: raw.thinking_tokens } : {}),
    ...(raw.thinking_tokens !== undefined && !valid(raw.thinking_tokens) ? { incomplete: true } : {}),
    source: 'agy json',
  };
}

/**
 * agy --print 的輸出。
 *
 * ★ 2026-09-10：改吃 `--output-format json`。舊註解寫「沒有 JSON、沒有 token
 *   stats、沒有 session_id」——那是**只讀 text 格式**的結果，不是 CLI 的事實。
 *
 *   為什麼非改不可：`--conversation` 只認 agy 自己發的 id。呼叫端自編一個傳進去，
 *   agy 印 `warning: conversation "<id>" not found` 然後**開一個新的對話**
 *   （實測 2026-09-10）。所以拿不到 conversation_id ＝ 這個 agent 完全無法續接，
 *   而且失敗方式是靜默的：看起來有回答，其實每一回合都是新的。
 *
 *   v1.1.9 的 json 格式（實測原文）：
 *     {"conversation_id":"80a644dd-…","status":"SUCCESS",
 *      "response":"致 User\n---\n<body>\n---\n",
 *      "duration_seconds":8.36,"num_turns":2,
 *      "usage":{"input_tokens":31227,"output_tokens":545,"thinking_tokens":523,…}}
 *
 *   續接實測：同一個 id 第二回合答得出第一回合記住的字串，
 *   **id 不變**（與 codex 同語意，與 claude 的 fork 不同）、`num_turns` 1→2、
 *   `input_tokens` 15319→31227。
 *
 *   兩件不能省的事：
 *   ① warning 印在 JSON **前面**，所以不能對整段 `JSON.parse`，要逐行挑。
 *      而且那行 warning 是 resume 失敗的唯一訊號，必須保留給呼叫端判定，
 *      不能因為換了格式就把它吞掉（吞掉＝把 unknown 折進 ok）。
 *   ② text 解析保留成 fallback：舊版 agy、或哪天 json 格式又變，
 *      至少本文還拿得到，不要為了新欄位把既有能力弄丟。
 */
function parseOutput(stdout: string): unknown {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/);
  const preamble: string[] = [];
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) {
      if (candidate) preamble.push(candidate);
      continue;
    }
    let parsed: {
      conversation_id?: unknown;
      status?: unknown;
      response?: unknown;
      usage?: unknown;
      num_turns?: unknown;
    };
    try {
      parsed = JSON.parse(candidate) as typeof parsed;
    } catch {
      // 這一行不是完整的 JSON（可能是本文裡剛好以 { 開頭）——繼續往下找。
      if (candidate) preamble.push(candidate);
      continue;
    }
    if (typeof parsed.response !== 'string') continue;
    const usage = normalizeJobUsage(parsed.usage);
    return {
      message: unwrapAgyBody(parsed.response),
      ...(usage ? { usage } : {}),
      ...(typeof parsed.conversation_id === 'string' && parsed.conversation_id !== ''
        ? { session_id: parsed.conversation_id }
        : {}),
      ...(typeof parsed.status === 'string' ? { status_text: parsed.status } : {}),
      ...(parsed.usage !== undefined && parsed.usage !== null ? { tokens: parsed.usage } : {}),
      ...(typeof parsed.num_turns === 'number' ? { num_turns: parsed.num_turns } : {}),
      // `warning: conversation "…" not found` 會落在這裡。呼叫端據此判 resume 失敗。
      ...(preamble.length > 0 ? { warnings: preamble } : {}),
    };
  }

  // fallback：text 格式（或 json 解析全數落空）。
  return { message: unwrapAgyBody(trimmed) };
}

function resolveAntigravityLocalPath(): string {
  return process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    : join(homedir(), '.agy', 'bin', 'agy');
}

/**
 * 路由：agy / agy-default / agy-* / antigravity* / *-agy / 大寫 "Gemini ..." / gemini-*
 *
 * 大寫 "Gemini " 區別於 lowercase gemini-cli 模型（本框架已不支援 gemini）。
 *
 * **刻意不收** agy 也代理的 `claude-*` / `gpt-oss-*`——那些名字同時屬於
 * claude/codex agent，靠名字猜會把使用者送到錯的 CLI。
 *
 * ★ 2026-08-22 更正：這裡原本寫「要指定『agy 上的 claude』請用目錄的
 *   `antigravity/claude-sonnet-4-6`」。實查沒有這回事——selectAgentForModel
 *   只拿整個字串問 matchesModel，沒有任何地方會拆 `<agent>/<model>`。
 *   那個寫法只是目錄的顯示 id。要真的支援得先實作路由，在那之前不要
 *   把它寫成 run 的用法。discoverModels 仍照列這些名字，由 catalog 標成 routable: false。
 */
export function matchesAgyModel(model: string): boolean {
  return (
    model === 'agy' ||
    model === 'agy-default' ||
    model.startsWith('agy-') ||
    model.startsWith('antigravity') ||
    model.endsWith('-agy') ||
    // 舊的顯示寫法（agy settings.json 風格），alias 表仍在用
    model.startsWith('Gemini ') ||
    // v1.1.17 的真實 id 形如 `gemini-3.6-flash-high`
    model.startsWith('gemini-')
  );
}

export const antigravityAgent: AgentDefinition = {
  id: 'antigravity',
  models: ANTIGRAVITY_FALLBACK_MODELS,
  billingRoute: 'subscription-cli',
  discoverModels,
  matchesModel: matchesAgyModel,
  binary: {
    envVarName: 'AGY_CLI_NAME',
    defaultCliName: 'agy',
    localInstallPath: resolveAntigravityLocalPath(),
  },
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for antigravity (agy) models.',
  },
  buildCommand,
  buildStrictCommand,
  parseOutput,
  // agy 在 win32 非 TTY 下靜默無輸出 → 強制走 ConPTY
  win32SpawnMode: 'pty',
};
