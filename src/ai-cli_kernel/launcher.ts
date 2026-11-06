/**
 * Windows 短命 launcher：交回 runner PID 後就退出。Claude Code 退出時會對 MCP server 做
 * tree kill，runner 必須脫離那棵行程樹才活得下來。作法與 core/job-launcher.ts 相同。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2];
const report = (value: unknown) => writeFileSync(join(directory, 'launcher.json'), JSON.stringify(value) + '\n', { mode: 0o600 });
try {
  const runner = spawn(process.execPath, [fileURLToPath(new URL('./runner.js', import.meta.url)), directory], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env, detached: true, stdio: 'ignore', windowsHide: true,
  });
  runner.once('error', error => { report({ error: error.message }); process.exitCode = 1; });
  runner.once('spawn', () => {
    try { report({ pid: runner.pid, launcherPid: process.pid }); }
    catch (error) { console.error('ai-cli_kernel launcher:', error); process.exitCode = 1; }
    runner.unref();
  });
} catch (error) {
  report({ error: (error as Error).message }); process.exitCode = 1;
}
