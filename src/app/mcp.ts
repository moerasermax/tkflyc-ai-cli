/**
 * MCP server。對應 dist/app/mcp.js。
 * 工具（11 個）：run, list_processes, get_result, wait, peek, kill_process,
 *       cleanup_processes, doctor, models, set_config, query_usage。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { debugLog } from '../core/debug.js';
import { getCliDoctorStatus, resolveAllCliPaths } from '../core/doctor.js';
import {
  MODEL_ALIASES,
  getModelParameterDescription,
  getModelsPayload,
  getSupportedModelsDescription,
  isBuiltinAlias,
  isKnownModelTarget,
  listKnownModels,
} from '../models/catalog.js';
import { refreshCatalogV2 } from '../models/catalog-v2.js';
import { ALLOWED_REASONING_EFFORTS } from '../core/reasoning.js';
import { updateUserConfig } from '../core/user-config.js';
import { validatePeekPids, validatePeekTimeSec } from '../core/peek.js';
import { ProcessService } from '../core/process-service.js';
import { CircuitBreakerError } from '../core/circuit-breaker.js';
import { UsageService } from '../plugins/usage-service.js';
import { consumeNotice, scheduleBackgroundUpdates } from '../core/updater.js';
import { getServerIdentity } from '../core/identity.js';
import { assertCanStartJob } from '../core/worker-env.js';

// 版本與 doctor / models 回傳的 server.version 取自同一份來源，避免兩處各讀一次
// package.json 而在某天分岔。
//
// 讀不到時**不要編一個看起來像真版本的字串**（例如 '0.0.0'）：那是合法 semver，
// 呼叫端會當成真的，而同一個行程的 doctor 卻回 `version: null` ——兩邊打架。
// MCP 的 serverInfo.version 只要求字串、不要求 semver，所以誠實講「不知道」。
const identityVersion = getServerIdentity().version;
const SERVER_VERSION = identityVersion?.trim() ? identityVersion : 'unknown';

let isFirstToolUse = true;
const serverStartupTime = new Date().toISOString();

export class AiCliMcpServer {
  private server: Server;
  private processService: ProcessService;
  private usageService: UsageService;
  private sigintHandler?: () => Promise<void>;
  private closed: Promise<void>;
  private stopUpdates?: () => void;

  constructor() {
    const cliPaths = resolveAllCliPaths();
    console.error(`[Setup] Claude CLI: ${cliPaths.claude}`);
    console.error(`[Setup] Codex CLI: ${cliPaths.codex}`);
    console.error(`[Setup] Antigravity CLI (agy): ${cliPaths.antigravity}`);
    console.error('[Setup] Direct API: ~/.local/share/ai-cli/providers.json');

    this.processService = new ProcessService({ cliPaths });
    this.usageService = new UsageService(cliPaths);

    this.server = new Server(
      { name: 'ai_cli_mcp', version: SERVER_VERSION },
      { capabilities: { tools: {}, logging: {} } }
    );

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[Error]', error);
    // server 的「整段生命週期」promise，給 waitUntilClosed() 用。要在這裡就掛好：
    // Protocol.connect() 只覆寫 transport.onclose（它再轉呼叫 this.server.onclose），
    // 不會蓋掉這一行。
    this.closed = new Promise<void>((resolve) => {
      this.server.onclose = () => { this.stopUpdates?.(); resolve(); };
    });
    this.sigintHandler = async () => {
      await this.server.close();
      process.exit(0);
    };
    process.on('SIGINT', this.sigintHandler);
  }

  private getCliConfigurationError(): string | null {
    const doctorStatus = getCliDoctorStatus();
    for (const name of ['claude', 'codex'] as const) {
      const status = doctorStatus[name] as { error?: string };
      if (status?.error) {
        return status.error;
      }
    }
    return null;
  }

  private setupToolHandlers(): void {
    // 工具描述只同步讀目錄／快取；不可 await vendor 查詢，避免重連卡住 tools/list。
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'run',
          description: `AI Agent Runner: Starts a Claude, Codex, Antigravity, or direct API agent job in the background and returns a PID immediately. Use list_processes and get_result to monitor progress.

• File ops: Create, read, (fuzzy) edit, move, copy, delete, list files, analyze/ocr images, file content analysis
• Code: Generate / analyse / refactor / fix
• Git: Stage ▸ commit ▸ push ▸ tag (any workflow)
• Terminal: Run any CLI cmd or open URLs
• Web search + summarise content on-the-fly
• Multi-step workflows & GitHub integration

**IMPORTANT**: This tool now returns immediately with a PID. Use other tools to check status and get results.
For cost-aware dispatch (batching, duplicate jobs, polling, and agentOutput.usage), read the models tool's dispatchGuidance.

**Candidate models** — this is NOT an allowlist. claude is the routing catch-all, so a name that is
absent from this list may still run; call the models tool and read "modelListCaveat" before concluding
that a model is unsupported. Conversely, a name listed here may have been retired by the vendor.
${getSupportedModelsDescription()}

**Prompt input**: You must provide EITHER prompt (string) OR prompt_file (file path), but not both.

**Prompt tips**
1. Be concise, explicit & step-by-step for complex tasks.
2. Check process status with list_processes
3. Get results with get_result using the returned PID
4. Kill long-running processes with kill_process if needed
`,
          inputSchema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description:
                  'The detailed natural language prompt for the agent to execute. Either this or prompt_file is required.',
              },
              prompt_file: {
                type: 'string',
                description:
                  'Path to a file containing the prompt. Either this or prompt is required. Must be an absolute path or relative to workFolder.',
              },
              workFolder: {
                type: 'string',
                description: 'The working directory for the agent execution. Must be an absolute path.',
              },
              model: { type: 'string', description: getModelParameterDescription() },
              reasoning_effort: {
                type: 'string',
                description:
                  'Reasoning control for Claude and Codex. Claude uses --effort with "low", "medium", "high", "xhigh", "max". Codex uses model_reasoning_effort with "low", "medium", "high", "xhigh", "max", "ultra" — "max" and "ultra" are only offered by the newer models (gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-5.6-sol, gpt-5.6-terra; gpt-6-luna and gpt-5.6-luna stop at "max", gpt-5.5 stops at "xhigh", per the vendor model catalog as of 2026-10-03). Note the CLI-side default effort differs per model: gpt-6.1-sol and gpt-5.6-sol default to "low", the rest to "medium", so omitting this field is not the same across models. An unsupported combination is not reliably rejected: gpt-5.5 + "max" fails with HTTP 400 from the API, while gpt-6-luna + "ultra" exited 0 in a 2026-09-26 run — so a clean exit does not prove the level took effect. Antigravity and direct-api do not support reasoning_effort in this integration.',
              },
              session_id: {
                type: 'string',
                description:
                  'Optional session ID to resume a previous session. Supported for Claude, Codex, Antigravity, and direct-api. direct-api stores sessions under workFolder/.tmp/api_sessions.',
              },
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Restrict what the agent may do. Give it and the agent starts through its STRICT builder instead of the normal one: claude gets --allowedTools Read,Glob,Grep with no --dangerously-skip-permissions, codex gets --sandbox read-only. A read-only turn is ["fs/read", "analysis/produce"]. OMITTING this field keeps the long-standing behaviour: unrestricted, with the vendor permission bypasses on. An EMPTY array is NOT the same as omitting it — empty means "no capabilities at all" and still goes through the strict builder. If the selected agent has no strict builder the call is REFUSED rather than quietly falling back to the permissive one.',
              },
              system_prompt: {
                type: 'string',
                description:
                  "A system prompt for this run, appended after the vendor default (claude: --append-system-prompt-file). Use it for operator-side framing that must NOT look like user input — for example a protocol marker or a transcript replay that the caller injects. Text placed in the prompt body sits where the user's own words go, and a well-aligned model can legitimately read it as prompt injection and refuse. REFUSED (not ignored) when the selected agent has no system-prompt channel, so the caller never believes the framing was delivered when it was not.",
              },
            },
            required: ['workFolder'],
          },
        },
        {
          name: 'list_processes',
          description:
            'List tracked AI agent processes with PID, agent and status. Running items include liveness (alive, elapsedSec, sinceLastOutputSec, stdoutBytes, stderrBytes, lastEvent, eventCount, hint), plus elapsedSec, sinceLastOutputSec and lastEvent at the item level. Terminal items include elapsedSec when the end time is known and have no liveness.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_result',
          description:
            'Get the current output and status of an AI agent process by PID. Running results include liveness: alive, elapsedSec, sinceLastOutputSec, stdoutBytes, stderrBytes, lastEvent, eventCount and an English hint. Codex/Claude can emit nothing while reasoning; while liveness.alive is true, keep waiting or use peek for live events. Terminal results have no liveness. Defaults to a compact result shape; set verbose to true for full metadata and detailed parsed output. Compact results omit raw stdout/stderr while a job is running (use liveness, or peek for live events); a finished job without a parsed reply returns only the last 4096 characters, marked by stdoutTruncated/stderrTruncated. With verbose, a job without a parsed reply returns the full raw output.',
          inputSchema: {
            type: 'object',
            properties: {
              pid: { type: 'number', description: 'The process ID returned by run tool.' },
              verbose: {
                type: 'boolean',
                description:
                  'Optional: If true, returns the full result shape including metadata fields and detailed parsed output such as tool usage history. Defaults to false.',
              },
            },
            required: ['pid'],
          },
        },
        {
          name: 'wait',
          description:
            'Wait for AI agent processes and return an array of current results. Timeout is NOT an error: still-running items include timedOut: true and liveness (alive, elapsedSec, sinceLastOutputSec, stdoutBytes, stderrBytes, lastEvent, eventCount, hint). Use timeout <= 90 seconds and call repeatedly; do not abandon a PID while liveness.alive is true. Codex/Claude emit nothing while reasoning. Use peek to observe live messages and tool events. Terminal items have neither liveness nor timedOut. Unknown PIDs still cause an error. Defaults to compact result items; set verbose to true for full metadata and detailed parsed output. Compact results omit raw stdout/stderr while a job is running (use liveness, or peek for live events); a finished job without a parsed reply returns only the last 4096 characters, marked by stdoutTruncated/stderrTruncated. With verbose, a job without a parsed reply returns the full raw output.',
          inputSchema: {
            type: 'object',
            properties: {
              pids: {
                type: 'array',
                items: { type: 'number' },
                description: 'List of process IDs to wait for (returned by the run tool).',
              },
              timeout: {
                type: 'number',
                description: 'Optional: Maximum wait in seconds; default 180. Recommended <= 90 for repeated polling. Timeout returns current status and liveness, not an error.',
              },
              verbose: {
                type: 'boolean',
                description:
                  'Optional: If true, each result item uses the full result shape including metadata fields and detailed parsed output. Defaults to false.',
              },
            },
            required: ['pids'],
          },
        },
        {
          name: 'peek',
          description:
            'One-shot short observation window for running child agents. Returns only natural-language message events, and optionally normalized tool_call events, observed during this call; not a history API, not gapless streaming, and not stdout/stderr tailing. Message extraction is supported for Codex, Claude, direct-api, and Antigravity. Tool calls exclude raw tool output.',
          inputSchema: {
            type: 'object',
            properties: {
              pids: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'Process IDs returned by run. Duplicates are deduplicated server-side, preserving first occurrence order. Unknown PIDs are returned per process as not_found.',
              },
              peek_time_sec: {
                type: 'number',
                description: 'Optional positive integer observation window in seconds. Defaults to 10; maximum is 60.',
              },
              include_tool_calls: {
                type: 'boolean',
                description: 'Optional: include normalized tool_call events without raw tool output. Defaults to false.',
              },
            },
            required: ['pids'],
          },
        },
        {
          name: 'kill_process',
          description: 'Terminate a running AI agent process by PID.',
          inputSchema: {
            type: 'object',
            properties: { pid: { type: 'number', description: 'The process ID to terminate.' } },
            required: ['pid'],
          },
        },
        {
          name: 'cleanup_processes',
          description: 'Remove all completed and failed processes from the process list to free up memory.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'doctor',
          description:
            'Check supported AI CLI binary availability and path resolution. Does not verify login state or terms acceptance. Also reports the identity of this server itself — npm package name, version and repository — in the "server" field, which is the authoritative answer to "which project is this?".',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'models',
          description: 'List candidate model names, model aliases, and dynamic backend discovery hints. Also reports the identity of this server itself (npm package, version, repository) in the "server" field. The per-agent arrays are NOT an allowlist: claude is the routing catch-all, so a name that is absent from them may still run — see the "modelListCaveat" field before concluding a model is unsupported.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'set_config',
          description: `Update persisted user settings at the ai-cli config file. Changes take effect immediately for subsequent run calls; the MCP server does NOT need to be restarted.

Use alias_model to repoint a model alias (for example {"codex-ultra": "gpt-5.6-terra"}). Valid alias names: ${Object.keys(
            MODEL_ALIASES
          )
            .map((a) => `"${a}"`)
            .join(', ')}.

Use unset to drop overrides and fall back to the built-in defaults. Returns the same payload as the models tool so the effective state is visible right away.

Note: antigravity (agy) does accept model selection — the resolved name is normalized to an agy model id ("Gemini 3.1 Pro (High)" -> gemini-3.1-pro-high) and passed as --model. Only "agy" and "agy-default" pass nothing and fall back to the agy CLI's own default, so repointing agy-ultra to those two changes what is reported, not what runs.`,
          inputSchema: {
            type: 'object',
            properties: {
              alias_model: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description:
                  'Map of alias name to the model it should resolve to. Unknown model names are rejected rather than silently routed to Claude.',
              },
              alias_reasoning_effort: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description:
                  'Map of alias/model name to default reasoning effort applied when run does not specify one.',
              },
              default_reasoning_effort: {
                type: 'string',
                description:
                  'Default reasoning effort for reasoning-capable agents when neither run nor an alias override specifies one.',
              },
              unset: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Keys to remove: an alias name clears both its model and reasoning overrides; "defaultReasoningEffort" clears the global default.',
              },
            },
          },
        },
        {
          name: 'query_usage',
          description: 'Query remaining token/credit usage for AI CLI tools (Claude, Codex, Antigravity/agy). Results are cached for 120 seconds. Use refresh=true to force a fresh query.',
          inputSchema: {
            type: 'object',
            properties: {
              agents: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of agents to query (claude, codex, agy/antigravity). Defaults to all.',
              },
              refresh: {
                type: 'boolean',
                description: 'Optional: If true, bypass cache and force a fresh query. Defaults to false.',
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (args): Promise<ServerResult> => {
      debugLog('[Debug] Handling CallToolRequest:', args);
      const toolName = args.params.name;
      const toolArguments = (args.params.arguments || {}) as Record<string, unknown>;
      switch (toolName) {
        case 'run':
          return this.handleRun(toolArguments);
        case 'list_processes':
          return this.jsonResult(this.processService.listProcesses());
        case 'get_result':
          return this.handleGetResult(toolArguments);
        case 'wait':
          return this.handleWait(toolArguments);
        case 'peek':
          return this.handlePeek(toolArguments);
        case 'kill_process':
          return this.handleKillProcess(toolArguments);
        case 'cleanup_processes':
          return this.jsonResult(this.processService.cleanupProcesses());
        case 'doctor':
          return this.jsonResult(getCliDoctorStatus());
        case 'models':
          await refreshCatalogV2();
          return this.jsonResult(getModelsPayload());
        case 'set_config':
          return this.handleSetConfig(toolArguments);
        case 'query_usage':
          return this.handleQueryUsage(toolArguments);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
      }
    });
  }

  private jsonResult(value: unknown): ServerResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  }

  /** 讀出一個 optional 的 Record<string, string> 參數，型別不符就丟 InvalidParams。 */
  private readStringMap(
    toolArguments: Record<string, unknown>,
    key: string
  ): Record<string, string> | undefined {
    const raw = toolArguments[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new McpError(ErrorCode.InvalidParams, `${key} must be an object.`);
    }
    // 必須用 null prototype：普通 {} 的 out['__proto__'] = '...' 會打到 Object.prototype
    // 的 setter（字串會被無聲丟棄），結果 __proto__ 這個 key 根本不會變成 own property
    // ——後面的 alias 驗證迴圈就掃不到它，呼叫端會拿到「成功」但什麼都沒設定。
    //
    // 實測（verify-alias-config 走真的 stdio JSON-RPC）：`{"__proto__":"opus"}` 會原樣送達
    // 這裡並成為 own property，因此這一行就是實際擋下它的那道防線
    // ——被拒理由是「Unknown alias "__proto__"」，測試也是這樣斷言的。
    const out: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new McpError(ErrorCode.InvalidParams, `${key}.${k} must be a non-empty string.`);
      }
      out[k] = v.trim();
    }
    // 空物件不能當成「有指定」：它會通過下面的 Nothing-to-change 檢查，
    // 然後一路走到寫檔卻什麼也沒改，呼叫端只會看到一個假的成功。
    if (Object.keys(out).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `${key} must not be empty.`);
    }
    return out;
  }

  private assertKnownAlias(alias: string): void {
    // 用 hasOwnProperty 而非 in：'constructor' / 'toString' 會讓 in 回 true，
    // 那就等於允許寫入不存在的 alias。
    if (!isBuiltinAlias(alias)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown alias "${alias}". Valid aliases: ${Object.keys(MODEL_ALIASES).join(', ')}.`
      );
    }
  }

  private assertValidEffort(label: string, effort: string): void {
    if (!ALLOWED_REASONING_EFFORTS.has(effort.toLowerCase())) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid reasoning effort "${effort}" for ${label}. Allowed: ${[
          ...ALLOWED_REASONING_EFFORTS,
        ].join(', ')}.`
      );
    }
  }

  private handleSetConfig(toolArguments: Record<string, unknown>): ServerResult {
    const aliasModel = this.readStringMap(toolArguments, 'alias_model');
    const aliasReasoning = this.readStringMap(toolArguments, 'alias_reasoning_effort');

    const defaultEffortRaw = toolArguments.default_reasoning_effort;
    if (defaultEffortRaw !== undefined && typeof defaultEffortRaw !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'default_reasoning_effort must be a string.');
    }
    const defaultEffort = (defaultEffortRaw as string | undefined)?.trim();

    const unsetRaw = toolArguments.unset;
    if (unsetRaw !== undefined && !Array.isArray(unsetRaw)) {
      throw new McpError(ErrorCode.InvalidParams, 'unset must be an array of strings.');
    }
    const unset = ((unsetRaw as unknown[] | undefined) ?? []).map((entry) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new McpError(ErrorCode.InvalidParams, 'unset entries must be non-empty strings.');
      }
      return entry.trim();
    });

    if (!aliasModel && !aliasReasoning && !defaultEffort && unset.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Nothing to change. Provide at least one of alias_model, alias_reasoning_effort, default_reasoning_effort, unset.'
      );
    }

    // 驗證：alias 必須是既有的；model 必須真的被某個 agent 認得。
    // claude 的 matchesModel 是 catch-all，不擋的話打錯字會靜默跑去 claude。
    for (const [alias, target] of Object.entries(aliasModel ?? {})) {
      this.assertKnownAlias(alias);
      if (!isKnownModelTarget(target)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown model "${target}" for alias "${alias}". Known models: ${listKnownModels().join(
            ', '
          )}. direct-api also accepts provider-prefixed names such as "or-<model>" or "ds-<model>".`
        );
      }
    }
    for (const [alias, effort] of Object.entries(aliasReasoning ?? {})) {
      this.assertValidEffort(`alias_reasoning_effort.${alias}`, effort);
    }
    if (defaultEffort) {
      this.assertValidEffort('default_reasoning_effort', defaultEffort);
    }
    for (const key of unset) {
      if (key !== 'defaultReasoningEffort') {
        this.assertKnownAlias(key);
      }
    }

    // 既有值如果不是普通物件（例如使用者手寫成陣列），不能拿來 spread：
    // `{ ...['a','b'] }` 會變成 `{"0":"a","1":"b"}`，寫回去之後那些數字 key
    // 就從「parser 會忽略的垃圾」升級成「parser 認可的 alias」。整個丟掉才對。
    const spreadable = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const written = updateUserConfig((raw) => {
      if (aliasModel) {
        raw.aliasModel = { ...spreadable(raw.aliasModel), ...aliasModel };
      }
      if (aliasReasoning) {
        raw.aliasReasoningEffort = { ...spreadable(raw.aliasReasoningEffort), ...aliasReasoning };
      }
      if (defaultEffort) {
        raw.defaultReasoningEffort = defaultEffort.toLowerCase();
      }
      for (const key of unset) {
        if (key === 'defaultReasoningEffort') {
          delete raw.defaultReasoningEffort;
          continue;
        }
        // alias 名稱：同時清掉 model 與 reasoning 兩種覆寫。
        for (const bucket of ['aliasModel', 'aliasReasoningEffort'] as const) {
          const map = raw[bucket];
          if (map && typeof map === 'object' && !Array.isArray(map)) {
            delete (map as Record<string, unknown>)[key];
            if (Object.keys(map as Record<string, unknown>).length === 0) {
              delete raw[bucket];
            }
          }
        }
      }
    });

    // 直接回報「剛剛寫進去的那一份」。重新讀一次的話，中間有別的 writer 介入時，
    // 回傳的 payload 描述的就不是本次寫入的結果了（而且會多一次讀檔）。
    // set_config 也只讀同步目錄，不能等背景 vendor 查詢。
    return this.jsonResult(getModelsPayload(written));
  }

  private handleRun(toolArguments: Record<string, unknown>): ServerResult {
    try { assertCanStartJob(); }
    catch (error) { throw new McpError(ErrorCode.InvalidRequest, (error as Error).message); }
    if (isFirstToolUse) {
      console.error(`ai_cli_mcp v${SERVER_VERSION} started at ${serverStartupTime}`);
      isFirstToolUse = false;
    }
    const cliConfigurationError = this.getCliConfigurationError();
    if (cliConfigurationError) {
      throw new McpError(ErrorCode.InvalidParams, cliConfigurationError);
    }
    try {
      const result = this.processService.startProcess({
        prompt: toolArguments.prompt as string | undefined,
        prompt_file: toolArguments.prompt_file as string | undefined,
        workFolder: toolArguments.workFolder as string,
        model: toolArguments.model as string | undefined,
        session_id: toolArguments.session_id as string | undefined,
        reasoning_effort: toolArguments.reasoning_effort as string | undefined,
        // 存在才轉送——`undefined`（沒有意見）與 `[]`（什麼都不給）必須分得開，
        // 折成同一件事會讓一個要求限制的呼叫端拿到全開權限而不自知。
        ...(Array.isArray(toolArguments.capabilities)
          ? { capabilities: (toolArguments.capabilities as unknown[]).map(String) }
          : {}),
        // 同理：存在才轉送。不支援系統提示的 agent 會在 command-builder 被擋下，
        // 呼叫端寧可拿到一個明確的拒絕，也不要以為那段說明送到了。
        ...(typeof toolArguments.system_prompt === 'string'
          ? { system_prompt: toolArguments.system_prompt }
          : {}),
      });
      return this.jsonResult({ ...result, updateNotice: consumeNotice() });
    } catch (error) {
      // 熔斷器攔截：回傳清楚的錯誤，讓呼叫端知道是框架迴圈防護而非一般失敗。
      if (error instanceof CircuitBreakerError) {
        throw new McpError(ErrorCode.InvalidRequest, error.message);
      }
      const message = (error as Error).message;
      const code = /Failed to start/.test(message) ? ErrorCode.InternalError : ErrorCode.InvalidParams;
      throw new McpError(code, message);
    }
  }

  private handleGetResult(toolArguments: Record<string, unknown>): ServerResult {
    if (!toolArguments.pid || typeof toolArguments.pid !== 'number') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: pid');
    }
    try {
      return this.jsonResult(
        this.processService.getProcessResult(toolArguments.pid, !!toolArguments.verbose)
      );
    } catch (error) {
      const message = (error as Error).message;
      const code = /not found/.test(message) ? ErrorCode.InvalidParams : ErrorCode.InternalError;
      throw new McpError(code, message);
    }
  }

  private async handleWait(toolArguments: Record<string, unknown>): Promise<ServerResult> {
    if (
      !toolArguments.pids ||
      !Array.isArray(toolArguments.pids) ||
      toolArguments.pids.length === 0
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Missing or invalid required parameter: pids (must be a non-empty array of numbers)'
      );
    }
    try {
      const results = await this.processService.waitForProcesses(
        toolArguments.pids as number[],
        typeof toolArguments.timeout === 'number' ? toolArguments.timeout : 180,
        !!toolArguments.verbose
      );
      return this.jsonResult(results);
    } catch (error) {
      const message = (error as Error).message;
      const code = /not found/.test(message) ? ErrorCode.InvalidParams : ErrorCode.InternalError;
      throw new McpError(code, message);
    }
  }

  private async handlePeek(toolArguments: Record<string, unknown>): Promise<ServerResult> {
    let pids: number[];
    let peekTimeSec: number;
    let includeToolCalls: boolean;
    try {
      pids = validatePeekPids(toolArguments.pids);
      peekTimeSec = validatePeekTimeSec(toolArguments.peek_time_sec);
      if (
        toolArguments.include_tool_calls !== undefined &&
        typeof toolArguments.include_tool_calls !== 'boolean'
      ) {
        throw new Error('include_tool_calls must be a boolean when provided');
      }
      includeToolCalls = toolArguments.include_tool_calls === true;
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, (error as Error).message);
    }
    try {
      const response = await this.processService.peekProcesses(pids, peekTimeSec, includeToolCalls);
      return this.jsonResult(response);
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to peek processes: ${(error as Error).message}`);
    }
  }

  private handleKillProcess(toolArguments: Record<string, unknown>): ServerResult {
    if (!toolArguments.pid || typeof toolArguments.pid !== 'number') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: pid');
    }
    try {
      return this.jsonResult(this.processService.killProcess(toolArguments.pid));
    } catch (error) {
      const message = (error as Error).message;
      const code = /not found/.test(message) ? ErrorCode.InvalidParams : ErrorCode.InternalError;
      const finalMessage =
        code === ErrorCode.InternalError ? `Failed to terminate process: ${message}` : message;
      throw new McpError(code, finalMessage);
    }
  }

  private async handleQueryUsage(toolArguments: Record<string, unknown>): Promise<ServerResult> {
    try {
      const agents = Array.isArray(toolArguments.agents) ? toolArguments.agents as string[] : undefined;
      const refresh = toolArguments.refresh === true;
      const result = await this.usageService.queryAll({ agents, refresh });
      return this.jsonResult(result);
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `query_usage failed: ${(error as Error).message}`);
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AI CLI MCP server running on stdio');
    // 讓隨附的 plugin 找得到這份安裝的最新判定核心，不必為了修 bug 重裝 plugin。
    this.stopUpdates = scheduleBackgroundUpdates(async (message) => {
      console.error(message.replace(/\r?\n/g, ' | '));
      // MCP 的 logging 是 server capability；client 沒有標準 logging capability。
      // 初始化後透過 SDK 發送，並遵守 client 的 logging/setLevel。
      if (this.server.getClientCapabilities()) {
        await this.server.sendLoggingMessage({ level: 'warning', logger: 'ai-cli.updater', data: message });
      }
    });
  }

  /**
   * 等到 server 真的關閉為止。
   *
   * 為什麼需要這個：`run()` 只等到 transport 接上就 resolve，呼叫端很容易讀成
   * 「server 跑完了」。`bin/ai-cli.ts` 就是這樣中招的——它在 runCli() resolve 之後
   * 呼叫 process.exit()，於是 `ai-cli mcp` 一連上就自殺（實測 0.2 秒退出、stdout
   * 全空），client 只看得到「MCP error -32000: Connection closed」。三個入口裡只有
   * 這一個會 process.exit，另外兩個是「碰巧」沒事，不是設計使然。
   *
   * 注意這個 promise 不是退出時機的主導者：StdioServerTransport 只監聽 stdin 的
   * data / error，**不監聽 end**，所以 client 斷線時 onclose 並不會觸發。那種情況下
   * 是 stdin EOF 釋放掉 handle、event loop 淨空，行程自然以 0 退出。這裡的唯一職責
   * 是擋掉呼叫端「啟動完成 == 可以退出」的誤判。
   */
  waitUntilClosed(): Promise<void> {
    return this.closed;
  }

  async cleanup(): Promise<void> {
    this.stopUpdates?.();
    if (this.sigintHandler) {
      process.removeListener('SIGINT', this.sigintHandler);
    }
    await this.server.close();
  }
}

export async function runMcpServer(): Promise<void> {
  const server = new AiCliMcpServer();
  await server.run();
  // 這個 promise 涵蓋整段 server 生命週期，不只是啟動。少了它，任何在 runMcpServer()
  // resolve 之後呼叫 process.exit 的入口都會在 handshake 完成前把自己殺掉。
  await server.waitUntilClosed();
}
