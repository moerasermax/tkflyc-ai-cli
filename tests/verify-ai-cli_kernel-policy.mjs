/** D1: invert only the three authorized policy edits, then verify every other byte (LF space). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const originalHash = 'ff8cf780ed7108a2c1019878ca754e81eeba149ee7434fb190260001b18ab0c9';
const text = readFileSync(new URL('../tools/hooks/aicli-model-policy.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rule13 = '13. ai-cli_kernel 同時最多 3 個 run，同一個 repo 一次 1 個（以 git common dir 判斷，worktree 和同一個 origin 的 clone 都算同一個）；Claude 週額度剩不到 10% 或量不到時退回全機 1 個；Codex 剩不到 20% 或量不到時，不同時跑兩個用到 Codex 的 run。這些由 kernel 在開工時自己擋，上限只能由人調整，MCP 改不了（使用者 2026-11-08 決定）。';
const edits = [
  ['【ai-cli 精簡派工政策 v2.3（2026-11-08）】', '【ai-cli 精簡派工政策 v2.2（2026-10-22）】'],
  ['剩不到 20% 不同時跑兩個 Codex 工作', '剩不到 50% 不同時跑兩個 Codex 工作'],
  ['（使用者 2026-10-14 決定；並行門檻 2026-11-08 由 50% 改為 20%）', '（使用者 2026-10-14 決定）'],
  [`\n${rule13}`, ''],
];
let restored = text;
for (const [current, previous] of edits) {
  assert.equal(restored.split(current).length - 1, 1, `authorized policy text must occur once: ${current}`);
  restored = restored.replace(current, previous);
}
assert.equal(createHash('sha256').update(restored).digest('hex'), originalHash,
  'only the header, rule 11 and new rule 13 may change; WORKER_CONTEXT and other bytes stay identical');
console.log('PASS D1 policy contains exactly the authorized edits; worker context unchanged');
