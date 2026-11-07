/** 控制面板共用純規則。由既有側邊面板核對移植；不讀檔、不操作終端機。 */
export interface KernelAction {
  id: string; runId: string | null; label: string; summary: string; warning: string | null;
  args: string[]; commit: string | null; isRelease: boolean;
  /** 僅確認畫面保存；操作 JSON 維持原始 commit 欄位語義。 */
  confirmedCommit?: string | null;
}
export interface KernelProgress {
  decides?: { used: number; max: number }; workerSteps?: { used: number; max: number };
  inputTokens?: { used: number; max: number }; activeMinutes?: { used: number; max: number };
}
export interface KernelSnapshot {
  at: number; active: string | null; pendingArchive: number; triggersOn: boolean | null; error: string | null;
  runs: Array<{runId: string; state: string; label: string; goal: string}>;
}
export interface KernelDetail {
  runId: string; state: string; label: string; reason: string | null; detail: string | null; goal: string;
  template: string; nextAction: string | null; reportPath: string | null; progress: KernelProgress | null;
  develop: null | { repoRoot: string; branch: string; verifiedCommit: string | null; hasCheckpoint: boolean;
    currentBranch: string | null; defaultBranch: string | null; notices: string[]; testCommand: string | null;
    allowedPaths: string[]; checkpointRef: string | null };
  workFolder: string | null; models: string | null; boundary: string | null; origin: string | null;
  steps: Array<{id: string; title: string; status: string}>; accepted: boolean | null; currentAction: string | null;
}
export const EMPTY: KernelSnapshot = { at: 0, active: null, pendingArchive: 0, triggersOn: null, runs: [], error: null };
const TERMINAL = ['completed', 'failed', 'cancelled', 'budget_exhausted'];
const RESUMABLE = ['awaiting_approval', 'waiting_human', 'interrupted'];
const UNISOLATED = 'develop 的 worker 權限等於你本人，沒有隔離。核准即代表你承認這一點。';
/* ---- 純函式：畫面與操作的規則都在這裡，方便測試 ---- */

/** 目標可能很長又有多行，列表只要第一行。內容來自委任書，只顯示，不送進對話。 */
export const firstLine = (goal: string): string => (goal.split(/\r?\n/).find(line => line.trim()) ?? '').replace(/^\s*目標：/, '').trim()

export function shortCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

export function progressLine(progress: KernelProgress | null): string {
  if (!progress) return ''
  const parts: string[] = []
  if (progress.decides) parts.push(`決策 ${progress.decides.used}/${progress.decides.max}`)
  if (progress.workerSteps) parts.push(`worker ${progress.workerSteps.used}/${progress.workerSteps.max}`)
  if (progress.inputTokens) parts.push(`未快取 ${shortCount(progress.inputTokens.used)}/${shortCount(progress.inputTokens.max)}`)
  if (progress.activeMinutes) parts.push(`${Math.round(progress.activeMinutes.used)}/${progress.activeMinutes.max} 分`)
  return parts.join(' · ')
}

/** 狀態列的一行。沒事要看就回 undefined，把它清掉。 */
export function summaryLine(snap: KernelSnapshot): string | undefined {
  if (snap.error) return undefined
  const parts: string[] = []
  if (snap.active) parts.push('1 執行中')
  const waiting = snap.runs.filter(run => RESUMABLE.includes(run.state)).length
  if (waiting) parts.push(`${waiting} 等你`)
  if (snap.pendingArchive) parts.push(`${snap.pendingArchive} 待歸檔`)
  return parts.length ? `kernel ${parts.join(' · ')}` : undefined
}

/** 這個 run 現在能按什麼。按了只會進確認畫面；kernel 自己還會再驗一次。 */
export function actionsFor(d: KernelDetail): KernelAction[] {
  const run = d.runId
  const dev = d.develop
  const isTerminal = TERMINAL.includes(d.state)
  const out: KernelAction[] = []
  const plain = (id: string, label: string, summary: string, args: string[], warning: string | null = null): KernelAction =>
    ({ id, runId: run, label, summary, warning, args, commit: null, isRelease: false })

  if (RESUMABLE.includes(d.state)) {
    const isNew = d.state === 'awaiting_approval'
    out.push(plain('approve', isNew ? '核准' : '接回',
      isNew ? '核准委任書，讓這個 run 開始執行。' : '接回這個 run，從停下的地方繼續。',
      ['approve', run, ...(dev ? ['--acknowledge-unisolated'] : [])], dev ? UNISOLATED : null))
  }
  if (!isTerminal) out.push(plain('cancel', '取消 run', '取消這個 run，並確認程序真的停了。', ['cancel', run]))

  if (d.state === 'completed' && dev?.verifiedCommit) {
    const commit = dev.verifiedCommit
    const short = commit.slice(0, 10)
    const release = (id: string, label: string, summary: string, action: string, target: string, extra: string[], warning: string | null): KernelAction => ({
      id, runId: run, label, summary, warning, commit, isRelease: true,
      args: ['release', 'create', run, '--action', action, '--target', target, '--confirm', short, ...extra, '--json'],
    })
    if (dev.currentBranch && dev.currentBranch !== dev.branch) {
      out.push(release('merge', `合併到 ${dev.currentBranch}`, `把已通過測試的 ${short} 合併到 ${dev.currentBranch}。`, 'merge', dev.currentBranch, [], null))
    }
    out.push(release('push-branch', '推送這個分支', `把 ${short} 推到 origin/${dev.branch}，不動其他分支。`, 'push', dev.branch, dev.branch === dev.defaultBranch ? ['--allow-default-branch'] : [], dev.branch === dev.defaultBranch ? `origin/${dev.branch} 是遠端預設分支。在有自動更新的 repo，推上去等於部署到所有機器。` : null))
    if (dev.currentBranch && dev.currentBranch !== dev.branch) {
      const isDefault = dev.currentBranch === dev.defaultBranch
      out.push(release('push-current', `推送到 origin/${dev.currentBranch}`, `把 ${short} 推到 origin/${dev.currentBranch}。`, 'push', dev.currentBranch,
        isDefault ? ['--allow-default-branch'] : [],
        isDefault ? `origin/${dev.currentBranch} 是遠端預設分支。在有自動更新的 repo，推上去等於部署到所有機器。` : null))
    }
  }
  if (isTerminal && dev?.hasCheckpoint) {
    out.push(plain('rollback', '回復', '從開工前的回復點建 restore 分支。不切換分支，也不動目前的工作。', ['rollback', run, '--apply']))
  }
  if (isTerminal && dev) out.push(plain('cleanup', '清理 worktree', '移除這個 run 的 worktree。分支沒合併就留著。', ['cleanup', run]))
  if (isTerminal) {
    out.push(plain('archive', '標記已歸檔', '標記這個 run 已交接，它會從待歸檔清單消失。', ['archive', 'done', run, '--note', '由控制面板標記'],
      '這只改本機的標記，不會幫你寫交接。請先確認事實已經記下來。'))
  }
  return out
}

/** 切換自動觸發。打開代表排程和觸發可以無人看管地開工。 */
export function triggerAction(isOn: boolean): KernelAction {
  return isOn
    ? { id: 'triggers-off', runId: null, label: '關閉自動觸發', summary: '關閉總開關，排程和觸發都不會再開工。', warning: null, args: ['triggers', 'off'], commit: null, isRelease: false }
    : { id: 'triggers-on', runId: null, label: '開啟自動觸發', summary: '打開總開關，已核准的委任範本可以無人看管地開工。', warning: '開工後 worker 權限等於你本人，沒有隔離。', args: ['triggers', 'on'], commit: null, isRelease: false }
}

type RawSnapshot = { active?: unknown; pendingArchiveCount?: unknown; runs?: unknown }

export function parseSnapshot(raw: RawSnapshot, triggersOn: boolean | null, at: number): KernelSnapshot {
  const active = raw.active
  const activeId = typeof active === 'string' ? active
    : active && typeof active === 'object' && typeof (active as { runId?: unknown }).runId === 'string' ? (active as { runId: string }).runId : null
  const runs = Array.isArray(raw.runs) ? raw.runs as Array<Record<string, unknown>> : []
  return {
    at, active: activeId, triggersOn, error: null,
    pendingArchive: typeof raw.pendingArchiveCount === 'number' ? raw.pendingArchiveCount : 0,
    runs: runs.map(run => ({
      runId: String(run.runId ?? ''),
      state: String(run.effectiveState ?? ''),
      label: String(run.stateLabel ?? ''),
      goal: firstLine(String(run.goal ?? '')),
    })).filter(run => run.runId),
  }
}

export function parseDetail(raw: Record<string, unknown>): KernelDetail {
  const dev = raw.develop as Record<string, unknown> | null | undefined
  return {
    runId: String(raw.runId ?? ''),
    state: String(raw.effectiveState ?? raw.state ?? ''),
    label: String(raw.stateLabel ?? ''),
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    detail: typeof raw.detail === 'string' ? raw.detail : null,
    goal: String(raw.goal ?? ''),
    template: String(raw.template ?? ''),
    nextAction: typeof raw.nextAction === 'string' ? raw.nextAction : null,
    reportPath: typeof raw.reportPath === 'string' ? raw.reportPath : null,
    progress: (raw.progress as KernelProgress | undefined) ?? null,
    develop: dev ? {
      repoRoot: String(dev.repoRoot ?? ''),
      branch: String(dev.branch ?? ''),
      verifiedCommit: typeof dev.verifiedCommit === 'string' ? dev.verifiedCommit : null,
      hasCheckpoint: Boolean(dev.checkpointResult ?? dev.checkpointPrepared),
      currentBranch: null,
      defaultBranch: null,
      notices: Array.isArray(dev.notices) ? dev.notices.map(String) : [],
      testCommand: typeof dev.testCommand === 'string' ? dev.testCommand : null,
      allowedPaths: Array.isArray(dev.allowedPaths) ? dev.allowedPaths.map(String) : [],
      checkpointRef: typeof (dev.checkpoint as { ref?: unknown } | null | undefined)?.ref === 'string' ? (dev.checkpoint as { ref: string }).ref : null,
    } : null,
    workFolder: typeof raw.workFolder === 'string' ? raw.workFolder : null,
    models: modelsLine(raw.models),
    boundary: typeof raw.boundaryLabel === 'string' ? raw.boundaryLabel : null,
    origin: typeof raw.origin === 'string' ? raw.origin : raw.origin ? JSON.stringify(raw.origin) : null,
    steps: Array.isArray(raw.steps) ? (raw.steps as Array<Record<string, unknown>>).map(step => ({
      id: String(step.id ?? ''), title: String(step.title ?? ''), status: String(step.status ?? ''),
    })) : [],
    accepted: typeof (raw.acceptance as { passed?: unknown } | null | undefined)?.passed === 'boolean' ? (raw.acceptance as { passed: boolean }).passed : null,
    currentAction: currentActionLine(raw.currentAction),
  }
}

/* ---- 把代碼翻成人看得懂的話 ---- */

const SHORT_STATES: Record<string, string> = {
  completed: '完成', failed: '失敗', cancelled: '已取消', budget_exhausted: '預算用完', running: '執行中',
  awaiting_approval: '等核准', waiting_human: '等你決定', interrupted: '中斷', stop_pending: '等舊程序', version_drift: '已暫停',
}
export const shortState = (state: string, label: string): string => SHORT_STATES[state] ?? label

const REASONS: Record<string, string> = {
  delivered: '工作做完，驗收通過',
  user_cancelled: '由人取消',
  input_tokens: 'token 預算用完',
  decide_gave_up: '模型判斷做不下去',
  decide_invalid: '模型回的計畫格式不對',
  decide_question: '模型有問題要問你',
  repeated_acceptance_failure: '驗收連續沒過',
  kernel_error: 'kernel 自己出錯',
  workspace_failed: 'worktree 準備或檢查失敗',
  trigger_lost_lock: '自動觸發搶不到執行鎖',
  worker_still_alive: '舊的 worker 還在跑',
  check_still_alive: '測試指令停不掉',
  check_identity_unknown: '查不到測試程序的身分',
  cannot_verify_start: '無法確認 worker 有沒有開始',
  quota_low: '額度低於門檻',
  quota_unknown: '查不到額度',
  worktree_changed: 'worktree 被動過',
  repo_refs_changed: 'repo 的 ref 被動過',
  mandate_expired: '委任書過期',
  checkpoint_push_failed: '回復點推送失敗',
}
/** 代碼一定留著：翻譯沒收錄時它就是唯一線索，查 log 也要用。 */
export const reasonLabel = (reason: string | null): string | null => (reason ? `${REASONS[reason] ?? '見細節'}（${reason}）` : null)

export const templateLabel = (template: string): string =>
  template === 'develop' ? '開發：會改程式，權限等於你本人' : template === 'readonly-audit' ? '唯讀稽核：只看不改' : template

const STEP_STATUS: Record<string, string> = { passed: '通過', failed: '沒過', running: '執行中', pending: '等待', skipped: '跳過', blocked: '卡住' }
export const stepLabel = (status: string): string => STEP_STATUS[status] ?? status

/** 這個狀態代表什麼、你該做什麼。 */
export function stateHelp(d: KernelDetail): string {
  const isDevelop = d.template === 'develop'
  switch (d.state) {
    case 'completed': return isDevelop
      ? (d.develop?.verifiedCommit ? '做完了，測試也過了。成果還在分支上，要不要收下由你決定。' : '做完了，但這個 commit 沒有通過測試的紀錄，不能放行。')
      : '查完了，報告裡的引用都核對過。看報告就好，沒有東西要合併。'
    case 'running': return '正在跑，不用動它。想停就按取消。'
    case 'awaiting_approval': return '還沒開工，等你看過委任書後核准。'
    case 'waiting_human': return '停下來等你決定，先看原因和細節。按接回會繼續。'
    case 'interrupted': return '程序中斷了。按接回會從停下的地方繼續，已完成的不會重做。'
    case 'failed': return '失敗結束，先看原因和報告。'
    case 'cancelled': return '已取消，不會再跑。'
    case 'budget_exhausted': return '預算用完而停止。做到一半的成果還留著，要看報告判斷。'
    case 'stop_pending': return '正在等舊程序結束，還不能做其他操作。'
    case 'version_drift': return 'ai-cli 被更新了，先暫停。按接回會用新版繼續。'
    default: return ''
  }
}

/**
 * 面板現在該看哪一筆。
 * 新開工的 run 一定跳過去，否則畫面會一直停在舊的那筆；人自己點過的才固定住，直到又有新的開工。
 */
export function chooseRun(current: string | null, isPinned: boolean, previousActive: string | null, snap: KernelSnapshot): { runId: string | null; pinned: boolean } {
  if (snap.error) return { runId: current, pinned: isPinned }
  const isListed = (id: string) => snap.runs.some(run => run.runId === id)
  if (snap.active && snap.active !== previousActive) return { runId: snap.active, pinned: false }
  if (isPinned && current && isListed(current)) return { runId: current, pinned: true }
  if (snap.active) return { runId: snap.active, pinned: false }
  if (current && isListed(current)) return { runId: current, pinned: false }
  return { runId: snap.runs.find(run => RESUMABLE.includes(run.state))?.runId ?? snap.runs[0]?.runId ?? null, pinned: false }
}

export function clockTime(at: number): string {
  const date = new Date(at)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** run id 的時間是 UTC，顯示成這台機器的當地時間。 */
export function startedAt(runId: string): string {
  const found = runId.match(/^kr-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/)
  if (!found) return ''
  const [, y, mo, da, h, mi] = found
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi)))
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function modelsLine(raw: unknown): string | null {
  const models = raw as { decide?: { model?: string; effort?: string }; worker?: { model?: string; effort?: string } } | null | undefined
  if (!models?.decide && !models?.worker) return null
  const one = (name: string, m?: { model?: string; effort?: string }) => (m?.model ? `${name} ${m.model}${m.effort ? `（${m.effort}）` : ''}` : null)
  return [one('決策', models.decide), one('worker', models.worker)].filter(Boolean).join('、')
}

function currentActionLine(raw: unknown): string | null {
  const action = raw as { kind?: string; title?: string; stepId?: string } | null | undefined
  if (!action?.kind) return null
  return [action.kind, action.title ?? action.stepId].filter(Boolean).join('：')
}

