/** Grok native CLI stub；絕不載入 vendor executable。 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'models') {
  const mode = process.env.GROK_STUB_DISCOVERY;
  if (mode === 'timeout') setInterval(() => {}, 1000);
  else if (mode === 'error') { console.error('Please log in first'); process.exitCode = 1; }
  else if (mode === 'unauthenticated') console.log('Default model: grok-4.7\nPlease log in first');
  else console.log('Default model: grok-4.7\nAvailable models:\n* grok-4.7 (default)\n- grok-4.7-build-fast\n- grok-4.6\n- grok-4.5');
} else {
  const value = flag => args[args.indexOf(flag) + 1];
  const spec = JSON.parse(readFileSync(value('--prompt-file'), 'utf8'));
  if (spec.capture) writeFileSync(spec.capture, JSON.stringify({ args, worker: process.env.AI_CLI_WORKER, rules: value('--rules') }));
  console.log(JSON.stringify({ type: 'system', session_id: 'grok-stub-session' }));
  // 祖先身分查詢速度不固定；重啟測試先確認 running，再明確放行完成。
  if (spec.release) {
    const deadline = Date.now() + 60000;
    while (!existsSync(spec.release)) {
      if (Date.now() >= deadline) throw new Error('Grok stub release deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  await new Promise(resolve => setTimeout(resolve, spec.delay ?? 0));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'grok-stub-session', message: { content: [{ type: 'text', text: 'stub assistant' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: spec.subtype ?? (spec.error ? 'error_during_execution' : 'success'),
    is_error: !!spec.error, duration_ms: 7631, num_turns: 1, result: spec.error ? 'stub error' : '完整輸出：PONG',
    stop_reason: spec.stop_reason ?? 'end_turn', total_cost_usd: 0.02655808,
    usage: { input_tokens: 17306, output_tokens: 602, cache_read_input_tokens: 1664, cache_creation_input_tokens: 0 },
    modelUsage: {}, session_id: 'grok-stub-session', uuid: 'stub-uuid' }));
}
