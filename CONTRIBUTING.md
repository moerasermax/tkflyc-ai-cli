# 共同維護準則（CONTRIBUTING）

這個框架的目標是**開放給所有專案共用**，且每位協作者都有修改權限。正因為共用，
「誰改了什麼、為什麼改」必須留下可追溯的紀錄——這是本準則的核心。

> 一句話原則：**每一次改動，都要在 commit 與 CHANGELOG 留下足夠讓別人看懂的紀錄。**

---

## 1. 改動前

1. 先 `git pull`（或同步最新），避免在舊基礎上改。
2. 較大的功能或會動到 `core/` 框架本體的改動，先在 issue / 討論串說明動機。
3. 從 `master` 切出工作分支：`git checkout -b <type>/<簡述>`，例如 `feat/circuit-breaker`。

## 2. 改動中

- **新增 AI agent**：照 `README.md`「新增一個 AI agent」步驟，只動 `agents/` 與少數註冊點，不要改 `core/`。
- **改框架本體（`core/`）**：影響所有 agent，務必謹慎，並在 PR 描述列出影響範圍。
- 維持既有風格：繁體中文註解、檔頭用區塊註解說明該檔職責、對外行為改動要標註。
- 改完一定要能編譯：`npm run build`（或 `npm run typecheck`）必須零錯誤。
- 驗證腳本都在 `tests/`（`tests/verify-*.mjs`）；新功能盡量補一支放這裡。每支用相對路徑往上一層讀 `dist/`、`src/`、`tools/`，新增時照抄既有那行 `const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))` 即可。
- 有對應的驗證腳本時，跑過確認通過。
- `npm test` 串起十六支驗證腳本（breaker / rate / direct-api / extra-body / alias-config / catalog-source / agy-parse / usage-parse / job-usage / exec-contract / mcp-capabilities / mcp-system-prompt / mcp / liveness / update / mutation-manifest），都不會打真實 AI 供應商或真實 origin。
- `verify-catalog-source.mjs` 涵蓋非同步查詢、單飛、10 分鐘 TTL、30 天磁碟快取及 agy 的逾時／stderr／kill；`verify-mcp.mjs` 對三個入口驗冷啟動 `tools/list < 1 秒` 與 `models` 等待規則。兩支自建暫存快取並使用 `tools/stubs/agy-models-*`，不連真實 vendor。
- verify 腳本與突變 harness 載入 `tools/stubs/catalog-test-env.mjs`，隔離 config.json、providers、catalog-cache 與狀態，並設定 `AI_CLI_AUTO_UPDATE=off`、git 只允許 file 協定。alias-config 單跑也會自行載入，不碰使用者目錄。
- `verify-update.mjs` 只在暫存 bare origin + A/B clone 內開啟更新；`AI_CLI_UPDATE_REPO_ROOT` 僅供測試，不要用來覆寫正式安裝。
- `verify-liveness.mjs` 用 `tools/stubs/slow-agent` 驗證 MCP / file 跨行程 liveness、wait 逾時回傳、CLI exit 3 與 lost 對照組；暫存檔放 repo 的 `dist/`。
- **修完 bug 請順手加一個突變**到 `tools/mutations.json`：把修補改壞、確認對應斷言真的會 FAIL。
  **片段（`from`）必須從當前原始碼取出、而且在該檔案裡只命中一處**——`mutation-test.mjs` 用的是
  `String.replace`，只換第一個命中，片段出現兩次時改到哪一處取決於檔案順序，那筆突變驗的就不是
  你以為的那一段。手寫片段也不要：2026-10-03 查出 5 筆長期套用不上（4 筆含 CRLF、1 筆被重構掉），
  而它們只在有人跑 harness 時才會露面。`verify-mutation-manifest.mjs` 現在把這兩件事納入 `npm test`。
  這個專案已經吃過三次假綠燈的虧（測試看起來在測、其實測不到）。用法見 `tools/mutation-test.mjs` 檔頭。
  新更新突變可用 `node tools/mutation-test.mjs --script verify-update.mjs` 單獨執行，基準必須先全綠。
  不給 worktree 路徑時，harness 會自己在系統暫存目錄建一個（測的是 **HEAD**，未 commit 的改動不在裡面），
  結束時自動照下面的順序收掉並驗證主 repo 的 `node_modules`；收不掉時會印出手動步驟並以非零碼結束。
- Windows 突變 worktree 收尾時，**先刪 `node_modules` junction 本身，再刪 worktree 目錄**；不可用 `git worktree remove --force` 穿過 junction，否則可能誤刪主 repo 的相依套件。
  唯一可靠的刪法是 PowerShell 的 `(Get-Item <junction> -Force).Delete()`——它只解除連結。
  **`Remove-Item -Recurse -Force` 與 `git worktree remove --force` 都會穿透**，
  2026-09-08 連續踩了兩次，主 repo 的 `node_modules/.bin` 被清空、`tsc` 消失、`npm test` 當場失敗
  （復原：`npm install --ignore-scripts --no-audit --no-fund`）。順序是：
  `(Get-Item ...).Delete()` → `git worktree remove` → `git worktree prune`。
- `verify-e2e.mjs` 會真的呼叫 claude / codex / agy 三家 CLI、消耗額度，**刻意不放進 `npm test`**，
  只在需要驗證端到端行為時手動跑。

## 3. 改動的紀錄（最重要）

每一次改動都要在**兩個地方**留痕，缺一不可：

### 3.1 Commit message —— 採 Conventional Commits

格式：`<type>(<scope>): <用繁體中文寫的簡述>`

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 重構，不改對外行為 |
| `docs` | 只改文件 |
| `chore` | 雜項（建置、相依、設定） |
| `test` | 測試/驗證腳本 |

範例：`feat(core): 新增 AI 啟動熔斷器，避免框架迴圈造成供應商誤判`

commit 內文（body）說明**為什麼這樣改**，而不只是改了什麼。

### 3.2 CHANGELOG.md

- 所有「使用者/協作者看得到的行為變化」都要在 `CHANGELOG.md` 的 `[Unreleased]` 區段補一行。
- 格式採 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)：分 `新增 / 變更 / 修正 / 移除`。
- 每筆結尾用括號標註作者，例如：`（@moerasermax）`，方便日後追責任人。
- 發版時把 `[Unreleased]` 的內容歸到新的版本號與日期下。

> 為什麼要這麼嚴格：這個框架被多個專案、多位協作者共用，少了紀錄，
> 一旦某次改動引發問題（尤其是 `core/` 的改動），就很難回溯是誰、為什麼改的。

## 4. 版本號（SemVer）

`package.json` 的 `version` 遵循語意化版本：

- **MAJOR**：破壞性變更（對外 MCP 行為或介面不相容）。
- **MINOR**：新增向後相容的功能（如新 agent、新工具、熔斷器）。
- **PATCH**：向後相容的修正。

## 5. 送出改動

1. `npm run build` 通過、相關 `verify-*.mjs` 通過。
2. commit（遵循 §3.1）、push 分支。
3. 開 PR，描述：**動機 / 改了什麼 / 影響範圍 / 如何驗證**。
4. 動到 `core/` 的 PR 至少要有一位其他協作者 review。
5. **push 到 master 會被所有機器自動拉下來**，等同部署；push 前必須 `npm test` 全綠。

### 5.1 目前的實況與替代做法（2026-09-08 補）

上面 2–4 寫的是理想流程，**實際上不是這樣跑的**：至今 200 個 commit 裡只有 4 個經過 PR，
其餘直接進 master。維護者只有一人，開一個只有自己能 merge 的 PR 是形式，不是審查。

與其留一份沒人照做的規定，這裡寫下**真正在執行的規則**——動到 `core/` 時，
下列三件事一件都不能少，缺任何一件就不准 push：

- **獨立稽核**：派一個沒有寫這段程式碼的 agent（`mcp__ai-cli__run`）讀實作原始碼審查，
  不是自己 review 自己。稽核意見要**逐條實測確認成立才修**，不成立的要說明為什麼。
- **稽核結果進 CHANGELOG**：由誰稽核、找到什麼、修了什麼、哪幾條判定不成立。
  看不到稽核紀錄的 core 改動，等同沒稽核過。
- **突變測試**：修完 bug 補一個對應突變（§2），確認新斷言真的殺得掉那個 bug。
  測試全綠不算數，要證明測試沒在假綠燈。

2–4 仍適用於**有第二位人類協作者參與**的情況。單人作業時走上面這條。

## 6. 不要提交的東西

`dist/`、`node_modules/`、`.env*`、各種 `*.log` 已在 `.gitignore`。
請勿提交個人路徑、token、帳號憑證。
