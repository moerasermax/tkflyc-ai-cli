/**
 * `ai-cli exec` — **前景**執行契約。
 *
 * ── 與既有 `run` 的關係 ───────────────────────────────────────
 * `run` 不動：它是「背景啟動、之後回來拿結果」，那是它的功能。
 * `exec` 是給**監督者**用的：呼叫端要自己擁有這個程序、自己收 stdout、
 * 自己判斷終態。兩者共用 catalog / binary resolver / command builder。
 *
 * ── 三條不可協商的規則 ────────────────────────────────────────
 * 1. **能力 fail-closed**：agent 沒有 `buildStrictCommand` 就拒絕啟動，
 *    **不退回** `buildCommand`（那會帶著 `--dangerously-*` 全開權限跑，
 *    而呼叫端以為有限制）。
 *    唯一的例外是**明確的** `authority: 'unrestricted'`（2026-08-17，
 *    供 OmniMesh 的全權員工使用）：呼叫端自己寫出這個字面值，代表
 *    「這次執行的不設限是人授權的，由呼叫端負責」，exec 才用該 vendor
 *    的一般組裝。這不是退回——退回是呼叫端要求限制而我們給不出時
 *    偷偷放寬；這裡是呼叫端**要求不限制**。started frame 會回報實際
 *    生效的模式（`authority` 欄位），呼叫端據此驗證，版本不合時能
 *    發現「要求了 unrestricted 但對方不認識」而拒絕解讀。
 * 2. **terminal frame 必須等三件事齊全**：child close、stdout EOF、
 *    stderr EOF。少等任何一個，最後幾個 byte 會在「已完成」之後才到，
 *    而呼叫端已經把那次執行封存了——那就是無聲的資料遺失。
 * 3. **不得用立即 `process.exit()`**：stdout 是 pipe 時非同步，
 *    最後一個 frame 可能還在緩衝區。設 `exitCode` 讓事件迴圈自然收乾淨。
 *
 * ── 為什麼 stdout 走 base64 ───────────────────────────────────
 * vendor 的 stdout 是**位元組流**，不是字串。從任意位置切開再
 * `toString('utf-8')` 會把跨界的多位元字元切壞（既有的觀察介面就有
 * 這個 bug）。base64 讓呼叫端拿回原封不動的 bytes。
 */

import { spawn } from 'node:child_process';
import { buildWorkerEnv, assertCanStartJob } from '../core/worker-env.js';
import { buildCliCommand } from '../core/command-builder.js';
import { inspectCliBinary } from '../core/binary-resolver.js';
import { listAgents, selectAgentForModel } from '../agents/registry.js';
import { resolveModelAlias } from '../models/catalog.js';
import type { AgentDefinition } from '../agents/types.js';

export interface ExecRequest {
  cwd: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
  /** 這次執行允許的能力。空陣列 = 什麼都不准，仍會啟動（純問答）。 */
  capabilities?: string[];
  /**
   * 明確的不設限授權。**只認 `'unrestricted'` 這個字面值。**
   *
   * 與 `capabilities` 互斥：一個是「只給這些能力」、一個是「不設限」，
   * 同時出現是語義衝突，exec 不猜。
   */
  authority?: string;
  sessionId?: string;
}

/** exec 這次執行實際生效的模式。started frame 會回報它。 */
export type ExecAuthority = 'scoped' | 'unrestricted';

export interface ExecPlan {
  authority: ExecAuthority;
  agent: AgentDefinition;
  built: ReturnType<typeof buildCliCommand>;
}

/** 一個 NDJSON frame。`v` 是協定版本，呼叫端必須檢查。 */
type Frame =
  | {
      v: 1;
      type: 'started';
      /** 實際生效的模式。呼叫端據此確認「我要的不設限真的生效了」。 */
      authority: ExecAuthority;
      vendor: string;
      requestedModel: string;
      resolvedModel: string;
      command: string;
      args: string[];
    }
  | { v: 1; type: 'stdout'; seq: number; encoding: 'base64'; data: string }
  | {
      v: 1;
      type: 'terminal';
      status: 'succeeded' | 'failed' | 'spawn-failed';
      exitCode: number | null;
      signal: string | null;
      detail: string | null;
    };

function writeFrame(frame: Frame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function parseRequest(raw: string): ExecRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`stdin 不是合法的 JSON：${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stdin 必須是一個 JSON 物件');
  }
  const row = parsed as Record<string, unknown>;
  for (const key of ['cwd', 'model', 'prompt'] as const) {
    if (typeof row[key] !== 'string' || (row[key] as string).trim() === '') {
      throw new Error(`缺少必要欄位或不是非空字串：${key}`);
    }
  }
  const capabilities = row['capabilities'];
  if (capabilities !== undefined && !Array.isArray(capabilities)) {
    throw new Error('capabilities 必須是陣列');
  }
  /*
    authority 的**值**由 planExec 檢查（那裡才有完整語義），這裡只擋型別。
    錯誤訊息一律含 "authority" ——呼叫端與回歸測試都靠它區分
    「被這條規則拒絕」與「碰巧缺 CLI 也回 spawn-failed」。
  */
  const authority = row['authority'];
  if (authority !== undefined && typeof authority !== 'string') {
    throw new Error('authority 必須是字串');
  }
  return {
    cwd: row['cwd'] as string,
    model: row['model'] as string,
    prompt: row['prompt'] as string,
    ...(typeof row['reasoningEffort'] === 'string'
      ? { reasoningEffort: row['reasoningEffort'] }
      : {}),
    ...(Array.isArray(capabilities) ? { capabilities: capabilities.map(String) } : {}),
    ...(typeof authority === 'string' ? { authority } : {}),
    ...(typeof row['sessionId'] === 'string' ? { sessionId: row['sessionId'] } : {}),
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

function resolveCliPaths(): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const agent of listAgents()) {
    if (!agent.binary) continue;
    const status = inspectCliBinary(agent.binary);
    if (status.resolvedPath !== null) paths[agent.id] = status.resolvedPath;
  }
  return paths;
}

/**
 * `<agent>/<model>` 目錄 id → 拆成 agent 與 model。
 *
 * 前綴不是已知 agent id 時**原樣回傳**：direct-api 的
 * `or-qwen/qwen3.7-plus` 這種 provider/model 名字本來就含斜線，
 * 把它當目錄 id 拆掉會直接毀掉那條路徑。
 */
export function splitCatalogModelId(model: string): { agentId: string | null; model: string } {
  const slash = model.indexOf('/');
  if (slash <= 0) return { agentId: null, model };
  const prefix = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  if (rest === '' || !listAgents().some((agent) => agent.id === prefix)) {
    return { agentId: null, model };
  }
  return { agentId: prefix, model: rest };
}

/**
 * exec 的**決策**：用哪個 agent、哪一種組裝、這次生效的模式是什麼。
 *
 * 抽出來是為了**能直測**。authority 這條分支若只能靠整跑驗證，
 * 每驗一次都要真的啟動一個 vendor CLI——花錢、慢、還受機器狀態影響，
 * 於是實務上就不會有人驗它，而它偏偏是「權限有沒有真的收好」的那條線。
 * 這裡不 spawn、不寫 frame，只做決定。
 */
export function planExec(request: ExecRequest): ExecPlan {
  const requestedAuthority = request.authority;
  if (requestedAuthority !== undefined) {
    if (request.capabilities !== undefined) {
      throw new Error(
        'authority 與 capabilities 同時出現：一個要求不設限、一個要求只給特定能力，' +
          '這是語義衝突。exec 不猜呼叫端想要哪一個——只給其中一個。'
      );
    }
    if (requestedAuthority !== 'unrestricted') {
      throw new Error(
        `authority 只認 'unrestricted' 這個字面值，收到「${requestedAuthority}」。` +
          '未知的值不當成沒寫——當成沒寫會讓呼叫端以為授權生效了，而實際上是受限的。'
      );
    }
  }

  const { agentId, model } = splitCatalogModelId(request.model);
  const resolvedModel = resolveModelAlias(model);
  const agent = selectAgentForModel(resolvedModel);
  if (agentId !== null && agentId !== agent.id) {
    /*
      目錄 id 明講了 vendor，但這個 model 依名稱會路由到別家
      （`antigravity/claude-sonnet-4-6`：agy 確實代理 claude，但本框架的
      command builder 是按 agent 組的，硬指過去只會組出對方吃不下的指令）。
      說清楚並拒絕，不要靜默跑到另一家去。
    */
    throw new Error(
      `目錄 id「${request.model}」指定 agent「${agentId}」，但 model「${model}」` +
        `依名稱會路由到「${agent.id}」。exec 不做跨 vendor 的強制指派。`
    );
  }

  /*
    ★ fail-closed 那一段現在住在 `buildCliCommand` 裡（傳了 capabilities 就走
      strict builder，agent 沒有 strict builder 就丟錯、不退回一般模式）。

      這裡本來有一份自己的：先檢查 `agent.buildStrictCommand`、組一次一般指令、
      再把結果拆開餵給 strict 重組。它跟 command-builder 那份「看起來在講同一件事」，
      而那正是問題——MCP `run` 現在也要能表達「這一回合不要動我的檔案」，
      權限政策抄成兩份的下場，是其中一份哪天漏改而沒有人發現：兩邊都還跑得動，
      只有一邊真的擋得住。

      順帶修掉舊版的一個不一致：它傳給 strict 的 `reasoningEffort` 是
      `request.reasoningEffort ?? ''`，也就是呼叫端沒指定時就送空字串進去，
      跳過了 alias 解析與設定檔預設。走同一個入口之後，scoped 與 unrestricted
      拿到的是同一套解析結果。
  */
  const built = buildCliCommand({
    workFolder: request.cwd,
    prompt: request.prompt,
    model,
    cliPaths: resolveCliPaths(),
    ...(request.reasoningEffort !== undefined
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
    ...(request.sessionId !== undefined ? { session_id: request.sessionId } : {}),
    // 呼叫端**要求**不限制時不傳 capabilities——那不是 fail-closed 的退回，
    // 是它自己明確寫出授權並負責。退回指的是「要求限制、給不出、卻偷偷放寬」。
    ...(requestedAuthority === 'unrestricted'
      ? {}
      : { capabilities: request.capabilities ?? [] }),
  });

  return requestedAuthority === 'unrestricted'
    ? { authority: 'unrestricted', agent, built }
    : { authority: 'scoped', agent, built };
}

export async function runExec(): Promise<number> {
  // 先於讀 stdin，worker 即使沒送 JSON 也立即收到明確拒絕。
  try { assertCanStartJob(); }
  catch (error) {
    writeFrame({ v: 1, type: 'terminal', status: 'spawn-failed', exitCode: null,
      signal: null, detail: (error as Error).message });
    return 2;
  }
  let request: ExecRequest;
  try {
    request = parseRequest(await readStdin());
  } catch (error) {
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: (error as Error).message,
    });
    return 2;
  }

  let plan: ExecPlan;
  try {
    plan = planExec(request);
  } catch (error) {
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: (error as Error).message,
    });
    return 2;
  }

  const built = plan.built;

  if (built.cliPath.trim() === '') {
    /*
      解析不到二進位檔。**在 started 之前**就回報——送出 started 再失敗，
      呼叫端會以為程序真的起來過。
    */
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: `找不到 agent「${built.agent}」的 CLI 二進位檔，無法啟動。`,
    });
    return 2;
  }

  writeFrame({
    v: 1,
    type: 'started',
    // 呼叫端的唯一確認點：它要求 unrestricted，就必須在這裡看到 unrestricted。
    // 版本不合的對端不認識這個欄位，於是能發現「要求了但對方沒生效」而拒絕解讀。
    authority: plan.authority,
    vendor: built.agent,
    requestedModel: request.model,
    resolvedModel: built.resolvedModel,
    command: built.cliPath,
    args: [...built.args],
  });

  const usesStdin = typeof built.stdinPrompt === 'string';
  /*
    `detached: false` 是**刻意**的，而且是 exec 的核心：呼叫端要能
    把這個程序放進自己的程序群／Job 管起來。背景路徑走 `run`。
  */
  /*
    ★ `spawn()` 會**同步丟例外**（例如 argv 含 NUL、命令列過長）。
      不接住的話這個行程會直接死掉，而呼叫端只收到 started、沒有
      terminal——它只能標 unknown，卻是我們本來說得出原因的。
  */
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(built.cliPath, built.args, {
      env: buildWorkerEnv(),
      cwd: built.cwd,
      stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: false,
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: `spawn 同步失敗：${(error as Error).message}`,
    });
    return 2;
  }

  let seq = 0;
  let stdoutEnded = false;
  let stderrEnded = false;
  let closed = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let spawnError: string | null = null;

  const finish = (resolve: (code: number) => void): void => {
    // ★ 三件事都齊全才送 terminal。少等任何一個 = 無聲的資料遺失。
    if (!(stdoutEnded && stderrEnded && closed)) return;
    if (spawnError !== null) {
      writeFrame({
        v: 1,
        type: 'terminal',
        status: 'spawn-failed',
        exitCode: null,
        signal: null,
        detail: spawnError,
      });
      resolve(2);
      return;
    }
    writeFrame({
      v: 1,
      type: 'terminal',
      status: exitCode === 0 ? 'succeeded' : 'failed',
      exitCode,
      signal,
      detail: null,
    });
    // vendor 的 exit code 原樣透傳，不吃掉、不一律回 0。
    resolve(exitCode ?? 1);
  };

  const code = await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      spawnError = error.message;
      stdoutEnded = true;
      stderrEnded = true;
      closed = true;
      finish(resolve);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      seq += 1;
      writeFrame({ v: 1, type: 'stdout', seq, encoding: 'base64', data: chunk.toString('base64') });
    });
    child.stdout?.on('end', () => {
      stdoutEnded = true;
      finish(resolve);
    });
    // vendor 的 stderr 原樣轉送到我們自己的 stderr——不進 frame，
    // 也不由我們加工。診斷訊息混進 stdout 會汙染協定。
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr?.on('end', () => {
      stderrEnded = true;
      finish(resolve);
    });
    child.on('close', (childCode, childSignal) => {
      exitCode = childCode;
      signal = childSignal;
      closed = true;
      finish(resolve);
    });
    if (usesStdin && child.stdin) {
      child.stdin.end(built.stdinPrompt);
    }
  });

  return code;
}
