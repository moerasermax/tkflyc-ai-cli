/** 面板的真實 I/O：直接呼叫 API；只以參數陣列讀 git，不呼叫 CLI 子程序。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as api from './api.js';
import { actionsFor, parseDetail, parseSnapshot, type KernelAction, type KernelDetail } from './dashboard-rules.js';
import type { DashboardEffects } from './dashboard.js';

async function git(cwd: string, args: string[]): Promise<string | null> {
  try { return (await promisify(execFile)('git', ['-C', cwd, ...args], { timeout: 5_000, windowsHide: true })).stdout.trim() || null; }
  catch { return null; }
}
export async function dashboardDetail(runId: string): Promise<KernelDetail> {
  const raw = await api.aiCliKernelStatus({ runId });
  if ('runs' in raw) throw new Error('未回傳指定 run 的狀態');
  const d = parseDetail(raw as unknown as Record<string, unknown>);
  if (d.develop && d.state === 'completed') {
    d.develop.currentBranch = await git(d.develop.repoRoot, ['branch', '--show-current']);
    const head = await git(d.develop.repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    d.develop.defaultBranch = head?.replace(/^origin\//, '') ?? null;
  }
  return d;
}
export async function dashboardActions(runId: string): Promise<KernelAction[]> { return actionsFor(await dashboardDetail(runId)); }

export const dashboardEffects: DashboardEffects = {
  async snapshot() {
    const raw = await api.aiCliKernelStatus();
    if (!('runs' in raw)) throw new Error('未回傳 run 清單');
    return parseSnapshot(raw, api.aiCliKernelTriggersEnabled(), Date.now());
  },
  detail: dashboardDetail,
  async report(runId) {
    const result = await api.aiCliKernelResult({ runId });
    return result.report ?? `這個 run 還沒有報告。\n狀態：${result.state}\n下一步：${result.nextAction}`;
  },
  async triggers() { return api.aiCliKernelTriggersEnabled(); },
  async execute(action) {
    const runId = action.runId ?? '';
    switch (action.id) {
      case 'approve': return api.aiCliKernelApprove({ runId, acknowledgeUnisolated: action.args.includes('--acknowledge-unisolated') });
      case 'cancel': return api.aiCliKernelCancel({ runId });
      case 'rollback': return api.aiCliKernelRollback({ runId, apply: true });
      case 'cleanup': {
        const result = await api.aiCliKernelCleanup({ runId });
        if (!result.worktreeRemoved) throw new Error(result.detail);
        return result;
      }
      case 'archive': return api.aiCliKernelArchiveDone({ runId, note: '由控制面板標記' });
      case 'triggers-on': case 'triggers-off': return api.aiCliKernelTriggersSetEnabled(action.id === 'triggers-on');
      default: throw new Error('不認識的面板操作');
    }
  },
  async createRelease(action) {
    const value = (name: string) => action.args[action.args.indexOf(name) + 1];
    return api.aiCliKernelReleaseCreate({ runId: action.runId!, action: value('--action'), target: value('--target'),
      confirm: value('--confirm'), allowDefaultBranch: action.args.includes('--allow-default-branch') });
  },
  async runRelease(id) {
    const result = api.aiCliKernelReleaseRun({ id });
    if (result.status !== 'succeeded') throw new Error(`${result.status}：${result.detail}；請人工對帳`);
    return result;
  },
};
