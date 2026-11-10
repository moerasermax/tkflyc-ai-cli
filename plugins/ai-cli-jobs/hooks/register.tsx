import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, Timer } from 'claude-code'
import type { AiCliJobsJob, AiCliJobsMachineJob } from '../types/index'
import { ALERT_KINDS, KERNEL_RECENT_MS, RUN_ID, alertKey, alertText, kernelCounts, kernelJobLabel, kernelRows, kernelVisible, parseJournal, summarizeKernelRun, unreadableRun } from './kernel'
import type { KernelRow, KernelRunSummary } from './kernel'

const jobs = atom({ plugin: 'ai-cli-jobs', key: 'jobs' } as const, [])
/** Every session's jobs, read from the job store on disk: `list_processes` only answers for this server. */
const machine = atom({ plugin: 'ai-cli-jobs', key: 'machine' } as const, [])
/** kernel runs, read from <state dir>/kernel/runs on the same SCAN_MS timer. */
const kernel = atom({ plugin: 'ai-cli-jobs', key: 'kernel' } as const, [])
const kernelArchived = atom({ plugin: 'ai-cli-jobs', key: 'kernelArchived' } as const, {})
/** How long a kernel toast stays: longer than the default 4 s, it is the one nudge the run gets. */
export const KERNEL_TOAST_MS = 15_000
const RETAIN_MS = 120_000
export const SCAN_MS = 5_000
/** A finished job from elsewhere stays this long; the server deletes its folder after 30 minutes. */
export const RECENT_MS = 10 * 60_000
/** A running job whose stdout has not moved for this long gets the 💤 note. */
export const QUIET_MS = 5 * 60_000
export const POLL_MS = 500
/** A list_processes call that has not answered by then is abandoned, so it cannot hold `busy` forever. */
export const CALL_TIMEOUT_MS = 10_000
const COLORS = {
  list: '#E8DCB5',
  running: '#A8D5CE',
  completed: '#DDE6A3',
  failed: '#F4BE86',
  /** A kernel run that waits for the person. */
  attention: '#D9C4DC',
  text: '#1A1A1A',
} as const
const KERNEL_BACKGROUND: Record<KernelRow['kind'], string> = {
  running: COLORS.running, approval: COLORS.attention, human: COLORS.attention, interrupted: COLORS.attention, expired: COLORS.attention,
  done: COLORS.completed, failed: COLORS.failed, budget: COLORS.failed, unreadable: COLORS.failed, cancelled: COLORS.list,
}
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
const str = (v: unknown) => typeof v === 'string' ? v : ''
const clip = (v: string, n: number) => Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, n).join('')

/** Decode core result wrappers and MCP structured/JSON text results. */
export function payload(v: unknown): unknown {
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return v }
  }
  const r = record(v)
  if (!r) return v
  if (r.structuredContent !== undefined) return payload(r.structuredContent)
  if (Array.isArray(r.content)) {
    const texts = r.content.map(b => str(record(b)?.text)).filter(Boolean)
    if (texts.length) return payload(texts.join('\n'))
  }
  if (r.result !== undefined) return payload(r.result)
  return v
}
export function runPid(v: unknown): number | undefined {
  const p = payload(v)
  const value = record(p)?.pid
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) :
    typeof p === 'string' ? Number(p.match(/\bpid\b\s*[:=]\s*(\d+)/i)?.[1]) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}
export function inferAgent(model: string): string {
  const name = model.trim().toLowerCase()
  if (/^(?:gpt-|codex-)/.test(name)) return 'codex'
  if (/^(?:gemini-|agy)/.test(name)) return 'antigravity'
  if (/^grok(?:-|$)/.test(name)) return 'grok'
  if (name.includes('/')) return 'direct-api'
  if (/^(?:claude|fable|sonnet|opus|haiku)(?:-|$)/.test(name)) return 'claude'
  if (/^[^-\s]+-.+/.test(name)) return 'direct-api'
  return 'claude'
}
export function taskLabel(input: Record<string, unknown>): string {
  if (str(input.prompt_file)) return clip(str(input.prompt_file).split(/[\\/]/).pop() || '任務檔案', 40)
  let identity = false
  for (const raw of str(input.prompt).split(/\r?\n/)) {
    const line = raw.trim()
    if (/^(?:#+\s*)?【(?:身分|身份|角色)】/.test(line)) { identity = true; continue }
    if (identity) {
      if (!line) { identity = false; continue }
      if (!/^#+\s|^(?:任務|目標)[：:]/.test(line)) continue
      identity = false
    }
    if (!line || /^不要呼叫|^本節權威|^你收到這份/.test(line)) continue
    return clip(line.replace(/^#+\s*/, '').replace(/^【任務】\s*/, '').replace(/^任務[：:]\s*/, ''), 40)
  }
  return 'ai-cli 任務'
}
export function summary(list: AiCliJobsJob[], othersRunning = 0, kernelPart = ''): string {
  const labels = [['running', '執行中'], ['completed', '完成'], ['failed', '失敗'], ['untracked', '已不追蹤']] as const
  return 'ai-cli ▸ ' + [...labels.map(([status, label]) => {
    const n = list.filter(j => j.status === status).length
    return n ? `${n} ${label}` : ''
  }), othersRunning ? `其他 ${othersRunning} 執行中` : '', kernelPart].filter(Boolean).join(' · ')
}
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  return m < 1 ? '剛剛' : `${m} 分前`
}
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/**
 * Folds one job folder of the store into a row. `endMtime` stands in when the end record carries no endTime.
 * The fields are the server's own (src/core/job-store.ts): change them there and this reader goes blind.
 */
export function machineJob(jobId: string, meta: unknown, exit: unknown, lost: unknown,
  outputAt: number | undefined, here: string, endMtime?: number): AiCliJobsMachineJob | undefined {
  const m = record(meta)
  if (!m) return undefined
  const model = str(m.resolvedModel) || str(m.model) || str(m.agent) || 'default'
  const folder = str(m.projectDir) || str(m.workFolder)
  const p = norm(folder), h = norm(here)
  const project = p && h && p !== h && !h.startsWith(p + '/') ? folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder : ''
  const x = record(exit), l = record(lost)
  const status: AiCliJobsMachineJob['status'] = x ? (x.exitCode === 0 && x.killed !== true && x.timedOut !== true ? 'ok' : 'bad') : l ? 'lost' : 'running'
  const end = x ?? l
  return {
    jobId, pid: typeof m.pid === 'number' ? m.pid : undefined, agent: str(m.agent) || inferAgent(model), model,
    effort: str(m.effort), task: taskLabel({ prompt: str(m.task) }), project, status,
    startedAt: Date.parse(str(m.startTime)) || 0, outputAt,
    ...(end ? { endedAt: Date.parse(str(end.endTime)) || endMtime || 0 } : {}),
  }
}
const DOTS: Record<string, string> = { claude: '🟠', codex: '🟢', grok: '⚫', antigravity: '🔵', 'direct-api': '🟣' }
type Row = { key: string, kind: 'running' | 'ok' | 'bad' | 'lost' | 'gone', model: string, source: string, task: string, time: string, wrap: boolean }
/** This session's rows first, then everyone else's; running before finished, the newest finish first. */
/** `runs` names the jobs a kernel run dispatched: its step instead of the prompt's head, its repo instead of `wt`. */
export function tableRows(own: AiCliJobsJob[], others: AiCliJobsMachineJob[], now: number, runs: KernelRunSummary[] = []): Row[] {
  const modelText = (agent: string, model: string, effort: string) => `${DOTS[agent] ?? '⚪'} ${model}${effort ? `·${effort}` : ''}`
  const mine = new Set(own.map(j => j.pid))
  const rows: (Row & { at: number })[] = own.map(j => {
    const kind = j.status === 'running' ? 'running' : j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'bad' : 'gone'
    const seconds = kind === 'running' ? Math.max(j.elapsedSec, (now - j.startedAt) / 1000) : j.elapsedSec
    const poll = isPollFailure(j.lastEvent)
    const note = poll ? j.lastEvent : eventLabel(j.lastEvent)
    const k = kernelJobLabel(j.task, runs)
    return {
      key: `own-${j.pid}`, kind, model: modelText(j.agent, j.model, j.reasoningEffort), source: '這個對話',
      task: [k ? [k.project ? `［${k.project}］` : '', k.task].filter(Boolean).join(' ') : j.task, note].filter(Boolean).join('  ·  '), wrap: poll, at: j.finishedAt ?? now,
      time: kind === 'running' ? `已跑 ${elapsed(seconds)}` : ago(now - (j.finishedAt ?? now)),
    }
  })
  for (const j of others) {
    if (j.pid !== undefined && mine.has(j.pid)) continue
    const quiet = j.status === 'running' && j.outputAt !== undefined && now - j.outputAt > QUIET_MS
      ? `💤 ${Math.floor((now - j.outputAt) / 60_000)} 分沒輸出` : ''
    const k = kernelJobLabel(j.task, runs)
    const project = k ? k.project : j.project
    rows.push({
      key: `job-${j.jobId}`, kind: j.status, model: modelText(j.agent, j.model, j.effort), source: k ? 'kernel' : j.project ? '其他專案' : '同專案',
      task: [project ? `［${project}］` : '', k ? k.task : j.task, quiet].filter(Boolean).join(' '), wrap: false, at: j.endedAt ?? now,
      time: j.status === 'running' ? `已跑 ${elapsed((now - j.startedAt) / 1000)}` : ago(now - (j.endedAt ?? now)),
    })
  }
  const order = (r: Row & { at: number }) => r.kind === 'running' ? 0 : 1
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => order(a.r) - order(b.r) || (order(a.r) ? b.r.at - a.r.at : a.i - b.i))
    .map(({ r: { at, ...row } }) => row)
}
export function eventLabel(text: string): string {
  return clip(text.replace(/^(?:item|turn|thread)\.[\w.-]+\s+/g, ''), 28)
}
/**
 * The engine's two `$.mcp.call` failures each have one fix the user can apply right away; spell it out
 * instead of the raw text, which the 28-column event label used to cut down to "ai-cli-jobs: $.mcp.call".
 */
export function failureText(why: string): string {
  // auto mode's background refusal is the usual cause, but a hook or a declined ask refuses the same way, so keep its reason.
  const refused = why.match(/\$\.mcp\.call\([^)]*\) refused:?\s*(.*)$/s)
  if (refused) return `輪詢被拒：把 mcp__ai-cli__list_processes 加進 permissions.allow（原因：${clip(refused[1] ?? '', 40) || '未提供'}）`
  // A permissions.deny rule drops the tool from the session, so it lands here, not as a refusal (Claude Code 2.1.296).
  if (/no connected MCP tool\b/.test(why)) return '輪詢失敗：找不到 mcp__ai-cli__list_processes：ai-cli 未連線（用 /mcp 重連，server 名稱須為 ai-cli），或被 permissions.deny 擋下'
  return `輪詢失敗：${clip(why, 80) || '未知錯誤'}`
}
/** Poll failures are our own bounded text and must be read in full; vendor events keep the short label. */
const isPollFailure = (text: string) => /^輪詢(?:失敗|被拒)：/.test(text)
export function elapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Folds one list_processes row into a job, the same way for jobs dispatched here and jobs adopted from elsewhere. */
function applyRow(j: AiCliJobsJob, row: Record<string, unknown>, now: number): AiCliJobsJob {
  const rawStatus = str(row.status)
  const isKnownStatus = ['running', 'completed', 'failed'].includes(rawStatus)
  const status: AiCliJobsJob['status'] = rawStatus === 'running' ? 'running' : rawStatus === 'completed' ? 'completed' : 'failed'
  return {
    ...j, status, agent: str(row.agent) || j.agent,
    elapsedSec: typeof row.elapsedSec === 'number' && Number.isFinite(row.elapsedSec) ? row.elapsedSec : (now - j.startedAt) / 1000,
    sinceLastOutputSec: typeof row.sinceLastOutputSec === 'number' ? row.sinceLastOutputSec : undefined,
    lastEvent: isKnownStatus ? str(row.lastEvent) : [rawStatus, str(row.lastEvent)].filter(Boolean).join(' '),
    ...(status === 'running' ? {} : { finishedAt: now }),
  }
}
export const ADOPTED_TASK = '接管自前一個 session'
/**
 * The server adopts a same-project job once the MCP is ready and on each 60 s GC pass, and the MCP may connect late
 * or another session may end later. On Windows the adoption landed 7–11 s after claude.exe started (three restarts),
 * so a single look at 5 s always came too early and the job only showed a minute later: look every 5 s for the first
 * 30 s, then once a minute while idle; while anything is running the regular poll sees them too.
 */
export const DISCOVER_EARLY_MS = [5_000, 10_000, 15_000, 20_000, 25_000, 30_000]
export const DISCOVER_EVERY_MS = 60_000

  let poll: Timer | undefined
  let expiry: Timer | undefined
  let discovery: Timer[] = []
  let scanner: Timer | undefined
  let busy = false
  let scanning = false
  let generation = 0
  /** Adopted jobs already shown once, so one that was pruned is not brought back while the server still lists it. */
  const seen = new Set<string>()
  /** meta.json never changes once written, so each job's is read once. */
  const metas = new Map<string, unknown>()
  function stop() {
    poll?.cancel(); expiry?.cancel(); scanner?.cancel(); for (const t of discovery) t.cancel()
    poll = undefined; expiry = undefined; scanner = undefined; discovery = []
  }
  const readJson = ($: EngineInterface, path: string) => $.fs.read(path).then(t => JSON.parse(t) as unknown, () => undefined)
  /** src/core/live-jobs.ts jobStateDir: AI_CLI_STATE_DIR, else ~/.local/state/ai-cli. */
  async function stateDir($: EngineInterface) {
    const dir = await $.env.get('AI_CLI_STATE_DIR')
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    return dir || `${home}/.local/state/ai-cli`
  }
  let kernelScanning = false
  /** First kernel scan of a session: what is already waiting is drawn, not toasted. */
  let kernelBaseline = true
  /** Toasts already shown, by run, state event and kind: each change of state is told once. */
  const alerted = new Set<string>()
  /**
   * Per run: the parsed journal, keyed by its size and mtime so an unchanged one is not read again; the contract,
   * which never changes once written; archived.json's seq. `settled` runs (finished and out of sight) are not listed again.
   */
  const runCache = new Map<string, { journalKey?: string, events?: Record<string, unknown>[], error?: string, contract?: unknown, archivedKey?: string, archivedSeq?: number, settled?: boolean }>()
  /** Reads <state dir>/kernel/runs (src/ai-cli_kernel/journal.ts kernelRunsDir) with $.fs only: no ai-cli, no node. */
  async function scanKernel($: EngineInterface) {
    if (kernelScanning) return
    kernelScanning = true
    const epoch = generation
    try {
      const root = `${await stateDir($)}/kernel/runs`
      const now = await $.clock.now()
      // A listing that fails tells nothing: keep the last tick's rows and baseline, or the next good tick would toast
      // every run already waiting as if it had just changed. (No folder yet, before any run, fails the same way.)
      const folders = await $.fs.list(root).catch(() => undefined)
      if (!folders) return
      const found: KernelRunSummary[] = []
      const archived: Record<string, number> = {}
      for (const folder of folders) {
        if (folder.kind !== 'dir' || !RUN_ID.test(folder.name)) continue
        const cached = runCache.get(folder.name) ?? {}
        if (cached.settled) continue
        runCache.set(folder.name, cached)
        const path = `${root}/${folder.name}`
        const files = await $.fs.list(path).catch((err: unknown) => err instanceof Error ? err : new Error(String(err)))
        // A run folder that cannot be listed gets a row saying so instead of silently dropping out.
        if (files instanceof Error) { found.push(unreadableRun(folder.name, `讀不到 run 目錄（${files.message}）`, now)); continue }
        const file = (name: string) => files.find(f => f.name === name)
        const journal = file('journal.jsonl'), archive = file('archived.json')
        // Handed over (archived) or judged (verdict.json) long ago: settled without reading a byte of it.
        if (journal && now - journal.mtimeMs > KERNEL_RECENT_MS && (archive || file('verdict.json')) && !cached.events) { cached.settled = true; continue }
        let run: KernelRunSummary
        try {
          if (!journal) throw new Error('沒有 journal.jsonl')
          const key = `${journal.size}:${journal.mtimeMs}`
          // A broken or oversized journal is not read again until it changes.
          if (cached.journalKey === key && cached.error) throw new Error(cached.error)
          if (cached.journalKey !== key || !cached.events) {
            cached.journalKey = key; cached.events = undefined; cached.error = undefined
            try { cached.events = parseJournal(await $.fs.read(`${path}/journal.jsonl`)) }
            catch (err) { cached.error = err instanceof Error ? err.message : String(err); throw err }
          }
          if (cached.contract === undefined) {
            const contract = await readJson($, `${path}/contract.json`)
            if (contract === undefined) throw new Error('讀不到 contract.json')
            cached.contract = contract
          }
          run = summarizeKernelRun(folder.name, cached.contract, cached.events, !!file('runner.json'), now)
        } catch (err) {
          run = unreadableRun(folder.name, err instanceof Error ? err.message : String(err), journal?.mtimeMs || now)
        }
        if (archive) {
          const key = `${archive.size}:${archive.mtimeMs}`
          if (cached.archivedKey !== key) {
            const seq = (await readJson($, `${path}/archived.json`) as { journalSeq?: unknown } | undefined)?.journalSeq
            cached.archivedSeq = typeof seq === 'number' ? seq : undefined
            cached.archivedKey = key
          }
          if (cached.archivedSeq !== undefined) archived[folder.name] = cached.archivedSeq
        }
        const visible = kernelVisible(run, now, archived[folder.name])
        // Settled for good once its journal's own state is terminal and the row is out of sight: such a run can no
        // longer be approved (src/ai-cli_kernel/api.ts:311 refuses a terminal state) and verdict.json is written only on
        // delivery (src/ai-cli_kernel/loop.ts:628), so it never waits for the person again. A stop that is only derived
        // from the journal (state still `running`) is not terminal and keeps being read.
        if (!visible && run.terminal) { runCache.set(folder.name, { settled: true }); continue }
        found.push(run)
      }
      for (const key of runCache.keys()) if (!folders.some(f => f.name === key)) runCache.delete(key)
      if (epoch !== generation) return
      for (const run of found) {
        if (!ALERT_KINDS.includes(run.kind) || !kernelVisible(run, now, archived[run.runId])) continue
        const key = alertKey(run)
        if (alerted.has(key)) continue
        alerted.add(key)
        if (!kernelBaseline) $.ui.toast(alertText(run), { timeoutMs: KERNEL_TOAST_MS })
      }
      kernelBaseline = false
      await update($, kernel, () => found)
      await update($, kernelArchived, () => archived)
    } catch {
      // A kernel folder that cannot be listed shows no runs; the job rows are not affected.
    } finally {
      kernelScanning = false
    }
  }
  /** Reads the job store the server writes (src/core/live-jobs.ts jobStateDir): no MCP, so other sessions' jobs show too. */
  async function scan($: EngineInterface) {
    if (scanning) return
    scanning = true
    const epoch = generation
    try {
      const root = `${await stateDir($)}/jobs`
      const here = await $.session.root()
      const now = await $.clock.now()
      const folders = await $.fs.list(root).catch(() => [])
      const found: AiCliJobsMachineJob[] = []
      for (const folder of folders) {
        if (folder.kind !== 'dir') continue
        const path = `${root}/${folder.name}`
        const files = await $.fs.list(path).catch(() => undefined)
        if (!files) continue
        const file = (name: string) => files.find(f => f.name === name)
        const exitFile = file('exit.json'), lostFile = file('lost.json')
        const endFile = exitFile ?? lostFile
        // Finished long ago: skip the reads; the server deletes the folder later.
        if (endFile && now - endFile.mtimeMs > RECENT_MS) continue
        if (!metas.has(folder.name)) {
          const meta = await readJson($, `${path}/meta.json`)
          if (meta === undefined) continue
          metas.set(folder.name, meta)
        }
        const exit = exitFile ? await readJson($, `${path}/exit.json`) : undefined
        const lost = !exitFile && lostFile ? await readJson($, `${path}/lost.json`) : undefined
        const job = machineJob(folder.name, metas.get(folder.name), exit, lost, file('stdout.log')?.mtimeMs || undefined, here, endFile?.mtimeMs)
        if (job && (job.status === 'running' || now - (job.endedAt ?? 0) <= RECENT_MS)) found.push(job)
      }
      for (const key of metas.keys()) if (!folders.some(f => f.name === key)) metas.delete(key)
      if (epoch === generation) await update($, machine, () => found)
    } catch {
      // A store that cannot be read shows nothing from elsewhere; this session's own rows still come from MCP.
    } finally {
      scanning = false
    }
  }
  async function synchronize($: EngineInterface) {
    const held = await read($, jobs)
    if (held.some(j => j.status === 'running')) {
      if (!poll) poll = $.clock.every(POLL_MS, () => { void refresh($) })
    } else { poll?.cancel(); poll = undefined }
    expiry?.cancel(); expiry = undefined
    const ends = held.filter(j => j.finishedAt !== undefined).map(j => j.finishedAt! + RETAIN_MS)
    if (ends.length) {
      const now = await $.clock.now()
      expiry = $.clock.after(Math.max(1, Math.min(...ends) - now), () => { void prune($) })
    }
  }
  async function prune($: EngineInterface) {
    const now = await $.clock.now()
    await update($, jobs, list => list.filter(j => j.finishedAt === undefined || now - j.finishedAt < RETAIN_MS))
    await synchronize($)
  }
  function withTimeout<T>($: EngineInterface, call: Promise<T>): Promise<T> {
    let timer: Timer | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = $.clock.after(CALL_TIMEOUT_MS, () => reject(new Error(`逾時 ${CALL_TIMEOUT_MS / 1000}s`)))
    })
    return Promise.race([call, expired]).finally(() => timer?.cancel())
  }
  /** Keeps the tracked jobs running but shows why this poll told us nothing. */
  async function noteFailure($: EngineInterface, tracked: Set<number>, why: string) {
    const lastEvent = failureText(why)
    await update($, jobs, list => list.map(j => j.status === 'running' && tracked.has(j.pid) ? { ...j, lastEvent } : j))
  }
  async function refresh($: EngineInterface) {
    if (busy) return
    busy = true
    const epoch = generation
    let tracked = new Set<number>()
    try {
      const before = await read($, jobs)
      tracked = new Set(before.filter(j => j.status === 'running').map(j => j.pid))
      const result = await withTimeout($, $.mcp.call('ai-cli', 'list_processes', {}))
      if (epoch !== generation) return
      // Connection errors/malformed results do not prove a job disappeared.
      if (result.isError) {
        const text = (Array.isArray(result.content) ? result.content : []).map(b => str(record(b)?.text)).join(' ')
        return await noteFailure($, tracked, text || 'MCP 回傳錯誤')
      }
      const p = payload(result)
      const r = record(p)
      const rows = Array.isArray(p) ? p : r?.processes ?? r?.jobs
      if (!Array.isArray(rows)) return await noteFailure($, tracked, '回傳格式無法解析')
      const entries = rows.map(record).filter((v): v is Record<string, unknown> => !!v && runPid(v) !== undefined)
      const now = await $.clock.now()
      // The updater stays pure (it may run again); what it saw is recorded in `adopted` and applied after.
      let adopted: string[] = []
      await update($, jobs, list => {
        adopted = []
        if (epoch !== generation) return list
        const next = list.map(j => {
          if (j.status !== 'running' || !tracked.has(j.pid)) return j
          const row = entries.find(v => runPid(v) === j.pid)
          if (!row) return { ...j, status: 'untracked' as const, lastEvent: '已不追蹤', finishedAt: now }
          return applyRow(j, row, now)
        })
        // A job the server adopted from an ended session never passed through this session's run hook.
        for (const row of entries) {
          const key = str(row.jobId)
          if (row.adopted !== true || !key || seen.has(key)) continue
          // Seen even when already held (a resumed session keeps its rows), so a pruned row never comes back.
          adopted.push(key)
          const pid = runPid(row)!
          if (next.some(j => j.pid === pid)) continue
          const elapsedSec = typeof row.elapsedSec === 'number' && Number.isFinite(row.elapsedSec) ? row.elapsedSec : 0
          next.push(applyRow({
            pid, agent: str(row.agent) || 'ai-cli', model: str(row.model) || 'default', reasoningEffort: '',
            task: ADOPTED_TASK, startedAt: now - elapsedSec * 1000, status: 'running', elapsedSec, lastEvent: '',
          }, row, now))
        }
        return next
      })
      for (const key of adopted) seen.add(key)
    } catch (err) {
      // Retry next tick while retaining the last known state, but say why.
      if (epoch === generation) await noteFailure($, tracked, err instanceof Error ? err.message : String(err)).catch(() => {})
    } finally {
      busy = false
      if (epoch === generation) await synchronize($)
    }
  }
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const epoch = generation
    await prune($)
    for (const t of discovery) t.cancel()
    scanner?.cancel(); scanner = undefined
    discovery = epoch !== generation ? [] : [
      ...DISCOVER_EARLY_MS.map(ms => $.clock.after(ms, () => { void refresh($) })),
      $.clock.every(DISCOVER_EVERY_MS, () => { void refresh($) }),
    ]
    if (epoch === generation) {
      kernelBaseline = true
      scanner = $.clock.every(SCAN_MS, () => { void scan($); void scanKernel($) })
      void scan($); void scanKernel($)
    }
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    // `seen` outlives the session: /clear ends it with no new start, and the server keeps listing adopted jobs.
    generation++; stop()
    await update($, jobs, () => [])
    await update($, machine, () => [])
    await update($, kernel, () => [])
    await update($, kernelArchived, () => ({}))
    return next(e)
  })
  on('tool.call', { tool: 'mcp__ai-cli__run' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    const pid = runPid(result.result) ?? runPid(result.text)
    if (pid === undefined) return result
    const input = e as Record<string, unknown>
    const job: AiCliJobsJob = {
      pid, agent: inferAgent(str(input.model)), model: str(input.model) || 'default',
      reasoningEffort: str(input.reasoning_effort), task: taskLabel(input),
      startedAt, status: 'running', elapsedSec: 0, lastEvent: '',
    }
    await update($, jobs, list => [...list.filter(j => j.pid !== pid), job])
    await synchronize($)
    return result
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const runs = await read($, kernel)
    const rows = tableRows(await read($, jobs), await read($, machine), now, runs)
    const k = kernelRows(runs, now, await read($, kernelArchived))
    if (e.props.hasSurvey || (!rows.length && !k.rows.length)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const spinner = SPINNER[Math.floor(now / POLL_MS) % SPINNER.length]
    const STATUS = { running: `${spinner} 執行`, ok: '✅ 成功', bad: '❌ 失敗', lost: '❔ 中斷', gone: '➖ 不追蹤' } as const
    const BACKGROUND = { running: COLORS.running, ok: COLORS.completed, bad: COLORS.failed, lost: COLORS.failed, gone: COLORS.failed } as const
    // Fixed cell widths keep the columns lined up whatever the CJK and emoji widths; the task takes what is left.
    const cells = (status: string, source: string, model: string, task: string, time: string, wrap: boolean, bold: boolean) => [
      <Box key="status" width={10} flexShrink={0}><Text color={COLORS.text} bold={bold}>{status}</Text></Box>,
      <Box key="source" width={10} flexShrink={0}><Text color={COLORS.text} bold={bold}>{source}</Text></Box>,
      <Box key="model" width={26} flexShrink={0}><Text color={COLORS.text} bold={bold} wrap="truncate-end">{model}</Text></Box>,
      <Box key="task" flexGrow={1}><Text color={COLORS.text} bold={bold} wrap={wrap ? 'wrap' : 'truncate-end'}>{task}</Text></Box>,
      <Box key="time" width={12} flexShrink={0} justifyContent="flex-end"><Text color={COLORS.text} bold={bold}>{time}</Text></Box>,
    ]
    // The kernel runs' own widths: their states are longer words than a job's, and they are a section of their own.
    const kernelCells = (status: string, run: string, phase: string, since: string, total: string, bold: boolean) => [
      <Box key="status" width={12} flexShrink={0}><Text color={COLORS.text} bold={bold}>{status}</Text></Box>,
      <Box key="run" width={24} flexShrink={0}><Text color={COLORS.text} bold={bold} wrap="truncate-end">{run}</Text></Box>,
      <Box key="phase" flexGrow={1}><Text color={COLORS.text} bold={bold} wrap="truncate-end">{phase}</Text></Box>,
      <Box key="since" width={10} flexShrink={0} justifyContent="flex-end"><Text color={COLORS.text} bold={bold}>{since}</Text></Box>,
      <Box key="total" width={12} flexShrink={0} justifyContent="flex-end"><Text color={COLORS.text} bold={bold}>{total}</Text></Box>,
    ]
    const running = rows.filter(r => r.kind === 'running').length
    const counts = rows.length ? `執行中 ${running} · 剛完成 ${rows.length - running}` : ''
    return <Box flexDirection="column" backgroundColor={COLORS.list} paddingX={1}>
      <Box key="title"><Text color={COLORS.text} bold>{`🤖 ai-cli 背景工作（${[counts, kernelCounts(k.running, k.attention)].filter(Boolean).join(' · ')}）`}</Text></Box>
      {rows.length ? <Box key="head" flexDirection="row">{cells('狀態', '來源', '模型', '任務／專案', '時間', false, false)}</Box> : null}
      {rows.map(r => <Box key={r.key} flexDirection="row" backgroundColor={BACKGROUND[r.kind]}>
        {cells(STATUS[r.kind], r.source, r.model, r.task, r.time, r.wrap, true)}
      </Box>)}
      {k.rows.length ? <Box key="kernel-head" flexDirection="row">{kernelCells('kernel run', 'run／專案', '目前階段', '本階段', '總計／預算', false)}</Box> : null}
      {k.rows.map((r: KernelRow) => <Box key={r.key} flexDirection="row" backgroundColor={KERNEL_BACKGROUND[r.kind]}>
        {kernelCells(r.kind === 'running' ? `${spinner} ${r.status}` : r.status, r.run, r.phase, r.since, r.total, true)}
      </Box>)}
      {k.more ? <Box key="kernel-more"><Text color={COLORS.text}>{`…另有 ${k.more} 個 kernel run，ai-cli kernel status 看全部`}</Text></Box> : null}
    </Box>
  })
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const list = await read($, jobs)
    const mine = new Set(list.map(j => j.pid))
    const others = (await read($, machine)).filter(j => j.status === 'running' && (j.pid === undefined || !mine.has(j.pid))).length
    const k = kernelRows(await read($, kernel), await $.clock.now(), await read($, kernelArchived))
    const kernelPart = kernelCounts(k.running, k.attention)
    if (!list.length && !others && !kernelPart) return next(e)
    return next({ ...e, props: { ...e.props, tail: [e.props.tail, summary(list, others, kernelPart)].filter(Boolean).join(' · ') } })
  })
}
