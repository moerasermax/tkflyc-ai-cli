/** jobs 唯讀 CLI：聚合 MCP 快照與 detached 狀態，每兩秒重畫一次。 */
import { FileProcessService } from '../core/file-process-service.js';
import { jobStateDir, readLiveJobs, shortText, JOB_REFRESH_MS, type LiveJob } from '../core/live-jobs.js';

export const JOBS_HELP_TEXT = `Usage: ai-cli jobs [--watch] [--json] [--running]

List jobs across all sessions sharing AI_CLI_STATE_DIR.
  --watch     Refresh every 2 seconds; Ctrl+C exits
  --json      Print a JSON array (watch emits one compact array per refresh)
  --running   Show only running jobs
  --help, -h  Show this help message
`;

/** CJK／全形與 emoji 以兩格估算；控制字元已由 shortText 移除。 */
export function displayWidth(text: string): number {
  return Array.from(text).reduce((width, character) => {
    const code = character.codePointAt(0)!;
    if (/\p{Mark}/u.test(character)) return width;
    return width + ((code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7ff || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300)) ? 2 : 1);
  }, 0);
}
function cell(value: string, width: number, sanitize = true): string {
  const text = sanitize ? shortText(value, 1000) : value;
  let output = '';
  for (const character of text) {
    if (displayWidth(output + character) > width) break;
    output += character;
  }
  return output + ' '.repeat(Math.max(0, width - displayWidth(output)));
}
export function formatJobsTable(jobs: LiveJob[], columns = 120, frame = 0): string {
  const width = Math.max(1, Math.floor(columns) - 1); // 避免最後一格觸發 terminal autowrap。
  const ideal = [2, 12, 26, 40, 8, 30, 20];
  const minimum = [1, 4, 5, 4, 4, 4, 4];
  const sizes = [...ideal];
  while (sizes.reduce((sum, size) => sum + size, 0) + 6 > width) {
    const index = sizes.reduce((best, size, i) => size - minimum[i] > sizes[best] - minimum[best] ? i : best, 0);
    if (sizes[index] <= minimum[index]) break;
    sizes[index]--;
  }
  const row = (values: string[]) => cell(values.map((value, i) => cell(value, sizes[i])).join(' '), width, false).trimEnd();
  const lines = [row(['', 'AGENT', 'MODEL (EFFORT)', 'TASK', 'ELAPSED', 'LAST EVENT', 'DISPATCHER'])];
  for (const job of jobs) {
    const seconds = Math.max(0, Math.floor(job.elapsedSec));
    const symbol = job.status === 'running' ? ['◐', '◓', '◑', '◒'][frame % 4] : job.status === 'completed' ? '✓' : job.status === 'lost' ? '?' : '✗';
    lines.push(row([symbol, job.agent, `${job.model || 'default'}${job.reasoning_effort ? ` (${job.reasoning_effort})` : ''}`,
      job.task, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, job.lastEvent || '—',
      `${job.identityVerified === false ? '[unverified] ' : ''}${job.dispatcher.parentName || 'unknown'}+${job.dispatcher.pid || '?'}`]));
  }
  if (!jobs.length) lines.push(cell('No jobs.', width).trimEnd());
  return lines.join('\n') + '\n';
}

// watch 保留檔案輸出解碼器的 offset，避免每輪從頭重掃大型 log。
const fileReaders = new Map<string, FileProcessService>();
export async function listJobs(): Promise<LiveJob[]> {
  const stateDir = jobStateDir();
  let file = fileReaders.get(stateDir);
  if (!file) { file = new FileProcessService({ stateDir, cliPaths: {}, readOnly: true }); fileReaders.set(stateDir, file); }
  const [mcp, cli] = await Promise.all([readLiveJobs(stateDir), file.listJobSummaries()]);
  return [...mcp, ...cli].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.pid - b.pid);
}
export interface JobsDeps {
  stdout: (text: string) => void; stderr: (text: string) => void;
  list: () => Promise<LiveJob[]>; columns: () => number; isTTY: () => boolean;
}
export async function runJobs(args: string[], overrides: Partial<JobsDeps> = {}): Promise<number> {
  const deps: JobsDeps = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
    list: listJobs, columns: () => process.stdout.columns || 120, isTTY: () => !!process.stdout.isTTY, ...overrides };
  if (args.includes('--help') || args.includes('-h')) { deps.stdout(JOBS_HELP_TEXT); return 0; }
  if (args.some(arg => !['--watch', '--json', '--running'].includes(arg))) { deps.stderr('Unknown jobs option\n'); return 1; }
  const watch = args.includes('--watch');
  const json = args.includes('--json');
  let stopped = false;
  let wake: (() => void) | undefined;
  const onStop = () => { stopped = true; wake?.(); };
  if (watch) { process.on('SIGINT', onStop); process.on('SIGTERM', onStop); }
  try {
    let frame = 0;
    do {
      const refreshStarted = Date.now();
      let jobs = await deps.list();
      if (stopped) break;
      if (args.includes('--running')) jobs = jobs.filter(job => job.status === 'running');
      if (json) deps.stdout(JSON.stringify(jobs, null, watch ? undefined : 2) + '\n');
      else deps.stdout((watch && deps.isTTY() ? '\x1b[2J\x1b[H' : '') + formatJobsTable(jobs, deps.columns(), frame++));
      if (!watch || stopped) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.max(0, JOB_REFRESH_MS - (Date.now() - refreshStarted)));
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    } while (!stopped);
    return 0;
  } catch (error) { deps.stderr(`jobs: ${(error as Error).message}\n`); return 1; }
  finally { if (watch) { process.off('SIGINT', onStop); process.off('SIGTERM', onStop); } }
}
