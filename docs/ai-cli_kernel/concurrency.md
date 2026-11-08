# 跨行程名額與測試鎖

CLI 核准、接回與觸發開工共用跨行程 admission。預設全機三個 run，硬上限三個；暫停／等待人工仍佔名額，awaiting_approval 不佔。被名額、repo 或額度條件擋下會直接回報原因及佔用 run，沒有等待開工的佇列；排程沿用 skipped 與觸發帳本記錄。

人可編輯本機 `<AI_CLI_STATE_DIR>/kernel/concurrency.json`（未指定 state dir 時為 `~/.local/state/ai-cli/kernel/concurrency.json`）：

```json
{
  "maxRuns": 3,
  "claudeMinRemainingPercent": 10,
  "codexMinRemainingPercent": 20
}
```

`maxRuns` 僅接受整數 1～3，兩個百分比接受 0～100 的有限數值；缺欄採預設，未知欄或非法值拒絕開工。此檔是人的設定，沒有 MCP 參數或工具可以調整。降低設定或額度不足不會中斷已取得名額的 run，也不會剝奪暫停 run 原本的名額。

取得新名額時重用 UsageService 查詢與快取。Claude 週額度剩餘 **小於** 10% 或未知時，限制全機一個 run；Codex 剩餘 **小於** 20% 或未知時，限制一個用到 Codex 的 run。決策、worker、允許的 worker 模型任一使用 Codex 都計入。Codex 按明示 used／left／remaining basis 換算，Claude `weekAllModelsPercent` 按 `percentBasis: used` 換算；缺漏、無效數字及查詢失敗均按未知處理。

同 repo 的身分以 `git rev-parse --git-common-dir` 加 `realpathSync.native` 判斷，linked worktree 共用一個身分。不同 clone 的 origin 經去除認證資料、query／fragment、transport 差異、結尾斜線與 `.git` 後比較；遠端身分只保存 SHA-256，不將原始 URL 或憑證寫進名額與錯誤。非 git 唯讀目錄使用真實工作路徑。Git 身分查詢錯誤會拒絕開工。

`active-runs/<runId>.json` 保存名額，短臨界區使用獨立行程票券協調檢查與寫入。票券採唯一名稱與完整原子發布；choosing 與編號階段分別只發布一次，讀者取同 ID 的編號階段，避免 Windows 多讀者下覆寫票券的 rename 偶發 EPERM。死行程票券可按行程建立時間身分回收，不會刪到後來持有者的同名鎖。內部協調最長等待 15 秒，超時報忙碌；這不是名額不足時的開工佇列。仍然先建立 run，再取得名額；找不到、已結束、尚未核准的遺留名額會回收。核准程序在 runner 啟動前死掉且沒有未結案動作／檢查時，留下的名額也可回收。runner 進場在同一臨界區確認名額後取得原有每 run 鎖；延遲啟動的 launcher 不能在名額已回收後補開工。被 admission 擋下的觸發 run 留下 cancelled 狀態與 skipped 帳本供對帳，不扣 reserved 次數。

升級時會計入舊 `active.lock`，與新名額按 runId 去重，並在下次 admission 回收不存在、已結束或尚未核准 run 的舊鎖。請讓各入口使用同一版 kernel；此相容處理針對升級時已存在的舊鎖，不能讓仍持續啟動工作的舊二進位理解新名額。每個 run 原有 `runner-lock.ts` 保持原樣。

所有 setupCommand、testCommand 共用全機 `test.lock`，contextCommand 不受這道測試互斥限制。等待期間日誌記錄 `test_lock_wait`／`test_lock_acquired`，status 顯示「等測試鎖（被 <runId> 佔用）」；等待時間不列入命令或 active wall-clock 預算。等待仍可取消。鎖保存 runner 與命令監督程序的 PID／建立時間；runner 死掉而監督程序仍活著時仍保留鎖，確認命令停止後才釋放／回收。PID 存在但身分查不到時保守保留。監督程序先等 runner 將 PID 寫入鎖與日誌才執行命令，開工信號不作為命令 stdin。Windows 監督程序使用 detached console，避免父 runner 退出後監督程序跟著消失而實際命令仍活著。命令身分更新與釋放同樣經過跨行程臨界區，延遲的身分查詢不能覆寫後來持有者的鎖。

`status.active` 維持 `string|null`，代表排序最前的佔名額 run。新增 `activeRuns`，每筆含 `runId`、`repo`、`models`（decide、worker、allowedWorkers）與 `acquiredAt`。dashboard 顯示全部佔用者；`actions --json` 保留陣列及原操作欄位，每個操作額外附 `activeRuns`。

驗證入口：`node --import tsx tests/verify-ai-cli_kernel-concurrency.mjs --source`；已登記於固定 npm test 清單，正式驗收讀 dist。測試以 IPC／檔案屏障同步多個真實 Node 子行程，使用本機命令與假 workspace，不啟動 vendor CLI。未覆蓋斷電、磁碟損毀、網路檔案系統及多主機共享 state dir；協調設計的適用範圍是同一台機器的本機檔案系統。

| 要求 | 測試證據 |
| --- | --- |
| C1、C5 | 六個獨立程序爭三名額、同 run 並行核准一次；暫停保留、未核准不佔；不存在／結束／死核准程序回收與取消 |
| C2 | 五個獨立程序爭同 repo；真 linked worktree、同 origin 不同 clone、憑證不落盤 |
| C3、C4 | 真多行程未知額度限制；used／remaining、缺漏／無效／失敗、小於門檻邊界；設定 1～3、MCP schema 無調整參數 |
| C6、C7 | 舊鎖計入／去重／回收；阻擋回報原因與持有者；quota 觸發 skipped 帳本、未扣 reserved、未啟動 |
| C8 | 真 setup／test 命令互斥、執行中 tree kill、等待取消、runner 退出但命令存活、死／重用 PID；正式 loop 等待超過命令時限仍成功及失敗／逾時釋放 |
| C9 | status.active 型別、activeRuns、dashboard 畫面與 actions CLI JSON 的既有欄位及全部持有者 |

上述程序生命週期實測環境是 Windows／Node 24；其他平台、支援範圍內較舊 Node、強制只殺監督程序而留下其子行程，以及斷電後的磁碟持久性尚待驗證。source 測試不等於 kernel 重建後執行固定 `npm test` 的最終驗收。
