import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {recordJobFailure,readJobExit,JobStore} from '../dist/core/job-store.js';
import {runJob} from '../dist/core/job-runner.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {readBroker,readContainment,drainedProof,saveContainmentRef} from '../dist/core/containment-store.js';
import {powershell,nativeScript,bridgeCall,ContainmentTransportError} from '../dist/core/win-job-broker.js';
import {ensureWindowlessHost,runWindowless} from '../dist/core/win-job-host.js';
import {preserveDurableFailure} from './helpers/durable-failure-evidence.mjs';
fs.mkdirSync('.tmp',{recursive:true});const root=fs.mkdtempSync(resolve('.tmp/fix9-fixture-'));console.log('EVIDENCE '+root);
let failed=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function test(name,fn){if(process.env.FIX9_TEST_FILTER&&!name.includes(process.env.FIX9_TEST_FILTER))return;try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+'\n'+e.stack);}}
const id=async pid=>JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${pid})`)));
const evidence=async owner=>JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${owner.pid},'${owner.started}')`)));
async function stop(owner){if(owner?.started && (await evidence(owner)).state==='alive')await powershell(nativeScript(`[AiCliContainment]::StopFixture(${owner.pid},'${owner.started}')`));}
async function until(fn,ms=15000){const end=Date.now()+ms;do{if(await fn())return;await sleep(100);}while(Date.now()<end);throw Error('fixture deadline');}
await test('FIX9 diagnostic publication is atomic bounded and retains first reason',()=>{
 const dir=join(root,'atomic');fs.mkdirSync(dir);const rename=fs.renameSync;let attempts=0;
 try{fs.renameSync=function(from,to){if(String(to).endsWith('runner-error.json')){assert.equal(fs.existsSync(to),false,'no partial diagnostic exposed');assert.equal(JSON.parse(fs.readFileSync(from)).error.length,4096);if(++attempts===1)throw Object.assign(Error('busy'),{code:'EPERM'});}return rename(from,to);};syncBuiltinESMExports();recordJobFailure(dir,'x'.repeat(100000));}
 finally{fs.renameSync=rename;syncBuiltinESMExports();}
 assert.equal(attempts,2);assert.equal(readJobExit(dir).error.length,4096);assert.ok(fs.statSync(join(dir,'runner-error.json')).size<=32768);
 recordJobFailure(dir,'second');assert.equal(readJobExit(dir).error,'x'.repeat(4096));
 const tooLong=join(root,'long-reader');fs.mkdirSync(tooLong);fs.writeFileSync(join(tooLong,'runner-error.json'),JSON.stringify({...readJobExit(dir),error:'x'.repeat(4097)}));assert.equal(readJobExit(tooLong),undefined);
});
if(process.platform==='win32'){
 await test('FIX9 prepare unavailable broker still persists startup cause',async()=>{
  const state=join(root,'prepare-unavailable'),store=new JobStore(state);await store.ready;const ensure=WinJobClient.prototype.ensure;
  try{WinJobClient.prototype.ensure=async()=>{throw Error('FIX9 broker unavailable original');};await assert.rejects(store.start({cliPath:process.execPath,args:[],cwd:root,agent:'claude',prompt:'{}',resolvedModel:'fixture'}),/FIX9 broker unavailable original/);const dirs=fs.readdirSync(join(state,'jobs'));assert.equal(dirs.length,1);assert.match(readJobExit(join(state,'jobs',dirs[0])).error,/FIX9 broker unavailable original/);}
  finally{WinJobClient.prototype.ensure=ensure;store.dispose();}
 });
 await test('FIX9 prepare lost reply and mismatch persist cause before native termination',async()=>{
  for(const mode of ['lost','mismatch']){
   const store=new JobStore(join(root,'prepare-'+mode));await store.ready;await new WinJobClient().ensure();
   const spawn=cp.spawn,terminate=WinJobClient.prototype.terminate,seen=[];let prepared;
   try{
    WinJobClient.prototype.terminate=async function(ref,reason){const record=readContainment(ref,this.config);seen.push(readJobExit(record.resultDirectory));return terminate.call(this,ref,reason);};
    cp.spawn=function(file,args,options){let request;try{request=JSON.parse(Buffer.from(options?.env?.AI_CLI_CONTAINMENT_REQUEST||'','base64').toString());}catch{}
     const child=spawn(file,args,{...options,windowsHide:true});if(request?.op!=='prepare')return child;
     prepared=request;const facade=new EventEmitter();facade.kill=s=>child.kill(s);child.once('error',e=>facade.emit('error',e));child.once('close',code=>{
      if(code===0&&mode==='mismatch'){const path=join(args[0],'..','output.txt'),reply=JSON.parse(fs.readFileSync(path));reply.value.generation=randomUUID();fs.writeFileSync(path,JSON.stringify(reply));}
      facade.emit('close',code===0&&mode==='lost'?92:code);
     });return facade;
    };syncBuiltinESMExports();
    await assert.rejects(store.start({cliPath:process.execPath,args:[],cwd:root,agent:'claude',prompt:'{}',resolvedModel:'fixture'}),mode==='lost'?/PowerShell/:/prepare identity mismatch/);
    assert.ok(seen.length>0);for(const result of seen){assert.equal(result.exitCode,1);assert.match(result.error,/Containment prepare failed/);}
    const exit=JSON.parse(fs.readFileSync(join(prepared.resultDirectory,'exit.json')));assert.equal(exit.exitCode,1);assert.equal(exit.killed,false);assert.doesNotMatch(fs.readFileSync(join(prepared.resultDirectory,'stderr.log'),'utf8'),/terminated by user/);assert.ok(drainedProof(prepared));
   }finally{cp.spawn=spawn;WinJobClient.prototype.terminate=terminate;syncBuiltinESMExports();if(prepared)await new WinJobClient().terminate(prepared);store.dispose();}
  }
 });
 await test('FIX9 invalid diagnostic never blocks drained or broker idle exit',async()=>{
  const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(root,'invalid-registry'),idleMs:5000},client=new WinJobClient(config),owners=[];
  try{
   for(const mode of ['partial','oversized','schema','unreadable']){
    const jobId=randomUUID(),dir=join(root,'invalid','jobs',jobId);fs.mkdirSync(dir,{recursive:true});const ref=await client.prepare(jobId,dir);const broker=readBroker(config);owners.push(broker);
    if(mode==='partial'||mode==='oversized'){
     const ready=join(dir,'ready'),script=join(dir,'runner.mjs');
     fs.writeFileSync(script,`import{WinJobClient}from ${JSON.stringify(new URL('../dist/core/win-job-client.js',import.meta.url).href)};import{writeFileSync}from'node:fs';await new WinJobClient(${JSON.stringify(config)}).register(${JSON.stringify(ref)});writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
     const child=cp.spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});owners.push(await id(child.pid));await until(()=>fs.existsSync(ready));
    }
    const path=join(dir,'runner-error.json');
    if(mode==='unreadable')fs.mkdirSync(path);else fs.writeFileSync(path,mode==='partial'?'{"exitCode":1,':mode==='oversized'?JSON.stringify({exitCode:1,killed:false,timedOut:false,signal:null,endTime:new Date().toISOString(),error:'x'.repeat(70000)}):'{"exitCode":1,"error":"bad schema"}');
    assert.equal(readJobExit(dir),undefined);
    await client.terminate(ref);await until(async()=> (await client.inspect(ref)).state==='drained');
    assert.ok(drainedProof(ref,config));assert.equal(readJobExit(dir).exitCode,143);assert.match(fs.readFileSync(join(dir,'stderr.log'),'utf8'),/Ignored invalid runner-error.json/);
   }
   const broker=readBroker(config);await until(async()=> (await evidence(broker)).state==='dead',20000);assert.equal((await evidence(broker)).state,'dead','broker exits idle after invalid diagnostics');
  }finally{for(const owner of owners.reverse())await stop(owner);}
 });
 await test('FIX9 register shares one total deadline across attempts',async()=>{
  const client=new WinJobClient(),ref=await client.prepare(randomUUID());await ensureWindowlessHost();const spawn=cp.spawn,now=performance.now.bind(performance),descriptor=Object.getOwnPropertyDescriptor(performance,'now');let offset=0;const budgets=[];
  try{
   Object.defineProperty(performance,'now',{configurable:true,value:()=>now()+offset});
   cp.spawn=function(file,args,options){const request=JSON.parse(Buffer.from(options.env.AI_CLI_CONTAINMENT_REQUEST,'base64').toString());assert.equal(request.op,'register');assert.equal(options.windowsHide,true);budgets.push(Number(args[2]));const child=new EventEmitter();child.kill=()=>true;setTimeout(()=>{offset+=26000;child.emit('close',92);},10);return child;};syncBuiltinESMExports();
   await assert.rejects(client.register(ref),/total deadline exhausted/);assert.equal(budgets.length,2);assert.ok(budgets[0]<=45000&&budgets[1]<25000,'remaining deadline reaches helper');
  }finally{if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;cp.spawn=spawn;syncBuiltinESMExports();await client.terminate(ref);}
 });
 await test('FIX9 host total deadline settles without close and stops retained handle',async()=>{
  await ensureWindowlessHost();const spawn=cp.spawn;let kills=0;
  try{cp.spawn=function(_file,_args,options){assert.equal(options.windowsHide,true);const child=new EventEmitter();child.kill=function(){assert.equal(this,child);kills++;return true;};return child;};syncBuiltinESMExports();const began=performance.now();await assert.rejects(runWindowless('fixture.ps1',{},false,45000,performance.now()+80),/deadline/);assert.ok(performance.now()-began<1000);assert.equal(kills,1);}
  finally{cp.spawn=spawn;syncBuiltinESMExports();}
 });
 await test('FIX9 recognizable policy errors without error txt are permanent',async()=>{
  await ensureWindowlessHost();const spawn=cp.spawn;
  try{for(const policy of ['ExecutionPolicy','AppLocker','Constrained Language']){
   cp.spawn=function(_file,args,options){assert.equal(options.windowsHide,true);fs.writeFileSync(args[0]+'.host-error',policy+' blocked');const child=new EventEmitter();child.kill=()=>true;queueMicrotask(()=>child.emit('close',1));return child;};syncBuiltinESMExports();
   await assert.rejects(powershell("'unused'"),e=>!(e instanceof ContainmentTransportError)&&e.message.includes(policy));
  }}finally{cp.spawn=spawn;syncBuiltinESMExports();}
 });
 await test('FIX9 outer failure preserves containment unknown and fail logs once',async()=>{
  const state=join(root,'outer-state'),jobId=randomUUID(),dir=join(state,'jobs',jobId);fs.mkdirSync(dir,{recursive:true});const client=new WinJobClient(),ref=await client.prepare(jobId,dir);saveContainmentRef(state,ref);fs.writeFileSync(join(dir,'launch.tmp'),'{');const terminate=WinJobClient.prototype.terminate;
  try{WinJobClient.prototype.terminate=async()=>({state:'unknown',reason:'injected unavailable'});await assert.rejects(runJob(dir));assert.equal(JSON.parse(fs.readFileSync(join(dir,'containment-status.json'))).state,'unknown');assert.equal(readJobExit(dir).exitCode,1);}
  finally{WinJobClient.prototype.terminate=terminate;await client.terminate(ref);}
  const early=join(root,'early');fs.mkdirSync(early);fs.writeFileSync(join(early,'launch.tmp'),JSON.stringify({meta:{jobId:randomUUID()},serverPid:process.pid,principalPid:process.pid}));await runJob(early,{waitForLauncher:true,launcherWaitMs:0,lookup:async()=>new Map([[process.pid,{pid:process.pid,started:'fixture'}]])});assert.equal((fs.readFileSync(join(early,'stderr.log'),'utf8').match(/Process error:/g)||[]).length,1);
 });
 await test('FIX9 real broker denies different caller replay and invalid capability',async()=>{
  const client=new WinJobClient(),ref=await client.prepare(randomUUID()),record=readContainment(ref),payload={...ref,op:'register',requestId:randomUUID(),capability:record.launchCapability};let owner;
  try{
   await assert.rejects(bridgeCall(client.config,{...payload,capability:'invalid'}),/unauthorized operation/);
   const ready=join(root,'replay-ready'),script=join(root,'replay.mjs');fs.writeFileSync(script,`import{bridgeCall}from ${JSON.stringify(new URL('../dist/core/win-job-broker.js',import.meta.url).href)};import{writeFileSync}from'node:fs';const result=await bridgeCall(${JSON.stringify(client.config)},${JSON.stringify(payload)});writeFileSync(${JSON.stringify(ready)},JSON.stringify(result));setInterval(()=>{},1000);`);
   const child=cp.spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});owner=await id(child.pid);await until(()=>fs.existsSync(ready));assert.equal(JSON.parse(fs.readFileSync(ready)).ready,true);
   await assert.rejects(bridgeCall(client.config,payload),/READY is one-shot/);assert.equal(readContainment(ref).runnerPid,owner.pid,'replay cannot assign requester');
  }finally{await client.terminate(ref);await stop(owner);}
 });
}
await test('FIX9 evidence is bounded namespace scoped and disabled during mutations',()=>{
 const old=process.env.AI_CLI_MUTATION_TEST;delete process.env.AI_CLI_MUTATION_TEST;
 try{
  const base=join(root,'evidence'),cache=join(base,'ai-cli-windowless-test'),dest=join(base,'saved'),job=join(base,'jobs',randomUUID()),name='TkflycAiCliContainmentBroker-test-'+randomUUID();for(const p of[cache,dest,job])fs.mkdirSync(p,{recursive:true});
  fs.writeFileSync(join(job,'stdout.log'),'x'.repeat(6*1024*1024));for(const[n,v]of[['current',name],['foreign','TkflycAiCliContainmentBroker-test-other'],['old',name]])fs.writeFileSync(join(cache,n+'.host-error'),v);fs.utimesSync(join(cache,'old.host-error'),new Date(0),new Date(0));
  for(let i=0;i<4;i++)fs.writeFileSync(join(job,'output-'+i+'.log'),'x'.repeat(1048576));
  const options={name:'capture',result:{status:'failed'},roots:[join(base,'jobs')],config:{name,directory:join(base,'missing')},cacheRoot:base,destination:dest};const saved=preserveDurableFailure(options);assert.ok(saved);assert.ok(fs.existsSync(join(saved,'windowless','ai-cli-windowless-test','current.host-error')));assert.equal(fs.existsSync(join(saved,'windowless','ai-cli-windowless-test','foreign.host-error')),false);assert.equal(fs.existsSync(join(saved,'windowless','ai-cli-windowless-test','old.host-error')),false);
  const lockPath=join(dest,'.capture.lock'),lock=fs.openSync(lockPath,'wx');try{assert.equal(preserveDurableFailure(options),undefined,'concurrent captures cannot race retention limits');}finally{fs.closeSync(lock);fs.rmSync(lockPath,{force:true});}
  let bytes=0;function size(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())size(f);else bytes+=fs.statSync(f).size;}}size(saved);assert.ok(bytes<=4*1024*1024);
  process.env.AI_CLI_MUTATION_TEST='1';assert.equal(preserveDurableFailure(options),undefined);assert.equal(fs.readdirSync(dest).length,1);delete process.env.AI_CLI_MUTATION_TEST;
  fs.utimesSync(saved,new Date(0),new Date(0));for(let i=1;i<20;i++)fs.mkdtempSync(join(dest,'kept-'));
  const newest=preserveDurableFailure({...options,result:{status:'failed',latest:true}});assert.ok(newest,'full count must retain newest evidence');assert.equal(fs.existsSync(saved),false,'oldest capture evicted first');assert.equal(fs.readdirSync(dest).length,20);assert.equal(JSON.parse(fs.readFileSync(join(newest,'failure.json'))).result.latest,true);
  const bytesDest=join(base,'bytes');fs.mkdirSync(bytesDest);const oldest=fs.mkdtempSync(join(bytesDest,'capture-'));const large=join(oldest,'data.bin');fs.writeFileSync(large,'');fs.truncateSync(large,32*1024*1024);const byteNewest=preserveDurableFailure({...options,destination:bytesDest});assert.ok(byteNewest,'byte cap must make room for newest evidence');assert.equal(fs.existsSync(oldest),false);bytes=0;size(bytesDest);assert.ok(bytes<=32*1024*1024);

  const full=join(base,'full');fs.mkdirSync(full);const f=join(full,'kept.bin');fs.writeFileSync(f,'');fs.truncateSync(f,32*1024*1024);assert.equal(preserveDurableFailure({...options,destination:full}),undefined);assert.equal(fs.readdirSync(full).length,1);
 }finally{if(old===undefined)delete process.env.AI_CLI_MUTATION_TEST;else process.env.AI_CLI_MUTATION_TEST=old;}
});
console.log('FIX9: '+failed+' failed');if(failed)process.exitCode=1;

if(!failed)try{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}catch(e){console.warn('Fixture cleanup deferred: '+root+' '+e.message);}
