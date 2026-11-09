# 跨行程名額與測試鎖

CLI 核准、接回與觸發開工共用跨行程 admission。預設全機三個 run，硬上限三個；暫停／等待人工仍佔名額，一般 awaiting_approval 不佔；已取得舊版 active.lock 的 awaiting_approval 是例外。被名額、repo 或額度條件擋下會直接回報原因及佔用 run，沒有等待開工的佇列；排程沿用 skipped 與觸發帳本記錄。

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

新版只要有名額，就維持舊格式 `active.lock`（`{runId, at}`）作為相容標記，而且 runId **一律指向一個新版名額**，不指向舊版 run（G2，c646 交付後獨立稽核）。理由：舊版釋放是「標記的 runId 等於自己就刪」，標記若沿用舊版 run L，L 結束時就會刪掉它，新版名額還在、舊版 launcher 卻能用 wx 取得並開跑，不受名額、同 repo、額度閘門限制。發現舊版 run 持有標記時，新版把 L 另記成 `active-runs/<runId>.legacy.json`（檔名刻意不符合新版名額格式），admission 用這筆紀錄獨立計數 L：算進硬上限與同 repo 判斷；L 的 repo 判斷不了（例如 develop 的 repoRoot 不是 git repo）時，保守當成和每個 repo 都同 repo——舊版本來就只允許全機一個 run，這樣擋不會比舊版寬。L 終止或 run 目錄不存在時，紀錄在下一次 admission 或最後一個新版名額釋放時回收（在那之前 status／activeRuns 也不再列出它）；新版接回 L 時，L 換成新版名額，紀錄刪除。沒有任何新版名額時，標記可以繼續指向仍在跑的 L，不去動它；最後一個新版名額釋放時，若還有活著的 legacy 紀錄，標記改回指向它，讓 L 結束時由舊版自然刪除。

建立使用 wx。改指向**不直接覆寫**：先把現有標記 rename 到旁邊取出內容，再用 wx 建立新標記，寫完重讀確認；wx 撞到 EEXIST 或重讀不符就再來一輪。理由：直接覆寫可能蓋掉舊版剛用 wx 取得的鎖，而「寫完重讀」本身看不到被蓋掉的那一份。任何被取出、又不是新版名額的活 run（包括在讀與搬之間才用 wx 搶到的舊版 launcher）都記成 legacy 紀錄，不會遺失。代價是 rename 與 wx 之間標記短暫不存在，舊版 launcher 剛好在這個窗口取得時會照舊版邏輯開跑，但下一輪就被取出並記成 legacy 紀錄而計數。建立、改指向、刪除均在 admission 跨行程臨界區內。runner 結束、實際 cancel、失效名額回收與核准 start 回呼失敗都協調釋放；標記指向被釋放 run 時，有其他名額則改指向，最後一個名額釋放時連同指向已終止或不存在 run 的過期標記一起回收（G2a；過去釋放時保留這種標記，舊版會一直被擋到下一次新版 admission）。舊版 releaseActiveLock 可能刪掉標記，下一次新版取得（包含被閘門拒絕）或釋放名額時會補回。核准取得名額後 runner 啟動失敗（launcher 結束碼非 0 或 20 秒內沒起來）時，先在 admission 臨界區確認沒有 runner 已認領，再釋放名額並丟出原錯誤；run 留在 running、沒有 runner，即 interrupted，可再 approve 接回。晚到的 runner 由 `claimRunnerSlot` 在同一臨界區擋下，所以不會超額進場（G3）。每個 run 原有 `runner-lock.ts` 保持原樣。

標記 runId 已有新版名額檔時只計一次；沒有名額檔才當作真正的舊版佔用。舊版先建立 active.lock 才寫 approved，因此指向 `awaiting_approval` 的舊鎖必須保留並阻擋新版取得名額，錯誤包含 runId 及 `ai-cli kernel cancel <runId>` 提示；請用實際 cancel 釋放，不要手動刪鎖。例外：同一次協調已經取出一個活著的舊版 run 之後才出現的 awaiting_approval 標記，照樣取出並記成 legacy 紀錄，否則前一個被取出的舊版 run 會失去標記保護。標記指向**正在核准的這個 run 自己**、而它沒有名額檔時，當成新版寫好標記、寫名額檔前當掉的殘留處理，照常放行（G2b）；過去會誤判成「舊版正在核准」而永遠擋住。代價是舊版與新版同時核准同一個 run 時，名額這一層不再互擋；舊版先寫入 approved 的話，新版 start 回呼的日誌序號檢查會拒絕，新版先寫入時舊版那邊怎麼處理沒有實測。不存在或已結束的舊 run 可回收。單純建立尚未核准的委任書仍不佔名額。

更新 dist 後，既有 session 的 MCP server 在重啟前仍跑舊程式，不能假設更新檔案就已切換。新版以 active.lock 讓舊程式的 wx 取得直接拒絕，避免舊程式看不到新版名額而另開 run；重啟舊 session 的 MCP server 後才會改用新版並行。不要手動移除相容標記。程序身分只快取有 started 的成功查詢；失敗／空 started 當次沿用原本回退方式，下次重查，避免暫時失敗永久污染身分快取。

所有 setupCommand、testCommand 共用全機 `test.lock`，contextCommand 不受這道測試互斥限制。等待期間日誌記錄 `test_lock_wait`／`test_lock_acquired`，status 顯示「等測試鎖（被 <runId> 佔用）」；等待時間不列入命令或 active wall-clock 預算。等待仍可取消。鎖保存 runner 與命令監督程序的 PID／建立時間；runner 死掉而監督程序仍活著時仍保留鎖，確認命令停止後才釋放／回收。PID 存在但身分查不到時保守保留。監督程序先等 runner 將 PID 寫入鎖與日誌才執行命令，開工信號不作為命令 stdin。Windows 監督程序使用 detached console，避免父 runner 退出後監督程序跟著消失而實際命令仍活著。命令身分更新與釋放同樣經過跨行程臨界區，延遲的身分查詢不能覆寫後來持有者的鎖。

F2（5579 交付後獨立稽核）將 15 秒協調忙碌逾時改為 `ProcessMutexBusy`，以型別識別，不比對文字。測試鎖等待遇忙碌仍視為等待，每輪檢查取消／fencing，其他錯誤照常上拋。租約輪詢間隔為 1 秒；同 token／同命令身分先用既有 `mayBeAlive`（kill(0)）確認存活，完整身分查詢最多每 30 秒一次。token 或命令身分變更立即完整查詢；死亡下一輪即可回收，PID 重用最晚下一次完整查詢識別。

`command()`、`release()`／停止後清理及 runner 的 `claimRunnerSlot()`，對協調忙碌最多嘗試三次，每次 mutex 協調等待上限 15 秒、重試間隔 1 秒；不重試其他錯誤。command 與 claim 耗盡後上拋，claim 每次仍在 admission 臨界區檢查名額 fence。release 耗盡則寫 `test_lock_release_deferred` journal，避免 finally 的忙碌覆蓋已通過測試；租約的 command 身分屬於已停止的測試命令，其他 run 可確認死亡後回收。所有權已變動的既有檢查保持：延遲 command 不能覆寫後來持有者，release 也不能刪除他人的 token。短臨界區內 bakery ticket 的輕量輪詢維持既有行為，1 秒間隔適用於測試租約等待與協調重試。

名額釋放（G1，c646 交付後獨立稽核）同樣走有限重試：`releaseRunSlot` 經 `retryProcessMutex`，最多三次、間隔 1 秒。仍忙碌時 `releaseActiveLock` 只寫 `slot_release_failed` journal 並回傳 false，不丟出；這個事件不是 state，replay 不讀它，終止狀態維持原樣。runner 收尾在 `runner-settle.ts`：只有 loop 丟出的程式錯誤才寫 `failed／kernel_error`，釋放名額在結果之外，所以已交付的 run 不會因釋放忙碌變成失敗，runner 照常 exit 0。留下的名額檔指向已終止 run，下一次 admission（含同 repo）會回收。cancel 在 run 已寫成 cancelled 後釋放忙碌，仍回 cancelled，detail 附說明。

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
| F1 | 以 journal.acquireActiveLock 模擬舊版；新版標記阻擋舊版、最後釋放後可取得；舊 awaiting_approval 保留與真 cancel；wx 競爭保留舊贏家；三名額去重、釋放改指向、標記補回、釋放等待 admission 臨界區、start 失敗回滾 |
| F3 | 可控查詢第一次缺失／空 started／reject、第二次成功、第三次命中成功快取；不透過環境變數變更正式行為 |
| F2 | 注入型別化忙碌／時鐘／身分查詢：等鎖持續及停止、release 不覆蓋通過結果且記 journal、command 與 runner claim 三次上限、不吞其他錯誤、所有權保護；61 秒等待只完整查詢三次、每輪 kill(0)、死亡下一輪回收、token／命令身分換人即查、PID 重用最晚 30 秒查出 |
| G2 | 以 journal.acquireActiveLock 加測試內的「runId 相同就刪」模擬舊版：舊版 run 持鎖時新版放行後，舊版釋放刪不掉標記、舊版 launcher 仍被擋，legacy 紀錄在舊 run 終止後回收；legacy 紀錄計入硬上限與同 repo，repo 判斷不了時擋所有 repo，沒有新版名額時標記改回指向它（G2 兩組）；最後釋放回收指向已終止／不存在 run 的標記（G2a）；標記指向自己且無名額檔時照常放行（G2b）；在讀與搬之間用 wx 搶到的舊版 launcher 被記成 legacy 紀錄而不是被覆寫（G2c） |
| G4 | e2e 以 `CLAUDE_CLI_NAME` 指向執行期產生在暫存目錄的替身（立刻結束，額度查詢得到「量不到」），PATH 最前面另放一個同名誘餌；結束時斷言替身有被呼叫、誘餌一次都沒有。kernel source 測試與 concurrency 測試也經 `tests/helpers/claude-quota-stub.mjs` 把 `CLAUDE_CLI_NAME` 指向替身；它們的額度都已注入，替身只是防線，不斷言呼叫次數 |
| G1、G3 | 注入釋放忙碌（含真 admission 票券＋快轉時鐘）：completed／failed／cancelled 維持原狀態、journal 一筆 `slot_release_failed`、同 repo 下一次 admission 回收殘留名額；loop 程式錯誤才是 kernel_error，非忙碌的釋放錯誤上拋但不改寫狀態；cancel 忙碌仍回 cancelled 並附說明；`deps.launch` 失敗釋放名額、interrupted 可接回、晚到 runner 被擋、已認領 runner 保留名額、釋放忙碌不蓋掉啟動錯誤 |

F1／F3 既有驗證（01816dc，非此次重跑）：`tsc --noEmit` 通過；concurrency source 完整 24 組通過，最後新增的 wx 競態組另以定向選取通過；既有 kernel source 測試為 762 passed、0 failed。`tools/mutations.json` 新增的 11 筆 `kernel F1F3：` 與調整片段後的兩筆既有 D 段突變（舊鎖計數、死亡核准程序回收），均在 repo 外隔離快照編譯成功並由對應 expect 斷言抓到；原始 log 不進 repo。本段未重建工作區 dist、未執行正式 npm test，最終驗收交由 kernel。

上述程序生命週期實測環境是 Windows／Node 24；其他平台、支援範圍內較舊 Node、強制只殺監督程序而留下其子行程，以及斷電後的磁碟持久性尚待驗證。source 測試不等於 kernel 重建後執行固定 `npm test` 的最終驗收。

F2 本次來源驗證：TypeScript `--noEmit` 通過，concurrency 完整 31 組通過（含既有 F1/F3 與真子程序死亡回收）。F2/F4 定向突變與 helper 限制、既有／此次結果區分見 [d-coverage.md](d-coverage.md)。未重建 live dist；固定 npm test 留由 kernel 驗收。
