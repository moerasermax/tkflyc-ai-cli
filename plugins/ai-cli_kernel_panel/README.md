# ai-cli_kernel_panel

Claude Code 的正式 kernel 控制面板 plugin，版本 **0.1.0**。使用 CLI 取得資料與操作，不新增 MCP 工具，也不消耗模型 token。

## 使用

- `/kernel`：執行 `ai-cli kernel dashboard --new-tab`，直接開新的 Terminal 分頁顯示完整面板，成功回覆「已在新分頁打開」。目前 CLI 的新分頁功能需要 Windows Terminal；失敗時會完整顯示 stdout、stderr、退出碼與可貼上的備援指令，亦可使用側邊面板。
- `/kernel side`：在目前 session 開啟並聚焦嵌入式側邊面板；保留 run 選取、狀態與進度、報告預覽、操作與兩步確認。未知參數只回用法。
- 側邊面板有執行中的 run 時每 5 秒更新，閒置每 30 秒更新。新版 `status.activeRuns` 顯示所有佔用者；空陣列仍顯示沒有，只有欄位不存在的舊版才使用 `status.active`。

## 必要環境與最低功能需求

需要支援 `hooks.json` 的 `modules`、`command.run`、`$.process.run`、`$.ui.open` 與 Pane/Button 的 Claude Code。使用前可執行下方 validate/test 核對目前 CLI。需要 Node（與 ai-cli 相同，`^20.19.0 || >=22.12.0`）以及已建置的 ai-cli 原始碼 repo。

不猜測 npm 最低版本：本 repo 的 `package.json` 是 7.0.0，但發版文件註明尚未發佈。請以已建置來源實際支援以下功能核對，舊的 npm 發行版不能只看版號推定相容：

```text
ai-cli kernel status --json
ai-cli kernel actions <run-id> --json
ai-cli kernel dashboard --new-tab
```

`actions` 必須回傳陣列，每項包含 `id`、`runId`、`label`、`summary`、`warning`、`args`、`commit`、`isRelease`，與本 repo `src/ai-cli_kernel/dashboard-api.ts` 的 `dashboardActions` 一致。status schema 見 `src/ai-cli_kernel/api.ts`，命令入口見 `src/ai-cli_kernel/cli.ts`。plugin 不自行重算 run 操作政策；全域的自動觸發開關仍有獨立確認。

repo 依序定位：

1. `AI_CLI_REPO` 指定的根目錄，檢查 `dist/bin/ai-cli.js` 可讀。
2. 前者未設定或不可讀時，使用家目錄（優先 `USERPROFILE`，其次 `HOME`）下的 `ai-cli-mcp-source`。
3. 兩者均不可用時，顯示嘗試的入口與錯誤，說明設定方式。只有來源但尚未建置也視為不可用。有效但 CLI 版本不支援功能時保留實際 CLI 錯誤，不默默改用別的來源。

PowerShell 設定範例（路徑改成自己的 repo，然後從此環境重啟 Claude Code）：

```powershell
$env:AI_CLI_REPO = 'D:/projects/ai-cli-mcp-source'
```

可用 `AI_CLI_STATE_DIR` 指定 ai-cli 狀態目錄；預設為家目錄下 `.local/state/ai-cli`。執行採參數陣列，路徑空白與 shell 字元不會被插入 shell 指令。worker session 不註冊面板。

## 確認與權限

develop worker 權限等於使用者本人，**未隔離執行**；核准時須看過 CLI 提供的警告與 `--acknowledge-unisolated`。操作先按數字鍵或按鈕進入確認畫面，第一次不執行；按 **y** 才執行，按 n 取消。y 時重新查詢 status 的 commit 及 `actions --json`，commit、操作參數、說明或警告變更就拒絕，必須重新確認。release 維持先 create 再 run，缺少放行 id 不執行、不自動重試；CLI 的原有拒絕條件仍生效。

## 自行安裝與更新

此 repo 使用 `.claude-plugin/marketplace.json`，marketplace 名稱為 `tkflyc-ai-cli`。正式合併並發布到該 repo 後，由使用者自行執行：

```sh
claude plugin marketplace add moerasermax/tkflyc-ai-cli
claude plugin install ai-cli_kernel_panel@tkflyc-ai-cli
```

已加入 marketplace 者可略過 add；更新時執行：

```sh
claude plugin marketplace update tkflyc-ai-cli
claude plugin update ai-cli_kernel_panel@tkflyc-ai-cli
```

安裝／更新後重啟 Claude Code。`ai-cli_kernel_panel` 是刻意保留的名稱；`claude plugin validate` 會警告不是 kebab-case，Claude Code 接受此命名，但 Claude.ai marketplace sync 要求 kebab-case，因此本 plugin 不宣稱可同步到該目錄。

## 開發與維護

**改 plugin 程式要同時調 plugin.json 的 version**，因為已安裝機器依 manifest 版本判斷更新；只 git pull 不會自動改到已安裝的 cache 副本。

```sh
claude plugin validate ./plugins/ai-cli_kernel_panel
claude plugin test ./plugins/ai-cli_kernel_panel
npm test
```

`tests/*.test.ts` 使用 Claude Code 原生測試引擎。`tests/verify-ai-cli_kernel-panel.mjs` 會編譯並執行實際 hook、以真實 kernel 規則產生 actions fixture，透過 `tools/run-tests.mjs` 納入固定 `npm test` 與既有三平台 CI；缺 claude CLI 不會跳過這些核心測試。既有 ai-cli-jobs 原生測試只在 plugin 內，原本並未被 `verify-jobs.mjs` 呼叫，本 plugin 因此另補無 CLI 的 verify 入口。`tsconfig.json` 供標準 TypeScript 編輯器使用，型別檢查需 Claude Code 產生的 `.claude-plugin/types/tsconfig.json`；不把機器產生的 SDK 型別提交到 repo。
