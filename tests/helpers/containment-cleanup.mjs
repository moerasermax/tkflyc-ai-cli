// No catalog import: this is the owning test's synchronous exit cleanup.
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {WinJobClient} from '../../dist/core/win-job-client.js';
import {powershell,nativeScript} from '../../dist/core/win-job-broker.js';
import {readBroker} from '../../dist/core/containment-store.js';
const config=JSON.parse(process.env.AI_CLI_CONTAINMENT_TEST);
if(!/^TkflycAiCliContainmentBroker-test-[0-9a-f-]{36}$/.test(config.name))throw Error('not an owned fixture');
const client=new WinJobClient(config),broker=readBroker(config);
if(broker){
  for(const file of readdirSync(config.directory).filter(n=>n!=='broker.json'&&n.endsWith('.json'))){
    const ref=JSON.parse(readFileSync(join(config.directory,file),'utf8'));
    if(ref.brokerEpoch===broker.epoch){const s=await client.terminate(ref);if(s.state!=='drained')throw Error('fixture did not drain: '+ref.jobId+' '+s.reason);}
  }
  // Hold the same process handle and verify exact native creation time before stop.
  try{await powershell(nativeScript(`[AiCliContainment]::StopFixture(${broker.pid},'${broker.started}')`));}
  catch(error){let same=false;try{const now=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${broker.pid})`)));same=now.started===broker.started&&!now.exited;}catch{}if(same)throw error;}
}
