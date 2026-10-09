/** 沿祖先鏈只跳套件啟動器；Node 本身也可能是 Claude Code 主導者。 */
import { lookupPrincipalIdentities, type IdentityLookup, type ProcessIdentity } from './live-jobs.js';

export function identityOnly(identity: ProcessIdentity): ProcessIdentity {
  const { commandLine: _commandLine, ...safe } = identity;
  return safe;
}
function shellCommand(identity: ProcessIdentity): { program: string; args: string } | undefined {
  if (!/^(?:cmd|sh|bash|dash|zsh)(?:\.exe)?$/i.test(identity.name)) return;
  let command = identity.commandLine?.match(/(?:\/c|-c)\s+(.+)$/i)?.[1].trim();
  if (!command) return;
  // cmd /s /c 的外層雙引號、POSIX sh -c 的整句引號，與含空格的 executable 引號分開。
  const quote = command[0];
  if ((quote === '"' || quote === "'") && command.endsWith(quote)) {
    const end = command.indexOf(quote, 1), content = command.slice(1, -1);
    if (command[1] === quote || (end === command.length - 1 && !/^(?:(?:[a-z]:[\\/]|[\\/])(?:[^\r\n]*[\\/])?)?(?:npx|npm|ai-cli(?:-mcp)?)(?:\.cmd)?$/i.test(content))) command = content;
  }
  command = command.replace(/^exec\s+/, '');
  const match = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(.*)$/);
  if (!match) return;
  return { program: (match[1] ?? match[2] ?? match[3]).split(/[\\/]/).at(-1)!, args: match[4].trim() };
}
export function isPackageLauncher(identity: ProcessIdentity): boolean {
  const command = identity.commandLine ?? '';
  if (/^(?:node|nodejs)(?:\.exe)?$/i.test(identity.name)) {
    return /(?:^|[\s"'\\/])npx-cli\.js(?:[\s"']|$)/i.test(command)
      || /(?:^|[\s"'\\/])npm-cli\.js["']?\s+(?:exec|x|run|run-script|test)(?:\s|$)/i.test(command);
  }
  const shell = shellCommand(identity);
  return !!shell && (/^npx(?:\.cmd)?$/i.test(shell.program) || (/^npm(?:\.cmd)?$/i.test(shell.program) && /^(?:exec|x|run|run-script|test)(?:\s|$)/i.test(shell.args)));
}
export async function resolvePrincipal(parentPid: number, lookup: IdentityLookup = lookupPrincipalIdentities): Promise<ProcessIdentity | null> {
  const seen = new Set<number>();
  for (let depth = 0; depth < 16 && parentPid > 0 && !seen.has(parentPid); depth++) {
    seen.add(parentPid);
    const parent = (await lookup([parentPid])).get(parentPid);
    if (!parent) return null;
    if (/^(?:node|nodejs|cmd|sh|bash|dash|zsh)(?:\.exe)?$/i.test(parent.name) && !parent.commandLine?.trim()) return null;
    // npm exec 也會在 npm node 與 server 中插入 `sh -c ai-cli-mcp`／cmd shim。
    // 只有命令精準指向本套件、且上層確實是 npm/npx 啟動器才可跳過。
    const shell = shellCommand(parent);
    const serverShim = shell && /^ai-cli(?:-mcp)?(?:\.cmd)?$/i.test(shell.program) && !shell.args;
    // npm run/test 的 script shell 命令是 script 本文，必須由直屬 npm-cli 父行程佐證。
    const shimLauncher = shell && parent.ppid ? (await lookup([parent.ppid])).get(parent.ppid) : undefined;
    const scriptShell = shimLauncher && /^(?:node|nodejs)(?:\.exe)?$/i.test(shimLauncher.name)
      && /(?:^|[\s"'\\/])npm-cli\.js["']?\s+(?:run|run-script|test)(?:\s|$)/i.test(shimLauncher.commandLine ?? '');
    if (!isPackageLauncher(parent) && !(shimLauncher && ((serverShim && isPackageLauncher(shimLauncher)) || scriptShell))) return identityOnly(parent);
    parentPid = parent.ppid ?? 0;
  }
  return null;
}
