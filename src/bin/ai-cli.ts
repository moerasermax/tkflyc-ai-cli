#!/usr/bin/env node
import { clearNoticeOnStartup, runUpdateCli } from '../core/updater.js';

/**
 * ★ 任何子命令都**不能**用立即的 `process.exit()`。
 *
 * stdout 是 pipe 時寫入是非同步的：`process.exit()` 會在緩衝區還有資料
 * 時就終止行程，最後一個 NDJSON frame（很可能就是 terminal frame）
 * 會消失。對呼叫端而言那等於「程序結束了但沒說結果」——它只能標
 * unknown，而那是本來可以避免的資訊遺失。
 *
 * ⚠️ 這個判斷原本只套用在 `exec` 與 `update`，理由是「其他子命令印的是
 * 一次性的 JSON」。那個理由是錯的：**一次性不等於小**。macOS 的 pipe
 * buffer 是 8 KiB，而 `ai-cli models` 的 payload 超過它，於是呼叫端拿到
 * 的是在第 8192 位元組被切斷的殘缺 JSON——不報錯、不留痕跡，只是 parse
 * 會炸在一個看起來莫名其妙的位置。CI 在 macos + node 20.19 上抓到，
 * Windows 與 Linux 因為輸出剛好一次到齊而一直看不到。
 *
 * 但也不能單純改成「設 exitCode 就好」：有些子命令會留下計時器/handle
 * 讓事件迴圈不空，那正是當初加 `process.exit()` 的原因。所以是
 * **等排空、再強制退出**，並加一個保險上限，避免對端已關閉時永遠等下去。
 */
const isExec = process.argv[2] === 'exec';
// exec / update 讓事件迴圈自然結束（它們沒有殘留 handle，且要完整吐完串流）。
const drainStdout = isExec || process.argv[2] === 'update';

/** 等 stdout 實際排空之後才強制結束，逾時仍會退出以免卡住。 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    process.exit(code);
  };
  // 對端關閉或 stdout 卡住時不能無限等——寧可截斷也不要永遠不退出。
  const guard = setTimeout(finish, 2000);
  guard.unref?.();
  // 空寫入的 callback 排在既有寫入之後，它被呼叫代表前面的資料已交給 OS。
  process.stdout.write('', async () => {
    clearTimeout(guard);
    if (process.argv[2] === 'run') {
      const { flushJobIdentities } = await import('../core/file-process-service.js');
      await flushJobIdentities();
    }
    finish();
  });
}

async function main(): Promise<number> {
  // 更新 CLI 只載入 updater，避免在替換 dist 或 native addon 時再 import app。
  if (process.argv[2] === 'update') return runUpdateCli(process.argv.slice(3));
  const { runCli } = await import('../app/cli.js');
  // MCP 在 transport 連線後自行處理，不能把 git 放到 handshake 前面。
  // jobs 是唯讀監看，連「已更新」notice 都不在這個入口清掉。
  if (process.argv[2] !== 'mcp' && process.argv[2] !== 'jobs') {
    const state = await clearNoticeOnStartup();
    if (state.reason?.startsWith('ai-cli 已是最新版')) process.stderr.write(`${state.reason}\n`);
  }
  return runCli(process.argv.slice(2));
}

main()
  .then((exitCode) => {
    if (drainStdout) {
      process.exitCode = exitCode;
      return;
    }
    exitAfterFlush(exitCode);
  })
  .catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    if (drainStdout) {
      process.exitCode = 1;
      return;
    }
    exitAfterFlush(1);
  });
