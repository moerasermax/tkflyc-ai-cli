import { expect, test, mock } from 'claude-code/testing'

const PANE = {
  plugin: 'ai-cli_kernel_panel',
  component: 'Pane',
  requestId: 'ai-cli_kernel_panel',
  surface: 'terminal',
  props: {
    title: 'ai-cli_kernel',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const COMMIT = 'abcdef1234567890'

/** 假的 CLI：照實回 JSON，把每次呼叫記下來。 */
function fakeKernel(on: (name: never, hook: never) => void, state: { commit: string; calls: string[]; active?: string }) {
  const hook = (name: string, value: unknown) => (on as unknown as (n: string, h: unknown) => void)(name, value)
  hook('command.register', () => ({ value: { command: 'kernel' } }))
  hook('ui.open', () => ({ value: { isPlaced: true } }))
  hook('ui.status', () => ({ value: undefined }))
  hook('ui.panes', () => ({ value: [] }))
  hook('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'D:/test home' : undefined }))
  mock.clock(on as never)
  hook('fs.read', () => ({ value: '{"enabled":false}' }))
  hook('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  hook('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const argv = e.argv
    const done = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv[0] === 'git') return done(argv.includes('symbolic-ref') ? 'origin/master\n' : 'master\n')
    const args = argv.slice(3)
    state.calls.push(args.join(' '))
    if (args[0] === 'status' && args[1] === '--json') {
      const runs = [{ runId: 'kr-1', effectiveState: 'completed', stateLabel: '完成', goal: '目標：做事' }]
      if (state.active) runs.unshift({ runId: state.active, effectiveState: 'running', stateLabel: '執行中', goal: '目標：新的工作' })
      return done(JSON.stringify({ active: state.active ?? null, pendingArchiveCount: 0, runs }))
    }
    if (args[0] === 'status') {
      const isActive = args[1] === state.active
      return done(JSON.stringify({
        runId: args[1], effectiveState: isActive ? 'running' : 'completed', stateLabel: isActive ? '執行中' : '完成', goal: '目標：做事', template: 'develop',
        develop: { repoRoot: 'C:/repo', branch: 'ai-cli_kernel/kr-1', verifiedCommit: state.commit, notices: [] },
      }))
    }
    if (args[0] === 'actions') return done(JSON.stringify([{
      id: 'merge', runId: args[1], label: '合併到 master', summary: '合併已驗證的 commit', warning: null,
      commit: state.commit, isRelease: true,
      args: ['release', 'create', args[1], '--action', 'merge', '--target', 'master', '--confirm', state.commit.slice(0, 10), '--json'],
    }]))
    if (args[0] === 'release' && args[1] === 'create') return done(JSON.stringify({ id: 'kr-1-rel-1' }))
    return done('succeeded\n')
  })
}

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const found = await probe()
    if (found) return found
    await Promise.resolve()
  }
  throw new Error('等不到畫面更新')
}

const released = (calls: string[]) => calls.filter(call => call.startsWith('release'))

test('按一次合併只進確認畫面，第二次才放行，而且先 create 再 run', async ($, on) => {
  const state = { commit: COMMIT, calls: [] as string[] }
  fakeKernel(on as never, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await waitFor(() => ui.find({ key: 'merge' }))
  expect(released(state.calls)).toEqual([])

  await ui.press({ key: 'merge' })
  await waitFor(() => ui.find({ key: 'confirm-yes' }))
  expect(released(state.calls)).toEqual([])

  await ui.press({ key: 'confirm-yes' })
  await waitFor(async () => (released(state.calls).length === 2 ? true : undefined))
  expect(released(state.calls)).toEqual([
    `release create kr-1 --action merge --target master --confirm ${COMMIT.slice(0, 10)} --json`,
    'release run kr-1-rel-1',
  ])
  await ui.unmount()
})

test('新的 run 開工時，面板會跳過去，不會停在舊的那筆', async ($, on) => {
  const state: { commit: string; calls: string[]; active?: string } = { commit: COMMIT, calls: [] }
  fakeKernel(on as never, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await waitFor(() => ui.find({ type: 'Text', text: /^kr-1$/ }))

  state.active = 'kr-2'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await waitFor(() => ui.find({ type: 'Text', text: /^kr-2$/ }))
  await waitFor(() => ui.find({ type: 'Text', text: /新的工作/ }))
  await ui.unmount()
})

test('按「不要」什麼都不會執行', async ($, on) => {
  const state = { commit: COMMIT, calls: [] as string[] }
  fakeKernel(on as never, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await waitFor(() => ui.find({ key: 'merge' }))
  await ui.press({ key: 'merge' })
  await waitFor(() => ui.find({ key: 'confirm-no' }))
  await ui.press({ key: 'confirm-no' })
  await waitFor(() => ui.find({ key: 'merge' }))
  expect(released(state.calls)).toEqual([])
  await ui.unmount()
})

test('確認畫面停留期間 commit 變了就不放行', async ($, on) => {
  const state = { commit: COMMIT, calls: [] as string[] }
  fakeKernel(on as never, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await waitFor(() => ui.find({ key: 'merge' }))
  await ui.press({ key: 'merge' })
  await waitFor(() => ui.find({ key: 'confirm-yes' }))
  state.commit = '9999999999999999'
  await ui.press({ key: 'confirm-yes' })
  await waitFor(() => ui.find({ type: 'Text', text: /commit 已經變了/ }))
  expect(released(state.calls)).toEqual([])
  await ui.unmount()
})
