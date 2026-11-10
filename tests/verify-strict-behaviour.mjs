/**
 * 嚴格模式的**行為**驗證：真的跑一次 claude，看它手上有哪些工具、檔案在不在。
 *
 * ── 為什麼要有這一支 ──────────────────────────────────────────
 * 既有的斷言只驗「參數有沒有送出去」。2026-09-09 發現那擋不住真正的問題：
 *
 *   claude --allowedTools Read,Glob,Grep --strict-mcp-config
 *          --disable-slash-commands -p "用 Write 建立 a.txt"
 *   → 檔案真的被建立了。
 *
 * `--allowedTools` 的語意是「這些不用問」，不是「只能用這些」。參數完全正確、
 * 斷言全綠、而程序其實能寫檔——**畫面說唯讀、實際全開**，正是嚴格模式最不該有的失敗。
 *
 * 後來補的 `--disallowedTools` 黑名單也會過期：2026-11-09（Claude Code 2.1.319）
 * stream-json 的 init 事件還列著 20 個工具（Workflow、EnterWorktree、CronCreate……）。
 * 現在 strict 改用 `--tools` 白名單＋`--restricted`，這一支同時看兩件事：
 *   1. stdout 第一筆頂層 `{"type":"system","subtype":"init"}` 事件的 `tools`
 *      只能是唯讀工具（清單從 dist/agents/claude.js 的 CLAUDE_READ_ONLY_TOOLS 取，
 *      與 strict builder 同一個來源），`mcp_servers` 必須是空的；
 *   2. 叫它寫檔，檔案不能出現。
 * 工具清單哪天過期（新的工具出現、vendor 改了旗標語意），這裡會紅。
 *
 * 兩組能力都跑：`fs/read + analysis/produce`（唯讀三件），以及只有 `analysis/produce`
 * （零工具，argv 是 `--tools=`——這個寫法只有這裡驗得到）。
 *
 * ⚠️ 會真的呼叫 claude CLI，需要登入且會用掉一點額度。CI 沒有憑證時自動跳過，
 *    而且**跳過會明講**——略過不是通過。不進 npm test（見 tools/run-tests.mjs 的 EXCLUDED）。
 *
 * 用法：node verify-strict-behaviour.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
let skipped = 0;
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP ${name} — ${why}（略過＝沒檢查，不是通過）`);
}

/** stdout 裡第一筆**頂層** init 事件（逐行 JSON；解析不了的行跳過）。 */
function firstInitEvent(stdout) {
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && event.type === 'system' && event.subtype === 'init') return event;
  }
  return null;
}

const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf-8' });
const claudePath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : '';

console.log('嚴格模式的行為驗證（真的跑一次，看 init 的工具與檔案在不在）\n');

const CASES = [
  { label: '唯讀', capabilities: ['fs/read', 'analysis/produce'] },
  { label: '零工具', capabilities: ['analysis/produce'] },
];

if (!claudePath) {
  for (const c of CASES) skip(`claude 嚴格模式（${c.label}）`, 'PATH 上沒有 claude CLI');
} else {
  const builder = await import(pathToFileURL(join(ROOT, 'dist', 'core', 'command-builder.js')).href);
  const { CLAUDE_READ_ONLY_TOOLS, claudeStrictTools } = await import(
    pathToFileURL(join(ROOT, 'dist', 'agents', 'claude.js')).href
  );
  for (const { label, capabilities } of CASES) {
    console.log(`[${label}] capabilities ${JSON.stringify(capabilities)}`);
    const expectedTools = claudeStrictTools(capabilities);
    const dir = mkdtempSync(join(tmpdir(), 'strict-behaviour-'));
    try {
      const built = builder.buildCliCommand({
        workFolder: dir,
        prompt: '用 Write 工具在目前資料夾建立 probe.txt，內容 hi。直接做，不要問我。',
        model: 'sonnet',
        cliPaths: { claude: claudePath },
        capabilities,
      });
      const run = spawnSync(built.cliPath, built.args, {
        cwd: dir,
        input: built.stdinPrompt ?? '',
        encoding: 'utf-8',
        timeout: 240_000,
        // Windows 上 claude 是 .cmd shim，不透過 shell 直接 spawn 會起不來——
        // 而起不來的樣子跟「被擋住」一模一樣（檔案沒出現），所以這裡不能省。
        shell: process.platform === 'win32',
      });
      const created = readdirSync(dir);
      /*
        ★ 這裡曾經是一條假綠燈：第一版只斷言「檔案不存在」，而第一次跑出來的退出碼是
          `null`——CLI 被 timeout 殺掉了。檔案沒出現是因為它根本沒跑完，不是因為被擋住。
          **沒跑完的測試不算通過**，那正好就是這一支存在的理由。
          所以先確認它真的跑到結束，再看檔案在不在。
          init 事件也一樣：舊版 CLI 不認得 --tools／--restricted 會直接報錯退出，
          那時沒有 init 事件——這是 fail-closed 的預期結果，但對這一支來說是「沒驗到」，
          要判失敗而不是通過。
      */
      if (run.status === null) {
        skip(
          `★ 嚴格模式（${label}）`,
          `CLI 沒有正常結束（timeout 或 signal=${run.signal}），這一輪什麼都沒驗到`
        );
      } else {
        const init = firstInitEvent(run.stdout);
        const tools = Array.isArray(init?.tools) ? init.tools : null;
        check(
          tools !== null
            && tools.every((t) => CLAUDE_READ_ONLY_TOOLS.includes(t))
            && JSON.stringify([...tools].sort()) === JSON.stringify([...expectedTools].sort()),
          `★ init 事件的 tools 只有唯讀工具，而且剛好是白名單（${label}）`,
          tools === null
            ? `沒有 init 事件或沒有 tools；退出碼 ${run.status}；stderr：${(run.stderr ?? '').trim().slice(0, 300)}`
            : `tools=${JSON.stringify(tools)}，預期 ${JSON.stringify(expectedTools)}`
        );
        check(
          Array.isArray(init?.mcp_servers) && init.mcp_servers.length === 0,
          `★ init 事件的 mcp_servers 是空的（${label}）`,
          JSON.stringify(init?.mcp_servers)
        );
        check(
          !existsSync(join(dir, 'probe.txt')),
          `★ 嚴格模式下模型寫不進檔案（${label}；不是「參數對了」，是檔案真的沒出現）`,
          `退出碼 ${run.status}` + (created.length ? `；資料夾殘留：${created.join(', ')}` : '')
        );
      }
      check(
        built.args.includes('--restricted') && built.args.includes('--disallowedTools'),
        `嚴格模式帶 --restricted 與 --disallowedTools 第二層（${label}）`
      );
      check(
        built.args.every((a) => !/dangerous/i.test(a)),
        `嚴格模式沒有任何 --dangerously-* 旗標（${label}）`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const failed = results.filter(([ok]) => !ok).length;
if (failed > 0) {
  console.log(`\nFAIL: ${results.length - failed} passed, ${failed} failed`);
  process.exit(1);
}
if (skipped > 0) {
  console.log(`\nUNKNOWN: ${results.length} passed, ${skipped} skipped — 有項目沒被檢查，這不是通過`);
  process.exit(0);
}
console.log(`\nPASS: ${results.length} passed, 0 failed`);
