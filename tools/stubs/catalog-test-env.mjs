import { preserveDurableFailure } from '../../tests/helpers/durable-failure-evidence.mjs';
/** 驗證與突變測試共用：設定、狀態、快取全部隔離；禁止自動更新及 git 網路協定。 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 不預先實體化 node:fs 的 ESM facade，保留 verify-alias-config 的讀取注入能力。
const fs = createRequire(import.meta.url)('node:fs');
if (process.argv[1]?.endsWith('mutation-test.mjs')) process.env.AI_CLI_MUTATION_TEST='1';
const temp = fs.mkdtempSync(join(tmpdir(), 'ai-cli-catalog-tests-'));
// Registered before broker/state teardown; retain unexpected nonzero exits too.
process.once('exit', code => { if (code) preserveDurableFailure({ name: 'catalog-exit-'+process.pid, result: { exitCode: code }, roots: [temp] }); });
// A mutation's native broker must be compiled from that candidate, never reuse
// the baseline's still-live daemon. Descendant fixtures retain this namespace.
const mutationVerify=process.env.AI_CLI_MUTATION_TEST==='1' && /[\\/]verify-[^\\/]+\.mjs$/.test(process.argv[1]??'');
if (process.platform === 'win32' && (!process.env.AI_CLI_CONTAINMENT_TEST || mutationVerify)) {
  const { randomUUID } = createRequire(import.meta.url)('node:crypto');
  const config = {name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(temp,'containment'),idleMs:60000};
  process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(config);
  process.once('exit',()=>{
    if (!fs.existsSync(join(config.directory,'broker.json'))) return;
    const {spawnSync}=createRequire(import.meta.url)('node:child_process');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../tests/helpers/containment-cleanup.mjs',import.meta.url))],{windowsHide:true,stdio:'pipe',encoding:'utf8',env:process.env});
    if(result.status!==0){console.error('FAIL containment fixture cleanup: '+result.stdout+result.stderr);process.exitCode=1;}
  });
}
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
// Grok 預設模擬未安裝，不引入額外背景探查；Grok 專測自行注入 native stub。
process.env.GROK_CLI_NAME = join(temp, 'missing-grok');
process.on('exit', () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
