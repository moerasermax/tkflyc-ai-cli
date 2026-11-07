# dashboard 驗收紀錄（2026-11-08）

接續既有 dashboard 核心，補強正式 adapter 與 launcher 的控制流程測試、安全突變及交付文件。此紀錄不代表真人終端機或跨平台已驗收。

## 八項需求與證據

| 需求 | 已觀察的實作與自動化證據 |
|---|---|
| 共用規則與 actions JSON | CLI actions 與畫面皆用 dashboard-rules；JSON 核對 id、label、summary、warning、args、commit、isRelease，並與正式 dashboardActions 比對。無通過測試 commit 不列放行，只有 push 預設分支帶明示旗標。 |
| 互動面板 | 純畫面組裝測試涵蓋寬雙欄／窄單欄、中文與 grapheme、完整長目標、詳情標籤、報告尾端、固定頂部四項與底部提示、resize；控制器涵蓋方向鍵、j/k、f/g、數字、捲動及 Esc。 |
| 確認安全 | 第一次只確認；僅 y 執行，n/Esc 取消，其他鍵忽略；內容放不下時禁 y。固定 run／commit，重新讀取並重算操作。create 得可靠 id 才 run；失敗與結果不明不重試，執行中防重入。 |
| 終端機還原 | 注入終端機測試正常退出、Ctrl+C、SIGINT/SIGTERM、例外、rejection、初始化中途失敗、resize 錯誤；復原 raw／paused、alternate screen／游標，清自身 timer／listener，退出不呼叫取消 run。 |
| 拒絕與 stdout | worker、stdin／stdout 非 TTY 在碰終端機前回非零；實際 CLI 以 pipe 啟動測拒絕。stdout callback 前不回傳，排空失敗回非零。 |
| new-tab | 注入正式 nativeLaunch，驗證 shell:false、含空白路徑的獨立 argv、stdio ignore、逾時與 wt.exe 結束即返回；不遞迴帶 --new-tab。worker 先拒絕，父 launcher 可從 pipe 啟動，新分頁才查 TTY；不支援環境給可貼命令及非零退出碼。 |
| 測試與突變 | 正式 verify 已在 tools/run-tests.mjs 的 TESTS；本次由 27 增為 30 項測試，全部通過。dashboard 突變 13 增為 18 筆，原樣 harness 逐筆編譯、執行完整 dashboard 測試及還原，18 筆皆由指定斷言殺死。 |
| 文件 | CHANGELOG 僅改 Unreleased；教學列按鍵／確認／新分頁；技術手冊說明規則、adapter、刷新、安全、恢復、啟動器與限制。既有中英文 README 的一行 dashboard 入口保留。 |

## 規則來源核對

以 TypeScript AST 列印比較指定來源的 actionsFor、triggerAction、stateHelp、reasonLabel、templateLabel、shortState、stepLabel、chooseRun、progressLine。除 actionsFor 一處外，其餘相同；差異為交付分支本身是遠端預設分支時，補上 --allow-default-branch 與部署警告。perform 沿用確認後執行與 create→run、不重試語義，並強化為所有變更重新查詢／重算操作、綁定完整 commit、核對 release id。來源未修改、未納入 repo。

## 本次實際驗證

- Windows 本機：`npm run build` 零錯誤。
- `node tests/verify-ai-cli_kernel-dashboard.mjs`：30/30 PASS。
- `node tests/verify-mutation-manifest.mjs`：645 筆清單，8/8 健康檢查 PASS；只代表可套用且唯一，不代表 645 筆已實跑。
- `node tests/dashboard-mutations.mjs`：最終測試檔重跑仍為 18/18 KILLED、其他斷言代殺 0、SURVIVED 0、ERROR／BUILD_FAILED 0、原始碼 bytes 還原。原樣 harness 的快照日誌與 result.json 位於 Git 忽略的 `docs/ai-cli_kernel/dashboard-evidence.log/run-xdVNp2/`，包含測試及 harness SHA-256。
- 固定 `npm test`（Windows、Node v24.15.0）：完整執行 34 支，32 PASS／2 FAIL，exit 1，耗時 1625.3 秒；dashboard、kernel E2E、runner、突變清單均 PASS。完整日誌為 `docs/ai-cli_kernel/dashboard-evidence.log/npm-test.log`。此輪不能稱整套驗收通過。

兩支失敗由本次驗證環境造成：為遵守只能在工作目錄內寫入，TEMP／TMP 指到 repo 內的忽略暫存目錄。`verify-principal-process.mjs` 的四個 CommonJS `.js` fixture 繼承 repo 的 ESM package scope，實際報 require 不存在；`verify-ai-cli_kernel.mjs` 的三個「非 git repo」斷言因向上發現本 repo 而失敗。沒有修改這兩支既有測試或產品檢查。

修正驗證環境的方法是只在忽略的暫存根產生 CommonJS package scope，並令 `GIT_CEILING_DIRECTORIES` 指向該暫存根，隔離外層 repo；repo 根的 package.json 與 git 設定均未改。原樣 `node tests/verify-principal-process.mjs` 重跑為 7/7 PASS；另外三個非 repo 條件使用正式 gitSnapshot、buildContract、aiCliKernelMemoryRepo／aiCliKernelMemory 定向重驗，3/3 PASS。日誌為同一證據目錄的 `principal-corrected.log`、`nonrepo-corrected.log`。這是環境原因的定向查證，沒有重跑完整 kernel 主測試或整套 npm test，不能替代 kernel 的固定驗收。

Confidence：上述自動化與突變結果有直接輸出、指定斷言及還原證據，信心高；兩支失敗的環境歸因亦經修正環境後定向重現。整套在正常隔離環境下是否全綠仍待 kernel 確認。

## 合理推論及尚待確認

注入測試避免依賴真實 TTY、wt.exe 或供應商，且不使用特定平台 shell，設計可供三平台執行；這只支持可攜性推論。目前實際執行上述驗證的環境只有 Windows，Linux／macOS 未實跑。

真人 TTY 的全螢幕、字型／Unicode 寬度與還原效果、Windows Terminal 真實新分頁及 Claude Code 的真人啟動流程尚待確認。既有 kernel 只有 Windows 實際使用經驗，不能當成本次 dashboard 已實測。未執行全清單 645 筆突變；本次只跑 dashboard 的 18 筆。固定 npm test 的 kernel 驗收仍由 kernel 獨立執行。
