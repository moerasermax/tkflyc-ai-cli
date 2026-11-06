/**
 * 真實環境的依賴：版本指紋、額度讀取、模型對應。loop 本身不碰這些，測試才能換成假的。
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveAllCliPaths } from '../core/doctor.js';
import { resolveAgentIdForModel, resolveModelAlias } from '../models/catalog.js';
import { UsageService } from '../plugins/usage-service.js';
import { digestText } from './journal.js';

const WATCHED = [
  '../core/job-store.js', '../core/job-runner.js', '../core/file-process-service.js', '../core/command-builder.js',
  './loop.js', './runner.js', './executor.js', './journal.js', './replay.js', './verdict.js', './plan.js', './probe.js', './workspace.js',
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
  if (!provider || provider.status !== 'ok') return null;
  const usage = provider.usage as { raw?: unknown; percentBasis?: unknown; weekAllModelsPercent?: unknown } | null;
  if (!usage) return null;
  if (agent === 'codex') {
    const match = typeof usage.raw === 'string' ? usage.raw.match(/Weekly limit:\s*[\d.]+%\s*used\s*\(([\d.]+)%\s*left\)/i) : null;
    return match ? Number(match[1]) : null;
  }
  if (agent === 'claude') {
    return usage.percentBasis === 'used' && typeof usage.weekAllModelsPercent === 'number' ? 100 - usage.weekAllModelsPercent : null;
  }
  return null;
}

let usageService: UsageService | null = null;

export async function readQuota(agent: string): Promise<number | null> {
  if (agent !== 'codex' && agent !== 'claude') return null;
  usageService ??= new UsageService(resolveAllCliPaths());
  // 量不到就是 unknown，由閘的保守上限處理；不能讓額度查詢卡住整個 run。
  const limit = Number(process.env.AI_CLI_KERNEL_QUOTA_TIMEOUT_MS) || 90000;
  const timeout = new Promise<null>(resolve => { setTimeout(() => resolve(null), limit).unref(); });
  const provider = await Promise.race([usageService.queryProvider(agent), timeout]);
  return remainingPercentFromUsage(agent, provider);
}
