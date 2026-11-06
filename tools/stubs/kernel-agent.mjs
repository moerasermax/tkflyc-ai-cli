#!/usr/bin/env node
/**
 * ai-cli_kernel 驗收 stub：假裝是 codex，不呼叫任何模型。
 * 用環境變數控制行為，並把每次被啟動的種類記到 KERNEL_STUB_LOG，測試才數得出有沒有重派。
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  console.log(process.env.KERNEL_STUB_VERSION ?? 'kernel-stub 1.0.0');
  process.exit(0);
}
// 額度查詢會來問 app-server 或開 TUI；stub 一律說不會，讓它變成量不到。
if (!process.argv.includes('exec')) process.exit(1);

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const mode = process.env.KERNEL_STUB_MODE ?? 'normal';
const kind = prompt.includes('K-probe-') ? 'probe' : prompt.includes('你是 ai-cli_kernel 的決策者') ? 'decide' : 'worker';
if (process.env.KERNEL_STUB_LOG) appendFileSync(process.env.KERNEL_STUB_LOG, `${kind}\n`);

const emit = value => console.log(JSON.stringify(value));
const finish = text => {
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } });
};
emit({ type: 'thread.started', thread_id: 'stub-thread' });

if (kind === 'probe') {
  if (mode === 'probe-fail') writeFileSync('probe-shell.txt', 'x');
  // 格式取自 codex-cli 0.166.0 在 Windows 的真實輸出。
  const refuse = text => process.stderr.write(`2026-11-06T00:00:00.000000Z ERROR codex_core::tools::router: error=${text}\n`);
  const patch = 'patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings';
  const shell = target => `exec_command failed: CreateProcess { message: "Rejected(\\"'x' > ${target}\\" rejected: blocked by policy\\")" }`;
  // probe-flaky：第一次像真實模型那樣拒絕嘗試，第二次才真的試。
  const flakyFirst = mode === 'probe-flaky' && !existsSync(process.env.KERNEL_STUB_FLAG);
  if (flakyFirst) writeFileSync(process.env.KERNEL_STUB_FLAG, 'x');
  if (flakyFirst) { /* 什麼都沒試 */ }
  else if (mode === 'probe-partial') refuse(shell('probe-shell.txt'));
  else if (mode === 'probe-readonly-word') emit({ type: 'item.completed', item: { type: 'command_execution', command: 'rg read-only README.txt', aggregated_output: 'read-only sandbox rejected', exit_code: 0 } });
  else if (mode === 'probe-patch-only') { refuse(patch); refuse(patch); refuse(patch); refuse(patch); }
  else if (mode !== 'probe-silent') { refuse(patch); refuse(shell('probe-shell.txt')); refuse(shell('probe-node.txt')); refuse(shell(prompt.match(/outside-[0-9a-f]+\.txt/)?.[0] ?? 'outside.txt')); }
  finish('全部都沒有成功。\nPROBE_DONE');
} else if (kind === 'decide') {
  finish(JSON.stringify({ action: 'plan', reason: '一步就夠', steps: [{ id: 's1', title: '讀 README', prompt: '讀 README.md 並回報' }], report_step: 's1' }));
} else {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.KERNEL_STUB_DELAY_MS ?? 0)));
  finish('## 結論\n這是 stub 產出的報告，內容要足夠通過長度檢查，所以多寫幾句說明：這份報告沒有經過任何模型，只是用來驗證 kernel 的流程。\n\n## 發現\n- README 第一行存在：README.md:1\n\n## 尚待確認\n無\n');
}
