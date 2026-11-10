/**
 * ai-cli kernel runs on the panel: pure functions over the run folder's files, no I/O.
 *
 * The run state is the kernel's own replay (src/ai-cli_kernel/replay.ts) cut down to what the panel shows: the
 * state, what the runner is doing right now and since when, and the active minutes against the budget. The event
 * and field names are the kernel's (src/ai-cli_kernel/types.ts KernelEventBody): change them there and this reader
 * goes blind, so tests/jobs.test.ts pins each one it reads.
 */

/** Finished runs stay this long after their last state event, unless archived first (archived.json). */
export const KERNEL_RECENT_MS = 24 * 60 * 60_000
/** At most this many run rows; the rest are counted on one line. */
export const KERNEL_MAX_ROWS = 4
/** A running run whose runner.json is gone, with no journal event for this long, is called interrupted. */
export const KERNEL_RUNNER_GRACE_MS = 60_000

/**
 * running: the runner works. approval: the contract waits for the person. human: paused for the person
 * (waiting_human, needs_reconcile, stop_pending, version_drift). done/failed/budget: finished. interrupted: still
 * `running` in the journal, but no runner holds it. expired: never approved, the contract has lapsed.
 * unreadable: a file is missing or broken. cancelled: never shown.
 */
export type KernelKind = 'running' | 'approval' | 'human' | 'done' | 'failed' | 'budget' | 'interrupted' | 'expired' | 'unreadable' | 'cancelled'

export type KernelRunSummary = {
  runId: string
  /** The run id's last 4 characters, what the person calls a run by. */
  short: string
  /** The repo folder's name (develop) or the work folder's; '' when the contract could not be read. */
  project: string
  /** The repo root or work folder in full, to tell this session's project from others. */
  projectDir: string
  state: string
  reason: string
  kind: KernelKind
  /** What the run is doing, or why it stopped: 'decide', '步驟 2/4 寫測試', '驗收測試', '等測試鎖（kernel 3a1a）'. */
  phase: string
  /** When that phase began (ms). */
  phaseSince: number
  /** When the last state event was written (ms); the run's creation when it has none. */
  stateSince: number
  /** Seq of the last state event: a new pause of the same kind is a new event to tell the person about. */
  stateSeq: number
  /**
   * Which change of state a toast is about: the state event's seq; for a stop derived from the journal, the event it
   * came from; for an interrupted run, the journal's last seq (runner.json coming and going does not move it).
   */
  alertSeq: number
  /** The journal's own state is terminal (completed, failed, budget_exhausted, cancelled): no event can reopen it. */
  terminal: boolean
  lastSeq: number
  lastAt: number
  /** Active time as the kernel counts it toward maxWallMinutes: closed spans plus the open one. */
  activeMs: number
  activeSince: number | null
  wallMinutes: number | null
  /** The develop contract's approval deadline (ms), if any. */
  expiresAt: number | null
  /** actionId → what the panel calls that action's job: 'decide' or '步驟 i/n 標題'. */
  labels: Record<string, string>
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
const str = (v: unknown) => typeof v === 'string' ? v : ''
const clip = (v: string, n: number) => Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, n).join('')
const time = (v: unknown) => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0 }
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export const RUN_ID = /^kr-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/

/**
 * The journal as the kernel reads it (journal.ts RunStore.read): only the last line may be half written (a crash),
 * and is dropped; a broken line in the middle is real damage, so it throws instead of guessing.
 */
export function parseJournal(text: string): Record<string, unknown>[] {
  const lines = text.split('\n')
  const events: Record<string, unknown>[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch {
      if (lines.slice(i + 1).every(rest => !rest.trim())) break
      throw new Error(`journal 第 ${i + 1} 行損毀`)
    }
    const event = record(value)
    if (!event || typeof event.type !== 'string') throw new Error(`journal 第 ${i + 1} 行不是事件`)
    events.push(event)
  }
  return events
}

/** `[K-<runId without kr- and dashes>-<actionId>]` (src/ai-cli_kernel/plan.ts actionMarker) heads every kernel prompt. */
export function kernelMarker(task: string): { runId: string, actionId: string } | { probe: true } | undefined {
  const head = task.trimStart()
  if (/^\[K-probe-[0-9a-z]+\]/i.test(head)) return { probe: true }
  const m = head.match(/^\[K-([0-9]{8})([0-9]{6})([0-9a-f]{4})-([A-Za-z0-9]+)\]/)
  return m ? { runId: `kr-${m[1]}-${m[2]}-${m[3]}`, actionId: m[4]! } : undefined
}

const PAUSED = ['waiting_human', 'needs_reconcile', 'stop_pending', 'version_drift']
/** src/ai-cli_kernel/types.ts TERMINAL_STATES and NEEDS_HUMAN_FAILURES. */
const TERMINAL = ['completed', 'failed', 'cancelled', 'budget_exhausted']
const NEEDS_HUMAN_FAILURES = ['rate_limited', 'quota', 'auth', 'model_unavailable']
/** The kernel's reason codes in words; anything else is shown as written. */
const REASONS: Record<string, string> = {
  delivered: '交付完成',
  user_cancelled: '已取消',
  boundary_unverified: '權限邊界未驗證',
  decide_question: 'decide 有問題問你',
  quota_low: '額度不足',
  repo_refs_changed: 'repo 被動過',
  worktree_changed: 'worktree 被動過',
  mandate_expired: '委任書已失效',
  dist_changed: 'ai-cli 版本變了',
  wall_clock: '時間用完',
  input_tokens: 'token 用完',
  test_failures: '測試失敗太多次',
  worker_steps: 'worker 次數用完',
  decides: 'decide 次數用完',
  decide_invalid: 'decide 輸出無效',
  repeated_acceptance_failure: '驗收連續失敗',
  rate_limited: '被限流',
  quota: '額度用完',
  auth: '登入失效',
  model_unavailable: '模型無法使用',
}
export function reasonText(reason: string): string {
  if (!reason) return ''
  const repeated = reason.match(/^repeated_failure:(.+)$/)
  if (repeated) return `連續失敗（${repeated[1]}）`
  return REASONS[reason] ?? clip(reason, 24)
}
const CHECKS: Record<string, string> = { setup: 'setup 準備環境', test: '驗收測試', context: '讀取脈絡' }

/** Folds one run's contract and journal into its panel summary. `contract` may be undefined (unreadable). */
export function summarizeKernelRun(runId: string, contract: unknown, events: Record<string, unknown>[], runnerPresent: boolean, now: number): KernelRunSummary {
  const c = record(contract)
  const develop = record(c?.develop)
  const projectDir = str(develop?.repoRoot) || str(c?.workFolder)
  const wall = record(c?.budget)?.maxWallMinutes
  const expires = time(develop?.expiresAt)
  let state = 'awaiting_approval', reason = '', stateSince = 0, stateSeq = 0, lastSeq = 0, lastAt = 0
  let activeMs = 0, activeSince: number | null = null
  let lockHeldBy: string | null = null, lockSince = 0
  let check: { kind: string, pid: unknown, at: number } | null = null
  const steps = new Map<string, { index: number, count: number, title: string }>()
  const actions = new Map<string, { kind: string, stepId: string, at: number, open: boolean, outcome?: Record<string, unknown> }>()
  // replay.ts derivedStop: a stop the journal already holds while its state event is not written yet.
  let pendingStop: { state: string, reason: string } | null = null, humanStop: { state: string, reason: string } | null = null
  let streak: { failureClass: string | null, count: number } = { failureClass: null, count: 0 }
  let rejectedDecides = 0, acceptanceFailures = 0
  let stoppedAt: { seq: number, at: number } | null = null
  const fail = (failureClass: string) => {
    streak = streak.failureClass === failureClass ? { failureClass, count: streak.count + 1 } : { failureClass, count: 1 }
    if (NEEDS_HUMAN_FAILURES.includes(failureClass)) humanStop = { state: 'waiting_human', reason: failureClass }
  }
  const derived = (): { state: string, reason: string } | null => pendingStop ?? humanStop
    ?? (streak.count >= 2 ? { state: 'failed', reason: `repeated_failure:${streak.failureClass}` } : null)
    ?? (rejectedDecides >= 2 ? { state: 'failed', reason: 'decide_invalid' } : null)
    ?? (acceptanceFailures >= 2 ? { state: 'failed', reason: 'repeated_acceptance_failure' } : null)
  // A time that does not parse moves no clock: as 0 it would count the budget from 1970.
  const close = (at: number) => { if (at && activeSince !== null) { activeMs += Math.max(0, at - activeSince); activeSince = null } }
  for (const e of events) {
    const at = time(e.at)
    if (typeof e.seq === 'number') lastSeq = e.seq
    if (at) lastAt = at
    switch (e.type) {
      case 'created': if (!stateSince && at) stateSince = at; break
      case 'runner_started': lockHeldBy = null; if (at) { close(at); activeSince = at } break
      case 'test_lock_wait': close(at); lockHeldBy = str(e.heldBy) || '?'; if (at) lockSince = at; break
      case 'test_lock_acquired': lockHeldBy = null; if (at && state === 'running' && activeSince === null) activeSince = at; break
      case 'state':
        state = str(e.state) || state; reason = str(e.reason)
        if (at) stateSince = at
        stateSeq = typeof e.seq === 'number' ? e.seq : stateSeq
        pendingStop = null; humanStop = null // the stop is on disk now
        if (state !== 'running') { close(at); lockHeldBy = null }
        break
      case 'decide_processed': {
        const a = actions.get(str(e.actionId)); if (a) a.open = false
        if (e.ok === true) {
          rejectedDecides = 0
          const plan = record(e.plan)
          const list = Array.isArray(plan?.steps) ? plan.steps.map(record) : []
          list.forEach((s, i) => { if (s && str(s.id)) steps.set(str(s.id), { index: i + 1, count: list.length, title: str(s.title) }) })
          const stop = record(e.stop)
          if (stop) pendingStop = { state: str(stop.state) || 'waiting_human', reason: str(stop.reason) }
        } else if (a?.outcome && a.outcome.ok !== true) fail(str(a.outcome.failureClass) || 'process_failed')
        else rejectedDecides += 1
        break
      }
      case 'action_intent': {
        const spec = record(e.action)
        const id = str(spec?.actionId)
        if (id) actions.set(id, { kind: str(spec?.kind), stepId: str(spec?.stepId), at, open: true })
        break
      }
      case 'action_started': { const a = actions.get(str(e.actionId)); if (a) a.at = time(record(e.job)?.startedAt) || at || a.at; break }
      case 'action_result': { const a = actions.get(str(e.actionId)); if (a) { a.open = false; a.outcome = record(e.outcome) ?? {} } break }
      case 'action_abandoned': { const a = actions.get(str(e.actionId)); if (a) a.open = false; break }
      case 'step_checked':
        if (e.passed === true) streak = { failureClass: null, count: 0 }
        else fail(str(e.failureClass) || 'check_failed')
        break
      case 'acceptance': if (e.passed !== true) acceptanceFailures += 1; break
      // The same check is recorded twice (spawned, then its identity): keep when it began.
      case 'check_started': if (!check || check.pid !== e.pid) check = { kind: str(e.kind), pid: e.pid, at: at || lastAt }; break
      case 'check_finished': check = null; break
    }
    // Since when the journal holds a stop: kept until a state event writes it, cleared when nothing derives one.
    if (!derived()) stoppedAt = null
    else if (!stoppedAt) stoppedAt = { seq: typeof e.seq === 'number' ? e.seq : lastSeq, at: at || lastAt }
  }
  const labels: Record<string, string> = {}
  for (const [id, a] of actions) {
    const step = steps.get(a.stepId)
    labels[id] = a.kind === 'decide' ? 'decide' : step ? clip(`步驟 ${step.index}/${step.count} ${step.title}`, 40) : `步驟 ${a.stepId || id}`
  }
  const terminal = TERMINAL.includes(state)
  /** Which change of state a toast is about (see alertKey). */
  let alertSeq = stateSeq
  // As archive.ts does: a run still `running` with a stop in its journal shows as that stop; active minutes stay open.
  const stop = state === 'running' ? derived() : null
  if (stop && stoppedAt) { state = stop.state; reason = stop.reason; stateSince = stoppedAt.at; alertSeq = stoppedAt.seq }
  let kind: KernelKind, phase: string, phaseSince = stateSince
  if (state === 'running') {
    const open = [...actions].filter(([, a]) => a.open).pop()
    if (!runnerPresent && now - lastAt > KERNEL_RUNNER_GRACE_MS) {
      // runner.json coming and going does not move the journal: keyed on its last event, it is told once.
      kind = 'interrupted'; phase = 'runner 不在，可能中斷了'; phaseSince = lastAt; alertSeq = lastSeq
    }
    else if (lockHeldBy !== null) {
      kind = 'running'; phaseSince = lockSince
      phase = `等測試鎖（${RUN_ID.test(lockHeldBy) ? `kernel ${lockHeldBy.slice(-4)}` : clip(lockHeldBy, 16)}）`
    } else if (check) { kind = 'running'; phase = CHECKS[check.kind] ?? check.kind; phaseSince = check.at }
    else if (open) { kind = 'running'; phase = labels[open[0]] ?? open[0]; phaseSince = open[1].at }
    else { kind = 'running'; phase = 'kernel 判定中'; phaseSince = lastAt }
  } else if (state === 'awaiting_approval') {
    kind = expires && now > expires ? 'expired' : 'approval'
    phase = kind === 'expired' ? '委任書已失效，沒核准' : expires ? `委任書待核准，${until(expires - now)}後失效` : '委任書待核准'
  } else if (PAUSED.includes(state)) { kind = 'human'; phase = reasonText(reason) || state }
  else if (state === 'completed') { kind = 'done'; phase = reasonText(reason) || '完成' }
  else if (state === 'failed') { kind = 'failed'; phase = reasonText(reason) || '失敗' }
  else if (state === 'budget_exhausted') { kind = 'budget'; phase = reasonText(reason) || '預算用完' }
  else if (state === 'cancelled') { kind = 'cancelled'; phase = '已取消' }
  else { kind = 'unreadable'; phase = `不認識的狀態 ${clip(state, 16)}` }
  return {
    runId, short: runId.slice(-4), project: projectDir ? baseName(projectDir) : '', projectDir, state, reason, kind, phase,
    phaseSince, stateSince, stateSeq, alertSeq, terminal, lastSeq, lastAt, activeMs, activeSince,
    wallMinutes: typeof wall === 'number' && wall > 0 ? wall : null, expiresAt: expires || null, labels,
  }
}
function until(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m >= 120 ? `${Math.floor(m / 60)} 小時` : `${m} 分`
}

/** A run whose files cannot be read still gets a row, so a broken run is seen rather than silently dropped. */
export function unreadableRun(runId: string, why: string, at: number): KernelRunSummary {
  return {
    runId, short: runId.slice(-4), project: '', projectDir: '', state: '', reason: '', kind: 'unreadable', phase: `讀不到狀態：${clip(why, 40)}`,
    phaseSince: at, stateSince: at, stateSeq: 0, alertSeq: 0, terminal: false, lastSeq: 0, lastAt: at, activeMs: 0, activeSince: null, wallMinutes: null, expiresAt: null, labels: {},
  }
}

/**
 * Whether the panel shows a run. Unfinished ones always do; finished ones (and a lapsed contract, and one that
 * cannot be read) for KERNEL_RECENT_MS. A run archived at its current journal seq is handled: gone at once.
 * `archivedSeq` is archived.json's journalSeq; a run with newer events than that is shown again, as the kernel does.
 */
export function kernelVisible(run: KernelRunSummary, now: number, archivedSeq?: number): boolean {
  if (run.kind === 'cancelled') return false
  if (archivedSeq !== undefined && archivedSeq === run.lastSeq && run.kind !== 'unreadable') return false
  if (run.kind === 'running' || run.kind === 'approval' || run.kind === 'human' || run.kind === 'interrupted') return true
  const since = run.kind === 'expired' ? run.expiresAt ?? run.stateSince : run.stateSince
  return now - since <= KERNEL_RECENT_MS
}

/** Runs whose state moved to one the person must act on, that the panel should tell about once. */
export const ALERT_KINDS: readonly KernelKind[] = ['approval', 'human', 'done', 'failed', 'budget', 'interrupted', 'expired']
export const alertKey = (run: KernelRunSummary) => `${run.runId}#${run.alertSeq}#${run.kind}`
export function alertText(run: KernelRunSummary): string {
  const name = `ai-cli kernel ${run.short}${run.project ? `［${run.project}］` : ''}`
  const what = { approval: '等你核准', human: '等你處理', done: '完成待審', failed: '失敗', budget: '預算用完', interrupted: '中斷', expired: '過期' }[run.kind as 'approval'] ?? run.kind
  const hint = run.kind === 'approval' ? `ai-cli kernel status ${run.runId}` : run.kind === 'done' ? `ai-cli kernel result ${run.runId}` : `ai-cli kernel status ${run.runId}`
  return `${name} ${what}：${run.phase}。${hint}`
}

export const KERNEL_STATUS: Record<KernelKind, string> = {
  running: '執行中', approval: '✋ 等你核准', human: '✋ 等你處理', done: '📦 完成待審', failed: '❌ 失敗', budget: '⛽ 預算用完',
  interrupted: '❔ 中斷', expired: '⌛ 已失效', unreadable: '⚠ 讀不到', cancelled: '已取消',
}

export type KernelRow = { key: string, kind: KernelKind, status: string, run: string, phase: string, since: string, total: string }
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const agoText = (ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  return m < 1 ? '剛剛' : m < 120 ? `${m} 分前` : `${Math.floor(m / 60)} 小時前`
}
export function activeMinutes(run: KernelRunSummary, now: number): number {
  return (run.activeMs + (run.activeSince === null ? 0 : Math.max(0, now - run.activeSince))) / 60_000
}

/**
 * The run rows: the ones waiting for the person first (they are what the panel is for), then running ones, then
 * finished ones, newest first; at most KERNEL_MAX_ROWS, and how many more there are.
 */
export function kernelRows(runs: KernelRunSummary[], now: number, archived: Record<string, number> = {}): { rows: KernelRow[], more: number, running: number, attention: number } {
  const shown = runs.filter(r => kernelVisible(r, now, archived[r.runId]))
  const rank = (r: KernelRunSummary) => r.kind === 'approval' || r.kind === 'human' || r.kind === 'interrupted' ? 0 : r.kind === 'running' ? 1 : 2
  shown.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? a.phaseSince - b.phaseSince : b.stateSince - a.stateSince))
  const rows = shown.slice(0, KERNEL_MAX_ROWS).map(r => {
    const used = Math.round(activeMinutes(r, now))
    const live = r.kind === 'running'
    return {
      key: `kernel-${r.runId}`, kind: r.kind, status: KERNEL_STATUS[r.kind],
      run: [r.short, r.project].filter(Boolean).join(' '), phase: r.phase,
      since: live ? mmss(now - r.phaseSince) : agoText(now - (r.kind === 'interrupted' ? r.phaseSince : r.stateSince)),
      total: r.wallMinutes ? `${used}/${r.wallMinutes} 分` : r.kind === 'unreadable' ? '' : `${used} 分`,
    }
  })
  const running = shown.filter(r => r.kind === 'running').length
  return { rows, more: shown.length - rows.length, running, attention: shown.length - running }
}

/** The kernel part of a summary line: '' when no run is shown. */
export function kernelCounts(running: number, attention: number): string {
  return [running ? `kernel 執行中 ${running}` : '', attention ? `待你看 ${attention}` : ''].filter(Boolean).join(' · ')
}

/**
 * A job's task and project when its prompt carries the marker of a run the panel has read; undefined for any other
 * job, including one whose prompt merely looks like a marker of a run that is not there.
 */
export function kernelJobLabel(task: string, runs: KernelRunSummary[]): { task: string, project: string } | undefined {
  const mark = kernelMarker(task)
  if (!mark) return undefined
  if ('probe' in mark) return { task: 'kernel 權限邊界探針', project: '' }
  const run = runs.find(r => r.runId === mark.runId)
  if (!run) return undefined
  return { task: `kernel ${run.short} · ${run.labels[mark.actionId] ?? mark.actionId}`, project: run.project }
}
