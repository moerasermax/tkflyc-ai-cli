/**
 * doctor 與 CLI 路徑解析。從 registry 自動涵蓋所有 agent。
 * 對應 dist/cli-utils.js 的 getCliDoctorStatus + 各 findXxxCli。
 */

import type { AgentId } from '../agents/types.js';
import { listAgents, getAgent } from '../agents/registry.js';
import {
  buildDoctorStatus,
  resolveAgentCli,
  type CliDoctorStatus,
} from './binary-resolver.js';
import type { CliPaths } from './process-service.js';
import { getUpdateStatus, type UpdateResult } from './updater.js';
import { getServerIdentity, type ServerIdentity } from './identity.js';

/**
 * doctor：所有 agent 的二進位可用性，外加這個 server 自己的身分。
 *
 * `server` 那欄不是裝飾：呼叫端只從 MCP 註冊看得到一行 `node .../dist/server.js`，
 * 認不出這是哪個 repo／npm 套件。見 identity.ts 檔頭。
 */
export function getCliDoctorStatus(): { [key: string]: CliDoctorStatus[string] | UpdateResult | ServerIdentity; checks: CliDoctorStatus['checks']; update: UpdateResult; server: ServerIdentity } {
  return { ...buildDoctorStatus(
    listAgents()
      .filter((a) => a.binary)
      .map((a) => ({ id: a.id, config: a.binary! }))
  ), update: getUpdateStatus(), server: getServerIdentity() };
}

/** 解析每個 agent 的 CLI 路徑，組成 ProcessService 需要的 CliPaths。 */
export function resolveAllCliPaths(): CliPaths {
  const path = (id: Exclude<AgentId, 'direct-api'>) => resolveAgentCli(getAgent(id).binary!);
  return {
    claude: path('claude'),
    codex: path('codex'),
    grok: path('grok'),
    antigravity: path('antigravity'),
  };
}
