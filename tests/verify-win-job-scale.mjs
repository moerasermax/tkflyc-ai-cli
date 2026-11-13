import '../tools/stubs/catalog-test-env.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {JobStore} from '../dist/core/job-store.js';
import {readBroker,drainedProof} from '../dist/core/containment-store.js';
import {powershell,nativeScript,bridgeCall} from '../dist/core/win-job-broker.js';
let failed=0;const check=(n,b)=>{console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const n=Number(process.env.SCALE_SAMPLES??10),dir=mkdtempSync(resolve('.tmp/phase3-scale-'));
const metrics=[],old=process.env.AI_CLI_CONTAINMENT_TEST;
const stop=async b=>{if(b){await powershell(nativeScript(`[AiCliContainment]::StopFixture(${b.pid},'${b.started}')`)).catch(()=>{});check('owned scale broker identity exited',JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${b.pid},'${b.started}')`))).state==='dead');}};
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
if(process.platform==='win32')try{
 await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));
 for(const count of [0,1000,10000]){
  const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,String(count),'registry'),idleMs:60000};mkdirSync(config.directory,{recursive:true});
  const initial=new WinJobClient(config);await initial.ensure();await stop(readBroker(config));
  for(let i=0;i<count;i++){const ref={version:1,jobId:randomUUID(),generation:randomUUID(),brokerEpoch:randomUUID(),phase:'drained',terminalProof:{runnerExited:true,activeProcesses:0,at:'2020-01-01T00:00:00Z'}};writeFileSync(join(config.directory,ref.generation+'.json'),JSON.stringify(ref));}
  process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(config);const client=new WinJobClient(config),startup=[],job=[];let owner,store;
  try{
   for(let sample=0;sample<n;sample++){
    let t=performance.now();await client.ensure();owner=readBroker(config);startup.push(performance.now()-t);await stop(owner);owner=undefined;
    store=new JobStore(join(dir,String(count),'state-'+sample),'cli');await store.ready;
    t=performance.now();const j=await store.start({cliPath:process.execPath,args:['-e','setTimeout(()=>{},100)'],cwd:dir,agent:'grok',resolvedModel:'stub',prompt:'scale stub'});const readyDeadline=Date.now()+30000;while(!existsSync(join(j.directory,'meta.json'))&&Date.now()<readyDeadline)await sleep(50);check('scale worker READY '+count+'/'+sample,existsSync(join(j.directory,'meta.json')));job.push(performance.now()-t);owner=readBroker(config);
    const until=Date.now()+20000;while(!existsSync(join(j.directory,'exit.json'))&&Date.now()<until)await sleep(100);
    const meta=JSON.parse(readFileSync(join(j.directory,'meta.json'),'utf8'));const status=await client.terminate(meta.containment);
    check('scale job completes and drains '+count+'/'+sample,JSON.parse(readFileSync(join(j.directory,'exit.json'),'utf8')).exitCode===0&&status.state==='drained');
    store.dispose();store=undefined;await stop(owner);owner=undefined;
   }
   await client.ensure();owner=readBroker(config);
   const corrupt={version:1,jobId:randomUUID(),generation:randomUUID(),brokerEpoch:randomUUID()};writeFileSync(join(config.directory,corrupt.generation+'.json'),'{broken');
   check('corrupt retained generation stays unknown '+count,(await client.inspect(corrupt)).state==='unknown'&&!drainedProof(corrupt,config));
   const m={count,n,startup,job,startupP50:percentile(startup,.5),startupP95:percentile(startup,.95),jobP50:percentile(job,.5),jobP95:percentile(job,.95)};metrics.push(m);console.log('METRIC '+JSON.stringify(m));
  }finally{store?.dispose();await stop(owner??readBroker(config));}
 }
 check('startup independent of 10000 drained history',metrics[2].startupP50-metrics[0].startupP50<=1000&&metrics[2].startupP95-metrics[0].startupP95<=1000);
}finally{if(old===undefined)delete process.env.AI_CLI_CONTAINMENT_TEST;else process.env.AI_CLI_CONTAINMENT_TEST=old;writeFileSync(join(dir,'metrics.json'),JSON.stringify(metrics,null,2));}
console.log(`Scale: ${failed} failed; evidence ${dir}`);process.exitCode=failed?1:0;
