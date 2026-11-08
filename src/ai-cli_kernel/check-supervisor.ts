/** Stable command owner across runner death, including Windows cmd.exe lifetime.
 * A deferred command cannot start until its supervisor PID has been journaled and
 * bound to the global test lease. EOF before permission means no command executes.
 * This file deliberately imports only Node builtins (also executable in source tests).
 */
import { spawn } from 'node:child_process';

const [mode, command] = process.argv.slice(2);
let started = false;
function start(): void {
  if (started) return;
  started = true;
  const child = spawn(command, { shell: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.once('error', () => process.exit(127));
  child.once('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}
if (mode === 'wait') {
  process.stdin.setEncoding('utf8');
  let permission = '';
  process.stdin.on('data', chunk => { permission += chunk; if (permission === 'go\n') { process.stdin.pause(); start(); } });
  process.stdin.on('end', () => { if (!started) process.exit(125); });
} else if (mode === 'run' && command) start();
else process.exit(126);
