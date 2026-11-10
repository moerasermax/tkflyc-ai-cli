/**
 * 自動選模型：依「額度」與「任務難度」決定 decide、worker 與允許清單。
 *
 * 這裡全部是純函式。額度由呼叫端先讀好、做成快照傳進來；這支檔案不查額度、不碰檔案、
 * 不 import catalog。原因是同一份邏輯要在三個地方用：建立委任書（凍結候選池）、
 * 派工前（池內改派）、decide 的提示與驗證，測試也才能直接餵快照。
 *
 * 幾條不變的規則：
 * - 量不到（null）就是不合格，不是「還夠」。
 * - 候選池在建立委任書時凍結，之後只能在池內選，不會把池外的模型加回來。
 * - 自動路徑的 effort 最高到 high，不會發出 xhigh／max／ultra。
 * - 明示的模型與 effort 不經過這裡的額度判斷：使用者指名就照指名。
 */
import type { DispatchReroute, KernelContract, KernelDifficulty, ModelChoice, ModelSelection, PoolEntry, QuotaSnapshot, StepMode } from './types.js';

/** 委任書可以把 model／decideModel 寫成這個字面值，意思和省略一樣。 */
export const AUTO_MODEL = 'auto';
export const DIFFICULTIES: readonly KernelDifficulty[] = ['routine', 'elevated', 'critical'];
/** 合格門檻：那一家的週額度至少要剩這麼多。和派工閘的預設門檻同一個數字。 */
export const AUTO_MIN_REMAINING_PERCENT = 25;
export const EFFORT_ORDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** 每一級難度的 effort 上限。自動路徑不會超過這張表。 */
export const EFFORT_CEILINGS: Record<KernelDifficulty, string> = { routine: 'medium', elevated: 'high', critical: 'high' };
/** readQuota 認得的額外鍵：Fable 自己的週額度（Claude 用量畫面的 Current week (Fable)）。 */
export const FABLE_QUOTA_KEY = 'claude:fable';

interface Candidate { model: string; effort: string; family: 'claude' | 'codex' | 'grok'; needsFable?: true; fallback?: true; reason?: string }

/**
 * 候選表。順序就是優先序；只有「合格」的才進池。
 * routine 的最後一筆是備援：沒有額度資料，只有前面都不合格、而且整個 run 的難度上限就是 routine 時才進池。
 */
export const AUTO_CANDIDATES: Record<KernelDifficulty, readonly Candidate[]> = {
  routine: [
    { model: 'gpt-6.1-sol', effort: 'medium', family: 'codex' },
    { model: 'sonnet', effort: 'medium', family: 'claude' },
    { model: 'grok-4.7', effort: 'medium', family: 'grok', fallback: true, reason: '備援：其他候選都不合格；沒有額度資料，派工時受額度未知的次數上限控制' },
  ],
  elevated: [
    { model: 'opus', effort: 'medium', family: 'claude' },
    { model: 'gpt-6.1-sol', effort: 'high', family: 'codex', reason: '高風險／跨模組／架構／develop 寫入' },
  ],
  critical: [
    { model: 'fable', effort: 'high', family: 'claude', needsFable: true },
    { model: 'opus', effort: 'high', family: 'claude' },
    { model: 'gpt-6-astra', effort: 'high', family: 'codex', reason: '同樣工作約為 6.1-sol 的 2～5 倍週額度' },
  ],
};

/** 沒有任何合格候選可以自動選。呼叫端據此拒絕建立 run。 */
export class NoEligibleModelError extends Error {}

const rank = (level: KernelDifficulty): number => DIFFICULTIES.indexOf(level);
const validPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const effortRank = (effort: string): number => EFFORT_ORDER.indexOf(effort);

/** a 比 b 高才回 true。不認識的 effort 一律當成超過，讓呼叫端拒絕。 */
export function effortExceeds(effort: string, ceiling: string): boolean {
  const value = effortRank(effort);
  return value < 0 || value > effortRank(ceiling);
}

export function isAutoModel(value: string | undefined): boolean { return value === undefined || value === AUTO_MODEL; }

export function parseDifficulty(value: unknown): KernelDifficulty | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(DIFFICULTIES as readonly string[]).includes(value)) throw new Error(`difficulty 必須是 ${DIFFICULTIES.join('、')} 其中之一`);
  return value as KernelDifficulty;
}

/** 難度上限：呼叫端有填就用它；沒填時 develop 是 elevated（寫入），其他範本是 routine。 */
export function difficultyCeiling(template: string, difficulty: KernelDifficulty | undefined): { difficulty: KernelDifficulty; source: 'caller' | 'template' } {
  if (difficulty) return { difficulty, source: 'caller' };
  return { difficulty: template === 'develop' ? 'elevated' : 'routine', source: 'template' };
}

/**
 * 哪一邊要自動選、需不需要額度快照。
 * decide 沒指定、worker 是明示、難度上限又是 routine 時，decide 就是「和 worker 同一個」：
 * 不用看額度，結果和以前一樣，所以不算自動。
 */
export function autoPlan(input: { template: string; difficulty?: KernelDifficulty; workerModel?: string; decideModel?: string }): { workerAuto: boolean; decideAuto: boolean; needsQuotas: boolean } {
  const workerAuto = input.workerModel === undefined;
  const ceiling = difficultyCeiling(input.template, input.difficulty).difficulty;
  const decideAuto = input.decideModel === undefined && (workerAuto || ceiling !== 'routine');
  return { workerAuto, decideAuto, needsQuotas: workerAuto || decideAuto };
}

/** 把讀到的數字整理成快照：不是 0～100 的有限數字一律當量不到。Claude 與 Fable 來自同一次查詢，依序讀才吃得到快取。 */
export async function readQuotaSnapshot(quota: (agent: string) => Promise<number | null>, now: () => Date = () => new Date()): Promise<QuotaSnapshot> {
  const read = async (agent: string): Promise<number | null> => {
    const value = await quota(agent).catch(() => null);
    return validPercent(value) ? value : null;
  };
  const [codex, [claude, fable]] = await Promise.all([read('codex'), (async () => [await read('claude'), await read(FABLE_QUOTA_KEY)] as const)()]);
  return { claude, codex, fable, readAt: now().toISOString() };
}

const percentText = (value: number | null): string => value === null ? '量不到（unknown）' : `剩 ${value}%`;

export function describeQuotas(quotas: Pick<QuotaSnapshot, 'claude' | 'codex' | 'fable'>): string {
  return `Claude ${percentText(quotas.claude)}、Codex ${percentText(quotas.codex)}、Fable ${percentText(quotas.fable)}`;
}

type QuotaNeeds = Pick<PoolEntry, 'family'> & { needsFable?: true };

/**
 * 這個候選目前的週額度剩餘。量不到回 null。
 * 需要 Fable 額度的模型兩個都要量得到，取比較少的那個；沒有額度資料的家（備援）永遠是 null。
 */
export function remainingFor(entry: QuotaNeeds, quotas: Pick<QuotaSnapshot, 'claude' | 'codex' | 'fable'>): number | null {
  if (entry.family === 'codex') return validPercent(quotas.codex) ? quotas.codex : null;
  if (entry.family !== 'claude') return null;
  if (!validPercent(quotas.claude)) return null;
  if (!entry.needsFable) return quotas.claude;
  return validPercent(quotas.fable) ? Math.min(quotas.claude, quotas.fable) : null;
}

/** 不合格時回原因；合格回 null。 */
function disqualified(entry: QuotaNeeds, quotas: QuotaSnapshot, min: number): string | null {
  if (entry.family === 'codex') {
    if (!validPercent(quotas.codex)) return 'Codex 週額度量不到（unknown）';
    return quotas.codex >= min ? null : `Codex 週額度剩 ${quotas.codex}% < ${min}%`;
  }
  if (entry.family !== 'claude') return '這一家沒有額度資料';
  if (!validPercent(quotas.claude)) return 'Claude 週額度量不到（unknown）';
  if (quotas.claude < min) return `Claude 週額度剩 ${quotas.claude}% < ${min}%`;
  if (!entry.needsFable) return null;
  if (!validPercent(quotas.fable)) return 'Fable 自己的週額度量不到（unknown）';
  return quotas.fable >= min ? null : `Fable 自己的週額度剩 ${quotas.fable}% < ${min}%`;
}

export interface SelectInput {
  template: string;
  /** 已驗證過的難度；沒填用範本預設。 */
  difficulty?: KernelDifficulty;
  /** 明示的 worker 模型（已解析）。undefined＝自動。 */
  workerModel?: string;
  /** 明示的 worker effort。undefined＝依候選表。 */
  workerEffort?: string;
  decideModel?: string;
  decideEffort?: string;
  /** 呼叫端給的 workerModels（已解析）。自動時候選池先和它相交。 */
  workerModels?: string[];
  /** 委任書的派工閘門檻。比 25 高時，合格門檻跟著提高，免得選到一派就被閘擋下的模型。 */
  minQuotaRemainingPercent?: number;
}
export interface SelectResult { worker: ModelChoice; decide: ModelChoice; allowedWorkerModels: string[]; modelSelection: ModelSelection }

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * 建立委任書時呼叫：算出凍結的候選池與預設的 decide／worker。
 * usable 讓呼叫端排除不能派的名稱（例如 knownBadModels），回傳原因字串表示不能用。
 * 沒有合格候選（或和 workerModels 沒有交集）時丟 NoEligibleModelError。
 */
export function selectModels(input: SelectInput, quotas: QuotaSnapshot, options: { usable?(model: string): string | null } = {}): SelectResult {
  const plan = autoPlan(input);
  if (!plan.needsQuotas) throw new Error('兩邊模型都已明示，不需要自動選');
  const ceiling = difficultyCeiling(input.template, input.difficulty);
  const min = Math.max(AUTO_MIN_REMAINING_PERCENT, validPercent(input.minQuotaRemainingPercent) ? input.minQuotaRemainingPercent : 0);
  // develop 的唯讀步驟（審查、查資料）走 routine，所以池裡要同時有兩級。
  const levels: KernelDifficulty[] = input.template === 'develop' ? unique([ceiling.difficulty, 'routine']) : [ceiling.difficulty];
  const qualified: PoolEntry[] = [];
  const excluded: ModelSelection['excluded'] = [];
  for (const level of levels) {
    const before = qualified.length;
    for (const candidate of AUTO_CANDIDATES[level]) {
      const effort = input.workerEffort ?? candidate.effort;
      const drop = (reason: string) => excluded.push({ model: candidate.model, effort, level, reason });
      const unusable = options.usable?.(candidate.model) ?? null;
      if (unusable) { drop(unusable); continue; }
      if (candidate.fallback) {
        // 備援只在「整個 run 就是 routine」而且這一級其他候選都不合格時進池。
        if (ceiling.difficulty !== 'routine') { drop('備援只用在難度上限是 routine 的 run'); continue; }
        if (qualified.length > before) { drop('備援：還有其他合格候選，不進池'); continue; }
      } else {
        const reason = disqualified(candidate, quotas, min);
        if (reason) { drop(reason); continue; }
      }
      qualified.push({
        model: candidate.model, effort, family: candidate.family, level,
        ...(candidate.needsFable ? { needsFable: true as const } : {}), ...(candidate.fallback ? { fallback: true as const } : {}),
        ...(candidate.reason ? { reason: candidate.reason } : {}),
      });
    }
  }
  const quotaText = `${describeQuotas(quotas)}（門檻 ${min}%）`;

  let pool: PoolEntry[] = [];
  let worker: ModelChoice;
  let allowedWorkerModels: string[];
  if (plan.workerAuto) {
    pool = qualified;
    if (input.workerModels) {
      const wanted = new Set(input.workerModels);
      for (const entry of qualified) if (!wanted.has(entry.model)) excluded.push({ model: entry.model, effort: entry.effort, level: entry.level, reason: '不在呼叫端給的 workerModels 內' });
      pool = qualified.filter(entry => wanted.has(entry.model));
    }
    if (qualified.length === 0) {
      throw new NoEligibleModelError(`沒有合格的模型可以自動選，不建立 run。週額度：${quotaText}。量不到不算「還夠」。等額度恢復，或明確指定 model 與 decideModel（明示的模型不看額度）。`);
    }
    if (pool.length === 0) {
      throw new NoEligibleModelError(`workerModels（${input.workerModels!.join('、')}）和目前合格的候選（${unique(qualified.map(entry => entry.model)).join('、')}）沒有交集，不建立 run。週額度：${quotaText}。要用清單裡的模型請明確指定 model。`);
    }
    const first = entriesForLevel(pool, ceiling.difficulty, input.workerEffort !== undefined)[0];
    worker = { model: first.model, effort: first.effort };
    allowedWorkerModels = unique(pool.map(entry => entry.model));
  } else {
    worker = { model: input.workerModel!, effort: input.workerEffort ?? 'medium' };
    allowedWorkerModels = unique([input.workerModel!, ...(input.workerModels ?? [])]);
  }

  let decide: ModelChoice;
  if (!plan.decideAuto) {
    // 明示，或「routine＋明示 worker」的同一個：和以前的預設一樣。
    decide = { model: input.decideModel ?? worker.model, effort: input.decideEffort ?? input.workerEffort ?? 'medium' };
  } else if (ceiling.difficulty === 'routine') {
    decide = { model: worker.model, effort: input.decideEffort ?? worker.effort };
  } else {
    // elevated／critical：池內第一個 Claude 家的模型；沒有就和 worker 同一個。決策不寫檔，effort 用 medium。
    const claude = (plan.workerAuto ? pool : qualified).find(entry => entry.family === 'claude');
    decide = { model: claude?.model ?? worker.model, effort: input.decideEffort ?? 'medium' };
  }

  return {
    worker, decide, allowedWorkerModels,
    modelSelection: {
      mode: 'auto', auto: { worker: plan.workerAuto, decide: plan.decideAuto },
      ...(plan.workerAuto && input.workerEffort !== undefined ? { workerEffortExplicit: true as const } : {}),
      difficulty: ceiling.difficulty, difficultySource: ceiling.source,
      quotas: { claude: quotas.claude, codex: quotas.codex, fable: quotas.fable, readAt: quotas.readAt },
      minRemainingPercent: min, pool,
      selected: { decide, worker, allowedWorkerModels },
      excluded, effortCeilings: { ...EFFORT_CEILINGS },
    },
  };
}

/** 自動選模型的委任書才回傳紀錄；舊委任書和明示的都是 null。 */
export function autoSelection(contract: Pick<KernelContract, 'modelSelection'>): ModelSelection | null {
  return contract.modelSelection?.mode === 'auto' ? contract.modelSelection : null;
}

/** 這一步的難度：develop 的唯讀步驟是 routine，其餘用委任書的難度上限。decide 沒有欄位可以調高它。 */
export function stepLevel(contract: Pick<KernelContract, 'modelSelection' | 'develop'>, mode: StepMode | undefined): KernelDifficulty {
  const selection = autoSelection(contract);
  if (!selection) return 'routine';
  return contract.develop && mode !== 'write' ? 'routine' : selection.difficulty;
}

/**
 * 某一級難度可用的池內候選，依優先序排好、每個模型一筆。
 * 先放不高於這一級的（同級在前），再放只在更高級出現的模型，effort 壓到這一級的上限。
 * keepEffort＝呼叫端明示了 effort，不壓。
 */
export function entriesForLevel(pool: readonly PoolEntry[], level: KernelDifficulty, keepEffort = false): PoolEntry[] {
  const seen = new Set<string>();
  const result: PoolEntry[] = [];
  const add = (entry: PoolEntry) => { if (!seen.has(entry.model)) { seen.add(entry.model); result.push(entry); } };
  for (let current = rank(level); current >= 0; current--) for (const entry of pool) if (rank(entry.level) === current) add(entry);
  const ceiling = EFFORT_CEILINGS[level];
  for (const entry of pool) add(keepEffort || !effortExceeds(entry.effort, ceiling) ? entry : { ...entry, effort: ceiling });
  return result;
}

export interface DispatchRequest {
  kind: 'decide' | 'worker';
  /** worker 步驟的 mode。 */
  mode?: StepMode;
  /** decide 在步驟上指定的模型（已驗證在允許清單內）。 */
  model?: string;
  /** decide 在步驟上指定的 effort（已驗證不超過上限）。 */
  effort?: string;
}
export interface DispatchChoice {
  model: string;
  effort?: string;
  /** 這一邊是不是自動選的。false＝明示，呼叫端照舊用原本的額度閘。 */
  auto: boolean;
  /** 自動時：選定模型目前的剩餘（null＝量不到）。派工閘拿它判斷，不再另外查。 */
  remaining?: number | null;
  reroute?: DispatchReroute;
}

function plannedEntries(contract: KernelContract, selection: ModelSelection, request: DispatchRequest): PoolEntry[] {
  if (request.kind === 'decide') {
    // 決策用池內的模型、委任書的決策 effort。
    const seen = new Set<string>();
    return selection.pool.filter(entry => !seen.has(entry.model) && !!seen.add(entry.model)).map(entry => ({ ...entry, effort: contract.decide.effort ?? entry.effort }));
  }
  const entries = entriesForLevel(selection.pool, stepLevel(contract, request.mode), selection.workerEffortExplicit === true);
  return request.effort === undefined || selection.workerEffortExplicit ? entries : entries.map(entry => ({ ...entry, effort: request.effort! }));
}

function sideIsAuto(selection: ModelSelection | null, kind: DispatchRequest['kind']): selection is ModelSelection {
  return !!selection && selection.pool.length > 0 && (kind === 'decide' ? selection.auto.decide : selection.auto.worker);
}

/**
 * 不看額度的「原定」模型：省略步驟模型時由這裡決定，不由 decide 決定。
 * 明示的委任書（含所有舊委任書）回傳的就是以前的值。
 */
export function plannedDispatch(contract: KernelContract, request: DispatchRequest): DispatchChoice {
  const selection = autoSelection(contract);
  if (!sideIsAuto(selection, request.kind)) {
    if (request.kind === 'decide') return { model: contract.decide.model, ...(contract.decide.effort ? { effort: contract.decide.effort } : {}), auto: false };
    return { model: request.model ?? contract.worker.model, ...(contract.worker.effort ? { effort: contract.worker.effort } : {}), auto: false };
  }
  const entries = plannedEntries(contract, selection, request);
  const wanted = request.kind === 'decide' ? contract.decide.model : request.model;
  const entry = (wanted !== undefined ? entries.find(item => item.model === wanted) : undefined) ?? entries[0];
  return { model: entry.model, effort: entry.effort, auto: true };
}

/**
 * 派工前呼叫：原定模型那家額度不足（低於派工閘門檻，或量不到而且未知的次數已用完）時，
 * 在凍結池內改派目前合格的另一個模型。池內沒有合格的就回原定模型，交給派工閘照舊停下等人。
 * 明示的委任書不會改派。
 */
export function selectDispatch(contract: KernelContract, quotas: QuotaSnapshot, request: DispatchRequest, state: { unknownExhausted: boolean }): DispatchChoice {
  const selection = autoSelection(contract);
  const planned = plannedDispatch(contract, request);
  if (!sideIsAuto(selection, request.kind)) return planned;
  const entries = plannedEntries(contract, selection, request);
  const original = entries.find(entry => entry.model === planned.model)!;
  const remaining = remainingFor(original, quotas);
  const gate = contract.budget.minQuotaRemainingPercent;
  const blocked = remaining === null ? state.unknownExhausted : remaining < gate;
  if (!blocked) return { ...planned, remaining };
  const min = selection.minRemainingPercent;
  const alternative = entries.find(entry => {
    if (entry.model === original.model || entry.fallback) return false;
    const left = remainingFor(entry, quotas);
    return left !== null && left >= min && left >= gate;
  });
  if (!alternative) return { ...planned, remaining };
  const left = remainingFor(alternative, quotas);
  return {
    model: alternative.model, effort: alternative.effort, auto: true, remaining: left,
    reroute: {
      fromModel: original.model, fromEffort: original.effort,
      reason: `${original.model} 那家週額度${remaining === null ? '量不到，額度未知的派工次數已用完' : `剩 ${remaining}% < ${gate}%`}，改派凍結池內目前合格的 ${alternative.model}（剩 ${left}%）`,
      quotas: { claude: quotas.claude, codex: quotas.codex, fable: quotas.fable, readAt: quotas.readAt },
    },
  };
}

const entryText = (entry: Pick<PoolEntry, 'model' | 'effort' | 'level' | 'reason'>): string => `${entry.model}·${entry.effort}（${entry.level}${entry.reason ? `；${entry.reason}` : ''}）`;

/** status 與核准前給人看的說明。一行一項，呼叫端自己加欄位名稱。 */
export function describeSelection(selection: ModelSelection): Array<{ label: string; text: string }> {
  const sides = selection.auto.worker && selection.auto.decide ? '決策與 worker 都自動'
    : selection.auto.worker ? 'worker 自動、決策模型是明示的' : '決策模型自動、worker 是明示的';
  const lines = [
    { label: '選模型', text: `自動（${sides}）；難度上限 ${selection.difficulty}（${selection.difficultySource === 'caller' ? '呼叫端指定' : '範本預設'}）；開工時週額度 ${describeQuotas(selection.quotas)}（${selection.quotas.readAt} 讀取，門檻 ${selection.minRemainingPercent}%）` },
    { label: '選中', text: `決策 ${selection.selected.decide.model}（${selection.selected.decide.effort}）、worker ${selection.selected.worker.model}（${selection.selected.worker.effort}）；允許清單 ${selection.selected.allowedWorkerModels.join('、')}` },
  ];
  if (selection.pool.length > 0) lines.push({ label: '候選池', text: `${selection.pool.map(entryText).join('、')}。順序就是優先序，已凍結；額度不足時只會在這裡面改派` });
  if (selection.excluded.length > 0) lines.push({ label: '排除', text: selection.excluded.map(item => `${item.model}·${item.effort}（${item.level}）：${item.reason}`).join('；') });
  lines.push({ label: 'effort', text: `上限 ${DIFFICULTIES.map(level => `${level} ${selection.effortCeilings[level]}`).join('、')}${selection.workerEffortExplicit ? '；worker effort 是呼叫端明示的，照指定' : ''}` });
  return lines;
}

/** decide 的提示用：凍結的池、每級上限、目前各家剩餘。 */
export function describeSelectionForDecide(contract: KernelContract, selection: ModelSelection, quotas?: QuotaSnapshot): string {
  const current = quotas ?? selection.quotas;
  const writeLevel = stepLevel(contract, 'write'), readLevel = stepLevel(contract, 'read');
  const levels = contract.develop ? `write 步驟的難度是 ${writeLevel}、read 步驟是 ${readLevel}` : `每個步驟的難度都是 ${readLevel}`;
  return `
- 模型由 kernel 依額度與難度自動選，難度上限 ${selection.difficulty}。${levels}。你不能調高難度，也不能加模型。
- 凍結的候選池（順序就是優先序）：${selection.pool.map(entryText).join('、')}。
- 每級 effort 上限：${DIFFICULTIES.map(level => `${level} ${selection.effortCeilings[level]}`).join('、')}。
- ${quotas ? '目前' : '開工時'}週額度：${describeQuotas(current)}。低於門檻或量不到的那一家，kernel 會在池內改派目前合格的模型；池內都不合格就停下等人。
- step 不寫 model 時由 kernel 依這張表決定。要指定只能挑池內的模型${selection.workerEffortExplicit ? '；effort 由委任書指定，步驟不能改' : '；effort 可以省略，要寫只能是 low、medium、high，而且不能超過該步驟難度的上限'}。重要的改動可以派池內另一個模型做唯讀審查。`;
}
