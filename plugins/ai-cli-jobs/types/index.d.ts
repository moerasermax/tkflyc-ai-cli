export type AiCliJobsJob = {
  pid: number
  agent: string
  model: string
  reasoningEffort: string
  task: string
  startedAt: number
  status: 'running' | 'completed' | 'failed' | 'untracked'
  elapsedSec: number
  sinceLastOutputSec?: number
  lastEvent: string
  finishedAt?: number
}
declare module 'claude-code' {
  interface PluginState {
    'ai-cli-jobs': { jobs: AiCliJobsJob[] }
  }
}
