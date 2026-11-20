/**
 * Antigravity CLI (agy) — Google Gemini 後繼 CLI (2026/05)。
 *
 * Windows 的 spawn 模式依 agy 版本決定（resolveAgyWin32SpawnMode）：
 *
 * - **≥ 1.5.13 走一般管線**（和 claude／codex 同一條 durable job 路：runner、Job Object
 *   包容、可接回；windowsHide、stdout 直接進檔）。2026-11-20 實測 agy 1.5.13：
 *   `-p … --output-format json` 的 stdout 導向檔案 → exit 0、完整 JSON、stderr 空。
 *   1.5.13 是唯一實測過的版本，所以門檻就設在這裡，不往下猜。
 * - **較舊、或量不到版本走 ConPTY**（保守退路）。舊版 agy.exe 在 stdout 不是 TTY 時
 *   靜默不輸出，這是當初強制 ConPTY 的理由；版本不明時不能賭它已經修好。
 *
 * 為什麼要離開 ConPTY：PTY 寬度是 200 欄，ConPTY 會在第 200 格插入 `\r\n`，
 * **而且斷點處的字元會重複一次**（2026-11-20 實測 12,431 字元的稽核回覆，含大量全形字：
 * `functio\r\non.name`、`cal\r\nll_2`、`fu\r\nunction`）。`--output-format json` 的結果是一整行，
 * 被切斷後 parseOutput 逐行 JSON.parse 全數失敗、退回 text fallback：message 變成
 * 整段原始 JSON，session_id（續接）與 usage 都遺失。短回覆不受影響。
 * 斷點會重複字元，所以 parseOutput 不做「把換行接回去」的啟發式修復——修了也
 * 不知道該刪哪個字元，誤修比明確失敗更糟。
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
import { jobStateDir, lookupIdentities, type IdentityLookup } from '../core/live-jobs.js';
import { claimPromptOwner, promptDirOwnersGone } from '../core/prompt-owner.js';
import { truncateWarning, WARNING_MAX_CHARS, WARNING_MAX_COUNT } from '../core/warning-text.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32 as win32Path } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand, ModelDiscoveryResult, SpawnMode } from './types.js';

/**
 * 靜態後備清單。**只有在尚無可用的 vendor 查詢結果／快取時才會被用到。**
 *
 * ★ 這份清單曾經是錯的，而且錯得沒有人看得出來：它宣稱 agy 只有四個
 *   模型、且「不接受 --model」。實測 v1.1.9 有 11 個模型（id 形如
 *   `gemini-3.6-flash-high`，還包含 `claude-sonnet-4-6`、
 *   `gpt-oss-120b-medium`——agy 自己就代理多家），而且 `--model` 早就支援。
 *
 *   所以現在的第一來源是 `discoverModels()` 去問 CLI，
 *   而這份清單對外一律標成 `builtin-fallback`。
 *   後備 Flash 採用目前 vendor 提供的 `gemini-3.8-flash-high`。
 *   保留 'agy'/'agy-default' 是為了讓既有的 alias 路由不斷。
 */
const ANTIGRAVITY_FALLBACK_MODELS = [
  'agy',
  'agy-default',
  'gemini-4-neon-xhigh',
  'gemini-3.8-flash-high',
] as const;

/**
 * `agy models` 是網路呼叫，會先做 loadCodeAssist eligibility check。
 * 2026-09-05 agy 1.1.26 暖機八次：1739 / 1755 / 1762 / 1838 / 1906 /
 * 2487 / 2729 / 3972 ms；網路尾延遲可能超過舊的 5 秒上限，並非本機讀設定。
 * 非同步 + 快取才是避免卡住 MCP 的解法；15 秒只限制背景／明確查詢的等待。
 */
const DISCOVER_TIMEOUT_MS = 15_000;

/**
 * 實測過「非 TTY 也正常輸出」的最低 agy 版本。只有這一版實測過，不往下推。
 */
export const AGY_PIPE_MIN_VERSION = [1, 5, 13] as const;

/**
 * `agy --version` 的逾時。2026-11-20 實測 agy 1.5.13 stdout 導向檔案：
 * 250 / 258 / 261 ms，輸出就是 `1.5.13\n`。它擋在 run 回 PID 之前，所以要短；
 * 逾時＝unknown＝走 ConPTY，不讓 run 失敗。
 */
const AGY_VERSION_TIMEOUT_MS = 5_000;

/**
 * 版本 < 門檻或量不到時，多久之後重新問。agy 會自動更新，舊版本的結論會過期；
 * 但不能每次 run 都問（每次多 ~250 ms，失敗時多到逾時上限）。
 * ≥ 門檻的結論不按時間過期，但綁著執行檔身分（size＋mtime）：同一路徑被換成
 * 別的版本（自動更新、手動降版）時身分改變，一定重問。
 */
const AGY_VERSION_RECHECK_MS = 5 * 60_000;

/** `--version` 輸出的收集上限。超過就整筆作廢（unknown），不拿截斷的前綴判版本。 */
const AGY_VERSION_OUTPUT_LIMIT = 4096;

/**
 * 只認 `1.5.13` 這種整段就是版本號的輸出（前後空白除外）。
 * 刻意不從任意文字裡挑數字：`v22.19.0`、`agy 1.6.0 (beta)` 這類不是實測過的格式，
 * 一律當 unknown → ConPTY。寧可少走 pipe，不可把不輸出的舊版送進管線。
 */
export function parseAgyVersion(output: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 版本 ≥ AGY_PIPE_MIN_VERSION 才可走管線；量不到版本一律否。 */
export function agyVersionSupportsPipe(output: string | null): boolean {
  const version = output === null ? null : parseAgyVersion(output);
  if (!version) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== AGY_PIPE_MIN_VERSION[i]) return version[i] > AGY_PIPE_MIN_VERSION[i];
  }
  return true;
}

/**
 * 執行 `<cliPath> --version`，回 stdout；失敗、逾時、非零退出、輸出超過上限一律 null。
 * shell:false——只問 .exe；.cmd／.bat 由呼叫端直接判 ConPTY，不在這裡經 cmd.exe。
 *
 * 逾時立刻判 unknown，不等 close；結束子行程只用 child handle（child.kill()：Windows 是
 * 對 handle 的 TerminateProcess），**不用 PID 做 taskkill /T**——逾時當下 PID 可能已被重用。
 * `--version` 不該有子孫；萬一有，留下的是它自己的孫行程，不會誤殺別人。
 */
export function probeAgyVersion(
  cliPath: string,
  timeoutMs: number = AGY_VERSION_TIMEOUT_MS,
  args: readonly string[] = ['--version']
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(cliPath, [...args], {
        env: buildWorkerEnv(),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }
    let stdout = '';
    let overflow = false;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (data: string) => {
      if (overflow) return;
      if (stdout.length + data.length > AGY_VERSION_OUTPUT_LIMIT) { overflow = true; stdout = ''; return; }
      stdout += data;
    });
    child.on('error', () => finish(null));
    timer = setTimeout(() => {
      finish(null);
      try { child.kill(); } catch { /* 已退出；不可讓計時器拋例外。 */ }
    }, timeoutMs);
    child.on('close', (code) => finish(code === 0 && !overflow ? stdout : null));
  });
}

/** 執行檔身分：size＋mtime。量不到（不存在、無權限）回 null＝不快取。 */
function agyBinaryIdentity(cliPath: string): string | null {
  try {
    const stat = statSync(cliPath);
    return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : null;
  } catch {
    return null;
  }
}

export interface AgySpawnModeResolverOptions {
  probe?: (cliPath: string) => Promise<string | null>;
  identity?: (cliPath: string) => string | null;
  now?: () => number;
  recheckMs?: number;
  platform?: NodeJS.Platform;
}

/**
 * 可以替它擔保版本的路徑：Windows 只接受 `C:\…` 或 UNC（`\\server\share\…`）。
 * `\agy\bin\agy.exe` 這種 drive-relative 路徑 `isAbsolute` 為真，卻依「目前磁碟機」解析——
 * 探測與 runner 的目前磁碟機不一定相同，和裸名稱是同一類問題。
 */
export function agyProbeablePath(cliPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return isAbsolute(cliPath);
  return /^[A-Za-z]:[\\/]/.test(cliPath) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(cliPath);
}

/**
 * 依 agy 版本選 win32 spawn 模式，並在行程內快取（鍵是 cliPath，值綁執行檔身分）。
 * - cliPath 不是可擔保的絕對路徑 → 'pty'，不問：裸名稱（例如 `AGY_CLI_NAME=agy`）的探測在 ai-cli 的 cwd
 *   解析，runner 卻在 job 的 workFolder 解析，兩邊可能是不同的 exe。binary-resolver 對裸名稱
 *   刻意保留原字串交給 spawn 解析，這裡不改那個語意，只是不替它擔保版本。drive-relative 同理。
 * - .cmd／.bat → 'pty'，不問：管線模式不經 cmd.exe（prompt 在 argv，cmd 會重新切詞）。
 *   注意 ConPTY 啟動 .cmd 時仍由 cmd.exe 解讀命令列——既有行為，正式安裝的 agy 是 .exe，不在此修。
 * - 同時多個 run 共用同一次查詢，不重複 spawn。
 * - ≥ 門檻 → 'pipe'，身分不變就不再問。
 * - 較舊／unknown → 'pty'，AGY_VERSION_RECHECK_MS 後或身分改變時重問（自動更新後能切過去）。
 * - 探測完成後再讀一次身分；探測期間被換掉（TOCTOU）就不寫快取、這次判 'pty'。
 * - Windows 的快取鍵正規化大小寫與分隔符（`C:\A\agy.exe` 與 `c:/a/AGY.EXE` 是同一支）。
 * - 已知不擋：核對版本之後、runner spawn 之前若被換成舊版，這一次仍走管線。接受的理由：agy 只會
 *   自動往前更新，降版要手動、時間窗只有數秒；萬一發生，後果是那一次輸出為空、呼叫端看得到，
 *   不是靜默錯誤。
 */
export function createAgySpawnModeResolver(options: AgySpawnModeResolverOptions = {}) {
  const probe = options.probe ?? ((cliPath: string) => probeAgyVersion(cliPath));
  const identityOf = options.identity ?? agyBinaryIdentity;
  const now = options.now ?? Date.now;
  const recheckMs = options.recheckMs ?? AGY_VERSION_RECHECK_MS;
  const platform = options.platform ?? process.platform;
  const keyOf = (cliPath: string) => platform === 'win32' ? win32Path.normalize(cliPath).toLowerCase() : cliPath;
  const cache = new Map<string, { identity: string; mode: SpawnMode; expiresAt: number }>();
  const inflight = new Map<string, Promise<SpawnMode>>();
  return function resolveAgyWin32SpawnMode(cliPath: string): Promise<SpawnMode> {
    if (!agyProbeablePath(cliPath, platform)) return Promise.resolve('pty');
    if (/\.(cmd|bat)$/i.test(cliPath)) return Promise.resolve('pty');
    const identity = identityOf(cliPath);
    if (identity === null) return Promise.resolve('pty');
    const cacheKey = keyOf(cliPath);
    const cached = cache.get(cacheKey);
    if (cached && cached.identity === identity && now() < cached.expiresAt) return Promise.resolve(cached.mode);
    const key = `${cacheKey}\0${identity}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const run = (async (): Promise<SpawnMode> => {
      let output: string | null = null;
      try { output = await probe(cliPath); } catch { output = null; }
      if (identityOf(cliPath) !== identity) return 'pty';
      const mode: SpawnMode = agyVersionSupportsPipe(output) ? 'pipe' : 'pty';
      cache.set(cacheKey, { identity, mode, expiresAt: mode === 'pipe' ? Infinity : now() + recheckMs });
      return mode;
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  };
}

const resolveAgyWin32SpawnMode = createAgySpawnModeResolver();

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
  return withPromptArg(input, args, prompt);
}

/**
 * ── 長 prompt 改走檔案 ──────────────────────────────────────────
 * agy 的 prompt 只能從 `-p` 進來。Windows 命令列上限 32,767 個 UTF-16 單位，超過就
 * `Cannot create process, error code: 206`（2026-10-19／10-22 實測：3.5 萬～8.5 萬字的派工
 * 秒退；呼叫端把原文寫成檔、命令列只送一行「去讀那個檔」就能 spawn 並交件，3.5 萬字那次
 * 128 秒交件）。這裡在**序列化後的命令列**估計超過門檻時，把完整 prompt 寫進 ai-cli 自己的
 * 私有目錄（每個 prompt 一個目錄，只放這一個檔——`--add-dir` 給 agent 的就是這個目錄，
 * 不可讓它看到別的 job 的 prompt），`-p` 只送身分鎖＋一行指示。
 *
 * 門檻：Windows 估計命令列 > 24,000（留給 exe 路徑、模型、其他引數與跳脫的餘裕）。
 * POSIX 也做，但看的是單一引數的位元組數：Linux 的 MAX_ARG_STRLEN 是 128 KiB，
 * 超過就 E2BIG；門檻取 100,000 bytes。中文 3 bytes／字，約 3.3 萬字才觸發。
 *
 * 位置：每使用者私有的 ai-cli state 目錄底下（`<state>/agy-prompts`），不用共用的 /tmp——
 * POSIX 的 /tmp 是多使用者共用、可被預先放 symlink。根目錄若是 symlink 就拒絕寫入。
 *
 * 清理：
 * - durable job（JobStore）把整個目錄搬進 job 目錄（prompt-dir），隨 job 目錄回收；
 * - 啟動前失敗（breaker、spawn mode、store 搬移之前）由 service 當場刪掉；
 * - `ai-cli exec` 是前景執行，子行程結束、本行程退出時刪；
 * - POSIX 的 legacy detached 路徑**不在**派工行程結束時刪（agy 可能還沒讀檔），
 *   和其他沒搬走的一樣交給 TTL：JobStore 的 GC（collectStoreFiles）與下次寫入時清掉超過 24 小時的。
 */
export const AGY_WIN32_COMMAND_LINE_LIMIT = 24_000;
export const AGY_POSIX_ARG_LIMIT_BYTES = 100_000;
export const AGY_PROMPT_FILE_NAME = 'prompt.md';
export const AGY_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
/** 每次呼叫重讀環境變數：測試與多 store 可改 AI_CLI_STATE_DIR。 */
export function agyPromptRoot(): string { return resolve(jobStateDir(), 'agy-prompts'); }

/** libuv／node-pty 組 Windows 命令列的保守估計：每個引數加引號與空白，`"` 與 `\` 各算兩倍。 */
export function estimateWin32CommandLine(cliPath: string, args: readonly string[]): number {
  let length = cliPath.length + 3;
  for (const arg of args) {
    length += arg.length + 3;
    for (let i = 0; i < arg.length; i++) {
      const code = arg.charCodeAt(i);
      if (code === 34 || code === 92) length++;
    }
  }
  return length;
}

export function agyPromptNeedsFile(
  cliPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') return estimateWin32CommandLine(cliPath, args) > AGY_WIN32_COMMAND_LINE_LIMIT;
  return args.some((arg) => Buffer.byteLength(arg) > AGY_POSIX_ARG_LIMIT_BYTES);
}

export function agyPromptFileInstruction(file: string): string {
  return [
    `本則訊息超過命令列長度上限，完整內容放在這個檔案（UTF-8）：${file}`,
    '請先把檔案完整讀完（不要只讀開頭），再把檔案內容當成這則訊息本身來執行。',
    `This message exceeded the command-line limit; its full text is in the file above: ${file}`,
    'Read the entire file first, then treat its contents as this message itself and carry it out.',
  ].join('\n');
}

/** 清掉超過 TTL 的 prompt 目錄。只認 `agy-<uuid>` 目錄，symlink 一律跳過（lstat，不跟隨）。 */
export async function collectAgyPromptDirs(
  now = Date.now(),
  lookup: IdentityLookup = lookupIdentities,
  isAlive?: (pid: number) => boolean
): Promise<void> {
  const root = agyPromptRoot();
  try { if (!lstatSync(root).isDirectory()) return; } catch { return; }
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!/^agy-[0-9a-f-]{36}$/.test(name)) continue;
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (now - stat.mtimeMs <= AGY_PROMPT_TTL_MS) continue;
      // 過了 TTL 還要擁有者確認不在：exec／legacy job 可能跑超過 24 小時，還在讀這個檔。
      if (!(await promptDirOwnersGone(path, lookup, isAlive))) continue;
      rmSync(path, { recursive: true, force: true });
    } catch { /* 清理失敗不可擋住派工。 */ }
  }
}

function writeAgyPromptDir(prompt: string): string {
  const root = agyPromptRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`agy 長 prompt 的私有目錄不是一般目錄（可能是 symlink），拒絕寫入：${root}`);
  }
  const dir = join(root, `agy-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  // 交出去之前擁有者是派工行程本身；spawn 成功後由 handOffTemporaryPrompt 改成 vendor 子行程。
  void claimPromptOwner(dir, process.pid);
  // 只用 `ai-cli exec` 的機器沒有 JobStore 回收者：建立時順手清一次過期目錄。不等待、錯誤吞掉，
  // 不拖慢 run；判斷擁有者用既有的行程身分查詢。剛建立的這個目錄沒過期，不會被收。
  void collectAgyPromptDirs().catch(() => undefined);
  writeFileSync(join(dir, AGY_PROMPT_FILE_NAME), prompt, { encoding: 'utf8', mode: 0o600 });
  return dir;
}

/** 兩個 builder 共用：命令列放得下就照舊 `-p <prompt>`，放不下改走檔案。 */
function withPromptArg(input: BuildCommandInput, args: string[], prompt: string): BuiltCommand {
  const { cliPath, cwd, resolvedModel } = input;
  const inline = [...args, '-p', prompt];
  if (!agyPromptNeedsFile(cliPath, inline)) {
    return { cliPath, args: inline, cwd, agent: 'antigravity', prompt, resolvedModel };
  }
  const dir = writeAgyPromptDir(input.prompt);
  const instruction = withWorkerContext(agyPromptFileInstruction(join(dir, AGY_PROMPT_FILE_NAME)));
  return { cliPath, args: [...args, '--add-dir', dir, '-p', instruction], cwd, agent: 'antigravity', prompt,
    resolvedModel, temporaryPromptDir: dir };
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

      CLI 的 `--model` 接受模型 id。內建 `agy-ultra` 解析成 `gemini-4-neon-xhigh`，
      使用者自訂 alias 也可能指向顯示名稱。統一正規化，無法轉成 id 時省略參數，
      由 CLI 選擇預設模型。
  */
  const cliModel = normalizeAgyModel(resolvedModel);
  if (cliModel !== null) {
    args.push('--model', cliModel);
  }
  return withPromptArg(input, args, prompt);
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
function parseOutput(stdout: string, stderr = ''): unknown {
  // 管線模式下 agy 的 warning 印在 stderr（2026-11-20 實測續接失敗）；POSIX legacy 也靠這裡帶出。
  const stderrWarnings = collectAgyWarnings(stderr);
  // 嚴格模式固定那行（在 PTY 下會併進 stdout）不是回覆：拿掉之後沒東西，就走警告／raw 退路，
  // 不可讓它變成 message 把 stderr 的致命診斷遮住。
  const trimmed = (stdout ?? '').split(/\r?\n/).filter((line) => !isHarmlessAgyWarning(line.trim())).join('\n').trim();
  if (!trimmed) return stderrWarnings.length > 0 ? { warnings: stderrWarnings } : null;

  const lines = trimmed.split(/\r?\n/);
  const preamble: string[] = [];
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) {
      if (candidate && !isHarmlessAgyWarning(candidate)) preamble.push(candidate);
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
    const warnings = limitAgyWarnings([...preamble, ...stderrWarnings]);
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
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // fallback：text 格式（或 json 解析全數落空）。
  return { message: unwrapAgyBody(trimmed), ...(stderrWarnings.length > 0 ? { warnings: stderrWarnings } : {}) };
}

/** 與 core 的 durable 上限一致：最多 20 筆、每筆 1,000 字。 */
export const AGY_WARNING_MAX_COUNT = WARNING_MAX_COUNT;
export const AGY_WARNING_MAX_CHARS = WARNING_MAX_CHARS;

/**
 * 嚴格模式固定組合 `--mode plan --disable-slash-commands` 時，agy 每次都會印這行
 * （2026-09-10 實測，2026-11-20 在 stderr 再次確認）。它是 ai-cli 自己的參數組合造成的、
 * 不代表任何失敗；留著會讓每個嚴格模式 job 都帶一筆假警告。只排除這一行，其他 warning 照收。
 */
const HARMLESS_AGY_WARNING = /^warning: --mode plan has no effect while slash command expansion is disabled\.?$/i;
function isHarmlessAgyWarning(text: string): boolean {
  return HARMLESS_AGY_WARNING.test(text);
}

/**
 * 續接失敗（`warning: conversation "…" not found`）是呼叫端判斷 resume 有沒有成功的唯一訊號，
 * 不可被一般警告擠出上限：排在最前面，再截到上限。選「優先名額」而不是另開欄位，
 * 是因為呼叫端（與 parseOutput 的文件）已經約定看 warnings，另開欄位等於要所有讀端改寫。
 */
export function isAgyResumeWarning(text: string): boolean {
  return /^warning: conversation ".*" not found/i.test(text);
}

function limitAgyWarnings(list: readonly string[]): string[] {
  const ordered = [...list.filter(isAgyResumeWarning), ...list.filter((text) => !isAgyResumeWarning(text))];
  // 排序用未截斷的原文；截斷保留結尾（與 durable 路徑同一個函式）。
  return ordered.slice(0, AGY_WARNING_MAX_COUNT).map((text) => truncateWarning(text));
}

function collectAgyWarnings(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const warning = agyDurableWarning(line);
    if (warning) found.push(warning);
  }
  return limitAgyWarnings(found);
}

/**
 * durable job 逐行解析時保留 `warning: …` 行。`warning: conversation "<id>" not found` 是
 * 續接失敗的唯一訊號（agy 會改開新對話、照樣回 JSON），預設結果不帶它就等於把 resume 失敗
 * 靜默折成成功。只收 `warning:` 開頭的行，不收一般本文；嚴格模式固定出現的那行排除。
 */
export function agyDurableWarning(line: string): string | null {
  const text = line.trim();
  return /^warning:/i.test(text) && !isHarmlessAgyWarning(text) ? text : null;
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
  durableWarning: agyDurableWarning,
  priorityWarning: isAgyResumeWarning,
  // 保守退路：版本量不到或 < 1.5.13 時，舊版 agy 非 TTY 會靜默無輸出 → ConPTY。
  win32SpawnMode: 'pty',
  // ≥ 1.5.13 改走管線（見檔頭）。
  resolveWin32SpawnMode: resolveAgyWin32SpawnMode,
  // 管線模式不經 cmd.exe：prompt 在 argv（-p），cmd 會對引號、%、換行重新切詞。
  // 只影響 pipe；ConPTY 本來就直接啟動 exe。.cmd／.bat 由 resolver 留在 ConPTY。
  win32DirectExec: true,
};
