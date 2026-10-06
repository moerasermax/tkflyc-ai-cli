/** 組裝對外回傳的 process result。1:1 還原 dist/process-result.js。 */

import type { AgentId } from '../agents/types.js';
import type { ProcessLiveness } from './liveness.js';

export interface ProcessResultContext {
  pid: number;
  agent: AgentId;
  status: string;
  exitCode?: number;
  startTime: string;
  workFolder: string;
  prompt: string;
  model?: string;
  stdout: string;
  stderr: string;
  liveness?: ProcessLiveness;
}

function compactAgentOutput(agentOutput: any): any {
  if (!agentOutput || typeof agentOutput !== 'object') {
    return null;
  }
  const { tools: _tools, ...rest } = agentOutput;
  const compact = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined && value !== null)
  );
  return Object.keys(compact).length > 0 ? compact : null;
}

function shapeAgentOutput(agent: AgentId, agentOutput: any, verbose: boolean): any {
  return verbose ? agentOutput : compactAgentOutput(agentOutput);
}

function hasMeaningfulParsedOutput(agentOutput: any): boolean {
  if (!agentOutput || typeof agentOutput !== 'object') {
    return false;
  }
  return Object.entries(agentOutput).some(([key, value]) => {
    if (value === undefined || value === null) {
      return false;
    }
    if (key === 'session_id' || key === 'usage') {
      return false;
    }
    if (key === 'tools') {
      return Array.isArray(value) ? value.length > 0 : true;
    }
    return true;
  });
}

export const RAW_OUTPUT_TAIL_CHARS = 4096;

// 只留結尾一段；被截掉時另外標出原始長度，呼叫端才知道看到的不是全部（要全文用 verbose）。
function _rawTail(field: 'stdout' | 'stderr', text: string | undefined): Record<string, unknown> {
  const value = text ?? '';
  if (value.length <= RAW_OUTPUT_TAIL_CHARS) return { [field]: value };
  let tail = value.slice(-RAW_OUTPUT_TAIL_CHARS);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1); // 不從半個字元（UTF-16 代理對的後半）開始
  return {
    [field]: tail,
    [`${field}Truncated`]: { totalChars: value.length, shownChars: tail.length },
  };
}

function shouldPreserveRawFailureOutput(context: ProcessResultContext): boolean {
  return context.status === 'failed' && false;
}

export function buildProcessResult(
  context: ProcessResultContext,
  agentOutput: any,
  verbose = false
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    pid: context.pid,
    agent: context.agent,
    status: context.status,
    exitCode: context.exitCode ?? null,
    model: context.model ?? null,
  };
  if (context.status === 'running' && context.liveness) {
    response.liveness = context.liveness;
  }
  if (verbose) {
    response.startTime = context.startTime;
    response.workFolder = context.workFolder;
    response.prompt = context.prompt;
  }
  if (agentOutput?.session_id) {
    response.session_id = agentOutput.session_id;
  }
  const shapedAgentOutput = shapeAgentOutput(context.agent, agentOutput, verbose);
  const preserveRawFailureOutput = shouldPreserveRawFailureOutput(context);
  if (hasMeaningfulParsedOutput(shapedAgentOutput) && (verbose || !preserveRawFailureOutput)) {
    response.agentOutput = shapedAgentOutput;
  }
  if (!response.agentOutput || preserveRawFailureOutput) {
    // 精簡結果不再整份帶原始輸出。2026-10-06 實測：執行中的 claude job 只解析得出 session_id，
    // wait 每輪詢一次就把約 90 KB 的 stream-json 灌進呼叫端的 context。
    // 執行中：不帶（進度看 liveness，即時內容用 peek）；已結束：只帶結尾一段（錯誤原文通常在最後）。
    // verbose 照舊給完整內容。
    if (verbose) {
      response.stdout = context.stdout;
      response.stderr = context.stderr;
    } else if (context.status !== 'running') {
      Object.assign(response, _rawTail('stdout', context.stdout), _rawTail('stderr', context.stderr));
    }
    // 用量不構成回覆內容；保留原始錯誤輸出的同時，仍在固定位置回傳用量。
    if (!response.agentOutput && shapedAgentOutput?.usage) {
      response.agentOutput = { usage: shapedAgentOutput.usage };
    }
  }
  if (verbose && preserveRawFailureOutput && hasMeaningfulParsedOutput(shapedAgentOutput)) {
    response.agentOutput = shapedAgentOutput;
  }
  return response;
}
