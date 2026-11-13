/**
 * 子孫追蹤驗收用的假 worker：不呼叫任何模型，只會在背景啟動程序。argv[2] 是一份 JSON 規格檔的路徑。
 *
 *   mode: 'child'  → 啟動一個長時間存活的孫程序，把它的 pid 寫進 childFile，等 lingerMs 後自己結束。
 *   mode: 'orphan' → 啟動一個中間程序（mode: 'mid'），自己一直活著。
 *   mode: 'mid'    → 啟動長時間存活的程序，pid 寫進 childFile，等 lingerMs 後結束：留下的程序在 worker 還活著時就成了孤兒。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// Windows 上 node 會把非 detached 的子程序放進「父程序結束就一起殺掉」的 job object，要 detached 才活得下來。
// POSIX 刻意不 detached：留在 worker 的 process group 裡，才測得到 group 那條規則。
const background = args => {
  const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  child.unref();
  return child;
};
if (spec.mode === 'orphan') {
  const midSpec = `${process.argv[2]}.mid.json`;
  writeFileSync(midSpec, JSON.stringify({ ...spec, mode: 'mid' }));
  background([fileURLToPath(import.meta.url), midSpec]);
  setInterval(() => {}, 1000);
} else {
  const child = background(['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
  writeFileSync(spec.childFile, String(child.pid));
  setTimeout(() => process.exit(0), spec.lingerMs ?? 0);
}
