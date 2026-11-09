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

建立使用 wx。標記原本指向新版名額（某個 target，或正在釋放的 run）時，改指向用原子覆蓋，見下方 H1；其餘情況改指向**不直接覆寫**：先把現有標記 rename 到旁邊取出內容，再用 wx 建立新標記，寫完重讀確認；wx 撞到 EEXIST 或重讀不符就再來一輪。理由：直接覆寫可能蓋掉舊版剛用 wx 取得的鎖，而「寫完重讀」本身看不到被蓋掉的那一份。任何被取出、又不是新版名額的活 run（包括在讀與搬之間才用 wx 搶到的舊版 launcher）都記成 legacy 紀錄，不會遺失。代價是 rename 與 wx 之間標記短暫不存在（H1 之後只剩標記指向舊版或不明 run 時才會走這條路），舊版 launcher 剛好在這個窗口取得時會照舊版邏輯開跑，但下一輪就被取出並記成 legacy 紀錄而計數。建立、改指向、刪除均在 admission 跨行程臨界區內。runner 結束、實際 cancel、失效名額回收與核准 start 回呼失敗都協調釋放；標記指向被釋放 run 時，有其他名額則改指向，最後一個名額釋放時連同指向已終止或不存在 run 的過期標記一起回收（G2a；過去釋放時保留這種標記，舊版會一直被擋到下一次新版 admission）。舊版 releaseActiveLock 可能刪掉標記，下一次新版取得（包含被閘門拒絕）或釋放名額時會補回。核准取得名額後 runner 啟動失敗（launcher 結束碼非 0 或 20 秒內沒起來）時，先在 admission 臨界區確認沒有 runner 已認領，再釋放名額並丟出原錯誤；run 留在 running、沒有 runner，即 interrupted，可再 approve 接回。晚到的 runner 由 `claimRunnerSlot` 在同一臨界區擋下，所以不會超額進場（G3）。每個 run 原有 `runner-lock.ts` 保持原樣。

標記 runId 已有新版名額檔時只計一次；沒有名額檔才當作真正的舊版佔用。舊版先建立 active.lock 才寫 approved，因此指向 `awaiting_approval` 的舊鎖必須保留並阻擋新版取得名額，錯誤包含 runId 及 `ai-cli kernel cancel <runId>` 提示；請用實際 cancel 釋放，不要手動刪鎖。例外：同一次協調已經取出一個活著的舊版 run 之後才出現的 awaiting_approval 標記，照樣取出並記成 legacy 紀錄，否則前一個被取出的舊版 run 會失去標記保護。標記指向**正在核准的這個 run 自己**、而它沒有名額檔時，當成新版寫好標記、寫名額檔前當掉的殘留處理，照常放行（G2b）；過去會誤判成「舊版正在核准」而永遠擋住。代價是舊版與新版同時核准同一個 run 時，名額這一層不再互擋；舊版先寫入 approved 的話，新版 start 回呼的日誌序號檢查會拒絕，新版先寫入時舊版那邊怎麼處理沒有實測。不存在或已結束的舊 run 可回收。單純建立尚未核准的委任書仍不佔名額。

H1～H3 來自 8a63 交付後的獨立稽核，處理新舊版 MCP server 共存時 active.lock 的空窗。下面的行為以 `admission.ts`／`runner.ts` 的程式與 `verify-ai-cli_kernel-concurrency.mjs` 的模擬測試為準；**真的有新舊版 MCP server 同時在跑的情境沒有實測。**

**H1：新版名額之間改指向，改用原子覆蓋。** 標記原本指向新版名額（target，或正在釋放的 run）、要改指向另一個新版名額時，`replaceMarker` 在同目錄寫暫存檔（wx、fsync）再 rename 蓋過 `active.lock`，寫完重讀確認，不符就進下一輪協調。理由：過去這種情況也走 take＋put，rename 與 wx 之間 `active.lock` 不存在，舊版 launcher 的 wx 剛好在這個窗口成功就會不受任何 admission 限制開跑。檔案存在時舊版的 wx 贏不了，所以新版覆蓋時 `active.lock` 全程存在，舊版 launcher 不會趁這一步取得。但這**不等於**覆蓋一定不會蓋掉舊版的鎖：舊版釋放是先讀後刪、不經過新版的互斥，它可能在新版寫好暫存檔、rename 之前把標記刪掉，讓另一個舊版 launcher 用 wx 搶到，接著被新版的 rename 蓋掉，見下方「剩餘風險」（I4 更正；8a63 時這裡寫的「覆蓋不會蓋掉舊版的東西，被蓋掉的一定是新版名額的標記」說得太滿）。只有標記指向舊版或不明 run 時才照舊走 take＋put，被取出的活 run 記成 legacy 紀錄，保留 G2c 的保證（不覆寫舊版剛用 wx 取得的鎖）。Windows 上 rename 遇到 EPERM／EBUSY／EACCES（例如防毒或其他程序開著檔案）時重試，最多 20 次、每次間隔約 25 毫秒；仍失敗就丟出 `LegacyMarkerReplaceFailed`（`code` 為 `KERNEL_LEGACY_MARKER_REPLACE_FAILED`），這時 `active.lock` 維持覆蓋前的內容，仍指向新版名額，暫存檔一律清掉。

**H2：runner 定期補回標記。** 舊版釋放是「讀到 runId 等於自己就刪」，先讀後刪不是原子操作：舊版讀完、還沒刪之前，新版剛好把標記改指向新版名額，舊版接著就會把新版的標記刪掉。這是舊版程式本身的問題，新版無法消除，只能縮短沒有標記的時間。新版 runner 開跑後用 `startLegacyMarkerWatch` 每 20 秒呼叫一次 `ensureLegacyMarker`（單飛，上一次沒跑完就跳過；run 結束時停止）。平常只讀 `active.lock` 和名額檔，不進互斥；只有「有新版名額檔，而標記不存在、沒指向新版名額，或指向的名額檔屬於已終止的 run（I1 覆蓋失敗留下的）」時才進 admission 互斥，對仍佔名額的新版 run 用既有協調補回。取互斥的等待上限是 `LEGACY_MARKER_CHECK_WAIT_MS`（500 毫秒，I3），取不到就回 busy、下次再試，不重試、不排隊；其他錯誤只寫一筆 `legacy_marker_check_failed` journal（不是 state 事件，replay 不讀），不丟出，不影響 run 的狀態。在下一次檢查、admission 或釋放名額補回之前，舊版 launcher 仍可能趁空窗開跑，之後被取出並記成 legacy 紀錄。

**H3：catch 路徑的取捨。** `admitRun` 被拒絕時，catch 路徑用 `blockAwaiting=false` 再協調一次標記。如果拒絕的原因是標記指向舊版 `awaiting_approval` 的 run，而還有其他新版名額，這一輪會把標記改指向新版名額，並把該舊版 run 記成 legacy 紀錄。這和前面「指向 awaiting_approval 的舊鎖保留、不刪、不放行」的字面不同，刻意保留，理由有兩個：一是 G2 主規則（有新版名額時標記一定指向新版名額）優先，否則舊版 run 結束時會刪掉標記，留下沒人看守的空窗；二是那個舊版 run 仍以 legacy 紀錄計入硬上限與同 repo，所以沒有任何 run 因此被放行。行為沒改，只補了測試與程式註解。

I1～I5 來自 3a1a（H1～H4）交付後的獨立稽核。依據同樣是 `admission.ts`／`journal.ts`／`process-mutex.ts`／`runner-settle.ts` 的程式與 `verify-ai-cli_kernel-concurrency.mjs` 的模擬測試；**真的新舊版 MCP server 同時在跑仍沒有實測。**

**I1：覆蓋失敗之後的恢復，不退回 take＋put。** H1 時釋放是先刪名額檔、再協調標記。如果原子覆蓋重試耗盡，標記還指向 A，A 的名額檔卻已經刪了；之後的協調認不出 A 是新版 run（它既不是 target 也不在 released 裡），只能走 take＋put，又出現 H1 要消除的空窗。現在**已終止（或 run 目錄不存在）的 run 的名額檔，要等標記改指向別處之後才刪**：協調在 `finally` 呼叫 `dropReleasedSlots`，標記仍指向它就留著，`active.lock` 讀不出來時全部留著。名額檔是「標記指向的是新版 run」唯一能持久留下的證據。留著的名額檔不佔名額：admission、`readActiveRuns` 只算 run 還活著、而且已經過核准的名額。下一次協調會把它們當成 released，照樣走原子覆蓋，改指向成功之後才回收。會做這件事的協調有三種：
- runner 的定期檢查（H2）：標記指向的名額檔屬於已終止的 run 時，也會進互斥處理。
- 下一次 `releaseRunSlot`：所有已終止 run 留下的名額檔都一起算進 released。
- 下一次 `admitRun`：回收過期名額時同樣等標記移走才刪。

還活著的 run（例如 G3 核准後 runner 起不來時的釋放）的名額檔照舊先刪。理由是同一個 runId 若被舊版 launcher 接手（舊版遇到同 runId 的標記直接成功），它必須走 G2c 的 take＋put 記成 legacy 紀錄。`awaiting_approval` 與 abandoned 的名額也照舊直接刪。恢復之前標記仍指向已終止的 A，舊版 launcher 會被擋住，方向是少放、不是多放。如果這時已經沒有任何新版 runner 在跑，要等下一次新版 admission 或釋放才回收（依程式推論，沒有對應測試）。

**I2：釋放時覆蓋失敗不讓 runner 以失敗結束。** `releaseActiveLock` 遇到 `LegacyMarkerReplaceFailed` 時，比照 G1 的忙碌處理：寫一筆 `slot_release_failed` journal（detail 以「名額釋放時 active.lock 改指向重試耗盡」開頭，和忙碌的說明不同）並回傳 false，不丟出。原本這個錯誤會從釋放一路丟到 runner 的 `main`，runner 寫 `runner-crash.log` 並以 exit 1 結束。終止狀態有 G1 的收尾保護、沒有被改寫，但已交付的 run 看起來像 runner 出錯。現在 runner 照常 exit 0；cancel 在 run 已寫成 cancelled 後遇到這種失敗，仍回 cancelled，detail 附覆蓋失敗的說明。`retryProcessMutex` 只重試互斥忙碌，覆蓋失敗不會在互斥層再重試（rename 本身已重試 20 次）；其他錯誤照常丟出。之後由 I1 的協調補上。

**I3：定期檢查取互斥的等待有上限。** `ensureLegacyMarker` 呼叫 `withProcessMutex` 時帶 `maxWaitMs = LEGACY_MARKER_CHECK_WAIT_MS`（500 毫秒）；原本沒帶，用的是預設的 15 秒。runner 的檢查是單飛，所以那 15 秒內這個 run 的定期檢查等於停住。上限從呼叫起算，包含第一次批次身分查詢：查詢超過期限就不等它，PID 還在的 ticket 一律當成活著（只會更容易判忙碌，不會放行不該放的）。取不到就丟 `ProcessMutexBusy`、清掉自己的 ticket，檢查回 busy。不在這個截斷裡的有兩項：自己行程的身分查詢（runner 內第一次成功後就快取），以及等待期間才出現的新 ticket 的身分查詢。所以實際放棄的時間可能略超過 500 毫秒。測試在另一個持有者佔著 admission 互斥時，量到檢查在 1 秒內回 busy，而且沒留下 ticket、沒寫 journal。其他呼叫端（admission、釋放、runner claim）仍是 15 秒加 `retryProcessMutex` 的三次重試。

**I5：同 repo 被舊版 run 擋下時附 cancel 提示。** `admitRun` 以 `same_repo` 拒絕時，擋住它的若有舊版 legacy 紀錄，錯誤訊息逐一附上「可用 ai-cli kernel cancel <runId> 釋放」。理由是 legacy 紀錄只會在該 run 終止或被 cancel 後才回收，使用者看到「同 repo 同時最多一個 run」卻不知道要對哪個 run 做什麼。寫法和「舊版正在核准」的拒絕一致。擋住的是新版名額時不附，因為新版 run 結束會自己釋放。

**剩餘風險：舊版先讀後刪的釋放，可能讓新版覆蓋蓋掉另一個舊版剛取得的鎖。** 稽核找到的交錯如下：
1. 舊版 run O 結束，它的 MCP server 讀到 `active.lock` 指向 O 自己，在刪除前暫停。
2. 新版之後把標記改指向新版名額 A（H1 覆蓋，或 G2 協調）。
3. 新版釋放 A，寫好暫存檔，準備 rename 覆蓋成指向 B。
4. O 恢復，照它先前讀到的結果刪掉 `active.lock`（這時其實指向 A）。
5. 另一個舊版 launcher P 用 wx 搶到 `active.lock`。
6. 新版的 rename 蓋掉 P 的標記。

結果 P 照舊版邏輯開跑，卻沒有新版名額，也沒有 legacy 紀錄，不計入硬上限與同 repo 判斷。要發生需要兩個舊版 run 在同一瞬間撞上：一個剛好在讀與刪之間被新版改指向，另一個剛好在刪除與 rename 之間用 wx 取得。新版無法完全消除，因為舊版的釋放是先讀後刪、不經過新版的 admission 互斥，新版在 rename 前無論再讀幾次，都還是有「讀完到 rename」的窗口。改回 take＋put 也不行，會重新打開 H1 要關掉的空窗，而且那個空窗不需要兩個舊版同時撞上。所有舊版 MCP server 都重開、換成新版之後，就沒有先讀後刪的釋放者，這個風險隨之消失。在那之前，避免在新舊版並存期間同時從多個舊 session 核准 run。這條是依程式與稽核描述推論，沒有測試重現，也沒有實測。

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
| H1 | 新版名額之間改指向時，`active.lock` 全程存在；注入 rename EPERM 時有限重試，持續失敗則丟出 `LegacyMarkerReplaceFailed`，標記維持原指向 |
| H2 | 標記被刪後 `ensureLegacyMarker` 補回並指向新版名額；互斥忙碌回 busy、其他錯誤回 failed 並記 journal，不丟出；標記健康時不進 admission 互斥；`startLegacyMarkerWatch` 會重複檢查直到停止 |
| H3 | 核准被舊版 awaiting_approval 標記拒絕（附 cancel 提示）後，標記改指向既有新版名額、該舊版 run 記成 legacy 紀錄；它仍列在 activeRuns、擋住同 repo 的核准；實際 cancel 並釋放最後一個新版名額後，紀錄與標記都回收 |
| I1 | 注入 rename EPERM 讓釋放的覆蓋失敗：沒有 wx 空窗、標記仍指向 A、A 的名額檔留著但不列在 activeRuns；之後分別由定期檢查（回 repaired）與下一次 admission 恢復，恢復期間舊版 launcher 的 wx 一次都沒成功、至少一次原子覆蓋，標記改指向活著的新版名額後 A 的名額檔被回收；admission 回收時覆蓋失敗也保留名額檔，交給下一次協調 |
| I2 | 覆蓋失敗時 `settleRunnerRun` 仍回 completed、不寫 failed／kernel_error、journal 一筆 `slot_release_failed`；`releaseActiveLock` 回 false；cancel 回 cancelled 且 detail 附覆蓋失敗說明；其他錯誤照常丟出 |
| I3 | 另一個真的持有者佔著 admission 互斥時，`ensureLegacyMarker` 在 1 秒內回 busy，不留 ticket、不寫 journal、run 仍是 running；持有者放開後下一次檢查回 repaired |
| I5 | 被 legacy 紀錄擋下的 same_repo 錯誤含該 runId 的 cancel 提示；被新版名額擋下時不含 cancel；H3 的情境同樣帶提示 |
| 剩餘風險 | 舊版先讀後刪與新版覆蓋交錯、兩個舊版同時撞上的情境**沒有測試**，只是依程式推論 |

I1～I5 另在 `tools/mutations.json` 新增 8 筆 `kernel I1`～`kernel I5` 突變，並調整幾筆既有突變的片段以對應新寫法；這些突變是否實跑過，以該步交付報告為準，本文件這一步沒有跑。

F1／F3 既有驗證（01816dc，非此次重跑）：`tsc --noEmit` 通過；concurrency source 完整 24 組通過，最後新增的 wx 競態組另以定向選取通過；既有 kernel source 測試為 762 passed、0 failed。`tools/mutations.json` 新增的 11 筆 `kernel F1F3：` 與調整片段後的兩筆既有 D 段突變（舊鎖計數、死亡核准程序回收），均在 repo 外隔離快照編譯成功並由對應 expect 斷言抓到；原始 log 不進 repo。本段未重建工作區 dist、未執行正式 npm test，最終驗收交由 kernel。

上述程序生命週期實測環境是 Windows／Node 24；其他平台、支援範圍內較舊 Node、強制只殺監督程序而留下其子行程，以及斷電後的磁碟持久性尚待驗證。source 測試不等於 kernel 重建後執行固定 `npm test` 的最終驗收。

F2 本次來源驗證：TypeScript `--noEmit` 通過，concurrency 完整 31 組通過（含既有 F1/F3 與真子程序死亡回收）。F2/F4 定向突變與 helper 限制、既有／此次結果區分見 [d-coverage.md](d-coverage.md)。未重建 live dist；固定 npm test 留由 kernel 驗收。
