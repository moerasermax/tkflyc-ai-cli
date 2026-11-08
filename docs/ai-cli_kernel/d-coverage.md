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

## 本步修正

TAP 摘要原先只驗總數大於等於通過加失敗，會接受缺少項目或矛盾的 skipped／cancelled／todo 數。現在驗證所有終結計數合計相等且總數為安全整數；矛盾或不完整仍輸出「未解析」。新增 CRLF、缺項、超額及不安全總數回歸。這只修正顯示統計，不改固定測試命令或 exit-code 驗收。

定向突變也揭露 C8 的原等待預算斷言過寬：斷言採用後續其他案例執行完的 Date.now，額外耗時會掩蓋被誤算的等待。現在直接用該 run 的 runner_started、wait／acquired 與停止事件計算精確預期 active 時間，誤差小於 1ms；不再用其他案例的耗時作容許值。

## 可重跑命令

```text
node node_modules/typescript/bin/tsc --noEmit
node --import tsx tests/verify-ai-cli_kernel-evidence.mjs --source
node --import tsx tests/verify-ai-cli_kernel-base-archive.mjs --source
node --import tsx tests/verify-ai-cli_kernel-concurrency.mjs --source
node tests/verify-ai-cli_kernel-policy.mjs
node tests/verify-worker-guards.mjs
node tests/verify-run-tests.mjs
node tests/verify-mutation-manifest.mjs
node tests/helpers/kernel-d-mutations.mjs
# 只重跑尚未有可信指定斷言結果的項目（保留既有證據）
node tests/helpers/kernel-d-mutations.mjs --remaining
```

定向 helper 使用現有 `tools/mutation-test.mjs` 的未修改副本，在工作目錄內建立一次性 snapshot；每個測試分組先通過基準，再逐筆突變、編譯並核對指定 FAIL 名稱。A／B／C 的環境篩選只用於突變定位，空選擇會拒絕；正式 runner 清空這三個篩選，固定 npm test 仍跑完整清單。fixture 使用 GIT_CEILING_DIRECTORIES，避免置於 repo 內的非 Git 目錄誤認母 repo；harness 所在 snapshot 是其兄弟目錄，仍可檢查還原狀態。helper 最後解除 node_modules junction，確認依賴完整與 live dist 的大小／mtime 未改，才移除 snapshot。輸出路徑已去識別化，見 [d-mutations.txt](d-mutations.txt)。該 helper 不屬於固定 npm test，不能把手動抽驗當全量突變結果。

## 本步實測結果（Windows，Node v24.15.0）

| 證據 | 結果 |
| --- | --- |
| TypeScript `--noEmit` | exit 0；未重建 live dist |
| A 原始碼回歸 | 15 passed，0 failed |
| B 原始碼回歸 | 12 passed，0 failed |
| C 原始碼完整回歸 | 17 groups 通過；其後 C4 的獨立 fixture 與 C8 的精確計時斷言再以原始碼定位回歸及隔離突變重測通過 |
| 政策精確校驗 | 通過；另以備份實際位元組比對，ctx 前綴及 WORKER_CONTEXT 到檔尾均不變 |
| 既有 worker 防護 | 41 passed，0 failed（使用既有 vendor stub） |
| 正式測試 runner | 15 個斷言通過，含清除定向篩選；新 policy verify 已登記 |
| 突變清單健康 | 682 筆，8 個檢查通過，全部片段存在且唯一 |
| 新增 D 定向突變 | 33 個不同的現行突變，最終全部由指定 FAIL 名稱抓到；每個可信分組均先通過基準並成功編譯突變 |
| 固定 npm test | 本步未執行，留給 kernel 固定驗收；上述來源測試不能代替該驗收 |

完整日誌保留了不採計的初次結果：新增交付檔造成母 repo 狀態清單變動、repo 內非 Git fixture 誤認母 repo、加強 C8 斷言時變數重名造成一輪基準語法錯誤，以及獨立執行 C4 時缺少狀態目錄。修正後逐組重測；原先存活的 wall-clock 突變也已由精確計時斷言殺死。不能將早先基準失敗視為殺死突變。每輪結束均確認 live dist 未改、snapshot 已移除、共用 node_modules 完整。

本步只實跑上述 33 個新增突變；其餘 649 個既有突變未重新全量實跑。對本機假 CLI／fixture 範圍的結論信心高；真 provider 與其他平台仍未確認。

## 未完成及適用範圍

- #17 第 2 點：第二模型可執行驗證涉及權限邊界，本次未做。
- #22 Claude 證據格式：需要真 CLI 實測，本次未做；#8 不在範圍。
- 本步僅 Windows／Node 現環境與假 CLI；不宣稱真 provider、其他平台、斷電與多主機共享檔案系統已驗證。
- 主 session 須逐檔檢查完整 diff，完成獨立稽核及固定 npm test 的最後驗收。政策安裝副本仍需主 session 重新同步；歸檔程序改用 list 摘要後逐筆 show。重建 dist 前等其他 run 全部停止，避免 version_drift。
