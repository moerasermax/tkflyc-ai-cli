/**
 * 真實環境的依賴：版本指紋、額度讀取、模型對應。loop 本身不碰這些，測試才能換成假的。
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveAllCliPaths } from '../core/doctor.js';
import { resolveAgentIdForModel, resolveModelAlias } from '../models/catalog.js';
import { UsageService } from '../plugins/usage-service.js';
import { digestText } from './journal.js';
import { FABLE_QUOTA_KEY } from './model-select.js';

const WATCHED = [
  '../core/job-store.js', '../core/job-runner.js', '../core/process-tree.js', '../core/file-process-service.js', '../core/command-builder.js',
  './loop.js', './runner.js', './runner-settle.js', './full-permission.js', './executor.js', './journal.js', './replay.js', './verdict.js', './plan.js', './probe.js', './workspace.js', './admission.js', './process-mutex.js', './test-lock.js', './check-supervisor.js', './runtime.js', './model-select.js',
];

/** dist 被原地重建時這個值會變。查不到的檔案也算進指紋，不會誤判成沒變。 */
export function kernelVersionId(): string {
  const parts: string[] = [];
  try { parts.push((JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version?: string }).version ?? '?'); }
  catch { parts.push('?'); }
  for (const relative of WATCHED) {
    try { const stat = statSync(fileURLToPath(new URL(relative, import.meta.url))); parts.push(`${relative}:${stat.size}:${stat.mtimeMs}`); }
    catch { parts.push(`${relative}:missing`); }
  }
  return digestText(parts.join('|')).slice(0, 16);
}

export function agentForModel(model: string): string { return resolveAgentIdForModel(resolveModelAlias(model)); }

/**
 * 從 query_usage 的結果取週額度剩餘百分比。優先讀 raw 原文，因為百分比欄位的語意歷史上變過。
 * 取不到一律回 null，不猜。
 */
export function remainingPercentFromUsage(agent: string, provider: { status?: unknown; usage?: unknown } | null | undefined): number | null {
  if (!provider || provider.status !== 'ok' || !provider.usage || typeof provider.usage !== 'object') return null;
  const usage = provider.usage as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
  if (agent === 'codex') {
    // Old text sometimes carried both used and left; require consistency and explicit basis.
    const line = typeof usage.raw === 'string' ? usage.raw.match(/^\s*Weekly limit:\s*([^\n]+)/im)?.[1] : undefined;
    if (line) {
      const used = line.match(/(-?[\d.]+)%\s*used/i), left = line.match(/(-?[\d.]+)%\s*(?:left|remaining)/i);
      const u = used ? Number(used[1]) : null, l = left ? Number(left[1]) : null;
      if (u !== null && !valid(u) || l !== null && !valid(l) || u !== null && l !== null && Math.abs(u + l - 100) > 0.11) return null;
      if (l !== null) return l;
      if (u !== null) return 100 - u;
    }
    // UsageService's parsed TUI/session-file/RPC windows declare their basis.
    const weekly = usage.weekly as { basis?: unknown; percentUsed?: unknown; percentRemaining?: unknown } | undefined;
    if (!weekly) return null;
    if (weekly.basis === 'used' && valid(weekly.percentUsed)) return 100 - weekly.percentUsed;
    if ((weekly.basis === 'left' || weekly.basis === 'remaining') && valid(weekly.percentRemaining)) return weekly.percentRemaining;
    return null;
  }
  if (agent === 'claude') return usage.percentBasis === 'used' && valid(usage.weekAllModelsPercent) ? 100 - usage.weekAllModelsPercent : null;
  if (agent === FABLE_QUOTA_KEY) {
    // Fable 另有自己的週額度（用量畫面的 Current week (Fable)），解析在 additionalLimits。畫面沒有這一列就是量不到。
    if (usage.percentBasis !== 'used' || !Array.isArray(usage.additionalLimits)) return null;
    const rows = (usage.additionalLimits as Array<{ label?: unknown; basis?: unknown; percentUsed?: unknown }>).filter(row => row && typeof row.label === 'string' && /^fable$/i.test(row.label.trim()));
    if (rows.length !== 1 || rows[0].basis !== 'used' || !valid(rows[0].percentUsed)) return null;
    return 100 - rows[0].percentUsed;
  }
  return null;
}

let usageService: UsageService | null = null;

/** agent 可以是 codex、claude，或 FABLE_QUOTA_KEY（Fable 自己的週額度，和 claude 同一次查詢）。其他家沒有額度資料，回 null。 */
export async function readQuota(agent: string): Promise<number | null> {
  if (agent !== 'codex' && agent !== 'claude' && agent !== FABLE_QUOTA_KEY) return null;
  usageService ??= new UsageService(resolveAllCliPaths());
  // 量不到就是 unknown，由閘的保守上限處理；不能讓額度查詢卡住整個 run。
  const limit = Number(process.env.AI_CLI_KERNEL_QUOTA_TIMEOUT_MS) || 90000;
  const timeout = new Promise<null>(resolve => { setTimeout(() => resolve(null), limit).unref(); });
  const provider = await Promise.race([usageService.queryProvider(agent === FABLE_QUOTA_KEY ? 'claude' : agent), timeout]);
  return remainingPercentFromUsage(agent, provider);
}
