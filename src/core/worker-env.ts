/**
 * vendor CLI 子行程環境：保留呼叫端環境，標記這個 CLI 是 ai-cli 啟動的。
 * SessionStart hook 可據此注入 worker 政策，避免把主導者派工規則套到 worker。
 */
export function buildWorkerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, AI_CLI_WORKER: '1' };
}

/** 穩定識別碼也供驗收器辨識機制拒絕；只檢查 ai-cli 自己的環境。 */
export const NESTED_DISPATCH_ERROR = 'AI_CLI_NESTED_DISPATCH_BLOCKED: 此行程是 ai-cli 派出的 worker（AI_CLI_WORKER=1），禁止再派工以免遞迴；派工內容應由你自己完成。只有確定需要巢狀派工時，才設定 AI_CLI_ALLOW_NESTED=1 解除限制。';

export function assertCanStartJob(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AI_CLI_WORKER === '1' && env.AI_CLI_ALLOW_NESTED !== '1') {
    throw new Error(NESTED_DISPATCH_ERROR);
  }
}
