/** 排程只產生命令；明確 apply 才透過可替換的執行介面登記 Windows 工作。 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aiCliKernelMandateShow } from './mandates.js';

export interface KernelScheduleInput { name: string; daily?: string; everyHours?: number; apply?: boolean; remove?: boolean }
export interface KernelScheduleDeps {
  platform: NodeJS.Platform; nodePath: string; cliPath: string;
  execute(file: string, args: string[]): void;
}
const realDeps: KernelScheduleDeps = {
  platform: process.platform, nodePath: process.execPath, cliPath: fileURLToPath(new URL('../bin/ai-cli.js', import.meta.url)),
  execute: (file, args) => { execFileSync(file, args, { windowsHide: true, stdio: 'pipe', timeout: 30000 }); },
};
function windowsQuote(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error('Windows 排程路徑不能含換行');
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/u, match => match + match)}"`;
}
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export function aiCliKernelSchedule(input: KernelScheduleInput, deps: KernelScheduleDeps = realDeps) {
  aiCliKernelMandateShow({ name: input.name }); // 不接受可改變工作名稱或命令的任意字串。
  for (const key of ['apply', 'remove'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必須是布林值`);
  if (input.remove ? input.daily !== undefined || input.everyHours !== undefined : (input.daily === undefined) === (input.everyHours === undefined)) throw new Error('指定 --daily HH:MM 或 --every-hours N；--remove 不能搭配時程');
  if (input.daily !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.daily)) throw new Error('daily 必須是 HH:MM');
  if (input.everyHours !== undefined && (!Number.isInteger(input.everyHours) || input.everyHours < 1 || input.everyHours > 999)) throw new Error('every-hours 必須是 1–999 的整數');
  const taskName = `ai-cli_kernel_${input.name}`;
  if (deps.platform !== 'win32') {
    const command = [deps.nodePath, deps.cliPath, 'kernel', 'trigger', input.name].map(shellQuote).join(' ').replace(/%/g, '\\%');
    const cron = input.remove ? `# 從 crontab 移除帶有 # ${taskName} 的行`
      : input.daily ? `${Number(input.daily.slice(3))} ${Number(input.daily.slice(0, 2))} * * * ${command} # ${taskName}`
      : `0 * * * * [ $(( $(date +\\%s) / 3600 \\% ${input.everyHours} )) -eq 0 ] && ${command} # ${taskName}`;
    return { taskName, applied: false, command: cron, file: null, args: [] as string[] };
  }
  const taskCommand = [deps.nodePath, deps.cliPath, 'kernel', 'trigger', input.name].map(windowsQuote).join(' ');
  const args = input.remove ? ['/Delete', '/TN', taskName, '/F']
    : ['/Create', '/TN', taskName, ...(input.daily ? ['/SC', 'DAILY', '/ST', input.daily] : ['/SC', 'HOURLY', '/MO', String(input.everyHours)]), '/TR', taskCommand];
  if (input.apply === true) {
    if (process.env.AI_CLI_WORKER === '1') throw new Error('worker 不能登記或移除真實排程');
    deps.execute('schtasks', args);
  }
  return { taskName, applied: input.apply === true, command: ['schtasks', ...args.map(windowsQuote)].join(' '), file: 'schtasks', args };
}
