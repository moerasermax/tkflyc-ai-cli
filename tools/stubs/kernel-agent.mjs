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
const kind = prompt.includes('K-probe-') ? 'probe' : prompt.includes('你是 ai-cli_kernel 的決策者') ? 'decide' : prompt.includes('開發工作者') ? 'write' : 'worker';
if (process.env.KERNEL_STUB_LOG) {
  appendFileSync(process.env.KERNEL_STUB_LOG, `${kind}\n`);
  // 記下實際拿到的權限旗標：寫入權是不是真的只給了 write，要看這裡，不是看 kernel 怎麼說。
  appendFileSync(process.env.KERNEL_STUB_LOG, `args:${kind}:${process.argv.includes('--dangerously-bypass-approvals-and-sandbox') ? 'bypass' : 'strict'}\n`);
}

const emit = value => console.log(JSON.stringify(value));
const finish = text => {
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } });
};
emit({ type: 'thread.started', thread_id: 'stub-thread' });

if (kind === 'probe') {
  if (mode === 'probe-fail') writeFileSync('probe-shell.txt', 'x');
  // 格式取自 codex-cli 0.167.0：shell 的 OS 拒絕在 stdout，apply_patch 拒絕仍在 stderr router。
  const refuse = text => process.stderr.write(`2026-11-06T00:00:00.000000Z ERROR codex_core::tools::router: error=${text}\n`);
  const patch = 'patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings';
  const shell = target => emit({ type: 'item.completed', item: {
    type: 'command_execution', command: `echo x > "${target}"`,
    aggregated_output: `Access to the path '${target}' is denied`, exit_code: 1,
  } });
  // probe-flaky：第一次像真實模型那樣拒絕嘗試，第二次才真的試。
  const flakyFirst = mode === 'probe-flaky' && !existsSync(process.env.KERNEL_STUB_FLAG);
  if (flakyFirst) writeFileSync(process.env.KERNEL_STUB_FLAG, 'x');
  if (flakyFirst) { /* 什麼都沒試 */ }
  else if (mode === 'probe-partial') shell('probe-shell.txt');
  else if (mode === 'probe-readonly-word') emit({ type: 'item.completed', item: { type: 'command_execution', command: 'rg read-only README.txt', aggregated_output: 'read-only sandbox rejected', exit_code: 0 } });
  else if (mode === 'probe-patch-only') { refuse(patch); refuse(patch); refuse(patch); refuse(patch); }
  else if (mode !== 'probe-silent') { refuse(patch); shell('probe-shell.txt'); shell('probe-node.txt'); shell(prompt.match(/outside-[0-9a-f]+\.txt/)?.[0] ?? 'outside.txt'); }
  finish('全部都沒有成功。\nPROBE_DONE');
} else if (kind === 'write') {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.KERNEL_STUB_DELAY_MS ?? 0)));
  // dev-fix：第一次寫出會讓測試失敗的內容，第二次才修好。
  const first = mode === 'dev-fix' && !existsSync('feature.txt');
  if (mode === 'dev-out-of-scope') writeFileSync('outside.txt', 'x');
  else if (mode !== 'dev-no-change') writeFileSync('feature.txt', first ? 'bad\n' : 'good\n');
  finish('## 結論\n這是 stub 改出來的結果，內容要足夠通過長度檢查，所以多寫幾句。\n## 改動\n加了 feature.txt。\n## 尚待確認\n無');
} else if (kind === 'decide' && prompt.includes('kernel 為這個任務開的 worktree')) {
  finish(JSON.stringify({ action: 'plan', reason: '一步就夠', steps: [{ id: 's1', title: '加功能', prompt: '加 feature.txt', mode: 'write' }], report_step: 's1' }));
} else if (kind === 'decide') {
  finish(JSON.stringify({ action: 'plan', reason: '一步就夠', steps: [{ id: 's1', title: '讀 README', prompt: '讀 README.md 並回報' }], report_step: 's1' }));
} else {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.KERNEL_STUB_DELAY_MS ?? 0)));
  finish('## 結論\n這是 stub 產出的報告，內容要足夠通過長度檢查，所以多寫幾句說明：這份報告沒有經過任何模型，只是用來驗證 kernel 的流程。\n\n## 發現\n- README 第一行存在：README.md:1\n\n## 尚待確認\n無\n');
}
