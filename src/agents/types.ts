/**
 * Agent 定義系統 — 整個框架「可擴充」的核心。
 *
 * 新增一個 AI agent = 新增一個 src/agents/<name>.ts 檔，實作 AgentDefinition，
 * 然後在 registry.ts 註冊。core/ 不需要任何改動。
 */

/** 所有已支援的 agent id。新增 agent 時在此加入字面量。 */
export type AgentId =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'antigravity'
  | 'direct-api';

/** spawn 策略：決定 process-service 怎麼啟動這個 agent 的子程序。 */
export type SpawnMode =
  | 'pipe' // 一般 child_process.spawn + pipe（大多數 agent）
  | 'pty' // Windows ConPTY（agy 之類在非 TTY 下不輸出的 CLI）
  | 'direct'; // 不啟動子程序，直接在目前 Node.js 行程執行

/** 由 agent.buildCommand() 產出，交給 process-service 執行。 */
export interface BuiltCommand {
  cliPath: string;
  args: string[];
  cwd: string;
  agent: AgentId;
  prompt: string;
  resolvedModel: string;
  /** core 附加的最終 reasoning 選值，供監看摘要使用。 */
  reasoningEffort?: string;
  sessionId?: string;
  /** 若為字串，prompt 透過 stdin（positional `-`）送入，而非當作 arg。 */
  stdinPrompt?: string;
  /** 檔案 prompt 的建置暫存；持久化 store 接管到 job 目錄後解除 fallback 清理。 */
  temporaryPromptFile?: string;
  releaseTemporaryPrompt?: () => void;
  /** direct-api 專用：OpenAI-compatible API 連線資訊。 */
  directApi?: DirectApiCommandConfig;
}

/** buildCommand 的輸入。 */
export interface BuildCommandInput {
  cliPath: string;
  cwd: string;
  prompt: string;
  resolvedModel: string;
  rawModel: string;
  reasoningEffort: string;
  sessionId?: string;
  /**
   * 這一回合的系統提示。只有宣告 `supportsSystemPrompt` 的 agent 收得到；
   * command-builder 對其他 agent 會直接拒絕，不會靜默丟掉。
   */
  systemPrompt?: string;
  /** direct-api 專用：provider key（providers.json 中的 key）。 */
  providerName?: string;
  /** direct-api 專用：實際送到 provider 的 model 名稱。 */
  providerModel?: string;
  /** direct-api 專用：OpenAI-compatible API base URL。 */
  providerBaseUrl?: string;
  /** direct-api 專用：API key。 */
  providerApiKey?: string;
}

export interface DirectApiCommandConfig {
  providerName: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  /**
   * 併進 /chat/completions request body 的額外欄位（providers.json 的
   * extra_body ∪ model_extra_body）。框架自組的欄位不會出現在這裡——
   * 那些在載入設定時就被擋掉了。
   */
  extraBody?: Record<string, unknown>;
  /** 429/5xx 的重試設定（providers.json 的 retry）；省略時用內建預設。 */
  retry?: { maxRetries: number; initialDelayMs: number };
  /** 是否把上一輪的 reasoning_content 回送（providers.json 的 replay_reasoning）。 */
  replayReasoning?: boolean;
}

export interface DirectRunIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  signal?: AbortSignal;
}

/** parser 可選上下文；主要供需要工作目錄/狀態的 agent 使用。 */
export interface ParseOutputContext {
  workFolder?: string;
  status?: string;
}

/** CLI 二進位解析設定，交給共用的 binary-resolver 使用。 */
export interface BinaryConfig {
  /** 環境變數名稱，可覆寫 CLI 名稱或絕對路徑，例如 CLAUDE_CLI_NAME。 */
  envVarName: string;
  /** 預設指令名稱，例如 'claude'、'codex'、'agy'。 */
  defaultCliName: string;
  /** 可選的本機安裝絕對路徑（依平台），找得到就優先用。 */
  localInstallPath?: string;
  /** 此 agent 優先 PATH，找不到才退回 localInstallPath；既有 agent 保留本機優先。 */
  preferPath?: boolean;
}

/** reasoning_effort 支援度。 */
export interface ReasoningSupport {
  /** 此 agent 是否支援 reasoning_effort。 */
  supported: boolean;
  /** 允許的值集合（小寫）。supported 為 true 時必填。 */
  allowed?: ReadonlySet<string>;
  /** 不支援時拋出的錯誤訊息。 */
  unsupportedMessage?: string;
  /** 值不在 allowed 內時的錯誤訊息。 */
  invalidMessage?: string;
}

/**
 * 一筆模型清單的**出處**。
 *
 * ★ 這個欄位存在的理由是一次真實的誤導：2026-07-31，有人照
 *   `antigravity.ts` 的註解斷定「agy 不支援 --model」，並把它當事實
 *   轉述出去。實測 agy v1.1.9 早就支援了——**硬編的清單沒有標明自己
 *   是硬編的**，讀的人就沒有理由懷疑它。
 *
 *   `vendor-cli` = 這一輪真的去問過 vendor CLI。
 *   `vendor-cli-cached` = 先前行程問到並存到磁碟的值，這一輪尚未確認。
 *   `builtin-fallback` = 原始碼裡的靜態清單，**未經確認**，可能已過時。
 *
 *   消費端必須把 `builtin-fallback` 當成「參考值」而不是事實。
 *   這比「記得更新註解」可靠，因為它不依賴任何人的記性。
 */
export type ModelListSource = 'vendor-cli' | 'vendor-cli-cached' | 'builtin-fallback';

/** 查詢可附診斷；models 為 null 代表失敗，note 交給 catalog 的 discoveryNote。 */
export interface ModelDiscoveryResult {
  models: readonly string[] | null;
  note: string | null;
}

/**
 * 計費路徑。**不同的錢，不能混在同一組沒有區別的選項裡。**
 *
 * `subscription-cli` = 走各 vendor CLI 自己的登入（訂閱額度）。
 * `metered-api` = 走 providers.json 的 API 金鑰，**按量計費**。
 */
export type BillingRoute = 'subscription-cli' | 'metered-api';

/**
 * 一個 AI agent 的完整定義。所有 agent 專屬行為都集中在這裡。
 */
export interface AgentDefinition {
  /** 唯一 id。 */
  id: AgentId;

  /**
   * 此 agent 支援的標準 model 名稱清單。
   *
   * **這是靜態後備值。** 有 `discoverModels` 的 agent 以動態結果為準；
   * 這裡的內容一律以 `builtin-fallback` 出處對外呈現。
   */
  models: readonly string[];

  /** 計費路徑。未指定視為 `subscription-cli`。 */
  billingRoute?: BillingRoute;

  /**
   * 非同步向 vendor CLI 問它**現在**支援哪些模型，不得同步阻塞呼叫端。
   *
   * 實作必須：有逾時、**永不拋例外／reject**（問不到就回 null，或 models: null）。
   * 可回 { models, note } 說明失敗原因。失敗時呼叫端保留既有成功值並照實標示。
   */
  discoverModels?(cliPath: string): Promise<readonly string[] | null | ModelDiscoveryResult>;

  /**
   * 判斷一個（已解析 alias 後的）model 是否屬於此 agent。
   * registry 依序詢問各 agent；第一個回 true 的勝出。
   * claude 作為 fallback 永遠回 true，必須最後註冊。
   */
  matchesModel(resolvedModel: string): boolean;

  /** CLI 二進位解析設定。direct-api 不需要本機 CLI。 */
  binary?: BinaryConfig;

  /** reasoning_effort 支援度。 */
  reasoning: ReasoningSupport;

  /** 組裝實際 CLI 指令。 */
  /**
   * 這個 agent 的 CLI 有沒有系統提示通道（claude 的 --append-system-prompt-file）。
   * 省略等於沒有：command-builder 會拒絕帶 system_prompt 的呼叫，而不是靜默丟掉。
   */
  supportsSystemPrompt?: boolean;

  buildCommand(input: BuildCommandInput): BuiltCommand;

  /**
   * 組裝**嚴格模式**的 CLI 指令（`ai-cli exec` 專用）。
   *
   * 與 `buildCommand` 只差一件事，但那件事是決定性的：
   * **不得使用任何 `--dangerously-*` 旁路**，改成把呼叫端宣告的
   * `capabilities` 映射成該 vendor 真正的沙箱／工具限制。
   *
   * ★ 這個方法是選用的，而**缺席等於拒絕**（fail-closed）：
   *   `exec` 對沒有實作它的 agent 直接拒絕啟動，**不會退回**
   *   `buildCommand`。退回去等於在呼叫端以為「有限制」的時候全開權限跑
   *   ——那是顯示一個不存在的約束，比不支援更糟。
   *
   * 給不出某個 capability 的保證時**必須丟例外**，不得放寬。
   */
  buildStrictCommand?(input: BuildCommandInput, capabilities: readonly string[]): BuiltCommand;

  /** 解析此 agent 的原始 stdout/stderr 成結構化結果。 */
  parseOutput(stdout: string, stderr: string, exitCode?: number, context?: ParseOutputContext): unknown;

  /** 子程序啟動方式。預設 'pipe'。 */
  spawnMode?: SpawnMode;

  /** spawnMode === 'direct' 時由 process-service 呼叫。 */
  runDirect?(cmd: BuiltCommand, io: DirectRunIO): Promise<void>;

  /**
   * Windows 上是否強制走某種 spawn。回傳的 mode 會覆寫 spawnMode。
   * 用於「只有 win32 才需要 PTY」這類情境（例如 agy）。
   */
  win32SpawnMode?: SpawnMode;

  /** 失敗時保留 raw stdout/stderr（不靠 parser）。 */
  preserveRawOnFailure?: boolean;

  /**
   * Windows 上以 pipe spawn 時，是否「不」透過 cmd.exe shell 啟動。
   * 預設 false（多數 CLI 是 npm shim，win32 需要 shell:true 才能啟動）。
   * 設 true 用於真實 .exe（而非 npm 的 .cmd shim），避免 cmd.exe 對 prompt 重新切詞。
   */
  win32DirectExec?: boolean;
}
