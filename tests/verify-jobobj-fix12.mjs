import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WIN_JOB_NATIVE} from '../dist/core/win-job-native.js';
import {powershell} from '../dist/core/win-job-broker.js';
import {RunStore,atomicWrite,kernelRunDir,kernelStateDir,newRunId} from '../dist/ai-cli_kernel/journal.js';
import {takeJournalLock,JournalUnavailableError} from '../dist/ai-cli_kernel/journal-lock.js';
import {settleRunnerRun} from '../dist/ai-cli_kernel/runner-settle.js';
import {buildContract} from '../dist/ai-cli_kernel/templates.js';
import {runKernelLoop} from '../dist/ai-cli_kernel/loop.js';
import {releaseStoppedTestLock} from '../dist/ai-cli_kernel/test-lock.js';
fs.mkdirSync('.tmp',{recursive:true});const root=fs.mkdtempSync(resolve('.tmp/fix12-fixture-'));console.log('EVIDENCE '+root);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let failed=0;
async function test(name,fn){if(process.env.FIX12_TEST_FILTER&&!name.includes(process.env.FIX12_TEST_FILTER))return;try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+'\n'+e.stack);}}
function fresh(open=false){const store=new RunStore(kernelRunDir(newRunId()));store.create(buildContract({goal:'FIX12 persistence fixture',workFolder:resolve('.'),model:'gpt-6.1-sol',decideModel:'gpt-6.1-sol',allowUnverifiedBoundary:true}));store.append({type:'state',state:'running'});if(open){store.append({type:'action_intent',action:{actionId:'a1',kind:'decide',model:'fixture',prompt:'fixture',marker:'fixture'}});store.append({type:'action_started',actionId:'a1',job:{pid:99999999,jobId:'fixture'}});}return store;}
let workerKills=0;const noKill={kill:async()=>{workerKills++;return false;},isGone:async()=>false};
async function reconcile(store,error){const before=store.read(),killsBefore=workerKills;const state=await settleRunnerRun(store,noKill,async()=>{throw error;},async()=>assert.fail('must retain slot'));assert.equal(state,'running');assert.equal(workerKills,killsBefore,'persistence failure must never request worker termination');assert.deepEqual(store.read(),before);const detail=JSON.parse(fs.readFileSync(join(store.dir,'journal-reconcile.json')));assert.equal(detail.reason,'journal_unavailable');assert.equal(detail.observedSeq,before.at(-1).seq);}
async function native(body,edit=s=>s){const type='Fix12'+randomUUID().replaceAll('-','');const source=edit(WIN_JOB_NATIVE).replace('static IntPtr OpenPipe(string name) {',body+'\n  static IntPtr OpenPipe(string name) {').replaceAll('AiCliContainment',type);const result=await powershell(`Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'\n${source}\n'@\n[${type}]::Exercise(${JSON.stringify(root)})`);assert.match(result,/fixture-ok/);}
// Real separate reader; schedule instrumentation never manufactures a filesystem error.
const holderFile=join(root,'holder.mjs');fs.writeFileSync(holderFile,`import fs from 'node:fs';const c=process.argv[2],sleep=ms=>new Promise(r=>setTimeout(r,ms)),end=Date.now()+20000;let fd;try{while(!fs.existsSync(c+'.target')){if(Date.now()>end)throw Error('target deadline');await sleep(2);}fd=fs.openSync(fs.readFileSync(c+'.target','utf8'),'r');fs.writeFileSync(c+'.ready','ready');while(!fs.existsSync(c+'.stop')){if(Date.now()>end)throw Error('release deadline');await sleep(2);}}finally{if(fd!==undefined)fs.closeSync(fd);}`);
function holder(){const c=join(root,randomUUID()),child=spawn(process.execPath,[holderFile,c],{windowsHide:true,stdio:'inherit'});const done=new Promise((r,j)=>{child.once('error',j);child.once('close',code=>code===0?r():j(Error('holder exit '+code)));});done.catch(()=>{});return{engage(file){fs.writeFileSync(c+'.target',file);const end=Date.now()+5000;while(!fs.existsSync(c+'.ready')){assert.ok(Date.now()<end,'reader readiness');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}},async close(){fs.writeFileSync(c+'.stop','stop');if(!fs.existsSync(c+'.target'))fs.writeFileSync(c+'.target',holderFile);await done;}};}
 // Fault-injected JournalUnavailableError at exact journal/identify/wait boundaries;
 // command lifecycle is a counted fake, distinct from the real OS reader tests above.
 for(const kind of ['context','setup','test'])for(const point of ['first journal','begin','identify','second journal','waiting','finished journal'])await test('FIX12B '+kind+' '+point+' has safe disposition',async()=>{
  const runId=newRunId(),store=new RunStore(kernelRunDir(runId)),contract=buildContract({goal:'FIX12B tracking boundary',workFolder:resolve('.'),template:'develop',testCommand:'fake-test',...(kind==='context'?{contextCommand:'fake-context'}:{}),...(kind==='setup'?{setupCommand:'fake-setup'}:{}),model:'gpt-6.1-sol',decideModel:'gpt-6.1-sol',allowUnverifiedBoundary:true,checkpoint:'off',budget:{maxDecides:1,maxWallMinutes:10}},new Date(),{runId,worktree:resolve('.')});
  store.create(contract);const events=[{type:'approved',kind:'contract',contractDigest:store.contractDigest()},{type:'state',state:'running'}];if(kind!=='setup')events.push({type:'workspace_ready',head:'head'});events.push({type:'action_intent',action:{actionId:'a1',kind:'decide',model:contract.decide.model,prompt:'fixture',marker:'fixture'}},{type:'action_result',actionId:'a1',outcome:{ok:true,usage:{input:0,output:0,cached:0}}},{type:'decide_processed',actionId:'a1',ok:true,decision:'plan',plan:{planId:'p1',steps:[]}});for(const e of events)store.append(e);
  const original=store.append.bind(store),fault=new JournalUnavailableError('injected '+point,{cause:Object.assign(Error('injected IO'),{code:'ENOSPC'})});let checks=0,kills=0,begins=0,writes=0,stopped=false,waits=0;
  store.append=e=>{if(e.type==='check_started'){writes++;if(point==='first journal'&&writes===1||point==='second journal'&&writes===2)throw fault;}if(e.type==='check_finished'&&point==='finished journal')throw fault;return original(e);};
  const workspace={prepare(){},refs:()=>[],commitHistory:()=>[],restore(){},inspect:()=>({branch:contract.develop.branch,head:'head',dirty:[],changed:['feature'],ancestorOk:true}),startCheck(command,cwd,log,outputChars,deferStart){checks++;assert.equal(command,'fake-'+kind);assert.equal(deferStart,kind!=='context');return{pid:99999999,begin(){begins++;if(point==='begin')throw fault;},identify:async()=>{if(point==='identify')throw fault;return{started:'fixture',name:'fixture'};},tail:()=>'',kill:async()=>{kills++;await sleep(1);stopped=true;return true;},wait:async()=>{waits++;if(point==='waiting')throw fault;assert.equal(point,'finished journal');stopped=true;return{exitCode:0,tail:''};}};}};
  const killsBefore=workerKills;
  try{const state=await settleRunnerRun(store,noKill,()=>runKernelLoop({store,contract,workspace,executor:{...noKill,start:async()=>assert.fail('no vendor calls')},quota:async()=>80,boundary:async()=>'PASS',agentFor:()=>'codex',versionId:()=>'test',snapshot:()=>null,now:Date.now,sleep:async()=>{},pollMs:1,killConfirmMs:1,pid:process.pid}),async()=>assert.fail('slot must remain'));
   const early=['first journal','begin'].includes(point),ended=point==='finished journal',lease=join(kernelStateDir(),'test.lock');assert.equal(state,'running');assert.equal(checks,1);assert.equal(kills,early?1:0,'stop only unrecorded/unbegun commands');assert.equal(stopped,early||ended,'stop confirmed before lease release');assert.equal(workerKills,killsBefore,'never kill unrelated workers');assert.equal(begins,point==='first journal'?0:1);assert.equal(waits,['waiting','finished journal'].includes(point)?1:0);assert.equal(fs.existsSync(lease),kind!=='context'&&!early&&!ended,'release only a confirmed stopped command');assert.equal(store.read().filter(e=>e.type==='check_started').length,point==='first journal'?0:['waiting','finished journal'].includes(point)?2:1);assert.equal(JSON.parse(fs.readFileSync(join(store.dir,'journal-reconcile.json'))).reason,'journal_unavailable');
  }finally{store.append=original;await releaseStoppedTestLock(runId);}
 });


// Portable fault injection: real lease files, counted fake command; no native reader required.
const fix12cCases=[];
for(const kind of ['context','setup','test'])for(const point of ['initial lease','first journal','begin']){
 if(kind==='context'&&point==='initial lease')continue;
 for(const outcome of ['false','throws'])fix12cCases.push({kind,point,outcome,name:`FIX12C ${kind} ${point} kill ${outcome}`});
}
for(const kind of ['setup','test'])for(const releaseOp of ['read','remove'])fix12cCases.push({kind,point:'first journal',outcome:'true',releaseOp,name:`FIX12C ${kind} release ${releaseOp} preserves original`});
for(const releaseOp of ['read','remove'])fix12cCases.push({kind:'test',point:'finished',outcome:'true',releaseOp,name:`FIX12C release ${releaseOp} without original propagates`});
for(const {kind,point,outcome,releaseOp,name} of fix12cCases)await test(name,async()=>{
 const runId=newRunId(),store=new RunStore(kernelRunDir(runId)),contract=buildContract({goal:'FIX12C cleanup boundary',workFolder:resolve('.'),template:'develop',testCommand:'fake-test',...(kind==='context'?{contextCommand:'fake-context'}:{}),...(kind==='setup'?{setupCommand:'fake-setup'}:{}),model:'gpt-6.1-sol',decideModel:'gpt-6.1-sol',allowUnverifiedBoundary:true,checkpoint:'off',budget:{maxDecides:1,maxWallMinutes:10}},new Date(),{runId,worktree:resolve('.')});
 store.create(contract);const events=[{type:'approved',kind:'contract',contractDigest:store.contractDigest()},{type:'state',state:'running'}];if(kind!=='setup')events.push({type:'workspace_ready',head:'head'});events.push({type:'action_intent',action:{actionId:'a1',kind:'decide',model:contract.decide.model,prompt:'fixture',marker:'fixture'}},{type:'action_result',actionId:'a1',outcome:{ok:true,usage:{input:0,output:0,cached:0}}},{type:'decide_processed',actionId:'a1',ok:true,decision:'plan',plan:{planId:'p1',steps:[]}});for(const e of events)store.append(e);
 const fault=new JournalUnavailableError('FIX12C original '+point),killFault=Error('FIX12C kill rejected'),releaseFault=Object.assign(Error('FIX12C release '+releaseOp),{code:'EIO'}),lease=join(kernelStateDir(),'test.lock');
 const original=store.append.bind(store),rename=fs.renameSync,read=fs.readFileSync,remove=fs.rmSync,log=console.error;
 let armed=false,releaseArmed=false,kills=0,releases=0,slots=0,writes=0,checks=0,observed;const notes=[],killsBefore=workerKills;
 store.append=e=>{if(e.type==='check_started'&&++writes===1&&point==='first journal')throw fault;return original(e);};
 fs.renameSync=(a,b)=>{if(armed&&point==='initial lease'&&String(b)===lease)throw fault;return rename(a,b);};
 fs.readFileSync=(...args)=>{if(releaseArmed&&releaseOp==='read'&&String(args[0])===lease){releases++;throw releaseFault;}return read(...args);};
 fs.rmSync=(...args)=>{if(String(args[0])===lease){releases++;if(releaseArmed&&releaseOp==='remove')throw releaseFault;}return remove(...args);};
 console.error=(...args)=>{notes.push(args);log(...args);};syncBuiltinESMExports();
 const workspace={prepare(){},refs:()=>[],commitHistory:()=>[],restore(){},inspect:()=>({branch:contract.develop.branch,head:'head',dirty:[],changed:['feature'],ancestorOk:true}),startCheck(){checks++;armed=true;return{pid:99999999,begin(){if(point==='begin')throw fault;},identify:async()=>({started:'fixture',name:'fixture'}),tail:()=>'',kill:async()=>{kills++;if(outcome==='throws')throw killFault;if(outcome==='false')return false;releaseArmed=true;return true;},wait:async()=>{assert.equal(point,'finished');releaseArmed=true;return{exitCode:0,tail:''};}};}};
 const run=()=>runKernelLoop({store,contract,workspace,executor:{...noKill,start:async()=>assert.fail('no vendor calls')},quota:async()=>80,boundary:async()=>'PASS',agentFor:()=>'codex',versionId:()=>'test',snapshot:()=>null,now:Date.now,sleep:async()=>{},pollMs:1,killConfirmMs:1,pid:process.pid});
 try{
  if(point==='finished')await assert.rejects(run(),e=>e===releaseFault,'without an original error release failure must propagate unchanged');
  else{
   const state=await settleRunnerRun(store,noKill,async()=>{try{return await run();}catch(e){observed=e;throw e;}},async()=>{slots++;});
   assert.equal(observed,fault,'cleanup must not replace the original JournalUnavailableError');assert.equal(state,'running');assert.equal(slots,0);assert.equal(workerKills,killsBefore);
   assert.equal(JSON.parse(read(join(store.dir,'journal-reconcile.json'),'utf8')).reason,'journal_unavailable');
  }
  assert.equal(checks,1);assert.equal(kills,point==='finished'?0:outcome==='true'?1:point==='initial lease'?1:2,'unconfirmed stop retries exactly once at the outer catch');
  assert.equal(fs.existsSync(lease),kind!=='context','unconfirmed/failed cleanup must retain lease');assert.equal(releases,releaseOp?1:0,'never release without stop confirmation');
  if(releaseOp&&point!=='finished')assert.ok(notes.some(a=>String(a[0]).includes('test lease release failed')&&a[1]===releaseFault),'secondary release error must be recorded as an annotation');
 }finally{store.append=original;fs.renameSync=rename;fs.readFileSync=read;fs.rmSync=remove;console.error=log;syncBuiltinESMExports();await releaseStoppedTestLock(runId);}
});

if(process.platform==='win32'){
 for(const mode of ['ticket','lease'])await test('FIX12 real '+mode+' exhaustion reconciles without killing worker',async()=>{
  const store=fresh(true),h=holder(),rename=fs.renameSync;let held=false,error;
  try{if(mode==='lease'){const file=join(root,'lease.json');fs.writeFileSync(file,'old');h.engage(file);try{atomicWrite(file,'wrong');}catch(e){error=e;}assert.equal(fs.readFileSync(file,'utf8'),'old');}
   else{fs.renameSync=function(a,b){if(String(b).includes('journal.writer.tickets')&&fs.existsSync(b)&&!held){held=true;h.engage(b);}return rename(a,b);};syncBuiltinESMExports();try{takeJournalLock(store.dir);}catch(e){error=e;}}
  }finally{fs.renameSync=rename;syncBuiltinESMExports();await h.close();}
  assert.ok(error instanceof JournalUnavailableError,'real '+mode+' failure must be JournalUnavailableError');assert.ok(['EPERM','EACCES','EBUSY'].includes(error.cause?.code),'original Windows cause retained');
  if(mode==='ticket')assert.deepEqual(fs.readdirSync(join(store.dir,'journal.writer.tickets')),[],'both own ticket paths removed');
  await reconcile(store,error);
 });
 await test('FIX12 filesystem boundaries retain cause and existing journal error identity',async()=>{
  const store=fresh(true);for(const op of ['mkdirSync','readdirSync','writeFileSync']){const real=fs[op],original=Object.assign(Error(op),{code:'ENOSPC'});fs[op]=(...args)=>{if(String(args[0]).includes('journal.writer.tickets'))throw original;return real(...args);};syncBuiltinESMExports();let error;try{takeJournalLock(store.dir);}catch(e){error=e;}finally{fs[op]=real;syncBuiltinESMExports();}assert.ok(error instanceof JournalUnavailableError,op);assert.equal(error.cause,original);await reconcile(store,error);assert.deepEqual(fs.readdirSync(join(store.dir,'journal.writer.tickets')),[]);}
  const original=new JournalUnavailableError('already classified'),mkdir=fs.mkdirSync;fs.mkdirSync=()=>{throw original;};syncBuiltinESMExports();try{assert.throws(()=>takeJournalLock(store.dir),e=>e===original);}finally{fs.mkdirSync=mkdir;syncBuiltinESMExports();}
  assert.throws(()=>atomicWrite(join(root,'missing-parent','file'),'x'),e=>e instanceof JournalUnavailableError&&e.cause.code==='ENOENT');
 });
 for(const point of ['initial lease','identified lease'])await test('FIX12 lease '+point+' write failure has safe disposition',async()=>{
  const runId=newRunId(),store=new RunStore(kernelRunDir(runId));const contract=buildContract({goal:'lease write fixture',workFolder:resolve('.'),template:'develop',testCommand:'fake-test',model:'gpt-6.1-sol',decideModel:'gpt-6.1-sol',allowUnverifiedBoundary:true,checkpoint:'off',budget:{maxDecides:1,maxWallMinutes:10}},new Date(),{runId,worktree:resolve('.')});
  store.create(contract);for(const e of [{type:'approved',kind:'contract',contractDigest:store.contractDigest()},{type:'state',state:'running'},{type:'workspace_ready',head:'head'},{type:'action_intent',action:{actionId:'a1',kind:'decide',model:contract.decide.model,prompt:'fixture',marker:'fixture'}},{type:'action_result',actionId:'a1',outcome:{ok:true,usage:{input:0,output:0,cached:0}}},{type:'decide_processed',actionId:'a1',ok:true,decision:'plan',plan:{planId:'p1',steps:[]}}])store.append(e);
  const h=holder();let checks=0,kills=0;
  // Inspect the persisted lease path through the filesystem observer, not guessed process state.
  const rename=fs.renameSync;let actualLease,armed=false;
  fs.renameSync=function(a,b){if(String(b).endsWith('test.lock'))actualLease=b;return rename(a,b);};syncBuiltinESMExports();
  const engage=()=>{assert.ok(actualLease,'lease path observed');if(!armed){armed=true;h.engage(actualLease);}};
  const workspace={refs:()=>[],commitHistory:()=>[],restore(){},inspect:()=>({branch:contract.develop.branch,head:'head',dirty:[],changed:['feature'],ancestorOk:true}),startCheck(){checks++;if(point==='initial lease')engage();return{pid:99999999,identify:async()=>{if(point==='identified lease')engage();return{started:'fixture',name:'fixture'};},tail:()=>'',kill:async()=>{kills++;return true;},wait:async()=>assert.fail('must not continue check after failed lease write')};}};
  try{const state=await settleRunnerRun(store,noKill,()=>runKernelLoop({store,contract,workspace,executor:{...noKill,start:async()=>assert.fail('no vendor calls')},quota:async()=>80,boundary:async()=>'PASS',agentFor:()=>'codex',versionId:()=>'test',snapshot:()=>null,now:Date.now,sleep:async()=>{},pollMs:1,killConfirmMs:1,pid:process.pid}),async()=>assert.fail('no slot release'));assert.equal(state,'running');assert.equal(checks,1);assert.equal(kills,point==='initial lease'?1:0,'only a durably recorded, begun check is preserved');assert.equal(fs.existsSync(actualLease),point!=='initial lease','unrecorded stopped check releases lease; recorded check retains it');assert.equal(JSON.parse(fs.readFileSync(join(store.dir,'journal-reconcile.json'))).reason,'journal_unavailable');}
  finally{fs.renameSync=rename;syncBuiltinESMExports();await h.close();await releaseStoppedTestLock(runId);}
 });

 await test('FIX12 idle reader yields Gate and serves accepted hello under 400ms',()=>native(`
 static ManualResetEvent BackgroundEntered=new ManualResetEvent(false),Connected=new ManualResetEvent(false),Yielded=new ManualResetEvent(false),ProbeDone=new ManualResetEvent(false);
 static string FirstPath,SecondPath;static bool Entered,Probed;static FileStream Held;
 static void TestBackground(string path){if(path==FirstPath && !Entered){Entered=true;BackgroundEntered.Set();Require(Connected.WaitOne(5000),"client did not connect");}else if(path==SecondPath)Thread.Sleep(800);}
 static void TestYield(){Yielded.Set();Require(ProbeDone.WaitOne(1000),"Gate remained held between generations");}
 public static string Exercise(string root){
  string dir=Path.Combine(root,"idle"),name="TkflycAiCliContainmentBroker-test-"+Guid.NewGuid();Exception fault=null;Thread server=null,probe=null;SafeFileHandle client=null;
  try{
   server=new Thread(delegate(){try{Run(name,dir,60000);}catch(Exception e){fault=e;}});server.IsBackground=true;server.Start();
   var wait=Stopwatch.StartNew();while(!File.Exists(Path.Combine(dir,"broker.json"))){Require(wait.ElapsedMilliseconds<5000,"broker startup");Thread.Sleep(5);}
   lock(Gate){for(int i=0;i<2;i++){string gen=Guid.NewGuid().ToString();var j=new Job{record=new Dictionary<string,object>{{"generation",gen},{"phase","preparing"},{"termination","kill"}}};Save(j);Jobs.Add(gen,j);if(i==0){FirstPath=Path.Combine(dir,gen+".json");Held=new FileStream(FirstPath,FileMode.Open,FileAccess.Read,FileShare.Read);}else SecondPath=Path.Combine(dir,gen+".json");}}
   Require(BackgroundEntered.WaitOne(5000),"background never attempted drain");
   probe=new Thread(delegate(){try{Require(Yielded.WaitOne(5000),"yield missing");if(Monitor.TryEnter(Gate,300)){try{using(var me=new Identity(Process.GetCurrentProcess().Id)){Dispatch(new Dictionary<string,object>{{"op","hello"}},me);Probed=true;}}finally{Monitor.Exit(Gate);}}}finally{ProbeDone.Set();}});probe.Start();
   client=new SafeFileHandle(OpenPipe(name),true);using(var stream=new FileStream(client,FileAccess.ReadWrite,4096,false))using(var me=new Identity(Process.GetCurrentProcess().Id))using(var caller=Caller(me)){
    WriteLine(stream,new {op="hello",callerPid=caller.pid,callerStarted=caller.started});var clock=Stopwatch.StartNew();Connected.Set();string reply=ReadLine(stream);long elapsed=clock.ElapsedMilliseconds;Require((bool)Parse(reply)["ok"],"hello failed: "+reply);Require(elapsed<400,"accepted hello blocked by background drain: "+elapsed);}
   probe.Join();Require(Probed,"Gate was held between generations");return "fixture-ok";
  }finally{Connected.Set();ProbeDone.Set();if(Held!=null)Held.Dispose();if(client!=null)client.Dispose();lock(Gate){Jobs.Clear();Retiring=true;}if(probe!=null)probe.Join(5000);if(server!=null)Require(server.Join(10000),"test broker did not exit");if(fault!=null)throw fault;}
 }
`,s=>s.replace('if(MoveFileExW(temp,path,createOnly?8u:9u))','TestBackground(path);if(MoveFileExW(temp,path,createOnly?8u:9u))').replace('Thread.Yield(); // No registry','TestYield();Thread.Yield(); // No registry')));
 await test('FIX12 idle exit preserves an accepted unserved client',()=>native(`
 static ManualResetEvent AtExit=new ManualResetEvent(false),ClientReady=new ManualResetEvent(false);static bool Once;
 static void TestExit(Task accepting){if(Once)return;Once=true;Retiring=true;AtExit.Set();Require(ClientReady.WaitOne(5000),"client rendezvous");Require(accepting.Wait(5000),"not accepted");}
 public static string Exercise(string root){string name="TkflycAiCliContainmentBroker-test-"+Guid.NewGuid(),dir=Path.Combine(root,"exit-race");Exception fault=null;var thread=new Thread(delegate(){try{Run(name,dir,60000);}catch(Exception e){fault=e;}});thread.IsBackground=true;thread.Start();try{Require(AtExit.WaitOne(5000),"idle check missing");using(var h=new SafeFileHandle(OpenPipe(name),true))using(var stream=new FileStream(h,FileAccess.ReadWrite,4096,false))using(var me=new Identity(Process.GetCurrentProcess().Id))using(var caller=Caller(me)){WriteLine(stream,new {op="hello",callerPid=caller.pid,callerStarted=caller.started});ClientReady.Set();string reply=ReadLine(stream);Require((bool)Parse(reply)["ok"],"accepted hello lost: "+reply);}return "fixture-ok";}finally{ClientReady.Set();lock(Gate){Jobs.Clear();Retiring=true;}Require(thread.Join(10000),"broker not stopped");if(fault!=null)throw fault;}}
`,s=>s.replace('bool drained=true; foreach(var j in Jobs.Values)','TestExit(accepting);bool drained=true; foreach(var j in Jobs.Values)')));
 await test('FIX12 missing pipe notices original server death promptly',async()=>{
  const ready=join(root,'server-ready'),go=join(root,'server-exit');const script=join(root,'server.mjs');fs.writeFileSync(script,`import fs from'node:fs';fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));const end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(go)})){if(Date.now()>end)throw Error('fixture deadline');await new Promise(r=>setTimeout(r,5));}await new Promise(r=>setTimeout(r,100));`);const child=spawn(process.execPath,[script],{windowsHide:true,stdio:'inherit'}),done=new Promise((r,j)=>{child.once('error',j);child.once('close',c=>c===0?r():j(Error('server fixture '+c)));});done.catch(()=>{});
  try{while(!fs.existsSync(ready))await sleep(5);await native(`public static string Exercise(string root){using(var server=new Identity(Int32.Parse(File.ReadAllText(Path.Combine(root,"server-ready"))))){File.WriteAllText(Path.Combine(root,"server-exit"),"exit");var clock=Stopwatch.StartNew();bool rejected=false;try{CloseHandle(OpenPipe("fix12-absent-"+Guid.NewGuid(),server));}catch(IOException e){rejected=e.Message.Contains("broker exited");}Require(rejected && clock.ElapsedMilliseconds<2000,"dead server consumed connect budget");}return "fixture-ok";}`);}finally{fs.writeFileSync(go,'exit');await done;}
 });
 await test('FIX12 terminate itself publishes drained before reply',()=>native(`
 public static string Exercise(string root){DirectoryPath=root;Epoch=Guid.NewGuid().ToString();using(var caller=new Identity(Process.GetCurrentProcess().Id)){string gen=Guid.NewGuid().ToString(),id=Guid.NewGuid().ToString(),secret=Secret();var j=new Job{record=new Dictionary<string,object>{{"jobId",id},{"generation",gen},{"phase","preparing"},{"controlCapability",secret}}};Jobs.Add(gen,j);var r=new Dictionary<string,object>{{"version",1},{"brokerEpoch",Epoch},{"op","terminate"},{"jobId",id},{"generation",gen},{"requestId",Guid.NewGuid().ToString()},{"capability",secret}};var reply=Parse(Json(Dispatch(r,caller)));Require(S(reply,"state")=="drained" && S(Parse(File.ReadAllText(Path.Combine(root,gen+".json"))),"phase")=="drained","terminate failed to drain before reply");}return "fixture-ok";}
 `));
 await test('FIX12 terminated register rejects cached READY and disposes failed identity',()=>native(`
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessHandleCount(IntPtr process,out uint count);
 static uint Handles(){uint count;Require(GetProcessHandleCount(Process.GetCurrentProcess().Handle,out count),"handle count unavailable");return count;}
 public static string Exercise(string root){DirectoryPath=root;Epoch=Guid.NewGuid().ToString();using(var caller=new Identity(Process.GetCurrentProcess().Id)){
  string gen=Guid.NewGuid().ToString(),id=Guid.NewGuid().ToString(),request=Guid.NewGuid().ToString(),secret=Secret();var j=new Job{record=new Dictionary<string,object>{{"jobId",id},{"generation",gen},{"phase","preparing"},{"termination","kill"},{"launchCapability",secret}}};Jobs.Add(gen,j);
  var r=new Dictionary<string,object>{{"version",1},{"brokerEpoch",Epoch},{"op","register"},{"jobId",id},{"generation",gen},{"requestId",request},{"capability",secret}};j.replies[caller.pid+"|"+caller.started+"|register|"+request]=new {ready=true};bool rejected=false;try{Dispatch(r,caller);}catch(InvalidOperationException e){rejected=e.Message.Contains("admission closed");}Require(rejected,"cached READY escaped terminated admission");
  j.replies.Clear();j.record.Remove("termination");uint before=Handles();for(int i=0;i<64;i++){bool failed=false;try{Dispatch(r,caller);}catch(InvalidOperationException e){failed=e.Message=="runner identity changed";}Require(failed,"identity mismatch not exercised");}Require(Handles()<=before+2,"runner Identity leaked on Require failure");
 }return "fixture-ok";}
`,s=>s.replace('Require(runner.started==caller.started && !runner.Exited,"runner identity changed")','Require(false,"runner identity changed")')));
}else console.log('SKIP FIX12 Windows handles');
console.log('FIX12: '+failed+' failed');if(!failed)try{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}catch(e){console.warn('Fixture cleanup deferred: '+root+' '+e.message);}process.exitCode=failed?1:0;
