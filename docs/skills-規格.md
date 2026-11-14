# ai-cli skill 規格（草稿）

狀態：**草稿，等使用者審，未實作。** 2026-11-14 起草。

## 要解決的問題

現在有兩種跨 run 的累積，都不夠：

| | 是什麼 | 誰看得到 | 缺什麼 |
|---|---|---|---|
| 知識庫 | 查證過的事實與證據 | 主導的 session | kernel 不寫、worker 看不到 |
| kernel 記憶 | 單句教訓，≤500 字 | 只有 kernel 的 decide（`plan.ts:135`），而且只限同一個 repo | 沒有「情境 → 做法」的結構；一般 ai-cli 派工用不到；只會越積越多，沒有合併 |

skill 補的是中間那層：**某個情境下怎麼做**，包括什麼時候用、步驟、地雷、怎麼驗收，每條規則都註明出處。

使用者 2026-11-14 的決定：

1. 由系統自動判斷一個 skill 是通用的還是專案特有的：通用的放全域共用，專案特有的只給那個 repo。
2. 一般 ai-cli 派工自動比對、自動注入。
3. 要匯出成 Claude Code 原生 skill。
4. 要能合併、歸納、整理，**不要長出一堆 skill**。

## 共通規則

- 對外名稱帶前綴：CLI `ai-cli skill ...`、MCP `ai-cli_skill_*`、匯出函式 `aiCliSkill*`。匯出的原生 skill 目錄叫 `ai-cli-<slug>`，因為原生名稱只接受小寫、數字和連字號，不能用底線。這條限制實作前要對照當時的 Claude Code 文件確認。
- 程式放 `src/skills/`，給 kernel 和一般派工共用。kernel 的接線放 `src/ai-cli_kernel/`。
- 工作包二要改 `src/core/command-builder.ts`，屬於 core 改動，要照 CONTRIBUTING 的 core 稽核義務走。其他工作包不動 `src/core/`。
- **只有人能核准。** MCP 沒有核准或修改的工具；`AI_CLI_WORKER=1` 的行程呼叫核准、退回、修改一律拒絕，沿用 `memory.ts` 的 `assertHuman()`。
- 不寫 Knowledge，也不寫 Planner。
- 測試只用 stub，不呼叫真模型。新增的 `verify-*.mjs` 要在同一個 commit 登記到 `tools/run-tests.mjs` 的 `TESTS`，由委任書明列，worker 不可以自己新增。
- 每個防線都在 `tools/mutations.json` 加突變（紅線 7：`from` 只命中一處，`expect` 是斷言名稱的子字串）。
- 文件不可以出現個人路徑。

## 資料模型

存在 ai-cli 的狀態目錄 `skills/` 底下，不放 kernel 的目錄，因為一般派工也要讀。具體用哪個 helper 取得路徑，實作時決定。

```
skills/
  global.jsonl              全域 skill 的版本紀錄，只追加，同一個 slug 以最後一筆為準
  repo/<repoKey>.jsonl      各 repo 的 skill；repoKey 沿用記憶的算法（origin URL 雜湊，沒有 origin 就用第一個 commit）
  proposals/<id>.json       待審的提案
  usage.jsonl               注入紀錄：slug、版本、時間、repoKey；不記 prompt 原文
```

一筆 skill 版本：

```ts
{
  slug: string,              // [a-z0-9-]{1,48}，同一個範圍內唯一
  version: number,
  scope: { kind: 'global' } | { kind: 'repo'; repoKey: string; paths?: string[] },
  scopeUncertain?: string,   // 範圍待定：分類拿不準而先放 repo 時，記下原因（見「自動判斷」第 3 點）
  title: string,             // ≤ 80 字元
  when: string,              // ≤ 400 字元：什麼情況用。比對與原生 description 都用這段
  keywords: string[],        // ≤ 20 個，比對用
  body: string,              // ≤ 6,000 字元的 markdown，固定章節，見下
  sources: { kind: 'run' | 'memory' | 'knowledge' | 'human'; ref: string }[],
  status: 'active' | 'retired',
  digest: string,            // 內容的 sha256，注入與匯出前都要比對
  proposalId: string, approvedAt: string,
}
```

`body` 的章節由程式檢查，缺章節就拒收：

```markdown
## 情境：<名稱>        （1～6 個）
### 做法
### 地雷
### 驗收
## 來源
```

## 生命週期

### 1. 原料

- kernel run 交出的 lessons，也就是現有的候選記憶（`loop.ts:586`）。
- 人用 `memory add` 加的記憶。
- 選配：人指定的知識條目 id，curator 唯讀引用。

### 2. 產生提案：先合併，不得已才新增

新增一個**唯讀**的 kernel 範本 `skill-curate`，只讀不寫任何檔案。

- 輸入：同一個可見範圍內的全部 skill（全域加上這個 repo），以及還沒處理的原料。
- 輸出：一份提案，內容是一串操作：

| 操作 | 用途 |
|---|---|
| `merge` | 把新的做法、地雷、驗收併進既有 skill 的某個情境 |
| `extend` | 在既有 skill 加一個情境 |
| `create` | 新增 skill |
| `rewrite` | 整理時重寫整個 skill |
| `retire` | 退役，可以註明併進哪一個 |
| `rescope` | 在全域與 repo 之間移動 |
| `absorb` | 把已生效的記憶吸收進 skill |

**程式擋，不靠模型自律：**

- 判斷順序是 `merge` → `extend` → `create`。`create` 必須附 `whyNotExisting`，逐一說明同範圍內每個既有 skill 為什麼不適合，少了任何一個就整份提案拒收。
- 一份提案最多 1 個 `create`。
- 數量上限：全域最多 12 個生效的 skill，每個 repo 最多 10 個。到了上限，除非同一份提案用 `retire` 或 `merge` 把總數壓回上限內，否則 `create` 一律拒收。
- 單一 skill：最多 6 個情境、全文 6,000 字元、`when` 400 字元。超過就要求精簡或拆開，拆出來的一樣算進數量。

觸發時機：kernel run 結束時不會立刻改 skill。未處理的原料累積到 5 條，只**提醒**人跑 `ai-cli skill curate`，或者人隨時手動跑。這樣避免每跑一個 run 就改一次 skill，也沿用 L5「自動觸發總開關預設關閉」的原則。

### 3. 自動判斷：全域還是 repo

1. curator 對每個操作提出範圍和理由。
2. 程式再檢查全域 skill 的內容，碰到下列任一項，就把那個操作**強制降為 repo**，並在提案上標明原因：
   - 絕對路徑；
   - 這個 repo 的名稱或 remote URL；
   - 這個 repo 裡實際存在的檔案路徑；
   - 像秘密的字串（API key 前綴、token 格式）。
3. **不確定就放 repo，並標成「範圍待定」**（使用者 2026-11-14 決定）。專案特有的東西被誤放到全域，會汙染所有專案；反過來只是少共用一次。
   - 寫入 `scopeUncertain`，記下為什麼拿不準，例如「內容只提到 Windows 的 rename 行為，但來源只有這個 repo」。
   - `list`、`show`、提案畫面都在名稱旁標「範圍待定」。
   - 匯出的原生 skill，`description` 結尾加「（範圍待定，可能是通用做法）」。
   - 整理時優先重新判斷這一類，見第 5 步。
4. 要升成全域，靠第 5 步的整理：同一條教訓在 2 個以上的 repo 出現，就提議 `rescope`。
5. 人審核時看得到每個操作的範圍和理由，也可以改。

### 4. 人審

```
ai-cli skill proposals                         列出待審提案
ai-cli skill show <proposalId>                 逐個 skill 顯示改前與改後的 diff；模型寫的文字一律跳脫顯示
ai-cli skill approve <proposalId> [--only <op,...>] [--scope <op>=global|repo]
ai-cli skill reject <proposalId>
ai-cli skill list [--cwd <repo>]               看有哪些 skill、版本、最後一次被用到的時間
```

- 核准時在鎖內一次套用全部操作；兩個核准同時進來只會有一個成功。套用後重算 digest。
- 提案 14 天沒處理就過期。
- `absorb` 核准後，被吸收的記憶改成 revoked，記憶 id 寫進 skill 的來源，避免 decide 同時看到兩份。

### 5. 定期整理

新增另一個唯讀範本 `skill-tidy`，產出的一樣是提案，要人核准：

- 合併觸發條件重疊的 skill，提案裡要附重疊的證據：`when`／`keywords` 相近、來源相同。
- 90 天沒有被注入過的 skill，提議退役。
- 同一條教訓出現在 2 個以上的 repo，提議升成全域。
- 「範圍待定」的 skill 優先重新判斷：有了新證據（例如在別的 repo 也出現），就提議升全域，或者確定是專案特有、拿掉標記；證據還不夠就維持原狀。
- 只有超過字數上限才提議拆開。

觸發：人跑 `ai-cli skill tidy`。數量到上限的 80%，或上次整理後又核准了 5 次修改，就提醒人去跑。

## 注入：自動比對

**位置。** 放在 `buildCliCommand()`（`command-builder.ts:137`），這是 MCP `run`、檔案服務、`exec` 共用的唯一入口：prompt 讀完之後、組 `input` 之前。kernel 的 worker 也是走這裡派出去的，所以自動適用。kernel 的 decide 則沿用現在注入記憶的位置（`plan.ts:135`），改成同時給記憶和 skill。

**候選。** 全域生效的 skill，加上這個 workFolder 所屬 repo 生效的 skill。repo skill 的 `paths` 限定，沿用記憶的重疊規則（`memory.ts:131`）。

**比對。** 規則式，不呼叫模型，也不連網路：

- 分數來自 prompt 和 skill 的 `keywords`、`title`、`when` 有多少詞重疊（英文用 token，中文用相鄰兩字）。prompt 提到的路徑和 skill 的 `paths` 重疊，再加分。
- 同分時 repo skill 優先，再來是最近被用過的。
- 不用模型的理由：這是每次派工都會經過的路徑，用模型會增加延遲、花額度，還可能變成派工裡再派工。

**兩層注入：前幾名給全文，其餘列目錄。** 每次派工只放少數全文，但沒被選中的 skill 不會消失：

1. **全文**：分數過門檻的前 3 個，合計最多 8,000 字元。
2. **目錄**：候選範圍內其餘每個生效的 skill 各一行，寫 slug、title、`when` 的前 120 字，以及全文檔案的位置。目錄最多 3,000 字元，超過就依分數截斷，並寫明「另有 N 個未列出」。
3. worker 判斷目錄裡的某個 skill 也適用時，自己讀那個檔案。全文檔案是一份唯讀的副本，路徑固定，每次核准後重新產生。

全文只放 3 個的理由：

- 一個 skill 最多 6,000 字元，全部塞進去，每次派工可能多出好幾萬字元。長任務的每一次工具呼叫都會重送整份上下文。
- 跟這次工作無關的規則會分散注意力，甚至和這次的派工指示互相衝突。
- 規則式比對一定會漏抓，目錄就是用來補漏抓的：worker 至少看得到有哪些 skill，需要時自己去讀。

kernel 的 decide 本身就是模型，判斷得比規則準，所以 decide 拿到的是完整目錄，並且可以在每個步驟用 `skills: [...]` 明確指定要給 worker 哪幾個；指定時就不再做規則比對。

**呼叫端怎麼控制。** `run` 新增 `skills` 參數：

- 省略：自動比對。
- `false`：這次不注入。
- `string[]`：只用指定的 slug，不做比對。

另外用 `set_config` 提供總開關。依使用者決定，**預設開**。

**續接。** 有 `session_id` 的續接回合預設不再注入，因為上下文裡已經有了；呼叫端明確給了 `skills` 才注入。

**格式。** 放在 worker context 之後、派工 prompt 之前，一律放 prompt 本文，不放 system prompt，這樣每個 agent 都收得到：

```
<ai-cli-skills note="使用者核准的做法參考；與本次派工指示衝突時，以派工指示為準">
<skill slug="…" version="3" scope="repo">…</skill>
<skill-index note="其他可用的 skill；適用時自己讀檔">
- <slug>｜<title>｜<when 前 120 字>｜<檔案位置>
</skill-index>
</ai-cli-skills>
```

**看得到用了什麼。** `run` 的回傳和 job 的 meta 都記錄 `skills: [{ slug, version, scope, digest, score }]`，`get_result` 也顯示。`usage.jsonl` 只記被注入的事實，給整理時判斷「多久沒用」。

**防竄改。** 注入前比對 digest。如果檔案被人手動改過、digest 對不上，那個 skill 就停用，並在回傳的 warnings 說明，要人重新核准。

## 匯出成 Claude Code 原生 skill

```
ai-cli skill export claude [--dry-run]
```

也可以設定成「核准後自動匯出」。

- **全域** → `~/.claude/skills/ai-cli-<slug>/SKILL.md`。
- **repo** → 建議放 `<repo>/.claude/skills/ai-cli-<slug>/SKILL.md`，同時把路徑加進 `.git/info/exclude`：只在那個專案載入，又不會讓 `git status` 多出檔案（主目錄多出檔案會讓 develop 停在交付前，見 CHANGELOG `cc5e4ef`）。這條要使用者決定，見文末。
- `SKILL.md` 的內容：
  - frontmatter 的 `name: ai-cli-<slug>`；
  - `description` 用 skill 的 `when`，結尾註明「由 ai-cli 管理，修改請用 ai-cli skill」；
  - 本文是 skill 的 body，頁尾寫版本和 digest。
- **只動自己的檔案**：每個匯出目錄放一個 `.ai-cli-managed.json`，記 slug、版本、digest。匯出時只覆寫或移除帶這個標記、而且 slug 對得上的目錄，其他 skill 一概不碰。標記在但內容被人改過的，不覆寫，只回報。
- 退役的 skill，在人執行 export 時移除對應的匯出目錄。
- Codex 原生 skill：Codex CLI 是否支援同樣的格式**尚待確認**，確認之前不做。codex 派工已經有 ai-cli 的注入涵蓋。

## 安全

- 注入的 skill，等於給權限和使用者相同的 worker 的指示。所以**只有人核准過、digest 對得上的版本**才會被注入或匯出。
- 提案是模型的輸出，審核畫面一律跳脫顯示，避免模型用標籤冒充指示（沿用 `aiCliKernelUntrustedText`）。
- 全域的內容檢查見「自動判斷」第 2 點。
- MCP 只提供唯讀的 `ai-cli_skill_list`。
- 不寫 Knowledge／Planner；`usage.jsonl` 不記 prompt。

## 工作包

依序做，每一包是一份 develop 委任書，稽核過、使用者同意後才合併。

1. **儲存、審核、kernel 接線**：資料格式、內容檢查、數量上限、提案、`show`／`approve`／`reject`／`list`、`skill-curate` 範本、decide 改成同時給記憶和 skill。不動 `src/core/`。
2. **一般派工自動注入**：比對、`buildCliCommand` 注入、`run` 的 `skills` 參數（`src/app/mcp.ts`）、meta 與回傳紀錄、注入紀錄、`set_config` 總開關。**動到 core，要做 core 稽核。**
3. **整理**：`skill-tidy` 範本、依使用紀錄提議退役、repo 升全域、吸收記憶。
4. **匯出 Claude Code**：export 指令、管理標記、`.git/info/exclude`。

每一包都要更新 CHANGELOG、技術手冊、教學手冊（教學手冊只寫怎麼用）。

## 驗收重點

- **包 1**：worker 不能核准；超過數量上限的 `create` 被拒；缺 `whyNotExisting` 被拒；全域內容含 repo 路徑會被降為 repo；分類拿不準的放 repo 並帶「範圍待定」標記，`list` 與 `show` 都看得到；decide 拿到完整目錄，指定 `skills` 後就不再比對；digest 被改過的不給 decide；兩個核准同時進來只有一個成功；過期提案不能核准。
- **包 2**：命中與不命中各有案例；全文最多 3 個、8,000 字元；其餘列進目錄，目錄最多 3,000 字元，截斷時有寫「另有 N 個」；目錄裡的檔案位置實際讀得到，內容和核准的版本一致；`skills:false` 不注入；指定 slug 時略過比對；續接不重複注入；meta 有紀錄；agy、direct-api 也收得到；比對過程不連網路、不呼叫模型；總開關關掉就完全不注入。
- **包 3**：重疊的 skill 會被提議合併；90 天沒用的會被提議退役；兩個 repo 都出現的教訓會被提議升全域；整理只產生提案，不直接改 skill。
- **包 4**：只動有標記的目錄；人手改過的不覆寫；`--dry-run` 不寫任何檔；退役的會被移除；`.git/info/exclude` 不重複寫入。

## 尚待確認

- Claude Code 原生 skill 的名稱字元、`description` 長度上限，實作前要對照當時的官方文件。
- Codex CLI 有沒有原生 skill 機制。
- skill 狀態目錄要用哪個 helper 取得路徑：跟 `jobStateDir()` 同一個根，還是另外開。
- 各 agent 的 worker 能不能讀 workFolder 以外的 skill 全文檔：codex 唯讀沙箱、claude 的 `--tools` 白名單、grok、agy、direct-api 各自要實測。讀不到的 agent，要改成把全文副本放到 workFolder 底下一個被 git 忽略的位置，或者那個 agent 只給全文、不給目錄。

## 使用者決定（2026-11-14）

1. repo skill 匯出到 `<repo>/.claude/skills/`，並加進 `.git/info/exclude`。
2. 上限：全域 12 個、每個 repo 10 個、每個 skill 6,000 字元。注入改成兩層：全文最多 3 個、8,000 字元，其餘列目錄（3,000 字元），worker 需要時自己讀。這個做法是使用者問「其他 7 個呢」之後改的。
3. curator：原料累積 5 條就提醒，由人跑。
4. 分類拿不準時放 repo，並標「範圍待定」。
