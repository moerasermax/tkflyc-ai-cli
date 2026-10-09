/**
 * 模型目錄 v2 — **每一筆都說得出自己的出處與時間**。
 *
 * ── 為什麼要有這一層 ──────────────────────────────────────────
 * 2026-07-31 發生過一次具體的誤導：有人照 `agents/antigravity.ts` 的
 * 註解斷定「agy 不支援 --model」，並把它當成事實轉述給使用者。
 * 實測 agy v1.1.9 早就支援了，而且模型清單從 4 個變成 11 個。
 *
 * 根因**不是註解沒更新**——那只是症狀。根因是：
 * **硬編的清單沒有標明自己是硬編的**，讀的人（人或 AI）就沒有理由懷疑它。
 *
 * 所以這一層不試圖「保證清單永遠正確」（做不到，vendor 隨時會改），
 * 而是保證**清單永遠說得出自己是怎麼來的**：
 *
 *   source: 'vendor-cli'        這一輪真的問過 CLI，verifiedAt 是問到的時間
 *   source: 'vendor-cli-cached'  先前行程問到並存下的值，保留原 verifiedAt
 *   source: 'builtin-fallback'  原始碼裡的靜態值，**未經確認**
 *
 * 消費端可以自己決定要不要信 fallback，但**不會再誤以為那是事實**。
 *
 * ── 為什麼是新檔而不是改 catalog.ts ──────────────────────────
 * `models --json` 既有的頂層形狀（各 agent 一個字串陣列 + aliases）
 * 有現成的消費者。直接改會破壞它們。v2 以**新欄位**加上去，舊欄位不動。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { listAgents } from '../agents/registry.js';
import type { AgentDefinition, AgentId, BillingRoute, ModelListSource } from '../agents/types.js';
import { inspectCliBinary } from '../core/binary-resolver.js';
import { CONFIG_DIR } from '../core/user-config.js';

export interface CatalogEntry {
  /** 穩定識別：`{agent}/{model}`。消費端該存這個，不是顯示名。 */
  id: string;
  agent: AgentId;
  model: string;
  /** `{Vendor}_{Model}` —— 給人看的，不要拿來當鍵。 */
  displayName: string;
  billingRoute: BillingRoute;
  source: ModelListSource;
  /** ISO8601。`builtin-fallback` 也給，代表「這一輪讀到這份靜態值的時間」。 */
  verifiedAt: string;
  /**
   * 這個名字送進 `run` 會不會被路由回**同一個 agent**。
   *
   * 為什麼需要這個欄位：vendor 回報的清單可能包含本框架送不到它那裡的名字。
   * agy 就代理了 `claude-sonnet-4-6` / `gpt-oss-120b-medium`——那些名字同時屬於
   * claude/codex agent，`selectAgentForModel` 會把它們送去別家。
   *
   * 遇到這種名字有兩種做法：**默默扣掉**，或**列出來並標明**。
   * 扣掉會讓「問過 CLI」的清單與 CLI 實際說的不一致，而且不一致這件事看不見
   * ——那正是這一層要防的病。所以選後者。
   */
  routable: boolean;
}

export interface CatalogV2 {
  entries: CatalogEntry[];
  /**
   * 各 agent 這一輪的查詢結果。
   * `binaryFound: false` 時 source 必然是 builtin-fallback——
   * 這兩件事要一起看，否則「沒問到」會被誤讀成「問到了但只有這些」。
   */
  agents: Array<{
    agent: AgentId;
    binaryFound: boolean;
    source: ModelListSource;
    /** 該列來源的時間；磁碟快取保留原值，fallback 是讀到靜態值的時間。 */
    verifiedAt: string;
    /** 快取／失敗原因。沒有查詢能力就是 null。 */
    discoveryNote: string | null;
  }>;
  generatedAt: string;
}

/** 顯示名的 vendor 段。**只影響顯示**，不參與任何比對。 */
const VENDOR_LABEL: Record<AgentId, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  grok: 'xAI',
  antigravity: 'Antigravity',
  'direct-api': 'DirectAPI',
};

/** 成功值在行程內保留；只有明確 refresh 才依 10 分鐘新鮮度重查。 */
export const FRESH_TTL_MS = 10 * 60_000;
const DISK_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
interface CacheRow {
  models: readonly string[];
  verifiedAt: string;
  cliPath: string;
}
interface AgentRow extends CacheRow {
  source: ModelListSource;
  binaryFound: boolean;
  discoveryNote: string | null;
}
const cache = new Map<AgentId, CacheRow>();
const failures = new Map<AgentId, { cliPath: string; note: string }>();
let inFlight: Promise<CatalogV2> | null = null;
let generation = 0;

const cachePath = (): string => process.env.AI_CLI_CATALOG_CACHE_PATH || join(CONFIG_DIR, 'catalog-cache.json');

/** 壞 JSON、錯形狀、讀取錯誤都當成沒有快取，不能卡住模型描述。 */
function readDiskCache(path: string): Partial<Record<AgentId, CacheRow>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const rows: Partial<Record<AgentId, CacheRow>> = {};
    for (const { id } of listAgents()) {
      const row = (parsed as Record<string, CacheRow>)[id];
      if (row && Array.isArray(row.models) && row.models.length > 0
        && row.models.every((model) => typeof model === 'string' && model.trim().length > 0)
        && typeof row.cliPath === 'string' && typeof row.verifiedAt === 'string'
        && Number.isFinite(Date.parse(row.verifiedAt))) {
        rows[id] = { models: row.models, verifiedAt: row.verifiedAt, cliPath: row.cliPath };
      }
    }
    return rows;
  } catch {
    return {};
  }
}

/** 同目錄 tmp + rename，寫入失敗不影響已查到的記憶體值。 */
function writeDiskCache(path: string, agent: AgentId, row: CacheRow): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const rows = readDiskCache(path);
    rows[agent] = row;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // 持久化是盡力而為，不把已成功的網路查詢降級。
  } finally {
    try { unlinkSync(tmp); } catch { /* rename 後 tmp 本來就不存在。 */ }
  }
}

/** 測試用：預設只清記憶體；disk: true 一併刪除指定的磁碟快取。 */
export function clearCatalogCache(options: { disk?: boolean } = {}): void {
  generation++;
  cache.clear();
  failures.clear();
  // 不取消單飛中的程序，但舊世代的結果不得在 clear 之後重新寫回。
  if (options.disk) {
    try { unlinkSync(cachePath()); } catch { /* 沒有／讀不到都視為無快取。 */ }
  }
}

function resolveFor(agent: AgentDefinition): { path: string | null; found: boolean } {
  // direct-api 沒有本機二進位檔——那不是「找不到」，是本來就沒有。
  if (!agent.binary) return { path: null, found: false };
  try {
    const status = inspectCliBinary(agent.binary);
    return { path: status.resolvedPath, found: status.available && status.resolvedPath !== null };
  } catch {
    return { path: null, found: false };
  }
}

function loadAgent(agent: AgentDefinition, nowMs: number, disk: Partial<Record<AgentId, CacheRow>>): AgentRow {
  const fallback = (discoveryNote: string | null, binaryFound: boolean): AgentRow => ({
    models: agent.models,
    source: 'builtin-fallback',
    verifiedAt: new Date(nowMs).toISOString(),
    binaryFound,
    discoveryNote,
    cliPath: '',
  });

  if (typeof agent.discoverModels !== 'function') {
    // 沒有查詢能力不是失敗，但也不能假裝問過。
    return fallback(null, resolveFor(agent).found);
  }

  const { path, found } = resolveFor(agent);
  if (!found || path === null) {
    return fallback('找不到這個 agent 的 CLI 二進位檔，無法向它查詢模型清單。', false);
  }

  const failure = failures.get(agent.id);
  const note = failure?.cliPath === path ? `最近一次查詢失敗：${failure.note}` : null;
  const memory = cache.get(agent.id);
  if (memory?.cliPath === path) {
    return { ...memory, source: 'vendor-cli', binaryFound: true, discoveryNote: note };
  }

  // refresh 會先讓出同步堆疊再查詢；此處永不 spawn、永不等網路。
  void refreshCatalogV2().catch(() => {});
  const saved = disk[agent.id];
  const ageMs = saved ? nowMs - Date.parse(saved.verifiedAt) : Infinity;
  if (saved?.cliPath === path && ageMs >= 0 && ageMs <= DISK_MAX_AGE_MS) {
    return {
      ...saved,
      source: 'vendor-cli-cached',
      binaryFound: true,
      discoveryNote: `快取值：${Math.floor(ageMs / 1000)} 秒前問過 CLI；背景重新查詢中${note ? `；${note}` : ''}`,
    };
  }
  const reason = note ?? (saved?.cliPath && saved.cliPath !== path
    ? '快取 CLI 路徑與目前不同'
    : saved ? '快取時間無效或已超過 30 天' : '尚未查過');
  return fallback(`${reason}；背景查詢中`, true);
}

/**
 * 唯一會呼叫 discoverModels 的路徑；整個行程單飛，成功值才寫入快取。
 * Promise.then 刻意延後工作，buildCatalogV2 的同步堆疊連 spawn 都不會執行。
 */
export function refreshCatalogV2(options: { force?: boolean } = {}): Promise<CatalogV2> {
  if (inFlight) return inFlight;
  const startedGeneration = generation;
  const pathOnStart = cachePath();
  inFlight = Promise.resolve().then(async () => {
    for (const agent of listAgents()) {
      if (!agent.discoverModels) continue;
      const { path, found } = resolveFor(agent);
      if (!found || path === null) continue;
      const memory = cache.get(agent.id);
      const ageMs = memory ? Date.now() - Date.parse(memory.verifiedAt) : Infinity;
      if (!options.force && memory?.cliPath === path && ageMs >= 0 && ageMs < FRESH_TTL_MS) continue;
      try {
        const result = await agent.discoverModels(path);
        const detailed = result && 'models' in result ? result : null;
        const models = detailed ? detailed.models : result as readonly string[] | null;
        if (startedGeneration !== generation) continue;
        if (models && models.length > 0) {
          const row: CacheRow = { models: [...models], verifiedAt: new Date(Date.now()).toISOString(), cliPath: path };
          cache.set(agent.id, row);
          failures.delete(agent.id);
          writeDiskCache(pathOnStart, agent.id, row);
        } else {
          failures.set(agent.id, { cliPath: path, note: detailed?.note || '查詢模型清單失敗（回 null 或沒有模型 id）' });
        }
      } catch (error) {
        // 契約雖要求永不 reject，第三方 agent 違約也不能毀掉既有成功值。
        if (startedGeneration === generation) {
          failures.set(agent.id, { cliPath: path, note: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    // 建立回傳值時仍持有 inFlight，失敗不會遞迴排出永不停歇的重試。
    return buildCatalogV2();
  }).finally(() => { inFlight = null; });
  return inFlight;
}

export function buildCatalogV2(): CatalogV2 {
  const nowMs = Date.now();
  const entries: CatalogEntry[] = [];
  const agents: CatalogV2['agents'] = [];
  const disk = readDiskCache(cachePath());

  for (const agent of listAgents()) {
    const row = loadAgent(agent, nowMs, disk);
    agents.push({
      agent: agent.id,
      binaryFound: row.binaryFound,
      source: row.source,
      verifiedAt: row.verifiedAt,
      discoveryNote: row.discoveryNote,
    });
    for (const model of row.models) {
      entries.push({
        id: `${agent.id}/${model}`,
        agent: agent.id,
        model,
        displayName: `${VENDOR_LABEL[agent.id]}_${model}`,
        billingRoute: agent.billingRoute ?? 'subscription-cli',
        source: row.source,
        verifiedAt: row.verifiedAt,
        // 用 agent 自己的路由判斷，不寫死任何 vendor 的規則。
        routable: agent.matchesModel(model),
      });
    }
  }

  return { entries, agents, generatedAt: new Date(nowMs).toISOString() };
}
