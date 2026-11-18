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
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { windowlessHostMode, windowlessHostPath, type WindowlessHostMode } from './win-job-host.js';

/**
 * Windows 的 windowless 輔助程式狀態（#25）。
 *
 * 第三方防毒會刪掉現場編出來的輔助程式，`run` 就全數在啟動前失敗；以前 doctor 全綠、
 * 看不出原因。這裡回報它的完整路徑（使用者要放行的就是這個檔）與是否存在，
 * 主動呼叫 doctor 時再列出 Windows 資訊安全中心登記的防毒產品。
 *
 * - `exists: false` 不一定是壞：第一次 `run` 才會編。跑過之後又不見，才是防毒的跡象。
 * - 沒有 `antivirus` 欄位＝這次沒查（啟動檢查不查）；`antivirus: null`＝查了但查不到
 *   （伺服器版 Windows 沒有 SecurityCenter2、逾時、被擋），不是「沒有防毒」。
 */
export interface WindowlessHelperStatus {
  /** 這個行程目前用哪一種 host：compiled＝編譯的 exe；powershell＝exe 用不了時改用的系統 PowerShell（#25）。 */
  mode: WindowlessHostMode;
  path: string;
  exists: boolean;
  antivirus?: string[] | null;
  note: string;
}

// 明確設 UTF-8：Windows PowerShell 的主控台編碼可能是 big5 等，Node 以 UTF-8 解碼會變亂碼（稽核 gpt-6.2-sol 實測）。
const ANTIVIRUS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName }"];
const parseProducts = (stdout: string): string[] => stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** CLI doctor 用：只卡住那一次 CLI 行程。 */
export function listAntivirusProducts(): string[] | null {
  const result = spawnSync('powershell.exe', ANTIVIRUS_ARGS, { encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return parseProducts(result.stdout);
}

/** MCP doctor 用：非同步，查詢卡住時不會擋住同一個 server 的其他請求（稽核 gpt-6.2-sol）。 */
export function listAntivirusProductsAsync(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ANTIVIRUS_ARGS, { encoding: 'utf8', timeout: 8000, windowsHide: true }, (error, stdout) => {
      resolve(error || typeof stdout !== 'string' ? null : parseProducts(stdout));
    });
  });
}

export function getWindowlessHelperStatus(probeAntivirus = false): WindowlessHelperStatus | undefined {
  // probeAntivirus 只給 CLI（同步）；MCP 走 listAntivirusProductsAsync 自己補。
  if (process.platform !== 'win32') return undefined;
  const { target } = windowlessHostPath();
  const exists = existsSync(target);
  const mode = windowlessHostMode();
  return {
    mode,
    path: target,
    exists,
    ...(probeAntivirus ? { antivirus: listAntivirusProducts() } : {}),
    note: mode === 'powershell'
      ? 'using the built-in PowerShell host (forced by AI_CLI_WINDOWLESS_HOST=powershell, or the compiled helper was unusable in this process); no compiled helper is needed'
      : exists
        ? 'present'
        : 'not present: it is built on the next run. If antivirus removes it, ai-cli switches to the built-in PowerShell host automatically (slower, no exception needed).',
  };
}

/**
 * doctor：所有 agent 的二進位可用性，外加這個 server 自己的身分。
 *
 * `server` 那欄不是裝飾：呼叫端只從 MCP 註冊看得到一行 `node .../dist/server.js`，
 * 認不出這是哪個 repo／npm 套件。見 identity.ts 檔頭。
 */
export function getCliDoctorStatus(options: { probeAntivirus?: boolean } = {}): { [key: string]: CliDoctorStatus[string] | UpdateResult | ServerIdentity | WindowlessHelperStatus | undefined; checks: CliDoctorStatus['checks']; update: UpdateResult; server: ServerIdentity; windowlessHelper?: WindowlessHelperStatus } {
  const windowlessHelper = getWindowlessHelperStatus(options.probeAntivirus === true);
  return { ...buildDoctorStatus(
    listAgents()
      .filter((a) => a.binary)
      .map((a) => ({ id: a.id, config: a.binary! }))
  ), update: getUpdateStatus(), server: getServerIdentity(), ...(windowlessHelper ? { windowlessHelper } : {}) };
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
