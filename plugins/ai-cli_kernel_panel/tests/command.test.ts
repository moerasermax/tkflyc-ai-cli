import { expect, test } from 'claude-code/testing'

function fake(on: unknown, result = { exitCode: 0, stdout: '', stderr: '' }) {
  const hook = on as (name: string, handler: (...args: any[]) => any) => void
  const calls: string[][] = []
  let opened = 0
  hook('env.get', () => ({ value: 'D:/repo with spaces' }))
  hook('fs.read', () => ({ value: '{}' }))
  hook('process.run', (_: unknown, e: { argv: string[] }) => {
    calls.push(e.argv)
    return { value: result }
  })
  hook('ui.open', () => { opened++; return { value: { isPlaced: true } } })
  return { calls, opened: () => opened }
}

test('/kernel 新分頁成功，路徑空白仍是單一參數', async ($, on) => {
  const seen = fake(on)
  expect((await $.command.run({ command: 'kernel', args: '' })).text).toBe('已在新分頁打開')
  expect(seen.calls[0]).toEqual(['node', 'D:/repo with spaces/dist/bin/ai-cli.js', 'kernel', 'dashboard', '--new-tab'])
  expect(seen.opened()).toBe(0)
})

test('失敗完整保留 stdout stderr 結束碼與備援指令', async ($, on) => {
  fake(on, { exitCode: 7, stdout: 'one\ntwo\nthree\nfour\n', stderr: 'actual error\nlast reason\n' })
  const result = await $.command.run({ command: 'kernel', args: '' })
  for (const text of ['結束碼 7', 'one\ntwo\nthree\nfour\n', 'actual error\nlast reason\n', 'ai-cli kernel dashboard --new-tab', '/kernel side']) expect(result.text).toContain(text)
})

test('未知參數只提供用法，完全不執行指令或開面板', async ($, on) => {
  const seen = fake(on)
  expect((await $.command.run({ command: 'kernel', args: 'unexpected' })).text).toContain('用法')
  expect(seen.calls).toEqual([])
  expect(seen.opened()).toBe(0)
})
