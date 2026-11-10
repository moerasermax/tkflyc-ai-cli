import type { KernelRunSummary } from '../hooks/kernel'

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
/** A job read straight from the job store on disk: any session's, subagents' and other projects' included. */
export type AiCliJobsMachineJob = {
  jobId: string
  pid?: number
  agent: string
  model: string
  effort: string
  task: string
  /** The job's project folder name when it is not this session's project, else ''. */
  project: string
  /** lost = the server found the process gone with no exit record: neither success nor failure. */
  status: 'running' | 'ok' | 'bad' | 'lost'
  startedAt: number
  endedAt?: number
  /** When stdout.log was last written; undefined when there is none. */
  outputAt?: number
}
declare module 'claude-code' {
  interface PluginState {
    'ai-cli-jobs': {
      jobs: AiCliJobsJob[]
      machine: AiCliJobsMachineJob[]
      /** kernel runs read from <state dir>/kernel/runs that are not settled (finished and out of sight). */
      kernel: KernelRunSummary[]
      /** runId → archived.json's journalSeq, for the runs that have one. */
      kernelArchived: Record<string, number>
    }
  }
}
