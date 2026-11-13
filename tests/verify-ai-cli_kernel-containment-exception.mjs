import '../tools/stubs/catalog-test-env.mjs';
import fs,{mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {JobStore} from '../dist/core/job-store.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
import {readBroker,drainedProof,saveContainmentRef} from '../dist/core/containment-store.js';
import {loadPtyModule,releaseExitedPty,stopOwnedPty} from '../dist/core/pty-runner.js';
import {RunStore,newRunId,kernelRunDir} from '../dist/ai-cli_kernel/journal.js';
import {replayJournal} from '../dist/ai-cli_kernel/replay.js';
import {aiCliKernelCleanup,aiCliKernelCancel} from '../dist/ai-cli_kernel/api.js';
import {aiCliKernelHandleTool} from '../dist/ai-cli_kernel/mcp-tools.js';
import {createDashboardEffects} from '../dist/ai-cli_kernel/dashboard-api.js';
let failed=0;const check=(n,b,d='')=>{console.log(`${b?'PASS':'FAIL'} ${n}${d?' '+d:''}`);if(!b)failed++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rejects=async (fn,reason)=>{try{await fn();return false;}catch(error){return !reason||reason.test(error.message);}};
mkdirSync('.tmp',{recursive:true});const dir=mkdtempSync(resolve('.tmp/phase3-exception-'));
const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'registry'),idleMs:60000};
process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(config);process.env.AI_CLI_STATE_DIR=join(dir,'state');
const childScript=resolve('tests/helpers/phase3-human-cli.mjs');
let store,job,meta,owner,fixtureFault,identityKeeper,identityKeeperDone;const identities=[];
process.on('uncaughtException',error=>{fixtureFault=error;console.error('FIXTURE_ERROR',error.message);});
function rememberIdentity(id){identities.push(id);writeFileSync(join(dir,'owned-identities.json'),JSON.stringify(identities));}
async function exactStop(id){if(id){await powershell(nativeScript(`[AiCliContainment]::StopFixture(${id.pid},'${id.started}')`)).catch(()=>{});check('owned human fixture identity exited',JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${id.pid},'${id.started}')`))).state==='dead');}}
async function tty(mode,scope,run,answer='correct',onPrompt){
 let text='',ended=false,exit,answered=false,interruptSent=0;const signal=join(dir,randomUUID()+'.signal');
 const p=loadPtyModule().spawn(process.execPath,[childScript,mode,scope,run.runId,signal],{name:'xterm-color',cols:160,rows:30,cwd:process.cwd(),env:{...process.env,AI_CLI_WORKER:''},useConpty:true});
 p.onData(data=>{text+=data;});p.onExit(event=>{ended=true;exit=event.exitCode;releaseExitedPty(p);});
 try{
  const deadline=Date.now()+90000;
  while(!ended&&Date.now()<deadline){
   if(fixtureFault)throw fixtureFault;
   const plain=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
   const match=plain.match(/輸入 (kr-\d{8}-\d{6}-[0-9a-f]{4}) ([0-9a-f]{8})：/);
   if(match&&!answered){answered=true;
    check('interactive child has real ConPTY stdin and stdout',text.includes('ACTUAL_TTY true true'));
    const visible=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::VisibleWindows([int[]]@(${p.pid}))`)));
    check('interactive confirmation creates no visible top-level window',visible.length===0);
    if(mode==='recovered')writeFileSync(signal,'recovered');
    if(onPrompt)await onPrompt();
    if(answer==='interrupt'){interruptSent=Date.now();p.write('\x03');}else p.write((answer==='wrong-code'?`${match[1]} bad`:answer==='wrong-run'?`kr-20000101-000000-0000 ${match[2]}`:`${match[1]} ${match[2]}`)+'\r');
   }
   await sleep(40);
  }
  if(fixtureFault)throw fixtureFault;
  if(!ended)throw Error('interactive deadline: '+text.slice(-1200));
  writeFileSync(join(dir,run.runId+'-'+mode+'-'+scope+'.log'),text);
  return {text,exit,answered,interruptMs:interruptSent?Date.now()-interruptSent:null};
 }finally{if(!ended){stopOwnedPty(p);for(let n=0;n<100&&!ended;n++)await sleep(50);}if(ended)releaseExitedPty(p);}
}
function makeRun({blocker=false,state='stop_pending'}={}){
 const runId=newRunId(),run=new RunStore(kernelRunDir(runId));
 // No actual worktree is removed in this fixture. The isolated empty repository
 // exercises cleanup's remaining dependency/release gates after authorization.
 const repo=join(dir,'empty-repo');mkdirSync(repo,{recursive:true});if(!existsSync(join(repo,'.git')))spawnSync('git',['init','-q',repo],{windowsHide:true,encoding:'utf8'});
 run.create({version:1,runId,goal:'harmless containment fixture',template:'develop',workFolder:repo,develop:{repoRoot:repo,worktree:join(dir,runId+'-absent-worktree'),branch:'fixture-missing-branch'},decide:{},worker:{},budget:{}});
 run.append({type:'action_intent',action:{actionId:'a',kind:'worker',mode:'write',marker:'fixture-a',prompt:'no model'}});
 run.append({type:'action_started',actionId:'a',job:{pid:meta.pid,jobId:meta.jobId,containmentProtocol:1,tracked:true}});
 if(blocker)run.append({type:'check_started',kind:'test',pid:2147483645,started:'unknown',name:'fixture blocker'});
 run.append({type:'state',state,reason:'worker_still_alive'});return run;
}
try{
 if(process.platform!=='win32'){console.log('SKIP Windows actual-console matrix');}
 else{
  store=new JobStore(process.env.AI_CLI_STATE_DIR,'cli');await store.ready;
  job=await store.start({cliPath:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:dir,agent:'grok',resolvedModel:'stub',prompt:'harmless loss fixture'});
  for(let n=0;n<300&&!existsSync(join(job.directory,'meta.json'));n++)await sleep(100);
  meta=JSON.parse(readFileSync(join(job.directory,'meta.json'),'utf8'));owner=readBroker(config);
  for(const id of [meta.runner,meta.worker])rememberIdentity(JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${id.pid})`))));
  // Pin only these fixture process objects until the matrix ends. Otherwise a
  // dead root's PID can be reused by inaccessible SYSTEM during this long test.
  // That must block the product, but must not invalidate unrelated positive cases.
  const ready=join(dir,'identity-keeper.json'),release=join(dir,'identity-keeper.release');
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const script=`$ErrorActionPreference='Stop';$held=@();try{
foreach($id in (${quote(JSON.stringify([...identities,owner]))}|ConvertFrom-Json)){$p=[Diagnostics.Process]::GetProcessById($id.pid);$handle=$p.Handle;if($p.StartTime.ToUniversalTime().ToString('o') -ne $id.started){throw 'fixture identity changed'};$held+=,$p}
$me=[Diagnostics.Process]::GetCurrentProcess();@{pid=$me.Id;started=$me.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath ${quote(ready)}
$until=[DateTime]::UtcNow.AddMinutes(15);while(!(Test-Path -LiteralPath ${quote(release)})){if([DateTime]::UtcNow -ge $until){throw 'fixture keeper deadline'};Start-Sleep -Milliseconds 100}
}finally{foreach($p in $held){$p.Dispose()}}`;
  identityKeeper=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
  identityKeeperDone=new Promise((res,rej)=>{identityKeeper.once('error',rej);identityKeeper.once('close',res)});
  for(let n=0;n<150&&!existsSync(ready)&&identityKeeper.exitCode===null;n++)await sleep(100);
  if(!existsSync(ready))throw Error('fixture identity keeper failed');
  await exactStop(owner);for(const id of identities)await exactStop(id);store.dispose();
  check('real broker loss retains released record without drained proof',!drainedProof(meta.containment,config));
  // Exact FIX2 shape: no embedded owner and no epoch archive until next handoff.
  const legacyPath=join(config.directory,meta.containment.generation+'.json'),legacy=JSON.parse(readFileSync(legacyPath,'utf8'));delete legacy.broker;writeFileSync(legacyPath,JSON.stringify(legacy));
  fs.renameSync(join(config.directory,'epochs',owner.epoch+'.json'),join(dir,'original-epoch.saved.json'));
  const run=makeRun();
  for(const mode of ['good','worker']){
   const p=spawnSync(process.execPath,[childScript,mode,'cancel',run.runId,''],{windowsHide:true,encoding:'utf8',input:run.runId+' guessed-code\n',env:{...process.env,AI_CLI_WORKER:''},timeout:30000});
   check('nonTTY pipeline or worker rejected '+mode,p.status!==0&&(p.stderr??'').includes(mode==='worker'?'worker cannot':'stdin/stdout TTY')&&!run.read().some(e=>e.type==='containment_lost_confirmed'),p.stderr?.trim());
  }
  check('API cancel rejects exception fields',await rejects(()=>aiCliKernelCancel({runId:run.runId,confirmContainmentLost:true}),/cancel API rejects exception fields/));
  check('API cleanup rejects exception fields',await rejects(()=>aiCliKernelCleanup({runId:run.runId,confirmContainmentLost:true}),/cleanup API rejects exception fields/));
  const enabled=process.env.AI_CLI_KERNEL;process.env.AI_CLI_KERNEL='on';
  try{check('MCP rejects exception fields',await rejects(()=>aiCliKernelHandleTool('ai-cli_kernel_cancel',{runId:run.runId,confirmContainmentLost:true}),/MCP cancel rejects exception fields/));}
  finally{if(enabled===undefined)delete process.env.AI_CLI_KERNEL;else process.env.AI_CLI_KERNEL=enabled;}
  // A delegated call returning normally would expose silently discarded flags.
  let delegated=false;const effects=createDashboardEffects({aiCliKernelCancel:async()=>{delegated=true;}});
  check('dashboard rejects exception flag before API',await rejects(()=>effects.execute({id:'cancel',runId:run.runId,args:['--confirm-containment-lost']}))&&!delegated);
  for(const [mode,answer] of [['worker','correct'],['active','correct'],['good','wrong-code'],['good','wrong-run'],['recovered','correct'],['fsync','correct']]){
   const r=makeRun(),result=await tty(mode,'cancel',r,answer);
   const expected=mode==='worker'?'worker cannot':mode==='active'||mode==='recovered'?'ActiveProcesses > 0':mode==='fsync'?'injected confirmation fsync failure':'runId or confirmation code mismatch';
   check('confirmation refuses '+mode+' '+answer,result.exit!==0&&result.text.includes(expected)&&replayJournal(r.read()).state==='stop_pending'&&!r.read().some(e=>e.type==='containment_lost_confirmed'),result.text.slice(-220));
  }
  const parent=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${process.pid})`)));
  const recordPath=join(config.directory,meta.containment.generation+'.json'),savedRecord=readFileSync(recordPath,'utf8');
  for(const variant of ['live-broker','corrupt-record','unreleased']){
   const r=makeRun();const record=JSON.parse(savedRecord);
   if(variant==='live-broker')record.broker={...record.broker,...parent,epoch:meta.containment.brokerEpoch,version:1};
   if(variant==='unreleased')record.phase='assigned';
   writeFileSync(recordPath,variant==='corrupt-record'?'{broken':JSON.stringify(record));
   try{const result=await tty('good','cancel',r);check('ineligible loss refuses '+variant,result.exit!==0&&!result.answered&&!r.read().some(e=>e.type==='containment_lost_confirmed'));}
   finally{writeFileSync(recordPath,savedRecord);}
  }
  const aliveChild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  const alive=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${aliveChild.pid})`)));rememberIdentity(alive);
  const metaPath=join(job.directory,'meta.json'),savedMeta=readFileSync(metaPath,'utf8');
  for(const variant of ['runner-worker-alive','runner-alive','worker-alive','worker-unknown']){
   const r=makeRun({state:'paused'}),record=JSON.parse(savedRecord),m=JSON.parse(savedMeta);
   if(variant==='runner-worker-alive'||variant==='runner-alive'){record.runnerPid=alive.pid;record.runnerStarted=alive.started;}
   m.worker=variant==='runner-alive'?JSON.parse(savedMeta).worker:variant==='worker-unknown'?{pid:alive.pid,started:'unknown'}:alive;
   writeFileSync(recordPath,JSON.stringify(record));writeFileSync(metaPath,JSON.stringify(m));
   try{const result=await tty('no-kill','cancel',r);check('live runner or worker cannot be exempted '+variant,result.exit!==0&&!result.answered&&result.text.includes('KILL_ATTEMPT')&&result.text.includes(variant==='worker-unknown'?'death unconfirmed':variant.startsWith('runner')?'runner alive':'worker alive')&&replayJournal(r.read()).state==='paused'&&!r.cancelRequested());}
   finally{writeFileSync(recordPath,savedRecord);writeFileSync(metaPath,savedMeta);}
  }
  // A real cmd /c leaves its node grandchild alive after the cmd is stopped.
  const orphanScript=join(dir,'orphan.cjs'),orphanPid=join(dir,'orphan.pid');
  writeFileSync(orphanScript,"require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)");
  const shell=spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${process.execPath}" "${orphanScript}" "${orphanPid}""`],{windowsHide:true,windowsVerbatimArguments:true,stdio:'ignore'});
  const shellDone=new Promise(r=>shell.once('close',r));
  const shellId=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${shell.pid})`)));rememberIdentity(shellId);
  for(let n=0;n<200&&!existsSync(orphanPid);n++)await sleep(30);
  const grandchild=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${Number(readFileSync(orphanPid,'utf8'))})`)));rememberIdentity(grandchild);
  await exactStop(shellId);await shellDone;
  check('real cmd grandchild outlives both recorded roots',grandchild.parent===shellId.pid&&JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${grandchild.pid},'${grandchild.started}')`))).state==='alive');
  const orphanMeta=JSON.stringify({...JSON.parse(savedMeta),worker:shellId});
  try{
   writeFileSync(metaPath,orphanMeta);
   for(const scope of ['cancel','cleanup']){
    const r=makeRun({state:scope==='cleanup'?'cancelled':'paused'}),result=await tty('no-kill',scope,r);
    check('live orphan refuses '+scope,result.exit!==0&&!result.answered&&result.text.includes(`PID ${grandchild.pid} node.exe`)&&!r.read().some(e=>e.type==='containment_lost_confirmed'));
   }
   writeFileSync(metaPath,savedMeta);
   const r=makeRun(),result=await tty('no-kill','cancel',r,'correct',()=>writeFileSync(metaPath,orphanMeta));
   check('submission rechecks live descendants',result.answered&&result.exit!==0&&result.text.includes(`PID ${grandchild.pid} node.exe`)&&!r.read().some(e=>e.type==='containment_lost_confirmed'));
   await exactStop(grandchild);
   const ended=makeRun(),accepted=await tty('no-kill','cancel',ended);
   check('dead orphan permits confirmation without drained',accepted.answered&&accepted.exit===0&&!drainedProof(meta.containment,config));
  }finally{writeFileSync(metaPath,savedMeta);}
  const queryUnknown=makeRun(),queryResult=await tty('desc-query-fail','cancel',queryUnknown);
  check('failed descendant enumeration remains blocker',queryResult.exit!==0&&!queryResult.answered&&queryResult.text.includes('descendant query unknown'));
  const interrupted=makeRun({state:'paused'}),interruptedResult=await tty('good','cancel',interrupted,'interrupt');
  check('Ctrl+C releases writer with no cancellation side effects',interruptedResult.exit!==0&&interruptedResult.interruptMs<5000&&!interrupted.cancelRequested()&&replayJournal(interrupted.read()).state==='paused'&&fs.readdirSync(join(interrupted.dir,'journal.writer.tickets')).length===0&&!await rejects(()=>new RunStore(interrupted.dir).append({type:'state',state:'paused'})));
  const ancestry=makeRun(),ancestryResult=await tty('ancestry','cancel',ancestry);
  check('cleared worker environment cannot bypass native ancestor check',ancestryResult.exit!==0&&ancestryResult.text.includes('worker ancestry is worker')&&!ancestryResult.answered);
  const redirected=makeRun(),redirectedResult=await tty('stdout-only','cancel',redirected);
  check('stdout-only redirection refuses interactive exception',redirectedResult.exit!==0&&redirectedResult.text.includes('stdin/stdout TTY')&&!redirectedResult.answered);
  const liveRunner=makeRun();writeFileSync(liveRunner.runnerPath,JSON.stringify(parent));
  const liveResult=await tty('good','cancel',liveRunner);
  check('live kernel runner retains journal ownership',liveResult.exit!==0&&liveResult.text.includes('kernel runner alive or unknown')&&!liveRunner.read().some(e=>e.type==='containment_lost_confirmed'));
  // Fixture no longer claims to own a real kernel runner; retain original evidence.
  fs.renameSync(liveRunner.runnerPath,liveRunner.runnerPath+'.fixture-ended');
  const r=makeRun();let exclusive=false;
  const accepted=await tty('good','cancel',r,'correct',async()=>{exclusive=await rejects(()=>new RunStore(r.dir).append({type:'state',state:'completed'}));});
  check('exclusive journal blocks competing writer throughout prompt',exclusive);
  check('realTTY confirmation records event then cancels without drained',accepted.exit===0&&replayJournal(r.read()).state==='cancelled'&&replayJournal(r.read()).reason==='containment_lost_confirmed'&&!drainedProof(meta.containment,config),accepted.text.slice(-250));
  const events=r.read(),index=events.findIndex(e=>e.type==='containment_lost_confirmed'),event=events[index];
  check('confirmation event has actor scope diagnostics and no secrets',!!event&&event.actor.sid.startsWith('S-')&&event.actor.pid>0&&event.scope==='cancel'&&event.jobs[0].generation===meta.containment.generation&&!JSON.stringify(event).includes('Capability')&&!JSON.stringify(event).includes('confirmationCode'));
  check('replay finishes crash between fsynced event and state',!!event&&replayJournal(events.slice(0,index+1)).state==='cancelled');
  check('confirmation replay is idempotent and advances sequence',!!event&&replayJournal([...events,{...event,seq:events.at(-1).seq+1}]).state==='cancelled'&&replayJournal([...events,{...event,seq:events.at(-1).seq+1}]).lastSeq===events.at(-1).seq+1);
  check('ordinary cleanup never inherits cancel exemption',await rejects(()=>aiCliKernelCleanup({runId:r.runId}),/拒絕 cleanup：.*(containment|worktree|追蹤)/));
  const restoredCleanup=await tty('active','cleanup',r);
  check('cleanup restored active count refuses exemption',restoredCleanup.exit!==0&&restoredCleanup.text.includes('ActiveProcesses > 0')&&r.read().filter(e=>e.type==='containment_lost_confirmed').length===1);
  const cleanup=await tty('good','cleanup',r);
  check('cleanup requires fresh TTY scope event',cleanup.exit===0&&r.read().filter(e=>e.type==='containment_lost_confirmed').map(e=>e.scope).join(',')==='cancel,cleanup',cleanup.text.slice(-200));
  const other=makeRun({blocker:true}),blocked=await tty('good','cancel',other);
  check('other blockers remain stop_pending after confirmation',blocked.exit===0&&replayJournal(other.read()).state==='stop_pending'&&other.read().some(e=>e.type==='containment_lost_confirmed'));
 }
}catch(e){check('matrix completed',false,e.stack);}
finally{try{store?.dispose();for(const id of identities)await exactStop(id);await exactStop(owner);await exactStop(readBroker(config));}finally{if(identityKeeper){writeFileSync(join(dir,'identity-keeper.release'),'1');check('fixture identity keeper exits after releasing held process objects',await identityKeeperDone===0);}}}
if(fixtureFault)check('asynchronous fixture error is reported',false,fixtureFault.message);
console.log(`Containment exception: ${failed} failed; evidence ${dir}`);process.exitCode=failed?1:0;
