# 專案既定流程

在 Claude Code 與 Codex 開場載入同一份流程。每個專案由 Planner 辨識，進度來源、交付位置與額度由該專案自行設定。執行 hook 需要 Node.js 20.19 以上。Stop 另使用 Git，歸檔補充使用既有的 Python 3 歸檔腳本。

## Claude Code

```
claude plugin marketplace add moerasermax/tkflyc-ai-cli
claude plugin install ai-cli_project-flow@tkflyc-ai-cli
```

已加入 marketplace 時，可直接安裝。更新時先跑 `claude plugin marketplace update tkflyc-ai-cli`，再跑 `claude plugin update ai-cli_project-flow@tkflyc-ai-cli`。重開 Claude Code 生效。

## Codex

從長期保留的 ai-cli repo 執行。hook 以絕對路徑指向該 checkout。

```
node plugins/ai-cli_project-flow/install/codex-install.mjs --dry-run
node plugins/ai-cli_project-flow/install/codex-install.mjs
```

腳本在變更前備份 `~/.codex/hooks.json`，結構化合併三個事件，並同步 `~/.agents/skills/project-flow/SKILL.md`。安裝後重開 Codex，在 `/hooks` 信任這三支 hook。更新或移動 checkout 後重跑腳本可同步 skill 和命令路徑。執行 `--uninstall --dry-run` 可預覽移除，`--uninstall` 則移除此外掛的 hook 與 skill，保留其他 hooks 和備份。信任步驟見 [Codex hooks 文件](https://developers.openai.com/codex/hooks)。

## Planner 與專案設定

- 在啟動 Claude Code 或 Codex 的環境提供 `PLANNER_URL` 與 `PLANNER_TOKEN`，或設定 `PLANNER_ENV_FILE` 指向 Planner 的 `.env.local`。也可設定 `PLANNER_ROOT` 指向含該檔的 Planner 目錄。環境變數優先於檔案。伺服器本機的 `PORT` 與 `PLANNER_API_TOKENS` 格式也可讀。hook 使用 bearer token。
- hook 依最近的 `.planner-id` 或已登錄的 GitHub origin 查詢專案，沿用 Planner 的 Git 邊界與 worktree 回指。請先在 Planner 登錄專案。確認根目錄後，依 [設定範本](templates/_流程設定.md) 建立設定檔。有效即為 READY。已辨識但格式或欄位有誤為 INVALID。其餘為 INIT，只顯示可初始化。
- 查詢上限為 2.5 秒。Planner 離線或未設定時，讀取 `~/.ai-cli/project-flow/cache.json` 中同一路徑及 marker／origin 的已確認身分，明示快取時間。設定檔每次都從專案根重讀。從未確認的資料夾為 INIT。

## Hook 行為

- SessionStart 從 skill 正典擷取開場規則。Codex 已安裝 skill 與 checkout 正典有分歧時會提示重新同步。
- Stop 以開場的 Git 狀態為基準，包含 HEAD、工作區差異和未追蹤檔案內容。找到新指紋且回覆缺收尾證據時攔一次。沒有可靠的 Git 基準或最終回覆、續跑中的 Stop，以及 `AI_CLI_WORKER=1` 都放行。此檢查識別回覆中的證據線索，驗證證據真實性仍由 R3 負責。
- UserPromptSubmit 只接受 `~/.claude/scripts/archive_trigger.py --check` 的 `COMMAND` 結果，再補 R6 與 S11。找不到腳本就略過。可用 `PROJECT_FLOW_PYTHON` 指定 Python 3 路徑。
