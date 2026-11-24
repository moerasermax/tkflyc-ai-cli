/** Codex command hook。支援事件參數及 stdin／argv payload。 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { handleEvent, hookOutput, readStdin } from '../lib/flow.mjs';

try {
  const args = process.argv.slice(2);
  const eventArg = ['SessionStart', 'UserPromptSubmit', 'Stop'].includes(args[0]) ? args.shift() : undefined;
  if (args[0] === '--ai-cli-project-flow') args.shift();
  const payload = args.length ? JSON.parse(args[0]) : await readStdin();
  const event = eventArg ?? payload.hook_event_name;
  const installedSkillPath = join(homedir(), '.agents', 'skills', 'project-flow', 'SKILL.md');
  const result = await handleEvent(event, payload, { installedSkillPath });
  process.stdout.write(JSON.stringify(hookOutput(event, result)) + '\n');
} catch {
  // 無效 payload 或本機錯誤時放行。
  process.stdout.write('{}\n');
}
