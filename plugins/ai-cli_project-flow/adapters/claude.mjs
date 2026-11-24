/** Claude Code command hook。 */
import { handleEvent, hookOutput, readStdin } from '../lib/flow.mjs';

try {
  const payload = await readStdin();
  const event = process.argv[2] ?? payload.hook_event_name;
  process.stdout.write(JSON.stringify(hookOutput(event, await handleEvent(event, payload))) + '\n');
} catch {
  // 無效 payload 或本機錯誤時放行。
  process.stdout.write('{}\n');
}
