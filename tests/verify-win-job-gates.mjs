import '../tools/stubs/catalog-test-env.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {FileJobExecutor} from '../dist/ai-cli_kernel/executor.js';
import {KernelUntrackedStartError} from '../dist/ai-cli_kernel/types.js';
let failed=0;function check(n,b){console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;}
if(process.platform==='win32'){
  // Deterministic PID reuse: the original process is gone, but descendants are unproved.
  let lookups=0;const fakePid=2147483646;
  const executor=new FileJobExecutor({platform:'win32',lookup:async()=>new Map([[fakePid,{pid:fakePid,started:++lookups===1?'original':'reused',name:'fixture'}]]),untrackedConfirmMs:0});
  executor.service.dispose();executor.service={startProcess:async()=>({pid:2147483646})};
  let untracked;try{await executor.start({actionId:'a1',kind:'decide',model:'gpt-6.1-sol',prompt:'stub',marker:'stub'},{workFolder:process.cwd()});}catch(e){untracked=e;}
  check('missing jobId stays blocked even after Windows PID disappears',untracked instanceof KernelUntrackedStartError&&await executor.isGone(untracked.job)===false);
  const state=mkdtempSync(join(tmpdir(),'ai-cli-ready-gate-')),id=randomUUID(),dir=join(state,'jobs',id);mkdirSync(dir,{recursive:true});
  const marker=join(state,'worker-started'),worker=join(state,'worker.cjs');writeFileSync(worker,`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`);
  const ref={version:1,jobId:id,generation:randomUUID(),brokerEpoch:randomUUID()};
  writeFileSync(join(dir,'launch.tmp'),JSON.stringify({command:process.execPath,args:[worker],cwd:state,stdin:false,needsShell:false,serverPid:process.pid,principalPid:process.ppid,meta:{version:1,jobId:id,agent:'grok',resolvedModel:'stub',source:'cli',task:'READY gate',workFolder:state,startTime:new Date().toISOString(),server:null,principal:null,recoverable:true,containment:ref}}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/core/job-runner.js',import.meta.url)),dir],{detached:true,windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  check('READY rejection prevents worker spawn',!existsSync(marker)&&JSON.parse(readFileSync(join(dir,'exit.json'),'utf8')).exitCode===1);
  check('missing containment never becomes zero',(await new WinJobClient().inspect(ref)).state==='unknown');
  if(!failed){ // Mutation failures above must not launch an uncontained long-lived fixture.
  for(const pty of [false,true]){
  const legacyId=randomUUID(),legacy=join(state,'jobs',legacyId);mkdirSync(legacy);
  const spec=JSON.parse(readFileSync(join(dir,'meta.json'),'utf8'));
  delete spec.containment;delete spec.containmentProtocol;delete spec.runner;delete spec.worker;delete spec.pid;spec.jobId=legacyId;
  const idle=join(state,'idle.cjs');writeFileSync(idle,'setInterval(()=>{},1000)');
  writeFileSync(join(legacy,'launch.tmp'),JSON.stringify({command:process.execPath,args:[idle],cwd:state,stdin:false,needsShell:false,pty,serverPid:process.pid,principalPid:process.ppid,meta:spec}));
  const old=spawn(process.execPath,[fileURLToPath(new URL('../dist/core/job-runner.js',import.meta.url)),legacy],{detached:true,windowsHide:true,stdio:'ignore'});
  const closed=new Promise(r=>old.once('close',r));let meta;
  for(let n=0;n<200;n++){try{meta=JSON.parse(readFileSync(join(legacy,'meta.json'),'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,100));}
  try{
    check('old server '+(pty?'PTY':'pipe')+' spec acquires containment before worker',!!meta?.containment&&!!meta.worker);
    if(meta?.containment){
      check('live '+(pty?'PTY':'pipe')+' job PID tree has no visible top-level window',JSON.parse(await powershell(nativeScript(`[AiCliContainment]::VisibleWindows([int[]]@(${old.pid},${meta.worker?.pid||old.pid}))`))).length===0);
      writeFileSync(join(legacy,'kill.json'),JSON.stringify({runner:meta.runner}));await closed;
      for(let n=0;n<100&&!existsSync(join(legacy,'exit.json'));n++)await new Promise(r=>setTimeout(r,100));
      const exit=JSON.parse(readFileSync(join(legacy,'exit.json'),'utf8'));
      check('old '+(pty?'PTY':'pipe')+' kill.json gets durable exit without upgraded store',exit.killed===true&&exit.exitCode===143&&(await new WinJobClient().inspect(meta.containment)).state==='drained');
    }
  }finally{if(meta?.containment)await new WinJobClient().terminate(meta.containment);}
  }
  }
}
console.log(`Containment gates: ${failed} failed`);process.exitCode=failed?1:0;
