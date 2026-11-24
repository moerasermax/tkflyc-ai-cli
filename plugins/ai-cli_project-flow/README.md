# 專案既定流程

在 Claude Code 與 Codex 開場載入同一份流程。每個專案由 Planner 辨識，進度來源、交付位置與額度由該專案自行設定。執行 hook 需要 Node.js 20.19 以上。Stop 另使用 Git，歸檔補充使用既有的 Python 3 歸檔腳本。

## Claude Code

```
claude plugin marketplace add moerasermax/tkflyc-ai-cli
claude plugin install ai-cli_project-flow@tkflyc-ai-cli
```

已加入 marketplace 時，可直接安裝。更新時先跑 `claude plugin marketplace update tkflyc-ai-cli`，再跑 `claude plugin update ai-cli_project-flow@tkflyc-ai-cli`。重開 Claude Code 生效。

## Codex

從長期保留的 ai-cli repo 執行。hook 以絕對路徑指向該 checkout，並以 PATH 尋找 `node`。請確認啟動 Codex 的環境可執行 `node --version`。

```
node plugins/ai-cli_project-flow/install/codex-install.mjs --dry-run
node plugins/ai-cli_project-flow/install/codex-install.mjs
```

腳本在變更前備份 `~/.codex/hooks.json`，結構化合併三個事件，並同步 `~/.agents/skills/project-flow/SKILL.md`。安裝後重開 Codex，在 `/hooks` 信任這三支 hook。更新或移動 checkout 後重跑腳本可同步 skill 和命令路徑。執行 `--uninstall --dry-run` 可預覽移除，`--uninstall` 則移除此外掛的 hook 與 skill，保留其他 hooks 和備份。若回報安裝鎖，先確認沒有其他安裝程序，再檢查訊息所列路徑。信任步驟見 [Codex hooks 文件](https://developers.openai.com/codex/hooks)。

## Planner 與專案設定

Planner 依序尋找連線設定。

1. 啟動 Claude Code 或 Codex 時的 `PLANNER_URL` 與 `PLANNER_TOKEN`。也可用 `PLANNER_ENV_FILE` 指向 `.env.local`，或用 `PLANNER_ROOT` 指向含有該檔的 Planner 目錄。檔案也支援伺服器本機的 `PORT` 與 `PLANNER_API_TOKENS`。
2. 使用者設定檔 `~/.ai-cli/project-flow/config.json`。指定 `plannerEnvFile` 或 `plannerRoot` 的絕對路徑，例如 `{"plannerRoot":"D:/WorkSpace/02_產品_products/tkflyc/planner/tkflyc-planner"}`。
3. 從 `~/.claude/settings.json`、`~/.codex/hooks.json` 的 hook 命令尋找 `tkflyc-planner/mcp/session-start-hook.mjs` 或 `session-end-hook.mjs`，讀取該 Planner 根目錄的 `.env.local`。JSON 檔使用 UTF-8，命令中含空白的路徑請加引號。

hook 依最近的 `.planner-id` 或已登錄的 GitHub origin 查詢專案。Linked worktree 的 Planner 身分對應主 repo。注入的專案根始終是目前 checkout，並標明實際讀取的 `_流程設定.md`。在 worktree 找不到檔案才回退到主 repo。依 [設定範本](templates/_流程設定.md) 填完設定後，有效即為 READY，格式、缺項或仍為佔位值的欄位會顯示 INVALID。找不到可查詢的身分、Planner 查無專案或缺設定檔時，開場提示可初始化。

查詢上限為 2.5 秒。Planner 離線或未設定時，從 `~/.ai-cli/project-flow/cache.json` 讀取同一路徑及 marker／origin 的已確認身分，並標示快取時間。若沒有可用快取且缺連線設定，開場顯示「Planner 未設定（看 README）」。若連線設定已備妥，但查詢失敗且沒有可用快取，開場顯示「Planner 無法連線，暫時無法判定（無快取）」。Planner token 只用於 Gateway 的授權標頭。

## Hook 行為

- SessionStart 從 skill 正典擷取開場規則。Codex 已安裝 skill 與 checkout 正典有分歧時會提示重新同步。
- Stop 以開場 Git 狀態為基準，比對 HEAD、工作區差異和未追蹤檔案內容。同一批 Git 改動缺收尾證據時攔一次。純文件改動只檢查進度更新。文件含根目錄下的 `docs/` 及副檔名為 `.md`、`.markdown`、`.txt`、`.rst`、`.adoc`、`.asciidoc` 的檔案，大小寫皆可。若改名，來源與目的地都納入判斷。
- Stop 在缺少可靠 Git 基準、payload 缺少或留空 `last_assistant_message`、`stop_hook_active` 為 true，或 `AI_CLI_WORKER=1` 時放行。開場會回收超過 14 天的 `checked-*`、`session-*` 狀態檔。此檢查識別回覆中的證據線索，驗證證據真實性仍由 R3 負責。
- UserPromptSubmit 依 `~/.claude/scripts/archive_trigger.py --check` 的 `COMMAND` 結果補充 R6 與 S11。找不到腳本或 Python 時略過。可用 `PROJECT_FLOW_PYTHON` 指定 Python 3 路徑。
