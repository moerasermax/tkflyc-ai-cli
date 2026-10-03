# CLAUDE.md — 這棵樹的現況與紅線

給在這個 repo 上工作的 AI agent。**動手前讀完這頁。**

協作流程（commit 格式、CHANGELOG 規則、突變測試、core 改動的稽核義務）在
[CONTRIBUTING.md](./CONTRIBUTING.md)，這裡不重複。這頁只寫**你不會自己發現、
而弄錯會造成對外傷害**的現況與禁止事項。

---

## 這是什麼

一個 MCP server：把本機裝的 AI CLI（claude / codex / antigravity）與任何
OpenAI-compatible API 包成**背景工作**。`run` 立刻回 PID，呼叫端用
`list_processes` / `peek` / `wait` / `get_result` 觀察，而不是阻塞等待。

**這是 fork，不是原創作品。** 上游是 mkXultra/ai-cli-mcp（MIT），再上游是
Peter Steinberger 的 claude-code-mcp（MIT）。分歧點在架構：上游把後端寫死，
這裡 `src/agents/` 一個 CLI 一支檔案，是唯一的擴充點——**加後端不該動
`src/core/`**。

---

## 現況（2026-09-09 之後）

| 項目 | 值 |
| --- | --- |
| GitHub | `moerasermax/tkflyc-ai-cli` — **2026-09-09 改名**，舊名是 `ai-cli-mcp` |
| npm | `@tkflyc/ai-cli-mcp` — **已公開發佈** |
| 版本 | `6.3.0` — 2026-10-03 發佈。**npm 上沒有 `6.2.0`**：那版只 bump 了 `package.json` 與 CHANGELOG，沒打 tag、沒發佈，內容僅透過 git 自動更新進各機器 |
| 授權 | **Apache-2.0** — 2026-09-09 從 MIT 改的，附 `NOTICE` |
| 主分支 | `master`（push 到 master 等同部署，所有機器會自動拉） |
| CI | Windows / Linux / macOS × Node 20.19、22 — **三個平台都是閘門** |
| 本機路徑 | `C:\Users\Moera\ai-cli-mcp-source`（目錄名還是舊的，不影響任何東西） |

規模：`src/` 33 個 `.ts`、9,984 行；驗證腳本都在 `tests/`（16 支），其中 14 支進 `npm test`
（`verify-e2e.mjs` 會真的燒額度、`verify-strict-behaviour.mjs` 屬手動輔助，兩者刻意不進）。

---

## 紅線

### 1. `NOTICE` 不可刪，也不可移出 `package.json` 的 `files`

它帶著兩位上游作者的著作權聲明、保留的 MIT 條款，以及實測數字：
**1,980 行實質原始碼裡有 299 行（約 15%）與上游相同**，集中在 MCP 工具面與
CLI/MCP 入口。放在 repo 裡不算數——`files` 沒列它，它就不會隨 npm 套件散布，
歸屬聲明等於沒做。

### 2. 不要寫「上游已停止更新」

**上游活著。** 實測：npm `2.23.0` 發於 2026-09-06、GitHub 最後推送 2026-09-07、
25 stars、週下載約 680 次。這句話 2026-09-09 曾被寫進 README（中英）、CHANGELOG
與兩篇 Release notes，全部是錯的，已更正。

它糟在**驗證成本極低**——任何人點進上游 repo 三十秒就會看到——所以同時毀掉
可信度和歸屬聲明的誠意。要寫上游狀態就去查，不要從「我沒在追蹤它」推論。

### 3. POSIX CI 是閘門，不是實驗

`test-posix` 2026-09-09 從 `continue-on-error` 升為閘門。**不要為了讓它過而
把它降回實驗性。** 它紅了就是真的回歸。

順帶記住 `continue-on-error: true` 放在 **job 層**時，不管步驟怎麼失敗、
job 的 conclusion 都是 `success`——看 CI 綠不綠要看**步驟層**的結論。

### 4. 發版：先 `npm version` 打 tag，再 build，再 publish

npm 上的 `6.0.0` 是從**比 tag `v6.0.0` 多 13 個 commit** 的工作樹發出去的，
provenance 對不上。那個版本已 `deprecate`，**不要拿它當任何基準**。
已推出去的 tag 沒有重寫，歷史就留著。

另外 `npm version` 打的是 **annotated tag**：`git rev-parse v6.1.1` 給你的是
tag 物件的 SHA，要 commit 得用 `v6.1.1^{}`。

### 5. `process.exit()` 之前要排空 stdout

`src/bin/ai-cli.ts` 有 `exitAfterFlush()`，新增子命令請用它。
理由：stdout 是 pipe 時寫入是非同步的，直接 `process.exit()` 會在緩衝區還有
資料時就結束行程。macOS 的 pipe buffer 是 8 KiB，而 `models` 的 payload 實測
12,478 bytes——呼叫端拿到在第 8192 位元組被切斷的 JSON，不報錯、不留痕跡。

**「一次性輸出」不等於「小」。** 這個 bug 的正確註解早就寫在那裡，只是適用
範圍判斷錯了。

### 6. 對外文件不要造假社群訊號

star、fork、下載量、貢獻者數字一律據實。沒有就寫沒有。

---

### 7. 突變片段必須從當前原始碼取出，而且只命中一處

`tools/mutation-test.mjs` 用 `String.replace`，只換第一個命中。2026-10-03 查出 **5 筆突變
長期套用不上**（4 筆 `from` 內含 CRLF，而 harness 當時只正規化原始碼、不正規化片段；
1 筆的片段早被重構掉），跑到就是 `ERROR`——**那幾筆從加進來那天起就沒測到任何東西**。
另有 2 筆片段命中兩處，改到哪一處取決於檔案順序。

它們之所以潛伏那麼久，不是 harness 不報，而是**那兩支腳本的突變平時沒人跑**：突變測試要開
worktree、建 junction、每筆各跑一次 `tsc`，實務上只針對這次改到的檔案跑。
現在 `tests/verify-mutation-manifest.mjs` 把「片段還在、而且唯一」納入 `npm test`，每次都跑。

還有一個它抓不到的：`expect` 必須是對應斷言名稱的子字串，否則 harness 判
「KILLED(其他斷言)」——測試確實失敗了，但無法確認是不是該抓的那條抓到的。
同日修了 15 筆這種。**斷言名稱不要寫死型號**，否則換代時改了名稱卻忘了改 `expect`
就會靜默退化。這一條只有實跑 harness 才驗得出來。

### 8. 突變測試不可與 `npm test` 並行

兩者都會開暫存 bare origin 與 A/B clone（`verify-update`、`verify-liveness`）。
2026-10-03 同時跑，`npm test` 在 `spawnSync git` 上 `ETIMEDOUT`——看起來像回歸，
其實是搶 git。序列跑就全綠。CONTRIBUTING 原本只寫「突變檢查一次只能跑一個」。

### 9. `~/.codex/models_cache.json` 是多個 codex 執行檔共用的

PATH 上 npm 裝的 CLI 與 Codex 桌面版自帶的核心寫**同一個檔**，最後跑的那個覆寫它。
所以 `client_version` 與你要派工的那支 CLI 不符時，**你讀到的是另一支的視角**，
不只是「版本舊一號」。2026-10-03 實測：`0.159.0`／`0.160.0` 的視角都是 10 筆且一致，
而另一次讀到 `0.155.0` 的視角只有 9 筆、沒有 `gpt-6.1-sol`。
查這個檔之前先 `codex --version`；不符就重派一個 trivial job 讓目標 CLI 自己重抓。
另外 `fetched_at` 每隔幾分鐘就被重抓一次，**不要在文件或註解裡引用到「分」**。

## 更早的脈絡在哪

- 知識庫 namespace **`ai-cli-mcp`**（`mcp__knowledge__knowledge_search`）——
  架構、模型清單、direct-api、歷次假綠燈的根因。
- 通用的 npm 發佈／GitHub 整備／衍生專案授權經驗在 **`_global`** 資料層。
- 逐次改動的理由在 `CHANGELOG.md`：每一筆都寫了**為什麼**，不是只寫改了什麼。
