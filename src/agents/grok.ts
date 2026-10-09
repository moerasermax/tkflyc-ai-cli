/** Grok CLI pipe agent；Messages API NDJSON、檔案 prompt、rules worker 身分鎖。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand, ModelDiscoveryResult } from './types.js';
import { claudeAgent } from './claude.js';
import { WORKER_CONTEXT } from '../core/worker-context.js';
import { buildWorkerEnv } from '../core/worker-env.js';

const GROK_MODELS = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'] as const;
const PROMPT_DIR = join(tmpdir(), 'ai-cli-grok-prompts');
const PROMPT_TTL_MS = 6 * 60 * 60 * 1000;
const STRICT_TOOLS: Record<string, readonly string[]> = {
  'fs/read': ['Read', 'Glob', 'Grep'],
  'analysis/produce': [],
};
const STRICT_DENIED = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'Workflow', 'ToolSearch', 'Skill', 'SlashCommand',
  // Grok 相容名稱不會移除原生 MCP bridge；必須同時禁止原生工具。
  'search_tool', 'use_tool', 'run_terminal_command', 'write', 'search_replace',
  'spawn_subagent', 'workflow', 'scheduler_create', 'scheduler_delete', 'scheduler_list',
  'monitor', 'web_fetch', 'web_search', 'image_gen', 'image_edit', 'image_to_video',
  'reference_to_video', 'kill_command_or_subagent', 'get_command_or_subagent_output',
  'todo_write', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback'];

/** 長中文／引號／換行 prompt 不經 cmd 分詞；暫存檔有私有權限及 TTL。 */
const pendingPrompts = new Map<string, NodeJS.Timeout>();
function cleanPrompt(path: string): void { try { unlinkSync(path); } catch {} clearTimeout(pendingPrompts.get(path)); pendingPrompts.delete(path); }
process.once('exit', () => { for (const path of pendingPrompts.keys()) cleanPrompt(path); });
export function collectGrokPromptFiles(): void {
  let names: string[]; try { names = readdirSync(PROMPT_DIR); } catch { return; }
  for (const name of names) {
    if (!/^prompt_[0-9a-f-]+\.txt$/.test(name)) continue;
    try {
      const path = join(PROMPT_DIR, name);
      if (Date.now() - statSync(path).mtimeMs > PROMPT_TTL_MS) unlinkSync(path);
    } catch { /* 過期清理不可擋住派工。 */ }
  }
}
function writePrompt(prompt: string): string {
  mkdirSync(PROMPT_DIR, { recursive: true, mode: 0o700 });
  collectGrokPromptFiles();
  const path = join(PROMPT_DIR, `prompt_${randomUUID()}.txt`);
  writeFileSync(path, prompt, { encoding: 'utf8', mode: 0o600 });
  const timer = setTimeout(() => cleanPrompt(path), PROMPT_TTL_MS); timer.unref(); pendingPrompts.set(path, timer);
  return path;
}

function command(input: BuildCommandInput, strictArgs?: string[]): BuiltCommand {
  const promptFile = writePrompt(input.prompt);
  const args = ['--prompt-file', promptFile, '--output-format', 'streaming-messages-json',
    ...(strictArgs ?? ['--always-approve']), '--no-subagents', '--cwd', input.cwd,
    '--rules', input.systemPrompt ? `${WORKER_CONTEXT}\n\n${input.systemPrompt}` : WORKER_CONTEXT];
  if (input.resolvedModel) args.push('-m', input.resolvedModel);
  if (input.reasoningEffort) args.push('--reasoning-effort', input.reasoningEffort);
  if (input.sessionId) args.push('--resume', input.sessionId);
  return { cliPath: input.cliPath, args, cwd: input.cwd, agent: 'grok', prompt: input.prompt,
    temporaryPromptFile: promptFile, releaseTemporaryPrompt: () => { clearTimeout(pendingPrompts.get(promptFile)); pendingPrompts.delete(promptFile); },
    resolvedModel: input.resolvedModel, sessionId: input.sessionId };
}

function buildStrictCommand(input: BuildCommandInput, capabilities: readonly string[]): BuiltCommand {
  const tools = new Set<string>();
  for (const capability of capabilities) {
    const mapped = STRICT_TOOLS[capability];
    if (mapped === undefined) throw new Error(`grok 的嚴格模式無法保證能力「${capability}」——拒絕啟動（不放寬）。`);
    for (const tool of mapped) tools.add(tool);
  }
  // --tools 選擇相容讀取工具；deny 明確移除原生 MCP bridge、shell、寫入與子 agent。
  // 未實測 --tools 空字串的語意：純產出／空 capabilities 無法保證零工具，直接拒絕。
  if (tools.size === 0) throw new Error('grok 尚未確認零工具模式（--tools 空字串），拒絕啟動（不放寬）。');
  // 不得把 capabilities 當一般模式，也不得加 --always-approve。
  return command(input, ['--tools', [...tools].join(','), '--disallowed-tools', STRICT_DENIED.join(','),
    '--disable-web-search', '--permission-mode', 'dontAsk']);
}

/** 沿用 Claude 的 assistant/session/tool 解析；result 成敗及 usage 留在 Grok 自己的通道。 */
export function grokResultFailed(result: { is_error?: boolean; subtype?: string; stop_reason?: string }): boolean {
  return result.is_error === true || result.subtype !== 'success' || result.stop_reason === 'cancelled';
}
function parseOutput(stdout: string): unknown {
  if (!stdout.trim()) return null;
  let events: any[];
  try { events = [JSON.parse(stdout)]; }
  catch { events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  const result = events.filter(event => event?.type === 'result').at(-1);
  const parsed: any = claudeAgent.parseOutput('{}\n' + events.map(e => JSON.stringify(e)).join('\n'), '');
  if (!result) return parsed;
  const raw = result.usage;
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const usage = raw && valid(raw.input_tokens) && valid(raw.output_tokens)
    && (raw.cache_read_input_tokens === undefined || valid(raw.cache_read_input_tokens))
    && (raw.cache_creation_input_tokens === undefined || valid(raw.cache_creation_input_tokens)) ? {
      // Anthropic Messages wire format：原始 input 不含快取，統一後 input 含兩種快取。
      input_tokens: raw.input_tokens + (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0),
      cached_input_tokens: raw.cache_read_input_tokens ?? 0,
      cache_write_input_tokens: raw.cache_creation_input_tokens ?? 0,
      output_tokens: raw.output_tokens,
      reasoning_output_tokens: valid(raw.output_tokens_details?.thinking_tokens) ? raw.output_tokens_details.thinking_tokens : 0,
      ...(valid(result.num_turns) ? { num_turns: result.num_turns } : {}),
      ...(valid(result.total_cost_usd) ? { cost_usd_nominal: result.total_cost_usd } : {}),
      source: 'grok result',
    } : undefined;
  const { usage: _claudeUsage, ...rest } = parsed ?? {};
  const failed = grokResultFailed(result);
  return { ...result, ...rest, message: typeof result.result === 'string' ? result.result : rest.message,
    ...(failed ? { is_error: true, error: `Grok execution failed: subtype=${result.subtype ?? 'unknown'}; stop_reason=${result.stop_reason ?? 'unknown'}` } : {}),
    ...(raw !== undefined ? { raw_usage: raw } : {}), usage };
}

/** 只收 Available models 區塊的標記列，登入錯誤／default 名稱不能冒充成功清單。 */
export function parseGrokModelsOutput(stdout: string): readonly string[] | null {
  const clean = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const section = clean.split(/^\s*Available models:\s*$/m)[1];
  if (!section) return null;
  const models = section.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*[*-]\s+(grok-[a-z0-9][a-z0-9.-]*)(?:\s+\(default\))?\s*$/);
    return match ? [match[1]] : [];
  });
  return models.length ? [...new Set(models)] : null;
}

/** 有界非同步探查；只終止這次啟動的程序，失败交由 catalog 使用既有快取／fallback。 */
function discoverModels(cliPath: string): Promise<ModelDiscoveryResult> {
  return new Promise(resolve => {
    const configured = Number(process.env.AI_CLI_DISCOVER_TIMEOUT_MS);
    const timeoutMs = Number.isInteger(configured) && configured > 0 && configured <= 2_147_483_647 ? configured : 15_000;
    let child: ChildProcess;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (models: readonly string[] | null, note: string | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ models, note });
    };
    try {
      // Grok 是 native executable；不經 shell，不允許 .cmd shim 對 rules 重新切詞。
      child = spawn(cliPath, ['models'], { env: buildWorkerEnv(), windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => { if (!settled) stdout += chunk; });
      child.stderr!.on('data', (chunk: string) => { if (!settled) stderr += chunk; });
      child.on('error', error => finish(null, error.message));
      child.on('close', code => {
        if (code !== 0) return finish(null, stderr.trim().split(/\r?\n/)[0] || `grok models 非零退出（${code}）`);
        const models = parseGrokModelsOutput(stdout);
        finish(models, models ? null : `grok models 未回傳可解析清單：${(stderr || stdout).trim().slice(0, 300)}`);
      });
      timer = setTimeout(() => {
        if (settled) return;
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else if (child.pid) {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* 已退出。 */ } });
            killer.on('exit', code => { if (code !== 0) { try { child.kill('SIGKILL'); } catch { /* 已退出。 */ } } });
          }
        } catch { /* 已退出。 */ }
        finish(null, `grok models 逾時（>${timeoutMs} ms）`);
      }, timeoutMs);
    } catch (error) { finish(null, String(error)); }
  });
}

export const grokAgent: AgentDefinition = {
  id: 'grok', models: GROK_MODELS, matchesModel: model => model.startsWith('grok-'),
  binary: { envVarName: 'GROK_CLI_NAME', defaultCliName: 'grok', preferPath: true,
    localInstallPath: join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok') },
  reasoning: { supported: true, allowed: new Set(['low', 'medium', 'high', 'xhigh']),
    invalidMessage: 'Grok reasoning_effort supports only low, medium, high, xhigh (live verified: grok 1.0.50).' },
  supportsSystemPrompt: true, spawnMode: 'pipe', win32DirectExec: true,
  buildCommand: input => command(input), buildStrictCommand, parseOutput, discoverModels,
};
