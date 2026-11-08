# 審查與報告證據

develop 的 read 步驟及 report 步驟由 kernel 提供基準到交付的 Git 證據，唯讀模型不需補跑 Git。

| 證據 | 上限（JavaScript 字元） | 超限處理 |
| --- | ---: | --- |
| diff | 20,000 | 逐檔取片段，測試檔優先；清單標示完整、部分省略或全部省略 |
| git diff --stat | 8,000 | 附原始總字元數及截斷標籤 |
| A/M/D/R 等變更清單 | 16,000 | 項目邊界截斷，附總數、顯示數及截斷數 |
| 測試結尾摘要及輸出 | 4,000 | 保留尾段，附原始尾段字元數及截斷標籤 |
| 基準測試變更清單（prompt） | 16,000 | 項目邊界截斷，附總數及截斷數 |

Git name-status 使用 NUL 格式，rename 保留兩端；選檔使用 literal pathspec。清單以 JSON 字串表示路徑，空白、tab、換行不會被當成分隔符。

測試數字只解析結尾的完整 runner 彙總、`N passed, M failed` 或 TAP 終結摘要。runner 的數量單位是腳本，不冒稱腳本裡的 assertion 數。無法解析、數字矛盾或輸出在摘要後繼續時寫「未解析」；exit code 仍由原本的測試驗收判斷。

基準測試清單由基準與交付的淨差異計算。M/D/T 檢查原路徑，R 檢查來源；新增測試不列入。規則為 test/tests/__tests__/spec 目錄、`*.test.*`、`*.spec.*`、`test_*.py`、`*_test.*`。

報告 prompt 要求逐檔說明「為了讓既有測試通過而改動的斷言」，不增加驗收條件。報告通過既有驗收後，kernel 把完整的同類清單附於末尾「kernel 統計」。每次交付從原始 worker 回覆重建，不在上次產生的報告上累加；清單只描述檔案差異，不推斷修改動機。

引用優先使用從 repo 根目錄算起的完整相對路徑及行號。工作目錄是 repo 子目錄時，Git 的 index 與 prefix 會把完整路徑對應回工作目錄內。原路徑不存在時，只在 Git 工作目錄查 index 的同 basename 候選；唯一候選仍驗證目錄邊界（含 symlink/junction）、檔案大小及行號，多候選最多列八條完整候選及總數，交給 decide 修正。

探針標籤區分「CLI 尚無證據格式」與「已支援格式但未通過／結果不明」。只有 Codex 有既有證據格式；未實作 Claude 格式，也不改 PASS 閘門。develop 保持未隔離標籤，單一允許 worker 模型另提示沒有第二模型檢查。

## 測試與 D 步突變定位

`tests/verify-ai-cli_kernel-evidence.mjs` 已登記正式 runner。worker 可用 `node --import tsx tests/verify-ai-cli_kernel-evidence.mjs --source` 驗證原始碼，不重建 dist；正式驗收仍由 kernel 跑 npm test。

- `evidence.ts`：`full.length > maxChars`、`remaining <= 0`、摘要格式／總數驗證、`changedBaselineTests` 狀態與來源判斷。
- `verdict.ts`：Git 才能 fallback、候選數為零／一／多、八條上限、fallback 後仍檢查實體路徑及行號。
- `templates.ts`：單一允許 worker 模型的 notice；新增報告段落不加入 acceptance patterns。
- `loop.ts`：review/report 證據注入、通過驗收後的 kernel 附錄；測試涵蓋寫完 report 後中斷再交付的冪等性。
- `probe.ts`：格式支援與 FAIL/UNKNOWN 標籤分支；status 經 dashboard 的顯示由同一組測試驗證。
