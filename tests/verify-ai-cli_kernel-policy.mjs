/**
 * D1: invert only the authorized policy edits, then verify every other byte (LF space).
 * 2026-11-10（依額度與難度選模型）：再放行標題、第 2 條、第 11 條；先還原成 2026-11-08 的版本，再走原本的還原。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const originalHash = 'ff8cf780ed7108a2c1019878ca754e81eeba149ee7434fb190260001b18ab0c9';
const text = readFileSync(new URL('../tools/hooks/aicli-model-policy.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rule13 = '13. ai-cli_kernel 同時最多 3 個 run，同一個 repo 一次 1 個（以 git common dir 判斷，worktree 和同一個 origin 的 clone 都算同一個）；Claude 週額度剩不到 10% 或量不到時退回全機 1 個；Codex 剩不到 20% 或量不到時，不同時跑兩個用到 Codex 的 run。這些由 kernel 在開工時自己擋，上限只能由人調整，MCP 改不了（使用者 2026-11-08 決定）。';
const edits = [
  ["【ai-cli 精簡派工政策 v2.4（2026-11-10）】", "【ai-cli 精簡派工政策 v2.3（2026-11-08）】"],
  ["2. 選模型依週額度與任務難度；使用者指名就照指名，不看額度、不自動改。合格＝那一家的週額度剩 25% 以上：Claude 家（sonnet、opus）看 Claude 週額度；fable 另外還要 Fable 自己的週額度也剩 25% 以上（兩個都要）；Codex 家看 Codex 週額度；量不到（unknown）或沒有額度資料一律不合格。依難度照順序取第一個合格的：routine（日常）＝gpt-6.1-sol + medium → sonnet + medium → grok-4.7 + medium（備援：只有前兩者都不合格才用）；elevated（高風險／跨模組／架構／develop 寫入）＝opus + medium → gpt-6.1-sol + high；critical＝fable + high → opus + high → gpt-6-astra + high（同樣的工作 Astra 吃的週額度約是 6.1-sol 的 2～5 倍；2026-10-14 實測：五個 Astra high 包 6.3 小時用掉 Codex 週額度 84%）。自動選不發出 xhigh／max／ultra。注意 gpt-6.1-sol 的 CLI 端預設 effort 是 low，省略 reasoning_effort 不等於 medium，一定要明確傳。ai-cli_kernel 沒指定模型時照這張表自動選，候選池在開工時凍結（使用者 2026-11-10 決定）。",
    "2. 日常 Codex：gpt-6.1-sol + reasoning_effort=\"medium\"。Claude 日常也用 medium。（2026-10-03 換代：vendor 已把 gpt-5.6-sol 標成 \"Older generation workhorse model\"，現行 workhorse 是 priority 1 的 gpt-6.1-sol，文案寫 \"near-Astra performance at a lower cost\"。注意 gpt-6.1-sol 的 CLI 端預設 effort 是 low，省略 reasoning_effort 不等於 medium，一定要明確傳。）gpt-6-astra 只用於逆向歧義、架構設計、跨模組高風險，或 6.1-sol 一次明顯不足的工作，派之前寫明理由：同樣的工作 Astra 吃的週額度約是 6.1-sol 的 2～5 倍（2026-10-14 實測：五個 Astra high 包 6.3 小時用掉 Codex 週額度 84%）。"],
  ["11. 派工前先查週額度剩餘（看 raw 原文，見第 6 條）：剩不到 25% 或量不到的那一家不派，改派另一家合格的候選（見第 2 條）；沒有合格候選就停下回報。Codex 剩不到 20% 不同時跑兩個 Codex 工作。長工作拆小，避免一個 session 上千次請求反覆重送 100K 以上的 context（使用者 2026-10-14 決定；並行門檻 2026-11-08 由 50% 改為 20%；改派規則 2026-11-10 決定）。",
    "11. 派 Codex 前先查 Codex 週額度剩餘（看 raw 原文，見第 6 條）：剩不到 20% 不同時跑兩個 Codex 工作；剩不到 25% 只派小包或改派 Claude；量不到就當 unknown，不並行。長工作拆小，避免一個 session 上千次請求反覆重送 100K 以上的 context（使用者 2026-10-14 決定；並行門檻 2026-11-08 由 50% 改為 20%）。"],
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
  'only the header, rule 2, rule 11 and new rule 13 may change; WORKER_CONTEXT and other bytes stay identical');
console.log('PASS D1 policy contains exactly the authorized edits; worker context unchanged');
