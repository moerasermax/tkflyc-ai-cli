import '../tools/stubs/catalog-test-env.mjs';
import {mkdirSync,mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobStore} from '../dist/core/job-store.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {readBroker} from '../dist/core/containment-store.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let failed=0;
const check=(n,b)=>{console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;};
if(process.platform==='win32'){
 mkdirSync('.tmp',{recursive:true});const dir=mkdtempSync(resolve('.tmp/phase3-pipe-late-')),log=join(dir,'calls');
 const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'registry'),idleMs:60000};
 process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(config);process.env.PHASE3_PIPE_LOG=log;
 process.env.NODE_OPTIONS=`--import=${new URL('./helpers/phase3-pipe-late-preload.mjs',import.meta.url).href}`;
 const store=new JobStore(join(dir,'state'),'cli');let job;
 try{
  await store.ready;job=await store.start({cliPath:process.execPath,args:['-e','/* PHASE3_PIPE_LATE */setTimeout(()=>{},1500)'],cwd:dir,agent:'grok',resolvedModel:'stub',prompt:'late kill fixture'});
  const end=Date.now()+45000;while(!existsSync(join(job.directory,'exit.json'))&&Date.now()<end)await sleep(50);
  const exit=JSON.parse(readFileSync(join(job.directory,'exit.json'),'utf8'));
  check('pipe natural exit ignores later kill request',existsSync(log+'.late')&&!existsSync(log)&&exit.exitCode===0&&!exit.killed&&!exit.timedOut);
 }catch(e){check('pipe late fixture completed',false);console.error(e);}
 finally{
  delete process.env.NODE_OPTIONS;store.dispose();
  if(job){const meta=JSON.parse(readFileSync(join(job.directory,'meta.json'),'utf8'));await new WinJobClient(config).terminate(meta.containment);}
  const owner=readBroker(config);if(owner){await powershell(nativeScript(`[AiCliContainment]::StopFixture(${owner.pid},'${owner.started}')`)).catch(()=>{});check('late fixture broker exited',JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${owner.pid},'${owner.started}')`))).state==='dead');}
 }
}else console.log('SKIP Windows pipe cancellation');
process.exitCode=failed?1:0;
