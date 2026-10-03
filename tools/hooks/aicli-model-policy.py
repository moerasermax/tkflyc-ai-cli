# -*- coding: utf-8 -*-
"""SessionStart hook：注入 ai-cli 派工的預設模型、升級規則與情境對照表。

這份是版控來源。安裝方式（每台機器做一次）：

  1. 複製到 Claude Code 的腳本目錄：
       cp tools/hooks/aicli-model-policy.py ~/.claude/scripts/aicli_model_policy.py
  2. 在 ~/.claude/settings.json 的 hooks.SessionStart 裡加一筆：
       { "type": "command", "command": "python",
         "args": ["<你的家目錄>/.claude/scripts/aicli_model_policy.py"],
         "timeout": 5, "statusMessage": "載入 ai-cli 派工模型政策…" }

**ai-cli 不會自己去改你的 settings.json。** 派工工具靜默改寫使用者的
Claude Code 設定是壞設計——它要你知道你的環境被動了什麼。

裝好之後這個檔會隨 git pull 更新，內容改了不必重裝，只要下次開 session 就生效。

同一份建議也在 mcp__ai-cli__models 的 dispatchGuidance / knownBadModels 裡，
那個隨自動更新過去、不需要安裝——hook 的差別只是「不必等 AI 想到要查」。

使用者的定義（2026-09-07）：
  「預設 ai-cli 的 codex 都使用 sol-high level；
    如果同樣的問題超過 5 次尚未解決，再切 astra-high。」

理由：sol 較省額度。先用便宜的模型配高推理強度，只有在同一個問題反覆卡住時
才升級到最貴的 astra——不是一開始就用最貴的。

2026-09-09 追加派工建議表：NVIDIA 免費 API 接上之後，「大量低價值工作」與
「長脈絡」有了不花訂閱額度的選項，但那兩顆要指名才會用到——沒寫進來的話，
預設仍然會拿訂閱額度去做不需要它的事。

只在 SessionStart 注入一次，不在每則 prompt 重複，避免洗版。
"""
import json
import sys

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')

try:
    json.load(sys.stdin)
except Exception:
    pass

ctx = (
    '【ai-cli 派工的模型政策（使用者 2026-09-07 定，2026-09-09 補建議表）】\n'
    '\n'
    '── 預設與升級 ──\n'
    '用 mcp__ai-cli__run 派工給 Codex 時：\n'
    '  預設 model="gpt-5.6-sol"、reasoning_effort="high"。\n'
    '  同一個問題連續派工超過 5 次仍未解決 → 才升級成 '
    'model="gpt-6-astra"、reasoning_effort="high"。\n'
    '\n'
    '要點：\n'
    '  1. 不要一開始就用 astra——它最貴。先用 sol 配 high。\n'
    '  2. 「超過 5 次」指的是同一個問題／同一個工作包反覆卡住，'
    '不是不同任務累計。\n'
    '  3. 升級時要在派工書或回報裡寫明「第幾次、前幾次卡在哪」，'
    '不要靜默換模型。\n'
    '  4. 派給 Claude（claude-sonnet 等）維持既有規則：reasoning_effort="medium"。\n'
    '  5. 驗證實際送出的參數，不要只相信自己傳了什麼：\n'
    '     Codex 是 -c model_reasoning_effort=<值>，Claude 是 --effort <值>。\n'
    '     Get-CimInstance Win32_Process -Filter "Name=\'codex.exe\'" | '
    'Where-Object { $_.CommandLine -match \'model_reasoning_effort\' }\n'
    '\n'
    '── 派工建議表（依情境挑，不要一律用同一顆）──\n'
    '\n'
    '  情境              用什麼\n'
    '  ────────────────  ──────────────────────────────────────────────────\n'
    '  日常派工          gpt-5.6-sol + reasoning_effort="high"\n'
    '  卡了 5 次以上     gpt-6-astra（最貴，別一開始就用）\n'
    '  稽核／第二意見    claude-ultra 或 gemini-3.1-pro-high\n'
    '  大量低價值工作    nv-openai/gpt-oss-20b（免費）\n'
    '  長脈絡            nv-nvidia/nemotron-3.5-lightning-30b-a3b（1M，免費）\n'
    '\n'
    '  上面兩個 nv- 走 NVIDIA 的免費 API，**不吃訂閱額度**。分類、摘要、格式轉換、\n'
    '  批次改寫這種量大但不難的工作派給它們，把訂閱額度留給真的需要的地方。\n'
    '  它們不吃 reasoning_effort 參數（那是 claude/codex 的 CLI 旗標）。\n'
    '\n'
    '── NVIDIA 那批的注意事項（2026-09-09 實測）──\n'
    '  · 實測 10/10 的只有三顆：nv-openai/gpt-oss-20b、\n'
    '    nv-nvidia/nemotron-3.5-lightning-30b-a3b、nv-meta/muse-glimmer-30b。\n'
    '  · nv-moonshotai/kimi-k3 是 429 額度爭用，實測 3/10，重試打不穿——不要用。\n'
    '  · nv-google/gemma-4-31b-it 的工具迴圈要 91 秒；純文字（prompt 開頭加\n'
    '    [no-tools]）14 秒還可以。\n'
    '  · 免費層約 15 RPM 才穩。批次派工不要一次灑一堆並行，\n'
    '    框架已有退避重試，但重試救不了持續超速。\n'
    '  · 條款限制：NVIDIA API Trial Terms 明文禁止送入機密資訊與個資。\n'
    '    這是使用條件不是隱私偏好——別拿它讀有 NDA 的東西。\n'
    '\n'
    '── 其他 ──\n'
    '  · DashScope（ds-）免費額度 2026-09-30 到期——該日已過，派之前先確認還通不通。\n'
    '  · codex 的 gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.3-codex-spark /\n'
    '    gpt-5.2 已不在 vendor 目錄（2026-10-03 查 ~/.codex/models_cache.json），\n'
    '    也已從靜態清單移除。移除不等於擋下：gpt- 前綴仍會把指名的送到 codex\n'
    '    然後收到 HTTP 400 not supported when using Codex with a ChatGPT\n'
    '    account（2026-10-03 五顆各實測一次，全部如此），所以別派。\n'
    '  · codex 現行旗艦仍是 gpt-6-astra（Frontier intelligence）；priority 1 的\n'
    '    gpt-6.1-sol 是最新的 workhorse，vendor 文案寫 near-Astra performance at\n'
    '    a lower cost——最新不等於最強，要最強請指名 astra。\n'
    '  · gpt-5.5 的 vendor upgrade 欄位標明 2026-10-14T19:00Z 退役，建議改 gpt-6.1-sol。\n'
    '  · 不確定這台機器接得到什麼時，看 mcp__ai-cli__models 回傳的\n'
    '    directApiProviders（會列出已設定的 provider 與可用前綴）。'
)

print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': ctx,
    }
}, ensure_ascii=False))
sys.exit(0)
