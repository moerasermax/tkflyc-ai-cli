/** 持久化 job 驗收 stub；只吃 stdin JSON，完全不呼叫模型。 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const spec = JSON.parse(prompt);
if (spec.mode === 'tree') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  writeFileSync(spec.childFile, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  const agent = process.argv[2] || 'codex';
  const message = spec.mode === 'large' ? 'x'.repeat(1024 * 1024) : '完整輸出：PONG';
  console.log(JSON.stringify(agent === 'claude' ? { type: 'system', session_id: 'stub' } : { type: 'thread.started', thread_id: 'stub' }));
  await new Promise(resolve => setTimeout(resolve, spec.delay ?? 0));
  const text = JSON.stringify(agent === 'claude' ? { type: 'result', result: message, is_error: !!spec.error } : { type: 'item.completed', item: { type: 'agent_message', text: message } });
  // 含切開的 UTF-8；reader 不可整檔重讀或破壞字元。
  const bytes = Buffer.from(text + '\n');
  for (let i = 0; i < bytes.length; i += 8191) {
    if (!process.stdout.write(bytes.subarray(i, i + 8191))) await new Promise(resolve => process.stdout.once('drain', resolve));
  }
  if (spec.stderr) process.stderr.write(spec.stderr);
}
