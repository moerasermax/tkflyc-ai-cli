# A～D 覆蓋核對與交付驗證

本頁區分原始碼回歸、定向突變與尚待主 session 驗收。測試使用既有假 CLI／executor／命令及暫存 Git fixture，不呼叫真 vendor CLI。固定 `npm test` 保持原命令，由 kernel 另行驗收；本步未重建工作目錄的 dist。

## 需求對照

| 項目 | 已登記於 tools/run-tests.mjs 的驗證 | 分支／限制 |
| --- | --- | --- |
| A1 審查證據 | verify-ai-cli_kernel-evidence.mjs | NUL／rename／特殊路徑、diff 測試優先與逐檔省略、stat／清單／測試輸出獨立上限、完整與未知／矛盾終結統計、read 與 report prompt |
| A2 引用退路 | 同上 | Git index 唯一／零／多 basename、八候選與總數、repo 子目錄 prefix、非 repo 不掃描、原始逃逸、junction、檔案大小與行號 |
| A3 單模型提示 | 同上 | 單一與多個允許 worker 模型分流；未新增第二模型可執行驗證 |
| A4 基準測試統計 | 同上 | M／D／T／R 來源分類、排除新增／非測試、固定命令驗收後附加清單、報告崩潰續接與重跑不重複；不增加 acceptance patterns |
| A5 探針標籤 | 同上 | 缺少格式與既有格式 FAIL／UNKNOWN 分開；status → dashboard 使用假 CLI，未增 Claude 證據格式 |
| B1 摘要／篩選 | verify-ai-cli_kernel-base-archive.mjs | 固定欄位、Unicode 80 字、候選數量、大包仍由 show 取得；repo／workFolder／交集、非 git／linked worktree、CLI／MCP／API 一致、非法參數拒絕 |
| B2 baseRef／依賴 | 同上 | 分支／ref／完整與縮寫 commit、拒絕非法與非 commit；worktree／回復點固定 commit、首次啟動前及執行中 ref 漂移、依賴持久化／跨程序 cleanup、建立與清理短鎖、所有終止狀態、同 commit 不誤認依賴、省略相容 |
| C1 名額／C5 核准 | verify-ai-cli_kernel-concurrency.mjs | 六個真 Node 程序搶三名額、同 run 平行核准一次；待核准不佔、暫停保留／接回、舊限制下降不強停 |
| C2 同 repo | 同上 | 五程序同 common dir 互斥、linked worktree、同 origin 不同 clone、origin 正規化及憑證不外洩 |
| C3 額度／C4 人用設定 | 同上 | used／left／remaining basis、矛盾／缺欄位／無效／失敗／未知回退、10／20 嚴格小於邊界、decide／worker／allowedWorkers 計入；maxRuns 整數 1～3 與 MCP 無覆寫參數 |
| C6 舊鎖／C7 回收與觸發 | 同上 | legacy 去重及失效回收、死亡核准 owner／PID 身分／延遲 runner fence、額度阻擋 skipped／不扣 reserved／不啟動 |
| C8 全機測試鎖 | 同上 | 真 setup／test 子程序不重疊、等待取消、runner 死但命令活著保留、死亡／重用 PID 回收；正式 loop 等待狀態與事件、不耗命令逾時及 active wall-clock、成功／失敗／逾時釋放 |
| C9 status 相容 | 同上 | active 仍為 string 或 null、activeRuns 欄位、dashboard 全部佔用者、actions CLI JSON 保持操作陣列並附 activeRuns |
| D1 政策三處 | verify-ai-cli_kernel-policy.mjs；verify-worker-guards.mjs | 將指定變更反向還原後比對原版全檔 SHA-256（LF 正規化）；worker 常數仍逐字比對；未同步安裝副本 |
| D2 文件 | 技術手冊、教學手冊、CHANGELOG 人工核對 | 更新舊單名額敘述；列出不重建 dist、安裝副本交接與摘要加 show 流程；並行標使用者決定日期，未捏造 issue |
| D3 突變／登記 | verify-mutation-manifest.mjs；verify-run-tests.mjs | 所有新 verify 腳本已登記；每個 from 唯一且存在。定向實測另見下節，不將清單健康檢查當成殺死突變 |

## 既有證據（不是此次重跑）

5579 的 D 段交付（cbff66e）記錄：TypeScript --noEmit、A 15 passed／0 failed、B 12 passed／0 failed、C 完整 17 組及後續定向回歸、政策校驗、worker 防護 41 passed／0 failed、runner 15 個斷言、當時 682 筆突變清單健康檢查。這些是原交付紀錄，不冒稱本次實測。

從刪除前的原始執行紀錄逐筆讀取 JSON 分組，按目前 manifest 的突變名稱去重，只採 valid=true 且由指定 FAIL 捕獲、成功編譯的結果：

| 既有 D 分組（script） | 不同突變總數 | KILLED | SURVIVED | ERROR |
| --- | ---: | ---: | ---: | ---: |
| verify-ai-cli_kernel-evidence.mjs | 11 | 11 | 0 | 0 |
| verify-ai-cli_kernel-base-archive.mjs | 7 | 7 | 0 | 0 |
| verify-ai-cli_kernel-concurrency.mjs | 14 | 14 | 0 | 0 |
| verify-run-tests.mjs | 1 | 1 | 0 | 0 |
| 合計 | 33 | 33 | 0 | 0 |

原始紀錄共有 41 次 JSON 分組，其中 27 次 valid=true。最終可信名稱集合覆蓋全部 33 筆現行 kernel D 突變；已退役的亂碼名稱不計入。初次基準失敗、母 repo 狀態改變、fixture 誤認 repo、語法錯誤、狀態目錄缺少，以及早先 wall-clock 突變存活都不採計；後者加強精確 active 計時斷言後的指定 KILLED 才採計。表中是最終去重可信結果，不是歷次嘗試累加。

可追溯來源為 Git 中 cbff66e 的原始執行紀錄 blob（本次依明確授權刪除），刪除前工作區 bytes 的 SHA-256：`86137d4bae53da0fdab7e7936ead15e86cf5b0dc33202e7175910100e489f17c`。原始 log 不再提交或以文件連結發布，歷史仍可供唯讀核對。

F1/F3 前一步 01816dc 的紀錄：11 筆 kernel F1F3 與兩筆已調整的 D 突變可信 KILLED；concurrency source 完整 24 組、wx 競態另以定向組通過、既有 kernel source 762 passed／0 failed。這些突變此次只核對片段存在且唯一，不全面重跑；本次 concurrency 完整回歸仍涵蓋 F1/F3。

## F2、F4、F5 修正與驗證

- F2：ProcessMutexBusy 型別；等鎖忙碌可繼續、仍可停止且不吞其他錯誤。command／runner claim 最多三次嘗試；release 耗盡記 journal，避免覆蓋成功結果，保留可依已停止命令身分回收的租約。每秒 kill(0)、同 token／命令身分完整查詢每 30 秒一次，更換時立即查；死亡下一輪回收、PID 重用最晚下一次完整查詢識別。
- F4：cancelled、skipped、todo 各最多一次且依 Node 順序，重複／亂序即使總數相符仍未解析；安全整數、合計及完整結尾限制保留。測試包含 LF、CRLF、合法可選欄位及各種重複／亂序。
- F5：原始執行紀錄改為本頁摘要。新 log 寫入 os.tmpdir() 下每次新建的 kernel-mutations-* 目錄；不把不同來源測試或未重跑突變算成本次結果。

本次來源驗證（Windows／Node v24.15.0）：TypeScript --noEmit exit 0；concurrency 完整 31 組通過；evidence 16 passed／0 failed；目前 709 筆 manifest 的 8 個健康檢查通過。原 D「測試鎖忽略存活命令」隨實作改為 leaseAlive，片段已同步，測試意圖不變。

本次新增 16 筆 kernel F2F4 突變，指定 FAIL 分組如下；只採基準成功、突變編譯成功、指定斷言捕獲且 harness 最後狀態校驗成功的分組。下表採其餘六組與 identity 定向重測的可信結果，不採先前無效輪。

| 本次分組（expect 子字串） | 總數 | KILLED | SURVIVED | ERROR |
| --- | ---: | ---: | ---: | ---: |
| F2 mutex timeout is typed | 1 | 1 | 0 | 0 |
| F2 busy wait retries | 1 | 1 | 0 | 0 |
| F2 release busy defers | 1 | 1 | 0 | 0 |
| F2 command retries are bounded | 4 | 4 | 0 | 0 |
| F2 runner claim retries are bounded | 2 | 2 | 0 | 0 |
| F2 lease identity checks throttle | 4 | 4 | 0 | 0 |
| F4 TAP optional counters appear once | 3 | 3 | 0 | 0 |
| 本次新增合計 | 16 | 16 | 0 | 0 |

### snapshot 位置限制與不採計的嘗試

已實跑確認原 harness 的限制：完全放在 os.tmpdir() 的 snapshot 能先通過基準、編譯並由指定斷言捕獲三筆 TAP 突變，但 tools/mutation-test.mjs 最後將 status.code !== 0 判為 dirty，Git 回 128（not a git repository），整輪因此不可信。停止此方案，未修改原 harness、未建立 repo／分支或更改 Git 設定。

依此限制，只有 snapshot 暫置 docs/ai-cli_kernel/.d-mut-*；log 與 fixture 仍在 os.tmpdir() 獨立新目錄。helper 成功／失敗都走 finally：先只 unlink node_modules junction，確認共享依賴、驗證 snapshotRoot 的絕對目標在指定文件目錄下，再移除 snapshotRoot，檢查 live dist 大小／mtime 未改；log 留在系統暫存供核對。系統暫存方案失敗後 snapshot 也已清理。此 helper 不屬固定 npm test。

另一次 repo 內定向輪的 identity 分組雖有四筆指定 KILLED，但 worker 同時更新文件，使原 harness 的前後 Git status 清單不同。該分組不採計，停止並改為全部文件更新後只重跑該分組；其餘六個可信分組毋須全面重跑。後續驗證期間不再修改 repo 檔案。

## 可重跑命令

```text
node node_modules/typescript/bin/tsc --noEmit
node --import tsx tests/verify-ai-cli_kernel-concurrency.mjs --source
node --import tsx tests/verify-ai-cli_kernel-evidence.mjs --source
node tests/verify-mutation-manifest.mjs
node tests/helpers/kernel-d-mutations.mjs --name 'kernel F2F4：'
node tests/helpers/kernel-d-mutations.mjs --name 租約
node tests/helpers/kernel-d-mutations.mjs --name 測試鎖忽略存活命令
```

帶空白的 --name 值在 PowerShell 請用單引號包住，例如 `--name 'kernel F2F4：'`。不帶參數仍重跑全部 kernel D；新 helper 不再從 repo 原始 log 讀取 --remaining。每組以 expect 定向選取且拒絕空跑；正式 runner 清空定向篩選，固定 npm test 仍完整驗收。執行定向 helper 時不要同時修改 repo 或執行 npm test。

## 未完成及適用範圍

- 固定 npm test 尚未由本 worker 執行，交由 kernel 另行驗收；來源回歸和定向突變不能取代它。
- 未重建 live dist，未全面重跑其他既有突變，未改政策 hook、測試 runner、依賴或權限／額度／ref 閘門。
- #17 第 2 點、#22 Claude 真 CLI 證據格式及 #8 不在本段範圍。
- 本機假 CLI／fixture 範圍的結果可信；真 provider、其他平台、斷電／磁碟損毀與多主機共享檔案系統尚未驗證。
- 主 session 仍須檢查完整 diff、獨立稽核及 kernel 固定驗收。政策安裝副本與重建 dist 的交接條件仍依既有說明。

## 本次外部證據索引

原始 log 位於系統暫存 kernel-mutations-* 目錄（不在 repo），以下 SHA-256 對應其完整 bytes：

- F2/F4 其餘六組：`kernel-mutations-dEjbcF/mutations.log`；SHA-256 `c87aaac67afffe140dcbf6d156142f4cec722710f68c7e8bd05e85e8392a8125`。
- F2 identity 重測：`kernel-mutations-amDtXl/mutations.log`；SHA-256 `53c0c5c2154fa9454fa748dd18d12058633ed54c4ff950e2aa8222e87af41d91`。

第一份 log 的 identity 組因狀態清單變更標 valid=false，不採其整輪總結；只採六組 valid=true 的 12 筆。第二份 log 一組 4/4 valid=true，合計新增 16 筆全部可信 KILLED，SURVIVED 0、ERROR 0。helper 的成功與先前失敗路徑均記 snapshot removed、Live dist unchanged: true、共享依賴完整。

既有 D 片段適配抽驗：`kernel D：測試鎖忽略存活命令`，1/1 可信 KILLED，SURVIVED 0、ERROR 0。證據 `kernel-mutations-iBtBhF/mutations.log`；SHA-256 `a272146ed12314b001c0dd9328bc7bbc241385365d3d5c2a3d1f24b5fc73afc2`。本次不同突變合計 17 筆（新增 16、既有適配 1）；沒有將歷史 F1/F3 或其他 D 組算成本次實跑。

## 本次突變與實際斷言對照

下列每筆都編譯成功並由具名斷言捕獲。行號指本段交付來源；manifest 的 expect 是實際名稱的子字串。

| 突變名稱 | 實際斷言名稱 | 來源位置 |
| --- | --- | --- |
| kernel D：測試鎖忽略存活命令 | dead runner retains lease while real command lives, then reclaims dead identities | `src/ai-cli_kernel/test-lock.ts:67` |
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
| kernel F2F4：TAP 接受重複或亂序欄位 | F4 TAP optional counters appear once in Node order | `src/ai-cli_kernel/evidence.ts:65` |
| kernel F2F4：TAP 允許重複 skipped | F4 TAP optional counters appear once in Node order | `src/ai-cli_kernel/evidence.ts:65` |
| kernel F2F4：TAP 將 todo 置於 skipped 前 | F4 TAP optional counters appear once in Node order | `src/ai-cli_kernel/evidence.ts:65` |
