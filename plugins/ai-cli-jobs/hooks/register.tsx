import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, Timer } from 'claude-code'
import type { AiCliJobsJob } from '../types/index'

const jobs = atom({ plugin: 'ai-cli-jobs', key: 'jobs' } as const, [])
const RETAIN_MS = 120_000
export const POLL_MS = 500
/** A list_processes call that has not answered by then is abandoned, so it cannot hold `busy` forever. */
export const CALL_TIMEOUT_MS = 10_000
const COLORS = {
  list: '#E8DCB5',
  running: '#A8D5CE',
  completed: '#DDE6A3',
  failed: '#F4BE86',
  text: '#1A1A1A',
} as const
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
export function summary(list: AiCliJobsJob[]): string {
  const labels = [['running', '執行中'], ['completed', '完成'], ['failed', '失敗'], ['untracked', '已不追蹤']] as const
  return 'ai-cli ▸ ' + labels.map(([status, label]) => {
    const n = list.filter(j => j.status === status).length
    return n ? `${n} ${label}` : ''
  }).filter(Boolean).join(' · ')
}
export function eventLabel(text: string): string {
  return clip(text.replace(/^(?:item|turn|thread)\.[\w.-]+\s+/g, ''), 28)
}
export function elapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

  let poll: Timer | undefined
  let expiry: Timer | undefined
  let busy = false
  let generation = 0
  function stop() {
    poll?.cancel(); expiry?.cancel()
    poll = undefined; expiry = undefined
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
    const lastEvent = `輪詢失敗：${clip(why, 80) || '未知錯誤'}`
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
      await update($, jobs, list => list.map(j => {
        if (j.status !== 'running' || !tracked.has(j.pid)) return j
        const row = entries.find(v => runPid(v) === j.pid)
        if (!row) return { ...j, status: 'untracked', lastEvent: '已不追蹤', finishedAt: now }
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
      }))
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
    await prune($)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    generation++; stop()
    await update($, jobs, () => [])
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
    const list = await read($, jobs)
    if (e.props.hasSurvey || !list.length) return next(e)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column" backgroundColor={COLORS.list} paddingX={1}>{list.map(j => {
      const glyph = j.status === 'running' ? SPINNER[Math.floor(now / POLL_MS) % SPINNER.length] :
        j.status === 'completed' ? '✓' : j.status === 'failed' ? '✗' : '–'
      const seconds = j.status === 'running' ? Math.max(j.elapsedSec, (now - j.startedAt) / 1000) : j.elapsedSec
      const background = j.status === 'running' ? COLORS.running : j.status === 'completed' ? COLORS.completed : COLORS.failed
      return <Box key={`job-${j.pid}`} backgroundColor={background}>
        <Text color={COLORS.text} bold>{`${glyph} ${j.agent}  ${j.model}${j.reasoningEffort ? ` (${j.reasoningEffort})` : ''}  ${j.task}  ${elapsed(seconds)}  ${eventLabel(j.lastEvent)}`}</Text>
      </Box>
    })}</Box>
  })
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const list = await read($, jobs)
    if (!list.length) return next(e)
    return next({ ...e, props: { ...e.props, tail: [e.props.tail, summary(list)].filter(Boolean).join(' · ') } })
  })
}
