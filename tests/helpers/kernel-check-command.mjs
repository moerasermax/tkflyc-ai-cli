/** A local command with a filesystem barrier and an independent overlap detector. */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [control, runId] = process.argv.slice(2);
const busy = join(control, 'busy');
let fd;
try { fd = openSync(busy, 'wx'); }
catch {
  const previous = JSON.parse(readFileSync(busy, 'utf8'));
  let alive = true;
  try { process.kill(previous.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
  if (!alive) { rmSync(busy); fd = openSync(busy, 'wx'); }
  else { writeFileSync(join(control, 'overlap'), runId); console.error(`overlap: ${runId}, live pid ${previous.pid}`); process.exit(91); }
}
writeFileSync(fd, JSON.stringify({ pid: process.pid, runId }));
writeFileSync(join(control, `started-${runId}`), 'started');
const timer = setInterval(() => {
  if (!existsSync(join(control, `release-${runId}`))) return;
  clearInterval(timer); closeSync(fd); rmSync(busy); process.exit(0);
}, 10);
setTimeout(() => { closeSync(fd); rmSync(busy, { force: true }); process.exit(92); }, 45000).unref();
