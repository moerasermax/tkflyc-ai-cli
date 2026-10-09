/**
 * Peek 事件擷取器。1:1 還原 dist/parsers.js 的 PeekEventExtractor。
 *
 * 注意：這塊邏輯是「依 agent 格式分流」的，目前集中在此（與 dist 行為一致）。
 * 未來若要更徹底的 registry 化，可把各 agent 的 peek 規則移進各自 agents/<name>.ts。
 */

import type { AgentId } from '../agents/types.js';
import { stripAnsi } from './ansi.js';
import { debugLog } from './debug.js';
import { StringDecoder } from 'node:string_decoder';

const PEEK_TOOL_SUMMARY_MAX_LENGTH = 200;

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

interface Summary {
  summary: string;
  summary_truncated?: boolean;
  server?: string;
}

function boundedSummary(value: unknown): Summary {
  const summary = oneLine(value);
  if (summary.length <= PEEK_TOOL_SUMMARY_MAX_LENGTH) {
    return { summary };
  }
  return {
    summary: `${summary.slice(0, PEEK_TOOL_SUMMARY_MAX_LENGTH - 3)}...`,
    summary_truncated: true,
  };
}

function normalizeMcpToolName(tool: string, explicitServer?: string): Summary | null {
  if (explicitServer) {
    return { server: explicitServer, ...boundedSummary(`${explicitServer}.${tool}`) };
  }
  const mcpDouble = tool.match(/^mcp__([^_]+)__(.+)$/);
  if (mcpDouble) {
    return { server: mcpDouble[1], ...boundedSummary(`${mcpDouble[1]}.${mcpDouble[2]}`) };
  }
  const mcpSingle = tool.match(/^mcp_([^_]+)_(.+)$/);
  if (mcpSingle) {
    return { server: mcpSingle[1], ...boundedSummary(`${mcpSingle[1]}.${mcpSingle[2]}`) };
  }
  const acmShort = tool.match(/^acm_(.+)$/);
  if (acmShort) {
    return { server: 'acm', ...boundedSummary(`acm.${acmShort[1]}`) };
  }
  return null;
}

function buildToolSummary(
  tool: string,
  options: { command?: string; server?: string } = {}
): Summary {
  if (typeof options.command === 'string' && options.command.trim()) {
    return boundedSummary(options.command);
  }
  const mcpSummary = normalizeMcpToolName(tool, options.server);
  if (mcpSummary) {
    return mcpSummary;
  }
  return boundedSummary(tool || 'tool_call');
}

function normalizeToolStatus(
  rawStatus: unknown,
  exitCode: unknown,
  defaultStatus = 'unknown'
): string {
  if (typeof exitCode === 'number') {
    return exitCode === 0 ? 'success' : 'failed';
  }
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (['success', 'succeeded', 'ok', 'completed'].includes(status)) return 'success';
  if (['failed', 'failure', 'error', 'errored'].includes(status)) return 'failed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  return defaultStatus;
}

interface ToolCallEventParams {
  ts: string;
  phase: 'started' | 'completed';
  tool?: string;
  id?: string;
  server?: string;
  command?: string;
  status?: unknown;
  exit_code?: number;
  duration_ms?: number;
  defaultStatus?: string;
}

interface PeekEvent {
  kind: string;
  ts: string;
  [key: string]: unknown;
}

function createToolCallEvent(params: ToolCallEventParams): PeekEvent {
  const tool = params.tool || 'tool_call';
  const summary = buildToolSummary(tool, { server: params.server, command: params.command });
  const event: PeekEvent = {
    kind: 'tool_call',
    ts: params.ts,
    phase: params.phase,
    tool,
    summary: summary.summary,
  };
  if (params.id) event.id = params.id;
  if (summary.server) event.server = summary.server;
  else if (params.server) event.server = params.server;
  if (summary.summary_truncated) event.summary_truncated = true;
  if (params.phase === 'completed') {
    event.status = normalizeToolStatus(params.status, params.exit_code, params.defaultStatus);
    if (typeof params.exit_code === 'number') event.exit_code = params.exit_code;
    if (typeof params.duration_ms === 'number' && Number.isFinite(params.duration_ms)) {
      event.duration_ms = params.duration_ms;
    }
  }
  return event;
}

interface RememberedTool {
  tool: string;
  server?: string;
  summary: string;
  summary_truncated?: boolean;
}

function rememberToolCall(event: PeekEvent, memory: Map<string, RememberedTool>): void {
  if (event.kind !== 'tool_call' || !event.id) return;
  memory.set(event.id as string, {
    tool: event.tool as string,
    server: event.server as string | undefined,
    summary: event.summary as string,
    summary_truncated: event.summary_truncated as boolean | undefined,
  });
}

function createRememberedCompletion(params: {
  ts: string;
  id?: string;
  memory: Map<string, RememberedTool>;
  fallbackTool: string;
  status?: unknown;
  defaultStatus?: string;
}): PeekEvent {
  const remembered = params.id ? params.memory.get(params.id) : undefined;
  const event = createToolCallEvent({
    ts: params.ts,
    phase: 'completed',
    id: params.id,
    tool: remembered?.tool || params.fallbackTool,
    server: remembered?.server,
    status: params.status,
    defaultStatus: params.defaultStatus,
  });
  if (remembered) {
    event.summary = remembered.summary;
    if (remembered.summary_truncated) event.summary_truncated = true;
  }
  return event;
}

function extractPeekEventsFromParsedEvent(
  agent: AgentId,
  parsed: any,
  observedAt: string,
  includeToolCalls: boolean,
  memory: Map<string, RememberedTool>
): PeekEvent[] {
  if (agent === 'codex') {
    if (parsed.item?.type === 'agent_message' && typeof parsed.item.text === 'string' && parsed.item.text.trim()) {
      return [{ kind: 'message', ts: observedAt, text: parsed.item.text }];
    }
    if (parsed.msg?.type === 'agent_message' && typeof parsed.msg.message === 'string' && parsed.msg.message.trim()) {
      return [{ kind: 'message', ts: observedAt, text: parsed.msg.message }];
    }
    if (includeToolCalls && (parsed.type === 'item.started' || parsed.type === 'item.completed')) {
      const item = parsed.item;
      if (item?.type === 'command_execution') {
        const event = createToolCallEvent({
          ts: observedAt,
          phase: parsed.type === 'item.started' ? 'started' : 'completed',
          id: item.id,
          tool: 'command_execution',
          command: item.command,
          status: item.status || item.error,
          exit_code: typeof item.exit_code === 'number' ? item.exit_code : undefined,
          defaultStatus: parsed.type === 'item.completed' ? 'success' : 'unknown',
        });
        rememberToolCall(event, memory);
        return [event];
      }
      if (item?.type === 'mcp_tool_call') {
        const event = createToolCallEvent({
          ts: observedAt,
          phase: parsed.type === 'item.started' ? 'started' : 'completed',
          id: item.id,
          tool: item.tool || 'mcp_tool_call',
          server: item.server,
          status: item.status || item.error,
          defaultStatus: parsed.type === 'item.completed' ? 'success' : 'unknown',
        });
        rememberToolCall(event, memory);
        return [event];
      }
    }
    return [];
  }
  if (agent === 'claude' || agent === 'grok' || agent === 'direct-api') {
    if (agent === 'direct-api' && parsed.type === 'message' && typeof parsed.content === 'string' && parsed.content.trim()) {
      return [{ kind: 'message', ts: observedAt, text: parsed.content }];
    }
    if (agent === 'direct-api' && includeToolCalls && parsed.type === 'tool_use') {
      return [
        createToolCallEvent({
          ts: observedAt,
          phase: 'completed',
          id: typeof parsed.id === 'string' ? parsed.id : undefined,
          tool: typeof parsed.tool === 'string' ? parsed.tool : 'tool_use',
          command: typeof parsed.input?.command === 'string' ? parsed.input.command : undefined,
          status: parsed.status,
          defaultStatus: 'success',
        }),
      ];
    }
    if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      const events: PeekEvent[] = [];
      for (const content of parsed.message.content) {
        if (content?.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
          events.push({ kind: 'message', ts: observedAt, text: content.text });
        } else if (includeToolCalls && content?.type === 'tool_use') {
          const event = createToolCallEvent({
            ts: observedAt,
            phase: 'started',
            id: content.id,
            tool: content.name || 'tool_use',
            command: content.input?.command,
          });
          rememberToolCall(event, memory);
          events.push(event);
        }
      }
      return events;
    }
    if ((agent === 'claude' || agent === 'grok') && includeToolCalls && parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
      const events: PeekEvent[] = [];
      for (const content of parsed.message.content) {
        if (content?.type === 'tool_result') {
          events.push(
            createRememberedCompletion({
              ts: observedAt,
              id: content.tool_use_id,
              memory,
              fallbackTool: 'tool_result',
              status: content.is_error === true ? 'failed' : undefined,
              defaultStatus: content.is_error === true ? 'failed' : 'success',
            })
          );
        }
      }
      return events;
    }
    return [];
  }
  return [];
}


/** peek 與 liveness 共用的串流分行／NDJSON 解碼，保留半行與跨 chunk 的 UTF-8。 */
class AgentEventDecoder {
  private pending = '';
  private utf8 = new StringDecoder('utf8');

  constructor(private agent: AgentId) {}

  push(chunk: Buffer | string): any[] {
    const text = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    const lines = `${this.pending}${text}`.split(/\r?\n/);
    this.pending = lines.pop() || '';
    return this.decodeLines(lines);
  }

  flush(): any[] {
    const line = this.pending + this.utf8.end();
    this.pending = '';
    return this.decodeLines([line]);
  }

  private decodeLines(lines: string[]): any[] {
    const events: any[] = [];
    for (const line of lines) {
      if (this.agent === 'antigravity') {
        const text = stripAnsi(line).trim();
        if (text) events.push({ type: 'text', text });
      } else if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
        } catch {
          debugLog(`[Debug] Skipping invalid agent JSON line: ${line}`);
        }
      }
    }
    return events;
  }
}

/** 一個有意義的輸出事件算一次；不把空行、壞 JSON 或半行算成進展。 */
export class LivenessEventExtractor {
  private decoder: AgentEventDecoder;

  constructor(private agent: AgentId) {
    this.decoder = new AgentEventDecoder(agent);
  }

  push(chunk: Buffer | string): string[] {
    return this.summaries(this.decoder.push(chunk));
  }

  flush(): string[] {
    return this.summaries(this.decoder.flush());
  }

  private summaries(events: any[]): string[] {
    return events.flatMap((event) => {
      if (this.agent === 'antigravity') return [oneLine(event.text).slice(0, 80)];
      if (typeof event.type !== 'string' || !event.type.trim()) return [];
      let summary = oneLine(event.type);
      const text = (value: unknown) => typeof value === 'string' ? oneLine(value) : '';
      if (this.agent === 'codex') {
        const item = event.item ?? event.msg;
        if (typeof item?.type === 'string') summary += ` ${oneLine(item.type)}`;
        const detail = (text(item?.command) || text(item?.text) || text(item?.message) || text(item?.tool)).slice(0, 80);
        if (detail) summary += `: ${detail}`;
      } else if (this.agent === 'claude' || this.agent === 'grok') {
        const content = event.message?.content;
        const tool = Array.isArray(content) ? [...content].reverse().find((block: any) => block?.type === 'tool_use') : null;
        if (tool) summary += ` tool_use ${text(tool.name)}`;
        else if (event.type === 'tool_use') summary += ` ${text(event.name)}`;
      }
      return [summary.slice(0, 120)];
    });
  }
}

export class PeekEventExtractor {
  private agent: AgentId;
  private decoder: AgentEventDecoder;
  private includeToolCalls: boolean;
  private toolMemory = new Map<string, RememberedTool>();

  // source / terminal 兩個選項在 5.0.0 隨 forge 一起移除：它們只被 forge 的擷取策略
  // 讀取（stderr 全丟、pending 只在 terminal 時吐出），其餘 agent 從來不看。留著會是
  // 「看起來有作用、其實沒人讀」的死狀態。
  constructor(agent: AgentId, options: { includeToolCalls?: boolean } = {}) {
    this.agent = agent;
    this.decoder = new AgentEventDecoder(agent);
    this.includeToolCalls = options.includeToolCalls === true;
  }

  push(chunk: Buffer | string, observedAt: string = new Date().toISOString()): PeekEvent[] {
    return this.extractEvents(this.decoder.push(chunk), observedAt);
  }

  flush(observedAt: string = new Date().toISOString()): PeekEvent[] {
    return this.extractEvents(this.decoder.flush(), observedAt);
  }

  private extractEvents(parsedEvents: any[], observedAt: string): PeekEvent[] {
    if (this.agent === 'antigravity') {
      return parsedEvents.map(({ text }) => ({ kind: 'message', ts: observedAt, text }));
    }
    const events: PeekEvent[] = [];
    for (const parsed of parsedEvents) {
      try {
        events.push(
          ...extractPeekEventsFromParsedEvent(
            this.agent,
            parsed,
            observedAt,
            this.includeToolCalls,
            this.toolMemory
          )
        );
      } catch {
        debugLog('[Debug] Skipping invalid peek event shape');
      }
    }
    return events;
  }

}
