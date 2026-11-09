export type KernelRunRow = {
  runId: string
  state: string
  label: string
  goal: string
}

export type KernelSnapshot = {
  at: number
  active: string | null
  activeRuns: string[]
  pendingArchive: number
  triggersOn: boolean | null
  runs: KernelRunRow[]
  error: string | null
}

export type KernelProgress = {
  decides?: { used: number; max: number }
  workerSteps?: { used: number; max: number }
  inputTokens?: { used: number; max: number }
  activeMinutes?: { used: number; max: number }
}

export type KernelDevelop = {
  repoRoot: string
  branch: string
  verifiedCommit: string | null
  hasCheckpoint: boolean
  currentBranch: string | null
  defaultBranch: string | null
  notices: string[]
  testCommand: string | null
  allowedPaths: string[]
  checkpointRef: string | null
}

export type KernelStep = { id: string; title: string; status: string }

export type KernelDetail = {
  runId: string
  state: string
  label: string
  reason: string | null
  detail: string | null
  goal: string
  template: string
  nextAction: string | null
  reportPath: string | null
  progress: KernelProgress | null
  develop: KernelDevelop | null
  workFolder: string | null
  models: string | null
  boundary: string | null
  origin: string | null
  steps: KernelStep[]
  accepted: boolean | null
  currentAction: string | null
}

export type KernelAction = {
  confirmedCommit?: string | null
  id: string
  runId: string | null
  label: string
  /** 按下確認會發生什麼，用白話講。 */
  summary: string
  /** 比 summary 更要緊的後果：部署、未隔離。 */
  warning: string | null
  /** 接在 `ai-cli kernel` 後面的參數。 */
  args: string[]
  /** 這個操作綁定的 commit。確認時會再查一次，變了就不做。 */
  commit: string | null
  /** release create 之後要接 release run。 */
  isRelease: boolean
}

export type KernelNotice = { kind: 'info' | 'ok' | 'error'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'ai-cli_kernel_panel': {
      snapshot: Shaped<KernelSnapshot>
      selected: Shaped<string | null>
      detail: Shaped<KernelDetail | null>
      confirm: Shaped<KernelAction | null>
      notice: Shaped<KernelNotice | null>
      report: Shaped<string[] | null>
      available: Shaped<KernelAction[]>
    }
  }
}
