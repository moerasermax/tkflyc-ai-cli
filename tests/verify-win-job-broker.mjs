/** Windows 真機、無模型：隔離測試 broker，僅終止自己建立且核對身分的程序。 */
import '../tools/stubs/catalog-test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WinJobClient } from '../dist/core/win-job-client.js';
import { readBroker, readContainment, drainedProof } from '../dist/core/containment-store.js';
import { powershell, nativeScript, bridgeCall, launchBroker } from '../dist/core/win-job-broker.js';
import { lookupIdentities } from '../dist/core/live-jobs.js';
let passed=0, failed=0;
const check=(n,b,d='')=>{console.log(`${b?'PASS':'FAIL'} ${n}${d?' '+JSON.stringify(d):''}`); b?passed++:failed++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000) { const end=Date.now()+ms; do { const r=await fn(); if(r) return r; await sleep(200); } while(Date.now()<end); return null; }
if(process.platform!=='win32') { console.log('SKIP Windows Job Object native matrix'); process.exit(0); }
const dir=mkdtempSync(join(tmpdir(),'ai-cli-jobobj-test-'));
const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'registry'),idleMs:10000};
const client=new WinJobClient(config);
const moduleUrl=new URL('../dist/core/win-job-client.js',import.meta.url).href;
const fixtures=[];
async function identity(pid) { try { const p=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${pid})`)));return p.exited?undefined:p; } catch{return undefined;} }
async function stop(id) {
  if(!id?.started) return;
  await powershell(nativeScript(`[AiCliContainment]::StopFixture(${id.pid},'${id.started}')`)).catch(()=>{});
  const remaining=await identity(id.pid);
  check('owned fixture identity has exited',remaining?.started!==id.started);
}
async function launch(ref,stay=false) {
  const output=join(dir,ref.generation+'.pid');
  const grand=`require('fs').writeFileSync(${JSON.stringify(output)},String(process.pid));setTimeout(()=>{},90000)`;
  const grandFile=join(dir,ref.generation+'-grand.cjs');writeFileSync(grandFile,grand);
  const middle=`const c=require('child_process').spawn(process.execPath,[${JSON.stringify(grandFile)}],{detached:true,windowsHide:true,stdio:['ignore','ignore',require('fs').openSync(${JSON.stringify(output+'.err')},'a')]});c.on('error',e=>console.error(e));c.unref()`;
  const middleFile=join(dir,ref.generation+'-middle.cjs');writeFileSync(middleFile,middle);
  const script=join(dir,ref.generation+'.mjs');
  writeFileSync(script,`import {WinJobClient} from ${JSON.stringify(moduleUrl)};import {spawn} from 'node:child_process';await new WinJobClient(${JSON.stringify(config)}).register(${JSON.stringify(ref)});console.error('READY');const c=spawn(process.execPath,[${JSON.stringify(middleFile)}],{detached:true,windowsHide:true,stdio:['ignore','ignore','inherit']});await new Promise(r=>c.on('close',code=>{console.error('middle exit',code);r()}));${stay?'setTimeout(()=>{},90000);':''}`);
  const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe'],windowsHide:true,detached:true});
  let err='';child.stderr.on('data',b=>err+=b); const closed=new Promise(r=>child.on('close',r));
  const rid=await identity(child.pid);fixtures.push(rid);
  const found=await until(()=>existsSync(output),25000);
  if(!found) throw new Error('fixture failed before spawn: '+err+(existsSync(output+'.err')?readFileSync(output+'.err','utf8'):''));
  const gid=await identity(Number(readFileSync(output,'utf8')));fixtures.push(gid);
  if(!stay) await closed;
  return {rid,gid};
}
try {
  for (const kind of ['Mutex','Pipe']) {
    const held={...config,name:config.name+'-'+kind,directory:join(dir,kind)},ready=join(dir,kind+'.ready');
    const holder=powershell(nativeScript(`[AiCliContainment]::Hold${kind}Fixture('${held.name}','${ready.replaceAll("'","''")}',10000)`));
    await until(()=>existsSync(ready)); await launchBroker(held); await sleep(2500); const contender=readBroker(held); if(contender)fixtures.push(contender);
    check(kind==='Mutex'?'mutex ownership required before publishing broker':'FIRST_PIPE_INSTANCE rejects an occupied pipe',!readBroker(held));
    await holder;
  }
  const epochs=await Promise.all([client.ensure(),new WinJobClient(config).ensure(),new WinJobClient(config).ensure()]);
  check('broker singleton under concurrent clients',new Set(epochs).size===1,epochs);
  const broker=readBroker(config); fixtures.push(broker);
  const registryFile=join(config.directory,'broker.json'),savedBroker=readFileSync(registryFile);
  const impostor=await identity(process.pid);let refused=false;
  try {writeFileSync(registryFile,JSON.stringify({...broker,...impostor}));try{await client.hello();}catch{refused=true;}}
  finally {writeFileSync(registryFile,savedBroker);}
  check('actual pipe PID rejects same-SID wrong registry identity',refused);
  const naturalId=randomUUID(),natural=join(dir,'jobs',naturalId);(await import('node:fs')).mkdirSync(natural,{recursive:true});
  const naturalResult=JSON.stringify({exitCode:7,timedOut:false,killed:false,endTime:new Date().toISOString()});writeFileSync(join(natural,'exit.json'),naturalResult);
  const naturalRef=await client.prepare(naturalId,natural);await client.terminate(naturalRef);
  check('broker preserves existing natural exit result',readFileSync(join(natural,'exit.json'),'utf8')===naturalResult);
  const acl=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::SecurityFixture('${config.name}','${config.directory.replaceAll("'","''")}')`)));
  check('pipe mutex registry ACL allow only owner SID',['pipe','mutex','directory'].every(key=>{const aces=acl[key].match(/\(A;[^)]+\)/g)||[];return aces.length===1&&[acl.sid,...(acl.sid.endsWith('-500')?['LA']:[])].some(id=>aces[0].includes(';;;'+id+')'))&&!acl[key].includes(';;;WD)')&&!acl[key].includes(';;;AN)');}));
  await launchBroker(config); await sleep(1500);
  check('mutex contender cannot replace live epoch',readBroker(config).epoch===broker.epoch);
  const outside=spawn(process.execPath,['-e','setTimeout(()=>{},90000)'],{stdio:'ignore',windowsHide:true}); const outsideId=await identity(outside.pid);fixtures.push(outsideId);
  const ref=await client.prepare(randomUUID());
  const record=readContainment(ref,config);
  for(const [label,patch] of [['generation',{generation:randomUUID()}],['jobId',{jobId:randomUUID()}],['capability',{capability:'x'.repeat(44)}],['epoch',{brokerEpoch:randomUUID()}]]) {
    let rejected=false;try {await bridgeCall(config,{...ref,op:'inspect',requestId:randomUUID(),capability:record.controlCapability,...patch});}catch {rejected=true;}
    check('native rejects incorrect '+label,rejected);
  }
  const starting=await client.inspect(ref);
  check('empty preparing job is not drained',starting.state==='preparing' && !drainedProof(ref,config));
  let wrong=false; try {await client.register({...ref,generation:randomUUID()});}catch{wrong=true;}
  check('wrong generation rejected before READY',wrong);
  const {gid}=await launch(ref);
  const active=await client.inspect(ref); console.log('INFO instant intermediate orphan',JSON.stringify({pid:gid.pid,...active}));
  check('instant intermediate descendants remain active after runner exit',active.state==='active' && active.activeProcesses>0 && active.runnerExited===true,active);
  const terminated=await client.terminate(ref);
  check('TerminateJobObject drains descendants',terminated.state==='drained',terminated);
  check('unrelated node outside job survives', (await identity(outsideId.pid))?.started===outsideId.started);
  check('drained proof durable before handle close',drainedProof(ref,config));
  const request={...ref,op:'terminate',requestId:randomUUID(),capability:record.controlCapability};
  const first=await bridgeCall(config,request),second=await bridgeCall(config,request);
  check('request replay has identical result',JSON.stringify(first)===JSON.stringify(second));
  let replay=false; try {await client.register(ref);}catch{replay=true;}
  check('register cannot reuse consumed generation',replay);
  const crashRef=await client.prepare(randomUUID()); const orphan=await launch(crashRef);
  await sleep(11000);
  let activeEpoch;try{activeEpoch=(await client.hello()).epoch;}catch{} check('active job prevents idle exit',activeEpoch===broker.epoch);
  await stop(broker);
  const lost=await client.inspect(crashRef);
  check('broker crash is unknown never zero',lost.state==='unknown' && !drainedProof(crashRef,config),lost);
  check('broker crash does not kill orphan',(await identity(orphan.gid.pid))?.started===orphan.gid.started);
  const newEpoch=await client.ensure();fixtures.push(readBroker(config));
  check('new broker epoch cannot impersonate lost job',newEpoch!==crashRef.brokerEpoch && (await client.inspect(crashRef)).state==='unknown');
  check('old drained proof remains valid after restart',(await client.inspect(ref)).state==='drained');
  await sleep(12000);
  let idle=false;try{await client.hello();}catch{idle=true;}
  check('lost generations do not prevent idle handoff',idle);
  const emptyConfig={...config,name:config.name+'-empty',directory:join(dir,'empty')};
  const emptyClient=new WinJobClient(emptyConfig);await emptyClient.ensure();fixtures.push(readBroker(emptyConfig));
  await sleep(12000);let emptyGone=false;try{await emptyClient.hello();}catch{emptyGone=true;}
  check('empty broker exits after idle',emptyGone);
} catch(error) {check('native fixture completed',false,String(error.stack||error));}
finally {for(const f of fixtures.reverse()) await stop(f);}
console.log(`${passed} passed, ${failed} failed; evidence ${dir}`);if(failed) process.exitCode=1;
