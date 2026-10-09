/**
 * `ai-cli` 指令列介面。對應 dist/app/cli.js。
 * 子指令：run, wait, peek, ps, jobs, result, kill, cleanup, doctor, models, mcp, update, usage, help。
 *
 * usage 改為透過環境變數 AI_CLI_USAGE_PLUGIN_BIN 設定外部 plugin（見 plugins/usage.ts）。
 */

import { runMcpServer } from './mcp.js';
import { FileProcessService, type FileStartOptions } from '../core/file-process-service.js';
import { getCliDoctorStatus } from '../core/doctor.js';
import { getModelsPayload } from '../models/catalog.js';
import { refreshCatalogV2 } from '../models/catalog-v2.js';
import { runExec } from './exec.js';
import { validatePeekPids, validatePeekTimeSec } from '../core/peek.js';
import { runUsagePlugin } from '../plugins/usage.js';
import { runUpdateCli } from '../core/updater.js';
import { assertCanStartJob } from '../core/worker-env.js';
import { runJobs } from './jobs.js';

export const CLI_HELP_TEXT = `Usage: ai-cli <command> [options]

Commands:
  run       Start an AI CLI process in the background
  wait      Wait for pids; timeout returns JSON + liveness (exit 3)
  peek      Observe new agent events for a short window
  ps        List tracked processes with elapsed time and running liveness
  jobs      List all sessions' jobs (jobs [--watch] [--json] [--running])
  result    Get the current result and running liveness for a pid
  kill      Terminate a tracked pid
  cleanup   Remove completed and failed tracked processes
  doctor    Check supported AI CLI binaries
  update    Check/apply updates (update [--check] [--json])
  exec      Run an agent in the foreground (NDJSON frames, caller owns the process)
  models    List candidate models and aliases
  mcp       Start the MCP server
  usage     Report local AI CLI usage/quota across providers
  help      Show this help message
`;

export const RUN_HELP_TEXT = `Usage: ai-cli run --cwd <path> [options]

Start an AI CLI process in the background.

Options:
  --cwd <path>                 Working directory
  --prompt <text>              Prompt text
  --prompt-file <path>         Path to a prompt file
  --model <model>              Model name or alias (e.g. sonnet, claude-ultra, gpt-6-astra, codex-ultra, codex-ultracode, agy, or-qwen/qwen3.7-plus)
  --session-id <id>            Resume a previous session where supported, including direct-api sessions
  --reasoning-effort <level>   Claude: low/medium/high/xhigh/max; Codex also ultra; Grok: low/medium/high/xhigh (live verified: grok 1.0.50); unsupported for Antigravity and direct-api
  --help, -h                   Show this help message

Compatibility aliases:
  --workFolder, --work-folder
  --prompt_file
  --session_id
  --reasoning_effort
`;

export const WAIT_HELP_TEXT = `Usage: ai-cli wait <pid...> [options]

Wait for one or more tracked processes to finish.
By default each result uses the compact shape; set --verbose to include full metadata and detailed parsed output.
Timeout returns the current JSON array; still-running items have timedOut: true and liveness.
Exit codes: 0 = all terminal, 3 = timed out with processes still running, 1 = error (including unknown pid).
Poll with --timeout 90 or less. While liveness.alive is true, keep waiting; use peek for live events.
Codex/Claude can emit nothing while reasoning.

Options:
  --timeout <seconds>          Maximum wait time (default 180; recommended <= 90 for polling)
  --verbose                    Return full metadata and detailed parsed output
  --help, -h                   Show this help message
`;

export const RESULT_HELP_TEXT = `Usage: ai-cli result <pid> [options]

Get the current output and status of a tracked process. By default this returns a compact result shape; set --verbose to include full metadata and detailed parsed output.
Running results include liveness: alive, elapsedSec, sinceLastOutputSec, stdoutBytes, stderrBytes, lastEvent, eventCount, hint.

Options:
  --verbose                    Return full metadata and detailed parsed output
  --help, -h                   Show this help message
`;

export const PEEK_HELP_TEXT = `Usage: ai-cli peek <pid...> [options]

Observe new natural-language agent messages, and optionally tool calls, for a short one-shot window.
Message extraction is supported for Codex, Claude, Grok, direct-api, and Antigravity.
This is not a history API, gapless streaming, or stdout/stderr tailing. No --follow mode is available in v1.

Options:
  --time <seconds>             Observation window in seconds. Defaults to 10, maximum 60
  --include-tool-calls         Include normalized tool_call events without raw tool output
  --help, -h                   Show this help message
`;

export const KILL_HELP_TEXT = `Usage: ai-cli kill <pid>

Terminate a tracked process.

Options:
  --help, -h                   Show this help message
`;

export const CLEANUP_HELP_TEXT = `Usage: ai-cli cleanup

Remove completed and failed tracked processes.

Options:
  --help, -h                   Show this help message
`;

export const PS_HELP_TEXT = `Usage: ai-cli ps

List tracked processes.
Running items include liveness plus elapsedSec, sinceLastOutputSec and lastEvent.
Terminal items include elapsedSec when the end time is known; they have no liveness.

Options:
  --help, -h                   Show this help message
`;

export const EXEC_HELP_TEXT = `Usage: ai-cli exec

Run an agent in the FOREGROUND, streaming raw vendor stdout as NDJSON frames.
Unlike \`run\`, this process stays alive until the agent finishes, so the caller
owns the process (job/process-group containment, cancellation, PID identity).

Input: a JSON object on stdin
  { "cwd": "...", "model": "...", "prompt": "...",
    "capabilities": ["fs/read"], "reasoningEffort": "high", "sessionId": "..." }

Output on stdout: one JSON object per line
  {"v":1,"type":"started",...}
  {"v":1,"type":"stdout","seq":1,"encoding":"base64","data":"..."}
  {"v":1,"type":"terminal","status":"succeeded","exitCode":0,"signal":null,"detail":null}

Vendor stderr is forwarded verbatim to this process's stderr.
The terminal frame is emitted only after child close + stdout EOF + stderr EOF.

Capabilities are FAIL-CLOSED: agents without a strict (non-bypass) mode are
refused rather than run with permission bypass.

Options:
  --help, -h                   Show this help message
`;

export const MODELS_HELP_TEXT = `Usage: ai-cli models

List candidate models and aliases (candidates, not an allowlist — see modelListCaveat in the output).

Options:
  --help, -h                   Show this help message
`;

export const DOCTOR_HELP_TEXT = `Usage: ai-cli doctor

Check whether supported AI CLI binaries are available. direct-api provider config is checked when a direct-api model is used.
This checks binary availability and path resolution only; it does not verify login state or terms acceptance.

Options:
  --help, -h                   Show this help message
`;

export const MCP_HELP_TEXT = `Usage: ai-cli mcp

Start the MCP server.
`;

export const USAGE_HELP_TEXT = `Usage: ai-cli usage [options]

Report local AI CLI usage/quota across providers.
Requires the AI_CLI_USAGE_PLUGIN_BIN environment variable pointing to your ai-cli-usage.mjs.

Options:
  --json                     Output machine-readable JSON
  --help, -h                 Show this help message
`;

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  startMcpServer: () => Promise<void>;
  runProcess: (options: FileStartOptions) => Promise<unknown>;
  listProcesses: () => Promise<unknown>;
  getProcessResult: (pid: number, verbose: boolean) => Promise<unknown>;
  waitForProcesses: (pids: number[], timeoutSeconds: number | undefined, verbose: boolean) => Promise<unknown>;
  peekProcesses: (pids: number[], peekTimeSec: number, includeToolCalls: boolean) => Promise<unknown>;
  killProcess: (pid: number) => Promise<unknown>;
  cleanupProcesses: () => Promise<unknown>;
  getDoctorStatus: () => unknown;
}

let fileProcessService: FileProcessService | null = null;
function getFileProcessService(): FileProcessService {
  if (!fileProcessService) {
    fileProcessService = new FileProcessService();
  }
  return fileProcessService;
}

const defaultDeps: CliDeps = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  startMcpServer: () => runMcpServer(),
  runProcess: (options) => getFileProcessService().startProcess(options),
  listProcesses: () => getFileProcessService().listProcesses(),
  getProcessResult: (pid, verbose) => getFileProcessService().getProcessResult(pid, verbose),
  waitForProcesses: (pids, timeoutSeconds, verbose) =>
    getFileProcessService().waitForProcesses(pids, timeoutSeconds, verbose),
  peekProcesses: (pids, peekTimeSec, includeToolCalls) =>
    getFileProcessService().peekProcesses(pids, peekTimeSec, includeToolCalls),
  killProcess: (pid) => getFileProcessService().killProcess(pid),
  cleanupProcesses: () => getFileProcessService().cleanupProcesses(),
  getDoctorStatus: () => getCliDoctorStatus(),
};

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.h = '';
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = '';
    }
  }
  return { positionals, flags };
}

function getFirstFlag(flags: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    if (name in flags) return flags[name];
  }
  return undefined;
}

function parsePositivePid(value: string | undefined): number | null {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

function writeJson(stdout: (text: string) => void, value: unknown): void {
  stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function hasHelpFlag(flags: Record<string, string>): boolean {
  return 'help' in flags || 'h' in flags;
}

function parsePeekCliPids(values: string[]): number[] {
  return validatePeekPids(values.map((value) => Number(value)));
}

export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const {
    stdout,
    stderr,
    startMcpServer,
    runProcess,
    listProcesses,
    getProcessResult,
    waitForProcesses,
    peekProcesses,
    killProcess,
    cleanupProcesses,
    getDoctorStatus,
  } = { ...defaultDeps, ...deps };

  const [command] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    stdout(CLI_HELP_TEXT);
    return 0;
  }

  if (command === 'mcp') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(MCP_HELP_TEXT);
      return 0;
    }
    // startMcpServer()（= runMcpServer）的 promise 涵蓋整段 server 生命週期，
    // 不是「啟動完成就 resolve」。這點是必要的：bin/ai-cli.ts 會在 runCli() resolve
    // 之後呼叫 process.exit()，如果這裡提早回來，server 就會在 handshake 前自殺
    // （4.1.2 之前的 bug）。不要把它「優化」成 fire-and-forget。
    await startMcpServer();
    return 0;
  }

  if (command === 'update') return runUpdateCli(argv.slice(1), { stdout });
  if (command === 'jobs') return runJobs(argv.slice(1), { stdout, stderr });

  if (command === 'usage') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(USAGE_HELP_TEXT);
      return 0;
    }
    return await runUsagePlugin(argv.slice(1), { stdout, stderr });
  }

  if (command === 'run') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(RUN_HELP_TEXT);
      return 0;
    }
    try { assertCanStartJob(); }
    catch (error) { stderr(`${(error as Error).message}\n`); return 1; }
    const cwd = getFirstFlag(flags, ['cwd', 'workFolder', 'work-folder']);
    if (!cwd) {
      stderr('Missing required option: --cwd\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    const prompt = getFirstFlag(flags, ['prompt']);
    const promptFile = getFirstFlag(flags, ['prompt-file', 'prompt_file']);
    if (!prompt && !promptFile) {
      stderr('Missing required option: --prompt or --prompt-file\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    const result = await runProcess({
      cwd,
      prompt: prompt || undefined,
      prompt_file: promptFile || undefined,
      model: getFirstFlag(flags, ['model']) || undefined,
      session_id: getFirstFlag(flags, ['session-id', 'session_id']) || undefined,
      reasoning_effort: getFirstFlag(flags, ['reasoning-effort', 'reasoning_effort']) || undefined,
    });
    writeJson(stdout, result);
    return 0;
  }

  if (command === 'ps') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(PS_HELP_TEXT);
      return 0;
    }
    writeJson(stdout, await listProcesses());
    return 0;
  }

  if (command === 'result') {
    const { positionals, flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(RESULT_HELP_TEXT);
      return 0;
    }
    const pid = parsePositivePid(positionals[0]);
    if (pid === null) {
      stderr('Missing required pid argument\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    writeJson(stdout, await getProcessResult(pid, 'verbose' in flags));
    return 0;
  }

  if (command === 'wait') {
    const { positionals, flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(WAIT_HELP_TEXT);
      return 0;
    }
    const pids = positionals.map((value) => parsePositivePid(value));
    if (pids.length === 0) {
      stderr('Missing required pid arguments\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    if (pids.some((pid) => pid === null)) {
      stderr('All pid arguments must be positive integers\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    const timeoutRaw = getFirstFlag(flags, ['timeout']);
    const timeout = timeoutRaw ? Number(timeoutRaw) : undefined;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      stderr('Invalid --timeout value\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    const results = await waitForProcesses(pids as number[], timeout, 'verbose' in flags);
    writeJson(stdout, results);
    return Array.isArray(results) && results.some((result) => result.status === 'running' && result.timedOut === true) ? 3 : 0;
  }

  if (command === 'peek') {
    const { positionals, flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(PEEK_HELP_TEXT);
      return 0;
    }
    if ('follow' in flags) {
      stderr('peek does not support --follow in v1\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    let pids: number[];
    let peekTimeSec: number;
    try {
      pids = parsePeekCliPids(positionals);
      const timeRaw = getFirstFlag(flags, ['time']);
      peekTimeSec = validatePeekTimeSec(timeRaw === undefined ? undefined : Number(timeRaw));
    } catch (error) {
      stderr(`${(error as Error).message}\n`);
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    writeJson(
      stdout,
      await peekProcesses(
        pids,
        peekTimeSec,
        'include-tool-calls' in flags || 'include_tool_calls' in flags
      )
    );
    return 0;
  }

  if (command === 'kill') {
    const { positionals, flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(KILL_HELP_TEXT);
      return 0;
    }
    const pid = parsePositivePid(positionals[0]);
    if (pid === null) {
      stderr('Missing required pid argument\n');
      stdout(CLI_HELP_TEXT);
      return 1;
    }
    writeJson(stdout, await killProcess(pid));
    return 0;
  }

  if (command === 'cleanup') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(CLEANUP_HELP_TEXT);
      return 0;
    }
    writeJson(stdout, await cleanupProcesses());
    return 0;
  }

  if (command === 'exec') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(EXEC_HELP_TEXT);
      return 0;
    }
    /*
      ★ 這裡 return 之後，`bin/ai-cli.ts` 會呼叫 process.exit()。
        對 exec 而言那是**不安全**的：stdout 是 pipe 時非同步，最後一個
        frame 可能還在緩衝區。所以 bin 那側對 exec 改成設 exitCode。
    */
    return await runExec();
  }

  if (command === 'models') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(MODELS_HELP_TEXT);
      return 0;
    }
    await refreshCatalogV2();
    writeJson(stdout, getModelsPayload());
    return 0;
  }

  if (command === 'doctor') {
    const { flags } = parseArgs(argv.slice(1));
    if (hasHelpFlag(flags)) {
      stdout(DOCTOR_HELP_TEXT);
      return 0;
    }
    writeJson(stdout, getDoctorStatus());
    return 0;
  }

  stderr(`Unknown subcommand: ${command}\n`);
  stdout(CLI_HELP_TEXT);
  return 1;
}
