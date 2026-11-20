/**
 * 決定一個 agent 這次要用哪種 spawn 模式。
 *
 * 靜態的 `spawnMode`／`win32SpawnMode` 表達不了「依 CLI 版本而定」（agy 1.5.13 起
 * 非 TTY 也會輸出，可改走管線；更舊或量不到版本的維持 ConPTY）。這個判斷屬於
 * agent，所以放在 agent 定義的 `resolveWin32SpawnMode`；core 只呼叫這裡、
 * 把結果寫進 `cmd.spawnMode`，之後 JobStore 讀同一個值，不再各自重算。
 */

import type { AgentDefinition, SpawnMode } from './types.js';

export async function resolveSpawnMode(
  agent: AgentDefinition,
  cliPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<SpawnMode> {
  if (platform === 'win32') {
    if (agent.resolveWin32SpawnMode) {
      try {
        return await agent.resolveWin32SpawnMode(cliPath);
      } catch {
        // 解析器不該拋例外；萬一拋了，退回靜態設定（agy 是 ConPTY），不讓 run 失敗。
      }
    }
    if (agent.win32SpawnMode) return agent.win32SpawnMode;
  }
  return agent.spawnMode || 'pipe';
}
