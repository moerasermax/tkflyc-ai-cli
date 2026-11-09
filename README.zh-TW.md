> English version: [README.md](README.md)（英文版是精簡的設計說明；完整參考以本頁為準）

# ai-cli-mcp

選用 [ai-cli_kernel_panel](plugins/ai-cli_kernel_panel/README.md)：`/kernel` 開新 Terminal 分頁，`/kernel side` 開 session 側邊面板，操作保留兩步確認。

[![CI](https://github.com/moerasermax/tkflyc-ai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/moerasermax/tkflyc-ai-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40tkflyc%2Fai-cli-mcp)](https://www.npmjs.com/package/@tkflyc/ai-cli-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

把 Claude / Codex / Grok / Antigravity(agy) 等本機 AI CLI，
以及**任何第三方 OpenAI-compatible API**（透過 direct-api，自己接）包成 MCP 工具，支援背景 job。這是**從原始碼自行維護**的版本，採用 registry-based
架構，新增 AI agent 只需新增一個檔案。

## 快速開始

**從 npm——不用編譯：**

```bash
claude mcp add ai-cli -s user -- npx -y @tkflyc/ai-cli-mcp
```

**從原始碼——你打算改它，或想要自動更新：**

```bash
git clone https://github.com/moerasermax/tkflyc-ai-cli
cd tkflyc-ai-cli
npm install                                          # 會自動觸發 build，產生 dist/
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```

`dist/` 不進版控，所以**從原始碼裝**的那條一定要編譯過才能用。`npm install` 會經由 `prepare` script
自動跑 `npm run build`，正常情況下不需要另外手動 build。
需要 Node `^20.19.0 || >=22.12.0`。細節與 PowerShell 版指令見下方「掛到 Claude Code」。

⚠️ **兩條路的差別不只在要不要編譯。** 自動更新需要一個含 `.git` 與 `package.json`
的 clone（見下方「自動更新」），所以 **npm／npx 安裝拿不到自動更新**——換版本要自己
來。想確定跑的是哪一版，就在指令裡把版本釘住（`@tkflyc/ai-cli-mcp@<版本>`）。
`doctor` 回傳的 `update.supported` 表示這份安裝是否符合原始碼更新的前置條件。

## 掛到 Claude Code

最快的方式（在 repo 根目錄執行，`$PWD` 會自動展開成本機的絕對路徑）：

```bash
# bash / git bash
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```

```powershell
# PowerShell
claude mcp add ai-cli -s user -- node "$PWD\dist\server.js"
```

或手動把 `~/.claude.json` 的 `mcpServers.ai-cli` 指向（`<repo>` 換成你 clone 的絕對路徑）：

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["<repo>/dist/server.js"],
  "env": {}
}
```

### 三個入口是等價的

`dist/server.js`（官方推薦）、`dist/bin/ai-cli-mcp.js`、`node dist/bin/ai-cli.js mcp`
三者對外行為完全相同，`verify-mcp.mjs` 每次都會三個都測過。

> **4.1.2 之前 `ai-cli mcp` 是壞的**：`runMcpServer()` 在 transport 一接上就 resolve，
> 而 `bin/ai-cli.js` 會在那之後呼叫 `process.exit()`，於是 server 在 handshake 完成前
> 就自殺，client 只看得到 `MCP error -32000: Connection closed`。另外兩個入口沒有
> `process.exit`，所以只是碰巧沒事。若你的設定還指著 `ai-cli.js mcp` 且版本低於
> 4.1.2，升級或改指 `dist/server.js` 皆可。

## 各 agent

以下是各個後端的使用說明；維護者的驗收流程見 [tools/acceptance/README.md](tools/acceptance/README.md)。

### Grok CLI

Grok 是供程式碼／文字工作使用的獨立 xAI CLI 後端，使用 CLI 自己的登入。
模型候選為 `grok-4.7`、`grok-4.7-build-fast`、`grok-4.6`、`grok-4.5`；
`models` 工具與 `ai-cli models` 以 `grok models` 探查，15 秒逾時，失敗／未登入時
保留成功快取或標示 `builtin-fallback`，不把靜態清單冒充 vendor 回覆。
`GROK_CLI_NAME` 可覆寫指令或絕對路徑；預設先找 PATH，再退回
`~/.grok/bin/grok.exe`（Windows）或 `~/.grok/bin/grok`。doctor 會列出 grok。

長 prompt 走 UTF-8 `--prompt-file`，Windows native executable 不經 cmd.exe。
`--rules` 每次送出共用 `WORKER_CONTEXT`，接著空一行附上 `run.system_prompt`；
resume 也會重新補鎖，以 `--resume <session_id>` 續接，不使用 `--system-prompt-override`。
一律帶 `--no-subagents`，一般模式加 `--always-approve`。
`reasoning_effort` 支援 `low/medium/high/xhigh`，已實測（grok 1.0.50）。

Grok result 的 `subtype: error_during_execution` 或 `stop_reason: cancelled`
即使 exit 0 也判 failed；錯誤訊息帶出這兩個欄位。

Grok 的 MCP／CLI job 使用既有 JobStore／runner，可接回且適用結束後 30 分鐘回收。
Messages NDJSON 的 result 會正規化 input/output/cache tokens 與 `cost_usd_nominal`
（vendor 名目美元估值，不是帳單）；完整解析（verbose）的原始 usage 保存在 `raw_usage`。

唯讀 `capabilities` 的旗標組成與實機驗證、F2 實機驗證點屬於維護者驗收流程，見 [tools/acceptance/README.md](tools/acceptance/README.md)。空 capabilities 與未知能力會被直接拒絕。

### direct-api：自己接任何第三方 API

除了三個本機 CLI，這個框架還有一條 **direct-api** 路徑——它不啟動任何子程序，
直接在 Node 行程內打 HTTP，因此**任何 OpenAI-compatible 的 `/chat/completions` 端點都能接**：
OpenRouter、阿里雲 DashScope、NVIDIA 的 NIM 目錄、DeepSeek、Groq、together.ai、
自架的 vLLM / Ollama，或你公司內部的 gateway。想加一家新的供應商**不需要改任何程式碼**。

它不是單次補全的薄包裝：跑的是完整 agent loop，模型拿得到 `read_file` / `write_file` /
`bash`，可以真的改檔案、跑指令。

⚠️ **CLI 這條路有一個例外**：`ai-cli run` 派 direct-api 時不啟動子程序，也就沒有東西可以
detach——指令會**等到請求結束才返回**，回的是終局狀態而不是可輪詢的 pid。所以下方
「等待端怎麼知道 AI 還活著」教的 wait／peek 輪詢模式，在 CLI ＋ direct-api 這個組合上用不到。
MCP 的 `run` 不受影響，direct-api 一樣立刻回 pid。

#### 設定檔

路徑 `~/.local/share/ai-cli/providers.json`（可用 `AI_CLI_PROVIDERS_PATH` 覆寫）：

```json
{
  "providers": {
    "openrouter": { "api_key": "sk-or-v1-..." },
    "local":      { "base_url": "http://127.0.0.1:11434/v1", "api_key": "ollama" },
    "nv": {
      "base_url": "https://integrate.api.nvidia.com/v1",
      "api_key": "nvapi-...",
      "retry": { "max_retries": 3, "initial_delay_ms": 1000 },
      "extra_body": { "max_tokens": 8192 },
      "model_extra_body": {
        "nvidia/nemotron-3.5-lightning-30b-a3b": { "reasoning_effort": "none" }
      }
    }
  }
}
```

- `api_key` 也接受寫成 `key` 或 `token`；`base_url` 也接受 `baseURL`。
- `openrouter` 與 `dashscope` 有**內建預設端點與簡寫前綴**（`or`、`ds`），`base_url` 可省略。
  其他自訂名稱都必須自己給 `base_url`。
- provider key 建議取短名：叫 `nvidia` 會變成 `nvidia-nvidia/llama-...`，能動但很醜。

> ⚠️ **這個檔是整份 fail-closed。** 任何一筆 provider 缺 `base_url` 或 `api_key`，
> 整個檔案 throw，**其他原本正常的 provider 會一起壞掉**。動之前先備份。

#### 怎麼呼叫

model 名稱用 **`<provider>-<model>`**，前綴就是 `providers.json` 裡的那個 key：

| model 參數 | 實際打到哪 |
|-----------|-----------|
| `or-qwen/qwen3.7-plus` | OpenRouter（`or` 是 `openrouter` 的內建簡寫） |
| `nv-openai/gpt-oss-20b` | 上面自訂的 `nv`（NVIDIA NIM） |
| `local-llama3.1` | 上面自訂的 `local`（Ollama） |

前綴之後整串原樣送出，所以 model 名稱裡的斜線沒問題。**框架不維護任何白名單**。

#### extra_body：控制框架不會替你送的欄位

送出去的 request body 只有 `model` / `messages` / `stream` / `stream_options` / `tools`，
所以託管模型的預設值原封不動生效——而那些預設值可能很貴。實測
`nvidia/nemotron-3.5-lightning-30b-a3b`：走預設每輪 **28.0 秒／318 output token**，
傳 `reasoning_effort: "none"` 只要 **6.1 秒／84 token**。

`extra_body` 是 provider 層預設，`model_extra_body` **逐欄覆蓋**它，
key 是送給 provider 的完整 model 名（前綴之後那串）。

`model` / `messages` / `stream` / `stream_options` / `tools` 是**保留欄位**，
兩層都不准設，**載入時就丟錯並點名是哪個 provider 的哪個欄位**——不是靜默丟棄。
覆蓋 `stream` 會讓 SSE 解析器收到一整包 JSON；覆蓋 `tools` 會讓模型收到
`executeTool` 執行不了的工具。

> **注意術語衝突**：`run` 工具的 `reasoning_effort` 參數是 claude/codex 的 CLI 旗標，
> 對 direct-api 仍然無效。`extra_body` 送的是**同名的 API 欄位**，兩者不是同一件事。

#### max_tool_loops：工具迴圈上限

每個 provider 可在 providers.json 設定 `"max_tool_loops": 60`，接受 1～200 的
整數，預設 30。同一值限制工具迴圈輪數與 API completion 呼叫數，HTTP 重試不計入。
撞限時回傳 `finish_reason: "tool_loop_limit"`，stderr 印出實際生效的上限；
非法值會報錯，並指出 provider 名稱與 providers.json 路徑。
撞限時 job 仍是 `completed`、exit code 0，`get_result` 也看不到那行 stderr，
所以要先檢查 `agentOutput.finish_reason`，不要把回覆直接當成完成的答案。

#### retry：讓共享端點跑得完

免費的共享端點在尖峰會限流與卸載。NVIDIA 自己的故障排除文件就寫明 hosted Nemotron
endpoint 在高需求時會回 **429 或 503**，並建議「短暫等待後重試、降低並發」——
而這個框架原本收到任何非 200 就直接讓整個 job 失敗。

現在 429 與 5xx 走**指數退避加抖動**重試，其餘 4xx 不重試：服務端說格式錯的請求，
再送一次還是錯，只是白等又燒額度。抖動是為了避免並行 job 一起退避、一起回來，
把剛恢復的服務再打掛一次。

- 預設 2 次、首次退避 1 秒；`max_retries: 0` 明確關閉。
- 服務端有送 `Retry-After` 就聽它的（上限 60 秒）。
- 退避途中被 kill 會**立刻醒來**，不會等睡完。
- 每次重試發一個 `retry` 事件到 stdout——靜默重試會讓「很慢」跟「卡住」長得一模一樣，
  而呼叫端只看得到工具回傳。

**範圍限制**：重試只包住「建立請求」那一段。一旦回 200 開始讀串流，內容已經送到呼叫端，
中途失敗**不重試**——重來會讓同一段回答出現兩次。

實測 `nvidia/nemotron-3-super-120b-a12b`，每列 10 輪完整兩輪工具迴圈：

| 請求速率 | 重試 | 成功率 |
|---|---|---|
| 背靠背連發（約 66 RPM） | 關 | 4/10 |
| 10 RPM | 關 | 8/10 |
| 15 RPM | 關 | 9/10 |
| **15 RPM** | **開** | **10/10** |

**放慢速率到不了 100%，重試才到**，而且速率還更快。均勻放慢是拿所有請求的時間去換
少數請求的成功率；退避重試只在服務端真的拒絕時才付出等待。

#### replay_reasoning：把上一輪的推理回送

有些模型要求上一輪的 assistant message **完整**回送，包含它自己的推理內容。
Kimi-K3 的 model card 原句是 “clients must pass back the complete assistant message,
including `reasoning_content` and `tool_calls`”；DeepSeek V4 更硬——帶 `tools` 時
少送會直接 **400**。

```json
"nv": { "replay_reasoning": ["moonshotai/kimi-k3"] }
```

`true` 代表這個 provider 的所有 model 都送，陣列則只送列出的那幾個。

> **預設關閉，而且刻意不做內建的 model 白名單。**
> `reasoning_content` 不在 OpenAI 的 assistant message schema 裡，而「OpenAI-compatible」
> 不保證未知欄位會被忽略——Azure AI Model Inference 的 `extra-parameters` 預設就是 `error`。
> 至於為什麼不寫死一份清單：這個專案的每一份硬編 model 清單最後都過期了
> （codex 的靜態清單裡還躺著三個帳號用不了的 model），再加一份只是換個地方犯同一個錯。

兩個實作細節：

- 回送的是**這一輪**的推理（`turn.reasoningText`），不是整次 run 的累積值。用後者的話
  第二輪會把第一輪的推理再附一次，越滾越長。
- **每一個 assistant turn 都保存**，不是只有帶 `tool_calls` 的那些。最後一輪沒有工具呼叫的
  回覆會寫進 session 檔，下次用同一個 `session_id` 續聊時它就是歷史 assistant turn。

**實測的但書**：Kimi-K3 在**不回送**的情況下也能正確走完三輪工具鏈，而官方文件
沒有寫少送會怎樣。所以這是照契約做，不是修一個看得見的當機。

#### 這台機器接得到什麼

`models` 的回傳有一個 `directApiProviders`：每個已設定 provider 的可用前綴
（含內建簡寫）、`base_url`、`model_extra_body` 裡點名過的 model，
以及一個可以直接複製去派工的 `example`。

沒有它的話，工具回傳**答不出「這台機器接得到什麼」**——靜態的 `direct-api` 陣列
只有四個佔位字串，而已設定的 provider 是本機狀態，不在版控也不在任何靜態清單裡。

這個區塊**永遠不含 `api_key`**，而且**永遠不丟錯**：`providers.json` 讀不到時回 `note`，
因為「讀不到」與「沒設定」對呼叫端是兩件不同的事。

#### 能做什麼、限制在哪

- **session**：`session_id` 存在 `workFolder/.tmp/api_sessions`，可以續聊。
- **圖片**：prompt 裡寫 `[image:C:/path/to.png]`（png/jpg/webp/gif）。
- **關掉工具**：prompt 開頭加 `[no-tools]`，退化成單純問答。
- **每回合上限**：最多 30 次 API 呼叫、30 圈 tool loop。
- **金鑰保護**：錯誤訊息回傳前把 api_key 換成 `[redacted]`。

> 從 OpenCode 遷移：若 `providers.json` 不存在但 `~/.local/share/opencode/auth.json` 在，
> 框架會自動轉檔一次。

## 自動更新

**前提：這一節只適用於「從原始碼 clone」的安裝。** 更新器要求 repo 根目錄同時有
`.git` 與 `package.json`，所以 npm／npx 裝的那份完全不會自動更新，`doctor` 的
`update.supported` 會是 `false`。

三個 MCP 入口都在 transport 連線後正常服務，**3 秒後背景檢查 → 子程序背景套用 → 下次啟動生效**。
預設每小時檢查一次 `origin`；其他機器 push 新 commit 後，這台機器會在下一輪檢查發現。
更新不阻塞 MCP 啟動，也不自動終止目前的 server 或 agent job。

成功後 stderr 與 MCP `notifications/message`（warning）會提示：

```text
ai-cli 已更新至最新版（1234567 → abcdef0，2 個 commit），請重新啟動 MCP（Claude Code：/mcp 重連）。更新內容請至 https://github.com/moerasermax/tkflyc-ai-cli/blob/master/CHANGELOG.md 查看
abcdef0 fix: 最新修正標題
7654321 feat: 另一個改動標題
```

`doctor.update` 包含 `policy / checkedAt / local / remote / behind / available / lastApplied / notice`；
MCP `run` 啟動回傳與 `models` payload 另有 `updateNotice`（沒有提示為 `null`）。
讀取不會清除提示；新版啟動時，若 `lastApplied.to` 等於本次啟動的 HEAD，才清除 `notice`，
並在 stderr 印 `ai-cli 已是最新版 <sha7>`。MCP logging 由 server 宣告能力，通知遵守 client 的 `logging/setLevel`。

| `AI_CLI_AUTO_UPDATE` | 行為 |
|---|---|
| `on`（預設） | 背景檢查，發現新版後自動套用 |
| `check` | 只檢查並提示有新版，不套用 |
| `off` | 更新器完全不碰網路，仍可讀取既有狀態與提示 |

可在 MCP 的 `env` 中設定 policy、`AI_CLI_UPDATE_CHECK_INTERVAL_SEC`（預設 `3600`）與
`AI_CLI_UPDATE_BRANCH`。分支優先序為環境變數 → 目前分支 upstream 的分支名稱 → `master`，
實際 fetch/pull 的 remote 都是 `origin`。

狀態目錄為 `AI_CLI_STATE_DIR` 或預設 `~/.local/state/ai-cli`：

- `update.json`：`{ checkedAt, branch, local, remote, behind, available, lastApplied, notice }`。
  `lastApplied` 為 `null` 或 `{ at, from, to, ok, commits: [{ sha, subject }], message }`。
  時間用 ISO 8601，SHA 保存完整值；寫入採同目錄 tmp + rename，壞檔當空。
- `update.lock`：pid、時間與鎖識別碼。避免多個 server 同時套用；pid 不存在或超過 30 分鐘可回收。

以下情況不會自動套用：安裝不是含 `.git` 與 `package.json` 的 clone、追蹤檔有未 commit 改動、
目前分支不符、HEAD 不是遠端祖先（不能 fast-forward），或另一個更新程序持鎖。
未追蹤檔不影響髒樹判定，git 自身仍會拒絕覆蓋衝突檔案。
更新採 `pull --ff-only`；套件檔變動時執行 `npm install --no-audit --no-fund`（prepare 建置），
其他變動只執行 `npm run build`，最後以 `node dist/bin/ai-cli.js doctor` exit 0 做煙霧測試。
失敗會 reset 回原 HEAD 並重新 build；回滾失敗會明確回報，詳細指令結果在手動更新的 JSON `log`。
Windows 若其他 server 鎖住 `node-pty` 原生模組而出現 EPERM／EBUSY，會回滾並提示
「其他 ai-cli server 仍在執行，鎖住原生模組；關閉後再更新」，後續檢查會重試。
回滾只恢復原始碼與建置，不還原 `node_modules` 的完整安裝快照。

手動操作（尚未加入 PATH 時，以 `node dist/bin/ai-cli.js` 代替 `ai-cli`）：

```bash
ai-cli update --check          # 強制檢查，略過節流，不套用
ai-cli update                 # 強制檢查並套用；仍遵守 on/check/off
ai-cli update --json           # 結構化結果與指令 log
ai-cli doctor                 # 本機診斷與已保存的 update 區塊，不連更新網路
```

`check`／`off` 模式要手動套用時，先將 `AI_CLI_AUTO_UPDATE` 改為 `on`。
更新內容網址優先取 `package.json.homepage`，否則由 GitHub origin 推導該分支的 `CHANGELOG.md`。

⚠️ **安全提醒：push 到 master 要當成部署——push 前必須確認 `npm test` 全綠。**
這是 public repo，任何有寫入權限的人都能觸發它。

追蹤 `master` 且啟用自動更新的原始碼安裝，會在之後某一輪檢查**嘗試**拉取並套用。但不一定成功：
工作樹髒、追蹤的是別的分支（`AI_CLI_UPDATE_BRANCH`）、無法 fast-forward、或鎖被別的更新程序持有，
都會在 pull 之前就中止；install／build／`doctor` 煙霧測試失敗則會**嘗試**回滾，而回滾本身也可能失敗。
所以「一定傳出去了」和「應該沒傳出去」都不能假設。

### 信任模型：`on` 代表什麼

`AI_CLI_AUTO_UPDATE=on`（預設值）等於**信任 `origin` 上的每一次 push**：

- 能 push 到 `origin` 的人——或盜用了 repo 擁有者 GitHub 帳號／token 的人——都能讓這台機器在下一輪檢查時
  執行他們的程式碼，**不需要你做任何事**。
- 「下次啟動生效」指的是 MCP server 換版；新程式碼**在背景更新當下就已經執行**：套件檔變動時的 `npm install`
  會跑相依套件與本 repo 的 lifecycle scripts（例如 `prepare`），之後的 build 與 `doctor` 煙霧測試也跑在新程式碼上。
- 這個 server 本身權限就大：`run` 沒帶 `capabilities` 時，會以各家的權限略過旗標啟動 agent
  （claude 與 agy 的 `--dangerously-skip-permissions`、codex 的 `--dangerously-bypass-approvals-and-sandbox`、
  Grok 的 `--always-approve`），並使用你本機的 CLI 登入。

所以：

- **只在你信任 `origin` 寫入者的機器上用 `on`**，例如你自己的機器追你自己的 repo。
- 其他情況——`origin` 指向別人的 repo、共用機器、不確定誰有寫入權——用 `check`：只提示有新版，
  看過更新內容再照上面的「手動操作」套用。
- 維護者這端：GitHub 帳號開兩步驟驗證、寫入權限只給需要的人、保護 `master` 分支。

npm／npx 安裝不受影響，本來就不會自動更新。

## 架構

```
src/
├─ server.ts              # 預設進入點（啟動 MCP server）
├─ agents/                # ★ 每個 AI 一個檔，新增 AI 就加一個檔
│   ├─ types.ts               # AgentDefinition 介面（可擴充的核心契約）
│   ├─ registry.ts            # 中央註冊表（新增 agent 在此 import + 列入陣列）
│   ├─ claude.ts / codex.ts / grok.ts / antigravity.ts / direct-api.ts
├─ core/                  # 框架本體，新增 agent 時「不用動」
│   ├─ command-builder.ts     # model routing + 指令組裝協調
│   ├─ process-service.ts     # MCP job 管理
│   ├─ job-store.ts           # MCP／CLI 共用持久化 job、增量讀取與回收
│   ├─ job-runner.ts          # detached worker 父行程、fd 直寫輸出與 exit 記錄
│   ├─ file-process-service.ts# 檔案版 job 管理（`ai-cli` CLI 用；pipe 子程序走 detached，
│   │                         #   PTY 不 detach，direct-api 沒有子程序、同步跑完才返回）
│   ├─ pty-runner.ts          # ConPTY（agy 等需要真實 TTY 的 CLI）
│   ├─ binary-resolver.ts     # CLI 二進位解析
│   ├─ user-config.ts        # ~/.local/share/ai-cli/config.json 讀寫（依內容快取）
│   ├─ updater.ts            # 背景檢查／子程序更新、鎖、回滾與重啟提示
│   ├─ circuit-breaker.ts    # AI 啟動熔斷器
│   ├─ peek.ts / peek-extractor.ts / process-result.ts / reasoning.ts / ansi.ts / debug.ts
│   └─ doctor.ts              # doctor + 解析所有 CLI 路徑
├─ models/
│   ├─ catalog.ts         # model 清單 / alias / 同步 models payload
│   └─ catalog-v2.ts      # 出處 / 時間 / 非同步查詢與磁碟快取
├─ plugins/
│   ├─ usage.ts           # 查額度外掛橋接（路徑由環境變數設定）
│   └─ usage-service.ts   # query_usage 工具的實作與快取
├─ app/
│   ├─ mcp.ts             # MCP server（12 個工具）
│   └─ cli.ts             # ai-cli 指令列
└─ bin/
    ├─ ai-cli-mcp.ts      # MCP server 入口
    └─ ai-cli.ts          # CLI 入口
```

## 開發

```bash
npm install        # 含 prepare → 自動 build 一次
npm run build      # tsc → dist/（改完 src/ 後手動重編）
npm run dev        # tsx 直跑 src/server.ts（改完即生效，不用 build）
npm run typecheck  # 只型別檢查
```

## ai-cli_kernel：受監督的 agent run

`ai-cli kernel dashboard` 開啟全螢幕終端機控制面板，變更前一律確認；`--new-tab` 僅支援 Windows Terminal。既有真實 CLI 只在 Windows 用過；此次 dashboard 尚未做真人 TTY／Windows Terminal 或其他平台實測。

給目標和委任書，它自己規劃、派 worker、用確定性檢查驗收，當掉可以接回，做過的步驟不會重做。預設唯讀範本會實際打開核對每個 `路徑:行號`；工作者**沒有隔離**。

```
ai-cli kernel probe --agent codex
ai-cli kernel start --goal "稽核 X 的 Y" --cwd /path/to/repo
ai-cli kernel approve <run>
ai-cli kernel wait <run>
ai-cli kernel result <run>
```

有兩個範本。`readonly-audit`（預設）使用工具受限的唯讀模式。`develop` 會改程式：每個 run 有自己的 git worktree 和分支，kernel 自己跑你給的測試指令，通過才算完成，不會自動合併或推送交付分支。開工前的預設回復點使用專用位置，有 `origin` 就會推送，推送失敗便停下來。`develop` 的 worker 權限等於你本人，也會載入你完整的 CLI 設定，包含 MCP server。**它沒有隔離**，核准時要明確承認，只用在你信任的專案。

7.0.0 尚未發佈到 npm。現階段請從 GitHub 取得原始碼，再執行 `npm install`、`npm run build`（見[快速開始](#快速開始)）；前提是 Node `^20.19.0 || >=22.12.0`、已安裝並登入 Codex CLI、已註冊 ai-cli MCP。kernel 只在一台 Windows 上實測；Linux、macOS 尚未實測，stub 測試不代表這兩個平台的行為已經驗證。

常用委任書可用 `kernel mandate save/approve/list/show/revoke` 保存與管理。同意預設 30 天到期，重新保存或撤銷就失效。`kernel trigger <name>` 每次只觸發一次，另有預設關閉的 `kernel triggers on|off` 與持久每日次數／用量帳本。`kernel schedule <name> --daily HH:MM` 先預覽，Windows 加 `--apply` 才登記，POSIX 只印 crontab。觸發任務不能關閉回復點，也不能使用 release 單次放行；完整操作與限制見教學手冊。

記憶一律先產生候選，包括人說「記住」；使用者確認收下後才啟用。歸檔包整理已記錄的事實，可自行閱讀或交給 AI 整理到自己的筆記；標記歸檔只寫本機狀態，不寫外部服務。worktree 和分支隔開的是交付歷史，沒有隔離權限：全權限 worker 和 hook 仍可能影響其他地方，收下前應看報告與 diff。

MCP 工具 `ai-cli_kernel_*` 預設不列出且拒絕呼叫；`ai-cli kernel enable` 後重新連線 MCP 才可使用。`AI_CLI_KERNEL=on|off` 優先覆寫儲存設定。CLI 不受這個開關限制。既有 MCP 工具名稱與參數介面保持相容。kernel 的整合是新增 CLI 子命令、預設關閉的 MCP 工具，以及 `JobStore.start` 的檢查：目前 ai-cli 行程帶 `AI_CLI_WORKER=1` 且未設 `AI_CLI_ALLOW_NESTED=1`，即使直接呼叫 JobStore（含 FileProcessService、ProcessService 經此啟動）也拒絕派工。未帶 worker 標記的一般主 session 不受這條檢查阻擋。CLI run／exec、MCP run 原本已有入口防護；`spawnPty` 刻意不改，因為已授權的 runner 也帶 worker 標記。檢查的是目前 ai-cli 環境，不涵蓋所有 vendor 程序，也不是 OS 沙箱。本版其他 direct-api 路由／設定與 updater 提示變動，另見 [CHANGELOG](CHANGELOG.md#700---2026-11-07)。手把手教學看[教學手冊](https://github.com/moerasermax/tkflyc-ai-cli/blob/master/docs/ai-cli_kernel/教學手冊.md)，內部設計看[技術手冊](https://github.com/moerasermax/tkflyc-ai-cli/blob/master/docs/ai-cli_kernel/技術手冊.md)。

## 新增一個 AI agent

1. 複製 `src/agents/codex.ts` 成 `src/agents/<name>.ts`，實作 `AgentDefinition`：
   - `id` / `models` / `matchesModel` / `binary` / `reasoning` / `buildCommand` / `parseOutput`
   - 需要真實 TTY → 設 `win32SpawnMode: 'pty'`（參考 `antigravity.ts`）
   - 是真實 .exe（非 npm shim）→ 設 `win32DirectExec: true`
2. 在 `src/agents/registry.ts` import 並加進 `AGENTS` 陣列（claude 永遠最後，它是 fallback）。
3. 在 `src/agents/types.ts` 的 `AgentId` 加上新 id；若 agent 需要 CLI binary，更新
   `core/doctor.ts` 的 `CliPaths` 回傳欄位。
4. `npm run build`。

## 環境變數

| 變數 | 用途 |
|------|------|
| `MCP_CLAUDE_DEBUG=true` | 開啟 debug 日誌到 stderr |
| `AI_CLI_STATE_DIR` | MCP／CLI 共用持久化 job 與更新狀態目錄（預設 `~/.local/state/ai-cli`） |
| `AI_CLI_CONFIG_DIR` | 使用者設定目錄（預設 `~/.local/share/ai-cli`）；測試以此隔離 config.json |
| `AI_CLI_AUTO_UPDATE` | `on`（預設）／`check`／`off`，見「自動更新」 |
| `AI_CLI_UPDATE_CHECK_INTERVAL_SEC` | 更新檢查間隔秒數，預設 `3600`；無效值使用預設 |
| `AI_CLI_UPDATE_BRANCH` | 覆寫更新分支；未設時依 upstream 或 master |
| `AI_CLI_USAGE_PLUGIN_BIN` | `ai-cli usage` 外掛的 .mjs 絕對路徑 |
| `CLAUDE_CLI_NAME` / `CODEX_CLI_NAME` / `GROK_CLI_NAME` / `AGY_CLI_NAME` | 覆寫各 CLI 的指令名稱或絕對路徑 |
| `AI_CLI_DISCOVER_TIMEOUT_MS` | 模型查詢逾時毫秒，預設 `15000`；測試可縮短，非正整數或超出計時器範圍則用預設值 |
| `AI_CLI_CATALOG_CACHE_PATH` | 模型磁碟快取路徑，預設 `~/.local/share/ai-cli/catalog-cache.json`；測試一律指向暫存目錄 |
| `AI_CLI_PROVIDERS_PATH` | direct-api providers.json 路徑（預設 `~/.local/share/ai-cli/providers.json`） |
| `AI_CLI_BREAKER_DISABLED=true` | 停用 AI 啟動熔斷器（預設啟用） |
| `AI_CLI_BREAKER_MODE` | `block`（預設，觸發即擋下並回報）或 `warn`（只警告不擋） |
| `AI_CLI_BREAKER_WINDOW_SEC` | 熔斷器滑動視窗秒數（預設 `60`） |
| `AI_CLI_BREAKER_MAX_STARTS` | 視窗內最大啟動次數，超過視為爆量（預設 `30`） |
| `AI_CLI_BREAKER_DUP_LIMIT` | 視窗內「同一 agent + 同一 prompt」最大次數，超過視為迴圈（預設 `6`） |
| `AI_CLI_BREAKER_COOLDOWN_SEC` | 觸發後的開路冷卻秒數（預設 `120`） |
| `AI_CLI_DEFAULT_REASONING_EFFORT` | 覆寫 `config.json` 的 reasoning 預設值（見下方「使用者設定檔（config.json）」） |

## 模型目錄的出處與查詢時間

`models` payload 保留既有各 agent 字串陣列與 aliases，詳細來源看 `catalogV2`。
頂層 antigravity 清單採可路由的 vendor 結果（含成功快取）加 `agy`／`agy-default`；
尚無可用結果時才回後備 `agy`、`agy-default`、`gemini-3.1-pro-high`、`gemini-3.8-flash-high`。
`catalogV2.entries[]` 保留 `id / agent / model / displayName / billingRoute / source / verifiedAt / routable`；
`catalogV2.agents[]` 每列是 `{ agent, binaryFound, source, verifiedAt, discoveryNote }`。
每列的 `verifiedAt` 與所屬 entries 一致，快取不會把原時間改成現在。

| source | 意思 |
|--------|------|
| `vendor-cli` | 此 process 這一輪或先前真的問過 CLI 的成功值；`verifiedAt` 是當時問到的時間 |
| `vendor-cli-cached` | 先前行程問到、存進磁碟的值，這一輪尚未確認；保留原 `verifiedAt` |
| `builtin-fallback` | 原始碼的靜態參考值，未經 vendor 確認；`verifiedAt` 是本次讀取靜態值的時間 |

**`agy models` 是網路呼叫，不是讀本機設定。** 2026-09-05 本機 agy 1.1.26 實測，
它先對 `https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` 做 eligibility check。
八次暖機耗時為 **1739 / 1755 / 1762 / 1838 / 1906 / 2487 / 2729 / 3972 ms**，
網路尾延遲可能超過 5 秒。舊實作每個 process 冷啟動與 60 秒快取到期後都以 `spawnSync`
重查，連 MCP 工具描述也會卡住整個 server；5 秒逾時後又把整輪降成 fallback。

現在 `buildCatalogV2()` 與 `getModelsPayload()` 維持同步，只讀記憶體／磁碟／靜態值，
同步堆疊永不 spawn。找得到 CLI 卻沒有此 process 的成功值時，會排一輪背景
`refreshCatalogV2()`，自己不等：**MCP `tools/list` 與 `set_config` 不等查詢；
MCP `models` 與 CLI `ai-cli models` 會先 `await refreshCatalogV2()` 才回 payload。**

`refreshCatalogV2({ force?: boolean })` 是非同步且在 process 內單飛：已有查詢就共用 Promise。
預設記憶體成功值在 **10 分鐘**內不重查，`force: true` 可忽略新鮮度。失敗保留成功值，
並在 `discoveryNote` 記下逾時、stderr 第一行非空文字或沒有模型 id 的原因。
agent 的 `discoverModels` 現在必須回 Promise、有逾時且永不 reject；可回模型陣列／null，
或 `{ models, note }`（失敗時 `models: null`）。`agy` 採後者提供診斷。

磁碟檔為 `join(CONFIG_DIR, 'catalog-cache.json')`，每個 agent 一筆
`{ models, verifiedAt, cliPath }`。寫入採同目錄 tmp + rename，讀取任何錯誤都忽略；
只有 **CLI 路徑相同且時間不超過 30 天**的磁碟值會被使用。
`vendor-cli-cached` 的 note 顯示「快取值：N 秒前問過 CLI；背景重新查詢中」，
最近一次背景失敗時附原因。沒有有效快取時才回 `builtin-fallback` 並說明原因。
`clearCatalogCache()` 只清記憶體，測試可用 `clearCatalogCache({ disk: true })` 一併刪磁碟檔。

## 使用者設定檔（config.json）

路徑：`~/.local/share/ai-cli/config.json`（與 `providers.json` 同一層）。
每次都重新讀檔、以檔案內容當快取鍵（省下的只有 JSON 解析），改完檔不必重啟 MCP server。
每個高階操作（一次 `run` 的指令組裝、一次 `models`）只載入一份 snapshot，
所以同一次操作內看到的一定是同一份設定。

讀不到或讀壞了的處理方式分三種，刻意不一樣：

| 情況 | 行為 |
|------|------|
| **結構性**讀不到（`ENOENT` / `ENOTDIR` / `EISDIR` / `ELOOP` / `ENAMETOOLONG`） | 退回內建預設，不會讓 `run` 失敗 |
| 內容不是合法 JSON 物件 | 退回內建預設，並清掉快取（避免壞掉的舊值之後被當成 last-good 復活） |
| **暫時性**讀取錯誤（`EBUSY` / `EPERM` / `EACCES`…） | **沿用上一次成功讀到的設定**，不退回內建值 |

分界點是「再試一次有沒有可能成功」，不是「錯誤嚴不嚴重」：
結構性錯誤不會自己好，沿用舊設定只會讓一份永遠讀不到的設定無限期存活；
暫時性錯誤（別的 process 正在 rename、防毒掃描鎖檔）退回內建值則等於讓這一次 run
悄悄換成另一個 model 而沒有人會察覺。目前生效的狀態可從 `models` 的 `userConfig.status` 查看
（`fresh` / `missing` / `stale`+`errorCode` / `error`）。

反過來，**寫入**時的原則相反 —— `set_config` 若讀不到或讀到壞掉的設定檔會**明確失敗**，
不會拿空基底套上變更寫回去（那會把原有設定與未知欄位整份吃掉）。

檔案帶 UTF-8 BOM（Windows 記事本、PowerShell 5.1 的 `Set-Content` 都會產生）也能正常讀取。

```json
{
  "defaultReasoningEffort": "medium",
  "aliasReasoningEffort": {
    "claude-ultra": "medium",
    "codex-ultra": "medium"
  },
  "aliasModel": {
    "codex-ultra": "gpt-5.6-terra"
  }
}
```

| 欄位 | 用途 |
|------|------|
| `defaultReasoningEffort` | 呼叫端沒帶 `reasoning_effort` 時，所有支援 reasoning 的 agent 套用的預設 |
| `aliasReasoningEffort` | 針對特定 model/alias 的覆蓋，優先於 `defaultReasoningEffort` |
| `aliasModel` | 把 alias 重新指向另一個 model，優先於 `catalog.ts` 寫死的 `MODEL_ALIASES`（見下方「alias 重新指向」） |

檔案中它不認識的欄位會原封保留，`set_config` 寫入時也不會被吃掉。

reasoning 預設值的優先序（高 → 低）：

1. 呼叫端明確傳入的 `reasoning_effort`
2. `AI_CLI_DEFAULT_REASONING_EFFORT` 環境變數
3. `config.json` 的 `aliasReasoningEffort[model]`
4. `config.json` 的 `defaultReasoningEffort`
5. 內建 ultra alias 預設（`claude-ultra` = `max`、`codex-ultra` = `max`）

兩者行為不同，這點是刻意的：

- **明確傳入**的值不合法會**丟錯**（維持原本行為）。
- **設定檔／環境變數**推導出的預設，若該 agent 不支援 reasoning（antigravity /
  direct-api）或該值不在其允許集合（例如 claude 不吃 `ultra`），會**靜默略過**、
  改用該 CLI 自身預設。全域偏好不該讓個別 run 整個失敗。

目前生效的設定可從 `models` 工具回傳的 `userConfig` 欄位查看；`aliases[].defaultReasoningEffort`
也會反映套用設定後的實際值，`userConfig.builtinAliasReasoningEffort` 則保留內建值供對照。

### 設定檔的已知限制

- **手動編輯的 `aliasModel` 不會被驗證**：`set_config` 會擋掉不存在的 model（否則打錯字會被
  catch-all 的 claude agent 靜默接走），但直接編輯 `config.json` 沒有這道關卡。
  改完可以用 `models` 檢查 —— 每筆 alias 都會顯示實際 `resolvesTo` 與推算出的 `agent`，
  被靜默接走的打錯字會顯示成 `agent: claude`。
- **多個 process 同時寫入會遺失更新**：`set_config` 是無鎖的 read-modify-rename，
  兩個 MCP server 同時改不同欄位時，後 rename 的會覆蓋掉前一個的修改
  （tmp 檔名帶 pid 只避免 tmp 互撞，不解決這件事）。實務上 `set_config` 極少並發。

## alias 重新指向（免 rebuild、免重啟）

內建 alias 寫在 `src/models/catalog.ts` 的 `MODEL_ALIASES`：

| alias | 內建指向 |
|-------|----------|
| `claude-ultra` | `opus` |
| `codex-ultra` | `gpt-6-astra` |
| `agy-ultra` / `antigravity-ultra` | `Gemini 3.1 Pro (High)` |

> **`gpt-6-astra` 需要 codex-cli 0.153 以上。** 0.151.0 的模型快取雖然列得出它，實跑會被 API 以
> `requires a newer version of Codex` 拒絕（2026-09-05 實測；0.153.4 可用）。`codex-ultra` 既然改指它，
> 舊版 CLI 上呼叫 `codex-ultra` 也會失敗——升級 CLI，或用下面的 `aliasModel` 暫時把它指回 `gpt-5.6-sol`。

`config.json` 的 `aliasModel` 可以覆寫它。解析優先序（高 → 低）：

1. `config.json` 的 `aliasModel[alias]`
2. 內建 `MODEL_ALIASES[alias]`
3. 原樣（不是 alias 就當成 model 名稱直接送出）

**為什麼改完立刻生效**：`resolveModelAlias()` 是每次組指令時才呼叫（不是啟動時算好的常數），
而設定檔每次都會重讀，所以下一次 `run` 就會改用新的模型與路由，不必 `npm run build`、不必重連 MCP。
（實際怎麼傳給 CLI 依 agent 而定：claude / codex 走 `--model`，direct-api 走 API 請求，
agy 則完全不吃模型選擇 —— 見下方已知限制。）

### 用 `set_config` 工具寫入

| 參數 | 用途 |
|------|------|
| `alias_model` | `{"codex-ultra": "gpt-5.6-terra"}` — 重新指向 |
| `alias_reasoning_effort` | `{"codex-ultra": "high"}` — 該 alias 的預設 reasoning |
| `default_reasoning_effort` | 全域 reasoning 預設 |
| `unset` | `["codex-ultra"]` 會**同時**清掉該 alias 的 model 與 reasoning 兩種覆寫；`["defaultReasoningEffort"]` 清全域預設 |

回傳與 `models` 相同的 payload，可以立刻看到生效狀態。`models` 的每筆 alias 附帶
`source`（`builtin` / `config`），**被 config 重指的那幾筆**額外附 `builtinResolvesTo`
（沒被重指就沒有這個欄位），且 `agent` 欄位是**依實際生效的 model 動態推算**
——alias 被跨 agent 重指（例如 `codex-ultra` → `opus`）時才不會回報錯的 agent。

### 驗證是刻意從嚴的

claude agent 的 `matchesModel` 是 registry 最後一位的 catch-all（永遠回 `true`），
不擋的話**打錯字的 model 會被靜默送去 claude**。因此 `set_config` 只接受：
被某個非 fallback agent 認得的 model，或 direct-api 真的解析得出來的 provider-prefixed 名稱
（`or-` / `ds-` 這種空 model 會被拒絕）。另外 alias 只解析一層，所以**不接受把 alias 當 target**
（`codex-ultra` → `agy-ultra` 會讓該 alias 名稱被原樣當成 model 送出去）。

### 已知限制

- **antigravity（agy）不吃 `--model`**：其 CLI 沒有這個旗標，實際模型由登入帳號的 Google AI tier 決定。
  重指 `agy-ultra` / `antigravity-ultra` 只改變回報內容，不改變實際執行的模型。
- 模型的**自報名稱不可信**（問 `gpt-5.6-terra`「你是哪個模型」它會說 GPT-5）。要驗證 `--model`
  真的送出去，把 alias 指到一個不存在但能過驗證的名稱（如 `gpt-5.6-doesnotexist`）再 `run`，
  看 CLI 是否回報該模型不支援。
- **Kiro 與 Forge 已於 5.0.0 移除**（Kiro 沒額度、Forge 從沒安裝過）。`kiro`、`kiro-*`、
  `forge` 這些名稱現在會**明確報錯**，而不是被 catch-all 的 claude 靜默接走。
  注意 `forge-<model>` 不受影響——那會被讀成 direct-api 的 provider `forge` 加上 model。
- 回歸測試：`node verify-alias-config.mjs`（65 項，已納入 `npm test`）。

## 跨 session 監看 job

在旁邊開一個終端機，使用同一個狀態目錄：

```sh
ai-cli jobs                  # 所有 MCP session 與 CLI job 的一次性表格
ai-cli jobs --watch          # 每兩秒更新，Ctrl+C 結束
ai-cli jobs --json           # JSON 陣列，含 metadata 與時間
ai-cli jobs --running        # 只看 running，可搭配 watch/json
ai-cli jobs --watch --json   # 每次更新印一行 JSON 陣列（NDJSON）
ai-cli adopt                 # 唯讀 JSON 候選清單，供 MCP session 接管
```

表格列出狀態（轉圈／✓／✗；lost 為 ?）、agent、解析後的 model 與 effort、
prompt 第一個有意義行的 40 字摘要、經過時間 m:ss、最後事件及派工端（父行程名稱＋
ai-cli PID）。窄終端機會截短欄位，避免換行。父行程可能是 shell 或 Node launcher；
無法取得名稱時顯示 `unknown`。

Claude／Codex／Grok／Windows agy（ConPTY）的 MCP 與 CLI job 共用 `AI_CLI_STATE_DIR/jobs/<UUID>/`，
預設為 `~/.local/state/ai-cli/jobs/`。每個 job 都由 detached runner 當 worker 的父行程，
MCP server 或 CLI 啟動端退出後仍可繼續。對外 PID 為 runner PID；目錄 UUID 才是 job 身分。
Windows 由短命 launcher 建立 runner，確認 launcher 已退出才派 worker；runner 不在 server 的行程樹內，
因此 Claude Code 關閉 MCP 時即使終止整棵 server 行程樹，持久化 job 仍可繼續。POSIX 維持原有 detached 啟動方式。
MCP 重啟只接回同一主導者（排除套件啟動器後的祖先 PID＋OS 建立時間）派的 job，結果附
`recovered: true`，接回絕不重跑、重試或重派。有 `exit.json` 就還原完成／失敗；
runner 身分相符且活著則繼續追蹤；runner 與 worker 都消失且無 exit 時標為 `lost`，保留輸出。
Windows agy 的 ConPTY 由 detached runner 持有，PTY 合併 stdout／stderr 並清除 ANSI，stderr.log 只放 runner 錯誤與終止提示。
POSIX agy 與 direct-api 維持現有執行方式，無法在 MCP 重啟後接回或接管。

主導者取第一個不是套件啟動器的祖先：以命令列精準跳過 `npx-cli.js`、
`npm-cli.js exec`／`x`，以及執行 npx／npm exec 的 `cmd.exe`、POSIX `sh` 包裝。
Claude Code 本身以 Node 執行時仍保留它，因此直接 node 與上方 npx 註冊方式都支援接回。
server／主導者身分查不到會寫 stderr，後續 check 重試；命令列只用於辨識，不存入 metadata。

`meta.json` 保存 agent、model、effort、40 字任務摘要、workFolder、session 欄位，
及主導者／server／runner／worker 的 PID＋建立時間＋名稱，不存完整 prompt。
runner 各以原子 rename 寫一次 meta 與 `exit.json`；exit 含 exitCode、signal、
endTime、timedOut、killed。寫端以 `lost.json` 記錄首次確認失聯時間，讓沉默很久後
才失聯的 job 也能保留 30 分鐘輸出。worker 的 stdout／stderr 由 OS 直接寫入已開好的
`stdout.log`／`stderr.log` fd，不逐塊經過 ai-cli。prompt 經暫存 stdin 檔傳入，
worker 不依賴 server，完成後刪除；log 可能包含 prompt 或模型回覆內容。
`bootstrap.json` 只保存啟動摘要與 runner PID，meta 寫入失敗仍可找到 job。
runner 身分查詢最多三次，間隔退避 250／500 ms；仍失敗就寫 failed 結果、
刪除 stdin，完全不啟動 worker。30 秒後仍無 meta 的 job 顯示 lost。
worker 已啟動卻寫不進 meta 時，runner 終止剛啟動的 worker，並盡力寫錯誤 exit。
Grok prompt 檔移入 job 目錄隨 job 回收；未接管的 staging 檔有退出／計時清理，
GC 也會清掉超過六小時的 staging 檔，不必等下次 Grok 派工。

讀端只留各檔 byte offset、解析進度與每個 stream 的最後 4 KiB；輪詢只讀新增 bytes，
verbose result 按需讀取，每個 stream 最多 8 MiB；超出時附
`stdoutTruncated`／`stderrTruncated` 的原始與顯示 byte 數，過大的解析回覆另附
`agentOutputTruncated`。更大輸出可直接讀磁碟 log。
`ai-cli run / ps / result / wait / jobs` 都用同一份 store，持久化 job 不再重複寫監看快照。
CLI `run` 最多等 15 秒握手；逾時仍以 exit 0 回 PID＋jobId 和 warning，應追蹤這筆 job，勿重派。
`jobs` 全程唯讀，`AI_CLI_WORKER=1` 下也能執行。

### 自動接管無主 job

原派工 session 結束後，MCP session 會自動接管同專案的合格 job，通常不必再下 prompt 或呼叫工具。
新 server 啟動後在背景立刻接管一次（通常幾秒內；不拖慢 ready 與第一個工具呼叫，接管成功後下一次 `list_processes`／`get_result` 就看得到），
之後每 60 秒的 GC 週期再檢查，涵蓋先開新 session、後關舊 session 的情況。

專案目錄取 MCP server 建構時的 cwd，新 MCP job 會寫入 `projectDir`；
「stdio MCP cwd＝session 工作目錄」只在 Claude Code 2.1.296 實測過，其他版本或其他 MCP 用戶端未驗證。
cwd 取不到（例如目錄已被刪除）時停用自動接管，手動不受影響。
新 job 必須與本專案目錄相同；舊 job 沒有 `projectDir` 時，`workFolder` 等於本專案或位於其下才算，
並檢查路徑邊界，避免相似前綴誤判。專案目錄是磁碟根目錄或家目錄時，舊 job 只接 `workFolder` 完全相同的，
不套前綴（否則底下所有專案的舊 job 都會被接走）；家目錄取不到時只套根目錄這條。Windows 不分大小寫，其他平台區分大小寫。
範圍限制避免其他專案的活躍 session 先搶走 job。

`AI_CLI_AUTO_ADOPT` 設為 `off`／`0`／`false`／`no`（去空白、不分大小寫）可停用自動接管，手動仍可用。
它要寫在 **MCP server 的 env 設定**裡（例如 Claude Code 的 MCP 設定或 codex `config.toml` 的
`[mcp_servers.<名稱>.env]`）；codex 只把白名單環境變數轉給 MCP server，在 shell 裡 export 不一定傳得到。

ai-cli 派出的 worker（claude／codex／grok）也會載入 ai-cli MCP，cwd 常是同一個專案。
**worker 底下的 MCP 不接管**：自動接管停用、手動 `adopt` 也拒絕，否則原 session 一關，worker 會把同專案的孤兒
連同自己的父 job 接走，使用者新開的 session 反而接不到。判定有兩層：環境有 `AI_CLI_WORKER=1`
（設了 `AI_CLI_ALLOW_NESTED=1` 時這層不擋，與派工限制同一語意），或 MCP 行程的祖先鏈上有尚未結束的 job 的
runner／worker（codex 可能漏轉標記時的備援；principal 本身就是 job 的 worker 時直接判定，否則從 principal 往上最多查 4 層——
runner 不可能在更上面）。祖先鏈查不到時視為無法確認，只停用自動接管。

| 介面 | 用法 |
| --- | --- |
| MCP `adopt` | 跨專案的手動備援。不給 `pid`／`jobId` 時列出候選；給其中一個或兩者時接管。PID 只選最新那筆，兩個參數必須指向同一筆。 |
| CLI `ai-cli adopt` | 唯讀候選 JSON。帶 PID／jobId 會拒絕，必須由接手的 MCP session 呼叫工具；CLI `ps`／`result`／`wait`／`kill` 本來就看得到所有 job。 |

候選帶 `projectDir`（舊 job 為 `null`）與 `autoAdopt`，表示本 MCP 會不會自動接它：在自動範圍內、開關未關、且不是 worker 底下的 MCP；
CLI 以目前 cwd、開關與環境標記預覽。候選的 `model` 與 list 相同（優先請求的模型），`status` 只依 `exit.json`／`lost.json` 判定。

只有已寫入 `meta.json` 且 runner 身分已確認的持久化 MCP job（Claude／Codex／Grok／Windows agy ConPTY）才可接管。
POSIX agy、direct-api 不可接管；CLI job 全域可見，但不適用 MCP 接管。
原派工 session 必須已結束：PID 不存在或 OS 建立時間不同才算確認；身分查詢失敗會拒絕。
principal 為 null（派工時辨識 principal 失敗）時改看派工的 MCP server：server 已確認結束才可接；
server 仍在或無法確認則自動、手動都拒絕（錯誤會說明是派工的 MCP server 仍在）。
principal 與 server 都是 null 的 job 不自動接管（候選的 `autoAdopt` 為 false），只能手動接。可接管時間為執行期間全程與結束後 30 分鐘，
另受下方共用容量上限約束；接管不重跑、不延長保留期。接管後立刻出現在該 session 的
`list_processes`／`get_result`／`wait`／`peek`／`kill_process`。
list／result 項目帶 `adopted: true`（不帶 `recovered`，那是同一 principal 重啟後接回），list 另帶 `model`；verbose result 另有完整 `adoptedFrom`，
依序保留原 principal／server 身分與接管時間。

已存在 `adopt.lock` 時一律拒絕；自動接管會跳過，同一 job 在同一 server 行程只記一次 log，其他 session 已接走則靜默跳過。
手動呼叫的錯誤列出完整路徑、持有者 PID 與建立時間（讀不到則為 `unknown`）。
只有確定沒有其他 session 正在接管該 job（例如接管中的 MCP 當掉），才手動刪除此檔後重試。
不自動回收殘留鎖：兩方同時清舊鎖時，可能刪掉另一方剛取得的新鎖，導致兩方都接管成功。

結束／lost 的 job 保留 30 分鐘；寫端啟動時及 unref timer 每 60 秒回收，超過 100 個
已結束 job 或共 500 MiB 時由最舊開始刪除，活著的 job 不刪。
`cleanup_processes` 立即清除已結束 job 的記憶體與磁碟；agy／direct-api 記憶體項目
也套用 30 分鐘回收。kill 先核對 runner 身分，再請 runner 終止 worker 整棵樹，
寫入 `killed: true` 後 runner 自己退出。
身分查詢失敗時終止可重試，成功送出終止才設 killed／timedOut。
GC 先 rename 成 `<UUID>.deleting` 再刪；檔案被鎖時保留待下輪重試，
無 meta 的孤兒須超過 30 秒啟動寬限且 runner 不在才清除。
每兩秒 check 只追蹤自己 server 的執行中 job；先用 `kill(pid, 0)` 看存活，
OS 身分快取最多 60 秒並與 GC 共用，kill 仍會即時重查建立時間。

額度查詢只對互動更新選單停止自動按鍵（更新可用標題加選項／游標，或
「Press Enter to update」）。npm→native installer 的被動提示及更新進度不算。
Codex 被更新選單擋住時，可退回近期 session rate-limit 紀錄，refresh 查詢也適用。

`live-jobs/` 保留給不可接回的 agy／direct-api 與 6.7.0 相容讀取，舊 CLI `cwds/`
也仍可讀；摘要 30 分鐘後到期，快照須能查證 owner 仍活著。
要聚合的 session 必須共用 `AI_CLI_STATE_DIR`。Windows 用 CIM、Linux 用 `/proc`、
macOS 用 `ps` 查身分；拿不到身分資料時不得據此接回或殺行程。
監看摘要的 `lastEvent` 最多 80 字，可能包含模型回覆片段。
舊 CLI job 的 PID 仍在但建立時間無法查證時，沿用 running 並附
`identityVerified: false`，表格派工端標示 `[unverified]`；此舊版退化行為無法排除 PID 重用。

### 接回驗收與監看修正

持久化 job 以 UUID `jobId` 為主鍵；OS 重用 PID 時仍保留全部未過期 job。
以 PID 呼叫 wait/result/peek/kill 時選最新 job，回傳包含 `jobId`。
MCP `get_result` 可同時給 `pid` 與 `jobId`，讀取較舊的保留結果。
TTY `jobs --watch` 使用替代畫面，離開時還原游標與畫面；非 TTY／JSON 仍逐次輸出。

Codex 的 `query_usage` 不論 fresh 與否，都先用 `codex app-server` stdio JSON-RPC 即時讀取額度，不建立 thread、不消耗模型 token。RPC 失敗時，非 fresh 可退回 10 分鐘內的 session 事件，最後才開 TUI；`/status` 必須在渲染後的輸入列回顯才送 Enter。服務原有 120 秒快取仍保留，`refresh=true` 跳過快取。結果附 `source`、`asOf`（RPC／session）、`cliVersion`、`fallbackReasons`，未實測版本落到 TUI 時附 `warnings`（目前實測 0.162.1）。RPC 視窗提供已用／剩餘百分比、可讀的 `resetAt` 與 ISO `resetAtIso`、方案、重置 credits 與可讀 `raw` 摘要；沒有額度時一定回 error。

`query_usage` 啟動 Codex 時帶 `-c check_for_update_on_startup=false`，
拿掉 `--no-daemon` 的退路也保留這個設定。Codex／Claude 出現更新提示時，
自動按鍵即停止並回錯誤；不修改使用者的全域設定。

## Claude Code 派工面板（選用外掛）

`ai-cli-jobs` 外掛會在輸入框上方用表格列出 job，並在下方提示行顯示一行摘要。
表格欄位是「狀態／來源／模型／任務／時間」：狀態寫成文字（✅ 成功、❌ 失敗、
❔ 中斷＝行程消失但沒留下結果、➖ 不追蹤），模型前的色點代表廠商
（🟠 claude、🟢 codex、⚫ grok、🔵 gemini、🟣 其他 API），執行中顯示「已跑 m:ss」，
完成顯示「N 分前」。

- **這個對話派的 job**：有 job 執行中時每 0.5 秒輪詢 `list_processes`，完成後留 2 分鐘。
- **其他對話、子代理、其他專案的 job**：每 5 秒直接讀 job store
  （`AI_CLI_STATE_DIR` 或 `~/.local/state/ai-cli/jobs/`），來源欄標「同專案」或「其他專案」，
  完成後留 10 分鐘；stdout 超過 5 分鐘沒動會標 💤。本對話子代理派的 job 在紀錄裡分不出來，歸在「同專案」。

兩者都不花模型 token。前提是 ai-cli 的 MCP server 名稱設定為 `ai-cli`。

### 安裝

在 Claude Code 終端機 session 的輸入框執行：

```text
/plugin install ai-cli-jobs --marketplace moerasermax/tkflyc-ai-cli
```

它會先詢問是否加入 marketplace，按 `y`，再選擇安裝 scope。
這個 marketplace 就是本 repo（`.claude-plugin/marketplace.json`），**不是** Anthropic 的官方外掛目錄。

### 更新：每台電腦要自己做

**面板不跟著 ai-cli 一起更新。** 它不在 npm 套件裡（`package.json` 的 `files` 不收 `plugins/`），
ai-cli 的自動更新（git pull）也碰不到它：Claude Code 執行的是安裝當下複製到
`~/.claude/plugins/cache/` 的副本。每台電腦要自己裝一次，之後每次改版各自更新：

```text
claude plugin marketplace update tkflyc-ai-cli
claude plugin update ai-cli-jobs@tkflyc-ai-cli
```

更新後重開 Claude Code 才生效；`claude plugin list` 看得到目前裝的版本。
也可以在 Claude Code 裡開 `/plugin` 選單更新。

### auto 權限模式與解除安裝

如果 Claude Code 使用 `auto` 權限模式，請在 `~/.claude/settings.json` 的
`permissions.allow` 加入 `mcp__ai-cli__list_processes`。面板是在背景輪詢，
沒有 auto 模式的分類器可以問，Claude Code 會直接拒絕這個呼叫（fail closed），
該列會一直轉圈並顯示「輪詢失敗：… refused」。

在 Claude Code 輸入框解除安裝：

```text
/plugin uninstall ai-cli-jobs@tkflyc-ai-cli
```

### 選用：底部狀態列

不想裝外掛、或想在 MCP 斷線時仍看得到全機 job，可以改用
`tools/statusline/ai-cli-status.mjs`：它是 Claude Code 的 `statusLine` 指令，
直接讀 job store，在畫面底部印一行。啟用方式寫在檔頭（在 `~/.claude/settings.json`
加 `statusLine` 欄位）。它同樣不在 npm 套件裡，要從 git 取得。

## 等待端怎麼知道 AI 還活著

`wait` 逾時只代表這次觀察時間用完，程序會繼續跑。以前兩條路徑都丟
`Timed out after N seconds`，MCP 把它包成 InternalError；呼叫端 AI 容易將它當成任務失敗而遺棄 pid。
現在 MCP 與 CLI 都**回傳目前結果的陣列**，只有逾時時仍 `running` 的項目帶 `timedOut: true`。
不存在的 pid 仍是錯誤。`completed` / `failed` / `lost` 都不帶 `liveness` 或 `timedOut`。

`get_result`、`wait`、`list_processes` 的 running 項目都有同一個 `liveness` 物件，compact 與 verbose 都會回：

| 欄位 | 型別 | 意義 |
|------|------|------|
| `alive` | boolean | 持久化 job：尚無 exit，且 runner／worker 未被確認消失；不可接回的 MCP job：尚未收到 close；舊 file job：PID 存在且無 exit-status。它表示程序存活，不能保證模型正在產生答案 |
| `elapsedSec` | number | 從啟動到現在的秒數，可含小數 |
| `sinceLastOutputSec` | number / null | 距最後 stdout / stderr chunk 的秒數；從未輸出是 null |
| `stdoutBytes` | number | 收到的 stdout 位元組數；PTY 合併的輸出也計入 stdout |
| `stderrBytes` | number | 收到的 stderr 位元組數 |
| `lastEvent` | string / null | 最後一個有意義事件的一行摘要，最多 120 字；Codex 含事件 type、item.type 及最多 80 字的 command / text，Claude 含 type 與工具名，agy 去 ANSI，direct-api 取 type |
| `eventCount` | number | 已解碼的完整、有意義事件數；空行、壞 JSON 與未完成半行不計 |
| `hint` | string | 給 AI 的英文建議：starting up、最近有輸出、活著但沉默，或等待結束 metadata |

`list_processes`（CLI 為 `ps`）還會在 running 項目直接放 `elapsedSec`、`sinceLastOutputSec`、`lastEvent`，
方便快速掃描。已結束的項目只在知道結束時間時附 `elapsedSec`，該時間不再隨輪詢增加。
file 路徑沿用 `lost`：PID 消失且沒有結束回報表示結果未知，不能當成 failed。
PTY 在 OS PID 消失到寫下 exit-status 之間，可能短暫顯示 running 且 `alive: false`。

檔案版從 stdout / stderr 檔的 size 與非空檔 mtime 推導統計，不需要啟動它的 CLI 留在記憶體。
內部 `lastOutputAt` 是 ISO 時間；file 以 mtime 近似，兩個串流的事件先後也只能近似。
為了讓 `eventCount` 完整，新讀端首次逐塊掃描輸出檔，同一讀端接著只讀新增 bytes。

建議每次 `wait` 使用 **90 秒或更短**的 timeout，持續保存原 pid 並重複等待。
只要 `liveness.alive` 是 true，就不要因為逾時而遺棄它或另啟一份相同任務。
需要看即時訊息／工具事件時呼叫 `peek`；它只觀察這次視窗的新事件，不回放歷史，也不會回傳 Codex reasoning 內容。

以下假設已有連線的 MCP `client` 與 `run` 回傳的 `pid`：

```js
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content[0].text);
  return JSON.parse(response.content[0].text);
};

for (;;) {
  const [result] = await call('wait', { pids: [pid], timeout: 90 });
  if (result.status !== 'running') {
    console.log(result); // completed / failed / lost：依實際狀態處理
    break;
  }
  console.log(result.liveness.hint);
  console.log(await call('peek', {
    pids: [pid], peek_time_sec: 10, include_tool_calls: true,
  }));
  // 保留 pid，回到 wait；timedOut 不是任務失敗。
}
```

CLI 同樣印 JSON：`ai-cli wait <pid> --timeout 90` 的 exit code 為 **3 = 逾時且仍 running**、
**0 = 全部已結束**（不代表每個任務成功）、**1 = 呼叫錯誤**。輪詢程式要接受 3 並繼續等。

**codex 在推理時零輸出是正常的。** `exec --json` 送出 `turn.started` 後，到第一個 item 完成之前
可能幾分鐘沒有 stdout；Claude 推理時也可能沉默。因此有輸出但靜默未滿 120 秒時 hint 建議 keep waiting；
超過 120 秒且 alive 時會說明 reasoning 可能沒有輸出。完全沒輸出時，前 30 秒顯示 starting up，
30 秒後仍 alive 則建議繼續等待或 peek。

使用者於 **2026-09-05 本機 trivial prompt 實測**：啟動到 `thread.started` 約 **0.3–1.2 秒**；
載入 `~/.codex/config.toml` 的 4 個 MCP servers（含 ai-cli 自己），比 `--ignore-user-config` 整體多 **1–2 秒**；
gpt-6-astra medium 回一個字約 **5.7 秒**，gpt-5.4-mini low 約 **6.5 秒**。
這些是單機量測，主要等待發生在模型端推理；本功能讓等待端看得見程序狀態，不改模型速度。
回歸驗證使用 stub，不重打真實供應商：`node verify-liveness.mjs`。

## AI 啟動熔斷器（circuit breaker）

為避免「呼叫端框架 bug 造成無窮迴圈、對 AI 供應商狂打請求、進而被誤判為共用帳號或濫用而違規」，
框架在啟動任何子程序前會先經過熔斷器（`src/core/circuit-breaker.ts`）。它偵測兩種迴圈特徵：

- **爆量（rate）**：滑動視窗內啟動次數超過 `AI_CLI_BREAKER_MAX_STARTS`。
- **重複（duplicate）**：視窗內「同一 agent + 同一 prompt」次數超過 `AI_CLI_BREAKER_DUP_LIMIT`。

觸發後進入冷卻（`AI_CLI_BREAKER_COOLDOWN_SEC`），期間擋下所有啟動並回傳清楚錯誤，冷卻結束自動恢復。
所有門檻見上方環境變數表；正常用量不會誤觸。驗證：`npm run build && node verify-breaker.mjs`。

## 與舊 dist 的差異

- 移除了已壞掉的 gemini 殘留（舊 dist 的 cli-parse / app-cli 還 import 不存在的
  `parseGeminiOutput` / `findGeminiCli`，本版一併修正）。
- usage 外掛路徑由寫死改為 `AI_CLI_USAGE_PLUGIN_BIN` 環境變數。
- ConPTY 與各 agent 行為以 registry 重構。3.0.0 當時對外 MCP 行為與舊 dist 等價，
  **但之後已經分歧**：4.0.0 移除了 OpenCode agent 與 `oc-*` model routing（改用 direct-api），
  並新增 `set_config` 與 `query_usage` 兩個工具（加上 `adopt`，目前共 12 個）。詳見 `CHANGELOG.md`。

## 與上游原專案的關係

本專案起初是 [mkXultra/ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp)（MIT）的
clone，而後者又衍生自 Peter Steinberger 的 `claude-code-mcp`（MIT）。
**上游沒有停止維護**——最新版 `3.1.0` 發佈於 2026-09-30（2026-11-07 查證）。
這不是接手一個沒人管的專案，是架構上刻意分歧的 fork。要原版請用
[`ai-cli-mcp`](https://www.npmjs.com/package/ai-cli-mcp)。
完整歸屬與保留的 MIT 條款見 [NOTICE](NOTICE)。

此後經過大幅重寫。以上游 v2.23.0 為基準實測，本專案 1,980 行實質原始碼中有 299 行
（約 15%）仍與上游相同，**集中在 MCP 工具表面**（工具名稱、description、schema）
與 CLI/MCP 進入點。以下是本專案新增的部分：

- **registry 架構**。上游把五個後端寫死；這裡 `src/agents/` 一個 CLI 一個檔、是唯一
  擴充點，`src/core/` 是機器本體，加後端不動它。
- **`direct-api`** —— 自己接任何第三方 OpenAI-compatible provider，而不是只能用
  別人編進去的那幾個 CLI。
- **熔斷器**，擋爆量啟動與重複 prompt，避免框架迴圈變成對供應商的異常流量。
- **ConPTY runner**，給只在真 TTY 下才輸出的 CLI。
- **帶 provenance 的模型目錄**（每筆說得出出處與能不能派工）＋ 派工建議表。
- **背景自動更新**（subprocess apply + rollback）。
- **會說實話的回傳值**。`wait` 逾時回 liveness 而不是丟錯；job 狀態區分 `lost` 與
  `failed`；`doctor` 對沒驗的項目回 `null` 而不是 `false`。呼叫端是 AI，它只看得到
  回傳值，所以回傳值必須說出「實際知道什麼」。

套件發佈為 `@tkflyc/ai-cli-mcp`；npm 上不帶 scope 的 `ai-cli-mcp` 屬於上游。

## 授權

Apache-2.0，見 [LICENSE](LICENSE)。

本專案是衍生作品，原始程式最初以 MIT 授權釋出。原始的著作權聲明與保留的 MIT 條款在
[NOTICE](NOTICE)，它隨每一份副本散布（已列入 `package.json` 的 `files`）。

維護者驗收流程（Worker 身分、重啟接回、Grok 唯讀強制力）見 [tools/acceptance/README.md](tools/acceptance/README.md)。
