// 端對端：透過新 server 實跑 claude(pipe) + codex(stdin) + agy(ConPTY)，wait 拿結果。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const logs = [];
const log = (...a) => logs.push(a.join(' '));
process.on('exit', () => writeFileSync('e2e-out.txt', logs.join('\n') + '\n'));

const transport = new StdioClientTransport({
  command: 'node',
  // 相對本檔解析，不要寫死任何機器上的絕對路徑。
  args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
});
const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
log('connected');
const cwd = homedir();

async function runAndWait(model, prompt, timeout) {
  const started = await client.callTool({ name: 'run', arguments: { model, prompt, workFolder: cwd } });
  const { pid } = JSON.parse(started.content[0].text);
  log(`[${model}] started pid=${pid}`);
  const waited = await client.callTool({ name: 'wait', arguments: { pids: [pid], timeout } });
  return JSON.parse(waited.content[0].text)[0];
}

let failures = 0;
// codex 這一顆原本是 gpt-5.4-mini：2026-10-03 已不在 vendor 目錄，當日實測回
// HTTP 400 not supported when using Codex with a ChatGPT account，而這支腳本燒的是
// 真實額度，留著只會穩定失敗。換成 gpt-6-luna——vendor 自己的定位是
// "Fast and affordable model for easier tasks"。（目錄沒有價格欄位，所以這裡
// 只照抄 vendor 的定位，不宣稱它是最便宜的那一顆。）
for (const [model, to] of [['haiku', 90], ['gpt-6-luna', 120], ['agy', 150]]) {
  log(`--- ${model} ---`);
  try {
    const r = await runAndWait(model, 'Reply with exactly one word: PONG', to);
    const o = JSON.stringify(r.agentOutput || r.stdout || '');
    log(`  status=${r.status} exit=${r.exitCode} outLen=${o.length}`);
    log(`  output=${o.slice(0, 200)}`);
    // 三個條件都要看：只看輸出長度的話，「CLI 失敗但吐了一段錯誤訊息」會被判成成功。
    const ok =
      r.status === 'completed' &&
      (r.exitCode === 0 || r.exitCode === undefined) &&
      o.length > 5 &&
      o !== '""' &&
      o !== '{}' &&
      /pong/i.test(o);
    if (!ok) failures += 1;
    log(ok ? '  OK 有輸出' : '  FAIL 無輸出');
  } catch (e) {
    failures += 1;
    log(`  ERROR: ${e.message}`);
  }
}

await client.close();
log(`=== e2e done: ${failures} failed ===`);
// 一定要用 exit code 表態：原本無論結果都 process.exit(0)，
// 任何自動化都會把「三家 CLI 全都沒回應」讀成通過。
process.exit(failures > 0 ? 1 : 0);
