import type { AiCliJobsJob } from '../types/index'
import { test, expect, mock } from 'claude-code/testing'
import { taskLabel, runPid, elapsed, eventLabel, inferAgent, POLL_MS, CALL_TIMEOUT_MS } from '../hooks/register'

const tree = (text: string) => ({ type: 'Text' as const, props: {}, children: [text] })
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
  expect((await ui.find({ type: 'Text' }))?.text).toContain('⠙')
  await ui.unmount()
  await clock.advance(POLL_MS - 1)
  expect(calls).toBe(1)
  await clock.advance(1)
  expect(calls).toBe(2)
  const nextUi = await $.ui.mount({ plugin: 'ai-cli-jobs', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await nextUi.find({ type: 'Text' }))?.text).toContain('⠹')
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
    expect(boxes.map(b => b.props.backgroundColor)).toEqual(['#E8DCB5', '#A8D5CE', '#DDE6A3', '#F4BE86', '#F4BE86', '#F4BE86'])
    expect(boxes[0]?.props.paddingX).toBe(1)
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.length).toBe(5)
    expect(texts.every(t => t.props.color === '#1A1A1A')).toBe(true)
    expect(texts.every(t => t.props.bold === true)).toBe(true)
    expect(texts[3]?.text).toContain('killed')
    expect(texts[4]?.text).toContain('已不追蹤')
    await ui.unmount()
    // The tail stays plain text with no background or foreground styles.
    expect(await $.ui.render({ surface, component: 'PromptHint', requestId: 'color-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(tree('ai-cli ▸ 1 執行中 · 1 完成 · 2 失敗 · 1 已不追蹤'))
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
    expect(await ui.find({ type: 'Text', text: /claude  haiku/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /antigravity  gemini-pro/ })).toBeDefined()
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
    expect((await ui.find({ type: 'Text', text: /killed/ }))?.text).toContain('✗')
    expect((await ui.find({ type: 'Text', text: /cancelled/ }))?.text).toContain('✗')
    expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
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
    expect((await ui.find({ type: 'Text', text: /修驗收工具/ }))?.text).toContain('1:02  file_change')
    await ui.unmount()
    const survey = await $.ui.mount({ plugin: 'ai-cli-jobs', surface, component: 'AbovePrompt', props: { ...band, hasSurvey: true } })
    expect(await survey.find({ type: 'Text', text: /修驗收工具/ })).toBeUndefined()
    await survey.unmount()
  }
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'running-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(tree('ai-cli ▸ 1 執行中'))
  completed = true
  await clock.advance(POLL_MS)
  expect(held?.[0]?.status).toBe('completed')
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: 'base', tail: 'existing' } })).toEqual(tree('existing · ai-cli ▸ 1 完成'))
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
    expect(await $.ui.render({ surface, component: 'AbovePrompt', requestId: 'empty', props: band })).toEqual(tree('BASE'))
    expect(await $.ui.render({ surface, component: 'PromptHint', requestId: 'empty-hint', props: { isDraft: false, isWorking: false, hint: 'base' } })).toEqual(tree('BASE'))
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
  expect(await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'mixed', props: { isDraft: false, isWorking: false, hint: '' } })).toEqual(tree('ai-cli ▸ 1 完成 · 1 失敗 · 1 已不追蹤'))
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
