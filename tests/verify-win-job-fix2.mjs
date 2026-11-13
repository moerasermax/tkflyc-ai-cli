import '../tools/stubs/catalog-test-env.mjs';
import fs,{readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync,readdirSync,renameSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {selectMutations} from '../tools/mutation-selection.mjs';
import {JobStore} from '../dist/core/job-store.js';
import {FileJobExecutor} from '../dist/ai-cli_kernel/executor.js';
import {RunStore} from '../dist/ai-cli_kernel/journal.js';
import {hasContainmentIntent,readBroker,drainedProof} from '../dist/core/containment-store.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {powershell,nativeScript,launchBroker,bridgeCall} from '../dist/core/win-job-broker.js';
import {ensureWindowlessHost,runWindowless} from '../dist/core/win-job-host.js';
import {WIN_JOB_NATIVE} from '../dist/core/win-job-native.js';
import {stopOwnedPty} from '../dist/core/pty-runner.js';
const section=process.env.FIX2_SECTION??'all';
let failed=0,skipped=0;const check=(n,b,d='')=>{console.log(`${b?'PASS':'FAIL'} ${n} ${d}`);if(!b)failed++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),q=s=>"'"+s.replaceAll("'","''")+"'";
async function until(fn,ms=45000){const end=Date.now()+ms;do{if(await fn())return true;await sleep(100);}while(Date.now()<end);return false;}
mkdirSync('.tmp',{recursive:true});const dir=mkdtempSync(resolve('.tmp/fix2-fixtures-'));
const mutation={name:'fixture',file:'fixture',from:'once',to:'bad',platforms:['linux']};
for(const [name,m,source] of [['unknown platform',{...mutation,platforms:['wind32']},'once'],['skipped missing from',mutation,'none'],['skipped repeated from',mutation,'once once']]){
 let rejected=false;try{selectMutations([m],'win32',()=>source);}catch{rejected=true;}check('mutation validation '+name,rejected);
}
const selection=selectMutations([mutation],'win32',()=> 'once');check('mutation all skipped has zero runnable',selection.skipped.length===1&&selection.runnable.length===0);
if(process.platform==='win32'){
 const skipped=JSON.parse(readFileSync('tools/mutations.json','utf8')).find(m=>m.platforms&&!m.platforms.includes('win32'));
 const result=spawnSync(process.execPath,['tools/mutation-test.mjs',process.cwd(),'--name',skipped.name],{windowsHide:true,encoding:'utf8'});
 check('all skipped CLI returns explicit non-success summary',result.status===2&&result.stdout.includes('ALL SKIPPED: SKIP 1, KILLED 0; NO TESTS EXECUTED'));
 const partial=spawnSync(process.execPath,['tools/mutation-test.mjs',process.cwd(),'--name',skipped.name.slice(0,-1)],{windowsHide:true,encoding:'utf8'});
 check('mutation name selection is exact',partial.status===1&&!partial.stdout.includes('ALL SKIPPED'));
}
const bridgeSource=readFileSync('src/core/win-job-broker.ts','utf8');
check('DLL loads exactly verified bytes',bridgeSource.includes('[Reflection.Assembly]::Load($bytes)')&&!bridgeSource.includes('Add-Type -Path $dll'));
check('DLL sidecar precedes atomic publication',bridgeSource.indexOf("[IO.File]::WriteAllText($dll+'.sha256'")<bridgeSource.indexOf('[IO.File]::Replace($tmp,$dll,'));
const id=randomUUID(),state=join(dir,'intent-state');mkdirSync(state);
check('absent intent remains legacy',!hasContainmentIntent(state,id));
const stat=fs.statSync;try{fs.statSync=function(path,...args){if(String(path).includes('containment-intents'))throw Object.assign(Error('fixture denied'),{code:'EACCES'});return stat(path,...args);};syncBuiltinESMExports();check('unreadable intent refuses legacy downgrade',hasContainmentIntent(state,id));}finally{fs.statSync=stat;syncBuiltinESMExports();}
const executor=new FileJobExecutor({platform:'win32',lookup:async()=>new Map()});
try {
 executor.service.startProcess=async()=>({pid:2147483645,jobId:randomUUID()});executor.hold=()=>{};
 for(const mode of ['read','write']){
  const job=await executor.start({kind:'worker',mode,actionId:'fixture',prompt:'stub',model:'stub',cwd:dir},{template:'develop',workFolder:dir,develop:{worktree:dir}});
  const journalDir=join(dir,mode);mkdirSync(journalDir);const journal=new RunStore(journalDir);journal.append({type:'action_started',actionId:'fixture',job});
  const restored=new RunStore(journalDir).read()[0].job;
  check('JobRef and journal preserve '+mode+' containment marker',restored.containmentProtocol===1);
  check('journal marker blocks missing '+mode+' containment record',!await executor.isGone({...restored,tracked:false}));
 }
}finally{executor.service.dispose();}
if(process.platform==='win32'){
 const raceState=join(dir,'publication-race'),raceId=randomUUID(),raceDir=join(raceState,'jobs',raceId);mkdirSync(raceDir,{recursive:true});
 const raceRef={version:1,jobId:raceId,generation:randomUUID(),brokerEpoch:randomUUID()};
 writeFileSync(join(raceDir,'meta.json'),JSON.stringify({version:1,jobId:raceId,pid:2147483645,agent:'grok',source:'cli',resolvedModel:'stub',task:'publication race',workFolder:dir,startTime:new Date().toISOString(),server:null,principal:null,runner:{pid:2147483645,started:'fixture',name:'node'},worker:null,containment:raceRef,recoverable:true}));
 const originalInspect=WinJobClient.prototype.inspect;let synced=0,raceStore;
 try {
  WinJobClient.prototype.inspect=async function(ref){if(ref.jobId!==raceId)return originalInspect.call(this,ref);synced++;writeFileSync(join(raceDir,'exit.json'),JSON.stringify({exitCode:143,timedOut:true,killed:false,endTime:new Date().toISOString()}));return {state:'drained'};};
  raceStore=new JobStore(raceState,'cli',true,async()=>new Map());await raceStore.ready;
  check('broker timeout publication wins over premature lost',synced===1&&raceStore.get(2147483645,raceId).status==='failed');
 }finally{WinJobClient.prototype.inspect=originalInspect;raceStore?.dispose();}
 const bootstrapId=randomUUID(),bootstrapDir=join(raceState,'jobs',bootstrapId);mkdirSync(bootstrapDir);
 const bootstrapMeta={...JSON.parse(readFileSync(join(raceDir,'meta.json'),'utf8')),jobId:bootstrapId,startTime:new Date(0).toISOString(),runner:{pid:2147483645,started:'',name:'node'},containment:{...raceRef,jobId:bootstrapId}};
 writeFileSync(join(bootstrapDir,'bootstrap.json'),JSON.stringify(bootstrapMeta));
 try{WinJobClient.prototype.inspect=async ref=>{if(ref.jobId===bootstrapId)writeFileSync(join(bootstrapDir,'exit.json'),JSON.stringify({exitCode:0,endTime:new Date().toISOString()}));return {state:'drained'};};
 raceStore=new JobStore(raceState,'cli',true,async()=>new Map());await raceStore.ready;
 check('bootstrap grace inspects before marking lost',raceStore.get(2147483645,bootstrapId).status==='completed');
 }finally{WinJobClient.prototype.inspect=originalInspect;raceStore?.dispose();}
 const lateId=randomUUID(),lateDir=join(raceState,'jobs',lateId);mkdirSync(lateDir);
 const lateMeta={...JSON.parse(readFileSync(join(raceDir,'meta.json'),'utf8')),jobId:lateId,containment:{...raceRef,jobId:lateId}};
 writeFileSync(join(lateDir,'meta.json'),JSON.stringify(lateMeta));
 try{WinJobClient.prototype.inspect=async()=>({state:'unknown'});raceStore=new JobStore(raceState,'cli',true,async()=>new Map());await raceStore.ready;
 check('late publication fixture initially lost',raceStore.get(2147483645,lateId).status==='lost');
 writeFileSync(join(lateDir,'exit.json'),JSON.stringify({exitCode:143,endTime:new Date().toISOString()}));
 await until(()=>raceStore.get(2147483645,lateId).status==='failed',5000);
 check('late exit repairs cached lost result',raceStore.get(2147483645,lateId).status==='failed');
 }finally{WinJobClient.prototype.inspect=originalInspect;raceStore?.dispose();}
 let pidCalls=0,nativeCalls=0;const fake={kill:()=>pidCalls++,_agent:{_useConpty:true,_pty:12,_useConptyDll:false,_ptyNative:{kill:(id,dll)=>{if(id===12&&dll===false)nativeCalls++;}}}};
 check('PTY termination uses owned native baton once',stopOwnedPty(fake)&&!stopOwnedPty(fake)&&nativeCalls===1&&pidCalls===0);
 const host=await ensureWindowlessHost(),root=dirname(host),dll=join(root,'native-'+createHash('sha256').update('cache-v3:'+WIN_JOB_NATIVE).digest('hex')+'.dll');
 const oldTemp=new Set(readdirSync(root));
 if(['all','cache'].includes(section)){
 await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));
 renameSync(dll+'.sha256',dll+'.sha256.fix2-'+randomUUID());
 let recovered=false;try{await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));recovered=existsSync(dll+'.sha256');}catch{}
 check('missing DLL sidecar self heals',recovered);
 const original=readFileSync(dll);writeFileSync(dll,Buffer.from('corrupt DLL fixture'));
 try{await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));const bytes=readFileSync(dll);check('corrupt DLL is rebuilt before loading',bytes.subarray(0,2).toString()==='MZ'&&createHash('sha256').update(bytes).digest('hex').toUpperCase()===readFileSync(dll+'.sha256','utf8'));}catch(e){check('corrupt DLL is rebuilt before loading',false,e.message);}
 }
 if(['all','boot'].includes(section)){
 // Fresh assembly with fault injection, not a production bypass flag.
 const unavailable=WIN_JOB_NATIVE.replace('int returned; if(NtQuerySystemInformation(3,buffer,48,out returned)==0 && returned>=8)','int returned=0; if(returned<0)').replace('IntPtr h=OpenProcess(0x1000,false,4);','IntPtr h=IntPtr.Zero;');
 let fallback='';try{fallback=await powershell(`Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'\n${unavailable}\n'@\n'boot=['+[AiCliContainment]::BootIdentity()+']'`);}catch{}
 check('unavailable boot identity returns empty without throwing',fallback.includes('boot=[]'));
 if(fallback.includes('boot=[]')){
 const emptyConfig={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'empty-boot'),idleMs:10000},emptyScript=join(dir,'empty-boot.ps1');let emptyOwner;
 writeFileSync(emptyScript,`\ufeff$ErrorActionPreference='Stop'\nAdd-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'\n${unavailable}\n'@\n[AiCliContainment]::Run(${q(emptyConfig.name)},${q(emptyConfig.directory)},10000)`);
 try {await runWindowless(emptyScript,{},true);await until(()=>!!readBroker(emptyConfig));emptyOwner=readBroker(emptyConfig);const client=new WinJobClient(emptyConfig),ref=await client.prepare(randomUUID());check('empty boot broker accepts and drains a generation',emptyOwner.bootId===''&&(await client.terminate(ref)).state==='drained');}
 finally{emptyOwner??=readBroker(emptyConfig);if(emptyOwner)await powershell(nativeScript(`[AiCliContainment]::StopFixture(${emptyOwner.pid},'${emptyOwner.started}')`)).catch(()=>{});}
 }
 }
 for(const mode of ['timeout','kill','timeout-fast','kill-fast'].filter(mode=>section==='all'||section===mode)){
  const retryDir=join(dir,'retry-'+mode);mkdirSync(retryDir);const log=join(retryDir,'attempts.jsonl');
  const oldOptions=process.env.NODE_OPTIONS,oldLog=process.env.FIX2_RETRY_LOG,oldDelay=process.env.FIX2_RETRY_DELAY;process.env.FIX2_RETRY_DELAY=mode.endsWith('-fast')?'750':'0';
  process.env.NODE_OPTIONS=`--import=${new URL('./helpers/fix2-retry-preload.mjs',import.meta.url).href}`;process.env.FIX2_RETRY_LOG=log;
  const store=new JobStore(join(retryDir,'state'),'cli');let job,meta;
  try{
   await store.ready;job=await store.start({cliPath:process.execPath,args:['-e',`/* FIX2_RETRY_WORKER ${mode.endsWith('-fast')?'KILL_WORKS':''} */setTimeout(()=>{},10000)`],cwd:retryDir,agent:'grok',resolvedModel:'stub',prompt:'retry fixture'},undefined,mode.startsWith('timeout')?500:undefined);
   await until(()=>existsSync(join(job.directory,'meta.json')));meta=JSON.parse(readFileSync(join(job.directory,'meta.json'),'utf8'));
   if(mode.startsWith('kill'))writeFileSync(join(job.directory,'kill.json'),JSON.stringify({runner:meta.runner}));
   await until(()=>existsSync(join(job.directory,'exit.json')));
   const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(p=>p.pid===meta.runner.pid);
   const stderr=readFileSync(join(job.directory,'stderr.log'),'utf8');
   check(mode+' direct termination hints match actual requests',(stderr.match(/direct worker termination requested/g)??[]).length===(mode.endsWith('-fast')?1:0));
   check(mode+' retries exactly three times with backoff',calls.length===3&&calls[1].at-calls[0].at>=(mode.endsWith('-fast')?1650:900)&&calls[2].at-calls[1].at>=(mode.endsWith('-fast')?2650:1900),JSON.stringify(calls));
  }finally{if(oldDelay===undefined)delete process.env.FIX2_RETRY_DELAY;else process.env.FIX2_RETRY_DELAY=oldDelay;if(oldOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=oldOptions;if(oldLog===undefined)delete process.env.FIX2_RETRY_LOG;else process.env.FIX2_RETRY_LOG=oldLog;store.dispose();if(meta?.containment)await new WinJobClient().terminate(meta.containment);}
 }
 if(['all','normal'].includes(section)){
 // Normal-user child owns its broker; elevated parent tests the same-SID pipe/mutex.
 const normal=join(dir,'normal');mkdirSync(normal);const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(normal,'registry'),idleMs:60000};writeFileSync(join(normal,'config.json'),JSON.stringify(config));
 let child,broker;
 try {
  const args='"'+resolve('tests/helpers/fix2-normal-child.mjs')+'" "'+normal+'"';
  child=JSON.parse(await powershell(`Add-Type -TypeDefinition ${q(readFileSync('tests/helpers/fix2-normal-token.cs','utf8'))}\n[NormalTokenFixture]::Start(${q(process.execPath)},${q(args)},${q(process.cwd())})`));
  await until(()=>existsSync(join(normal,'normal-ready.json'))||existsSync(join(normal,'normal-error.txt')));
  if(existsSync(join(normal,'normal-error.txt')))throw Error(readFileSync(join(normal,'normal-error.txt'),'utf8'));
  const result=JSON.parse(readFileSync(join(normal,'normal-ready.json'),'utf8'));broker=result.broker;
  check('normal token broker and stub complete and drain',child.elevated===0&&result.admin==='False'&&result.exit.exitCode===0&&result.drained,JSON.stringify({admin:result.admin,bootId:broker.bootId}));
  check('normal token PID trees have no visible windows',result.visible.length===0);
  const client=new WinJobClient(config),hello=await client.hello(),ref=await client.prepare(randomUUID());
  check('elevated client controls normal same-SID broker',hello.epoch===broker.epoch&&(await client.terminate(ref)).state==='drained');
  await launchBroker(config);await sleep(1200);check('mixed integrity mutex preserves normal broker epoch',readBroker(config).epoch===broker.epoch);
 }catch(e){
  if(!child && /no same-SID same-session non-elevated desktop token available/.test(e.message)) {
   skipped++;console.log('SKIP normal-token and mixed-integrity matrix: no usable non-elevated same-user token in this worker session');
   writeFileSync(join(normal,'SKIPPED.txt'),e.message);
  }else check('normal token validation completed',false,e.stack);
 }
 finally{writeFileSync(join(normal,'normal-release'),'done');await sleep(2500);broker??=readBroker(config);for(const p of [broker,child])if(p)await powershell(nativeScript(`[AiCliContainment]::StopFixture(${p.pid},'${p.started}')`)).catch(()=>{});}
 }
 // At least 1000 retained records: measured actual startup, no bounded-time claim.
 for(const count of (section==='all'?[0,1000]:[])){
  const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'scale-'+count),idleMs:10000};mkdirSync(config.directory);
  for(let i=0;i<count;i++){const generation=randomUUID();writeFileSync(join(config.directory,generation+'.json'),JSON.stringify({version:1,generation,jobId:randomUUID(),brokerEpoch:randomUUID(),phase:'released',bootId:''}));}
  const client=new WinJobClient(config);let broker;try{const start=performance.now();await client.ensure();broker=readBroker(config);const ms=performance.now()-start;console.log('METRIC registry startup',JSON.stringify({count,ms}));check('registry startup '+count+' records',!!broker);
   const owned=readdirSync(root).filter(n=>n.startsWith('broker-')).find(n=>{try{const owner=JSON.parse(readFileSync(join(root,n,'owner.json'),'utf8').replace(/^\ufeff/,''));return owner.pid===broker.pid&&owner.started===broker.started;}catch{return false;}});
   check('broker TEMP records exact owned identity '+count,!!owned);
   if(count===0)await powershell(nativeScript(`[AiCliContainment]::StopFixture(${broker.pid},'${broker.started}')`));
   else await bridgeCall(config,{op:'retire',version:1,brokerEpoch:broker.epoch});
   await sleep(1000);await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));
   check('broker TEMP reclaimed after '+(count===0?'crash':'retire'),!!owned&&!existsSync(join(root,owned)));}finally{if(broker)await powershell(nativeScript(`[AiCliContainment]::StopFixture(${broker.pid},'${broker.started}')`)).catch(()=>{});}
 }
 check('completed bridge calls remove their TEMP directory',!readdirSync(root).some(n=>{if(!n.startsWith('bridge-')||oldTemp.has(n))return false;try{return JSON.parse(readFileSync(join(root,n,'owner.json'),'utf8').replace(/^\ufeff/,'' )).requesterPid===process.pid;}catch{return false;}}));
}
console.log(`FIX2: ${failed} failed; ${skipped} skipped; evidence ${dir}`);process.exitCode=failed?1:0;
