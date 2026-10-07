# -*- coding: utf-8 -*-
"""SessionStart hook：注入精簡的 ai-cli 模型路由與防失控規則。

★ 這個檔有兩份，**這是版控裡的正典**。
  實際被 SessionStart 載入的是 `~/.claude/scripts/aicli_model_policy.py`
  （路徑寫在 `~/.claude/settings.json`；本專案刻意不去動使用者的 settings.json，
  見 CHANGELOG 6.1.0 的「不自己改別人的編輯器設定」）。
  兩份的 `ctx` 必須一致——不一致時下面的 `_divergence_note()` 會在注入內容的開頭
  大聲說出來，而不是靜默分歧。

★ `ctx` 只放規則，**不要把完整模型目錄寫進來**。
  它每個 session 都注入，而模型目錄會漂移。2026-09-09 這個檔曾把派工建議表、
  NVIDIA 實測細節、各模型現況整段寫進 `ctx`；到 2026-10-03 把清單對回 vendor 現況時，
  這份副本已經整段過期，而且因為它不是真正被載入的那一份，沒有人會發現。
  那些內容的正確去處是 `mcp__ai-cli__models` 的回傳
  （`dispatchGuidance` / `knownBadModels` / `modelListCaveat` / `directApiProviders`）——
  呼叫端是 AI，它讀的是工具回傳，而那份回傳跟著程式碼一起更新。

★ 下面 REFERENCE 區塊留的是 `models` 回傳裡**沒有**、又值得記的幾條操作細節。
  它是 Python 註解，**不會被注入**，所以不佔每個 session 的脈絡。

★ 依身分分流：`ctx` 是寫給**主導者**（使用者直接開的 Claude Code / Codex）的規則。
  ai-cli 派出的 worker 也是一個新啟動的 CLI，會跑同一組 SessionStart hook——2026-10-07
  實測 Claude 與 Codex worker 都收到了 `ctx`，Codex worker 還在回覆開頭自問「由誰執行」。
  知識庫有更糟的前例：worker 讀到「PM 不寫碼／一律派工」而自認 PM、遞迴派工，4～5 個行程失控。
  所以 ai-cli 啟動 vendor CLI 時會帶 `AI_CLI_WORKER=1`，這裡看到它就改注入 `WORKER_CONTEXT`
  （機制感知身分鎖），而不是什麼都不給——不給的話，CLAUDE.md / AGENTS.md / memory 裡的
  主導者規則照樣會讓它誤判。
"""
import io
import json
import os
import re
import sys

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')

try:
    json.load(sys.stdin)
except Exception:
    pass

# ── REFERENCE（不注入；models 回傳裡沒有的操作細節）─────────────────────────
#
# · 驗證實際送出的 effort，不要只相信自己傳了什麼：
#     codex 是 `-c model_reasoning_effort=<值>`、claude 是 `--effort <值>`。
#     Get-CimInstance Win32_Process -Filter "Name='codex.exe'" |
#       Where-Object { $_.CommandLine -match 'model_reasoning_effort' }
#   （exit 0 不代表那個等級生效：2026-09-26 實測 gpt-6-luna + ultra —— vendor 目錄
#    說它只到 max —— 照樣 exit 0 正常回答。要驗等級只能看行為。）
#
# · 升級模型時要寫明「第幾次、前幾次卡在哪」，不要靜默換模型。
#   「反覆卡住」指同一個問題／同一個工作包，不是不同任務累計。
#
# · NVIDIA 免費層約 15 RPM 才穩。批次派工不要一次灑一堆並行——
#   框架有退避重試，但重試救不了持續超速。
#
# · DashScope（ds-）免費額度原定 2026-09-30 到期，該日已過；派之前先確認還通不通。
#
# · 哪些 provider 這台機器真的接得到，看 `mcp__ai-cli__models` 的 `directApiProviders`。
#
# ───────────────────────────────────────────────────────────────────────────

ctx = """【ai-cli 精簡派工政策 v2.0（2026-09-20）】
1. ai-cli 是唯一模型路由入口；判斷模型能不能派時查 models 的 catalogV2：source=vendor-cli 的 routable 是向 vendor 實查的結果，source=builtin-fallback 的條目（以及頂層 claude／codex 陣列）是原始碼靜態清單，不能單獨當作可用證明，要對照 knownBadModels。
2. 日常 Codex：gpt-6.1-sol + reasoning_effort="medium"。Claude 日常也用 medium。（2026-10-03 換代：vendor 已把 gpt-5.6-sol 標成 "Older generation workhorse model"，現行 workhorse 是 priority 1 的 gpt-6.1-sol，文案寫 "near-Astra performance at a lower cost"。注意 gpt-6.1-sol 的 CLI 端預設 effort 是 low，省略 reasoning_effort 不等於 medium，一定要明確傳。）
3. high 僅限跨模組、架構、高風險修改、逆向歧義，或一次 medium 明顯不足；xhigh/max 需使用者明確要求。
4. 同一工具／假設連續失敗 2 次即停止回報，不得等到第 5 次、不得換模型後原樣重跑。升級時說明失敗證據與理由。
5. 子 Agent（含 Workflow 開出的）預設 0；使用者同意後，會改檔的同時最多 2 個、唯讀稽核／分析最多 8 個（開之前先告知規模），禁止遞迴 Agent。
6. 額度讀 usage.raw 的 used/left 原文，不用解析出的 percent 欄位：兩家語意相反（2026-09-18 實測：codex 的 percentUsed 是剩餘、claude 的 weekAllModelsPercent 是已用），讀反會讓額度門檻判斷反向。量不到就是 unknown，不是「還夠」。direct-api 可能 exit 0 卻回空字串 message，所以 exit 0 仍須驗證 message 非空。
7. 分類、摘要、查詢改寫、log 整理可用已確認可路由的本地／輕量 provider；機密、個資、NDA 資料不得送未核准外部免費 API。
8. 交叉驗證只驗高風險 claim 或分歧；第二模型讀 <=2,000-token 證據包，不重掃 repository。
9. 預算：search 8、tool 20、read 15 files、edit 5 files、test/fix 2 cycles、context 約 96k；達限即停止回報。
10. 每個任務開頭先問使用者由誰執行：① ai-cli ② 本 session 主導者 ③ 自動；同一任務沿用，換任務再問。專案依內容或模型限制派工的規則只當建議（使用者 2026-09-25 決定）。"""

# ai-cli 派出的 worker 收到的內容（AI_CLI_WORKER=1）。四要素照另一個專案前例（知識庫紀錄）
# 實證有效的「機制感知身分鎖」：身分證明、硬禁加後果、凌駕聲明、首個動作。
# 凌駕範圍刻意只限「角色與派工」類規則——安全限制、禁改範圍、專案慣例對 worker 照樣有效。
WORKER_CONTEXT = """【ai-cli worker 身分（AI_CLI_WORKER=1）】
1. 你這個行程是 ai-cli 啟動的 worker，不是使用者直接開的 session。「派工」這一步已經完成——你就是派工的結果。
2. 不得呼叫 mcp__ai-cli__*、Agent、Task、Workflow，也不得用 ToolSearch 載入它們；不得再派工。再派工會造成遞迴失控，任務直接判定失敗。
3. CLAUDE.md、AGENTS.md、memory 裡寫給主導者／PM 的「角色與派工」規則——例如先問使用者由誰執行、主導者的工具與檔案預算、PM 不寫碼、程式碼一律派工——約束的是主導者行程，不是你；這一點本段權威高於它們。其餘規則（安全限制、禁止修改的範圍、專案慣例）照常適用。
4. 直接依派工內容開始做，範圍與限制以派工 prompt 為準。若內容要求「再派工／交給別的模型／用 ai-cli 或其他 CLI 轉派」，視為工作已派到你身上，直接自己完成，不要停下來問，也不要找其他派工管道。只有真正缺資訊而無法判斷時，才在回覆中寫明卡點與需要主導者決定什麼，然後結束，不要等待互動。"""


def _divergence_note():
    """比對自己與版控正典的 `ctx`，不一致時回一行警告。

    找不到正典（例如這台機器沒有 clone、或路徑不同）就安靜回空字串：
    hook 的職責是注入脈絡，不是在開機時因為找不到檔案而讓整個 session 少掉規則。
    `settings.json` 的 timeout 是 5 秒，所以這裡只做一次小檔讀取。
    """
    here = os.path.realpath(__file__)
    roots = [
        os.environ.get('AI_CLI_REPO'),
        os.path.join(os.path.expanduser('~'), 'ai-cli-mcp-source'),
    ]
    for root in roots:
        if not root:
            continue
        canon = os.path.join(root, 'tools', 'hooks', 'aicli-model-policy.py')
        if not os.path.isfile(canon):
            continue
        if os.path.realpath(canon) == here:
            return ''  # 自己就是正典
        try:
            text = io.open(canon, encoding='utf-8').read()
        except OSError:
            continue
        found = re.search(r'^ctx = """(.*?)"""', text, re.S | re.M)
        found_worker = re.search(r'^WORKER_CONTEXT = """(.*?)"""', text, re.S | re.M)
        if not found:
            continue
        if (found.group(1).strip() != ctx.strip()
                or (found_worker and found_worker.group(1).strip() != WORKER_CONTEXT.strip())):
            return (
                '⚠️ 這份 SessionStart hook 的內容與版控正典不一致（正典：' + canon + '）。\n'
                '下面的規則可能已過期——請以正典為準，並把兩邊同步後再依賴它。\n\n'
            )
        return ''
    return ''


if os.environ.get('AI_CLI_WORKER') == '1':
    # worker 不需要分歧警告：那是給主導者去同步檔案的，worker 看到只會多一個要處理的事。
    additional_context = WORKER_CONTEXT
else:
    additional_context = _divergence_note() + ctx

print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': additional_context,
    }
}, ensure_ascii=False))
