# archive list 摘要格式與 baseRef

`ai-cli_kernel_archive_list` 與 `ai-cli kernel archive list` 現在只回待歸檔摘要：
`runId`、`state`（有效狀態，含 interrupted）、`reason`、`goal`（前 80 個 Unicode 字元）、
`repo`、`branch`、`latestCommit`、`evidence: { journalSeq, releaseEvents }`、
`candidateMemories`（數量）。清單不含 origin、步驟、模型輸出、候選記憶內容等完整包欄位。
完整內容仍由既有 `ai-cli_kernel_archive_show`／`archive show <run>` 取得。
CLI 非 JSON 輸出先印筆數，再印同一摘要陣列。

這是 list 回傳格式變更：需要 origin、tests、steps、candidateMemories 陣列等內容的交接流程，
應先 list 找 runId，再逐筆 show；不能把摘要當完整包。archive done 的既有檢查不變。

list 的 `repo`／CLI `--repo` 要求絕對 git 目錄路徑，以本地 git common-dir 真實路徑比對，
包含同 repo 的 linked worktree。`workFolder`／CLI `--work-folder` 要求非空絕對路徑，
精確比對建立時的原始 workFolder，並非遞迴查子目錄，也不是 develop 新 worktree 路徑；既有檔案不是合法目錄篩選值。
workFolder 不必仍存在；存在時展開真實路徑，Windows 路徑忽略大小寫。兩種參數同給時取交集。
正常的非 git readonly-audit run 不會混入 repo 篩選結果，仍可用 workFolder 精確找到。
無法讀取或查證歸屬的紀錄仍以 `state: unreadable` 摘要顯示，不能因篩選失敗而隱藏損毀 run；
其未知欄位為 null、candidateMemories 為 0（未能取得內容）。

start 的 `baseRef`／CLI `--base-ref` 僅供 develop 使用，接受來源 repo 的本地分支名稱
（也可寫完整 refs/heads 名稱）或 commit ID（含可唯一解析的縮寫）。不接受 tag、revision expression、
選項、tree／blob ID、其他 repo 才有的 commit 或不存在的值。
workFolder 仍是來源主 repo（原有子目錄 prefix 語意保留）；委任書儲存輸入 baseRef、
解析 commit（baseCommit），以及分支的完整 ref。新 worktree 從固定 commit 建立。
明確指定 baseRef 的回復點保存該 commit，不把主目錄未提交變更套在其他基準上。
省略 baseRef 時委任書不新增相關欄位，維持既有 HEAD／回復點與主目錄檢查語意。

ref 閘門除既有所有 ref 的變動檢查外，會檢查所選分支仍指向已核准 commit，
包含委任書建立到 runner 首次啟動之間的移動；既有人工接回規則不變。
若使用另一 run 的實際交付分支且共用同一個 git common-dir，委任書持久儲存 dependsOnRunId。
使用相同 commit 的其他分支、直接 commit ID、其他 repo 的同名分支均不會推斷成依賴。
cleanup 在任何刪除前讀取持久契約與日誌：依賴 run 尚非終止狀態時拒絕並列出 run 與原因；
完成／失敗／取消／預算耗盡後解除阻擋。暫停、中斷、待核准都還沒結束。
遇到無法讀取的 run 契約時，cleanup 保守拒絕並指出 run，交由人核對依賴。
依賴契約建立與來源 cleanup／放行共用來源 run 既有的短鎖，阻止「掃描完依賴後才建立契約」的競態；
鎖被占用或上次中斷時沿用既有人工對帳錯誤，不排隊、不重試，也不改 runner 的並行政策。
