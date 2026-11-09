import { expect, test } from 'claude-code/testing'

import { chooseRun, parseDetail, parseSnapshot, reasonLabel, shortState, startedAt, stateHelp, stepLabel, templateLabel } from '../hooks/register.tsx'

const listed = (active: string | null, ...ids: string[]) =>
  parseSnapshot({ active, pendingArchiveCount: 0, runs: ids.map(runId => ({ runId, effectiveState: runId === active ? 'running' : 'completed', stateLabel: 's', goal: 'g' })) }, false, 1)

test('新開工的 run 一定跳過去，就算人點過別筆', () => {
  expect(chooseRun('old', false, null, listed('new', 'new', 'old'))).toEqual({ runId: 'new', pinned: false })
  expect(chooseRun('old', true, 'prev', listed('new', 'new', 'old', 'prev'))).toEqual({ runId: 'new', pinned: false })
})

test('人點過的那筆會留著，直到又有新的開工', () => {
  expect(chooseRun('old', true, 'new', listed('new', 'new', 'old'))).toEqual({ runId: 'old', pinned: true })
})

test('沒點過就跟著執行中的；跑完留在原地看結果', () => {
  expect(chooseRun('old', false, 'new', listed('new', 'new', 'old'))).toEqual({ runId: 'new', pinned: false })
  expect(chooseRun('new', false, 'new', listed(null, 'new', 'old'))).toEqual({ runId: 'new', pinned: false })
})

test('選的那筆不在清單裡就退回第一筆；讀取失敗時不動', () => {
  expect(chooseRun('gone', true, null, listed(null, 'a', 'b'))).toEqual({ runId: 'a', pinned: false })
  expect(chooseRun(null, false, null, listed(null))).toEqual({ runId: null, pinned: false })
  expect(chooseRun('old', true, null, { ...listed(null), error: '壞了' })).toEqual({ runId: 'old', pinned: true })
})

const RAW = {
  runId: 'kr-20261107-010406-55d0', effectiveState: 'completed', stateLabel: '完成，已通過驗收', reason: 'delivered', detail: null,
  goal: '目標：稽核\n細節', template: 'readonly-audit', workFolder: 'C:/repo', boundaryLabel: '工具受限，非隔離',
  models: { decide: { model: 'gpt-6.1-sol', effort: 'medium' }, worker: { model: 'gpt-6.1-sol', effort: 'high' } },
  steps: [{ id: 'p1', title: '獨立稽核', status: 'passed', findings: [] }],
  acceptance: { stepId: 'p1', passed: true, findings: [] }, currentAction: null, origin: null,
  progress: { decides: { used: 2, max: 3 } }, nextAction: '看報告', reportPath: 'r.md', develop: null,
}

test('真實的 status 欄位都解析得出來', () => {
  const d = parseDetail(RAW)
  expect(d.goal).toBe('稽核')
  expect(d.models).toBe('決策 gpt-6.1-sol（medium）、worker gpt-6.1-sol（high）')
  expect(d.boundary).toBe('工具受限，非隔離')
  expect(d.workFolder).toBe('C:/repo')
  expect(d.accepted).toBe(true)
  expect(d.steps).toEqual([{ id: 'p1', title: '獨立稽核', status: 'passed' }])
  expect(d.currentAction).toBe(null)
})

test('develop 的路徑、測試指令和回復點都帶得出來', () => {
  const d = parseDetail({ ...RAW, template: 'develop', develop: {
    repoRoot: 'C:/repo', branch: 'b', verifiedCommit: 'abc', testCommand: 'npm test', allowedPaths: ['src'],
    checkpoint: { mode: 'local', ref: 'ai-cli_kernel/checkpoints/kr' }, checkpointResult: { pushed: false }, notices: [],
  } })
  expect(d.develop?.testCommand).toBe('npm test')
  expect(d.develop?.allowedPaths).toEqual(['src'])
  expect(d.develop?.checkpointRef).toBe('ai-cli_kernel/checkpoints/kr')
  expect(d.develop?.hasCheckpoint).toBe(true)
})

test('正在做的動作顯示得出來，壞掉的欄位不會讓面板出錯', () => {
  expect(parseDetail({ ...RAW, currentAction: { kind: 'worker', stepId: 'p1' } }).currentAction).toBe('worker：p1')
  const broken = parseDetail({ runId: 'kr-x', steps: 'nope', models: 3, acceptance: 'x', develop: null })
  expect(broken.steps).toEqual([])
  expect(broken.models).toBe(null)
  expect(broken.accepted).toBe(null)
})

test('沒收錄的原因代碼也不會被藏起來', () => {
  expect(reasonLabel('delivered')).toBe('工作做完，驗收通過（delivered）')
  expect(reasonLabel('brand_new_reason')).toBe('見細節（brand_new_reason）')
  expect(reasonLabel(null)).toBe(null)
})

test('唯讀和開發的完成，說明不一樣；沒通過測試的 develop 不會說可以收下', () => {
  const readonly = parseDetail(RAW)
  expect(stateHelp(readonly)).toContain('沒有東西要合併')
  const develop = parseDetail({ ...RAW, template: 'develop', develop: { repoRoot: 'r', branch: 'b', verifiedCommit: 'abc', notices: [] } })
  expect(stateHelp(develop)).toContain('由你決定')
  const unverified = parseDetail({ ...RAW, template: 'develop', develop: { repoRoot: 'r', branch: 'b', verifiedCommit: null, notices: [] } })
  expect(stateHelp(unverified)).toContain('不能放行')
})

test('標籤文字', () => {
  expect(templateLabel('develop')).toContain('權限等於你本人')
  expect(templateLabel('未來的範本')).toBe('未來的範本')
  expect(stepLabel('passed')).toBe('通過')
  expect(stepLabel('weird')).toBe('weird')
  expect(shortState('completed', '完成，已通過驗收')).toBe('完成')
  expect(shortState('new_state', '新狀態')).toBe('新狀態')
  expect(startedAt('not-a-run')).toBe('')
  expect(startedAt('kr-20261107-010406-55d0')).toMatch(/^11\/0[67] \d{2}:\d{2}$/)
})
