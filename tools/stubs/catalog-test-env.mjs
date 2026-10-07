/** 驗證與突變測試共用：設定、狀態、快取全部隔離；禁止自動更新及 git 網路協定。 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 不預先實體化 node:fs 的 ESM facade，保留 verify-alias-config 的讀取注入能力。
const fs = createRequire(import.meta.url)('node:fs');
const temp = fs.mkdtempSync(join(tmpdir(), 'ai-cli-catalog-tests-'));
process.env.AI_CLI_AUTO_UPDATE = 'off';
// 測試預設模擬主導者；worker 防護測試自行指定每個環境組合，不繼承執行測試的 worker。
delete process.env.AI_CLI_WORKER;
delete process.env.AI_CLI_ALLOW_NESTED;
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.AI_CLI_CONFIG_DIR = join(temp, 'config');
process.env.AI_CLI_STATE_DIR = join(temp, 'state');
process.env.AI_CLI_PROVIDERS_PATH = join(temp, 'providers.json');
// codex 指令會依 $CODEX_HOME/config.toml 補 MCP 覆寫；指向空目錄，免得測試結果隨機器上的真設定變。
process.env.CODEX_HOME = join(temp, 'codex-home');
fs.writeFileSync(process.env.AI_CLI_PROVIDERS_PATH, '{"providers":{}}');
const stub = fileURLToPath(new URL(process.platform === 'win32'
  ? './agy-models-error.cmd' : './agy-models-error.mjs', import.meta.url));
if (process.platform !== 'win32') fs.chmodSync(stub, 0o755);
process.env.AI_CLI_CATALOG_CACHE_PATH = join(temp, 'catalog-cache.json');
process.env.AGY_CLI_NAME = stub;
process.on('exit', () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
