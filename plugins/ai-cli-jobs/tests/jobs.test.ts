import type { AiCliJobsJob } from '../types/index'
import { test, expect, mock } from 'claude-code/testing'
import { taskLabel, runPid, elapsed, eventLabel, failureText, inferAgent, machineJob, ago, tableRows, summary, POLL_MS, CALL_TIMEOUT_MS, ADOPTED_TASK, DISCOVER_EARLY_MS, SCAN_MS, RECENT_MS, QUIET_MS, KERNEL_TOAST_MS } from '../hooks/register'
import { kernelMarker, kernelJobLabel, parseJournal, summarizeKernelRun, unreadableRun, kernelVisible, kernelRows, kernelCounts, activeMinutes, alertText, reasonText, KERNEL_RECENT_MS, KERNEL_MAX_ROWS, KERNEL_RUNNER_GRACE_MS } from '../hooks/kernel'
import type { KernelRunSummary } from '../hooks/kernel'

const tree = (text: string) => ({ type: 'Text' as const, props: {}, children: [text] })
// The engine tags a drawn tree with the plugin that drew it (`part`, Claude Code 2.1.308); compare the tree alone.
const shown = (text: string) => expect.objectContaining(tree(text))
const ref = { plugin: 'ai-cli-jobs', key: 'jobs' } as const
const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('polls every POLL_MS and advances the spinner each tick', async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 500 } }))
  on('mcp.call', () => {
    calls++
    return { value: { isError: false, content: [], structuredContent: [{ pid: 500, status: 'running' }] } }
  })
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'poll-interval', prompt: 'task' })
  await clock.advance(POLL_MS - 1)
  expect(calls).toBe(0)
  await clock.advance(1)
  expect(calls).toBe(1)
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect(await ui.find({ type: 'Text', text: /⠙ 執行/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(POLL_MS - 1)
  expect(calls).toBe(1)
  await clock.advance(1)
  expect(calls).toBe(2)
  const nextUi = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect(await nextUi.find({ type: 'Text', text: /⠹ 執行/ })).toBeDefined()
  await nextUi.unmount()
})

test('band and status rows use Morandi backgrounds and bold dark text on both surfaces', async ($, on) => {
  const clock = mock.clock(on)
  let pid = 300
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: [
    { pid: 300, status: 'running', elapsedSec: 4 },
    { pid: 301, status: 'completed', elapsedSec: 4 },
    { pid: 302, status: 'failed', elapsedSec: 4 },
    { pid: 303, status: 'killed', elapsedSec: 4 },
    // pid 304 disappears and becomes untracked.
  ] } }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || ''))
  for (let n = 0; n < 5; n++) await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'color-' + n, model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.map(b => b.props.backgroundColor).filter(Boolean)).toEqual(['#E8DCB5', '#A8D5CE', '#DDE6A3', '#F4BE86', '#F4BE86', '#F4BE86'])
    expect(boxes[0]?.props.paddingX).toBe(1)
    const texts = await ui.findAll({ type: 'Text' })
    // A title, a header row of 5 column names, then 5 cells per job.
    expect(texts.length).toBe(1 + 5 + 5 * 5)
    expect(texts[0]?.text).toBe('🤖 ai-cli 背景工作（執行中 1 · 剛完成 4）')
    expect(texts.slice(1, 6).map(t => t.text)).toEqual(['狀態', '來源', '模型', '任務／專案', '時間'])
    expect(texts.every(t => t.props.color === '#1A1A1A')).toBe(true)
    expect(texts.filter(t => t.props.bold === true).length).toBe(1 + 5 * 5)
    expect(texts.filter(t => t.text === '❌ 失敗').length).toBe(2)
    expect(await ui.find({ type: 'Text', text: /killed/ })).toBeDefined()
    expect(texts.filter(t => t.text === '➖ 不追蹤').length).toBe(1)
    await ui.unmount()
    // The tail stays plain text with no background or foreground styles.
    expect(await $.ui.render({ surface, component: 'PromptHint', requestId: 'color-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(shown('ai-cli ▸ 1 執行中 · 1 完成 · 2 失敗 · 1 已不追蹤'))
  }
})

test('extracts task labels and pid from MCP results', async () => {
  expect(taskLabel({ prompt: '【身分】worker\n不要呼叫任何派工工具\n本節權威優先\n\n# 任務：修驗收工具判定 bug\n詳細說明' })).toBe('修驗收工具判定 bug')
  expect(taskLabel({ prompt_file: 'C:\\tasks\\review.md' })).toBe('review.md')
  expect(taskLabel({ prompt: '長'.repeat(55) }).length).toBe(40)
  expect(runPid({ content: [{ type: 'text', text: '{"pid":123}' }] })).toBe(123)
  expect(runPid({ structuredContent: { pid: 456 } })).toBe(456)
  expect(runPid('pid: 789')).toBe(789)
  expect(runPid({ pid: -1 })).toBeUndefined()
  expect(elapsed(62)).toBe('1:02')
  expect(eventLabel('item.completed file_change')).toBe('file_change')
})

test('infers initial agent from model without an agent argument', async ($, on) => {
  mock.clock(on)
  let held: AiCliJobsJob[] = []
  let pid = 100
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  const cases = [
    ['gpt-6.1-sol', 'codex'], ['codex-mini', 'codex'],
    ['gemini-pro', 'antigravity'], ['agy', 'antigravity'], ['agy-pro', 'antigravity'],
    ['grok-4.7', 'grok'], ['grok-4.7-build-fast', 'grok'],
    ['nv-model', 'direct-api'], ['or-model', 'direct-api'], ['ds-model', 'direct-api'],
    ['custom-model', 'direct-api'], ['provider/model', 'direct-api'],
    ['fable', 'claude'], ['sonnet', 'claude'], ['opus', 'claude'], ['haiku', 'claude'],
    ['claude-ultra', 'claude'], ['claude-sonnet-4', 'claude'], ['unknown', 'claude'], ['', 'claude'],
  ] as const
  for (const [model, agent] of cases) {
    expect(inferAgent(model)).toBe(agent)
    await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'model-' + pid, model, prompt: 'task' })
    expect(held[held.length - 1]?.agent).toBe(agent)
  }
  // Both surfaces show the correct agent before the first poll.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /^🟠 haiku$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^🔵 gemini-pro$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^🟢 gpt-6\.1-sol$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('unknown terminal statuses and invalid pids do not block other poll updates', async ($, on) => {
  const clock = mock.clock(on)
  let held: AiCliJobsJob[] = []
  let pid = 200
  let calls = 0
  let done = false
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  on('mcp.call', () => {
    calls++
    return { value: { isError: false, content: [], structuredContent: [
      { pid: 'invalid', status: 'running' }, null,
      { pid: 200, agent: 'poll-authority', status: done ? 'completed' : 'running', elapsedSec: 9, lastEvent: 'item.completed file_change' },
      { pid: 201, status: 'completed', elapsedSec: 4 },
      { pid: 202, status: 'failed', elapsedSec: 4, lastEvent: 'error' },
      { pid: 203, status: 'killed', elapsedSec: 4, lastEvent: 'signal SIGTERM' },
      { pid: 204, status: 'cancelled', elapsedSec: 4 },
    ] } }
  })
  for (let n = 0; n < 5; n++) await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'status-' + n, model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  expect(held.map(j => j.status)).toEqual(['running', 'completed', 'failed', 'failed', 'failed'])
  expect(held[0]?.agent).toBe('poll-authority')
  expect(held[0]?.lastEvent).toBe('item.completed file_change')
  expect(held[3]?.lastEvent).toBe('killed signal SIGTERM')
  expect(held[4]?.lastEvent).toBe('cancelled')
  expect(held.slice(1).every(j => j.finishedAt === POLL_MS)).toBe(true)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /killed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cancelled/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^❌ 失敗$/ })).length).toBe(3)
    expect((await ui.findAll({ type: 'Text', text: /^✅ 成功$/ })).length).toBe(1)
    await ui.unmount()
  }
  done = true
  await clock.advance(POLL_MS)
  expect(held[0]?.status).toBe('completed')
  await clock.advance(120000)
  expect(held).toEqual([])
  expect(calls).toBe(2)
})

test('records dispatch, polls, renders on both surfaces, expires and stops polling', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let calls = 0
  let completed = false
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { content: [{ type: 'text', text: '{"pid":123}' }] }, text: 'unchanged', ref: 7 }))
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('ai-cli')
    expect(e.tool).toBe('list_processes')
    calls++
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ processes: [{ pid: 123, agent: 'codex', status: completed ? 'completed' : 'running', elapsedSec: 62, sinceLastOutputSec: 1, lastEvent: 'item.completed file_change' }] }) }] } }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => tree('BASE'))
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || 'BASE'))
  const result = await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'run-1', agent: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'high', prompt: '【身分】worker\n\n# 任務：修驗收工具判定 bug' })
  expect(result).toEqual({ result: { content: [{ type: 'text', text: '{"pid":123}' }] }, text: 'unchanged', ref: 7 })
  expect(held).toEqual([expect.objectContaining({ pid: 123, model: 'gpt-6.1-sol', reasoningEffort: 'high', startedAt: 0, task: '修驗收工具判定 bug', status: 'running' })])
  await clock.advance(POLL_MS)
  expect(calls).toBe(1)
  expect(held?.[0]?.lastEvent).toBe('item.completed file_change')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: band })
    expect((await ui.find({ type: 'Text', text: /修驗收工具/ }))?.text).toBe('修驗收工具判定 bug  ·  file_change')
    expect(await ui.find({ type: 'Text', text: /^已跑 1:02$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^🟢 gpt-6\.1-sol·high$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^這個對話$/ })).toBeDefined()
    await ui.unmount()
    const survey = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: { ...band, hasSurvey: true } })
    expect(await survey.find({ type: 'Text', text: /修驗收工具/ })).toBeUndefined()
    await survey.unmount()
  }
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'running-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(shown('ai-cli ▸ 1 執行中'))
  completed = true
  await clock.advance(POLL_MS)
  expect(held?.[0]?.status).toBe('completed')
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: 'base', tail: 'existing' } })).toEqual(shown('existing · ai-cli ▸ 1 完成'))
  await clock.advance(119999)
  expect(held?.length).toBe(1)
  await clock.advance(1)
  expect(held).toEqual([])
  expect(calls).toBe(2)
})

test('empty jobs pass both UI sites through', async ($, on) => {
  mock.clock(on)
  on('ui.render', () => tree('BASE'))
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await $.ui.render({ surface, component: 'AbovePrompt', requestId: 'empty', props: band })).toEqual(shown('BASE'))
    expect(await $.ui.render({ surface, component: 'PromptHint', requestId: 'empty-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(shown('BASE'))
  }
})

test('mixed summary, failed/untracked retention, reconnect errors, and restart', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let pid = 10
  let mode = 'error'
  let calls = 0
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: pid++ } }))
  on('mcp.call', () => {
    calls++
    if (mode === 'error') return { value: { isError: true, content: [] } }
    return { value: { isError: false, content: [], structuredContent: mode === 'malformed' ? {} : [{ pid: 10, agent: 'codex', status: mode === 'done' ? 'completed' : 'running', elapsedSec: 8, lastEvent: '' }, { pid: 11, agent: 'codex', status: 'failed', elapsedSec: 4, lastEvent: 'error' }] } }
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || ''))
  for (let n = 0; n < 3; n++) await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'r' + n, prompt_file: '/tasks/job.md' })
  await clock.advance(POLL_MS)
  expect(held?.every(j => j.status === 'running')).toBe(true)
  mode = 'malformed'; await clock.advance(POLL_MS)
  expect(held?.length).toBe(3)
  mode = 'ok'; await clock.advance(POLL_MS)
  expect(held?.map(j => j.status)).toEqual(['running', 'failed', 'untracked'])
  mode = 'done'; await clock.advance(POLL_MS)
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'mixed', props: { isDraft: false, isWorking: false, hint: '' } })).toEqual(shown('ai-cli ▸ 1 完成 · 1 失敗 · 1 已不追蹤'))
  await clock.advance(120000)
  expect(held).toEqual([])
  const previous = calls
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'restart', prompt: 'new job' })
  await clock.advance(POLL_MS)
  expect(calls).toBe(previous + 1)
})

test('a poll that never answers times out, shows why, and the next poll finishes the job', async ($, on) => {
  let held: AiCliJobsJob[] = []
  const seen: string[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; seen.push(...held.map(j => j.lastEvent)); return next(e) })
  const clock = mock.clock(on)
  let calls = 0
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 700 } }))
  on('mcp.call', () => {
    calls++
    if (calls === 1) return new Promise<never>(() => {})
    return { value: { isError: false, content: [], structuredContent: [{ pid: 700, agent: 'grok', status: 'completed', elapsedSec: 84 }] } }
  })
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'hang', model: 'grok-4.7', prompt: 'task' })
  expect(held[0]?.agent).toBe('grok')
  await clock.advance(POLL_MS)
  await clock.advance(CALL_TIMEOUT_MS - 1)
  // The unanswered call holds later ticks back, but only until it times out.
  expect(calls).toBe(1)
  expect(held[0]?.status).toBe('running')
  await clock.advance(1 + POLL_MS)
  expect(seen).toContain(`輪詢失敗：逾時 ${CALL_TIMEOUT_MS / 1000}s`)
  expect(held[0]).toEqual(expect.objectContaining({ status: 'completed', agent: 'grok', elapsedSec: 84 }))
  expect(calls).toBe(2)
})

test('an isError poll result is shown on the running row', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 800 } }))
  on('mcp.call', () => ({ value: { isError: true, content: [{ type: 'text', text: 'server not connected' }] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'err', model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  expect(held[0]).toEqual(expect.objectContaining({ status: 'running', lastEvent: '輪詢失敗：server not connected' }))
})

test('engine refusals and missing servers turn into the fix, shown in full on the row', async ($, on) => {
  expect(failureText('ai-cli-jobs: $.mcp.call(ai-cli, list_processes) refused: Auto mode classifier unavailable'))
    .toBe('輪詢被拒：把 mcp__ai-cli__list_processes 加進 permissions.allow（原因：Auto mode classifier unavailable）')
  expect(failureText('ai-cli-jobs: $.mcp.call(ai-cli, list_processes) refused: Permission denied by a deny rule'))
    .toContain('（原因：Permission denied by a deny rule）')
  expect(failureText('ai-cli-jobs: $.mcp.call: no connected MCP tool "list_processes" on a server named "ai-cli"'))
    .toBe('輪詢失敗：找不到 mcp__ai-cli__list_processes：ai-cli 未連線（用 /mcp 重連，server 名稱須為 ai-cli），或被 permissions.deny 擋下')
  expect(failureText('server not connected')).toBe('輪詢失敗：server not connected')
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 900 } }))
  // The harness cannot raise the engine's own refusal: a deny from a test hook comes back as "$.mcp.call: <deny>",
  // while Claude Code 2.1.296 throws "<plugin>: $.mcp.call(<server>, <tool>) refused: <deny>" (read from the binary).
  // Feed that exact text through the isError path, which reaches the same failureText as a thrown error.
  on('mcp.call', () => ({ value: { isError: true, content: [{ type: 'text', text: 'ai-cli-jobs: $.mcp.call(ai-cli, list_processes) refused: Auto mode classifier unavailable' }] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'refused', model: 'haiku', prompt: 'task' })
  await clock.advance(POLL_MS)
  expect(held[0]).toEqual(expect.objectContaining({ status: 'running', lastEvent: '輪詢被拒：把 mcp__ai-cli__list_processes 加進 permissions.allow（原因：Auto mode classifier unavailable）' }))
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  const fix = await ui.find({ type: 'Text', text: /permissions\.allow/ })
  expect(fix?.text).toContain('把 mcp__ai-cli__list_processes 加進 permissions.allow（原因：Auto mode classifier unavailable）')
  // The fix is read in full: that cell wraps instead of cutting it off.
  expect(fix?.props.wrap).toBe('wrap')
  await ui.unmount()
})

test('jobs the server adopted from an ended session show up once, with their model', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let adoptedStatus = 'running'
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 1100 } }))
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: [
    { pid: 1100, agent: 'claude', status: 'running', elapsedSec: 1 },
    { pid: 1200, jobId: 'job-1200', agent: 'codex', model: 'gpt-6.1-sol', status: adoptedStatus, elapsedSec: 300, lastEvent: 'item.completed file_change', adopted: true },
    { pid: 1300, jobId: 'job-1300', agent: 'claude', status: 'running', elapsedSec: 5, recovered: true },
  ] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'own', model: 'haiku', prompt: 'own task' })
  await clock.advance(POLL_MS)
  expect(held.map(j => j.pid)).toEqual([1100, 1200])
  expect(held[1]).toEqual(expect.objectContaining({ agent: 'codex', model: 'gpt-6.1-sol', task: ADOPTED_TASK, status: 'running', elapsedSec: 300, lastEvent: 'item.completed file_change' }))
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect(await ui.find({ type: 'Text', text: /接管自前一個 session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^已跑 5:00$/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(POLL_MS)
  expect(held.filter(j => j.pid === 1200)).toHaveLength(1)
  adoptedStatus = 'completed'
  await clock.advance(POLL_MS)
  expect(held[1]?.status).toBe('completed')
  // Pruned after retention, and not brought back although the server still lists it.
  await clock.advance(120_000)
  expect(held.map(j => j.pid)).toEqual([1100])
})

test('an adoption that lands after the first look shows up within seconds, not a minute later', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let adopted = false
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: adopted
    ? [{ pid: 1700, jobId: 'job-1700', agent: 'codex', model: 'gpt-6.1-sol', status: 'running', elapsedSec: 400, adopted: true }]
    : [] } }))
  // The job store scan starts with the session too; keep it off the real disk.
  mock.env(on, { AI_CLI_STATE_DIR: '/store' })
  on('fs.list', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(DISCOVER_EARLY_MS[0]!)
  expect(held).toEqual([])
  // On Windows the server finished adopting 7–11 s after the session started; the row is up by 15 s.
  await clock.advance(11_000 - DISCOVER_EARLY_MS[0]!)
  adopted = true
  await clock.advance(4_000)
  expect(held.map(j => j.pid)).toEqual([1700])
  expect(held[0]?.task).toBe(ADOPTED_TASK)
})

test('adopted rows need a jobId, and one already held is never brought back after it is pruned', async ($, on) => {
  let held: AiCliJobsJob[] = []
  on('state.set', ref, async ($, e, next) => { held = e.value; return next(e) })
  const clock = mock.clock(on)
  let ownStatus = 'running'
  on('tool.call', { tool: 'mcp__ai-cli__run' }, ($, e) => ({ result: { pid: (e as { tool_use_id: string }).tool_use_id === 'keep' ? 1400 : 1500 } }))
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: [
    { pid: 1400, jobId: 'job-1400', agent: 'claude', status: 'running', elapsedSec: 1 },
    // Dispatched here, then adopted back by this session's new principal (a resumed session keeps its rows).
    { pid: 1500, jobId: 'job-1500', agent: 'codex', status: ownStatus, elapsedSec: 2, adopted: true },
    { pid: 1600, agent: 'codex', status: 'running', elapsedSec: 3, adopted: true },
  ] } }))
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'keep', model: 'haiku', prompt: 'keeps polling alive' })
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'own', model: 'gpt-6.1-sol', prompt: 'own job' })
  await clock.advance(POLL_MS)
  expect(held.map(j => j.pid)).toEqual([1400, 1500])
  expect(held[1]?.task).toBe('own job')
  ownStatus = 'completed'
  await clock.advance(POLL_MS)
  await clock.advance(120_000)
  expect(held.map(j => j.pid)).toEqual([1400])
})

test('job store folders fold into rows: outcome, project tag, task label', async () => {
  const meta = { agent: 'codex', model: 'gpt-6.1-sol', resolvedModel: 'gpt-6.1-sol', effort: 'medium', pid: 42,
    task: '【身分】worker\n\n# 任務：補測試', projectDir: 'D:\\Work\\proj-b', startTime: '2026-10-22T00:00:00.000Z' }
  const running = machineJob('a', meta, undefined, undefined, 5, 'C:/Users/me/ai-cli')
  expect(running).toEqual(expect.objectContaining({ jobId: 'a', pid: 42, agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium',
    task: '補測試', project: 'proj-b', status: 'running', startedAt: Date.parse('2026-10-22T00:00:00.000Z'), outputAt: 5 }))
  expect(running?.endedAt).toBeUndefined()
  // Same project, spelled with the other slashes and case, or a folder inside it: no tag.
  expect(machineJob('a', meta, undefined, undefined, undefined, 'd:/work/proj-b/')?.project).toBe('')
  expect(machineJob('a', meta, undefined, undefined, undefined, 'D:\\Work\\proj-b\\apps\\api')?.project).toBe('')
  const end = '2026-10-22T00:05:00.000Z'
  expect(machineJob('a', meta, { exitCode: 0, endTime: end }, undefined, undefined, '')?.status).toBe('ok')
  expect(machineJob('a', meta, { exitCode: 0, killed: true, endTime: end }, undefined, undefined, '')?.status).toBe('bad')
  expect(machineJob('a', meta, { exitCode: 0, timedOut: true, endTime: end }, undefined, undefined, '')?.status).toBe('bad')
  expect(machineJob('a', meta, { exitCode: 1, endTime: end }, undefined, undefined, '')?.endedAt).toBe(Date.parse(end))
  expect(machineJob('a', meta, undefined, { endTime: end }, undefined, '')?.status).toBe('lost')
  // An end record with no endTime falls back to the file's own time.
  expect(machineJob('a', meta, { exitCode: 0 }, undefined, undefined, '', 99)?.endedAt).toBe(99)
  expect(machineJob('a', { model: 'or-qwen/qwen3.7-plus' }, undefined, undefined, undefined, '')?.agent).toBe('direct-api')
  expect(machineJob('a', undefined, undefined, undefined, undefined, '')).toBeUndefined()
  expect(ago(59_999)).toBe('剛剛')
  expect(ago(3 * 60_000)).toBe('3 分前')
})

test('other sessions\' jobs show from the job store, this session\'s own are not shown twice', async ($, on) => {
  const clock = mock.clock(on)
  const now = 60 * 60_000
  await clock.advance(now)
  const iso = (t: number) => new Date(t).toISOString()
  type Entry = { name: string, kind: 'file' | 'dir' | 'other', size: number, mtimeMs: number, isLink: boolean }
  const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
  const file = (name: string, mtimeMs: number): Entry => ({ name, kind: 'file', size: 1, mtimeMs, isLink: false })
  const store: Record<string, { files: Entry[], text: Record<string, unknown> }> = {
    // Another session in another project, quiet for 7 minutes.
    other: { files: [file('meta.json', 0), file('stdout.log', now - 7 * 60_000)],
      text: { 'meta.json': { agent: 'grok', model: 'grok-4.7', effort: 'high', pid: 1, task: '查封包', projectDir: '/other/proj-b', startTime: iso(now - 14 * 60_000) } } },
    // Finished a minute ago in this project.
    done: { files: [file('meta.json', 0), file('exit.json', now - 60_000)],
      text: { 'meta.json': { agent: 'claude', model: 'sonnet', effort: 'low', pid: 2, task: '寫摘要', projectDir: '/proj', startTime: iso(now - 5 * 60_000) },
        'exit.json': { exitCode: 0, endTime: iso(now - 60_000), killed: false, timedOut: false } } },
    // Finished too long ago: skipped without reading it.
    old: { files: [file('meta.json', 0), file('exit.json', now - RECENT_MS - 1)], text: {} },
    // This session's own job, which list_processes already reports.
    mine: { files: [file('meta.json', 0)],
      text: { 'meta.json': { agent: 'claude', model: 'haiku', pid: 1800, task: 'own', projectDir: '/proj', startTime: iso(now) } } },
  }
  const reads: string[] = []
  mock.env(on, { AI_CLI_STATE_DIR: '/store' })
  on('session.root', () => ({ value: '/proj' }))
  // The engine hands the hook an absolute path (on Windows `C:\store\jobs`), so match by its last parts.
  const parts = (path: string) => path.split(/[\\/]/)
  on('fs.list', ($, e) => ({ value: /[\\/]store[\\/]jobs$/.test(e.path) ? Object.keys(store).map(dir) : store[parts(e.path).pop()!]?.files ?? [] }))
  on('fs.read', ($, e) => {
    reads.push(e.path)
    const [job, name] = parts(e.path).slice(-2)
    return { value: JSON.stringify(store[job!]!.text[name!]) }
  })
  on('tool.call', { tool: 'mcp__ai-cli__run' }, () => ({ result: { pid: 1800 } }))
  on('mcp.call', () => ({ value: { isError: false, content: [], structuredContent: [{ pid: 1800, agent: 'claude', status: 'running', elapsedSec: 1 }] } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || ''))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ai-cli__run', tool_use_id: 'own', model: 'haiku', prompt: 'own' })
  await clock.advance(SCAN_MS)
  expect(reads.some(p => /[\\/]old[\\/]/.test(p))).toBe(false)
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts[0]).toBe('🤖 ai-cli 背景工作（執行中 2 · 剛完成 1）')
  // Rows: this session's running job, then the other running one, then the finished one; pid 1800 only once.
  // The spinner frame depends on the clock; any frame is fine.
  expect(texts.slice(6).map(t => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 執行$/.test(t) ? '* 執行' : t)).toEqual([
    '* 執行', '這個對話', '🟠 haiku', 'own', '已跑 0:05',
    '* 執行', '其他專案', '⚫ grok-4.7·high', '［proj-b］ 查封包 💤 7 分沒輸出', '已跑 14:05',
    '✅ 成功', '同專案', '🟠 sonnet·low', '寫摘要', '1 分前',
  ])
  await ui.unmount()
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'machine-hint', props: { isDraft: false, isWorking: false, hint: '' } }))
    .toEqual(shown('ai-cli ▸ 1 執行中 · 其他 1 執行中'))
  // meta.json is read once per job, not on every scan.
  const metaReads = reads.filter(p => p.endsWith('meta.json')).length
  await clock.advance(SCAN_MS)
  expect(reads.filter(p => p.endsWith('meta.json')).length).toBe(metaReads)
  expect(QUIET_MS).toBe(5 * 60_000)
})

/* ---- kernel runs ---- */

const T0 = Date.parse('2026-11-10T02:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const CONTRACT = { workFolder: '/repos/demo-app', budget: { maxWallMinutes: 240 }, develop: { repoRoot: '/repos/demo-app', expiresAt: at(600) } }
const RUN = 'kr-20261110-020000-ab12'
const MARK = 'K-20261110020000ab12'
/** A develop run the way the kernel journals it: approval, test lock, setup, decide, two steps, the final test, done. */
function journal(): Record<string, unknown>[] {
  let seq = 0
  const ev = (min: number, body: Record<string, unknown>) => ({ ...body, seq: ++seq, at: at(min) })
  const intent = (min: number, actionId: string, kind: string, stepId?: string) => ev(min, { type: 'action_intent', action: { actionId, kind, stepId, model: 'm', prompt: `[${MARK}-${actionId}] ...`, marker: `${MARK}-${actionId}` } })
  return [
    ev(0, { type: 'created', contractDigest: 'd' }),
    ev(33, { type: 'approved', contractDigest: 'd', kind: 'contract' }),
    ev(33, { type: 'state', state: 'running' }),
    ev(33, { type: 'runner_started', pid: 1, versionId: 'v', token: 't' }),
    ev(34, { type: 'test_lock_wait', heldBy: 'kr-20261109-103236-3a1a' }), // 5 events: waiting for the lock
    ev(40, { type: 'test_lock_acquired' }),
    ev(40, { type: 'check_started', kind: 'setup', pid: 7, started: 's', name: 'node.exe' }),
    ev(40.2, { type: 'check_started', kind: 'setup', pid: 7, started: 's', name: 'node.exe' }), // 8: setup, identity added
    ev(41, { type: 'check_finished', pid: 7 }),
    ev(41, { type: 'workspace_ready', head: 'h' }),
    intent(41, 'a1', 'decide'), // 11: decide open
    ev(41.1, { type: 'action_started', actionId: 'a1', job: { pid: 2, jobId: 'j1', startedAt: at(41.1) } }),
    ev(43, { type: 'action_result', actionId: 'a1', outcome: { ok: true } }),
    ev(43, { type: 'decide_processed', actionId: 'a1', ok: true, plan: { planId: 'p', steps: [{ id: 's1', title: '寫測試', prompt: '' }, { id: 's2', title: '修 bug 並更新文件，這個標題很長很長很長很長很長很長很長很長很長很長', prompt: '' }] } }),
    intent(43, 'a2', 'worker', 's1'),
    ev(43.5, { type: 'action_started', actionId: 'a2', job: { pid: 3, jobId: 'j2', startedAt: at(43.5) } }), // 16: step 1/2 open
    ev(70, { type: 'action_result', actionId: 'a2', outcome: { ok: true } }),
    ev(70, { type: 'step_checked', actionId: 'a2', stepId: 's1', passed: true, findings: [] }),
    intent(70, 'a3', 'worker', 's2'),
    ev(70.5, { type: 'action_started', actionId: 'a3', job: { pid: 4, jobId: 'j3', startedAt: at(70.5) } }),
    ev(100, { type: 'action_result', actionId: 'a3', outcome: { ok: true } }),
    ev(100, { type: 'step_checked', actionId: 'a3', stepId: 's2', passed: true, findings: [] }), // 22: between steps
    ev(101, { type: 'check_started', kind: 'test', pid: 8, started: 's', name: 'node.exe' }), // 23: final test
    ev(150, { type: 'check_finished', pid: 8 }),
    ev(150, { type: 'verification', commit: 'c', passed: true, exitCode: 0, timedOut: false, tail: '' }),
    ev(151, { type: 'acceptance', stepId: 's2', passed: true, findings: [] }),
    ev(151, { type: 'state', state: 'completed', reason: 'delivered' }), // 27: done
  ]
}
const upTo = (n: number) => journal().slice(0, n)

test('kernel markers: a job prompt names its run and action; probes and other prompts are told apart', async () => {
  expect(kernelMarker(`[${MARK}-a8] 你是 ai-cli_kern`)).toEqual({ runId: RUN, actionId: 'a8' })
  expect(kernelMarker('  [K-probe-a3b6af82] 這是 ai-cli 擁有者授權的')).toEqual({ probe: true })
  expect(kernelMarker(`補測試 [${MARK}-a1]`)).toBeUndefined()
  expect(kernelMarker('[K-2026111002000ab12-a1] one digit short')).toBeUndefined()
  const run = summarizeKernelRun(RUN, CONTRACT, journal(), false, T0 + 200 * 60_000)
  expect(kernelJobLabel(`[${MARK}-a1] 你是決策者`, [run])).toEqual({ task: 'kernel ab12 · decide', project: 'demo-app' })
  expect(kernelJobLabel(`[${MARK}-a2] 你是 worker`, [run])).toEqual({ task: 'kernel ab12 · 步驟 1/2 寫測試', project: 'demo-app' })
  // A run the panel has read but an action it does not know: the action id.
  expect(kernelJobLabel(`[${MARK}-a9] x`, [run])).toEqual({ task: 'kernel ab12 · a9', project: 'demo-app' })
  // No such run: left alone, so a prompt that merely looks like a marker is not renamed.
  expect(kernelJobLabel(`[${MARK}-a1] x`, [])).toBeUndefined()
  expect(kernelJobLabel('[K-probe-1] x', [])).toEqual({ task: 'kernel 權限邊界探針', project: '' })
  expect(kernelJobLabel('補測試', [run])).toBeUndefined()
})

test('kernel journal: a half-written last line is dropped, a broken line in the middle is damage', async () => {
  const good = JSON.stringify({ type: 'created', seq: 1, at: at(0) })
  expect(parseJournal(`${good}\n{"type":"sta`)).toHaveLength(1)
  expect(parseJournal(`${good}\n\n`)).toHaveLength(1)
  expect(() => parseJournal(`${good}\n{"type":"sta\n${good}\n`)).toThrow(/第 2 行損毀/)
  expect(() => parseJournal(`${good}\n[1,2]\n${good}`)).toThrow(/不是事件/)
})

test('kernel run summary follows the run through each phase, with phase and budget minutes', async () => {
  const sum = (n: number, min: number, runner = true) => summarizeKernelRun(RUN, CONTRACT, upTo(n), runner, T0 + min * 60_000)
  expect(sum(1, 10)).toEqual(expect.objectContaining({ kind: 'approval', short: 'ab12', project: 'demo-app', projectDir: '/repos/demo-app', phase: '委任書待核准，9 小時後失效' }))
  expect(sum(1, 601).kind).toBe('expired')
  const loose = summarizeKernelRun(RUN, { workFolder: 'C:/w/notes', budget: {} }, upTo(1), false, T0)
  expect(loose).toEqual(expect.objectContaining({ phase: '委任書待核准', project: 'notes', wallMinutes: null }))
  const lock = sum(5, 36)
  expect(lock).toEqual(expect.objectContaining({ kind: 'running', phase: '等測試鎖（kernel 3a1a）', phaseSince: T0 + 34 * 60_000 }))
  // The wait for the lock does not count toward the budget: one minute ran before it.
  expect(activeMinutes(lock, T0 + 36 * 60_000)).toBe(1)
  expect(sum(8, 40.5)).toEqual(expect.objectContaining({ phase: 'setup 準備環境', phaseSince: T0 + 40 * 60_000 }))
  expect(sum(11, 42).phase).toBe('decide')
  expect(sum(12, 42).phaseSince).toBe(T0 + 41.1 * 60_000)
  expect(sum(16, 50)).toEqual(expect.objectContaining({ phase: '步驟 1/2 寫測試', phaseSince: T0 + 43.5 * 60_000 }))
  expect(sum(20, 80).phase).toBe('步驟 2/2 修 bug 並更新文件，這個標題很長很長很長很長很長很長很長很長很')
  expect(sum(22, 100.5)).toEqual(expect.objectContaining({ phase: 'kernel 判定中', phaseSince: T0 + 100 * 60_000 }))
  const testing = sum(23, 130)
  expect(testing).toEqual(expect.objectContaining({ phase: '驗收測試', phaseSince: T0 + 101 * 60_000 }))
  expect(activeMinutes(testing, T0 + 130 * 60_000)).toBe(91)
  const done = sum(27, 300)
  expect(done).toEqual(expect.objectContaining({ kind: 'done', phase: '交付完成', stateSince: T0 + 151 * 60_000, stateSeq: 27, lastSeq: 27, wallMinutes: 240 }))
  // Closed at the state event: 1 minute before the lock, then 40 → 151.
  expect(activeMinutes(done, T0 + 300 * 60_000)).toBe(112)
  expect(done.labels).toEqual({ a1: 'decide', a2: '步驟 1/2 寫測試', a3: '步驟 2/2 修 bug 並更新文件，這個標題很長很長很長很長很長很長很長很長很' })
  // Running in the journal, no runner.json, quiet past the grace: interrupted; within the grace, still running.
  expect(sum(16, 43.5 + KERNEL_RUNNER_GRACE_MS / 60_000 + 1, false).kind).toBe('interrupted')
  expect(sum(16, 43.6, false).kind).toBe('running')
  // An unreadable contract: no project, the run still summarised.
  expect(summarizeKernelRun(RUN, undefined, upTo(16), true, T0 + 50 * 60_000)).toEqual(expect.objectContaining({ project: '', wallMinutes: null, phase: '步驟 1/2 寫測試' }))
})

test('kernel stops: each state and reason reads in words', async () => {
  const stopped = (state: string, reason: string) => summarizeKernelRun(RUN, CONTRACT,
    [...upTo(16), { type: 'state', state, reason, seq: 99, at: at(60) }], true, T0 + 61 * 60_000)
  expect(stopped('waiting_human', 'decide_question')).toEqual(expect.objectContaining({ kind: 'human', phase: 'decide 有問題問你', stateSeq: 99 }))
  expect(stopped('needs_reconcile', 'whatever_new')).toEqual(expect.objectContaining({ kind: 'human', phase: 'whatever_new' }))
  expect(stopped('version_drift', 'dist_changed').phase).toBe('ai-cli 版本變了')
  expect(stopped('failed', 'repeated_failure:commit_failed')).toEqual(expect.objectContaining({ kind: 'failed', phase: '連續失敗（commit_failed）' }))
  expect(stopped('budget_exhausted', 'wall_clock')).toEqual(expect.objectContaining({ kind: 'budget', phase: '時間用完' }))
  expect(stopped('cancelled', 'user_cancelled').kind).toBe('cancelled')
  expect(stopped('exploded', '').kind).toBe('unreadable')
  expect(reasonText('')).toBe('')
})

test('kernel stops the journal already holds, before their state event (replay.ts derivedStop)', async () => {
  let seq = 16
  const ev = (min: number, body: Record<string, unknown>) => ({ ...body, seq: ++seq, at: at(min) })
  const after = (...extra: Record<string, unknown>[]) => summarizeKernelRun(RUN, CONTRACT, [...upTo(16), ...extra], true, T0 + 90 * 60_000)
  const reset = () => { seq = 16 }
  // decide asked to stop: waiting for the person, since that event; the budget minutes stay open as the kernel counts them.
  reset()
  const asked = after(ev(60, { type: 'action_result', actionId: 'a2', outcome: { ok: true } }), ev(61, { type: 'decide_processed', actionId: 'a2', ok: true, stop: { state: 'waiting_human', reason: 'decide_question', detail: '?' } }))
  expect(asked).toEqual(expect.objectContaining({ kind: 'human', phase: 'decide 有問題問你', stateSince: T0 + 61 * 60_000, alertSeq: 18, terminal: false }))
  expect(activeMinutes(asked, T0 + 90 * 60_000)).toBe(51)
  // A failure that needs a person (quota) on a decide: waiting for the person at once.
  reset()
  expect(after(ev(60, { type: 'action_result', actionId: 'a2', outcome: { ok: false, failureClass: 'quota' } }), ev(60, { type: 'decide_processed', actionId: 'a2', ok: false }))).toEqual(expect.objectContaining({ kind: 'human', phase: '額度用完' }))
  // The same failure twice: failed. Once, then a pass: still running.
  reset()
  const twice = after(ev(60, { type: 'step_checked', actionId: 'a2', stepId: 's1', passed: false, findings: [] }), ev(70, { type: 'step_checked', actionId: 'a3', stepId: 's1', passed: false, findings: [] }))
  expect(twice).toEqual(expect.objectContaining({ kind: 'failed', phase: '連續失敗（check_failed）', stateSince: T0 + 70 * 60_000, terminal: false }))
  reset()
  expect(after(ev(60, { type: 'step_checked', actionId: 'a2', stepId: 's1', passed: false, findings: [] }), ev(70, { type: 'step_checked', actionId: 'a3', stepId: 's1', passed: true, findings: [] })).kind).toBe('running')
  reset()
  expect(after(ev(60, { type: 'step_checked', actionId: 'a2', stepId: 's1', passed: false, failureClass: 'timeout', findings: [] }), ev(70, { type: 'step_checked', actionId: 'a3', stepId: 's1', passed: false, findings: [] })).kind).toBe('running')
  // Two rejected decides, two failed acceptances: failed.
  reset()
  expect(after(ev(60, { type: 'decide_processed', actionId: 'x', ok: false, reason: 'bad json' }), ev(61, { type: 'decide_processed', actionId: 'y', ok: false })).phase).toBe('decide 輸出無效')
  reset()
  expect(after(ev(60, { type: 'acceptance', stepId: 's2', passed: false, findings: [] }), ev(61, { type: 'acceptance', stepId: 's2', passed: false, findings: [] })).phase).toBe('驗收連續失敗')
  // Once the state event is written the derived stop is gone: approved again, it runs.
  reset()
  expect(after(ev(61, { type: 'decide_processed', actionId: 'a2', ok: true, stop: { state: 'waiting_human', reason: 'decide_question' } }),
    ev(62, { type: 'state', state: 'waiting_human', reason: 'decide_question' }), ev(70, { type: 'state', state: 'running' })).kind).toBe('running')
  // A written terminal state is terminal; a derived one is not.
  expect(summarizeKernelRun(RUN, CONTRACT, journal(), true, T0).terminal).toBe(true)
})

test('kernel times that do not parse move no clock', async () => {
  const bad = (type: string, extra: Record<string, unknown> = {}) => ({ type, seq: 99, at: 'not a time', ...extra })
  // A runner start with no time: the budget is not counted from 1970.
  const started = summarizeKernelRun(RUN, CONTRACT, [...upTo(3), bad('runner_started')], true, T0 + 40 * 60_000)
  expect(activeMinutes(started, T0 + 40 * 60_000)).toBe(0)
  // A state event with no time keeps the last known one.
  const stopped = summarizeKernelRun(RUN, CONTRACT, [...upTo(16), bad('state', { state: 'completed', reason: 'delivered' })], true, T0 + 60 * 60_000)
  expect(stopped).toEqual(expect.objectContaining({ kind: 'done', stateSince: T0 + 33 * 60_000 }))
  expect(activeMinutes(stopped, T0 + 60 * 60_000)).toBe(1 + 20)
})

test('kernel rows: which runs show, for how long, in what order, and at most how many', async () => {
  const now = T0 + 300 * 60_000
  const mk = (runId: string, kind: KernelRunSummary['kind'], stateSince: number, extra: Partial<KernelRunSummary> = {}): KernelRunSummary => ({
    ...unreadableRun(runId, '', stateSince), kind, phase: kind, project: 'demo-app', state: kind, stateSeq: 5, lastSeq: 5, stateSince, phaseSince: stateSince, ...extra })
  const id = (n: number) => `kr-20261110-000000-000${n}`
  const old = now - KERNEL_RECENT_MS - 1
  expect(kernelVisible(mk(id(1), 'done', now - KERNEL_RECENT_MS), now)).toBe(true)
  expect(kernelVisible(mk(id(1), 'done', old), now)).toBe(false)
  expect(kernelVisible(mk(id(1), 'failed', old), now)).toBe(false)
  expect(kernelVisible(mk(id(1), 'budget', old), now)).toBe(false)
  expect(kernelVisible(mk(id(1), 'cancelled', now), now)).toBe(false)
  // Unfinished runs show however old they are.
  for (const kind of ['running', 'approval', 'human', 'interrupted'] as const) expect(kernelVisible(mk(id(1), kind, old), now)).toBe(true)
  // A lapsed contract shows for a day after it lapsed.
  expect(kernelVisible(mk(id(1), 'expired', old, { expiresAt: now - 1000 }), now)).toBe(true)
  expect(kernelVisible(mk(id(1), 'expired', old, { expiresAt: old }), now)).toBe(false)
  // Archived at the seq it has: handled, gone. Newer events than the archive mark: shown again.
  expect(kernelVisible(mk(id(1), 'done', now), now, 5)).toBe(false)
  expect(kernelVisible(mk(id(1), 'done', now), now, 4)).toBe(true)
  expect(kernelVisible(mk(id(1), 'human', now), now, 5)).toBe(false)

  const runs = [
    mk(id(1), 'done', now - 3 * 60 * 60_000),
    mk(id(2), 'running', now - 60_000, { phase: '驗收測試', phaseSince: now - 754_000, activeMs: 78 * 60_000, wallMinutes: 240 }),
    mk(id(3), 'approval', now - 30 * 60_000),
    mk(id(4), 'failed', now - 5 * 60_000),
    mk(id(5), 'cancelled', now),
    mk(id(6), 'budget', now - 10 * 60_000, { activeMs: 75 * 60_000, wallMinutes: 240 }),
    mk(id(7), 'done', old),
    mk(id(8), 'unreadable', now - 60_000, { project: '' }),
  ]
  const out = kernelRows(runs, now, { [id(1)]: 4 })
  expect(KERNEL_MAX_ROWS).toBe(4)
  // Waiting for the person, then running, then finished (and unreadable) newest first; 1 is archived at an older seq, so still shown.
  expect(out.rows.map(r => r.key.slice(-4))).toEqual(['0003', '0002', '0008', '0004'])
  expect(out.more).toBe(2)
  expect(out.running).toBe(1)
  expect(out.attention).toBe(5)
  expect(out.rows[1]).toEqual(expect.objectContaining({ status: '執行中', run: '0002 demo-app', phase: '驗收測試', since: '12:34', total: '78/240 分' }))
  expect(out.rows[0]).toEqual(expect.objectContaining({ status: '✋ 等你核准', since: '30 分前', total: '0 分' }))
  // With the 4 rows full, a run that waits for the person still takes a row before running ones.
  const busy = [1, 2, 3, 4].map(n => mk(id(n), 'running', now, { phaseSince: now - n * 60_000 }))
  const waiting = [...busy, mk(id(9), 'interrupted', now - 2 * 60 * 60_000)]
  expect(kernelRows(waiting, now).rows.map(r => r.key.slice(-4))).toEqual(['0009', '0004', '0003', '0002'])
  expect(out.rows[2]).toEqual(expect.objectContaining({ status: '⚠ 讀不到', run: '0008', total: '' }))
  expect(kernelRows(runs, now, { [id(1)]: 5 }).more).toBe(1)
  expect(kernelRows(runs.slice(5, 6), now).rows[0]).toEqual(expect.objectContaining({ status: '⛽ 預算用完', since: '10 分前', total: '75/240 分' }))
  expect(kernelRows([runs[0]!], now).rows[0]?.since).toBe('3 小時前')
  expect(kernelCounts(out.running, out.attention)).toBe('kernel 執行中 1 · 待你看 5')
  expect(kernelCounts(0, 2)).toBe('待你看 2')
  expect(kernelCounts(0, 0)).toBe('')
  expect(summary([], 2, 'kernel 執行中 1')).toBe('ai-cli ▸ 其他 2 執行中 · kernel 執行中 1')
  expect(alertText(runs[2]!)).toBe(`ai-cli kernel 0003［demo-app］ 等你核准：approval。ai-cli kernel status ${id(3)}`)
})

test('kernel jobs in the job table: the run\'s repo and step instead of the worktree and the prompt\'s head', async () => {
  const now = T0 + 50 * 60_000
  const run = summarizeKernelRun(RUN, CONTRACT, upTo(16), true, now)
  const meta = { agent: 'claude', model: 'opus', effort: 'high', pid: 9, task: `[${MARK}-a2] 你是 ai-cli_kern`, workFolder: `/state/kernel/runs/${RUN}/wt`, startTime: at(43.5) }
  const job = machineJob('j2', meta, undefined, undefined, undefined, '/repos/demo-app')!
  expect(job.project).toBe('wt')
  expect(tableRows([], [job], now, [run])[0]).toEqual(expect.objectContaining({ source: 'kernel', task: '［demo-app］ kernel ab12 · 步驟 1/2 寫測試' }))
  // Without the run, the job is shown as it is.
  expect(tableRows([], [job], now)[0]).toEqual(expect.objectContaining({ source: '其他專案', task: `［wt］ [${MARK}-a2] 你是 ai-cli_kern` }))
})

test('kernel runs show from the state dir: section, summary, unreadable runs, toasts once per change, unchanged journals not re-read', async ($, on) => {
  const clock = mock.clock(on)
  const now = T0 + 120 * 60_000
  await clock.advance(now)
  type Entry = { name: string, kind: 'file' | 'dir' | 'other', size: number, mtimeMs: number, isLink: boolean }
  const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
  const text = (lines: Record<string, unknown>[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  const runs: Record<string, Record<string, string>> = {
    // Running: step 1/2, runner present.
    [RUN]: { 'contract.json': JSON.stringify(CONTRACT), 'journal.jsonl': text(upTo(16)), 'runner.json': '{}' },
    // A broken journal: line 3 of 4 is cut.
    'kr-20261110-010000-cd34': { 'contract.json': JSON.stringify(CONTRACT), 'journal.jsonl': `${text(upTo(2))}{"broken\n${text(upTo(1))}` },
    // Completed two days ago with a verdict: never read.
    'kr-20261108-010000-ef56': { 'contract.json': '{}', 'journal.jsonl': text(journal()), 'verdict.json': '{}' },
    // Waiting for approval since before this session: drawn, but not toasted.
    'kr-20261110-000000-0c0c': { 'contract.json': JSON.stringify(CONTRACT), 'journal.jsonl': text(upTo(1)) },
    // Cancelled: read once, then never listed again.
    'kr-20261110-011000-0a0b': { 'contract.json': JSON.stringify(CONTRACT), 'journal.jsonl': text([...upTo(3), { type: 'state', state: 'cancelled', reason: 'user_cancelled', seq: 4, at: at(5) }]) },
  }
  const mtimes: Record<string, number> = { 'kr-20261108-010000-ef56': now - 2 * KERNEL_RECENT_MS }
  const entries = (run: string) => Object.entries(runs[run] ?? {}).map(([name, body]): Entry => ({ name, kind: 'file', size: body.length, mtimeMs: mtimes[run] ?? now - 60_000, isLink: false }))
  const reads: string[] = [], lists: string[] = [], toasts: string[] = []
  mock.env(on, { AI_CLI_STATE_DIR: '/store' })
  on('session.root', () => ({ value: '/proj' }))
  const parts = (path: string) => path.split(/[\\/]/)
  on('fs.list', ($, e) => {
    lists.push(e.path)
    if (/[\\/]store[\\/]kernel[\\/]runs$/.test(e.path)) return { value: Object.keys(runs).map(dir) }
    return { value: /[\\/]kernel[\\/]runs[\\/]/.test(e.path) ? entries(parts(e.path).pop()!) : [] }
  })
  on('fs.read', ($, e) => {
    reads.push(e.path)
    const [run, name] = parts(e.path).slice(-2)
    const body = runs[run!]?.[name!]
    if (body === undefined) throw new Error('ENOENT')
    return { value: body }
  })
  on('ui.toast', ($, e, next) => { toasts.push(`${e.text}|${e.timeoutMs}`); return next(e) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => tree(e.props.tail || ''))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(SCAN_MS)
  expect(reads.some(p => p.includes('ef56'))).toBe(false)
  const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts[0]).toBe('🤖 ai-cli 背景工作（kernel 執行中 1 · 待你看 2）')
  expect(texts.slice(1).map(t => t.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /, '* '))).toEqual([
    'kernel run', 'run／專案', '目前階段', '本階段', '總計／預算',
    '✋ 等你核准', '0c0c demo-app', '委任書待核准，7 小時後失效', '2 小時前', '0/240 分',
    // 43.5 → 120 min 5 s on this step; active 33 → 34 and 40 → 120 min 5 s.
    '* 執行中', 'ab12 demo-app', '步驟 1/2 寫測試', '76:35', '81/240 分',
    '⚠ 讀不到', 'cd34', '讀不到狀態：journal 第 3 行損毀', '1 分前', '',
  ])
  await ui.unmount()
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'kernel-hint', props: { isDraft: false, isWorking: false, hint: '' } }))
    .toEqual(shown('ai-cli ▸ kernel 執行中 1 · 待你看 2'))
  // What was already there at the first look is drawn, not toasted.
  expect(toasts).toEqual([])
  // Unchanged journals are not read again; the broken one neither; the cancelled one is not even listed again.
  const before = reads.length
  const listedCancelled = lists.filter(p => p.endsWith('0a0b')).length
  await clock.advance(SCAN_MS)
  expect(reads.length).toBe(before)
  expect(lists.filter(p => p.endsWith('0a0b')).length).toBe(listedCancelled)
  // The run stops for the person: told once, with the command to look.
  runs[RUN]!['journal.jsonl'] = text([...upTo(16), { type: 'state', state: 'waiting_human', reason: 'quota_low', seq: 17, at: at(119) }])
  delete runs[RUN]!['runner.json']
  await clock.advance(SCAN_MS)
  await clock.advance(SCAN_MS)
  expect(toasts).toEqual([`ai-cli kernel ab12［demo-app］ 等你處理：額度不足。ai-cli kernel status ${RUN}|${KERNEL_TOAST_MS}`])
  // Approved again and finished: one more toast, for the new state.
  runs[RUN]!['journal.jsonl'] = text(journal())
  await clock.advance(SCAN_MS)
  expect(toasts).toHaveLength(2)
  expect(toasts[1]).toBe(`ai-cli kernel ab12［demo-app］ 完成待審：交付完成。ai-cli kernel result ${RUN}|${KERNEL_TOAST_MS}`)
  // Archived at its last seq: the row goes, no toast.
  runs[RUN]!['archived.json'] = JSON.stringify({ runId: RUN, journalSeq: 27 })
  await clock.advance(SCAN_MS)
  const after = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await after.findAll({ type: 'Text' })).map(t => t.text)[0]).toBe('🤖 ai-cli 背景工作（待你看 2）')
  await after.unmount()
  expect(toasts).toHaveLength(2)
})

test('kernel scan failures and the runs that stop by themselves: a failed listing changes nothing, interruptions and lapses are told once', async ($, on) => {
  const clock = mock.clock(on)
  const now = T0 + 120 * 60_000
  await clock.advance(now)
  type Entry = { name: string, kind: 'file' | 'dir' | 'other', size: number, mtimeMs: number, isLink: boolean }
  const text = (lines: Record<string, unknown>[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  const RUNNING = 'kr-20261110-030000-1111', LAPSING = 'kr-20261110-030000-2222', HIDDEN = 'kr-20261110-030000-3333'
  const runs: Record<string, Record<string, string>> = {
    // Running with its runner, quiet since 43.5 min: interrupted the moment runner.json goes.
    [RUNNING]: { 'contract.json': JSON.stringify(CONTRACT), 'journal.jsonl': text(upTo(16)), 'runner.json': '{}' },
    // Waiting for approval, lapsing at 121 min.
    [LAPSING]: { 'contract.json': JSON.stringify({ ...CONTRACT, develop: { ...CONTRACT.develop, expiresAt: at(121) } }), 'journal.jsonl': text(upTo(1)) },
  }
  let rootFails = true, folderFails = false
  const toasts: string[] = []
  mock.env(on, { AI_CLI_STATE_DIR: '/store' })
  on('session.root', () => ({ value: '/proj' }))
  const parts = (path: string) => path.split(/[\\/]/)
  on('fs.list', ($, e) => {
    if (/[\\/]store[\\/]kernel[\\/]runs$/.test(e.path)) {
      if (rootFails) throw new Error('EBUSY')
      return { value: [...Object.keys(runs), ...(folderFails ? [HIDDEN] : [])].map((name): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
    }
    const run = parts(e.path).pop()!
    if (run === HIDDEN) throw new Error('EACCES')
    return { value: Object.entries(runs[run] ?? {}).map(([name, body]): Entry => ({ name, kind: 'file', size: body.length, mtimeMs: now - 60_000, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    const [run, name] = parts(e.path).slice(-2)
    const body = runs[run!]?.[name!]
    if (body === undefined) throw new Error('ENOENT')
    return { value: body }
  })
  on('ui.toast', ($, e, next) => { toasts.push(e.text); return next(e) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const shownTexts = async () => {
    const ui = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return texts
  }
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  // The first looks fail: nothing drawn, and the baseline is still to come.
  await clock.advance(SCAN_MS)
  expect(await shownTexts()).toEqual([])
  rootFails = false
  await clock.advance(SCAN_MS)
  // The first good look is the baseline: the run already waiting for approval is drawn, not toasted.
  expect(toasts).toEqual([])
  expect((await shownTexts())[0]).toBe('🤖 ai-cli 背景工作（kernel 執行中 1 · 待你看 1）')
  // A failed listing later keeps what was drawn.
  rootFails = true
  await clock.advance(SCAN_MS)
  expect((await shownTexts())[0]).toBe('🤖 ai-cli 背景工作（kernel 執行中 1 · 待你看 1）')
  rootFails = false
  // A run folder that cannot be listed gets its own row.
  folderFails = true
  await clock.advance(SCAN_MS)
  const texts = await shownTexts()
  // (A throwing test hook is skipped by the engine, which then rejects with its own text: match the start.)
  expect(texts.some(t => t.startsWith('讀不到狀態：讀不到 run 目錄（'))).toBe(true)
  expect(texts).toContain('3333')
  folderFails = false
  // The runner goes: interrupted, told once.
  delete runs[RUNNING]!['runner.json']
  await clock.advance(SCAN_MS)
  expect(toasts).toEqual([`ai-cli kernel 1111［demo-app］ 中斷：runner 不在，可能中斷了。ai-cli kernel status ${RUNNING}`])
  // runner.json coming back and going again, with no new event, is the same interruption.
  runs[RUNNING]!['runner.json'] = '{}'
  await clock.advance(SCAN_MS)
  delete runs[RUNNING]!['runner.json']
  await clock.advance(SCAN_MS)
  expect(toasts).toHaveLength(1)
  // Taken over by a new runner that moves on, then gone again: a new interruption, told again.
  runs[RUNNING]!['runner.json'] = '{}'
  runs[RUNNING]!['journal.jsonl'] = text([...upTo(16), { type: 'action_result', actionId: 'a2', outcome: { ok: true }, seq: 17, at: at(119) }])
  await clock.advance(SCAN_MS)
  delete runs[RUNNING]!['runner.json']
  await clock.advance(SCAN_MS)
  expect(toasts).toHaveLength(2)
  // The approval window passes: told once.
  await clock.advance(60_000)
  const interrupted = `ai-cli kernel 1111［demo-app］ 中斷：runner 不在，可能中斷了。ai-cli kernel status ${RUNNING}`
  expect(toasts).toEqual([interrupted, interrupted, `ai-cli kernel 2222［demo-app］ 過期：委任書已失效，沒核准。ai-cli kernel status ${LAPSING}`])
})
