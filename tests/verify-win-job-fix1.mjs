import '../tools/stubs/catalog-test-env.mjs';
import{readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,existsSync,renameSync}from'node:fs';
import{join,dirname}from'node:path';import{randomUUID,createHash}from'node:crypto';
import{WIN_JOB_NATIVE}from'../dist/core/win-job-native.js';
import{WinJobClient}from'../dist/core/win-job-client.js';import{powershell,nativeScript,bridgeCall}from'../dist/core/win-job-broker.js';
import{readBroker,readContainment,drainedProof,markContainmentIntent}from'../dist/core/containment-store.js';
import{jobStateDir}from'../dist/core/live-jobs.js';import{FileJobExecutor}from'../dist/ai-cli_kernel/executor.js';
import{JobStore}from'../dist/core/job-store.js';import{ensureWindowlessHost}from'../dist/core/win-job-host.js';
import{confirmFullPermissionGone}from'../dist/ai-cli_kernel/full-permission.js';
let failed=0;function check(n,b){console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;}
const text=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8');
const native=text('src/core/win-job-native.ts'),host=text('src/core/win-job-host.ts');
for(const file of ['src/core/live-jobs.ts','src/core/process-tree.ts'])check('identity PowerShell process Bypass '+file,text(file).includes("'-ExecutionPolicy', 'Bypass'"));
check('process ExecutionPolicy Bypass on native and bootstrap launches',host.includes('-ExecutionPolicy Bypass -File')&&host.includes("'-ExecutionPolicy','Bypass'"));
check('native verifies owner SID',native.includes('Require(!requireOwner || sid==SID,"owner SID mismatch")')&&native.includes('bool requireOwner=true'));
check('pipe uses identification SQOS',native.includes('3,0x00110000,IntPtr.Zero'));
if(process.platform==='win32'&&!failed){
 mkdirSync(join(process.cwd(),'.tmp'),{recursive:true});
 const dir=mkdtempSync(join(process.cwd(),'.tmp','fix1-fixtures-'));
 const ref={version:1,jobId:randomUUID(),generation:randomUUID(),brokerEpoch:randomUUID()};
 const mock=new WinJobClient({name:'fake',directory:dir,idleMs:10000});mock.call=async()=>({state:'drained'});
 check('broker drained without durable proof remains unknown',(await mock.inspect(ref)).state==='unknown');
 writeFileSync(join(dir,ref.generation+'.json'),JSON.stringify({...ref,phase:'drained',terminalProof:{runnerExited:true,activeProcesses:1,at:new Date().toISOString()}}));
 check('nonzero durable proof remains unknown',(await mock.inspect(ref)).state==='unknown');
 const state=jobStateDir(),id=randomUUID(),jobDir=join(state,'jobs',id);mkdirSync(jobDir,{recursive:true});
 const old={version:1,jobId:id,pid:2147483645,agent:'grok',resolvedModel:'stub',source:'cli',task:'legacy fixture',workFolder:dir,startTime:new Date().toISOString(),server:null,principal:null,runner:{pid:2147483645,started:'old',name:'fixture'},worker:{pid:2147483644,started:'old',name:'fixture'},recoverable:true};
 writeFileSync(join(jobDir,'meta.json'),JSON.stringify(old));
 let alive=false;const executor=new FileJobExecutor({platform:'win32',lookup:async()=>alive?new Map([[old.runner.pid,old.runner]]):new Map(),mayBeAlive:()=>false});
 const job={pid:old.pid,jobId:id,tracked:true};
 check('genuine legacy dead identities release with notice',await executor.isGone(job)&&job.legacyNotice?.includes('子孫未驗證'));
 alive=true;check('legacy original runner alive stays blocked',!await executor.isGone(job));alive=false;
 const notices=[];const block=await confirmFullPermissionGone([{spec:{actionId:'legacy',kind:'worker',mode:'write'},job}],{executor,now:Date.now,sleep:async()=>{},pollMs:1,confirmMs:0,onLegacy:n=>notices.push(n)},{kill:false});
 check('legacy release exposes journal notice',!block&&notices.some(n=>n.includes('子孫未驗證')));
 markContainmentIntent(state,id);
 check('executor missing modern index stays blocked',!await executor.isGone(job));
 executor.service.dispose();
 const savedState=process.env.AI_CLI_STATE_DIR,badState=join(dir,'unreadable-state');mkdirSync(badState);
 try {
  process.env.AI_CLI_STATE_DIR=badState;
  const collected={pid:2147483645,jobId:randomUUID()};
  check('legacy collected logs release with explicit warning',await executor.isGone(collected)&&collected.legacyNotice?.includes('子孫未驗證'));
  writeFileSync(join(badState,'jobs'),'fixture: not a directory');
  check('legacy unreadable jobs root stays blocked',!await executor.isGone({pid:2147483645,jobId:randomUUID()}));
 } finally {if(savedState===undefined)delete process.env.AI_CLI_STATE_DIR;else process.env.AI_CLI_STATE_DIR=savedState;}

 // A simulated previous boot exercises publication, not an actual machine reboot.
 const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'registry'),idleMs:10000};mkdirSync(config.directory);
 const boot=await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));
 const proofBoot=await powershell(nativeScript('[AiCliContainment]::Pid4BootIdentity()'));
 const previous={...ref,bootId:boot,proofBootId:'1',phase:'released'},same={...ref,jobId:randomUUID(),generation:randomUUID(),bootId:boot,proofBootId:proofBoot,phase:'released'},unknown={...ref,jobId:randomUUID(),generation:randomUUID(),phase:'released'};
 const legacyNumeric={...ref,jobId:randomUUID(),generation:randomUUID(),bootId:'1',phase:'released'},emptyProof={...ref,jobId:randomUUID(),generation:randomUUID(),bootId:'1',proofBootId:'',phase:'released'};
 const tombstone={...ref,jobId:randomUUID(),generation:randomUUID(),phase:'drained',launchCapability:'secret',controlCapability:'secret',terminalProof:{runnerExited:true,activeProcesses:0,at:'2020-01-01T00:00:00Z'}};
 for(const r of[previous,same,unknown,tombstone,legacyNumeric,emptyProof])writeFileSync(join(config.directory,r.generation+'.json'),JSON.stringify(r));
 const client=new WinJobClient(config);let owner;
 try{
  await client.ensure();owner=readBroker(config);
  for(const r of [previous,same,unknown,tombstone,legacyNumeric,emptyProof])await bridgeCall(config,{...r,op:"recover",brokerEpoch:owner.epoch,targetEpoch:r.brokerEpoch});
  check('previous boot publishes reboot drained proof',drainedProof(previous,config)&&readContainment(previous,config)?.termination==='reboot');
  check('same boot lost and missing boot remain unknown',!drainedProof(same,config)&&!drainedProof(unknown,config));
  check('legacy numeric boot without proofBootId recovers',drainedProof(legacyNumeric,config));
  check('explicit empty proofBootId blocks numeric fallback',!drainedProof(emptyProof,config));
  check('broker stores stable kernel boot identity',owner.bootId===boot);
  check('old terminal record compacts capabilities but keeps durable proof',drainedProof(tombstone,config)&&!readContainment(tombstone,config).controlCapability);
  const hello=await bridgeCall(config,{op:'hello',version:99,brokerEpoch:owner.epoch});check('hello negotiates across protocol versions',hello.version===1);
  const pending=await client.prepare(randomUUID());
  await bridgeCall(config,{op:'retire',version:1,brokerEpoch:owner.epoch});
  let rejected=false;try{await client.prepare(randomUUID());}catch{rejected=true;}
  check('retiring broker rejects admission but drains owned generation',rejected&&(await client.terminate(pending)).state==='drained');
  await new Promise(r=>setTimeout(r,1600));let ended=false;try{await client.hello();}catch{ended=true;}check('retired empty broker exits despite same-boot lost records',ended);
 }finally{owner??=readBroker(config);if(owner){await powershell(nativeScript(`[AiCliContainment]::StopFixture(${owner.pid},'${owner.started}')`)).catch(()=>{});let current;try{current=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${owner.pid})`)));}catch{}check('boot fixture exact broker identity exited',current?.started!==owner.started||current.exited);}}
 const store=new JobStore(state,'cli');await store.ready;
 try{
  let rejected=false;try{await store.start({cliPath:process.execPath,args:[],cwd:dir,agent:'grok',resolvedModel:'stub',prompt:'prepare exception',temporaryPromptFile:join(dir,'missing-prompt')});}catch{rejected=true;}
  const c=JSON.parse(process.env.AI_CLI_CONTAINMENT_TEST);
  const records=readdirSync(c.directory).filter(n=>n!=='broker.json'&&n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(c.directory,n),'utf8')));
  check('post-prepare exception drains preparing generation',rejected&&records.length>0&&records.every(r=>drainedProof(r,c)));
 }finally{store.dispose();}
 // Removing a cached path is simulated by rename; preserve original fixture artifact.
 const helper=await ensureWindowlessHost();renameSync(helper,helper+'.fix1-saved-'+randomUUID());
 check('missing helper safely rebuilds',await ensureWindowlessHost()===helper&&existsSync(helper));
 const root=dirname(helper),dlls=readdirSync(root).filter(n=>n.endsWith('.dll')&&n.startsWith('native-'));
 check('native DLL is cached with hash sidecar',dlls.some(n=>existsSync(join(root,n+'.sha256'))));
 const checksum=join(root,'native-'+createHash('sha256').update('cache-v3:'+WIN_JOB_NATIVE).digest('hex')+'.dll.sha256'),saved=readFileSync(checksum,'utf8');
 let rejected=false;try{writeFileSync(checksum,'00');try{await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));rejected=readFileSync(checksum,'utf8')!=='00';}catch{}}finally{writeFileSync(checksum,saved);}
 check('cached DLL integrity mismatch rebuilds before loading',rejected);
}
console.log(`FIX1: ${failed} failed`);process.exitCode=failed?1:0;
