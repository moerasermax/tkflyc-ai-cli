/**
 * D1: invert only the authorized policy edits, then verify every other byte (LF space).
 * 2026-11-10（依額度與難度選模型）：再放行標題、第 2 條、第 11 條；先還原成 2026-11-08 的版本，再走原本的還原。
 * 2026-11-18（v2.6）：再放行標題與第 2 條的 Codex 換代（6.2 代）。
 * 2026-11-26（v2.7）：再放行標題、第 14 條結尾（稽核也走 API 額度）與新增的第 15、16 條，最先還原。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const originalHash = 'ff8cf780ed7108a2c1019878ca754e81eeba149ee7434fb190260001b18ab0c9';
const text = readFileSync(new URL('../tools/hooks/aicli-model-policy.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rule14 = "14. 開發完成後的驗證工作（自動化測試、驗證測試、煙霧測試、對真實服務的實測）要派工時，用 API 金鑰的 direct-api 模型：anthropic-<模型 ID> 或 openai-<模型 ID>（金鑰在 providers.json；這類模型有 bash 工具，可以跑測試指令），把 Claude／Codex 訂閱額度留給開發。API 按 token 計費：驗證包要小、模型選夠用的（例如 anthropic-claude-haiku-5-5、openai-gpt-6-luna），需要較強模型時說明理由。實作、修 bug 與唯讀稽核仍照第 2 條（使用者 2026-11-18 決定）。";
const rule13 = '13. ai-cli_kernel 同時最多 3 個 run，同一個 repo 一次 1 個（以 git common dir 判斷，worktree 和同一個 origin 的 clone 都算同一個）；Claude 週額度剩不到 10% 或量不到時退回全機 1 個；Codex 剩不到 20% 或量不到時，不同時跑兩個用到 Codex 的 run。這些由 kernel 在開工時自己擋，上限只能由人調整，MCP 改不了（使用者 2026-11-08 決定）。';
const rule15 = `15. 派工單與收件：派工單一律寫明①不要寫知識庫②所有指令前景執行、不用 run_in_background（非互動 worker 回合一結束行程就退出，背景結果沒人接）③只能停止自己啟動且核對過 pid 的程序，不得用名稱比對 kill④Windows 上 spawn 一律 windowsHide: true⑤備份與暫存放 repo 外。唯讀工作傳 capabilities: ["fs/read","analysis/produce"]：run 沒有 mode 參數（傳了會被靜默忽略），省略 capabilities 就是完整權限。審查由作者以外的那一家做，結果逐條對原始碼驗證再採納。會改檔的 job 同時最多 2 個、範圍互不重疊。job 交件就立刻把回覆存檔（結束約 30 分鐘後 job store 清掉，get_result 回 not found）。驗收分三層、不能互相代替：身分（結果屬於這次執行；exit 0 加空訊息或 elapsedSec 0 要懷疑撞號）、存活（看作業系統程序）、交付（讀結尾，「我先等…」就是沒做完，用 session_id 續接；看 diff、自己重跑測試）（使用者 2026-11-10～11-24 的派工實務）。`;
const rule16 = '16. ai-cli_kernel 的核准是使用者的：「由誰執行」選了 kernel 不等於同意開跑。委任書停在 awaiting_approval，把目標、可改路徑、預算、回復點列給使用者看，說可以跑才核准；不得用腳本代為核准（使用者 2026-11-08 決定）。';
const edits = [
  // 2026-11-26 v2.7：第 14 條把唯讀稽核納入 API 額度、補長測試改本機跑；新增第 15、16 條。先還原成 v2.6。
  ['【ai-cli 精簡派工政策 v2.7（2026-11-26）】', '【ai-cli 精簡派工政策 v2.6（2026-11-18）】'],
  ['需要較強模型時說明理由。獨立審查（唯讀稽核）也算驗證工作，同樣用 direct-api；跑很久的測試（例如完整測試套件）direct-api 會被中斷，改用本機腳本序列跑。實作與修 bug 仍照第 2 條（使用者 2026-11-18 決定；稽核納入 2026-11-24 決定）。',
    '需要較強模型時說明理由。實作、修 bug 與唯讀稽核仍照第 2 條（使用者 2026-11-18 決定）。'],
  [`\n${rule15}`, ''],
  [`\n${rule16}`, ''],
  // 2026-11-18 v2.6：第 2 條的 Codex 候選換成 6.2 代（gpt-6.2-sol／gpt-6.2-astra）。先還原成 v2.5。
  ['【ai-cli 精簡派工政策 v2.6（2026-11-18）】', '【ai-cli 精簡派工政策 v2.5（2026-11-18）】'],
  ['routine（日常）＝gpt-6.2-sol + medium', 'routine（日常）＝gpt-6.1-sol + medium'],
  ['＝opus + medium → gpt-6.2-sol + high', '＝opus + medium → gpt-6.1-sol + high'],
  ['→ gpt-6.2-astra + high（前代 gpt-6-astra 同樣的工作吃的週額度約是 6.1-sol 的 2～5 倍；2026-10-14 實測：五個 Astra high 包 6.3 小時用掉 Codex 週額度 84%；6.2 代倍率未實測）', '→ gpt-6-astra + high（同樣的工作 Astra 吃的週額度約是 6.1-sol 的 2～5 倍；2026-10-14 實測：五個 Astra high 包 6.3 小時用掉 Codex 週額度 84%）'],
  ['注意 gpt-6.2-sol（與 6.2-astra、6.1-sol）的 CLI 端預設 effort 是 low', '注意 gpt-6.1-sol 的 CLI 端預設 effort 是 low'],
  ['候選池在開工時凍結（使用者 2026-11-10 決定；2026-11-18 Codex 候選換成 6.2 代）。', '候選池在開工時凍結（使用者 2026-11-10 決定）。'],
  ["【ai-cli 精簡派工政策 v2.5（2026-11-18）】", "【ai-cli 精簡派工政策 v2.4（2026-11-10）】"],
  [`
${rule14}`, ''],
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
  'only the header, rule 2, rule 11 and new rules 13–14 may change; WORKER_CONTEXT and other bytes stay identical');
console.log('PASS D1 policy contains exactly the authorized edits; worker context unchanged');
