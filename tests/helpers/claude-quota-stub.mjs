/**
 * G4：kernel 的 admission 與 runner 會查 Claude 額度，真的查法是用 PTY 開一個 claude 互動
 * session 送 /usage。測試一律把 CLAUDE_CLI_NAME 指向這裡產生的替身：立刻結束、不輸出，
 * 查詢因此很快得到「量不到」。替身每被呼叫一次就在 log 寫一行，呼叫端可據此確認走的是替身。
 * 只設環境變數，子行程（fork／spawn）照常繼承。
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function installClaudeQuotaStub(tag = 'stub') {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-claude-stub-'));
  const log = join(dir, 'calls.log');
  const body = `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${tag}\n`)});\n`;
  let path;
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude-stub.cjs'), body);
    path = join(dir, 'claude-stub.cmd');
    writeFileSync(path, '@node "%~dp0claude-stub.cjs" %*\r\n');
  } else {
    path = join(dir, 'claude-stub');
    writeFileSync(path, `#!/usr/bin/env node\n${body}`); chmodSync(path, 0o755);
  }
  process.env.CLAUDE_CLI_NAME = path;
  return { path, log, calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line === tag).length : 0 };
}
