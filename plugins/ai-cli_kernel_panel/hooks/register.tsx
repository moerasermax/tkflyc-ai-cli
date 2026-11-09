import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KernelAction, KernelDetail, KernelNotice, KernelProgress, KernelSnapshot } from '../types'

const PANE = 'ai-cli_kernel_panel'
const TICK_MS = 5_000
const IDLE_MS = 30_000
const READ_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 180_000
const RESUMABLE = ['awaiting_approval', 'waiting_human', 'interrupted']

const EMPTY: KernelSnapshot = { at: 0, active: null, activeRuns: [], pendingArchive: 0, triggersOn: null, runs: [], error: null }
const snapshot = atom({ plugin: 'ai-cli_kernel_panel', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-2' })
const selected = atom({ plugin: 'ai-cli_kernel_panel', key: 'selected' } as const, null as string | null, { shape: 'selected-1' })
const detail = atom({ plugin: 'ai-cli_kernel_panel', key: 'detail' } as const, null as KernelDetail | null, { shape: 'detail-2' })
const confirm = atom({ plugin: 'ai-cli_kernel_panel', key: 'confirm' } as const, null as KernelAction | null, { shape: 'confirm-2' })
const notice = atom({ plugin: 'ai-cli_kernel_panel', key: 'notice' } as const, null as KernelNotice | null, { shape: 'notice-1' })
const report = atom({ plugin: 'ai-cli_kernel_panel', key: 'report' } as const, null as string[] | null, { shape: 'report-1' })
const available = atom({ plugin: 'ai-cli_kernel_panel', key: 'available' } as const, [] as KernelAction[], { shape: 'available-1' })

/* ---- 純函式：畫面與操作的規則都在這裡，方便測試 ---- */

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

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
  if (snap.activeRuns.length) parts.push(`${snap.activeRuns.length} 執行中`)
  const waiting = snap.runs.filter(run => RESUMABLE.includes(run.state)).length
  if (waiting) parts.push(`${waiting} 等你`)
  if (snap.pendingArchive) parts.push(`${snap.pendingArchive} 待歸檔`)
  return parts.length ? `kernel ${parts.join(' · ')}` : undefined
}

/** 切換自動觸發。打開代表排程和觸發可以無人看管地開工。 */
export function triggerAction(isOn: boolean): KernelAction {
  return isOn
    ? { id: 'triggers-off', runId: null, label: '關閉自動觸發', summary: '關閉總開關，排程和觸發都不會再開工。', warning: null, args: ['triggers', 'off'], commit: null, isRelease: false }
    : { id: 'triggers-on', runId: null, label: '開啟自動觸發', summary: '打開總開關，已核准的委任範本可以無人看管地開工。', warning: '開工後 worker 權限等於你本人，沒有隔離。', args: ['triggers', 'on'], commit: null, isRelease: false }
}

type RawSnapshot = { active?: unknown; activeRuns?: unknown; pendingArchiveCount?: unknown; runs?: unknown }

export function parseSnapshot(raw: RawSnapshot, triggersOn: boolean | null, at: number): KernelSnapshot {
  const active = raw.active
  const legacyId = typeof active === 'string' ? active
    : active && typeof active === 'object' && typeof (active as { runId?: unknown }).runId === 'string' ? (active as { runId: string }).runId : null
  // 新版的空陣列就是沒有佔用者，不能退回舊 active。
  const activeRuns = 'activeRuns' in raw
    ? (Array.isArray(raw.activeRuns) ? raw.activeRuns.filter((run): run is { runId: string } => !!run && typeof run.runId === 'string').map(run => run.runId) : [])
    : legacyId ? [legacyId] : []
  const runs = Array.isArray(raw.runs) ? raw.runs as Array<Record<string, unknown>> : []
  return {
    at, active: activeRuns[0] ?? null, activeRuns, triggersOn, error: null,
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
    goal: firstLine(String(raw.goal ?? '')),
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

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const firstLines = (text: string, count: number): string => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, count).join(' / ')

let ticker: { cancel: () => void } | undefined
let stateRoot: string | undefined
let refreshing = false
let lastRefresh = 0
let hasActive = false
let pinned = false
let lastActive: string | null = null
let performing = false

export async function resolvePaths($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const configured = await $.env.get('AI_CLI_REPO')
  stateRoot = (await $.env.get('AI_CLI_STATE_DIR')) || `${home}/.local/state/ai-cli`
  const candidates = [...new Set([configured, home ? `${home}/ai-cli-mcp-source` : undefined].filter((value): value is string => !!value))]
  const failures: string[] = []
  for (const repo of candidates) {
    const binary = `${repo.replace(/[\\/]+$/, '')}/dist/bin/ai-cli.js`
    try { await $.fs.read(binary); return binary }
    catch (error) { failures.push(`${binary}：${reasonOf(error)}`) }
  }
  throw new Error(`找不到已建置的 ai-cli repo。請將環境變數 AI_CLI_REPO 設成含 dist/bin/ai-cli.js 的 repo 根目錄，重新啟動 Claude Code。PowerShell 範例：$env:AI_CLI_REPO = 'D:/projects/ai-cli-mcp-source'\n${failures.join('\n')}`)
}

export async function kernel($: EngineInterface, args: readonly string[], timeoutMs = READ_TIMEOUT_MS): Promise<string> {
  const binary = await resolvePaths($)
  const ran = await $.process.run(['node', binary, 'kernel', ...args], { timeoutMs })
  if (ran.exitCode !== 0) throw new Error(`結束碼 ${ran.exitCode}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`)
  return ran.stdout
}

/** actions 的結構直接來自 CLI dashboardActions；無法辨認就關閉操作，絕不本地猜政策。 */
export function parseActions(raw: unknown, runId: string): KernelAction[] {
  if (!Array.isArray(raw)) throw new Error('actions --json 沒有回傳陣列')
  const nullableString = (value: unknown) => value === null || typeof value === 'string'
  if (!raw.every(action => action && typeof action.id === 'string' && action.runId === runId &&
    typeof action.label === 'string' && typeof action.summary === 'string' && nullableString(action.warning) &&
    nullableString(action.commit) && typeof action.isRelease === 'boolean' &&
    Array.isArray(action.args) && action.args.length > 0 && action.args.every((arg: unknown) => typeof arg === 'string'))) {
    throw new Error('actions --json 格式不符，沒有提供操作')
  }
  return raw
}

async function fetchActions($: EngineInterface, runId: string): Promise<KernelAction[]> {
  return parseActions(JSON.parse(await kernel($, ['actions', runId, '--json'])), runId)
}

async function fetchDetail($: EngineInterface, runId: string): Promise<KernelDetail> {
  const parsed = parseDetail(JSON.parse(await kernel($, ['status', runId, '--json'])) as Record<string, unknown>)
  return parsed
}

async function readTriggers($: EngineInterface): Promise<boolean | null> {
  await resolvePaths($)
  return $.fs.read(`${stateRoot}/kernel/triggers.json`)
    .then(text => (JSON.parse(text) as { enabled?: unknown }).enabled === true, () => false)
}

async function refresh($: EngineInterface): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const now = await $.clock.now()
    lastRefresh = now
    let next: KernelSnapshot
    try {
      next = parseSnapshot(JSON.parse(await kernel($, ['status', '--json'])) as RawSnapshot, await readTriggers($), now)
    } catch (error) {
      next = { ...EMPTY, at: now, error: `讀不到 kernel：${reasonOf(error)}。ai-cli 不在預設位置的話，設環境變數 AI_CLI_REPO。` }
    }
    hasActive = next.active !== null
    await update($, snapshot, () => next)
    await $.ui.status(summaryLine(next))
    // 確認畫面開著時不換 run，等它關掉；換了會讓人搞不清楚正在確認哪一筆。
    let isConfirming = false
    await update($, confirm, open => { isConfirming = open !== null; return open })
    let before = null as string | null
    let chosen = null as string | null
    await update($, selected, current => {
      before = current
      if (isConfirming) { chosen = current; return current }
      const pick = chooseRun(current, pinned, lastActive, next)
      pinned = pick.pinned
      chosen = pick.runId
      return pick.runId
    })
    if (!isConfirming && !next.error) lastActive = next.active
    if (chosen !== before) await update($, report, () => null)
    if (chosen) {
      const runId: string = chosen
      try {
        await update($, available, () => [])
        const fresh = await fetchDetail($, runId)
        const actions = await fetchActions($, runId)
        await update($, detail, () => fresh)
        await update($, available, () => actions)
      } catch (error) {
        await update($, notice, () => ({ kind: 'error', text: `讀不到 ${runId}：${reasonOf(error)}` }))
      }
    } else await update($, available, () => [])
  } finally { refreshing = false }
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const panes = await $.ui.panes()
  const wait = panes.some(pane => pane.id === PANE && pane.isPlaced) && hasActive ? TICK_MS : IDLE_MS
  if (now - lastRefresh >= wait) await refresh($)
}

async function select($: EngineInterface, runId: string, pin = true): Promise<void> {
  pinned = pin
  await update($, selected, () => runId)
  await update($, confirm, () => null)
  await update($, report, () => null)
  await update($, available, () => [])
  try {
    const fresh = await fetchDetail($, runId)
    const actions = await fetchActions($, runId)
    await update($, detail, () => fresh)
    await update($, available, () => actions)
  } catch (error) {
    await update($, notice, () => ({ kind: 'error', text: `讀不到這個 run：${reasonOf(error)}` }))
  }
}

async function showReport($: EngineInterface, d: KernelDetail): Promise<void> {
  if (!d.reportPath) { await update($, notice, () => ({ kind: 'info', text: '這個 run 還沒有報告。' })); return }
  try {
    const text = await $.fs.read(d.reportPath)
    await update($, report, () => text.split(/\r?\n/).slice(0, 60))
  } catch (error) {
    await update($, notice, () => ({ kind: 'error', text: `讀不到報告：${reasonOf(error)}` }))
  }
}

/** 第二次按下才會走到這裡。第一次只是進確認畫面。 */
async function perform($: EngineInterface, action: KernelAction): Promise<void> {
  if (performing) return
  performing = true
  await update($, confirm, () => null)
  await update($, notice, () => ({ kind: 'info', text: `執行中：${action.label}…` }))
  try {
    if (action.runId) {
      const fresh = await fetchDetail($, action.runId)
      if ((fresh.develop?.verifiedCommit ?? null) !== action.confirmedCommit ||
        (action.commit !== null && fresh.develop?.verifiedCommit !== action.commit)) throw new Error('這個 run 的 commit 已經變了，沒有執行。請重新看過再按。')
      const current = (await fetchActions($, action.runId)).find(item => item.id === action.id)
      if (!current || ['runId', 'commit', 'args', 'isRelease', 'label', 'summary', 'warning'].some(key =>
        JSON.stringify(current[key as keyof KernelAction]) !== JSON.stringify(action[key as keyof KernelAction]))) {
        throw new Error('可用操作或確認內容已經變了，沒有執行。請重新看過再按。')
      }
    } else {
      const enabled = await readTriggers($)
      if (enabled === null || triggerAction(enabled).id !== action.id) throw new Error('自動觸發狀態已經變了，請重新確認')
    }
    let text: string
    if (action.isRelease) {
      const created = JSON.parse(await kernel($, action.args, ACTION_TIMEOUT_MS)) as { id?: unknown }
      if (typeof created.id !== 'string') throw new Error('kernel 沒有回傳放行 id，沒有執行')
      text = await kernel($, ['release', 'run', created.id], ACTION_TIMEOUT_MS)
    } else {
      text = await kernel($, action.args, ACTION_TIMEOUT_MS)
    }
    await update($, notice, () => ({ kind: 'ok', text: `${action.label}：${firstLines(text, 3) || '完成'}` }))
  } catch (error) {
    // 放行結果不明時，kernel 不會自動重試，這裡也不重試。
    await update($, notice, () => ({ kind: 'error', text: `${action.label}失敗：${reasonOf(error)}` }))
  }
  try { await refresh($) } finally { performing = false }
}

export async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const command = args.trim()
  if (command === 'side') {
    const opened = await $.ui.open({ id: PANE, title: 'ai-cli_kernel', focus: true })
    await refresh($)
    return { text: opened.isPlaced ? 'kernel 控制面板已打開。' : `kernel 控制面板現在放不下：${opened.reason ?? '視窗太窄'}` }
  }
  if (command) return { text: '用法：/kernel 開新 Terminal 分頁；/kernel side 開 session 內的側邊面板。' }
  try {
    await kernel($, ['dashboard', '--new-tab'])
    return { text: '已在新分頁打開' }
  } catch (error) {
    return { text: `無法開新分頁：${reasonOf(error)}\n可自行貼上：ai-cli kernel dashboard --new-tab\n也可使用 /kernel side。` }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    // worker 不該有這個面板：它連放行都不被允許。
    if (e.isInteractive && (await $.env.get('AI_CLI_WORKER')) !== '1') {
      await $.command.register({ name: 'kernel', description: '打開 ai-cli_kernel 控制面板' })
      // 輪詢失敗要看得到，否則面板只會安靜地停在舊資料上。
      ticker = $.clock.every(TICK_MS, () => {
        void tick($).catch(error => update($, notice, () => ({ kind: 'error', text: `更新失敗：${reasonOf(error)}` })))
      })
      void refresh($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    return next(e)
  })

  on('command.run', { command: 'kernel' }, async ($, e) => runCommand($, e.args ?? ''))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns ?? 40)
    const snap = await read($, snapshot)
    const chosen = await read($, selected)
    const d = await read($, detail)
    const pending = await read($, confirm)
    const message = await read($, notice)
    const lines = await read($, report)
    const current = d && d.runId === chosen ? d : null
    const actions = current ? (await read($, available)).filter(action => action.runId === current.runId) : []
    const row = (label: string, value: string | null | undefined, color?: string) => (value ? (
      <Box flexDirection="row">
        <Box width={9} flexShrink={0}><Text dimColor>{label}</Text></Box>
        <Box flexShrink={1}><Text color={color}>{value}</Text></Box>
      </Box>
    ) : null)

    return (
      <Box flexDirection="column">
        {e.props.isFocused
          ? <Text dimColor>鍵盤：數字鍵按操作、Tab 移動、Enter 按下、方向鍵捲動、Esc 回輸入框</Text>
          : <Text dimColor>用滑鼠點按鈕；要用鍵盤就先點面板或按 ctrl+x tab</Text>}
        {snap.error ? <Text color="red">{snap.error}</Text> : null}
        {row('更新於', snap.at ? `${clockTime(snap.at)}（有 run 在跑時每 5 秒，閒置 30 秒）` : '讀取中…')}
        {row('執行中', snap.activeRuns.length ? snap.activeRuns.join('、') : '沒有', snap.activeRuns.length ? 'green' : undefined)}
        {snap.active && snap.active !== chosen && !pending ? (
          <Button key="follow-active" hotkey="f" label="f 跳到執行中的 run" onPress={() => { void select($, snap.active as string, false) }} />
        ) : null}
        {row('自動觸發', snap.triggersOn === null ? '未知' : snap.triggersOn ? '開：已核准的委任範本會自己開工' : '關：不會自己開工')}
        {row('待歸檔', `${snap.pendingArchive} 筆`)}
        {message ? row('結果', message.text, message.kind === 'error' ? 'red' : message.kind === 'ok' ? 'green' : undefined) : null}

        {pending ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>確定要「{pending.label}」嗎？</Text>
            {row('對象', pending.runId)}
            {row('會發生', pending.summary)}
            {pending.warning ? row('⚠ 注意', pending.warning, 'red') : null}
            {row('實際指令', `ai-cli kernel ${pending.args.join(' ')}`)}
            <Box flexDirection="row" marginTop={1} columnGap={1}>
              <Button key="confirm-yes" hotkey="y" label={`y 確定${pending.label}`} onPress={() => { void perform($, pending) }} />
              <Button key="confirm-no" hotkey="n" label="n 不要" onPress={() => { void update($, confirm, () => null) }} />
            </Box>
          </Box>
        ) : null}

        {!pending ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>最近的 run（點一下看詳細）</Text>
            {snap.runs.length === 0 ? <Text dimColor>還沒有 run。</Text> : <Text dimColor>  開始時間     狀態      目標</Text>}
            {snap.runs.slice(0, 8).map(run => (
              <Button key={run.runId} plain onPress={() => { void select($, run.runId) }}>
                {run.runId === chosen ? '▶ ' : '  '}{startedAt(run.runId)}  {shortState(run.state, run.label)} <Text dimColor>{clip(run.goal, Math.max(10, width - 24))}</Text>
              </Button>
            ))}
          </Box>
        ) : null}

        {!pending && current ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>選中的 run</Text>
            {row('編號', current.runId)}
            {row('開始', startedAt(current.runId))}
            {row('目標', clip(current.goal, width * 2))}
            {row('範本', templateLabel(current.template))}
            {row('狀態', current.label, current.state === 'failed' ? 'red' : current.state === 'completed' ? 'green' : undefined)}
            {row('說明', stateHelp(current))}
            {row('原因', reasonLabel(current.reason))}
            {row('細節', current.detail ? clip(current.detail, width * 3) : null)}
            {row('來源', current.origin ? `自動觸發：${clip(current.origin, width)}` : null)}
            {row('工作目錄', current.workFolder)}
            {row('模型', current.models)}
            {row('權限', current.boundary)}
            {row('進度', progressLine(current.progress))}
            {row('正在做', current.currentAction)}
            {row('驗收', current.accepted === null ? null : current.accepted ? '通過' : '沒過')}
            {current.develop ? row('分支', current.develop.branch) : null}
            {current.develop ? row('測試指令', current.develop.testCommand) : null}
            {current.develop ? row('通過的commit', current.develop.verifiedCommit?.slice(0, 10)) : null}
            {current.develop ? row('可改路徑', current.develop.allowedPaths.length ? clip(current.develop.allowedPaths.join('、'), width * 2) : '不限') : null}
            {current.develop ? row('回復點', current.develop.checkpointRef) : null}
            {row('下一步', current.nextAction ? clip(current.nextAction, width * 2) : null)}

            {current.steps.length ? (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>步驟</Text>
                {current.steps.map(step => <Text>[{stepLabel(step.status)}] {clip(step.title, width - 8)}</Text>)}
              </Box>
            ) : null}

            <Box flexDirection="column" marginTop={1}>
              <Text bold>可以做的事</Text>
              <Text dimColor>會改東西的操作都要再確認一次才執行。</Text>
              <Box flexDirection="row" columnGap={1}>
                <Button key="show-report" hotkey="r" label="r 看報告" onPress={() => { void showReport($, current) }} />
                <Box flexShrink={1}><Text dimColor>在面板裡顯示報告前 60 行，不改任何東西。</Text></Box>
              </Box>
              {actions.slice(0, 9).map((action, index) => (
                <Box flexDirection="row" columnGap={1}>
                  <Button key={action.id} hotkey={String(index + 1)} label={`${index + 1} ${action.label}`} onPress={() => { void update($, confirm, () => ({ ...action, confirmedCommit: current.develop?.verifiedCommit ?? null })) }} />
                  <Box flexShrink={1}><Text dimColor>{action.summary}</Text></Box>
                </Box>
              ))}
            </Box>
          </Box>
        ) : null}

        {!pending && lines ? (
          <Box flexDirection="column" marginTop={1}>
            <Button key="hide-report" hotkey="c" label="c 收起報告" onPress={() => { void update($, report, () => null) }} />
            {lines.map(line => <Text>{clip(line || ' ', width * 3)}</Text>)}
          </Box>
        ) : null}

        {snap.triggersOn !== null ? (
          <Box flexDirection="row" marginTop={1} columnGap={1}>
            <Button key="toggle-triggers" hotkey="t" label={`t ${triggerAction(snap.triggersOn).label}`} onPress={() => { void update($, confirm, () => triggerAction(snap.triggersOn === true)) }} />
            <Box flexShrink={1}><Text dimColor>{triggerAction(snap.triggersOn).summary}</Text></Box>
          </Box>
        ) : null}
      </Box>
    )
  })
}
