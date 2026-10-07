#!/usr/bin/env node
/** 不連供應商的 CLI stub；把子行程真正收到的環境寫出，供 worker 標記回歸測試。 */
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.AI_CLI_WORKER_ENV_OUTPUT, JSON.stringify({
  worker: process.env.AI_CLI_WORKER ?? null,
  inherited: process.env.AI_CLI_WORKER_ENV_SENTINEL ?? null,
}));
if (process.argv.includes('models')) {
  console.log('gemini-worker-stub\tWorker stub');
} else {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'worker env captured' } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
  process.stdin.resume();
}
