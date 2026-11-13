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
/** 注入邊界只替換 I/O；正式面板與測試走完全相同的 API 參數組裝。 */
export function createDashboardEffects(kernel: typeof api = api, readGit: typeof git = git, now: () => number = Date.now): DashboardEffects {
  async function detail(runId: string): Promise<KernelDetail> {
    const raw = await kernel.aiCliKernelStatus({ runId });
    if ('runs' in raw) throw new Error('未回傳指定 run 的狀態');
    const d = parseDetail(raw as unknown as Record<string, unknown>);
    if (d.develop && d.state === 'completed') {
      d.develop.currentBranch = await readGit(d.develop.repoRoot, ['branch', '--show-current']);
      const head = await readGit(d.develop.repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      d.develop.defaultBranch = head?.replace(/^origin\//, '') ?? null;
    }
    return d;
  }
  return {
    async snapshot() {
      const raw = await kernel.aiCliKernelStatus();
      if (!('runs' in raw)) throw new Error('未回傳 run 清單');
      return parseSnapshot(raw, kernel.aiCliKernelTriggersEnabled(), now());
    },
    detail,
    async report(runId) {
      const result = await kernel.aiCliKernelResult({ runId });
      return result.report ?? `這個 run 還沒有報告。\n狀態：${result.state}\n下一步：${result.nextAction}`;
    },
    async triggers() { return kernel.aiCliKernelTriggersEnabled(); },
    async execute(action) {
      const runId = action.runId ?? '';
      if(action.id==='cancel'||action.id==='cleanup'){
        for(const key of Object.keys(action))if(key!=='confirmedCommit'&&/containment|confirm|scope|requestId/i.test(key))throw Error('dashboard rejects containment exception fields');
        if((action.args??[]).some(arg=>arg.startsWith('--')))throw Error('dashboard cancel/cleanup rejects exception flags');
      }
      switch (action.id) {
        case 'approve': return kernel.aiCliKernelApprove({ runId, acknowledgeUnisolated: action.args.includes('--acknowledge-unisolated') });
        case 'cancel': return kernel.aiCliKernelCancel({ runId });
        case 'rollback': return kernel.aiCliKernelRollback({ runId, apply: true });
        case 'cleanup': {
          const result = await kernel.aiCliKernelCleanup({ runId });
          if (!result.worktreeRemoved) throw new Error(result.detail);
          return result;
        }
        case 'archive': return kernel.aiCliKernelArchiveDone({ runId, note: '由控制面板標記' });
        case 'triggers-on': case 'triggers-off': return kernel.aiCliKernelTriggersSetEnabled(action.id === 'triggers-on');
        default: throw new Error('不認識的面板操作');
      }
    },
    async createRelease(action) {
      const value = (name: string) => action.args[action.args.indexOf(name) + 1];
      return kernel.aiCliKernelReleaseCreate({ runId: action.runId!, action: value('--action'), target: value('--target'),
        confirm: value('--confirm'), allowDefaultBranch: action.args.includes('--allow-default-branch') });
    },
    async runRelease(id) {
      const result = kernel.aiCliKernelReleaseRun({ id });
      if (result.status !== 'succeeded') throw new Error(`${result.status}：${result.detail}；請人工對帳`);
      return result;
    },
  };
}
export const dashboardEffects = createDashboardEffects();
export const dashboardDetail = dashboardEffects.detail;
export async function dashboardActions(runId: string): Promise<KernelAction[]> {
  const [detail, status] = await Promise.all([dashboardDetail(runId), api.aiCliKernelStatus()]);
  const activeRuns = 'activeRuns' in status ? status.activeRuns : [];
  return actionsFor(detail).map(action => ({ ...action, activeRuns }));
}
