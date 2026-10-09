/**
 * CLI 二進位解析。1:1 還原自 dist/cli-utils.js 的解析邏輯，
 * 但改為吃 agent 的 BinaryConfig（envVarName / defaultCliName / localInstallPath）。
 *
 * 解析優先序：
 *   1. 環境變數覆寫（絕對路徑 or 簡單名稱；不允許相對路徑）
 *   2. localInstallPath（若存在且可執行）
 *   3. 在 PATH 上搜尋
 */

import { accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { AgentId, BinaryConfig } from '../agents/types.js';
import { debugLog } from './debug.js';

export interface CliBinaryStatus {
  configuredCommand: string;
  resolvedPath: string | null;
  available: boolean;
  lookup: 'env' | 'local' | 'path';
  error?: string;
}

function getPathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function getPathExtensions(): string[] {
  if (process.platform !== 'win32') {
    return [''];
  }
  // 真正的執行檔副檔名排在 '' 之前：npm 全域安裝會同時放 extensionless 的
  // bash shim 與 <name>.cmd。cmd.exe 無法執行 extensionless bash 腳本（exit 1
  // 空輸出），所以必須優先解析到 <name>.cmd / <name>.exe。
  const rawPathext = process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  return [...rawPathext.split(';').filter(Boolean), ''];
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(commandName: string): string | null {
  const rawPath = process.env.PATH || '';
  if (!rawPath) {
    return null;
  }
  const pathEntries = rawPath.split(getPathDelimiter()).filter(Boolean);
  const extensions = getPathExtensions();
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, `${commandName}${extension}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function validateCustomCliName(envVarName: string, customCliName: string): string | null {
  if (isAbsolute(customCliName)) {
    return null;
  }
  if (
    customCliName.startsWith('./') ||
    customCliName.startsWith('../') ||
    customCliName.includes('/')
  ) {
    const fallback = customCliName.split('/').pop() || 'cli';
    return `Invalid ${envVarName}: Relative paths are not allowed. Use either a simple name (e.g., '${fallback}') or an absolute path (e.g., '/tmp/${fallback}-test')`;
  }
  return null;
}

export function inspectCliBinary(config: BinaryConfig): CliBinaryStatus {
  const customCliName = process.env[config.envVarName];
  const configuredCommand = customCliName || config.defaultCliName;

  if (customCliName) {
    const validationError = validateCustomCliName(config.envVarName, customCliName);
    if (validationError) {
      return { configuredCommand, resolvedPath: null, available: false, lookup: 'env', error: validationError };
    }
    if (isAbsolute(customCliName)) {
      return {
        configuredCommand,
        resolvedPath: customCliName,
        available: isExecutableFile(customCliName),
        lookup: 'env',
      };
    }
    const resolvedPath = findExecutableOnPath(configuredCommand);
    return { configuredCommand, resolvedPath, available: resolvedPath !== null, lookup: 'env' };
  }

  if (config.preferPath) {
    const resolvedPath = findExecutableOnPath(configuredCommand);
    if (resolvedPath) return { configuredCommand, resolvedPath, available: true, lookup: 'path' };
  }
  if (config.localInstallPath && isExecutableFile(config.localInstallPath)) {
    return { configuredCommand, resolvedPath: config.localInstallPath, available: true, lookup: 'local' };
  }

  const resolvedPath = findExecutableOnPath(configuredCommand);
  return { configuredCommand, resolvedPath, available: resolvedPath !== null, lookup: 'path' };
}

export function getCliCommandOrThrow(status: CliBinaryStatus): string {
  if (status.error) {
    throw new Error(status.error);
  }
  if (status.lookup === 'env' && !isAbsolute(status.configuredCommand)) {
    return status.configuredCommand;
  }
  return status.resolvedPath || status.configuredCommand;
}

/** 解析單一 agent 的 CLI 路徑（找不到不丟錯，回 command 名稱）。 */
export function resolveAgentCli(config: BinaryConfig): string {
  debugLog(`[Debug] Resolving CLI for ${config.defaultCliName}...`);
  return getCliCommandOrThrow(inspectCliBinary(config));
}

/**
 * doctor 用：所有 agent 的二進位狀態。
 *
 * ★ `null` 與 `false` 在這裡是**不同的意思**，不可互換：
 *     false = 檢查過了，結果是否定的
 *     null  = **這一項根本沒有被檢查**
 *
 *   舊版這四個欄位全是寫死的常數：`binaryAvailability: true` 即使一個
 *   二進位檔都沒找到也照樣回 true；`loginState: false` 讀起來像
 *   「沒登入」，但這個指令根本不驗登入（DOCTOR_HELP_TEXT 自己寫著）。
 *   **一個看起來像答案的非答案，比不回答更糟**——讀的人不會去查證它。
 *   （2026-07-31：正是這類「沒標明自己不是事實」的欄位造成過誤導。）
 */
export interface CliDoctorStatus {
  checks: {
    /** 由各 agent 的實際結果推導，不是常數。 */
    binaryAvailability: boolean;
    pathResolution: boolean;
    /** null = 未檢查。這個指令不驗登入。 */
    loginState: null;
    /** null = 未檢查。 */
    termsAcceptance: null;
  };
  [agentId: string]: CliBinaryStatus | CliDoctorStatus['checks'];
}

export function buildDoctorStatus(
  configs: Array<{ id: AgentId; config: BinaryConfig }>
): CliDoctorStatus {
  const results = configs.map(({ id, config }) => ({ id, status: inspectCliBinary(config) }));
  const status: CliDoctorStatus = {
    checks: {
      // 真的去看結果：全部找得到才是 true——不是預設 true。
      binaryAvailability: results.every((r) => r.status.available),
      pathResolution: results.every((r) => r.status.resolvedPath !== null),
      loginState: null,
      termsAcceptance: null,
    },
  };
  for (const { id, status: agentStatus } of results) {
    status[id] = agentStatus;
  }
  return status;
}
