/**
 * Agent 註冊表 — 框架的中央索引。
 *
 * 新增 agent：import 它，加進下方 AGENTS 陣列即可。
 * 註冊順序 = matchesModel 詢問順序。claude 是 fallback，必須放最後。
 */

import type { AgentDefinition, AgentId } from './types.js';
import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';
import { grokAgent } from './grok.js';
import { antigravityAgent } from './antigravity.js';
import { directApiAgent } from './direct-api.js';

/**
 * 註冊順序很重要：
 * - direct-api 的 provider prefix 由 command-builder 先解析。
 * - 其餘依序比對；claude 的 matchesModel 永遠回 true，必須最後。
 */
const AGENTS: readonly AgentDefinition[] = [
  directApiAgent,
  codexAgent,
  grokAgent,
  antigravityAgent,
  claudeAgent, // fallback，務必最後
];

const AGENTS_BY_ID = new Map<AgentId, AgentDefinition>(
  AGENTS.map((a) => [a.id, a])
);

/** 取得所有 agent（依註冊順序）。 */
export function listAgents(): readonly AgentDefinition[] {
  return AGENTS;
}

/** 依 id 取得 agent，找不到則丟錯。 */
export function getAgent(id: AgentId): AgentDefinition {
  const agent = AGENTS_BY_ID.get(id);
  if (!agent) {
    throw new Error(`Unknown agent id: ${id}`);
  }
  return agent;
}

/**
 * 依（已解析 alias 後的）model 找出負責的 agent。
 */
export function selectAgentForModel(resolvedModel: string): AgentDefinition {
  for (const agent of AGENTS) {
    if (agent.matchesModel(resolvedModel)) {
      return agent;
    }
  }
  // 理論上不會到這裡，因為 claude 是 fallback
  return claudeAgent;
}
