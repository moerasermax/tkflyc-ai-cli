# 變更紀錄（Changelog）

本檔記錄所有對使用者/協作者可見的改動。格式參考
[Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循
[語意化版本](https://semver.org/lang/zh-TW/)。每筆結尾以括號標註作者。

維護規則見 [CONTRIBUTING.md](./CONTRIBUTING.md)：**每次改動都要在此補一行。**

## [Unreleased]

### 新增（job 用量與成本派工提醒）

- **Codex / Claude job 結束時回傳正規化 `agentOutput.usage`。** 過去只看得到結果，看不到每個 job 的 token 開銷，strict Codex 又帶 `--ephemeral`，事後無 session 可追。Codex 累加每筆 `turn.completed`，保留舊 `token_count`；Claude 的 NDJSON 與單一 JSON result 都映射 cache／thinking，用 `num_turns` 與 `cost_usd_nominal` 明示名目成本而非訂閱帳單。沒有量到就不放 usage；既有 compact result 會保留它，`process-result.ts` 不需修改。（Codex，@moerasermax）
- **MCP `run` 對實際送出的 xhigh / max / ultra 帶英文 `warnings`。** 影響 core 的 command-builder 與 process-service 三個 started 回傳：明確指定、alias 預設及 config（含環境覆寫）都標示 effort 與來源，提醒日常用 medium、最高強度只在使用者明確要求時使用；只增加可選回傳欄位，不擋派工、不改既有指令與欄位。low / medium / high 不附警告。CLI detached 路徑這次未延伸：增加 file-process-service 會超過核准的 12 個修改檔案。未變更 antigravity / direct-api agent。（Codex，@moerasermax）
- **`models.dispatchGuidance` 加入合併小任務、避免重複派工、長 wait 少 peek、job 結束讀 usage。** 依 2026-10-06 使用者實測：最小 Codex input 約 2 萬、Claude context 約 3 萬 tokens，零碎派工與大 context 的短輪詢會重複支付開銷；這些數字是當時環境觀察，不是所有 job 的保證下限。MCP run 描述指向這份建議。（Codex，@moerasermax）
- 新增 `verify-job-usage.mjs`，以假 spawn 驗證用量、compact result、effort 來源與 MCP start 警告；`npm test` 15→16 支。新增對應突變片段並檢查唯一命中；依使用者要求未執行 mutation-test，未做獨立 agent 稽核，提交／推送前的 core 稽核與突變實跑仍待完成。（Codex，@moerasermax）

### 修正（`query_usage` 讀不到 Codex 額度卻回 `status: "ok"`）

- **查 Codex 額度的 TUI 改帶 `--no-daemon`。** 2026-10-06 實測（codex-cli 0.160.0、Windows 11）：
  呼叫端以系統管理員權限執行時，ai-cli 與它啟動的 codex 都繼承這個權限，而 0.160 的互動模式要啟動
  共用背景 daemon，daemon 在管理員權限下拒絕啟動。TUI 只印
  `Error: start the Windows daemon from a non-elevated terminal …`，`/status` 面板永遠不會出現。
  查額度只要一次性的 TUI，用不到 daemon。`run` 的 `codex exec` 派工路徑不經 daemon（同時段實測
  exit 0），一個字都沒動。（Claude，moerasermax 指示）
  - **舊版退路選「出現 unexpected argument 才拿掉參數重跑一次」，不選「先看 `codex --help`」**：
    新版不多付一次啟動成本；而且 cliPath 在 Windows 常是 `.cmd` shim，PTY 吃得下，
    `child_process` 直接 spawn 吃不下，先探 `--help` 等於要再造一套 spawn。
    比對字串取自 clap 的實際輸出（`Error: unexpected argument '<arg>' found`），而且**不能只比對
    `--no-daemon`**：管理員權限的錯誤本身就寫著「rerun … with --no-daemon」，會白跑一次。
- **量不到額度就回 `status: "error"`，不再折成 `ok`。** 過去不管 raw 裡有沒有額度數字，
  provider 只要沒丟例外就是 `ok`。現在兩種情況改回 `error`，而且 `usage.raw` 照樣帶回去，
  呼叫端仍讀得到原文：
  - 沒有額度數字、畫面上有 `Error:`：`error` 欄位帶錯誤原文（最多兩行）。
  - 沒有額度數字、也沒有錯誤字樣：例如卡在 codex 的 hook 信任畫面（「2 hooks are new or changed」）、
    `/status` 送不進去。`error` 寫 `no quota panel in output`，逾時會另外標 `(timed out after 60s)`。
    這是修完 `--no-daemon` 後實跑才露面的第二個入口：同一個假綠燈，原本的條件抓不到。
  - 有額度數字時，畫面別處的 `Error:` 字樣不影響 `ok`。
  - hook 信任畫面本身**不由程式處理**：信不信任 hook 是使用者的決定，查額度不替他做，
    也不用 `--dangerously-bypass-hook-trust`。
- 新增 `tests/verify-usage-parse.mjs` 進 `npm test`（14→15 支），15 條斷言，以假 PTY 取代真實 codex。
  在此之前 usage-service **沒有任何測試**。突變 +6（不帶 `--no-daemon`、拿掉舊版退路、偵測放寬成只比對
  `--no-daemon`、解析器不認錯誤畫面、status 不看 `type: error`、沒有面板仍回 `ok`）。（Claude）

## [6.3.0] - 2026-10-03

> **npm 上沒有 6.2.0。** `package.json` 曾被 bump 到 `6.2.0`、下面也有該版本的區段，
> 但那個版本**從未打 git tag、也從未發佈到 npm**——它的內容只透過 git 自動更新進了各機器。
> 所以 npm 的版本序是 `6.1.1` → `6.3.0`；`[6.2.0]` 區段記的是「已部署到機器、未發佈到 npm」
> 的那一批。本版把 `6.2.0` 之後累積的六批工作一次發出去，沒有破壞性變更（SemVer MINOR）。
> 發版順序照 CLAUDE.md 紅線 4：先 `npm version` 打 annotated tag、再 build、再 publish；
> 要取 commit SHA 得用 `v6.3.0^{}`。


### 新增（`codex-ultracode`：補上真正的最強組合）

- **新增 alias `codex-ultracode` → `gpt-6-astra` + `reasoning_effort: "ultra"`。**
  在此之前「旗艦配最高推理」**沒有任何 alias**：`codex-ultra` 送的是 `max`，要 `ultra`
  得每次手動帶 `reasoning_effort`。（Claude，moerasermax 指示）
  - **為什麼另立名稱而不是把 `codex-ultra` 改成 `ultra`**：`ultra` 是 codex 的 **effort
    級別名**（`max` 之上還有一級），不是 model。把 effort 詞當 alias 名稱用，已經讓
    `codex-ultra` 名實不符——它叫 ultra、送的卻是 max。改它的語意是破壞性變更，
    所以這裡走純加法，`codex-ultra` 與 `claude-ultra` 一律不動。
  - **claude 側刻意不加對應名稱**：claude 的 effort 只到 `max`（沒有 `ultra`），
    `claude-ultracode` 會和 `claude-ultra` 完全同義——兩個名字做同一件事是新的混淆源。
  - 兩份寫死的 alias effort 表（`catalog.ts` 的 `MODEL_ALIAS_DETAILS` 進 payload 顯示、
    `user-config.ts` 的 `BUILTIN_ALIAS_REASONING` 是執行期真正送出的值）現在有一條斷言
    在守它們一致。漏改一邊的後果是「畫面上寫 ultra、實際送 max」，而且兩邊都不會報錯。
- 測試 +7 條（121 項）：解析到旗艦、路由到 codex、被認得是內建 alias、不能自己當 alias
  target、`codex-ultra` 語意沒被動到、**不帶 effort 時實際送出 `ultra`**、兩份表一致。
  突變 +4（拿掉 alias、執行期 effort 退成 max、只改顯示那一份、日常 effort 改回 high）。（Claude）

### 變更（日常派工 effort 對齊為 `medium`）

- **`dispatchGuidance`「日常派工」的 `reasoningEffort` 從 `high` 改為 `medium`**，
  `tools/hooks/aicli-model-policy.py` 兩處同步。這是上一批列為「已知問題・未修」的
  `high`／`medium` 矛盾——定錨取維護者自己的治理文件（`~/.claude/CLAUDE.md` 與實際載入的
  SessionStart hook 都寫 `medium`），而不是由這個 commit 自己挑一個值。（Claude，moerasermax 指示）
  - note 一併改寫：原本寫「先用便宜的配高推理強度」，前提隨 effort 改變就不成立了。
    新措辭**刻意中性**——這段會隨 dist 發佈到公開 npm，不該把維護者私有治理文件的原文
    寫進對外 payload。只說「這張表是維護者的派工政策：日常 medium；high 留給跨模組、
    架構、高風險修改、逆向歧義，或一次 medium 明顯不足」。
  - 「astra 最貴」這句保留但標明出處是政策、不是從 vendor 目錄推出來的（目錄沒有價格欄位）。
  - hook 內部原本還有一句「先用 sol 配 high」，改 effort 之後自相矛盾，一併修掉；
    升級路徑（astra + `high`）維持不變。

### 修正（突變測試的 5 筆壞片段 — 上一批的「已知問題」已修）

- **`tools/mutation-test.mjs` 現在也把比對片段正規化成 LF。** 根因是不對稱：它把**原始碼**
  正規化成 LF，卻拿 `mutation.from` 原樣比對——任何從 CRLF 工作區複製出來的片段永遠對不上，
  判 `ERROR`，而那筆突變等於什麼都沒測。實際有 4 筆長期如此（全在 `verify-extra-body.mjs`）。（Claude）
  - **沒有**改走「把那 4 筆資料改成 LF」那條路：`src/` 工作區含 CRLF（`git ls-files --eol`
    實測 `w/crlf`），而既有做法是「從當前原始碼取出實際片段」，所以只改資料保證復發。
  - `to` 也要正規化，否則 `to` 內含 CRLF 時會把 CRLF 寫進已正規化成 LF 的檔案、造成混合 EOL。
- **重新設計「unrestricted 仍走嚴格組裝」那筆突變**：它的片段
  `return { authority: 'unrestricted', agent, built };` 在現行 `src/app/exec.ts` 已改寫成
  條件運算式，所以永遠套不上。新片段打的是傳 `capabilities` 的那個三元式——讓 unrestricted
  路徑也被塞 `capabilities`，於是 `authority` 照樣回報 `unrestricted`、組出來的卻是嚴格指令，
  正是它原本要驗的「要求不設限卻靜默受限」。（Claude）
- **另外修掉 2 筆片段不唯一的突變**（`user-config.ts` 與 `direct-api.ts` 各一，各命中 2 處）。
  harness 用 `String.replace`，只換第一個命中——片段出現兩次時改到哪一處取決於檔案順序，
  那筆突變驗的就不是你以為的那一段，而且同樣沒有訊號。兩筆都往前擴一行到唯一。（Claude）

### 測試（`npm test` 13 支 → 14 支）

- **新增 `tests/verify-mutation-manifest.mjs`**：檢查突變清單自身的健康——欄位齊全、名稱不重複、
  `to !== from`、目標檔存在、**`from` 片段恰好命中一處**、`script` 指向存在的腳本。
  純讀檔、不建置、不需 worktree，所以每次 `npm test` 都跑得起。（Claude）
  - 這才是「下次會被自動抓到」的答案。那 5 筆之所以潛伏那麼久，不是 harness 不報
    （`ERROR` 會逐筆印、也會讓整支非零收場），而是**那兩支腳本的突變平時沒人跑**——
    突變測試要開 worktree、建 junction、每筆各跑一次 `tsc`，實務上只針對這次改到的檔案跑。
  - 它**不驗**斷言殺不殺得掉突變（那只有實跑 harness 才知道），只驗「這筆還套得上、
    而且套得到唯一那一處」。`expect` 是否對到該抓的那條斷言也不在它職責內：
    有些斷言名稱是迴圈裡的模板字串，靜態比對會產生大量假警報。
  - 寫這支時它自己先報了 4 項，其中 **2 項是這支測試寫錯**：`to: ""` 是「刪掉整行」的合法
    突變（我原本要求非空），而 `expect` 以「★」開頭也沒問題（`check()` 印的是
    `FAIL ${name}`，名稱本身就含星號）。兩個假檢查已移除。
- `CONTRIBUTING.md` 的突變撰寫規則補上「片段必須從當前原始碼取出、而且只命中一處」。（Claude）

### 修正（SessionStart hook 的分歧靜默）

- **`tools/hooks/aicli-model-policy.py` 改為版控正典，內容對回實際生效的那一份，
  並加上分歧自檢。** 實際被載入的是 `~/.claude/scripts/aicli_model_policy.py`
  （路徑寫在使用者的 `settings.json`）；**`settings.json` 一個字都沒動**。（Claude，moerasermax 指示）
  - **刻意沒有把 `settings.json` 指向 repo。** 那會讓「push 到公開 master」等於改寫所有開了
    自動更新的機器在每個 SessionStart 自動執行的 Python——那是比「讓檔案跟著 git pull」
    大得多的風險類別，不該夾在一次整理裡做。
  - **「合併」的做法依實際發現調整**：安裝版自己帶著一條維護註記——「`ctx` 每個 session
    都會注入，只放規則；**完整模型目錄不要寫進來**，需要時由 `mcp__ai-cli__models` 查詢」。
    而 repo 版塞滿模型目錄細節，且那些細節 `models` payload 已經在回了
    （`dispatchGuidance` / `knownBadModels` / `modelListCaveat` / `directApiProviders`）。
    所以正確的收斂不是「把兩份塞成一份」，而是讓版控裡終於是**真正生效的那份精簡規則**，
    並把 `models` 回傳裡沒有的四條操作細節（驗證實際送出的 effort、升級要寫明第幾次、
    NVIDIA 15 RPM、DashScope 到期）移到**不注入**的 REFERENCE 註解。
  - 注入的規則文字**位元相同**（1,290 字元），所以 session 脈絡沒有任何變化。
  - 自檢三態都實測過：兩份一致→不警告；故意改動正典→注入內容開頭出現警告並指名正典路徑；
    還原→不警告。找不到正典時安靜略過——hook 的職責是注入脈絡，不是因為找不到檔案就讓
    整個 session 少掉規則。

### 修正（`models_cache.json` 是多個 codex 執行檔共用的，不只是版本落後）

- `src/agents/codex.ts` 的註解原本寫「`client_version` 比 PATH 上的版本舊一號——那是寫入快取的
  版本，兩者要分開看」。**這句低估了**：PATH 上 npm 裝的 CLI 與 Codex 桌面版自帶的核心寫的是
  **同一個檔**，最後跑的那個覆寫它。所以 `client_version` 與你要派工的 CLI 不符時，
  **你讀到的是另一支的視角**，而不只是舊一號。（Claude）
  - 2026-10-03 同日的多次讀取裡，0.159.0／0.160.0 寫入的視角都是 10 筆且內容一致，
    而另一次讀到 0.155.0 寫入的視角只有 9 筆、**沒有 `gpt-6.1-sol`**。
    （那一次是稽核流程中另一個 agent 讀到的，我沒親自複現；但 `client_version` 與
    `fetched_at` 在同日反覆變動是我自己觀察到的，與「多個寫入者」一致。）
  - 操作規則：查這個檔之前先 `codex --version`，不符就重派一個 trivial job 讓目標 CLI
    自己重抓再讀。拿別支寫入的視角去改清單，等於照著一份不是你要用的目錄改。

### 稽核紀錄（CONTRIBUTING §5.1）

- **做法**：這一批用 Workflow 開了 **8 個唯讀子代理**——4 個調查員（每個項目一個，產出可直接
  套用的 `old`／`new` 字串）＋ 4 個對抗性審查員（每份方案一個，指令明寫「你的工作不是附和它，
  是找出它會壞在哪裡」）。全部不改檔、不跑測試；編輯與驗證由主流程序列執行（突變 harness
  共用同一份原始碼備份，不能並行）。符合全域規則的唯讀上限 8、會改檔的子代理 0。
- **結果：4 份方案全部被判 `needs-change`，共 31 項問題。所以沒有一份是照套的。**
  高嚴重度的四項都成立：
  1. effort 項的某一筆 `old` 在檔案裡**不存在**（`old` 與 `new` 是同一個字串），照套會失敗。
  2. gpt-5.5 項的新突變**必然 SURVIVED**，因為同批另一筆編輯讓關鍵字在檔內出現兩次，
     而 harness 只替換第一處。
  3. gpt-5.5 項新寫的「規則」與同一註解區塊上方 20 行的既有結論直接矛盾。
  4. hook 項把 `settings.json` 指向 repo 的風險被用「反正本來就有硬寫絕對路徑的 hook」帶過，
     那是假等價——那些指的都是本機、不會被遠端自動改寫的腳本。
- **採納並照辦**：日常派工斷言沒綁 `situation`（已補，並加突變證明它承重）、對外 note 不該
  寫進維護者私有治理文件原文、`verify-e2e.mjs` 的「最便宜」缺證據、`visibility: "hide"`
  不能推論成「只供 CLI 內部使用」、hook 項的風險框架（因此改走不碰 `settings.json` 的路線）。
- **採納但改寫**：審查員建議在 harness 加「片段預檢並 `process.exit(1)` 中止整輪」——
  不採納那個形狀（把「一筆片段過期」升級成「一個都不跑」，failure mode 更差；而且
  `console.error` 後立刻 `process.exit` 正是本專案紅線 5 那個 stdout 截斷的形狀）。
  改成獨立的 `verify-mutation-manifest.mjs` 進 `npm test`，用 `process.exitCode`。
- **判定不成立／不採納**：調查員主張「光把 4 筆片段改成 LF 無法避免復發」——這點成立，
  已照辦；但它另外建議「兩條路都做」，我只做 harness 那條，因為手改 4 段從沒執行過、
  無法便宜驗證的字串，等於憑空增加一次轉錄錯誤的機會。
- **審查員自己也有錯**：它說 repo 版 hook 的 `rejectedAlternatives` 裡「npm 套件也會少掉它」
  是錯的（這個 hook 從未隨 npm 散布）——這一點它對，而我因此沒沿用那段理由。
  但它同時假設我會把新突變插在清單最前面而推移 CHANGELOG 行號；我是附加在結尾，不成立。

### 已知問題（仍未修）

- **日常 effort 之外的第二個 repo↔治理文件矛盾**：repo 版 hook 的 REFERENCE 寫「反覆卡住才
  升級」、`dispatchGuidance` 的情境列字面叫「同一個問題卡超過 5 次」，而使用者的全域
  `~/.claude/CLAUDE.md` 與實際載入的 hook 寫的是「同一工具／假設**連續失敗 2 次**即停止回報」。
  兩者語意不同（一個是「換更強的模型」、一個是「停下來回報」），不是同一個軸，
  所以沒有照 effort 的方式一併對齊——要不要收斂成一條需要使用者拍板。（Claude）
- **`gpt-5.5` 將於 2026-10-14T19:00Z 退役**，vendor 的 `upgrade` 欄位建議改用 `gpt-6.1-sol`。
  退役後要動的地方：`CODEX_MODELS`、`KNOWN_BAD_MODELS` 那筆、`mcp.ts` 拿它當「只到 xhigh」
  例子的那句、`tests/` 裡把它當 fixture 的四處、`tools/mutations.json` 裡含它的片段。
  退役當天應該先派一個 job 收那個 HTTP 400，才寫得出有證據的理由。（Claude）


### 變更（`dispatchGuidance` 的「日常派工」換代為 GPT-6.1 Sol）

- **`models` 的 `dispatchGuidance`「日常派工」從 `gpt-5.6-sol` 改成 `gpt-6.1-sol`**
  （`reasoningEffort` 維持 `high`）。理由：vendor 已把 `gpt-5.6-sol` 標成
  `"Older generation workhorse model"`，現行的是 priority 1 的 `gpt-6.1-sol`
  （`"Latest workhorse model for coding and everyday work"`），而且 vendor 自己的文案說它
  `"near-Astra performance at a lower cost"`——比舊的新、又比 astra 便宜，正好是這一列要的。
  （Claude，moerasermax 指示）
  - note 補一條警告：**`gpt-6.1-sol` 的 CLI 端預設 effort 是 `low`**（不是 `medium`），
    所以省略 `reasoning_effort` 不等於拿到這裡建議的強度，一定要明確傳。
  - note 同時標明「astra 最貴」這句**出自使用者的派工政策，不是從 vendor 目錄推出來的**——
    那份目錄沒有價格欄位。（稽核者標為待確認的項目，照實註明出處而不是刪掉。）
  - 同步 `tools/hooks/aicli-model-policy.py` 的兩處型號。
- 「稽核／第二意見」那一列**保留** `claude-ultra` 與 `gemini-3.1-pro-high` 兩個選項，
  只在 note 補上後者的交付率事實：2026-09-09 通讀長文件撞過 agy 的 5 分鐘 print timeout；
  2026-10-03 派同一份稽核，430 秒後 stdout 累計只有 177 bytes（就是那一行 agy warning），
  之後 ai-cli MCP 連線中斷、結果再也取不回來。所以**不要把它當兩路稽核中唯一的那一路**，
  或先用一個小 job 確認它會回話。（Claude）

### 修正（突變測試自己的三個假綠燈）

- **兩個突變的 `expect` 不是對應斷言名稱的子字串**，所以一直被判成「KILLED(其他斷言)」
  而不是「KILLED」——測試確實失敗了，但 harness 無法確認**是不是那條該抓的斷言**抓到的，
  保證比看起來的弱。（Claude）
  - 「日常派工建議改成一開始就用最貴的 astra」：`日常派工要 sol + high，不是一開始就 astra`
    → `日常派工建議與模型政策一致`
  - 「dispatchGuidance 沒接進 models payload」：`呼叫端是 AI，建議表要在工具回傳裡`
    → `models 帶 dispatchGuidance`
  - 修完 `verify-alias-config.mjs` 的 38 個突變從「KILLED 38（其中 **2** 是被其他斷言抓到）」
    變成「KILLED 38（其中 **0** 是被其他斷言抓到）」。
- **「日常派工」斷言沒有綁定 `situation`**（既有覆蓋缺口，2026-10-03 稽核指出）：原本只比對
  `g.model` 與 `g.reasoningEffort`，所以把這組設定搬到別的情境、而「日常派工」那列改錯，
  斷言照樣會過。加上 `g.situation === '日常派工'`，並補一個突變（把那列的 `situation` 改名）
  證明這個條件真的承重。突變 97 → 98。（Claude）
- 斷言名稱刻意從「（sol + high…）」改成「（現行 workhorse + high…）」**不寫死型號**：
  這一列的模型會隨 vendor 換代而改，而對應突變的 `expect` 必須是斷言名稱的子字串——
  名稱綁型號的話，每次換代都要連 `expect` 一起改，少改一個就靜默退化成「KILLED(其他斷言)」。
  這正是上面那兩筆的成因。（Claude）

### 已知問題（當時未修 — ⚠️ 其中「5 筆壞突變」已於本頁最上方那一批修掉）

- **`tools/mutations.json` 有 5 筆突變永遠無法套用**，跑到就是 `ERROR`。兩種成因：（Claude）
  - 4 筆的 `from` 片段內含 **CRLF**（`tools/mutations.json` 第 468、508、548、556 行附近；
    其中 508 那筆只有 `from` 含 CRLF、`to` 是單行）。`tools/mutation-test.mjs:121` 會把
    **原始碼**正規化成 LF，但第 122 行拿 `mutation.from` 原樣比對、**沒有正規化片段**，
    所以永遠對不上。對應「重試事件」「provider 簡寫」「reasoning replay」「非法 replay_reasoning」
    四個突變，都歸 `verify-extra-body.mjs`。
  - 1 筆（`tools/mutations.json:194`，「unrestricted 仍走嚴格組裝」）的片段
    `return { authority: 'unrestricted', agent, built };` 在現行 `src/app/exec.ts` 已不存在——
    那裡已改寫成條件運算式（`src/app/exec.ts:243` 起）。歸 `verify-exec-contract.mjs`。
  - 這 5 筆剛好全在**本次沒有執行的那兩支腳本**底下，所以一直沒被發現。
    用 `8d262b6`（本批之前）的 `mutations.json` 驗證過，確認是既有問題。
  - 修法有兩條路：把片段統一成 LF，或在 harness 同時正規化 `from`／`to`。後者會讓那 4 筆
    真的開始執行，可能再暴露別的東西，所以該另案處理、另跑一次稽核。
- **日常派工 effort 的 `high`／`medium` 矛盾仍在，本批刻意沒動**：`src/models/catalog.ts`
  與 repo 內的 `tools/hooks/aicli-model-policy.py` 都寫 `high`，而使用者的全域
  `~/.claude/CLAUDE.md` 與實際載入的 `~/.claude/scripts/aicli_model_policy.py` 寫 `medium`。
  這是政策層的決定，不該由這個 commit 代為選邊。本批只換型號，沒有新增不一致。（Claude）

### 稽核紀錄（CONTRIBUTING §5.1）

- **稽核者**：`gpt-6-astra` + `high`。因為 ai-cli 的 MCP 連線在本 session 中途斷掉
  （ai-cli 與 tkflyc-planner 同時掉線），這一輪改走 **CLI 入口**
  `node dist/bin/ai-cli.js run`——它沒有 `--capabilities` 旗標，所以**不是**嚴格唯讀模式，
  唯讀是靠 prompt 要求的。稽核者自述只讀檔與搜尋，未改檔、未跑測試或建置。
- **判定**：**本批新增實質問題 0。** 確認 4 類既有問題。
- **已採納並修（2 項）**：
  1. 日常派工斷言沒綁 `situation`（上面「修正」第二條）。
  2. 「astra 最貴」無法由無價格欄位的 vendor 目錄佐證——照實標明出處，而不是刪掉這句政策。
- **採納為「已知問題」但不在本批修（2 項）**：5 筆壞突變、`high`／`medium` 政策矛盾。
- **稽核者對我的說法提出的修正**，已照它的版本寫入上面：第 508 行那筆只有 `from` 含 CRLF；
  `src/app/exec.ts` 的 `unrestricted` 已改寫成條件運算式而不是單純消失。
- **稽核者明確拒絕背書的一項**：它說我對 gemini 那次失敗的描述（「7 分鐘、一行 warning、
  其餘 0 bytes」）在它手上的資料裡無法獨立驗證，不能因為我這樣講就當成已查證。
  這個反駁是對的——那是我在本 session 的第一手觀察，沒放進它的證據包。
  因此 note 改寫成可查證的量測值（430 秒 / 177 bytes），不再用「7 分鐘」這種轉述。
- **稽核者查過並判定沒問題**：vendor 換代事實逐欄相符（description 原文、`priority: 1`、
  `default_reasoning_level: "low"`、`near-Astra` 文案都是原文子字串，且沒有把 priority 1
  誤寫成效能最強）；斷言非恆真；兩個新 `expect` 確實是斷言名稱的子字串；repo hook 與
  `catalog.ts` 一致；`gpt-5.6-sol` 的 6 處殘留逐一判斷後都該保留（候選模型、effort 能力
  紀錄、換代理由、README 的 alias 相容說明）。


### 新增（codex 清單對回 vendor 現況：補 GPT-6.1 Sol、移出五個已下架名稱）

- **codex 清單補上 `gpt-6.1-sol`**，依 vendor 的 `priority` 排在最前（priority 1）。
  來源是 codex-cli 0.160.0 所用的 `~/.codex/models_cache.json`：`"Latest workhorse model for
  coding and everyday work"`、effort 到 `ultra`、**CLI 端預設 `low`**。實跑 `gpt-6.1-sol` + `low`
  exit 0 正常回答。補之前它就派得動（`gpt-` 前綴本來就路由到 codex），只是 `models` 不把它
  當候選講出來——和 `fable`（issue #12）、`gpt-6-sol`/`gpt-6-luna` 同一種情況。（Claude，moerasermax 指示）
- **`codex-ultra` 刻意不改**，仍指向 `gpt-6-astra`。**vendor 的 `priority` 不是能力排名**：
  `gpt-6.1-sol` 是 priority 1，但它的定位是 workhorse，而 vendor 自己的推薦文案寫
  `"near-Astra performance at a lower cost"`——「接近 astra」不是「超過 astra」。
  旗艦仍是 `gpt-6-astra`（`"Frontier intelligence for the most demanding work"`）。
  測試裡釘了這一條，避免日後有人因為「有更新的名字」就把 alias 改指過去。（Claude）
- `KNOWN_BAD_MODELS` 新增 `gpt-5.5`：vendor 的 `upgrade` 欄位標明 **2026-10-14T19:00Z 退役**、
  建議改用 `gpt-6.1-sol`。退役前仍可派，effort 仍只到 `xhigh`。（Claude）
- `verify-alias-config.mjs` 第 3c 節新增 22 條；`tools/mutations.json` 新增 5 個突變
  （92 → 97），其中一個是反向突變：把「移出清單」誤做成「擋下路由」。（Claude）

### 移除（五個已不在 vendor 目錄的 codex 候選名稱）

- **`gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` / `gpt-5.3-codex-spark` / `gpt-5.2`
  從 `CODEX_MODELS` 移出**，停止把它們當候選廣告出去。（Claude）
  - **移出清單不等於擋下來。** `matchesModel` 是 `startsWith('gpt-')`，明確指定這些名稱
    仍然會被路由到 codex，也**仍然設得成 alias target**。測試對這五個各釘三條
    （不在清單／仍路由到 codex／仍設得成 alias target），把兩件事分開。
  - 依照既有結論**沒有**把它們放進 `REMOVED_MODELS`：`removedModelMessage()` 的文案固定
    指向 Kiro／Forge，塞進去會回一個不相干的錯誤。要真的擋得另建 tombstone。
  - 2026-10-03 五顆**各實測一個 trivial job**：全部 `exitCode 1`，CLI 先印
    `Model metadata for <name> not found.`（退回 fallback metadata），接著 API 回 HTTP 400
    `The '<name>' model is not supported when using Codex with a ChatGPT account.`
    **與 2026-09-05 的錯誤原文一字不差**，所以「帳號層級擋下」這個歸因仍然成立，
    「不在 vendor 目錄」只是同一件事的另一面（這份目錄是依帳號給的）。
    2026-09-11 知識庫記下的「舊歸因存疑、不能斷言是哪一種失敗」到此結案。（Claude）
- `gpt-reserve` 與 `codex-auto-review` **沒有**被加進清單：vendor 標 `visibility: "hide"`，
  它自己就不對外列出。`hide` 只證明「不列出」，所以註解沒寫成「只供 CLI 內部使用」——
  那兩顆的實際用途沒有實測。（Claude）

### 變更

- `run` 的 `reasoning_effort` 描述加入 `gpt-6.1-sol`，並補一句**各模型 CLI 端預設 effort 不同**
  （`gpt-6.1-sol` 與 `gpt-5.6-sol` 預設 `low`，其餘 `medium`），所以「不傳這個欄位」在不同模型
  之間不是同一件事。（Claude）
- `run` 的 `model` 參數描述寫明 `gpt-6.1-sol` 不是旗艦、以及五個名稱為什麼被移出、
  移出之後行為是什麼。（Claude）
- `verify-e2e.mjs` 的 codex 那一顆從已下架的 `gpt-5.4-mini` 換成 `gpt-6-luna`。
  這支腳本燒真實額度，留著只會穩定失敗。（Claude）
- `tools/hooks/aicli-model-policy.py` 的派工指引更新：五個名稱的現況與實測錯誤原文、
  「最新不等於最強」、`gpt-5.5` 退役日期；順帶把 DashScope 免費額度那行從未來式
  （「2026-09-30 到期」）改成「該日已過，派之前先確認」。（Claude）
- 原始碼註解不再引用 `models_cache.json` 的 `fetched_at` 到「分」：那個欄位每隔幾分鐘就被
  重抓一次，寫死就會自我作廢。改為記「2026-10-03 當日讀三次（01:01Z／02:04Z／02:13Z，
  中間一次是稽核者讀的）**10 筆內容完全相同**」——證明的是目錄內容穩定，不是某一次快照。（Claude）

### 修正

- **`modelListCaveat.notAnAllowlist` 對 `isKnownModelTarget()` 的描述是錯的。**
  原本寫「`set_config` 設定 alias target 走的是 `isKnownModelTarget()`，那裡**是**白名單，
  所以派得動的名稱不一定設得成 alias——兩個介面對『認不認得』的語意相反」。
  讀程式碼：它**不是純白名單**——清單命中算，而「非 `claude` 的 agent 的 `matchesModel` 命中」
  也算。所以任何 `gpt-*` 即使不在清單裡也設得成 alias（既有斷言 `isKnownModelTarget('gpt-9-future')`
  就釘著這件事）。真正被擋的是「只靠 `claude` catch-all 才跑得起來」的名稱（例如
  `claude-sonnet-4-6`）、**alias 名稱本身**（`run` 會展開 alias，這裡一律拒絕，所以連
  `codex-ultra` 都不能當 target），以及已移除模型。這次移出五個 `gpt-*` 名稱會讓原本那句
  更容易被誤讀成「這五個再也不能當 alias target」，所以一併改掉。（Claude）
- **`src/agents/codex.ts` 的 reasoning 註解還留著 8d262b6 已經推翻的那句**
  （「模型不支援的級別由 codex CLI 自己拒絕，錯誤訊息會原樣回到呼叫端」）。
  那次只改了 `mcp.ts` 的工具描述，漏了這段註解——於是同一個 repo 裡兩處對同一件事的說法相反。
  改成寫出實測：`gpt-5.5` + `max` 是**建完 thread 與 turn 之後**才收到 API HTTP 400（不是 CLI
  本地拒絕），而 `gpt-6-luna` + `ultra`（vendor 說它只到 `max`）exit 0、正常回答、完全不報錯。（Claude）
- **突變測試抓到一個自己造成的假綠燈。** 斷言「caveat 要講出 catch-all 這個機制」原本只檢查
  `notAnAllowlist` 含不含 `catch-all` 或 `fallback` 這兩個關鍵字；而上面那筆 caveat 改寫在
  **另一句**（講 `set_config` 的那段）寫進了「catch-all」三個字——於是既有突變
  「把講機制的那一行換成『這份清單可能不完整。』」當場 **SURVIVED**：關鍵字被另一句餵飽，
  斷言分不出機制還在不在。改成同時要求 `matchesModel`，才真的釘在「說出機制」而不是
  「出現某個詞」。修完該突變回到 KILLED。（Claude）

### 稽核紀錄（CONTRIBUTING §5.1）

- **稽核者**：`gpt-6-astra` + `reasoning_effort: high`，經 `mcp__ai-cli__run` 的嚴格唯讀模式
  （`capabilities: ["fs/read","analysis/produce"]` → `codex --sandbox read-only --ignore-user-config`）。
  刻意不用 Claude：同一家的模型會犯同一種錯。給它的事實來源是從 `models_cache.json` 萃取的
  欄位清單 + 268 行 unified diff，並要求逐條回原始碼驗證。
- **第二位稽核者沒有交付**：`gemini-3.1-pro-high` 同時派出，跑了 7 分鐘只吐出一行
  `warning: --mode plan has no effect...`、其餘 0 bytes，之後 ai-cli MCP 連線中斷，結果取不回來。
  **所以這次只有一位稽核者。** 不把它算成「兩路都通過」。
- **判定成立並已修（3 項，皆低嚴重度）**：
  1. 註解引用的 `fetched_at` 與事實檔不符——稽核者讀到的是 `02:04Z`，我寫的是 `01:01Z`。
     根因是這個欄位會被反覆重抓，不是任何一方讀錯。改成不引用到「分」（見「變更」最後一條）。
  2. 「移出的五個裡**只有** `gpt-5.3-codex-spark` 曾是 xhigh 上限的依據」與同段上一行自相矛盾：
     `gpt-5.4-mini` 也在那一行裡。已改成兩個都列，並補上「`gpt-5.5` 仍在清單裡也仍只到 xhigh」。
  3. 「兩個介面的差別**只在** claude 那一段」說得過頭：`isKnownModelTarget()` 對內建 alias
     一律回 `false`，而 `run` 會展開 alias，所以 `codex-ultra` 就是非 claude 的反例。已改。
- **判定成立並已修（2 項，稽核者標為「待確認」）**：
  4. 「不在 vendor 目錄」不足以證明「指名後必定失敗」——當時手上只有目錄缺席，沒有呼叫結果。
     **沒有改成模糊措辭，而是補做實測**：五顆各派一個 trivial job，拿到上面那段 HTTP 400 原文。
  5. `verify-e2e.mjs` 註解寫 `gpt-6-luna` 是「這三家裡最便宜的」——目錄沒有價格欄位，
     這個最高級沒有證據。已改成只照抄 vendor 的定位。
  - 同一項裡 `visibility: "hide"` 「不能單獨證明只供 CLI 內部使用」也成立，註解已改。
- **稽核者查過並判定沒問題的範圍**（記下來才知道哪些被覆蓋到）：八個可見模型的 slug／排序／
  effort 上限／預設 effort 與事實檔逐欄吻合；`gpt-5.5` 退役時間與升級目標正確；英文引用是原文
  連續片段；維持 `codex-ultra → gpt-6-astra` 有依據；移出五個名稱後的路由與 alias target 行為
  主張成立；22 條新斷言沒有恆真；5 個突變的 `from` 片段都存在、`expect` 都是對應斷言名稱的子字串；
  清單縮短的影響面已 grep（catalog-v2 條目、MCP／CLI 候選、模型描述、設定錯誤提示會跟著變，
  `doctor` 只讀 binary 設定，**沒有**程式依賴 codex 清單的固定長度或索引）。
- **稽核者自己標明的限制**（不當成已驗證）：它對突變只做靜態核對，**沒有**宣稱實跑出 KILLED
  （實跑由 harness 負責，見下）；`remains the strongest` 應理解為依 vendor 產品定位的推論，
  不是全面效能實測；該 session 沒有 Knowledge／Planner 工具可用。
- **我判定不成立／不採納的**：`README.zh-TW.md:583` 提到 `gpt-5.4-mini` 的啟動速度。
  那是一筆**標明日期與受測者的 2026-09-05 歷史量測**，不是「現在可用」的宣稱，稽核者也獨立
  得到同一結論，所以不改。（若要改，正確做法是補一句「該模型已下架、此量測無法重現」，
  但那超出這次範圍，留給使用者決定。）


### 新增（GPT-6 Sol 與 GPT-6 Luna）

- **codex 清單補上 `gpt-6-sol` 與 `gpt-6-luna`**，依 vendor 的 priority 排在 `gpt-6-astra` 後面。
  名稱與能力來自 codex-cli 0.155.1 的 `~/.codex/models_cache.json`（2026-09-26）：兩者都是 text + image
  輸入、CLI 預設 effort medium；`gpt-6-sol`（"Workhorse model for coding and everyday work"）到 `ultra`，
  `gpt-6-luna`（"Fast and affordable model for easier tasks"）到 `max`。（Claude，moerasermax 指示）
  - 補之前它們就派得動：`gpt-` 前綴本來就路由到 codex，只是 `models` 不把它們當候選講出來——
    和 issue #12 的 `fable` 同一種情況。實跑：`gpt-6-sol` + `ultra`、`gpt-6-luna` + `max` 都 exit 0 並照指示回答。
  - 只在 codex-cli 0.155.1 驗過，更舊的 CLI 沒測；`run` 的 `model` 參數描述照實寫了這一點。
- `verify-alias-config.mjs` 第 3c 節新增 6 條（兩個模型各「列在清單」「路由到 codex」，加上
  sol + ultra、luna + max 真的送進指令）；`tools/mutations.json` 新增 2 個突變（把兩個名稱從清單拿掉）。（Claude）

### 修正（`reasoning_effort` 描述對「不支援的組合」的說法）

- `run` 的 `reasoning_effort` 描述原本寫「不支援的組合由 codex CLI 自己拒絕」，這句兩個方向都不成立：
  `gpt-5.5` + `max` 是 API 回 HTTP 400（2026-09-09 已查明，不是 CLI 本地拒絕），而 2026-09-26 實跑
  `gpt-6-luna` + `ultra`——vendor 目錄說它只到 `max`——**exit 0、正常回答**，沒有任何錯誤。
  改寫成「不可靠地被拒絕；exit 0 不代表那個等級真的生效」，並把 gpt-6 兩個新成員放進能力說明。
  程式行為沒改：codex 端仍收六級聯集、不按模型細分。（Claude）

### 新增（`models` 不再假裝自己是可派工模型的全集）— issue #12

- **`claude` 清單補上 `fable`**（`claude-fable-5`，放在最前代表最新一代）。
  它一直派得動——依 issue 回報，`claude --help` 列它是合法別名，實測派工正常回應並自報
  `claude-fable-5-1`——只是不在 `CLAUDE_MODELS` 這份手動維護的靜態清單裡。
  （「別名確切指向哪個 model id」我沒有自己實測，所以原始碼註解不寫死全名。）（Claude）

- **`models` payload 新增 `modelListCaveat`**（`notAnAllowlist` / `notAGuarantee` /
  `authority`），`models` 工具描述也改寫成「這不是 allowlist」。

  **補一筆不是修掉問題。** 真正的根因是 claude agent 是整個 routing 的 catch-all
  （`matchesModel` 永遠回 `true`），任何沒被其他 agent 認領的名稱都會原樣交給
  `claude --model`——**只要 vendor CLI 認得那個名字就跑得起來，清單有沒有列無關**。
  於是這份清單兩個方向都不可靠：不在清單的可能能用（`fable`），在清單的可能不能用
  （`gpt-5.4` 那批被帳號擋下，已在 `knownBadModels`）。

  而它的呈現方式看起來像權威來源。2026-09-11 實際踩到的後果：呼叫端查不到 `fable`
  → 判定「不支援」→ 繞去找替代方案，正確答案其實是直接派。`knownBadModels` 顧的是
  「清單有但不能用」那一半，這次補的是另一半。**清單沒說自己不是全集，讀的人就會
  當它是全集**——所以要工具自己講出來，寫在 README 只有人看得到，而在挑模型的是 AI。（Claude）

### 修正

- **`package-lock.json` 對回改名與授權**（issue #11）。`062c8ef` 改了 `package.json`
  的套件名、`d4de74d` 換了授權，但 lockfile 兩次都沒跟上，停在 `ai-cli-mcp` / `6.1.1` /
  無 `license`。後果是任何人跑 `npm install` 都會讓 lockfile 自己對回去，工作區立刻
  多一筆自己沒改過的 `M package-lock.json`——內容還是正確的，於是每次都要重新判斷一次
  能不能丟。

  ⚠️ 本條初稿照抄了 issue 裡「name 不一致在某些 npm 版本會讓 `npm ci` 拒絕安裝」的說法，
  **那是推論，而且自家 CI 就是反證**：三個平台都跑 `npm ci`，而 lockfile 從 `062c8ef`
  改名起一直是舊 name，這期間 CI 全綠。`npm ci` 的同步檢查比對的是相依樹，不是根套件的
  `name`。實際後果就只有「工作區每次變髒」這一項——那一項是實測過的。（Claude）

- **`verify-catalog-source.mjs` 的逾時門檻改成從實測啟動成本推導**（issue #10）。
  原本寫死 `AI_CLI_DISCOVER_TIMEOUT_MS=500`，而 spawn 一次 stub（win32 是
  `.cmd` → `cmd.exe` → `node.exe`）的成本差一個數量級：本機實測 68–80 ms，
  回報問題的那台消費端機器 763–886 ms，三次裡紅 3、3、2 支。

  **這不是「測試比較嚴」，是那題什麼都沒驗到**：門檻在 node 開機完成前就觸發，
  stub 連 `trace('started')` 都執行不到，trace 是空的、`pid` 是 `undefined`，
  於是「逾時有沒有殺掉子程序」無從判斷——而失敗訊息指向產品。改門檻（500→1500）
  只是把同一個坑推給下一台更慢的機器，所以改成先量一次實際 spawn 成本，
  再取 `max(500, 成本 × 3)`，stub delay 維持 1:4 比例，相關斷言一併改成跟著門檻走。

  另外補一條**前提斷言**：`started` 不存在時明說「門檻低於本機啟動成本」並印出
  兩個數字，而不是讓它偽裝成產品沒殺掉程序。（Claude）

- **逾時預算不再洩漏到不相干的斷言**（issue #10 的第二半）。切換到 `errorStub` 時
  沒有還原 `AI_CLI_DISCOVER_TIMEOUT_MS`，於是「非零退出時 stderr 第一行怎麼取」
  那兩題也吃到 500 ms 預算，跟 node 啟動成本賽跑並固定輸掉——回傳的是逾時訊息
  而不是 stderr 內容。還原點從「再下一段」提前到切 stub 的當下。
  **這一項是讓測試變準，不是變鬆。**（Claude）

- **突變 harness 跑不起來**：`tools/mutation-test.mjs` 驗基準時跑的是
  `run([script])`，但 `46c6e75` 把測試搬進 `tests/` 之後只改了套用突變後的那一行
  （`join('tests', …)`），基準那行沒改，於是必定停在「基準未通過，中止」。
  同一次搬移還漏了 `package.json` 的 `verify:strict-behaviour`（仍指根目錄的舊路徑），
  一併修正。兩處都因為不在 `npm test` 的 `&&` 鏈上，CI 綠燈看不到。（Claude）

- `verify-update.mjs` 的 fixture 網址從 `ai-cli-mcp-source` 換成 `tkflyc-ai-cli`。
  測試是自洽的（那個常數只是塞進假 package 的 `homepage` 再驗通知字串包含它），
  換成什麼都會過；留著舊 repo 名只會讓讀的人以為那是真實設定。（Claude）

### 測試

- 突變 **81 → 90**。新增的九個：`fable` 從清單移除、`modelListCaveat` 從 payload 拿掉、
  caveat 不提 catch-all 機制、子程序在門檻觸發前沒跑起來、`started` 來得太晚、
  還原行被刪掉，以及三個守工具描述的（`run` 描述改回「Supported models」、
  `model` 參數描述拿掉警告、`models` 描述不再指向 `modelListCaveat`）。

  其中「子程序沒跑起來」那個突變改過兩次形狀才站得住：先壓 `timeoutMs` 會連帶
  縮短 stub delay（stub 反而來得及跑完），改成連 stub delay 一起釘住又在本機
  SURVIVED——Windows 上 kill 掉 `.cmd` 外殼後 `node.exe` 仍會啟動並寫下 `started`。
  最後直接注入那個狀態本身（stub 不寫 `started`）才殺得掉。
  **只在慢機器上浮現的 bug，本機突變要注入的是它的「狀態」，不是它的「成因」。**（Claude）

### 稽核紀錄（2026-09-11）

這批不動 `core/`，所以 CONTRIBUTING §5.1 的稽核義務不強制；仍然跨家派了五個獨立稽核者，
因為改的是**寫給另一個 AI 讀的文字**，而那種錯誤自己看不出來。

- **gpt-5.6-sol（high，唯讀沙箱）** 六條，全部成立並修掉：`run` 的工具描述仍寫
  「Supported models」（修法沒到達真正在挑模型的介面）、`authority` 錯稱四個陣列都是
  靜態值（`modelsByAgent()` 會把 antigravity 實查到的模型併進來）、catch-all 敘述
  漏掉 alias 解析與 `REMOVED_MODELS` 攔截、`started` 沒有時間戳所以證明不了「在門檻
  觸發前啟動」、「預算洩漏」突變用 1 ms 製造的是另一個錯誤而非保護還原行、
  CHANGELOG 把 `npm ci` 的推論寫成事實。它誠實聲明唯讀沙箱擋下了實跑，
  沒有宣稱測試跑過。
- **claude-ultra（唯讀沙箱）** 十一條，其中六條是 sol 沒看到的，全部成立並修掉：
  斷言少一個 `?.`（欄位消失時是整支崩潰而非 FAIL，後面約 350 行都不會跑，
  而 harness 只看 stdout 的 FAIL 行，看不出這件事）、前提斷言沒讓「指向產品」那條
  閉嘴（慢機器上會同時紅兩條、訊息互相矛盾）、工具描述那一半零測試覆蓋、
  caveat 沒講 `set_config` 的 alias target 走的**是**白名單（兩個介面語意相反）、
  baseline 量測失敗時門檻會靜默退回 500（正好回到要修的狀態）、
  `fable` 的「全名」在同一批改動裡有兩種說法。
- **gemini-3.1-pro-high** 回「沒有發現」，六個點逐一宣告無異常——但其中「caveat 描述
  完全符合實際程式行為」與 sol／ultra 查到的兩個事實錯誤直接衝突。**採信前兩者**
  （已逐條回原始碼驗證）。
- **nv-meta/muse-glimmer-30b** `exitCode: 0` 但 `message` 是空字串
  （`finish_reason: tool_loop_limit`，燒掉約 100 萬 input token 卡在讀檔迴圈）。
  **不計入同意**——這正是 ADR-085 ⑫「把 unknown 折進 ok」的形狀。
- **nv-nvidia/nemotron-3-ultra-550b-a55b** 逾時未回，同樣不計入。

修完之後又跑了一次錨點檢查，發現 caveat 改寫讓一個新突變的 `from` 失效——
**改文字會讓既有突變悄悄變成 ERROR**，這點本批已驗證並修正。（Claude）

### 變更（測試腳本改置於 `tests/`，無對外行為變化）

- **15 支 `verify-*.mjs` 從 repo 根目錄移進 `tests/`。** 根目錄本來被這排測試檔塞滿，
  訪客第一屏看不出這 repo 在做什麼；搬進 `tests/` 後根目錄只剩 README / 設定 / 授權等
  頂層檔。這是純搬移，`npm test` 內容、CI、突變 harness 覆蓋範圍都不變。
- 搬移的路徑處理：每支測試以「自己所在目錄的上一層」為基準讀 `dist/`、`src/`、`tools/`
  （`const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))`；`new URL` / 相對 import
  一律改成 `../`）。連帶更新 `package.json` 的 test script 前綴、`tools/mutation-test.mjs`
  跑腳本時補 `tests/`、以及 README / CONTRIBUTING / CLAUDE.md 的位置與支數敘述
  （順手把 CONTRIBUTING 過時的「十支」更正為實際的十三支）。
- typecheck / build / npm test（13 支、零 FAIL）在新位置全綠。（Claude）

## [6.2.0] - 2026-09-10

### 新增（本機 OpenAI 相容端點也能當 provider）

- **direct-api 接上一顆本機 llama.cpp 模型**（`localcoder` → `http://127.0.0.1:18090/v1`）。
  這件事**不需要改任何程式碼**——那正是 direct-api 的設計目的，這裡記一筆是因為它
  驗證了「本機端點」這條路真的走得通，以及兩個只有本機才會踩到的點：

  `api_key` 對 llama-server 沒有意義（它不驗證），但載入端要求非空字串，
  給不出來會讓**整份 `providers.json` fail-closed**、連 OpenRouter 一起掛。放佔位字串。

  模型要登記進 `model_extra_body` 才會出現在 `models` 回傳的 `knownModels` 裡。
  順帶把 `max_tokens` 綁上 llama-server 的 `--ctx-size 8192 --parallel 1`。

  實測：`localcoder-qwen25coder-abliterated` 回 `pong`（2 output tokens、`finish_reason: stop`），
  續接同一個 session 後 input 從 673 掉到 66 且答得出前一回合的字。

### 修正（🔴 antigravity 從來沒有真的續接過）

- **`agy` 改吃 `--output-format json`。** 舊碼解析的是 `--print` 的 text 格式，
  那個格式**沒有 `conversation_id`**——於是 antigravity 這條路等於完全無法續接，
  而且失敗方式是靜默的：`--conversation` 只認 agy 自己發的 id，呼叫端自編一個傳進去，
  agy 印一行 warning 然後**開一個新對話**。回答看起來正常，但每一回合都是新的。

  換成 json 之後拿得到 `conversation_id` 與 `usage`。實測續接有效：同一個 id 第二回合
  答得出第一回合記住的字串，**id 不變**（與 codex 同語意，與 claude 的 fork 不同）、
  `num_turns` 1→2、`input_tokens` 15319→31227。

  三件不能省的事：warning 印在 JSON **前面**，所以不能對整段 `JSON.parse`，要逐行挑；
  那行 warning 是 resume 失敗的**唯一訊號**，保留成 `warnings` 欄位交給呼叫端判定，
  不能因為換了格式就吞掉（吞掉＝把 unknown 折進 ok）；text 解析保留成 fallback，
  不為了新欄位把既有能力弄丟。

- **順帶更正 `buildStrictCommand` 的註解：`--mode plan` 擋不住檔案寫入。**
  三組對照實驗（同一個 prompt、各跑到模型自己結束、不是 timeout）：
  `--sandbox --mode plan` 模型照樣呼叫寫入工具把檔案建出來；加上
  `--disable-slash-commands` 行為一模一樣；叫它寫 cwd 以外的絕對路徑才被 vendor
  工具層擋下並回報原因。真正擋下來的是 `--sandbox`——檔案都落在 agy 自己的
  `brain/<conversation_id>/`，cwd 兩次都是空的。

  所以唯讀能力的保證是「**寫不出 brain 目錄**」而不是「不寫檔」，來源是 vendor 沙箱
  不是 plan 模式。旗標維持原狀，只把註解從推測換成實測。

- 新增 `verify-agy-parse.mjs`（13 條）並接進 `npm test`。突變驗證：拿掉 `buildCommand`
  的 `--output-format json` 與 `parseOutput` 的 `session_id` 輸出，正好紅 3 條、
  其餘 10 條不受影響，還原後回綠。

### 新增（MCP `run` 的系統提示通道）

- **`run` 新增 `system_prompt` 參數**，claude 走 `--append-system-prompt-file`。

  用途是「操作方的框架」——關於**這場對話怎麼運作**的話：你是稽核者、只回報不改碼；
  或者以下這些標記與逐筆重播是工作台產生的，不是使用者打的字。寫進 prompt 內文，
  它就出現在**使用者訊息的位置**，長相是提示注入的標準形狀，對齊良好的模型會合理地
  拒絕照做。一個實際遇到的案例（某個做續接對帳的呼叫端），模型的原話是：
  「…都是被塞進使用者訊息內文的提示注入……我不會附加 `[ack ...]` 標記」。
  系統提示是操作方自己的通道，那裡的文字天生就不是使用者輸入。

  **fail-closed**：agent 沒有系統提示通道時**拒絕啟動**，不是靜默忽略。靜默忽略會讓
  呼叫端以為那段說明送到了、而模型什麼都沒看到，比不支援更糟——它看起來成功了。
  `AgentDefinition.supportsSystemPrompt` 省略等於沒有。
  目前只有 claude 有這條通道；codex exec 只有 `-c key=value`、agy 的 23 個旗標裡
  沒有對應項（2026-09-10 查 `--help`）。**這是 vendor 的現況，不是我們挑呼叫端。**

  **走檔案不走 args**：Windows 上 claude 是 npm 的 `.CMD` shim，spawn 需要 `shell:true`，
  而 cmd.exe 會對含空白／換行的長參數重新切詞、並在換行處截斷（prompt 因此早就改走 stdin）。
  系統提示同樣是多行長文字，走 args 會踩一模一樣的坑，而且失敗的樣子很難看：
  指令跑得起來、系統提示卻少了半截。暫存檔寫在 `%TMP%/ai-cli-system-prompts`，
  每次寫入順手清掉超過 6 小時的舊檔——沒有人會回來刪這些檔。

  守門：`verify-mcp-system-prompt.mjs`（已進 `npm test`）釘住五件事——schema 真的收這個欄位、
  參數真的送到 CLI **且檔案內容逐字相符**（只驗「參數有沒有送出去」是不夠的）、
  唯讀回合（strict builder）也帶得上、不給時完全不出現、以及不支援的 agent 會被拒絕。

  ⚠ 誠實補一句：**這個參數解不了上面那個拒絕問題。** 呼叫端把說明改放系統提示之後
  逐字送達，模型照樣拒絕，理由一字未改。真正的根因是「模型自己先前的拒絕訊息被重播回去」
  （見 tkflyc-launcher ADR-093）。保留它的理由因此**不是**「某個呼叫端需要」，
  而是「有系統提示通道的 agent 本來就該讓呼叫端用得到」——這個參數的後續演進
  不要照著那個已經作廢的動機去推論。（Claude）

### 已知缺陷（未修）

- **`codex exec resume` 不接受 `--sandbox`**，但 codex 的 strict builder 在 resume 時照樣加了它，
  於是「唯讀 ＋ 續接既有 session」在 codex 上直接起不來：
  `error: unexpected argument '--sandbox' found`（實測 exit 2）。
  唯讀且不 resume、或 resume 但不唯讀都正常，只有兩者同時才炸。（Claude）


### 修正（🔴 嚴格模式一直擋不住寫入）

- **`ai-cli exec` 的嚴格模式（唯讀）從上線那天起就擋不住寫入。** 如果你把 `exec`
  當成「模型只能讀、不會動我的檔案」在用，那個保證一直不成立。

  `--allowedTools` 的語意是「**這些不用問**」（預先核准），不是「只能用這些」。
  實測 `claude --allowedTools Read,Glob,Grep --strict-mcp-config
  --disable-slash-commands -p "用 Write 建立 a.txt"`，檔案真的被建立了；
  同一輪試過 `--permission-prompts none` 也一樣擋不住。

  改用 `--disallowedTools`（實測擋得住，一般問答不受影響）。`--permission-mode plan`
  也擋得住，但它會把模型推進規劃心態、不直接回答，不適合「我只想問一句話」的唯讀回合。

  **這個缺陷沒被發現，是因為既有斷言只驗「參數有沒有送出去」**——旗標對了、畫面說唯讀、
  程序其實能寫檔。新增 `verify-strict-behaviour.mjs`：**不看參數，只看結果**——叫模型
  寫一個檔案，再去看那個檔案在不在。它會真的呼叫 CLI、用掉額度，所以不進預設
  `npm test`，用 `npm run verify:strict-behaviour`。
  `src/agents/claude.ts`、`verify-strict-behaviour.mjs`（`697b721`）
  （由 Claude 依該 commit 訊息補記 CHANGELOG；改動本身不是本人所寫）

### 新增（唯讀回合不再只有 exec 走得到）

- **MCP `run` 新增 `capabilities` 參數。** `exec` 從一開始就有嚴格模式，但那條路只有
  `exec` 走得到——MCP `run` 一律走一般組裝，帶著 `--dangerously-skip-permissions` /
  `--dangerously-bypass-approvals-and-sandbox`。於是任何透過 MCP 使用這個框架的呼叫端，
  就算自己不做 git 快照，模型仍有完整寫入能力。**「我不做快照」不等於「它不會寫檔」**——
  那樣做出來的唯讀回合是一個沒有回復點的可寫回合，比什麼都不做更糟。

  不給 `capabilities` 就是既有行為；給了就走 agent 的 strict builder，agent 沒有
  strict builder 就丟錯、**不退回**一般模式（fail-closed）。

  三個判準：`undefined`（沒有意見）與 `[]`（什麼都不給）**分得開**，折成同一件事等於
  讓要求限制的呼叫端拿到全開權限而不自知；`process-service` 與 `file-process-service`
  **兩條啟動路徑都轉送**，只有一條擋得住的話呼叫端要看運氣；`exec.ts` 那份自己的
  fail-closed 收掉改走同一個入口，因為**權限政策抄兩份的下場，是其中一份哪天漏改
  而沒有人發現**。順帶修掉舊版傳給 strict 的 `reasoningEffort` 是 `?? ''`（跳過 alias
  解析與設定檔預設）的不一致。

  `verify-mcp-capabilities.mjs`（8 條，已進 `npm test`）釘住：不給＝既有行為、
  給了＝零危險旗標、空陣列仍 strict、沒有 strict builder 就拒絕、schema 宣告了也真的
  轉送、兩條啟動路徑都收。

  ⚠️ **已知邊界**：codex 的 strict builder 帶 `--ephemeral`，可能不保存原生 session，
  影響下一輪 `resume`。不影響檔案唯讀保證，但要用唯讀回合續接前得先釘一條驗收。

  ⚠️ **這是 `core/` 改動，但沒有 CONTRIBUTING §5.1 要求的獨立稽核紀錄。**
  本條只補了 §3.2 的行為變化，稽核那一件沒有補——沒發生過的事不能事後寫成發生過。
  `src/app/mcp.ts`、`src/core/command-builder.ts`、`src/core/process-service.ts`、
  `src/core/file-process-service.ts`、`src/app/exec.ts`、`verify-mcp-capabilities.mjs`
  （`b9ad530`）
  （由 Claude 依該 commit 訊息補記 CHANGELOG；改動本身不是本人所寫）


### 新增（工具說得出自己是誰）

- **`doctor` 與 `models` 的回傳新增 `server` 欄位**：`name` / `version` /
  `repository` / `homepage` / `note`，來源是新檔 `src/core/identity.ts`。

  為什麼要有它：MCP 的註冊內容只有一行 `node <path>/dist/server.js`，呼叫端多半
  是另一個 AI，它從工具名認得出「有 ai-cli 這組工具」，**認不出對應哪個 repo、
  哪個 npm 套件**。於是它會去查外部紀錄——而 2026-09-09 改名之後，所有既有紀錄
  同時變錯。**識別資訊不能只存在文件裡**，文件要靠人記得更新，而改名恰好是
  「所有既有紀錄同時失效」的事件。能自我描述的東西才撐得住改名。

  三條規則與 `describeConfiguredProviders` 同源：永不丟錯、不查網路、
  **不硬編名稱**（寫死的話下次改名就會再說一次謊）。
  `repository` 只正規化 `http(s)://` 與 `git+http(s)://`，其餘原樣回傳。
  `src/core/identity.ts`、`src/core/doctor.ts`、`src/models/catalog.ts`、
  `src/app/mcp.ts`（`dc0eccc`）（Claude）

- 兩個工具的 description 也寫明了這件事。工具描述是呼叫端**決定要不要呼叫之前
  唯一讀得到的東西**；只把欄位放進 payload，等於假設對方會先呼叫再發現。（Claude）

### 修正（`server` 欄位的獨立稽核結果）

稽核者：`gpt-5.6-sol`(high) 與 `claude-ultra`，各自獨立、全程只讀原始碼。
`dc0eccc` 當初**漏做了 CONTRIBUTING §5.1 要求的獨立稽核與 CHANGELOG 紀錄就 push**，
這一段是補做的結果。

**找到並已修：**

- **`note` 成功時整個欄位消失**（`note?: string`）。這是 doctor / models 兩份
  payload 裡唯一這樣設計的欄位——`describeConfiguredProviders`、`updateNotice`、
  `checks.loginState` 全都是「欄位永遠在、值為 null」。欄位消失時，呼叫端分不出
  「這一版沒有這個欄位」與「這一版有、只是這次沒問題」。改為 `note: string | null`。（claude-ultra）
- **`normalizeRepositoryUrl` 對認不出的形狀做了半套正規化。**
  `git@github.com:o/r.git` 會被剝成 `git@github.com:o/r`——既不能 clone 也不能貼進
  瀏覽器。**半套正規化比不處理更糟**，因為呼叫端是 AI，它會直接當網址用。
  改成只處理 `http(s)` 形狀。（gpt-5.6-sol）
- **握手的版本 fallback 是 `'0.0.0'`。** 那是合法 semver，呼叫端會當成真版本，
  而同一個行程的 `doctor` 卻回 `version: null`——兩邊打架。改成 `'unknown'`
  （MCP 的 `serverInfo.version` 只要求字串）。另外空字串／純空白會通過
  `typeof === 'string'` 而 `??` 不會啟動，改用 `trim()` 判斷。（claude-ultra、gpt-5.6-sol）
- **`note` 原本回原始 `error.message`。** ENOENT / EACCES 的訊息通常帶絕對安裝路徑
  （在 Windows 上就是使用者名稱與目錄結構），而這個結構會原樣進工具回傳。
  改成只回錯誤類別，詳細訊息寫 stderr。（gpt-5.6-sol）
- **身分是可變單例**，doctor 與 models 共用同一個實例。改為 `Object.freeze`。（兩位都提）
- 快取註解「套件檔在行程存活期間不會改變」不精確——背景更新確實會改磁碟，
  只是執行中的 server 仍跑舊 dist。改成「身分描述的是本次已載入的這個 process」。（gpt-5.6-sol）

**判定成立、但這次刻意不做：**

- `doctor` 的回傳型別仍是 open index signature，每加一個具名欄位就要再撐寬一次，
  型別對呼叫端的資訊量遞減。正解是把 agent 狀態收進 `agents:` 子物件——那會動到
  既有呼叫端，屬於 MAJOR，不在這一輪。（兩位都提）
- **下一版應為 `6.2.0`（MINOR，純加欄位）。** 目前 `package.json` 仍是 `6.1.1`，
  與 npm 上**沒有**這個欄位的 `6.1.1` 同號——那個為了「說得出自己是誰」而生的欄位，
  此刻分辨不出自己是哪一份。這與 npm `6.0.0` 對不上 tag 是同一種形狀。發版前務必 bump。（claude-ultra）

**判定不成立（稽核者自己推翻的懷疑）：**

- 「缺檔／壞 JSON／package 根節點異常會殺死 MCP」——讀取與欄位存取都在同一個 `try/catch` 內。
- 「失敗結果是 falsy，所以每次都重讀」——失敗回傳的仍是物件，會快取到 process 結束。
- 「`../../package.json` 在 `dist/` 或 npm 安裝後會指錯」——兩者都回到 package root。
- 「`0.0.0` 不符 MCP schema，握手會失敗」——SDK 只驗證是字串。
- 「握手的 `ai_cli_mcp` 違反『不硬編名稱』」——那是 MCP implementation ID，與 npm 套件名不同用途。
- 「整份 package.json 會被序列化出去」——回傳的是明確四欄投影。
- 「`server` 會被 `models` 的『陣列 key 當 agent 清單』誤收」——`Array.isArray` 對 plain object 為 false。
- 「`verify-catalog-source` 的 everyAvailable 會被新 key 汙染」——它呼叫的是 `buildDoctorStatus()`，不含 `server`／`update`。

**順帶記下的既有問題（非本次造成，未修）：**

- `verify-mcp.mjs` 印「doctor available CLIs」那行把 `update.available`（語意是
  「有新版可更新」）當成「CLI 找得到」，是假陽性。只在 `log()` 裡，不影響 CI 判定。
- 若哪天有 agent id 叫 `server` 或 `update`，會被 `doctor.ts` 的 spread 順序**靜默覆蓋**。
  `AgentId` 目前是封閉 union 所以不成立，但「加後端不該動 `core/`」的人不會知道
  `core/` 已經佔用了三個保留字。

驗證：`npm test` 11 支全綠；`verify-mcp` 21→24 項、`verify-catalog-source` 新增
repository 正規化範圍的 7 項；突變 79→81。

### 新增（.gitignore）

- `.tmp/` 進 `.gitignore`。`src/agents/direct-api.ts` 把 session 寫到
  `workFolder/.tmp/api_sessions/`，所以只要派工時把 workFolder 指到本 repo 就會
  出現——而**那些檔案裡是完整對話內容**，不該有機會被 commit 進來。
  本次稽核期間就真的產生過一次。（Claude）


### 新增（給 AI agent 的開場必讀檔）

- **新增 `CLAUDE.md`。** 這棵樹先前沒有 `CLAUDE.md`、也沒有 `.claude/`，
  於是 2026-09-09 這一整批對外整備（改名 `tkflyc-ai-cli`、npm 發佈
  `@tkflyc/ai-cli-mcp`、授權改 Apache-2.0、POSIX CI 升為閘門）**只留在
  git log 裡**——要人主動去翻才看得到，不是開場就會撞見的東西。

  結果是下一個開在這個目錄的 agent 會以為 repo 還叫 `ai-cli-mcp`、還是 MIT、
  還沒發過 npm，然後重提已經做完或已經否決的事。

  新檔只寫兩類內容：**現況**（名字／版本／授權／CI 閘門範圍）與**紅線**
  （NOTICE 不可移出 `files`、不要寫上游停更、POSIX CI 不准降回實驗、
  發版先打 tag、`process.exit()` 前要排空 stdout、不造假社群訊號）。
  流程規則不重複，指回 `CONTRIBUTING.md`。（Claude，moerasermax 指示）

### 修正（文件數字）

- `CONTRIBUTING.md` 寫 `npm test` 串起「九支」驗證腳本，但同一句括號裡列了十支。
  改為十支。（Claude）

### 修正（事實錯誤：上游並未停更）

- **README（中英）先前寫「上游已停止更新 / no longer being updated」，這是錯的。**
  實測 mkXultra/ai-cli-mcp：npm `2.23.0` 發佈於 **2026-09-06**、GitHub 最後推送
  **2026-09-07**、25 stars / 9 forks / 12 open issues、**npm 週下載約 680 次、
  月下載 1,597 次**。它活得好好的。

  錯誤來源是把「我沒在追蹤它」當成「它沒在動」，然後直接寫進文件而沒有查證。
  這種話最糟的地方在於**驗證成本極低**——任何人點進上游 repo 三十秒就會看到，
  於是它同時毀掉可信度與歸屬聲明的誠意。

  更正後的說法反而更準確：**這不是接手一個沒人管的專案，是架構上刻意分歧的 fork。**
  上游把五個後端寫死，這裡改成 registry；上游沒有 direct-api、熔斷器、
  provenance 模型目錄。要原版的人應該去用 `ai-cli-mcp`，README 現在也這樣寫。
  （Claude，moerasermax 指示）


## [6.1.1] - 2026-09-09

### 修正（stdout 在管道上被截斷）

- **`ai-cli models` 之類的子命令在 pipe 上會吐出殘缺輸出。** `bin/ai-cli.ts`
  對 `exec` / `update` 以外的子命令直接呼叫 `process.exit()`，但 stdout 是 pipe
  時寫入是非同步的——行程會在緩衝區還有資料時就結束。

  原本的註解已經寫明這個危險，只是把適用範圍判斷錯了：理由是「其他子命令印的是
  一次性的 JSON」。**一次性不等於小。** macOS 的 pipe buffer 是 8 KiB，而
  `models` 的 payload 實測 **12,478 bytes**，於是呼叫端拿到的是在第 8192 位元組
  被切斷的 JSON——不報錯、不留痕跡，只有 `JSON.parse` 炸在一個看不出根因的位置。

  改成 `exitAfterFlush()`：用空寫入的 callback 確認前面的資料已交給 OS，再強制
  退出；保留強制退出是因為某些子命令有殘留的計時器/handle 會讓事件迴圈不空
  （那正是當初加 `process.exit()` 的原因）。另加 2 秒保險上限，對端關閉時寧可
  截斷也不要永遠不退出。（Claude，moerasermax 指示）

- `verify-catalog-source.mjs` 補上具名的回歸測試，並在 payload 未超過 8 KiB 時
  **明講「這次沒測到截斷」而不是靜靜通過**——一條在條件不成立時假裝自己有效的
  測試，比沒有測試更糟。（Claude，moerasermax 指示）

### 附註：6.1.0 沒有發到 npm

  tag `v6.1.0` 與其 GitHub Release 存在，但**從未發佈到 npm**：CI 在
  macos + node 20.19 上抓到上述截斷，發佈前就擋下來了。這正是前一版把 POSIX
  從 `continue-on-error` 升為閘門的直接回報——升級的隔一個 commit 它就攔到一個
  Windows 與 Linux 都看不見的真 bug。tag 不重寫（推出去的 tag 不該改），
  npm 的第一個對齊版本是 6.1.1。

## [6.1.0] - 2026-09-09

**這一版的第一個目的是把 npm 上的內容與 git tag 對齊。**

⚠️ **npm 上的 `6.0.0` 不對應 git tag `v6.0.0`。** 它是從超前該 tag **13 個 commit**
的樹發佈出去的——除了發佈整備（npm 套件化、CI、SECURITY.md、上游歸屬、改名）
之外，還含 tag 之後就一直堆在 `[Unreleased]` 的既有功能（`replay_reasoning`、
429/5xx 退避重試、派工建議表進工具回傳、SessionStart hook 進版控、`extra_body`）。
tag `v6.0.0`（`162c635`）裡連 `NOTICE` 都還不存在。

這是發佈當下沒注意到的順序錯誤：先發了套件，才想到樹早已超前 tag。**從 6.1.0 起，
npm 版本一律從打了 tag 的 commit 發佈**，讓「這個 tarball 對應哪個 commit」有唯一答案。
npm 上的 6.0.0 保留不刪（刪掉會讓已經裝到的人壞掉），改以 deprecate 標註它的實際來源。

這件事本身就是本專案那條原則的應用：**說得出自己的出處，比看起來乾淨重要。**
一個對不上 tag 的 tarball，跟一個回 `false` 卻其實沒檢查的 `doctor` 是同一類問題。

以下是本版收錄的全部內容。

### 變更（CI：POSIX 從實驗性升為閘門）

- **`test-posix` 移除 `continue-on-error`，改為與 Windows 同級的閘門，並補上
  node 20.19 / 22 雙版本矩陣。**

  這一版 CI 上線時，POSIX 那個 job 是刻意標成 `continue-on-error` 的——理由寫在
  上一筆：**這套測試從來沒有在 Linux/macOS 上被執行過**，在真的綠之前不該讓它
  擋合併，也不該讓它回報自己沒掙來的成功。

  第一次跑就全綠。ubuntu-latest 與 macos-latest 的 `npm test` 都通過
  （step 層級確認，不是被 `continue-on-error` 蓋掉的 job 層級 success）。
  既然已經是實測綠的，繼續讓它靜默失敗就變成反過來的謊——**壞了卻不擋**。
  所以立刻升級。

  順帶推翻了一個既有假設：`process.platform` 分支與 node-pty 的 POSIX prebuild
  一直被當成「應該可以但沒驗過」，現在是驗過的。`build-posix` 保留為比完整套件
  更早回報的型別/編譯訊號。（Claude，moerasermax 指示）

### 變更（改名：repo 與 npm scope）

- **GitHub repo `ai-cli-mcp-source` → `tkflyc-ai-cli`**，**npm 套件改以
  `@tkflyc/ai-cli-mcp` 發佈**（原規劃的 `@moerasermax/ai-cli-mcp` 未曾發佈，
  因此沒有遷移成本）。

  改名有兩個目的。一是**與上游區隔**：本專案是 mkXultra/ai-cli-mcp 的衍生，
  沿用近似名稱容易被讀成冒名或同一專案（詳見 NOTICE 的實測重疊數據）。
  二是**收攏到 tkflyc 生態鏈**：既有的 `tkflyc-database` / `tkflyc-monitor` /
  `tkflyc-planner` / `tkflyc-search` 已成命名慣例，`@tkflyc` scope 讓日後的
  knowledge-mcp、planner 收在同一個命名空間下。

  **GitHub 會自動轉址舊網址**，既有的 clone、書籤與 `git remote` 不會斷；
  本 repo 的 remote 仍已更新為新網址。

  ⚠️ **binary 名稱（`ai-cli` / `ai-cli-mcp`）與 MCP 註冊名（`ai-cli`）刻意不動。**
  它們是使用者每天打的指令與各機器 `settings.json` 裡的既有設定，跟著 repo 改名
  等於為了門面去破壞所有機器的設定。**本機原始碼目錄路徑同樣不動**——
  它被寫在 MCP 註冊指令裡。（Claude，moerasermax 指示）

### 新增（上游歸屬）

- **新增 `NOTICE`，並在 LICENSE 版權行下方標示衍生關係**。本專案是
  [mkXultra/ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp)（MIT）的 clone 後重寫，
  而上游又衍生自 Peter Steinberger 的 `claude-code-mcp`（MIT）。原本的 LICENSE 只寫
  `Copyright 2026 YC (moerasermax)`，**把前面兩層的版權聲明都拿掉了**。

  MIT 的條件是「上述版權聲明與本授權聲明必須包含在所有副本或**實質部分**中」。
  以上游 v2.23.0 為基準實測：本專案 1,980 行實質原始碼（去空白、去註解、
  長度 ≥20、去重）中有 **299 行（約 15%）**與上游相同，且**集中在 MCP 工具表面**
  —— 工具名稱、description 字串、input schema，以及 CLI/MCP 進入點。
  逐檔最高的是 `bin/ai-cli-mcp.ts` 100%、`core/peek.ts` 75%、`core/process-result.ts` 65%、
  `app/cli.ts` 60%。這已經構成「實質部分」，該補歸屬。

  **為什麼是加分不是扣分**：重疊的 15% 落在別人第一眼看到的介面上，不標歸屬
  會被讀成冒名；標了之後，真正的事實才講得出來——從一個活躍上游分歧出來、重寫 85%、
  把五個寫死的後端換成 registry 架構，並補上 direct-api、熔斷器、provenance 模型目錄、
  自動更新與 liveness。NOTICE 裡直接寫出實測數字，而不是含糊的「based on」。
  （Claude，moerasermax 指示）

- README（en/zh-TW）新增「與上游原專案的關係」段落，`package.json` 的 `files`
  加入 `NOTICE`，確保它隨每個 npm 副本一起散布。（Claude，moerasermax 指示）

### 新增（對外發佈：npm 套件、CI、安全政策）

- **改為可發佈的 npm 套件 `@tkflyc/ai-cli-mcp`**：移除 `package.json` 的
  `"private": true`，補 `license` / `repository` / `bugs` / `keywords` / `files` /
  `publishConfig.access=public`。

  **為什麼要換名字**：`ai-cli-mcp` 這個 npm 名稱**已被他人佔用**（mkXultra，MIT，
  latest 2.23.0，而且也是做 Claude/Codex 的 MCP 橋接）。不是偏好 scoped，是原名拿不到。
  README 因此需要說清楚本專案的差異在哪（registry 架構、背景 job、circuit breaker、
  direct-api），否則會被當成同一個東西。

  **為什麼現在才發**：從原始碼安裝要 clone + build + 手動指到 `dist/server.js`，
  這讓「想試一下」的成本高到不合理。`files` 只收 `dist` 與四份文件——`npm pack --dry-run`
  實測 70 檔 216 kB，沒有夾帶 `node_modules` 或一次性測試輸出。（Claude，moerasermax 指示）

- **新增 `.github/workflows/ci.yml`**：三個 job，刻意分開而不是一個矩陣。

  `test` 只跑 windows-latest（node 20.19 / 22）——ConPTY runner 與 CLI 解析路徑
  只在 Windows 被實際走過，所以**只有這個 job 是閘門**。`build-posix` 在
  ubuntu/macos 上跑 `typecheck` + `build`，擋的是型別與建置回歸，不宣稱執行期正確。
  `test-posix-experimental` 標 `continue-on-error`，因為**這套測試從來沒有在 POSIX 上
  跑過**，先讓它跑出來看看走多遠，在真的綠之前不准它擋合併，也不准它回報自己沒掙來的成功。

  這與 6.0.0「工具要對呼叫端說實話」同源：一個把沒驗證過的平台算成綠的 badge，
  比沒有 badge 更糟。（Claude，moerasermax 指示）

- **新增 `SECURITY.md`**：載明 threat model 而不只是回報信箱——這個工具會**執行本機
  binary**、並**讀取 `providers.json` 裡的明文 API key**。這兩件事決定了它不該被暴露到
  網路邊界或多租戶環境，講清楚比列一個支援版本表重要。（Claude，moerasermax 指示）

- README 加上 CI / npm / License badge，Quick start 改成「npm 一行」與「從原始碼」
  兩條路並列。（Claude，moerasermax 指示）

### 新增（派工建議表的 hook 進版控）

- 新增 `tools/hooks/aicli-model-policy.py`：Claude Code 的 SessionStart hook，
  在每個 session 開頭注入派工建議表與 NVIDIA 那批的實測注意事項。

  **為什麼要進版控**：原本那份 hook 只在作者機器的 `~/.claude/scripts/` 底下，
  push 不出去、其他機器拿不到——而它正是「每個 session 開頭主動告訴模型該派哪顆」
  的那一半。`models` 的 `dispatchGuidance` 隨自動更新過去了，hook 沒有。

  裝好之後它隨 `git pull` 更新，**內容改了不必重裝、也不必再動 `settings.json`**。
  安裝方式寫在檔頭。

  **ai-cli 不會自己去改你的 `settings.json`。** 派工工具靜默改寫使用者的
  Claude Code 設定是壞設計——那是他的環境，他該知道被動了什麼。
  （這與 2026-09-08 移除驗證閘門時的判斷一致：偵測並提醒，不代為安裝。）

- 更新後提醒新增第三則（綁 `020984d`），讓拉到這一版的機器自己看到安裝步驟。
  不裝也行——同一份建議在 `models` 的 `dispatchGuidance` / `knownBadModels` 裡，
  那個不需要安裝；hook 的差別只是「不必等 AI 想到要查」。

### 新增（派工建議表）

- 新增 `models` 回傳的 `dispatchGuidance` 與 `knownBadModels`：依情境該派哪一顆、
  以及哪些已知不能用與為什麼。`src/models/catalog.ts`

  **為什麼放進工具回傳而不是只寫在 README**：呼叫端是 AI，它讀的是工具回傳。
  一份只存在文件裡的建議表等於只有人看得到，而真正在挑模型的是它。
  直接理由是 NVIDIA 免費 API 接上之後，「量大但不難」的工作有了不吃訂閱額度的選項——
  但那要指名才會用到，沒有這張表就仍然會拿訂閱額度去做不需要它的事。

  | 情境 | 用什麼 |
  |---|---|
  | 日常派工 | `gpt-5.6-sol` + `reasoning_effort: high` |
  | 同一個問題卡超過 5 次 | `gpt-6-astra`（最貴，別一開始就用） |
  | 稽核／第二意見 | `claude-ultra` 或 `gemini-3.1-pro-high` |
  | 大量低價值工作 | `nv-openai/gpt-oss-20b`（免費） |
  | 長脈絡 | `nv-nvidia/nemotron-3.5-lightning-30b-a3b`（1M，免費） |
  | 較難的 coding／agentic 但不想動訂閱額度 | `nv-meta/muse-glimmer-30b` |

  每一筆的 `note` 都寫「為什麼」而不只是「用哪個」——沒有理由的建議會在情況變了之後
  被照抄，而讀的人不知道它已經不成立。

  `knownBadModels` 與 catalog 的 `routable: false` 不同：那個講「框架路由不到」，
  這個講「路由得到但實測不能用」（kimi-k3 的 429、nemotron-3-nano 的 410、
  gemma-4 的 91 秒工具迴圈、codex 清單裡三個帳號被擋的 model）。

### 測試

- `verify-alias-config.mjs` 增至 83 項，新增七條斷言。其中兩條是**一致性**檢查而不只是
  存在性：日常派工建議必須與模型政策一致（sol + high，不是一開始就 astra）；
  **建議表不可推薦出現在 `knownBadModels` 裡的模型**——那種矛盾靠人工看很容易漏掉。
- 突變 73 → 76，逐一實測全部 KILLED。

### 新增（reasoning_content 回送）

- 新增 `providers.json` 的 `replay_reasoning`：把上一輪 assistant 的 `reasoning_content`
  回送給要求保留它的模型。`true` = 該 provider 全部 model，陣列 = 只送列出的那幾個。
  `src/agents/direct-api.ts`（`resolveReplayReasoning`、`buildAssistantMessage`）、`src/agents/types.ts`

  **為什麼要**：Kimi-K3 的 model card 寫 “clients must pass back the complete assistant
  message, including `reasoning_content` and `tool_calls`”；DeepSeek V4 帶 `tools` 時
  少送會 **400**。而 direct-api 重建 assistant message 時只保留 `content` 與 `tool_calls`，
  推理內容直接丟掉——那個訊息不只送下一輪，也會寫進 session 檔，所以跨請求續聊同樣遺失。

  **為什麼預設關閉、而且不做內建白名單**：`reasoning_content` 不在 OpenAI 的 assistant
  message schema 裡，而「OpenAI-compatible」不保證未知欄位被忽略（Azure AI Model Inference
  的 `extra-parameters` 預設是 `error`）。至於白名單——這個專案的每一份硬編 model 清單最後
  都過期了，再加一份只是換個地方犯同一個錯。

  兩個實作細節：回送的是**這一輪**的推理而非整次 run 的累積（用後者第二輪會把第一輪再附一次）；
  **每個 assistant turn 都保存**而不只是帶 tool_calls 的那些（最後一輪會進 session，
  續聊時就是歷史 turn）。

**誠實的但書**：實測 Kimi-K3 在**不回送**的情況下也能正確走完三輪工具鏈，
而官方文件沒有寫少送會怎樣。所以這是照契約做，**不是修一個看得見的當機**。
端到端派工驗證做不到——kimi-k3 的 429 額度爭用連 8 次指數退避都打不穿（實測 3/10）。
能證明的是：單元測試確認欄位正確組出且只給設定過的 model，
手動探測確認真實端點收得下（200 OK）。

### 測試

- `verify-extra-body.mjs` 48 → 60 項（設定解析、四種不合法值要丟錯、開啟時串流分段的
  reasoning 要接起來、關閉時即使端點有回也不能送、同 provider 底下沒列到的 model 不送、
  端點沒回時要省略欄位而不是送空字串）。
- 突變 69 → 73，逐一實測全部 KILLED。其中一個原本 SURVIVED——`buildAssistantMessage`
  的預設參數 `= false` **永遠用不到**（呼叫端每次都明確傳值），所以改它不影響任何行為。
  照 2026-09-08 的既有做法處理：把測不到的東西移除（參數改成必填），
  突變改打在真正會執行的呼叫點上。

### 新增（讓機器知道自己有什麼、還缺什麼）

- **`models` 現在列得出這台機器設定了哪些 direct-api provider**（`directApiProviders`）。
  舊的 `direct-api` 陣列只有四個佔位字串（`or-<model>` 之類），**看不出本機實際設了什麼**——
  2026-09-09 有人在另一個專案問「NVIDIA 的模型呢」，而工具根本沒告訴他。
  已設定的 provider 是本機狀態，不在版控也不在靜態清單裡，只有讀 `providers.json` 才知道。
  新欄位給每個 provider 的可用前綴（含 `or` / `ds` 這類內建簡寫）、`base_url`、
  `model_extra_body` 裡點名過的 model，以及一個可以直接複製去派工的 `example`。
  `src/agents/direct-api.ts`（`describeConfiguredProviders`）、`src/models/catalog.ts`

  三條硬性規則：**永不回傳 `api_key`**（這個結構會原樣進工具回傳）、
  **永不丟錯**（`providers.json` 壞掉時回 `note` 說明讀不到，不能讓整個 `models` 陣亡——
  「讀不到」與「沒設定」對呼叫端是兩件事）、**不查網路**（只讀本機檔案；
  列舉 provider 的完整目錄要打 API，那是 `models` 同步路徑不能做的事）。

- **更新完畢後的提醒現在會列出「需要人在那台機器上動手」的事**（`postUpdateActions`）。
  自動更新帶得動 repo 裡的東西，帶不動每台機器自己的狀態：`providers.json` 的 API 金鑰
  不在版控裡，`~/.claude/plugins/` 的副本 `git pull` 也碰不到。這種事只有站在那台機器前的人
  做得到，而他不會知道要做——除非我們說。`src/core/updater.ts`

  **提醒綁 commit，不是固定文字**：key 是引入那件事的 commit，只有當這次更新真的包含
  該 commit 時才附上。所以每台機器只會看到一次，已經更新過的不會再被提醒。
  寫成固定文字的話會變成每次更新都出現的永久噪音，然後被忽略。

  目前有兩則：移除驗證閘門的 plugin（`4a06d74`）、要用 NVIDIA 就自己加 provider（`b8f7865`）。

### 測試

- `verify-extra-body.mjs` 42 → 48 項（新增 provider 列舉：不外流金鑰、內建簡寫要列出、
  設定檔壞掉回 note 不丟錯）。
- `verify-update.mjs` 45 → 51 項（新增提醒綁 commit：不相關的 commit 不給提醒、
  短碼只比對前綴不是任意位置）。
- 突變 64 → 69，逐一實測全部 KILLED。其中兩個第一版是被**編譯器**殺掉的而不是斷言——
  那證明不了測試有效，改成型別合法的形式（`baseUrl` 誤填成 `api_key`、`prefixes` 只留
  provider key）之後才是真的由斷言抓到。

### 新增（direct-api 的重試）

- 新增 429／5xx 的退避重試。共享的免費端點在尖峰會限流與卸載——NVIDIA 自己的故障排除文件寫明
  hosted Nemotron endpoint 在高需求時會回 **429 或 503**，並建議「短暫等待後重試、降低並發」。
  原本 direct-api 收到任何非 200 就直接失敗，整個 job 結束。
  現在 429 與 5xx 走指數退避加抖動重試，其餘 4xx 不重試——服務端說格式錯的請求，再送一次還是錯。
  `src/agents/direct-api.ts`（`fetchWithRetry`）
- 新增 `providers.json` 的 `retry` 設定：`{ max_retries, initial_delay_ms }`，預設 2 次／1 秒，
  `max_retries: 0` 明確關閉。`max_retries` 的存在與否用 `hasOwnProperty` 判斷——`0` 是 falsy，
  用值的真假會把「明確關閉」當成「沒設」而退回預設。`src/agents/direct-api.ts`
- 新增 `retry` 事件（stdout）。靜默重試會讓「這個 job 很慢」跟「這個 job 卡住了」長得一模一樣，
  而呼叫端是 AI，它只看得到工具回傳。事件帶 `attempt` / `status` / `delay_ms` / `from_retry_after`。
- 服務端有送 `Retry-After` 就聽它的（上限 60 秒）。NVIDIA 實測不送這個 header，
  但 OpenRouter 那類會送，聽服務端比自己猜準。
- 退避途中被 kill 會立刻醒來，不會等睡完才反應。

**重試只包住「建立請求」那一段。** 一旦回 200 開始讀串流，內容已經送到呼叫端，
中途失敗不重試——重來會讓同一段回答出現兩次。這是刻意的範圍限制。

**實測（`nvidia/nemotron-3-super-120b-a12b`，每組 10 輪完整兩輪工具迴圈）**

| 條件 | 成功率 |
|---|---|
| 連發、不重試（約 66 RPM） | 4/10 |
| 15 RPM、不重試 | 9/10 |
| 10 RPM、不重試 | 8/10 |
| **15 RPM + 退避重試** | **10/10** |

**放慢速率沒有讓它到 100%，重試有。**
同樣條件下 `openai/gpt-oss-20b`、`nvidia/nemotron-3.5-lightning-30b-a3b`、
`meta/muse-glimmer-30b` 也都是 10/10。
`moonshotai/kimi-k3` 是例外：10 輪觸發 24 次重試只救回 3 次、最終 3/10，
它的 429 是額度爭用不是尖峰抖動，重試打不穿。

### 測試（重試）

- `verify-extra-body.mjs` 增至 42 項，新增 429/5xx 重試、400/401 不重試、
  用完次數要放棄、`max_retries: 0` 真的關閉、重試事件不可靜默等斷言。
- 新增 5 個突變（59 → 64），逐一實測全部 KILLED。其中「無限重試」那個突變原本會讓
  harness **卡死而不是回報 FAIL**，改成「超出設定次數」這種會終止但仍然錯的形式；
  另有一個突變的比對片段因手寫 `\n` 對不上 CRLF 原始碼而回報 ERROR——
  那等於什麼都沒測，已照 CONTRIBUTING 的既有教訓改成從原始碼取出實際片段。

### 移除

- **程式碼修改驗證閘門（兩層一起拔掉）。** 6.0.0 加的東西，上線第一天就被實測數字否決。
  移除 `plugin/`、`.claude-plugin/`、`src/core/verification.ts`、`verification-log.ts`、
  `install-marker.ts`、`plugin-status.ts`、`tools/sync-plugin-core.mjs`、
  `verify-verification.mjs`、`verify-gate-hook.mjs`；連帶拿掉 `run`／`wait`／`get_result`
  回傳的 `verification` 欄位、`doctor.plugin`、`run.pluginNotice`、`build` 的第二步。
  `npm test` 12 支 → 10 支，突變 105 → 59。（claude）

  **為什麼拔掉**——用它自己的記錄檔（`verification-gate.jsonl`，39 筆）判的：

  | 指標 | 數字 |
  |---|---|
  | 第 2 層（會擋人的 plugin）當天擋人次數 | 19 |
  | 其中最後真的確認到「驗證通過」 | **1** |
  | 判定結果是 `not_observed`（＝看不出來）的比例 | **88%** |

  它 88% 的時候在說「我看不出來有沒有驗證」，然後就擋。更糟的是判定本身可以被繞過：
  `cd . && echo "npm test"` 會被判成**驗證通過**——因為防造假的規則只看指令開頭，
  認驗證的規則卻掃整串，兩邊不對稱。誤擋只是煩，**假通過是危險**。
  另外查到兩個假通過：工具輸出是陣列時文字比對整個失效（實測佔 12% 的工具回傳），
  以及 `ZERO_FAIL` 對整份輸出比對，`FAIL\n0 errors` 會被判成通過。

  > ### 其他機器要做什麼
  >
  > **自動更新帶得動程式碼，帶不動安裝。** `git pull` 只更新這個 repo；
  > plugin 是 `/plugin install` 當時**複製**到 `~/.claude/plugins/` 的副本，
  > 拉到新版之後它仍然會繼續跑舊副本、繼續擋你。每台機器要各自做一次：
  >
  > ```
  > # 1. 在 Claude Code 裡輸入（兩行都要）
  > /plugin uninstall ai-cli-verification-gate@ai-cli-mcp
  > /plugin marketplace remove ai-cli-mcp
  >
  > # 2. 更新 ai-cli 本體（沒裝自動更新的機器才需要手動跑）
  > git pull --ff-only && npm install
  >
  > # 3. 確認乾淨，並取得剩下該刪什麼的指令
  > node tools/check-gate-removed.mjs
  > ```
  >
  > 第 3 步會逐項檢查六個地方（`installed_plugins.json`、`known_marketplaces.json`、
  > `settings.json` 的兩個欄位、`marketplaces/` 與 `cache/` 兩個磁碟副本）加上
  > 這份安裝本身與 install marker，沒過的會把該跑的指令原樣印出來。全乾淨回 exit 0。
  > **它只檢查，不會動你的設定檔。**
  >
  > 兩個實測到的坑：`/plugin marketplace remove` 只清註冊，**cache 的副本要自己刪**；
  > 而 `installed_plugins.json` 才是「這個 plugin 到底會不會載入」的權威來源，
  > `settings.json` 的 `enabledPlugins` 只反映使用者層，用 project scope 裝過的機器在那裡看不到。
  >
  > `~/.local/state/ai-cli/verification-gate.jsonl` 是過去累積的紀錄，
  > 那是**資料不是程式**，checker 不會要求你刪。要留著做事後分析就別動它。

- `tools/check-gate-removed.mjs`：檢查驗證閘門是否已從這台機器完全移除，
  只回報不改設定，沒過會印出該跑的指令。（claude）


### 新增

- **`providers.json` 支援 `extra_body` 與 `model_extra_body`**（`src/agents/direct-api.ts`、
  `src/agents/types.ts`）。direct-api 原本送出去的 request body 寫死只有
  `model`／`messages`／`stream`／`stream_options`／`tools`，於是託管模型的預設值只能照單全收。
  實測 `nvidia/nemotron-3.5-lightning-30b-a3b` 走預設要 **28.0 秒／318 token**，
  傳 `reasoning_effort: "none"` 只要 **6.1 秒／84 token**，兩者成功率都是 5/5。
  provider 層是預設，model 層覆蓋它。（claude）
- `model`／`messages`／`stream`／`stream_options`／`tools` 是保留欄位，
  兩層設定都不准覆蓋，**載入時就丟錯並點名是哪個 provider 的哪個欄位**——不是靜默丟棄。
  覆蓋 `stream` 會讓 SSE 解析器收到一整包 JSON，覆蓋 `tools` 會讓模型收到框架執行不了的工具。
  request body 的展開順序（框架欄位後寫）是第二層防護，程式碼裡有註明。（claude）
- `verify-extra-body.mjs`：26 項，已接進 `npm test`。（claude）

## [6.0.0] - 2026-09-08

**判 MAJOR 的理由是對外行為不相容，不是這一版做了多少東西。** 依 CONTRIBUTING §4，
下列每一條各自都足以構成 MAJOR：

| 變更 | 舊行為 | 新行為 | 誰會壞 |
|---|---|---|---|
| `wait` 逾時 | 丟錯（MCP InternalError） | 回目前結果陣列，running 的帶 `timedOut: true` | 靠 `catch` 判斷逾時的呼叫端 |
| `codex-ultra` | → `gpt-5.6-sol`、effort `xhigh` | → `gpt-6-astra`、effort `max` | codex-cli < 0.153 的機器會被 API 拒絕 |
| `doctor.checks.loginState` / `termsAcceptance` | `boolean` | `null`（誠實表示「沒驗這個」） | 把它當布林讀的呼叫端 |
| CLI job 無結束紀錄時 | `failed` | `lost`（不知道 ≠ 失敗） | 只判斷 `failed` 的呼叫端會漏掉 |
| `gemini-*` 模型名 | 由 claude 的 catch-all 接走 | 路由到 agy，並實際傳 `--model` | 依賴舊路由行為的呼叫端 |

前兩條是 2026-09-05 那批，後三條來自 `805c619`（2026-08-22）——**是發版前逐 commit
對照才補上的**，我原本只記得自己近期做的那兩條。這正是 CONTRIBUTING §4 要求
「照 git log 逐 commit 對照，不能只看自己記得的部分」的理由（4.0.0 也踩過同一個坑）。

這一版的主線是**讓工具對呼叫端說實話**：`wait` 逾時回 liveness 而不是錯誤、模型目錄
說得出每一筆的出處與能不能派工、`run` 的回傳說得出「這次改了程式碼但沒驗證」。
另外補上原始碼安裝的自動更新，以及一個會擋住自己的程式碼修改驗證閘門——
它上線當天連續四次擋錯人，那四次的修復也在下面。

### 新增（程式碼修改驗證閘門）

> **這一批標記為實驗性。** 判定是啟發式的，上線第一天就誤擋七次（單字母副檔名、`->`、
> `2>/dev/null`、引號裡的重導向、`rg "npm test"` 誤判通過、`FAIL=0`），全部修掉了，
> 但這代表判定規則還在收斂。三次誤擋的修法都**刻意選擇收緊**（寧可漏擋不要誤擋），
> 所以實際覆蓋率低於設計覆蓋率——`cmd>file` 不留空白、單字母副檔名沒路徑都會漏。
> `run` / `wait` / `get_result` 多回一個 `verification` 欄位是加法、不影響既有呼叫端；
> 會擋人的那一層是**要自己去 `/plugin install` 才會生效**的，預設不啟用。

- 新增 `src/core/verification.ts`：程式碼修改的驗證狀態五態判定（`not_applicable` / `not_observed` / `passed` / `failed` / `waived`，running 另回 `pending`）。**刻意不是布林值**——`verified: false` 沒辦法區分「沒改程式碼所以不用驗」「改了但看不到有沒有驗」「驗了而且失敗」這三件對呼叫端意義完全不同的事。判定依**事件順序**：驗證必須發生在最後一次修改之後，否則「先跑測試再改程式碼」會假通過。（Claude，moerasermax 指示）
- `run` / `wait` / `get_result` 的回傳新增 `verification` 欄位，**compact 模式也不拿掉**。呼叫端是 AI，它只看得到工具回傳；回傳沒說「這次改了程式碼但沒驗證」，它就會把子 agent 的「我做完了」當成做完了。這與 2026-09-05「wait 逾時不丟錯、改回 liveness」同源：工具要對 AI 說實話。antigravity 沒有結構化工具紀錄，一律回 `not_observed`（看不到不等於沒改），不得回 `not_applicable`。（Claude，moerasermax 指示）
- 新增隨附的 Claude Code plugin `ai-cli-verification-gate`（`plugin/`，附 `.claude-plugin/marketplace.json`）：Stop hook 在「本回合改了程式碼卻沒跑驗證」時擋一次，要求補驗證或寫明豁免理由。硬性規則為一律 exit 0、最多擋一次（靠官方 `stop_hook_active` 防無限迴圈，第二次一律放行並誠實記下原狀態、標 `gate: allow-after-block`）、無法可靠判定時不擋。與第 1 層共用同一個判定模組，不是另一套規則。（Claude，moerasermax 指示）
- 新增 `verify-verification.mjs`（100 條）與 `verify-gate-hook.mjs`（47 條）並納入 `npm test`；新增 46 個突變（39 個判定、記錄、plugin 偵測與稽核修復，7 個 hook），涵蓋順序陷阱、compact 拿掉 verification、running 假稱結果、agy 誤判、豁免蓋過失敗、exit_code 被輸出文字蓋過。hook 的狀態目錄沿用 `AI_CLI_STATE_DIR` 隔離，測試不碰使用者目錄。（Claude，moerasermax 指示）
- 動機是實測而非臆測：掃 2026-09-06 13:00 起 44 小時、178 條 Claude Code transcript、26,003 筆 usage 記錄後，有改到程式碼的工作段裡 **31.7% 完全沒跑任何 test/build**，且該比例隨上下文長度上升（峰值 0-200k 為 5%、600-800k 為 59%）；有驗證的工作段返工率 59.2%、平均 4.67 圈。同一份資料顯示首次驗證通過率在各上下文區間之間沒有趨勢（89/77/86/78/86%），亦即長上下文並未讓品質變差，只是同一件工作在 800k+ 要花 11.64M 額度、在 200k 以下只要 1.43M。（Claude，moerasermax 指示）
- 判定加上專案範圍：只有工作目錄底下的修改才算數（ai-cli 傳 `workFolder`、plugin 傳 hook 事件的 `cwd`）。這是拿真實 transcript 實測時抓到的誤報——寫在暫存目錄的一次性分析腳本被當成專案程式碼而要求驗證，但那種腳本本來就沒有測試可跑。相對路徑一律算在專案內（它本來就相對於工作目錄解析）。（Claude，moerasermax 指示）
- 新增 `src/core/verification-log.ts`：第 1 層的判定結果落地到 `AI_CLI_STATE_DIR/verification-gate.jsonl`，**與 plugin 的 Stop hook 寫同一份檔案**，用 `source`（`ai-cli` / `hook`）區分。兩層合起來才是一台機器完整的品質基線，分開存會變成兩份誰也代表不了整體的數字。同一個 pid 只記一次（`wait` 會反覆呼叫 `getProcessResult`）。這一層只記錄、不彙總、不外送——跨機器基線需要明確的同步端與隱私政策，在那之前資料留在本機。（Claude，moerasermax 指示）
- 新增已安裝 plugin 的**過時偵測**：`doctor.plugin` 多一個 `upToDate`，直接比對已安裝的判定核心與這份 repo 的內容（版本號靠不住——改邏輯不一定會 bump version）。**plugin 安裝之後不會跟著 repo 更新**：Claude Code 把 source 目錄複製到 `~/.claude/plugins/cache/`，之後 `git pull` 再怎麼前進，cache 裡那份都不會動。2026-09-08 實測踩到：閘門連修兩次誤判、都 push 了，本機仍用舊判定擋人，而且完全沒有跡象。過時時提示重裝指令；讀不到 installPath 回 `null` 而非 `false`——比對不了不是過時，不該因此催人重裝。（Claude，moerasermax 指示）
- 新增 `src/core/plugin-status.ts` 與 `doctor.plugin`／`run.pluginNotice`：ai-cli 自己偵測「plugin 檔案在、但這台機器的 Claude Code 沒啟用」並提醒，**每 3 天最多一次**（`AI_CLI_PLUGIN_NOTICE_INTERVAL_SEC` 可覆寫，`AI_CLI_CLAUDE_SETTINGS_PATH` 供測試隔離）。自動更新只散布程式碼、不散布啟用狀態——plugin 的檔案會跟著 pull 到每台機器，但要不要載入記在各機器自己的 `settings.json`，而 ai-cli 不去改那個檔。只提醒一次不夠（新機器第一次跳出來時多半在忙，錯過就永遠看不到），每次 run 都喊又太吵，所以取 3 天。真的啟用後清旗標，日後若停用會重新開始提醒；讀不到或無法解析 `settings.json` 時只填 `reason`、不提醒——那可能根本不是 Claude Code 環境。（Claude，moerasermax 指示）
- **第四輪稽核（@codex-gpt-5.6-sol high 讀實作原始碼）找到 7 個成立的問題，全部修復**，其中兩個會讓閘門實際失效：
  - **plugin 從 marketplace 安裝後永久靜默失效**：hook 原本 import `../../dist/core/verification.js`，但 `dist/` 不進版控（實測 `git ls-files dist` 為 0），正式安裝的機器上必然找不到，而「找不到就放行」的設計讓它不留任何痕跡地失效。改為 plugin 自帶 `plugin/hooks/verification-core.mjs`，由 `npm run build` 經 `tools/sync-plugin-core.mjs` 從單一來源同步並進版控，測試斷言兩者一致，改了 src 忘了 build 會被 `npm test` 擋下。
  - **`0 failed` 被判成失敗**：`49 passed, 0 failed` 是最常見的成功輸出，舊的失敗比對認裸的 `failed`，實測會誤判。改成只認「非零個失敗」與明確失敗標記，並加 `all tests passed` 這類零失敗說法的白名單。
  - **同一指令同時改檔與驗證時，那次修改憑空消失**（`sed -i src/a.ts && npm test`）：舊版先認驗證就回傳，後續若再有一次驗證會整體判成 `passed`。改為改檔優先判定——無法確知先後就保守當成未驗證。
  - **`echo "npm test"` 被當成跑過驗證**：最廉價的偽造方式，現在 echo/printf/cat 開頭一律不算驗證。
  - **路徑 `..` 未解析**：`../outside/evil.ts` 與 `C:\proj\..\outside\evil.ts` 都會被當成專案內。`canonical` 改為真的解析 `.`／`..`，相對路徑接到 projectRoot 上再判斷，且只在 win32 折疊大小寫（POSIX 檔案系統大小寫敏感）。
  - **shell 改檔不受 projectRoot 限制**：改專案外的檔案也會要求本專案跑測試。現在從指令抽出路徑 token 逐一判斷。
  - **第七態「verification 欄位缺席」**：`verificationFromAgentOutput` 在「有記錄能力但這次沒有 tools」時回 `null`，與「一律回報」的契約矛盾。改為一律回報 `not_applicable`。
  - 另修 `verification-log` 的去重標記早於實際寫入（首次寫失敗就永不重試）、hook 在第二次放行時謊稱 `waived`（waived 依定義需要明確理由，hook 無法可靠判斷，改為誠實記錄原狀態並標 `gate: allow-after-block`）、`process.exit` 可能截斷 stdout。**並採納其設計意見：驗證失敗也擋一次**——原本只擋「沒驗證」，但模型看得到測試失敗仍可能回一句「改好了」就結束，那正是完成閘門要防的事。（Claude，moerasermax 指示）
- **端到端實測抓到 codex 改檔完全看不到**：codex 用 `file_change` item type 記錄改檔，而 `agents/codex.ts` 的 parser 只收 `mcp_tool_call` 與 `command_execution`，因此 codex 子 agent 改了程式碼也永遠判 `not_applicable`——第 1 層對 codex 等於失效。parser 補收 `file_change` 並把多檔展開成每檔一筆。真實派工複驗：改檔不驗證判 `not_observed`、改檔並跑 `npm test` 判 `passed`。（Claude，moerasermax 指示）
- 這批由 Claude 實作、@codex-gpt-5.6-sol（high）分三輪獨立稽核並修正三個實錯：兩張統計表口徑不一致（效率差距 8.3 倍實為 2.7 倍）、首次通過率母體混入未改程式碼的工作段（91.4% 實為 81.7%）、`205:1965` 是不同單位不能當覆蓋率。設計上採納其三項意見：五態而非布林、驗證須在最後一次修改之後、以 companion plugin 散布而非改寫使用者的 `~/.claude/settings.json`。（Claude，moerasermax 指示）

### 修正（發版前稽核抓到的第三類誤判：「說到」被當成「做到」）
- **修正假通過**：改完程式碼之後只要指令**字面上**出現 `npm test`，判定就回報 `passed`——`rg "npm test" README.md`、`grep -rn "npm test" .`、`git log --grep="npm test"` 全都算數。**閘門謊報通過比誤擋嚴重得多，因為呼叫端會信它。** 搜尋類指令（rg/grep/ag/ack/findstr/Select-String、`git log --grep`）一律不算跑過驗證；但 `pwsh.exe -Command "npm test"` 仍算——那裡的引號包的是真的要執行的指令，是 codex 在 Windows 的形狀。（Claude，moerasermax 指示）
- **修正引號裡的重導向被當成寫檔**：`echo "example > src/a.ts"`、`echo "用 tee src/x.ts 可以同時看到"` 這種說明文字會被判成改了程式碼。判斷寫檔目標前先剝掉引號內容；`echo "x" > src/gen.ts` 的重導向在引號外，仍然算數。（Claude，moerasermax 指示）
- **修正輸出含 `FAIL=0` 被判成失敗**：大寫 `FAIL` 一律中，而零失敗白名單只認得 `0 failed` 這種語序，接不住 `FAIL=0` / `FAIL: 0` 這類計數器寫法。這個誤判是閘門在我報告它有問題的那一則回覆裡當場示範的。（Claude，moerasermax 指示）
- **修正測試讀 stderr/stdout 時逐 chunk 解碼**：`stderr += buffer` 會對每個 chunk 各自 `toString()`，一個中文字（3 bytes）跨 chunk 邊界時兩邊都解成替換字元，要比對的中文訊息就永遠對不上。這是 `verify-update.mjs` 那支 flaky 的**第二個**來源（第一個是等待條件漏了一半）。`verify-update` / `verify-gate-hook` / `verify-exec-contract` / `verify-alias-config` 都補上 `setEncoding('utf8')`——`verify-liveness` 與 `updater.ts` 本來就有。（Claude，moerasermax 指示）
- **修正 `upToDate` 沒考慮 install marker**：hook 現在會優先讀 marker 指到的安裝，那份就是最新的，這時候 cache 舊不舊都不影響實際行為，催人重裝是騷擾。marker 指向本安裝時直接回 `true`；指向別的安裝時仍比對 cache。（Claude，moerasermax 指示）
- **修正三個突變因為上面的修復而對不上原始碼**：`tools/mutations.json` 的 `from` 片段一旦與原始碼不符，harness 回報 `ERROR`（片段不存在）而不是 `SURVIVED`——那個突變等於沒在測任何東西，但總表看起來仍然沒有 SURVIVED。改為從當前原始碼取出片段、再用 `replace` 推導突變後的樣子，手寫跳脫在 JSON / JS / shell 三層之間必錯。另補三個突變守住這次的修復（搜尋指令算成驗證、不剝引號、`upToDate` 不看 marker），驗證閘門的突變數 43 → 46。（Claude，moerasermax 指示）
- 這五條由 @gpt-6-astra（high，使用者特許）在發版前稽核抓出，逐條實測確認成立後才修。它同時指出版號判定漏了三個破壞性變更、CHANGELOG 漏記六個 commit、以及「第二次記 waived」那句與實作自相矛盾——都已補正。（Claude，moerasermax 指示）

### 修正（驗證閘門上線後的三次誤擋與 plugin 送達問題）
- 修正 `CODE_EXT` 收單字母副檔名 `c|h|m|r` 造成的誤判：Python 的 `re.M`、`re.S` 這種 regex flag，以及任何 `物件.c` 形式的屬性存取，都會被當成程式碼檔案路徑。改為單字母副檔名必須有路徑分隔符才算——`src/main.c` 仍算，`re.M` 不算。（Claude，moerasermax 指示）
- 修正重導向偵測沒要求前綴：輸出訊息裡的 `->`、比較用的 `=>`、regex 字面值裡的 `>` 都會被當成寫檔，一句 `echo "字數: 4591 -> readTime 應為 10"` 就讓整個回合被判成改了程式碼。改為 `>` 必須前接行首、空白、`;&|)` 或 fd 數字；代價是 `cmd>file` 這種不留空白的寫法會漏掉——漏擋比誤擋便宜。（Claude，moerasermax 指示）
- 修正「有寫檔動作」與「有程式碼路徑」被分開判定：那兩件事可能毫無關係——`grep -rn "a" src/core/updater.ts 2>/dev/null` 的寫入目標是 `/dev/null`，跟那個 `.ts` 無關，卻因為兩個條件各自成立而被判成改了它。改為只看**實際寫入的目標**（重導向取 `>` 後面那個 token，`tee`／`mv`／`cp` 取目的地，`dd of=`／`install -D` 取參數，`sed -i`／`patch` 因目標位置不固定才退回掃整串）。順帶修正 `cp src/a.ts /tmp/backup.txt`——來源是程式碼，但寫入目標不是。舊的 `SHELL_WRITE` 與 `pathTokens` 一併移除。（Claude，moerasermax 指示）
- 修正 plugin 安裝偵測只讀 `settings.json`：本機實查有 4 個 project scope 的 plugin 是 `enabledPlugins` 完全看不到的，於是裝過的機器會被判成沒裝而每 3 天被催一次。改為 `installed_plugins.json` / `known_marketplaces.json` / `settings.json` 三個來源任一說有就算有，三個全部讀不到才算判斷不了；狀態多回一個 `scopes`。（Claude，moerasermax 指示）

### 新增（plugin 自動跟上 ai-cli）
- 新增 `src/core/install-marker.ts`：MCP server 啟動時把自己的 repo 根寫進 `AI_CLI_STATE_DIR/install.json`，hook 優先讀那份安裝的判定核心、讀不到才用 plugin 自帶的。**Claude Code 安裝 plugin 是把 source 目錄複製到 cache，之後 `git pull` 不會動它**——沒有這條的話，每修一次判定就要重裝一次 plugin，而重裝完又會被下一次修改超車（2026-09-08 實測連續發生四次）。自足是下限、跟上是常態，兩者要一起成立。marker 只放路徑且兩端都驗證：寫的時候確認真的看得到判定核心，讀的時候確認那個路徑下真的有——「指到不存在的地方」跟「沒有 marker」下場相同。（Claude，moerasermax 指示）

### 測試（驗證閘門）
- 修掉四條假綠燈：`async` 函式傳進同步的 `ok()` 時，`fn()` 只回傳 Promise，try/catch 抓不到裡面的斷言錯誤，那四條測試永遠通過（其中一條還是最重要的 plugin 判定核心一致性）。`ok()` 現在明確擋掉 Promise，動態載入一律提到檔案頂層。突變 harness 補上判定核心的同步步驟並在收尾重建產物，`.gitattributes` 釘住產生檔的換行，否則「worktree 應乾淨」每輪誤報。（Claude，moerasermax 指示）
- 移除兩個本質上測不到的突變並在程式碼註明那兩層是冗餘防護：修完「只看寫入目標」之後，重導向的前綴檢查與 `/dev/null` 白名單都殺不掉任何斷言——主要保護擋在後面。留著測不到的突變只會每輪紅一次，但要寫明它們是第二層，免得後人在錯的地方修東西。（Claude，moerasermax 指示）

### 其他（發版前逐 commit 對照補記）
- `exec` 前景執行契約：呼叫端自己擁有程序、自己收 stdout、自己判斷終態，`started` frame 回報實際生效的模式。fail-closed 為預設——agent 沒有 `buildStrictCommand` 就拒絕啟動，不退回帶著 `--dangerously-*` 全開權限的 `buildCommand`。（`805c619`、`0df5c04`）
- `doctor.checks.loginState` 與 `termsAcceptance` 由 `boolean` 改成 `null`：doctor 只驗二進位路徑，從來沒有驗登入狀態，回 `false` 會讓人以為「驗過了、沒登入」。`null` 誠實表示「這一項沒有驗」。**這是破壞性變更**，見上方相容性表。（`805c619`）
- CLI 的 job 在沒收到結束回報時由 `failed` 改成 `lost`：程序不見了而且沒有結束紀錄，結果是**真的不知道**，那跟失敗不是同一件事。**這是破壞性變更**。（`805c619`）
- `gemini-*` 模型名改由 antigravity 認領並實際傳 `--model`：先前會被 claude 的 catch-all 靜默接走。**這是破壞性變更**。（`805c619`）
- 修正 `marketplace.json` 缺 `id`、`plugins[].version` 導致 `/plugin install` **完全沒有輸出、沒有安裝、也沒有錯誤訊息**；補齊必要欄位並加測試守住。（`7c64ae5`）
- 英文 README 改為主入口、中文保留為完整參考；新增 Apache-2.0 授權；`.planner-id` 進版控（跨 checkout 的專案身分標記）；`package-lock.json` 版號補同步，避免安裝後留下髒樹。（`df3386e`、`6372cb7`、`da7010f`、`6912c90`、`e67657b`）

### 新增（ai-cli 自動更新）
- 原始碼安裝新增背景更新器：MCP 連線後延遲檢查 origin，獨立 CLI 子程序以 fast-forward 套用、依套件變動安裝或建置、doctor 煙霧測試；支援 on／check／off、檢查節流、髒樹與分支守門、pid 殘留鎖、失敗回滾和 node-pty 鎖檔說明。（@codex-gpt-6-astra，moerasermax 指示）
- 新增 `ai-cli update [--check] [--json]`、原子寫入的 update.json 與 update.lock、含 SHA／commit 標題／CHANGELOG 網址的持續重啟提示；doctor.update、MCP run.updateNotice、models.updateNotice 及 stderr／MCP warning 通知讓使用者可見，新版啟動才清提示。（@codex-gpt-6-astra，moerasermax 指示）
- 新增暫存 bare origin 與雙 clone 更新驗證、真實 MCP 背景套用與重啟測試，以及回滾／髒樹／節流／非祖先／notice 五個突變；mutation harness 支援按 verify script 篩選。（@codex-gpt-6-astra，moerasermax 指示）

### 變更（測試隔離與部署政策）
- `npm test` 納入 verify-update；既有 server／CLI 驗證明確關閉自動更新，設定、狀態、provider 與目錄快取改用暫存目錄（新增 AI_CLI_CONFIG_DIR），不再改寫真實 config.json，git 網路協定在測試中停用。（@codex-gpt-6-astra，moerasermax 指示）
- README 與 CONTRIBUTING 記載背景套用、下次啟動生效及 public master push 等同全機部署，要求 push 前 npm test 全綠；package.json 新增 CHANGELOG homepage。（@codex-gpt-6-astra，moerasermax 指示）
- 這批自動更新由 @codex-gpt-6-astra（codex-ultra，max）實作、@gemini-3.1-pro 獨立審查（未發現確信問題；
  註記提示清除後每次 CLI 啟動仍會印「已是最新版」——已改成只在真的清掉提示那一次印）；Claude 逐項驗證：
  build 零錯誤、`npm test` 九支全綠（update 45 條）、5 個新突變全部由指定斷言 KILLED。（Claude，moerasermax 指示）

### 修正（agy 模型查詢常態逾時）
- 修正把 `agy models` 誤當本機讀設定的假設：agy 1.1.26 會先做網路 eligibility check，八次暖機實測 1739–3972 ms，舊的 5 秒同步查詢加 60 秒記憶體快取使重連與到期後的 MCP 請求卡住。改成 `spawn` 非同步、有計時與逾時殺子程序樹；同步目錄只讀快取，`tools/list`／`set_config` 不等網路，明確 `models` 才等待；失敗保留成功值並附診斷。（@codex-gpt-6-astra，moerasermax 指示）
- 這批改動由 @codex-gpt-6-astra（codex-ultra，max）實作、@gemini-3.1-pro 獨立審查（未發現確信問題；註記多 process
  同時寫快取時後寫者會蓋掉前者對其他 agent 的新值，目前只有 agy 有快取，先接受）；Claude 逐項驗證：build 零錯誤、
  `npm test` 八支全綠（catalog-source 74、mcp 12、liveness 97）、8 個新突變全部由指定斷言 KILLED。
  根因蒐證：把 proxy 指到不存在的位址時 `agy models` 238 ms 內失敗並印出 loadCodeAssist 的連線錯誤，
  證明它每次都先打網路；`tools/list` 的描述字串每次請求重算，等於每次重連都同步打一次。（Claude，moerasermax 指示）

### 變更（模型目錄出處）
- `AgentDefinition.discoverModels` 改回 Promise，接受模型陣列／null 或 `{ models, note }`；新增 `ModelListSource` 的 `vendor-cli-cached`，與此 process 問到的 `vendor-cli`、靜態 `builtin-fallback` 分開；`catalogV2.agents[]` 新增 `verifiedAt`，既有 payload 與同步 `getModelsPayload()` 簽章保留。（@codex-gpt-6-astra，moerasermax 指示）

### 新增（模型查詢快取與驗證）
- 新增 `CONFIG_DIR/catalog-cache.json`（每 agent 的 models／verifiedAt／cliPath、tmp + rename、同路徑且不超過 30 天才採用），`refreshCatalogV2({ force? })` 的單飛與 10 分鐘新鮮度、`clearCatalogCache({ disk: true })`，以及 `AI_CLI_CATALOG_CACHE_PATH`／`AI_CLI_DISCOVER_TIMEOUT_MS`（預設 15000 ms）覆寫。（@codex-gpt-6-astra，moerasermax 指示）
- 擴充既有 catalog-source 與三入口 MCP 測試；新增慢速／eligibility 錯誤 agy stub、alias 測試與突變 harness 的暫存快取隔離，以及同步阻塞、失敗蓋掉快取、錯報 source、逾時不 kill／不回 null、MCP／CLI 等待規則的突變，維持八支 `npm test` 腳本且不連真實 vendor。（@codex-gpt-6-astra，moerasermax 指示）

### 新增（程序存活資訊）
- MCP 與 CLI 的 running 結果新增統一 `liveness`：存活狀態、啟動與最後輸出秒數、stdout/stderr bytes、事件摘要、事件數與英文等待提示；`list_processes` / `ps` 同時提供時間摘要。Codex 推理期間可能零輸出，等待端需要區分沉默與程序消失，避免把 wait 逾時錯誤當成失敗而遺棄 pid。（@codex-gpt-6-astra，moerasermax 指示）
- `verify-liveness.mjs` 與慢速 Codex stub 納入 `npm test`，覆蓋兩條路徑、跨 CLI 行程、消失程序的 false/lost 對照與突變測試，確保「逾時不是失敗」及存活提示真的受到斷言保護。（@codex-gpt-6-astra，moerasermax 指示）
- 這批 liveness 改動由 @codex-gpt-6-astra（codex-ultra，max）實作、@gemini-3.1-pro 獨立審查（未發現確信問題）；
  Claude 逐項驗證：build 零錯誤、`npm test` 全綠（liveness 97 條）、6 個新突變加上既有第 16 案共 7 個全部 KILLED。
  起因是實際踩到：透過 `wait` 等 codex-ultra 實作時，每 100 秒就收到一次「Timed out」錯誤，而 codex 其實還在跑。
  實測 codex 慢的主因是模型端推理（trivial 回答 5–7 秒，高 effort 可達數分鐘），載入使用者 codex 設定的
  4 個 MCP servers 只多 1–2 秒。（Claude，moerasermax 指示）
- 順手修正既有突變第 16 案「getModelsPayload 退回每個 alias 各讀一次」的替換片段：payload 那段在同一批
  改動裡改寫過（見下方 `acceptsConfiguredEffort`），舊片段已對不上而讓完整突變測試 ERROR。（Claude）

### 變更（wait 輪詢契約）
- `wait` 逾時改回目前結果陣列，僅仍 running 的項目附 `timedOut: true`，已結束的項目不附 liveness；未知 pid 仍丟錯。CLI 逾時印 JSON 並 exit 3（0 = 全部結束，1 = 錯誤）。同步 MCP 描述、CLI help 與 README，建議以 ≤ 90 秒反覆 wait 並搭配 peek，避免呼叫端把 InternalError 當任務失敗而遺棄 pid；同時移除每輪等待留下的 listener。（@codex-gpt-6-astra，moerasermax 指示）
- Windows detached wrapper 改經 `cmd.exe` 啟動 npm `.cmd` shim，並使用新版 wrapper 檔名，讓 CLI file 路徑確實能啟動並回報 liveness；原本直接 spawn `.cmd` 會被 Node 拒絕，無法完成慢速 stub 驗證。（@codex-gpt-6-astra，moerasermax 指示）

### 新增（GPT-6 Astra 與 codex 的 max / ultra effort）
- **`gpt-6-astra`（GPT-6-Astra）加入 codex 目錄，排在清單最前。** 名稱與能力抄自 codex-cli 的
  `~/.codex/models_cache.json`（2026-09-05）：priority 1、text + image、reasoning 六級
  low / medium / high / xhigh / max / ultra、CLI 端預設 medium。實跑確認：`gpt-6-astra` 配 `ultra`
  與 `max` 都能經由 `run` → `wait` 拿到回答。（Claude，moerasermax 指示；程式碼由
  @codex-gpt-6-astra（xhigh）與 @gemini-3.1-pro 獨立審查——前者 3 項發現全部採納、見下方「變更」，
  後者未發現確信問題）
  - **需要 codex-cli ≥ 0.153.x。** 0.151.0 的 `models_cache.json` 雖然已經列出 `gpt-6-astra`，
    實跑會先報 `Model metadata for gpt-6-astra not found`，接著被 API 以
    `requires a newer version of Codex` 拒絕（HTTP 400）。這台機器已從 0.151.0 升到 0.153.4。
- **codex 的 `reasoning_effort` 多收 `max` 與 `ultra`**；全域集合 `ALLOWED_REASONING_EFFORTS`
  加入 `ultra`。claude 仍只到 `max`：明確傳 `ultra` 給 claude 會以 agent 專屬錯誤拒絕，設定檔給的
  `ultra` 落到 claude 則照舊靜默略過。codex 這邊收的是各模型能力的**聯集**、不按模型細分——同一份
  快取顯示 gpt-5.6-luna 到 max、gpt-5.5 / gpt-5.4-mini / gpt-5.3-codex-spark 仍只到 xhigh；
  不支援的組合由 codex CLI 自己拒絕，錯誤原樣回到呼叫端。（Claude）
- `verify-alias-config.mjs` 新增第 3c 節（8 條）、set_config 段 2 條與第 3 節 1 條（現為 76 項）；
  `tools/mutations.json` 新增 5 個對應突變（31 → 36），全部實測 KILLED、且各自由指定的斷言殺掉。（Claude）
  - 突變測試順帶抓到新斷言自己的弱點：codex 拒收 ultra 時 `buildCliCommand` 會拋例外，原本的
    寫法讓整支腳本當場中斷、後面的 set_config 斷言一條都跑不到——兩個突變因此被判成
    「KILLED(其他斷言)」。改成把例外收成 FAIL 後，4 個突變各自由指定的斷言殺掉。

### 變更（GPT-6 Astra）
- **`codex-ultra` 改指 `gpt-6-astra`，內建預設 effort 由 `xhigh` 改為 `max`**（`ultra` 保留給明確傳入）。
  「codex 最強組合」這個 alias 的意思沒變，變的是最強組合本身；`config.json` 的 `aliasModel` /
  `aliasReasoningEffort` 仍可覆寫。優先序沒動：使用者若在 `config.json` 設了
  `aliasReasoningEffort["codex-ultra"]` 或 `defaultReasoningEffort`，那個值仍然贏過內建的 `max`。
  （Claude，moerasermax 指示）
- `run` 的 `reasoning_effort` 參數描述、`ai-cli run --help`、README 的 alias 表與優先序說明同步更新。
  README 原本拿「codex 不吃 `max`」當靜默略過的例子，現在已不成立，改用「claude 不吃 `ultra`」。（Claude）
- **`models` 回報的 `aliases[].defaultReasoningEffort` 只回報真的會送出的值。** 舊寫法只看該 agent
  「支不支援 reasoning」、不看「值在不在它的允許集合」——設定檔給 `codex-ultra` 的 effort 是 `ultra`、
  `aliasModel` 又把它重指到 `opus` 時，payload 回報 `ultra`，指令裡卻沒有 `--effort`（claude 不吃
  ultra，command-builder 靜默略過）。
  現在「送不送」與「報不報」共用同一條規則 `acceptsConfiguredEffort()`（`core/reasoning.ts`），
  command-builder 也改用它。新增 1 條斷言與 1 個突變。（獨立稽核 @codex-gpt-6-astra 抓到；Claude 修）
- README 的 alias 表與 `run` 的 `model` 參數描述補上 **codex-cli 版本門檻**：`gpt-6-astra`（因此也包括
  `codex-ultra`）需要 0.153 以上，舊版可用 `aliasModel` 暫時指回 `gpt-5.6-sol`。（獨立稽核
  @codex-gpt-6-astra 指出未揭露此相容性條件；Claude 補）

### 修正
- **`agy models` 的查詢從上線起就沒有成功過一次。** 舊解析規則是「整行不含空白才算模型 id」，
  而 agy v1.1.17 的實際輸出是 `<id>	<顯示名稱>`（`gemini-3.1-pro-high	Gemini 3.1 Pro (High)`）
  ——顯示名稱必然帶空白，於是**每一行都被濾掉**，`discoverModels()` 永遠回 `null`，目錄永遠
  降級成 `builtin-fallback`。降級標示本身是誠實的，所以症狀看起來像「agy 查不到」而不像 bug。
  改成取每行第一個空白分隔欄位、且必須長得像模型 id，並先剝掉 ANSI 跳脫序列。修好後
  `models` / `doctor` 對 antigravity 回 `source: vendor-cli`，模型從靜態的 4 個變成實查的 11 個
  （`gemini-3.7/3.6/3.5-flash-{high,medium,low}`、`gemini-3.1-pro-{high,low}`）。（Claude）
  - **這個 bug 本來就有斷言抓得到**：`verify-catalog-source.mjs` 的「★ 有 agy 時真的去問了 CLI」
    在有裝 agy 的機器上從 2026-07-31 起一直是紅的。沒被發現不是因為缺測試，是因為那支測試
    沒在有 agy 的機器上跑過——沒有 agy 的機器會走 SKIP 分支。

### 變更
- `discoverModels()` 只回報**本框架真的會路由到 agy** 的 id。`agy models` 也會列出它代理的
  `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`，但 `matchesAgyModel`
  刻意不收這些名字（靠名字猜會把使用者送到錯的 CLI）。照單全收會讓 `models` 多出
  「列得出來、選了卻被 claude 的 catch-all 接走」的選項。（Claude）
- `matchesModel` 抽成具名匯出的 `matchesAgyModel()`，路由判斷只留一份實作，`discoverModels`
  共用同一份。（Claude）
- **更正兩處對外說明**：`set_config` 的 note 與 `model` 參數描述都還寫著「agy ignores model
  selection entirely / its CLI takes no --model flag」。那是 v1.0.x 的事實，2026-07-31 起
  `buildCommand` 早就在傳 `--model` 了。實測 `--model gemini-3.1-pro-high` 與
  `--model gemini-3.5-flash-high` 會得到不同的模型。（Claude）
- **更正 `matchesModel` 註解裡的一句假用法**：原本寫「要指定『agy 上的 claude』請用目錄的
  `antigravity/claude-sonnet-4-6`」。實查沒有任何地方會拆 `<agent>/<model>`——
  `selectAgentForModel` 只拿整個字串去問 `matchesModel`。那只是目錄的顯示 id，不是呼叫寫法。（Claude）
- `verify-catalog-source.mjs` 的失敗行由 `[FAIL] x` 改成 `FAIL x`，與其他 verify 腳本一致。
  `tools/mutation-test.mjs` 是掃「含 `FAIL ` 的行」判定突變有沒有被對應斷言殺掉，
  `[FAIL]` 一條都對不上——等於這支腳本先前根本無法納入突變測試。（Claude）

- `verify-exec-contract.mjs` 的失敗行同樣由 `[FAIL] x` 改成 `FAIL x`（理由同上）。（Claude）

### 新增
- `parseAgyModelsOutput()` 從 `discoverModels()` 抽出並匯出，改用**錄下來的真實 `agy models`
  輸出**做回歸測試（`verify-catalog-source.mjs` 新增第 3c 節，8 條斷言，27 → 35 項）。
  原本的第 3 節把 `discoverModels` 換成 stub，只驗得到「查不到時要誠實降級」，
  驗不到「查得到時解析對不對」——這次的 bug 正好落在那個洞裡。（Claude）
- 三個對應突變（`tools/mutations.json`，21 → 24）：解析退回舊規則、不剝 ANSI、
  照單全收不過濾路由。三個都實測 KILLED（原地套用＋還原，未走 worktree harness）。（Claude）

### 新增（`exec` 的明確不設限授權）
- **`authority: 'unrestricted'`**。fail-closed 的預設**一個字都沒動**——沒帶 `authority` 的請求
  與從前完全一樣。新增的是一條**明確**的鬆綁：呼叫端自己寫出這個字面值，代表「這次的不設限
  是人授權的、由呼叫端負責」，exec 才改用該 vendor 的一般組裝（帶 `--dangerously-*`）。
  這不是退回——退回是「呼叫端要求限制、我們給不出、卻偷偷放寬」。（Claude）
  - `authority` 與 `capabilities` 同時出現 → 以**語義衝突**為由拒絕，不猜呼叫端想要哪一個。
  - 只認 `'unrestricted'` 字面值；未知值（例如 `'yolo'`）一律拒絕，**不當成沒寫**
    ——當成沒寫會讓呼叫端以為授權生效、實際上受限。
  - `started` frame 新增 `authority` 欄位，回報**實際**生效的模式。版本不合的對端不認識
    這個欄位，於是能發現「要求了 unrestricted 但對方沒生效」而拒絕解讀。
  - 這個設計與它的 8 條斷言是 **2026-08-17 就寫好的**，但 `src/app/exec.ts` 只加了檔頭註解、
    實作從缺，`verify-exec-contract.mjs` 因此一直停在 20/24（其中 4 條連跑都跑不到，
    因為 `planExec` 不存在）。現在 28/28。
- **`planExec()` 匯出**：exec 的決策（選 agent、選組裝、定生效模式）抽成純函式，不 spawn、
  不寫 frame。這條分支若只能靠整跑驗證，每驗一次都要真的啟動一個 vendor CLI——花錢、慢、
  受機器狀態影響，於是實務上就不會有人驗它，而它偏偏是「權限有沒有真的收好」的那條線。（Claude）
- **`splitCatalogModelId()`**：`exec` 支援 `<agent>/<model>` 目錄 id（`codex/gpt-5.3-codex`）。
  前綴不是已知 agent id 時原樣保留——direct-api 的 `or-qwen/qwen3.7-plus` 本來就含斜線，
  拆掉會毀掉那條路徑。目錄 id 指定的 vendor 與名稱路由不一致時（`antigravity/claude-sonnet-4-6`）
  **拒絕**，不做跨 vendor 強制指派。**只在 `exec` 生效，`run` 的路由一行未動。**（Claude）
- 四個對應突變（`tools/mutations.json`，24 → 28）：語義衝突不擋、authority 收下任意值、
  started frame 的 authority 寫死、unrestricted 仍走嚴格組裝。四個都實測 KILLED。（Claude）
  - 其中一個順帶抓出原斷言的弱點：「started frame 帶 authority」原本是掃原始碼有沒有這個字，
    而型別已經逼著這個欄位必須存在（拿掉根本編不過），等於白抓。改成釘 `plan.authority`
    這個**值的來源**——欄位還在、值被寫死成字面值的情況現在會被抓到。

### 變更（模型目錄：列得完整，且每一筆說得出自己能不能派工）

上一版把 agy 的動態查詢修好之後留下兩個洞，這一版一起補：

- **`CatalogEntry` 新增 `routable: boolean`**（由 `agent.matchesModel(model)` 推得，
  不寫死任何 vendor 規則）。vendor 回報的清單可能含本框架送不到它那裡的名字
  ——agy 就代理了 `claude-sonnet-4-6` / `claude-opus-4-6-thinking` / `gpt-oss-120b-medium`，
  那些名字會被 `selectAgentForModel` 送去 claude/codex。（Claude）
- **`discoverModels()` 改成回報 vendor 說的全部**，不在那一層過濾。
  上一版是在 `discoverModels` 就把路由不到的名字濾掉——動機沒錯（避免候選名單出現
  「列得出來、選了卻跑去別家」的選項），但做法錯了：目錄標著 `vendor-cli`
  卻默默少三筆，而「少了」這件事在輸出裡完全看不見。**那正是 catalog-v2 這一層
  存在的理由所要防的病，只是換了個位置發作。** 現在是「列出來並標明」。（Claude）
- **`modelsByAgent()` 改成「靜態清單 ∪ 實查到且可路由的」**。以前只回靜態值，
  於是 agy 查詢修好之後，`catalogV2` 誠實列出 11 個實查模型，而 `run` 的候選名單
  與工具描述還停在寫死的 4 個——**查得到、跑得動、卻沒列在使用者真正會看的地方**
  （實測 `gemini-3.7-flash-low` 可正常派工，但當時沒被列出）。
  只增不減：靜態清單含 `agy` / `agy-default` 這種框架 alias，vendor 永遠不會回報它們，
  砍掉會弄丟有效用法。實查來的只收 `routable` 的。（Claude）

結果：`catalogV2` 列 agy 全部 14 筆（11 可派工 + 3 標明不可路由），
`run` 的候選名單 13 筆（4 靜態 + 9 實查）。claude / codex / direct-api 不受影響。

- 回歸斷言 35 → 41（`verify-catalog-source.mjs`）：routable 是 boolean、標示與實際路由
  一致、候選名單只放可路由的、框架 alias 不消失、實查結果要進候選名單。（Claude）
- 突變 28 → 31（拿掉一個因這次改動而過時的，補四個）：routable 寫死 true / 寫死 false、
  候選名單不過濾 routable、候選名單退回靜態。四個都實測 KILLED。（Claude）

### 其他
- `.gitignore` 補上 `e2e-out.txt`。`verify-e2e.mjs` 每次跑都會重新產生它，
  旁邊的 `mcp-test-out.txt` 早就被忽略了，這個漏了。（Claude）

## [5.0.0] - 2026-07-30

實測全部五個 agent 之後的收斂：Claude 5/5 模型可用、Codex 6/9（3 個被 ChatGPT 帳號層級擋下）、
Antigravity 可用；**Kiro 沒額度**（CLI 回 `Not logged in`）、**Forge 從沒安裝過**
（`resolvedPath: null`）。兩個長期不能用的 agent 拔掉，並把 direct-api 這條
「自己接第三方 API」的路徑補上完整說明——它現在是主要的擴充管道。

### 移除
- **Kiro agent**（`src/agents/kiro.ts`）與其 7 個 model、`kiro-ultra` alias、
  `query_usage` 的 Kiro 供應商。（Claude）
- **Forge agent**（`src/agents/forge.ts`）與 `peek-extractor` 裡整套 Forge 專用擷取策略
  （`extractForgeLines` / Execute-Finished 配對 / stderr 特例）。（Claude）
- `PeekEventExtractor` 的 `source` 建構選項與 `flush()` 的 `terminal` 選項。這兩個**只有**
  forge 的策略在讀，其餘 agent 從來不看；留著會是「看起來有作用、其實沒人讀」的死狀態。（Claude）

### 變更（破壞性）
- `kiro`、`kiro-default`、`kiro-ultra`、`kiro-deepseek-3.2`、`kiro-minimax-m2.5`、
  `kiro-minimax-m2.1`、`kiro-glm-5`、`kiro-qwen3-coder-next`、`forge` 這些 model 名稱
  現在會**丟出明確錯誤**。**這一條是重點**：claude 的 `matchesModel` 是 catch-all 永遠回 true，
  不主動攔的話這些名稱會被 claude 悄悄接走並正常回答，呼叫端根本不會發現自己跑的不是 Kiro。
  攔截點放在 alias 解析之後、`selectAgentForModel` 之前，所以連 alias 形式也擋得到。（Claude）
  - **不受影響**：`forge-<model>` 仍然有效，那會被讀成 direct-api 的 provider `forge` 加 model，
    在更早的 `resolveDirectApiModel()` 就解析走了。
- `AgentId` 收窄為 `claude | codex | antigravity | direct-api`。`CliPaths` 是從它推導的
  （`Record<Exclude<AgentId,'direct-api'>, string>`），所以型別一改，編譯器就把所有殘留點點名出來。（Claude）
- `doctor` 不再回報 Kiro / Forge；`query_usage` 只剩 claude / codex / agy（全部 PTY，
  移除了唯一走 pipe 的 Kiro，連帶簡化 `transport` 判斷）。（Claude）

### 新增
- **README 新增「direct-api：自己接任何第三方 API」專章**：`providers.json` 格式
  （含 `key`/`token`、`baseURL` 等別名寫法）、`or-`/`ds-` 內建前綴與預設端點、
  如何加自訂 provider（DeepSeek / Ollama 等範例）、`<provider>-<model>` 呼叫方式，
  以及能力與限制（工具呼叫、session、`[image:]`、`[no-tools]`、30 次上限、api_key 遮蔽）。（Claude）
- 回歸斷言：`kiro` / `kiro-default` / `kiro-ultra` / `kiro-glm-5` / `forge` 五個名稱
  必須被拒絕**且不得被路由到 claude**（`verify-alias-config.mjs`，60 → 65 項）。
  `verify-mcp.mjs` 另外斷言 models payload 不再有 kiro/forge 區塊與 `kiro-ultra` alias。（Claude）
- 突變 `移除的 model 名稱不攔截（kiro/forge 靜默路由到 claude）`。（Claude）

## [4.1.2] - 2026-07-30

起因是一台機器的 `ai-cli` MCP 連不上（`Failed to reconnect to ai-cli: -32000`），
另一台正常 —— 差別只在兩台註冊了不同的 entry point。

### 修正
- **`ai-cli mcp` 入口一連上就自殺**（從 `66ec771` 框架初版就存在）。`runMcpServer()`
  在 transport 接上的瞬間就 resolve，但呼叫端會合理讀成「server 跑完了」；
  `bin/ai-cli.ts` 正是在 `runCli()` resolve 之後呼叫 `process.exit()`，於是 server 在
  handshake 完成前就死掉（實測 0.2 秒退出、stdout 全空），client 收到
  `MCP error -32000: Connection closed`。改為 `runMcpServer()` 等到
  `waitUntilClosed()` 才 resolve，讓三個入口從「碰巧正確」變成「因設計而正確」。
  另外兩個入口（`dist/server.js`、`dist/bin/ai-cli-mcp.js`）之所以一直沒事，
  只是因為它們沒有呼叫 `process.exit`，不是設計使然。（Claude）
- **`verify-mcp.mjs` 從來只測得到三個入口中的一個**，所以上面那個 bug 活了四個版本
  都沒被抓到 —— 它硬編 `C:\Users\Moera\...\dist\server.js`（另一台機器的絕對路徑）。
  改為相對 `import.meta.url` 解析，並且**三個入口各跑一次完整 smoke test**
  （handshake → 11 個工具 → models → doctor → list_processes）。（Claude）
- **突變 harness 自己的假綠燈**：`tools/mutation-test.mjs` 寫死只跑
  `verify-alias-config.mjs`，任何斷言落在別支腳本的突變都會被判成 SURVIVED。
  新增 `script` 欄位讓每個突變指定負責的 verify 腳本（預設維持
  `verify-alias-config.mjs`），基準檢查也改為逐一驗證用到的每一支。（Claude）
- **突變 harness 在全新機器上直接 crash**：它無條件 `copyFileSync` 備份
  `~/.local/share/ai-cli/config.json`，但使用者從沒改過設定時那個檔並不存在，
  於是 ENOENT 當場中止。改為檔案不存在時跳過備份，收尾改成刪掉測試產生的那份。（Claude）

### 變更
- `package.json` 新增 `prepare: npm run build`。`dist/` 不進版控，clone 後必須編譯，
  現在 `git clone && npm install` 一步到位。（Claude）
- `verify-e2e.mjs` 去掉兩處硬編：server 路徑改為相對 `import.meta.url`，
  工作目錄由 `C:\Users\Moera` 改為 `homedir()`。仍刻意不納入 `npm test`。（Claude）
- README 移除硬編絕對路徑，新增「快速開始」與可直接複製的 `claude mcp add` 指令
  （bash / PowerShell 兩版），並說明三個入口等價、以 `dist/server.js` 為官方推薦。（Claude）

### 新增
- 突變 `runMcpServer 不等 transport 關閉（ai-cli mcp 啟動即自殺）`，由
  `verify-mcp.mjs` 負責抓。（Claude）

## [4.1.1] - 2026-07-30

全部來自 v4.1.0 的**發版後驗收稽核**（@codex xhigh，唯讀＋實跑）。
逐條處置見 [`docs/audits/2026-07-30-v4.1.1.md`](./docs/audits/2026-07-30-v4.1.1.md)。

### 修正
- **回歸：`set_config` 又會拿空基底覆寫設定檔（資料遺失）**。4.1.0 把讀取端的
  「結構性錯誤」集合從 `{ENOENT, ENOTDIR}` 擴大到含 `EISDIR` / `ELOOP` / `ENAMETOOLONG`，
  但 `readRawConfig()`（寫入端的基底）共用同一個判斷 —— 於是「路徑上有東西、只是讀不到」
  被當成「檔案不存在」，正好推翻 4.1.0 自己承諾的「只有檔案不存在才用空基底」。
  寫入端改回只認 `ENOENT`。**兩端的判準必須分開**：讀取端問「這次該用什麼值」，
  寫入端問「覆蓋下去會不會弄丟還在的東西」。（Claude；@codex 稽核指出）
- **突變測試工具自己的假綠燈**：收尾的 `run('git', ['status','--short'])` 因為 `run()`
  只吃一個參數陣列而**根本沒執行 git**，卻把空字串印成「worktree 乾淨」；
  同時還原時寫回的是 LF 正規化後的內容，實際上每輪都把 worktree 弄髒。
  改為分出 `exec(cmd,args)`、還原寫回原始 bytes、與開跑時的 `git status` 比對，
  不一致就以非零碼收場。（Claude；@codex 稽核指出）
- **`verify-e2e.mjs` 只看輸出長度**：「CLI 失敗但吐了一段錯誤訊息」會被判成成功。
  改為同時檢查 `status` / `exitCode` / 是否真的回 `PONG`。（Claude；@codex 稽核指出）
- **`verify-direct-api.mjs` 的暫存目錄清理只在成功路徑**：assertion 中途拋錯仍會留垃圾。
  改掛 `process.on('exit')`。（Claude；@codex 稽核指出）

### 變更
- **突變 14 → 19 個**：補上寫入端錯誤分類、根節點陣列、`aliasReasoningEffort` 陣列、
  `ELOOP`、`getModelsPayload(snapshot)` 不重讀。補的過程中突變測試又抓出兩條原本
  **不夠力的斷言**（根節點陣列擋不擋都回內建值，分辨不出來；三個結構性 code 寫成迴圈時，
  第一個會清掉快取讓後面的失去鑑別力），一併改強。（Claude）
- **測試 49 → 60 項**。（Claude）

### 更正（先前敘述不實）
- v4.1.0 的稽核紀錄稱「把**每個**修補逐一改壞」—— 實際只涵蓋產品端，
  測試基礎設施的修補沒有突變覆蓋。已改寫。（@codex 稽核指出）
- v4.1.0 的「API 變更**皆**向後相容」不成立：`updateUserConfig()` 回傳型別由
  `UserConfig` 改為 `ConfigSnapshot`，舊呼叫端若直接取 `.aliasModel` 會壞。
  見下方 4.1.0 的更正標註。（@codex 稽核指出）

## [4.1.0] - 2026-07-29

本版的重點是**設定檔讀寫的韌性**，全部屬於「不報錯、只安靜做錯事」那一類。
驗證方式與兩份獨立稽核的逐條處置見 [`docs/audits/2026-07-29-v4.1.0.md`](./docs/audits/2026-07-29-v4.1.0.md)。

### 修正
- **讀取錯誤的分類**：`ENOENT` / `ENOTDIR` / `EISDIR` / `ELOOP` / `ENAMETOOLONG` 屬**結構性**
  （不會自己好）→ 退回內建預設；`EBUSY` / `EPERM` / `EACCES` 等屬**暫時性** → 沿用 last-good。
  分界點是「再試一次有沒有可能成功」，不是「錯誤嚴不嚴重」。原本只有前兩個算結構性，
  於是「設定檔路徑被同名目錄佔住」這種永遠好不了的情況會讓一份讀不到的設定無限期存活。
  （Claude；@codex 稽核指出）
- **陣列型 `aliasModel` 會經由 `set_config` 復活成垃圾 alias**：parser 會忽略陣列，
  但 `set_config` 直接 spread 它 —— `{ ...['a','b'] }` 產生 `{"0":"a","1":"b"}` 寫回磁碟，
  那些數字 key 就從「被忽略」升級成「parser 認可的 alias」。非普通物件一律不 spread。
  （Claude；@codex 稽核指出）
- **`describeUserConfig()` 可能回報「A 版設定配 B 版狀態」**：它吃外部傳入的 config，
  卻搭配模組層級的 `lastStatus`。改為引入 `ConfigSnapshot { config, status }` 把兩者綁成一包傳遞。
  （Claude；@codex 稽核指出）
- **`set_config` 仍讀兩次設定檔**：`updateUserConfig()` 讀一次，回傳值被丟掉後
  `getModelsPayload()` 又讀一次 —— 中間有別的 writer 介入時，回傳的 payload 描述的
  就不是本次寫入的結果。改為直接把剛寫入的 snapshot 傳給 `getModelsPayload()`。
  （Claude；@codex 稽核指出）
- **`verify-e2e.mjs` 無論結果都 `process.exit(0)`**：三家 CLI 全都沒回應也會被讀成通過。
  （Claude；@gemini-3.1-pro 稽核指出）
- **`npm test` 沒有跑 `verify-mcp.mjs`**：MCP handshake 與工具清單完全在測試範圍外。串進 chain。
  （Claude；@gemini-3.1-pro 稽核指出）
- **`verify-alias-config.mjs` 的還原可能毀掉使用者設定**：測試中途會把 `config.json` 換成
  同名目錄，若殘留，還原時的 `copyFileSync` 會拿到 `EISDIR` 而拋錯 —— 使用者的設定就只剩備份檔。
  改為還原前強制清掉殘留目錄，並註冊 SIGINT/SIGTERM/SIGHUP/SIGBREAK。
  （Claude；@gemini-3.1-pro 稽核指出）
- **`verify-direct-api.mjs` 每跑一次就在 `%TEMP%` 留一個目錄**。（Claude；@gemini-3.1-pro 稽核指出）

### 新增
- **突變測試工具 `tools/mutation-test.mjs` + `tools/mutations.json`**：把**產品端**的修補
  逐一改壞，斷言「對應的測試必須 FAIL」。用來抓假綠燈 —— 這個專案已經吃過三次虧。
  在獨立 git worktree 上跑，不碰主工作目錄。本版 14 個突變全部 KILLED
  （測試基礎設施本身的修補沒有突變覆蓋；v4.1.1 補到 19 個）。
  新增修補時請順手加一個對應突變。（Claude）
- **`models` 的 `userConfig` 新增 `status` 欄位**：`fresh` / `missing` / `stale`（正在沿用
  last-good，附 `errorCode`）/ `error`。`exists` 也改由同一次載入推導，不再另外 `existsSync`
  ——否則會出現「`exists: true` 但回報的其實是 last-good 舊值」這種互相矛盾的診斷。（Claude）
- **設定物件會被 `Object.freeze`**：回傳的是共用參照，凍結後將來若有人誤改會當場丟錯而不是
  靜默污染所有後續讀取（目前所有呼叫端都已確認是唯讀）。（Claude；@gemini-3.1-pro 稽核指出）
- **稽核紀錄 `docs/audits/`**：逐條記錄稽核發現、判定（採納／駁回）與處置。（Claude）

### API 變更
- 新增 exported `loadUserConfigSnapshot()`、`ConfigSnapshot`、`ConfigStatus`。（向後相容）
- **不相容**：`updateUserConfig()` 回傳型別由 `UserConfig` 改為 `ConfigSnapshot`
  —— 直接取用回傳值欄位（如 `.aliasModel`）的呼叫端要改成 `.config.aliasModel`。
  本 repo 內唯一呼叫端是 `set_config`，已一併更新。
  （原本誤記為「皆向後相容」，由 v4.1.1 的驗收稽核更正。）
- `resolveConfiguredAliasModel` / `resolveConfiguredReasoningEffort` / `resolveModelAlias` /
  `getEffectiveAliasDetails` / `getModelsPayload` / `describeUserConfig` 新增**可選**的
  config/snapshot 參數；不傳時行為與原本相同。
- `set_config` 在設定檔讀不到或內容壞掉時，由「靜默成功並覆寫」改為**丟出明確錯誤**。

### 已知限制（本版明確記錄，未修）
- **手動編輯的 `aliasModel` 不會被驗證**：`set_config` 會擋掉不存在的 model，直接編輯設定檔則不會
  ——打錯字會被 catch-all 的 claude agent 靜默接走。`user-config` 不能 import `catalog`
  （會循環依賴），所以驗證只能放在消費端。可用 `models` 的 `agent` 欄位自檢。
- **多 process 並發寫入會遺失更新**：`set_config` 是無鎖的 read-modify-rename。

### 同版稍早的修正（commit `a5d5fa9`）
- **`set_config` 在設定檔讀不到／壞掉時會把它整份覆寫掉（資料遺失）**：`readRawConfig()` 原本
  對任何讀取或解析錯誤都回 `{}`，於是鎖檔的瞬間或使用者手改壞 JSON 之後，`set_config` 會拿
  **空基底**套上 patch 再寫回去 —— 原有設定與所有未知欄位就沒了。改為只有「檔案不存在」
  才用空基底，其餘一律丟出明確錯誤（寧可讓 `set_config` 失敗，也不能靜默覆寫）。（Claude；@codex 稽核指出）
- **讀檔失敗會靜默退回內建值**：`loadUserConfig()` 改成每次讀檔後，Windows 上撞到別的 process
  做 tmp+rename 或防毒鎖檔的機會變大；原本任何讀取錯誤都回 `{}`，等於那一次 run **悄悄換成
  另一個 model / reasoning**。現在區分 `ENOENT`／`ENOTDIR`（檔案真的不存在 → 用內建值）與
  其他錯誤（暫時性 → 沿用上一次成功的設定 last-good）。（Claude）
- **UTF-8 BOM 讓整份設定靜默失效**：Windows 記事本與 PowerShell 5.1 的 `Set-Content` 會寫出
  帶 BOM 的檔案，`JSON.parse` 遇到開頭的 U+FEFF 直接丟 `SyntaxError` → 設定全部不生效。
  讀檔後剝除 BOM。（Claude；@gemini-3.1-pro 稽核指出）
- **解析失敗後舊設定會「復活」**：JSON 壞掉時回 `{}` 但沒清快取，接著一次讀檔失敗就會把這份
  已作廢的舊設定當成 last-good 端出來。改為解析失敗即清快取。（Claude；@gemini-3.1-pro 稽核指出）
- **`aliasModel` / `aliasReasoningEffort` 是陣列時會產生垃圾 alias**：`typeof [] === 'object'`，
  `Object.entries` 會解出 `"0"` / `"1"` 這種 key。三處都補上 `Array.isArray` 檢查。（Claude；@gemini-3.1-pro 稽核指出）
- **同一次操作可能混用兩個版本的設定**：`buildCliCommand()` 原本讀 2 次設定檔（一次解析 alias、
  一次取 reasoning）、`getModelsPayload()` 讀 8 次，中間只要檔案被改動就會組出「A 版 alias +
  B 版 reasoning」這種兩邊都不對的結果。改為在操作入口載入一份 snapshot 往下傳，
  **兩者都降為 1 次讀取**，並加上讀取次數的回歸斷言。（Claude；@codex 稽核指出）
- **`updateUserConfig()` 寫入後重讀的空窗**：原本「清快取 → 重讀」，中間讀檔失敗時 last-good
  是空的，會回報一份跟磁碟上不一樣的設定。改為直接用剛寫出去的文字建立快取，也省掉一次讀檔。（Claude；@codex 稽核指出）

## [4.0.0] - 2026-07-29

> **破壞性變更**：移除 OpenCode agent 與 `oc-*` model routing。依 CONTRIBUTING §4，
> 「對外 MCP 行為或介面不相容」屬 MAJOR，因此本版是 4.0.0 而非 3.2.0。
> 仍在用 `oc-<model>` 的呼叫端要改用 direct-api 的 `or-<model>` / `ds-<model>` /
> `<provider>-<model>`。

### 新增
- **model alias 可在 runtime 重新指向，免 rebuild、免重啟**：`config.json` 新增 `aliasModel` 欄位
  （例如 `{"codex-ultra": "gpt-5.6-terra"}`），優先於 `models/catalog.ts` 寫死的 `MODEL_ALIASES`。
  `resolveModelAlias()` 是每次組指令時才呼叫、設定檔又是每次重讀，所以改完下一次 `run` 立即生效。
  同時新增 MCP 工具 **`set_config`** 負責寫入（`alias_model` / `alias_reasoning_effort` /
  `default_reasoning_effort` / `unset`），回傳與 `models` 相同的 payload 讓呼叫端立刻看到生效狀態。
  寫入採「讀原始 JSON → patch → tmp + rename」，會保留設定檔中它不認識的欄位。
  驗證上刻意擋掉未知 model：claude agent 的 `matchesModel` 是 catch-all，不擋的話打錯字會被
  **靜默送去 claude**，因此 `set_config` 只接受某個非 fallback agent 認得的 model 或
  direct-api 的 provider-prefixed 名稱。`models` 的 aliases 每筆新增 `source`
  （builtin/config），被 config 重指的那幾筆另附 `builtinResolvesTo`，
  且 `agent` 欄位改為依實際生效的 model 動態推算
  ——alias 被跨 agent 重指（如 `codex-ultra`→`opus`）時才不會回報錯的 agent。
  實測：不重啟直接把 `codex-ultra` 指到 `gpt-5.6-doesnotexist`，codex CLI 確實回報
  `The 'gpt-5.6-doesnotexist' model is not supported`，證明 `--model` 真的帶著新值送出。
  注意 antigravity（agy）不吃 `--model`，重指 `agy-ultra` 只影響回報、不影響實際執行。
  獨立稽核（@codex，xhigh）抓出並已修掉四個洞：(1) `or-` / `ds-` 這種空 direct-api model
  能通過 `matchesModel` 但 run 時必炸 —— 改為要求 `resolveDirectApiModel` 真的解析得出來；
  (2) 把 alias 名稱當 target（如 `codex-ultra`→`kiro-ultra`）會因為 alias 只解析一層而被
  kiro 剝成 `--model ultra` —— 改為直接拒絕 alias 當 target；(3) `constructor` / `toString`
  等 prototype key 在 `model in MODEL_ALIASES` 與 `map[key]` 下會被誤判為合法 alias 或取到函式
  —— 全部改用 `hasOwnProperty` 檢查；(4) `updateUserConfig` 的 tmp 檔名固定，跨 process 並發
  寫入會互相覆蓋且 rename 拿到 ENOENT —— 改為帶 pid 並在失敗時清理。另修正 alias 被重指到
  不支援 reasoning 的 agent 時，`models` 仍回報一個不會生效的 `defaultReasoningEffort`。（Claude）
- **alias 熱切換回歸測試 `verify-alias-config.mjs`**：33 項斷言，涵蓋 `isKnownModelTarget` /
  `resolveModelAlias` 的邊界（含上述稽核抓出的四個案例）、「同一個 process 內改設定，
  `buildCliCommand` 組出的 `--model` 與 agent 立即跟著變」，以及真的起一個 MCP server
  走 stdio JSON-RPC 驗 `set_config` 的驗證／寫入／`unset`（含「同時清掉 reasoning 覆寫」）／
  未知欄位保留。執行前備份 `config.json`，並以 `try/finally` 無條件還原。（Claude）
- **使用者持久化設定 `config.json`**：新增 `~/.local/share/ai-cli/config.json`（與 providers.json
  同層），支援 `defaultReasoningEffort` 與 `aliasReasoningEffort`，可持久覆寫原本寫死的
  ultra alias 預設（`claude-ultra`=max / `codex-ultra`=xhigh）。優先序為：呼叫端明確參數 >
  `AI_CLI_DEFAULT_REASONING_EFFORT` 環境變數 > `aliasReasoningEffort` > `defaultReasoningEffort` >
  內建預設。設定檔缺失／格式錯誤一律靜默退回內建值；由設定推導出的預設若該 agent 不支援
  reasoning 或值不在其允許集合，會靜默略過而非丟錯（明確傳入的不合法值仍照舊丟錯）。
  設定檔每次重讀，改檔免重啟。`models` 工具新增 `userConfig` 欄位回報目前生效設定。（Claude）
- **direct-api 的 tool use agent loop**：direct-api 不再只是單次問答，內建
  `read` / `write` / `grep` / `glob` / `bash` / `list_dir` 六個工具的 agent 迴圈，
  讓沒有自家 CLI 的 vendor 模型也能真的動檔案與跑指令。（@codex）
- **gpt-5.6 模型家族**：codex catalog 新增 `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`。（@codex）
- **direct-api agent**：移除 OpenCode CLI agent，新增不啟動子程序的 OpenAI-compatible API agent。
  支援 `or-<model>`（OpenRouter）、`ds-<model>`（DashScope）與 providers.json 中的
  `<provider>-<model>`，設定檔位於 `~/.local/share/ai-cli/providers.json`；首次使用時可從
  OpenCode `auth.json` 一次性遷移 API key。direct-api 會輸出 NDJSON streaming events、
  支援 `[image:path]` vision content，並把對話保存到 `workFolder/.tmp/api_sessions/`。（@codex）
- **熔斷器 rate 路徑回歸測試**：新增純邏輯測試腳本 `verify-rate.mjs`，注入固定時鐘餵 33 個不同
  prompt 給已編譯的 `CircuitBreaker`，斷言爆量 rate 門檻（`maxStarts=30`）在第 31 次觸發；
  不啟動任何 AI 子程序，與既有 `verify-breaker.mjs`（測 duplicate 路徑）同性質、互補覆蓋兩條電路。
  此腳本曾協助定位「磁碟 dist 已重編但運行中 server 仍載入過期 in-memory build」的問題。（@claude-code，moerasermax 指示）
- **`test` npm script**：`package.json` 新增 `test`，把純驗證腳本串成正式測試入口，供本地與 CI
  快速防回歸（任一支失敗即中止並回傳非零碼）。本版收斂為四支：`verify-breaker` /
  `verify-rate` / `verify-direct-api` / `verify-alias-config`，全部不打真實 AI 供應商。
  其中 `verify-alias-config.mjs` 會暫時改寫真實的 `~/.local/share/ai-cli/config.json`
  （自帶備份還原），已在 `CONTRIBUTING.md` 標註；`verify-e2e.mjs` 會真的呼叫三家 CLI、
  消耗額度，刻意不納入。（@claude-code，moerasermax 指示）
- **README 新增「alias 重新指向」章節**：補上內建 alias 對照表、`config.json` 的 `aliasModel`
  與 `set_config` 用法、「為什麼免 rebuild 免重啟」的原因、驗證為何從嚴（catch-all 的
  `matchesModel` 會靜默吃掉打錯的 model），以及 antigravity 不吃 `--model`、模型自報名稱
  不可信這兩個已知限制。（Claude）

### 變更
- **ultra alias 的預設指向**：`codex-ultra` 由 `gpt-5.5` 改為 `gpt-5.6-sol`；
  `agy-ultra` / `antigravity-ultra` 由 `agy-default` 改為 `Gemini 3.1 Pro (High)`。
  後者僅影響 `models` 的回報 —— agy CLI 不接受 `--model`，實際模型仍由登入帳號的
  Google AI tier 決定。（Claude，moerasermax 指示）

### 移除
- **OpenCode agent 與 `oc-*` model routing（破壞性）**：`src/agents/opencode.ts` 連同
  `OPENCODE_CLI_NAME` 環境變數與 `oc-` 前綴路由一併移除，改由 direct-api 直接打 vendor API。
  動機是 OpenCode 在大 context 累積後會出現 Qwen tool call 的 doom loop。
  對外影響：原本傳 `oc-<model>` 的呼叫端會失敗（該名稱不再被任何非 fallback agent 認得）。（@codex）
- **`verify-equivalence.mjs`**：它比對的是「新 dist vs 舊 `ai-cli-mcp-patched/` 的 dist」，
  而該路徑早已不存在，任何人跑它都必定 `ERR_MODULE_NOT_FOUND`。等價性驗證的階段性任務已結束，
  留著只會讓「跑一輪全部 `verify-*`」的人踩雷。（Claude）

### 修正
- **`set_config` 的 `__proto__` 與空 map 會靜默假成功**：`readStringMap` 用普通 `{}` 收結果，
  `out['__proto__'] = '<字串>'` 會打到 `Object.prototype` 的 setter 並被無聲丟棄，
  該 key 根本不會成為 own property → 後面的 alias 驗證迴圈掃不到 → 呼叫端拿到「成功」
  但什麼都沒設定。同理 `alias_model: {}` 也能通過「Nothing to change」檢查後空跑一趟。
  改為以 `Object.create(null)` 收集（`__proto__` 會變成正常的 own property 而被 alias 驗證擋下），
  並明確拒絕空 map。這是先前 prototype key 稽核（改用 `hasOwnProperty`）漏掉的同族案例。（Claude）
- **`verify-rate.mjs` 失敗時不會回傳非零 exit code**：它只印一行 `UNEXPECTED` 就正常結束，
  被 `&&` 串在 `npm test` 裡等於 rate 邏輯回歸也測不出來（CHANGELOG 3.1.0 對這支腳本
  「任一支失敗即中止」的描述因此並不成立）。改為失敗時設 `process.exitCode = 1`。（Claude）
- **`npm test` 可能測到過期的 `dist`**：測試載入的是 `dist/`，但 `test` script 不會先編譯，
  只改 `src` 的話會測到舊 build（而 `dist/` 被 gitignore，乾淨 clone 則直接缺模組）。
  新增 `pretest: npm run build`。（Claude）
- **`verify-alias-config.mjs` 的設定檔還原不夠可靠**：還原只寫在正常流程末端，
  任何例外（import / spawn / JSON parse 失敗）都會讓使用者的 `config.json` 停在測試中途狀態；
  原本沒有 `config.json` 的機器跑完會被留下一份測試產物；父目錄不存在時會 `ENOENT`。
  改為 `try/finally` 無條件還原、原檔不存在就刪掉、寫入前建父目錄。
  另把端到端那段改成不沿用使用者的 `baseConfig`，斷言才不會被使用者自己的
  `defaultReasoningEffort` 影響。（Claude）
- **`verify-mcp.mjs` 只檢查 9 個工具**：漏掉 `set_config` 與 `query_usage`，
  輸出還寫死「all 9」。改為檢查全部 11 個。（Claude）
- **`package-lock.json` 的版本停在 3.0.0**：與 `package.json` 不一致，一併同步。（Claude）
- **設定檔快取會漏掉「同一毫秒內的第二次寫入」**：`loadUserConfig()` 原本用 mtime 當快取鍵，
  但 mtime 的解析度不足以區分同一毫秒內的兩次寫入 —— 先讀一次（快取住 mtime M）→ 同一毫秒內
  檔案被改寫（新 mtime 仍是 M）→ 之後會**一路回傳過期設定**，直到有人再動一次這個檔。
  `updateUserConfig()` 只作廢自己這個 process 的快取，擋不到別的 process 或使用者手動編輯。
  改為每次讀檔、以**檔案內容**當快取鍵（設定檔只有幾百 bytes，快取存在的意義只剩省下 JSON 解析）。
  發現經過：把 `verify-alias-config.mjs` 納入 `npm test` 後，它從單獨跑必過變成在測試串裡穩定失敗
  3 項 —— 前面的腳本讓 node 暖機，兩次寫入因此落在同一毫秒。回歸測試用 `utimesSync` 把兩次寫入的
  mtime 直接鎖成同一個值，讓這個競態變成必然而非碰運氣。（Claude）
- **Codex 額度查詢完全失準修復**：`query_usage` 的 codex 一直回傳垃圾值（`percentUsed:100`、`numbers:[1,2,1,2]`）。
  根因有二：(1) 原本沿用通用 `PtyUsageProvider`，固定 1500ms 送 `/status`、6500ms 就 kill；但 codex 啟動會
  boot MCP servers，model 框先閃現真實模型再退回 `loading`，數秒後才穩定，導致 `/status` 被吃掉、面板根本來不及
  渲染就被砍。(2) `parseCodexUsage` 只做寬鬆數字擷取，未解析「5h limit / Weekly limit」面板，也沒處理 codex 的
  **`% left`（剩餘）語意**。改法：新增專屬 `CodexUsageProvider`，以輸出靜止（quiescence）偵測就緒後才送 `/status`、
  面板未出現時依「距上次送出」重試、面板出現後等輸出靜止再擷取，逾時上限放寬至 60s；`parseCodexUsage` 改為結構化解析
  `account/plan/model` 與 `fiveHour/weekly` 的 `{percentRemaining, percentUsed, basis, resetAt}`，同時相容新版
  `% left` 與舊版 `% used`、窄終端 reset 換行、`0% left` 與無方案括號等邊界。另把 settle 的 kill 強化為 Windows
  tree-kill（`taskkill /T /F`），避免 codex fork 出的 MCP server 子程序殘留為 orphan。實測端到端約 7 秒拿到正確
  數據（5h/weekly 剩餘百分比與 reset 時間）。（@claude-code 主導；格式邊界由 @codex-gpt-5.5 提供、程式碼由
  @gemini-3.1-pro 與 @kiro 獨立審查，moerasermax 指示）
- **Qwen tool call 相容性**：direct-api 新增 XML 格式 tool call 的 fallback 解析器，
  處理 Qwen 不照 OpenAI JSON tool call 格式輸出的情況。（@codex）
- **Windows `cmd.exe /s /c` 外層引號**：含空白的 prompt 在 MCP 路徑會被 cmd.exe 重新切詞，
  改為明確的 `/d /s /c` 加引號包裝。（@codex）
- **Windows detached wrapper 的 `shell:true`**：CLI detached 路徑下，含斜線的 model 參數
  （當時的 `oc-*`）會被 shell 重新解讀而壞掉。（@codex）

## [3.1.0] - 2026-05-31

### 新增
- **AI 啟動熔斷器（circuit breaker）**：新增 `src/core/circuit-breaker.ts`，在啟動子程序前偵測
  框架無窮迴圈的兩種特徵——「滑動視窗內爆量啟動（rate）」與「重複送出同一 agent + prompt
  （duplicate）」。觸發後開路冷卻、擋下新啟動並回傳清楚錯誤，冷卻結束自動恢復。目的是避免框架
  bug 造成對 AI 供應商的異常流量，被誤判為共用帳號或濫用而違規。門檻全可由 `AI_CLI_BREAKER_*`
  環境變數調整，預設保守。已接入 `ProcessService`（MCP 路徑）與 `FileProcessService`（CLI 路徑），
  並在 `app/mcp.ts` 的 `run` 工具回傳專屬錯誤訊息。附驗證腳本 `verify-breaker.mjs`。（@moerasermax）
- **`query_usage` MCP 工具**：查詢各 AI CLI（Kiro / Claude / Codex / Antigravity）剩餘額度，
  結果快取 120 秒，可用 `refresh=true` 強制更新；新增 `src/plugins/usage-service.ts`。（@moerasermax）
- **共同維護準則**：新增 `CONTRIBUTING.md` 與本 `CHANGELOG.md`，確立「誰改了什麼要留紀錄」的流程。（@moerasermax）

### 修正
- **claude 長中文 prompt 被截斷**：`src/agents/claude.ts` 將 prompt 從命令列參數 `-p <prompt>`
  改為走 stdin（保留 `-p` 旗標）。Windows 下 claude 是 npm `.CMD` shim，spawn 需 `shell:true`，
  cmd.exe 會對含空白/換行/全形標點的長 prompt 重新切詞並在換行處截斷；比照 codex 走 stdin 即可繞過。（@moerasermax）

## [3.0.0] - 2026-05-30（既有基準）

### 新增
- 自有可控的 ai-cli-mcp 框架，採 registry-based 架構：新增 AI agent 只需新增一個檔案。
  支援 Claude / Codex / Antigravity(agy) / Kiro / Forge / OpenCode，背景 job 管理，
  MCP 與 CLI 雙路徑。

### 修正
- Windows 上優先解析 `.cmd`/`.exe` 而非 extensionless shim。
- 移除已壞掉的 gemini 殘留；usage 外掛路徑改由 `AI_CLI_USAGE_PLUGIN_BIN` 環境變數設定。

[Unreleased]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v6.2.0...HEAD
[6.2.0]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v6.1.1...v6.2.0
[6.1.1]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v6.1.0...v6.1.1
[6.1.0]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v6.0.0...v6.1.0
[6.0.0]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v5.0.0...v6.0.0
[5.0.0]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v4.1.2...v5.0.0
[4.1.2]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v4.1.1...v4.1.2
[4.1.1]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v4.1.0...v4.1.1
[4.1.0]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/moerasermax/tkflyc-ai-cli/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/moerasermax/tkflyc-ai-cli/releases/tag/v3.0.0
