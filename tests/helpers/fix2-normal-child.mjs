import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {JobStore} from '../../dist/core/job-store.js';
import {WinJobClient} from '../../dist/core/win-job-client.js';
import {powershell,nativeScript,bridgeCall} from '../../dist/core/win-job-broker.js';
import {readBroker,drainedProof} from '../../dist/core/containment-store.js';
const dir=process.argv[2],config=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));
process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(config);
process.env.AI_CLI_STATE_DIR=join(dir,'normal-state');
const store=new JobStore(process.env.AI_CLI_STATE_DIR,'cli');let broker,meta;
try {
 await store.ready;
 const admin=await powershell('[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
 const job=await store.start({cliPath:process.execPath,args:['-e','console.log("normal-token stub")'],cwd:dir,agent:'grok',resolvedModel:'stub',prompt:'normal token fixture'});
 const until=Date.now()+45000;
 while(!existsSync(join(job.directory,'exit.json'))&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
 meta=JSON.parse(readFileSync(join(job.directory,'meta.json'),'utf8'));broker=readBroker(config);
 const client=new WinJobClient(config);
 let status;do {status=await client.inspect(meta.containment);if(status.state==='drained')break;await new Promise(r=>setTimeout(r,200));}while(Date.now()<until);
 const visible=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::VisibleWindows([int[]]@(${process.pid},${broker.pid}))`)));
 writeFileSync(join(dir,'normal-ready.json'),JSON.stringify({admin,broker,meta,exit:JSON.parse(readFileSync(join(job.directory,'exit.json'),'utf8')),drained:drainedProof(meta.containment,config),visible}));
 const end=Date.now()+45000;while(!existsSync(join(dir,'normal-release'))&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
 await bridgeCall(config,{op:'retire',version:1,brokerEpoch:broker.epoch});
}catch(error){writeFileSync(join(dir,'normal-error.txt'),String(error.stack));process.exitCode=1;}
finally {store.dispose();if(broker)await powershell(nativeScript(`[AiCliContainment]::StopFixture(${broker.pid},'${broker.started}')`)).catch(()=>{});}
