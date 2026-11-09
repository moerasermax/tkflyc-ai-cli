# F1～F5 最終交付與 e2e 診斷

## 提交與正式驗收

- F1／F3：`01816dcd63d5c1999458ebee9c41e95cffafab31`。
- F2／F4／F5：`629d1ecb65523d89e26fc8e69e268eff00e09424`。
- 本步尚無提交 hash，由 kernel 處理。
- 最新既有 kernel 正式 npm test：38 支中 37 PASS、1 FAIL；失敗的 e2e 內為 86 passed、1 failed，斷言是「核准後開始執行」。本步後正式驗收仍由 kernel 執行，不能宣稱已通過。

## 本步具體修改

原 e2e 保留退出碼、signal、spawn 錯誤、JSON 解析錯誤與單調時鐘耗時。失敗才印結構化診斷，保留原斷言條件：退出碼為 0，狀態屬於既有 running／completed 集合；沒有改逾時、重試或用後續 completed 取代原結果。

診斷串流每項最多保留 2048 字元及省略標記。有效 stdout 只投影 runId／state／effectiveState／reason；無效 JSON 隱去完整引號片段，解析錯誤也隱去引號摘錄。敏感環境變數值及其 JSON／URL 編碼形式、常見憑證賦值、Bearer、常見金鑰樣式會遮蔽；不列印環境、委任書、prompt、context 或 runner token。

狀態證據唯讀，不呼叫會對帳或改動狀態的 CLI。runner／launcher 檔最多讀 16 KiB；journal 只讀最後 16 KiB、最多 12 筆序號／時間／型別／狀態／原因，保留缺檔與解析錯誤。捕獲時間明示為失敗後的觀察，不能用來覆蓋 approve 的退出碼或回傳狀態。

新增回歸完整名稱為 `E2E approval diagnostics preserve process and parse failures with bounded redacted state evidence`。涵蓋非零及空退出碼、signal、spawn／解析錯誤、有界串流、敏感值遮蔽、缺檔、壞 journal、長 journal、無效 runId，以及後續 completed 不覆蓋原 running／非零碼。沒有新增專屬突變，也未改 manifest。

## F1：相容舊版名額

新版有名額就維持僅含 runId、at 的舊格式 active.lock。建立、改指向、補回、刪除與 start 回滾均在 admission 跨行程臨界區；釋放後指向剩餘名額，最後才刪除。同 runId 去重，無新版名額的有效舊鎖另計；不存在或終結的舊 run 可回收。awaiting_approval 舊鎖必須保留、阻擋並提示 runId 可 cancel，實際 cancel 才放行。

既有測試使用 journal.acquireActiveLock 模擬舊版，驗證新版佔用期間拒絕、最後釋放後成功、待核准舊 run 真 cancel 後放行。既有 session 的 MCP server 不會因 dist 更新自動換版，因此相容標記是更新期間的必要協議；本機模擬不能冒稱真實新舊 MCP server 同時運行已實測。

## F2：測試鎖與程序協調

ProcessMutexBusy 可辨識；等測試鎖遇忙碌仍繼續並檢查 shouldStop。command 與 claimRunnerSlot 最多三次重試且維持 token／名額 fence。release 耗盡記 test_lock_release_deferred，不把已通過測試改成失敗；已停止的 command 身分供下一 run 判死回收。輪詢每秒先 mayBeAlive，相同 token／身分最多每三十秒完整查詢，換 token 立即查，死亡仍回收。

## F3：身分快取

只有 started 非空的成功身分查詢快取。既有測試涵蓋第一次缺失、空 started、拋錯後第二次成功重查，之後才使用快取。

## F4：TAP 可選欄位

cancelled／skipped／todo 各至多一次且順序固定；重複或亂序即使總數一致也未解析。保留安全整數、總和與完整結尾檢查。

## F5：突變產物

已刪除 d-mutations.txt，d-coverage.md 留各組總數、KILLED／SURVIVED／ERROR 及摘要，不連結原始紀錄。helper 在 os.tmpdir 新建 log 目錄。既有實證顯示完全放 repo 外的 snapshot 會被未修改 harness 的最後 Git status 檢查拒絕，所以僅 snapshot 暫置 repo；成功／失敗均經 finally，先 unlink node_modules junction，再驗證刪除邊界、移除 snapshot 並檢查 live dist 未變。

F5 無固定套件具名測試、無專屬突變；證據是既有 harness 成功／失敗清理紀錄，不把其他組算作 F5 新驗證。

## 證據分層與尚待確認

- 既有正式實測：e2e 原失敗輸出僅保留前 800 字元，可見 running JSON 前段；查不到原 approve 的退出碼、signal、spawn／JSON 解析錯誤、耗時與輸出尾端。
- 既有調查實測：失敗 run `kr-20261109-034136-7f75` 核准後約兩秒寫入 runner，之後 completed；兩次定向重現均退出碼 0、JSON 可解析且 state=running。這不證明原斷言成功，也不足以判定 timeout。
- 既有來源及突變：d-coverage.md 記錄 F1／F3 新增 11 筆、F2／F4 新增 16 筆可信 KILLED。本步核對目前全部 27 筆的唯一片段與實際完整斷言，未重跑整批突變。F2 identity 的先前 invalid 分組不採計，只採後續 valid=true 的四筆；原 D 適配另有一筆可信 KILLED。
- 本步實測：診斷定向回歸兩輪各 1 passed、0 failed；TypeScript --noEmit exit 0；e2e 語法檢查 exit 0；709 筆突變清單八項健康檢查通過。未跑完整 e2e 或 npm test，未重建 live dist。
- 合理推論：admission／runner claim 會增加核准路徑的協調等待；測試鎖在之後 setup／test 命令階段，不能直接等同 approve 失敗。缺原失敗程序資料，無法確認 F1／F2 等待與測試契約有衝突，未據此修改正式實作。
- 根因仍未知：無法證明原 approve 何處未滿足退出碼及解析條件，也無法判定與 F1～F5 的因果關係。既有假設已定向兩輪未重現，本步不原樣重跑。最小下一步是 kernel 執行正式驗收；若再失敗，核對新增同次退出碼、signal、spawn／解析錯誤、耗時和狀態摘要。
- 尚待確認：真實多機、其他平台、真 provider、新舊版 MCP server 真實同時運行，以及主 session 的完整 diff 與獨立稽核。

## 完整測試及突變對照

下表由目前 manifest 與實際測試名稱核對；CRLF 正規化後片段須唯一，expect 須命中表列完整斷言。這是索引核對，不是本步重新執行突變。

### F1

| 完整測試名稱 | 位置 |
| --- | --- |
| F1 new reservations exclude legacy launchers until final release | `tests/verify-ai-cli_kernel-concurrency.mjs:96` |
| F1 awaiting legacy reservation blocks admission and real cancel releases it | `tests/verify-ai-cli_kernel-concurrency.mjs:112` |
| F1 legacy wx winner is preserved when new marker creation races | `tests/verify-ai-cli_kernel-concurrency.mjs:126` |
| F1 marker deduplication permits three slots and release repoints it | `tests/verify-ai-cli_kernel-concurrency.mjs:149` |
| F1 acquisition rejection and release repair a deleted legacy marker | `tests/verify-ai-cli_kernel-concurrency.mjs:170` |
| F1 release waits for admission critical section before changing markers | `tests/verify-ai-cli_kernel-concurrency.mjs:184` |
| F1 failed starts restore remaining marker and release the last reservation | `tests/verify-ai-cli_kernel-concurrency.mjs:204` |

| 完整突變名稱 | 對應完整斷言 | 實作位置 |
| --- | --- | --- |
| kernel F1F3：新版不建立相容標記 | F1 new reservations exclude legacy launchers until final release | `src/ai-cli_kernel/admission.ts:175` |
| kernel F1F3：忽略舊版尚未核准鎖 | F1 awaiting legacy reservation blocks admission and real cancel releases it | `src/ai-cli_kernel/admission.ts:180` |
| kernel F1F3：相容標記重複計數 | F1 marker deduplication permits three slots and release repoints it | `src/ai-cli_kernel/admission.ts:94` |
| kernel F1F3：釋放後不修復相容標記 | F1 marker deduplication permits three slots and release repoints it | `src/ai-cli_kernel/admission.ts:132` |
| kernel F1F3：釋放保留舊指向 | F1 marker deduplication permits three slots and release repoints it | `src/ai-cli_kernel/admission.ts:106` |
| kernel F1F3：start 失敗不回收名額 | F1 failed starts restore remaining marker and release the last reservation | `src/ai-cli_kernel/admission.ts:197` |
| kernel F1F3：釋放略過 admission 臨界區 | F1 release waits for admission critical section before changing markers | `src/ai-cli_kernel/admission.ts:129` |
| kernel F1F3：wx 競爭後忽略舊版持有者 | F1 legacy wx winner is preserved when new marker creation races | `src/ai-cli_kernel/admission.ts:116` |
| kernel F1F3：多名額時漏補遺失標記 | F1 acquisition rejection and release repair a deleted legacy marker | `src/ai-cli_kernel/admission.ts:108` |

### F2

| 完整測試名稱 | 位置 |
| --- | --- |
| F2 mutex timeout is typed and cleans its own tickets | `tests/verify-ai-cli_kernel-concurrency.mjs:405` |
| F2 busy wait retries, observes stop and propagates other errors | `tests/verify-ai-cli_kernel-concurrency.mjs:417` |
| F2 release busy defers in journal without failing a passed check | `tests/verify-ai-cli_kernel-concurrency.mjs:438` |
| F2 command retries are bounded and preserve successor ownership | `tests/verify-ai-cli_kernel-concurrency.mjs:458` |
| F2 runner claim retries are bounded and keep the slot fence | `tests/verify-ai-cli_kernel-concurrency.mjs:483` |
| F2 lease identity checks throttle, detect death, token changes and PID reuse | `tests/verify-ai-cli_kernel-concurrency.mjs:498` |

| 完整突變名稱 | 對應完整斷言 | 實作位置 |
| --- | --- | --- |
| kernel F2F4：mutex 忙碌失去錯誤型別 | F2 mutex timeout is typed and cleans its own tickets | `src/ai-cli_kernel/process-mutex.ts:110` |
| kernel F2F4：等測試鎖將忙碌當失敗 | F2 busy wait retries, observes stop and propagates other errors | `src/ai-cli_kernel/test-lock.ts:74` |
| kernel F2F4：釋放忙碌覆蓋通過結果 | F2 release busy defers in journal without failing a passed check | `src/ai-cli_kernel/test-lock.ts:32` |
| kernel F2F4：command 不重試忙碌 | F2 command retries are bounded and preserve successor ownership | `src/ai-cli_kernel/test-lock.ts:90` |
| kernel F2F4：runner claim 不重試忙碌 | F2 runner claim retries are bounded and keep the slot fence | `src/ai-cli_kernel/admission.ts:138` |
| kernel F2F4：重試超過三次 | F2 command retries are bounded and preserve successor ownership | `src/ai-cli_kernel/process-mutex.ts:31` |
| kernel F2F4：runner claim 略過名額 fence | F2 runner claim retries are bounded and keep the slot fence | `src/ai-cli_kernel/admission.ts:139` |
| kernel F2F4：完整租約查詢每秒執行 | F2 lease identity checks throttle, detect death, token changes and PID reuse | `src/ai-cli_kernel/test-lock.ts:55` |
| kernel F2F4：租約忽略快速死亡檢查 | F2 lease identity checks throttle, detect death, token changes and PID reuse | `src/ai-cli_kernel/test-lock.ts:53` |
| kernel F2F4：租約快取忽略 token 更換 | F2 lease identity checks throttle, detect death, token changes and PID reuse | `src/ai-cli_kernel/test-lock.ts:54` |
| kernel F2F4：租約不再完整確認 PID 重用 | F2 lease identity checks throttle, detect death, token changes and PID reuse | `src/ai-cli_kernel/test-lock.ts:55` |
| kernel F2F4：command 覆寫後來持有者 | F2 command retries are bounded and preserve successor ownership | `src/ai-cli_kernel/test-lock.ts:91` |
| kernel F2F4：release 刪除後來持有者 | F2 command retries are bounded and preserve successor ownership | `src/ai-cli_kernel/test-lock.ts:83` |

### F3

| 完整測試名稱 | 位置 |
| --- | --- |
| F3 failed identity lookup retries then caches only a successful identity | `tests/verify-ai-cli_kernel-concurrency.mjs:216` |

| 完整突變名稱 | 對應完整斷言 | 實作位置 |
| --- | --- | --- |
| kernel F1F3：失敗身分永久快取 | F3 failed identity lookup retries then caches only a successful identity | `src/ai-cli_kernel/process-mutex.ts:42` |
| kernel F1F3：成功身分不快取 | F3 failed identity lookup retries then caches only a successful identity | `src/ai-cli_kernel/process-mutex.ts:42` |

### F4

| 完整測試名稱 | 位置 |
| --- | --- |
| F4 TAP optional counters appear once in Node order | `tests/verify-ai-cli_kernel-evidence.mjs:130` |

| 完整突變名稱 | 對應完整斷言 | 實作位置 |
| --- | --- | --- |
| kernel F2F4：TAP 接受重複或亂序欄位 | F4 TAP optional counters appear once in Node order | `src/ai-cli_kernel/evidence.ts:65` |
| kernel F2F4：TAP 允許重複 skipped | F4 TAP optional counters appear once in Node order | `src/ai-cli_kernel/evidence.ts:65` |
| kernel F2F4：TAP 將 todo 置於 skipped 前 | F4 TAP optional counters appear once in Node order | `src/ai-cli_kernel/evidence.ts:65` |

### 本步診斷與 F5 引用

- `tests/verify-ai-cli_kernel-e2e.mjs:105`
- `tests/helpers/kernel-e2e-diagnostics.mjs:33`
- `tests/verify-ai-cli_kernel-evidence.mjs:52`
- `tests/helpers/kernel-d-mutations.mjs:26`
- `tests/helpers/kernel-d-mutations.mjs:74`
- `docs/ai-cli_kernel/d-coverage.md:46`
- `src/ai-cli_kernel/api.ts:323`
- `src/ai-cli_kernel/api.ts:247`
- `src/ai-cli_kernel/loop.ts:372`
