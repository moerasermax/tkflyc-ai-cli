import { expect, test } from 'claude-code/testing'
import { firstLine, parseActions, parseSnapshot, progressLine, summaryLine, triggerAction } from '../hooks/register.tsx'

test('actions JSON 使用 CLI 的原始參數與確認資訊，不在 plugin 計算操作政策', () => {
  const actions = [{ id: 'approve', runId: 'kr-1', label: '核准', summary: '開始', warning: '未隔離',
    args: ['approve', 'kr-1', '--acknowledge-unisolated'], commit: null, isRelease: false }]
  expect(parseActions(actions, 'kr-1')).toEqual(actions)
  expect(parseActions([], 'kr-1')).toEqual([])
  expect(() => parseActions({}, 'kr-1')).toThrow()
  expect(() => parseActions(actions, 'kr-other')).toThrow()
})

test('多個佔用者、新版空陣列與舊版 active fallback', () => {
  const snap = parseSnapshot({ active: 'old', activeRuns: [{ runId: 'a' }, { runId: 'b' }], runs: [] }, false, 1)
  expect(snap.active).toBe('a')
  expect(snap.activeRuns).toEqual(['a', 'b'])
  expect(summaryLine(snap)).toBe('kernel 2 執行中')
  const empty = parseSnapshot({ active: 'old', activeRuns: [] }, false, 1)
  expect(empty.active).toBe(null)
  expect(empty.activeRuns).toEqual([])
  expect(summaryLine(empty)).toBe(undefined)
  expect(parseSnapshot({ active: 'old' }, false, 1).activeRuns).toEqual(['old'])
  expect(parseSnapshot({ active: { runId: 'old' } }, false, 1).activeRuns).toEqual(['old'])
})

test('狀態摘要與進度維持中文顯示', () => {
  const snap = parseSnapshot({ active: 'kr-1', pendingArchiveCount: 2, runs: [{ runId: 'kr-2', effectiveState: 'awaiting_approval', stateLabel: '等', goal: '目標：測試\n細節' }] }, false, 1)
  expect(snap.runs[0]?.goal).toBe('測試')
  expect(summaryLine(snap)).toBe('kernel 1 執行中 · 1 等你 · 2 待歸檔')
  expect(summaryLine({ ...snap, error: '讀取失敗' })).toBe(undefined)
  expect(progressLine({ decides: { used: 1, max: 4 }, inputTokens: { used: 140299, max: 1000000 } }))
    .toBe('決策 1/4 · 未快取 140K/1M')
  expect(firstLine('\n  目標：第一行\n第二行')).toBe('第一行')
  expect(triggerAction(false).warning ?? '').toContain('隔離')
  expect(triggerAction(true).args).toEqual(['triggers', 'off'])
})
