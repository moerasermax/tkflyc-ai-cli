import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {WIN_JOB_NATIVE} from '../dist/core/win-job-native.js';
import {powershell,nativeScript,bridgeCall} from '../dist/core/win-job-broker.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {readBroker,readContainment,drainedProof} from '../dist/core/containment-store.js';
import {JobStore,jobHeld} from '../dist/core/job-store.js';
import {atomicWrite} from '../dist/ai-cli_kernel/journal.js';
import {retryJournalIO,takeJournalLock,JournalUnavailableError} from '../dist/ai-cli_kernel/journal-lock.js';
import {writerIdentity} from '../dist/ai-cli_kernel/journal-owner.js';
fs.mkdirSync('.tmp',{recursive:true});const root=fs.mkdtempSync(resolve('.tmp/fix11-fixture-'));console.log('EVIDENCE '+root);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let failed=0;
async function test(name,fn){if(process.env.FIX11_TEST_FILTER&&!name.includes(process.env.FIX11_TEST_FILTER))return;try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+'\n'+e.stack);}}
async function until(fn,ms=20000){const end=Date.now()+ms;do{if(await fn())return;await sleep(10);}while(Date.now()<end);throw Error('fixture deadline');}
const evidence=async b=>JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${b.pid},'${b.started}')`)));
async function stop(b){if(b?.started&&(await evidence(b)).state==='alive'){try{await powershell(nativeScript(`[AiCliContainment]::StopFixture(${b.pid},'${b.started}')`));}catch(e){if((await evidence(b)).state!=='dead')throw e;}}}
async function native(name,body,edit=s=>s){
 const type='Fix11'+randomUUID().replaceAll('-','');
 const source=edit(WIN_JOB_NATIVE).replace('static IntPtr OpenPipe(string name) {',body+'\n  static IntPtr OpenPipe(string name) {').replaceAll('AiCliContainment',type);
 const result=await powershell(`Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'\n${source}\n'@\n[${type}]::Exercise(${JSON.stringify(root)})`);assert.match(result,new RegExp(name));
}
if(process.platform==='win32'){
 await test('FIX11 background single attempt foreground backoff and temp cleanup',()=>{return native('persist-ok',`
 static List<int> TestDelays=new List<int>();static ManualResetEvent RetrySeen=new ManualResetEvent(false);
 public static string Exercise(string root) {
  string path=Path.Combine(root,"persist.json");Persist(path,new {value=1});
  using(var reader=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
   var clock=Stopwatch.StartNew();bool rejected=false;try { Persist(path,new {value=2},false,true); } catch(Win32Exception e) { rejected=e.Message.Contains("after 1 attempt(s)"); }
   Require(rejected && clock.ElapsedMilliseconds<250,"background spent retry budget");
   Require(Directory.GetFiles(root,"persist.json.*.tmp").Length==0,"failed temp leaked");
  }
  var held=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);
  var release=new Thread(delegate(){RetrySeen.WaitOne(5000);Thread.Sleep(100);held.Dispose();});release.Start();var watch=Stopwatch.StartNew();
  try {Persist(path,new {value=3});}finally{release.Join();held.Dispose();}
  Require(watch.ElapsedMilliseconds>=80 && watch.ElapsedMilliseconds<750,"foreground backoff not bounded");
  Require(TestDelays.Count>0,"backoff not exercised");int[] expected=new[]{1,2,5,10};for(int i=0;i<Math.Min(4,TestDelays.Count);i++)Require(TestDelays[i]==expected[i],"increasing delays missing");
  Require(N(Parse(File.ReadAllText(path)),"value")==3,"replacement missing");return "persist-ok";
 }
`,s=>s.replace("Thread.Sleep((int)Math.Min(delay,remaining));","TestDelays.Add(delay);RetrySeen.Set();Thread.Sleep((int)Math.Min(delay,remaining));"));});
 await test('FIX11 exit temp reader retries and Error retains Win32 code',()=>native('exit-temp-ok',`
 [DllImport("kernel32.dll",SetLastError=true)] static extern void SetLastError(uint error);
 static FileStream TestReader; static Thread ReleaseReader;
 public static string Exercise(string root) {
  string path=Path.Combine(root,"exit.json");
  var clock=Stopwatch.StartNew();try{Persist(path,new {exitCode=143},true);}finally{if(ReleaseReader!=null)ReleaseReader.Join();if(TestReader!=null)TestReader.Dispose();}
  Require(clock.ElapsedMilliseconds>=200 && N(Parse(File.ReadAllText(path)),"exitCode")==143,"temp reader not retried");
  SetLastError(5);Require(Error("AssignProcessToJobObject").Message.Contains("win32=5"),"native error code missing");return "exit-temp-ok";
 }
`,s=>s.replace('var clock=Stopwatch.StartNew();\n    try { for(int attempt=1;',`if(Path.GetFileName(path)=="exit.json") { TestReader=new FileStream(temp,FileMode.Open,FileAccess.Read,FileShare.Read);ReleaseReader=new Thread(delegate(){Thread.Sleep(250);TestReader.Dispose();});ReleaseReader.Start(); }
    var clock=Stopwatch.StartNew();
    try { for(int attempt=1;`)));
 await test('FIX11 real pipe busy and missing retry beyond one second before write',()=>native('pipe-ok',`
 public static string Exercise(string root) {
  foreach(bool busy in new[]{false,true}) {
   string name="fix11-"+Guid.NewGuid().ToString();NamedPipeServerStream old=null;IntPtr occupied=IntPtr.Zero;
   if(busy){old=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous);var pending=old.BeginWaitForConnection(null,null);occupied=OpenPipe(name);old.EndWaitForConnection(pending);}
   Exception fault=null;var thread=new Thread(delegate(){try{Thread.Sleep(1500);if(old!=null)old.Dispose();using(var server=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous)){var pending=server.BeginWaitForConnection(null,null);Require(pending.AsyncWaitHandle.WaitOne(7000),"client never connected");server.EndWaitForConnection(pending);}}catch(Exception e){fault=e;}});thread.Start();
   var clock=Stopwatch.StartNew();try{IntPtr h=OpenPipe(name);CloseHandle(h);Require(clock.ElapsedMilliseconds>=1200 && clock.ElapsedMilliseconds<6000,"connect retry budget failed");}finally{if(occupied!=IntPtr.Zero)CloseHandle(occupied);thread.Join();if(old!=null)old.Dispose();}
   if(fault!=null)throw fault;
  }
  return "pipe-ok";
 }
`));
 await test('FIX11 rolled back runner self heals after reader spans register and terminate',async()=>{
  const c={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(root,'broker'),idleMs:60000};
  await new WinJobClient({...c,idleMs:5000}).ensure();const broker=readBroker(c),old={c:process.env.AI_CLI_CONTAINMENT_TEST,n:process.env.NODE_OPTIONS,r:process.env.FIX11_READER};
  const rendezvous=join(root,'rendezvous');fs.mkdirSync(rendezvous);process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(c);process.env.NODE_OPTIONS='--import '+JSON.stringify(pathToFileURL(resolve('tests/helpers/fix11-register-preload.mjs')).href);process.env.FIX11_READER=rendezvous;
  const store=new JobStore(join(root,'state'));await store.ready;let fd,ref;
  try{
   const job=await store.start({cliPath:process.execPath,args:[resolve('tools/stubs/durable-agent.mjs'),'claude'],cwd:root,agent:'claude',prompt:'{}',stdinPrompt:'{}',resolvedModel:'fixture'});
   await until(()=>fs.existsSync(join(rendezvous,'register')));ref=JSON.parse(fs.readFileSync(join(rendezvous,'register')));const record=readContainment(ref,c);fd=fs.openSync(join(c.directory,ref.generation+'.json'),'r');fs.writeFileSync(join(rendezvous,'go'),'go');
   await until(()=>fs.existsSync(join(rendezvous,'terminated-2')));assert.equal(drainedProof(ref,c),false);assert.equal(jobHeld(job.directory),true);assert.equal(readContainment(ref,c).phase,'preparing');
   // Keep the same real reader beyond both failed RPCs. No inspect/terminate after release can help the idle path.
   await assert.rejects(bridgeCall(c,{...ref,op:'register',requestId:randomUUID(),capability:record.launchCapability}),/runner admission closed by termination/);
   await sleep(2000);fs.closeSync(fd);fd=undefined;
   await until(()=>drainedProof(ref,c));assert.equal(jobHeld(job.directory),false);assert.equal(fs.readdirSync(c.directory).filter(n=>n.endsWith('.tmp')).length,0);
   await until(async()=> (await evidence(broker)).state==='dead');
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.writeFileSync(join(rendezvous,'go'),'go');if(ref)await new WinJobClient(c).terminate(ref);store.dispose();await stop(broker);for(const[k,v]of [['AI_CLI_CONTAINMENT_TEST',old.c],['NODE_OPTIONS',old.n],['FIX11_READER',old.r]])if(v===undefined)delete process.env[k];else process.env[k]=v;}
 });
 // Real OS handles, separate process so synchronous retries cannot prevent release.
 const holderScript=join(root,'holder.mjs');fs.writeFileSync(holderScript,`import fs from 'node:fs';const [control]=process.argv.slice(2);const end=Date.now()+15000;const sleep=ms=>new Promise(r=>setTimeout(r,ms));let fd;try{while(!fs.existsSync(control+'.target')){if(Date.now()>end)throw Error('holder target deadline');await sleep(1);}const target=JSON.parse(fs.readFileSync(control+'.target'));fd=fs.openSync(target.file,target.exclusive?0x10000000:'r');fs.writeFileSync(control+'.ready','ready');while(!fs.existsSync(control+'.go')&&!fs.existsSync(control+'.stop')){if(Date.now()>end)throw Error('holder release deadline');await sleep(1);}if(!fs.existsSync(control+'.stop'))await sleep(target.delay??20);}finally{if(fd!==undefined)fs.closeSync(fd);}`);
 async function holder(){const control=join(root,randomUUID()),child=spawn(process.execPath,[holderScript,control],{windowsHide:true,stdio:'inherit'});const done=new Promise((r,j)=>{child.once('error',j);child.once('close',code=>code===0?r():j(Error('holder '+code)));});done.catch(()=>{});return {control,done,close:async()=>{fs.writeFileSync(control+'.stop','stop');if(!fs.existsSync(control+'.target'))fs.writeFileSync(control+'.target',JSON.stringify({file:holderScript}));await done;}};}
 function engage(h,file,exclusive=false,delay=20){fs.writeFileSync(h.control+'.target',JSON.stringify({file,exclusive,delay}));const end=Date.now()+5000;while(!fs.existsSync(h.control+'.ready')){if(Date.now()>end)throw Error('holder readiness');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}}
 await test('FIX11 journal atomicWrite retries real reader and preserves old lease on exhaustion',async()=>{
  const file=join(root,'lease.json');fs.writeFileSync(file,'old');
  for(const persistent of [false,true]){const h=await holder(),rename=fs.renameSync;let attempts=0;engage(h,file);fs.renameSync=function(a,b){try{return rename(a,b);}catch(e){if(b===file){attempts++;if(!persistent)fs.writeFileSync(h.control+'.go','go');}throw e;}};syncBuiltinESMExports();
   try{const t=performance.now();if(persistent){assert.throws(()=>atomicWrite(file,'wrong'),e=>e instanceof JournalUnavailableError && e.cause?.code==='EPERM');assert.equal(fs.readFileSync(file,'utf8'),'new');assert.ok(performance.now()-t>=200&&performance.now()-t<1000);}else{atomicWrite(file,'new');assert.equal(fs.readFileSync(file,'utf8'),'new');}assert.ok(attempts>1);console.log('journal rename attempts '+attempts+' ms '+(performance.now()-t).toFixed(1));}
   finally{fs.renameSync=rename;syncBuiltinESMExports();await h.close();}
  }
 });
 await test('FIX11 journal ticket overwrite retries real reader',async()=>{
  writerIdentity();const dir=join(root,'ticket-write');fs.mkdirSync(dir);const h=await holder(),rename=fs.renameSync;let held=false,attempts=0;
  fs.renameSync=function(a,b){if(String(b).includes('journal.writer.tickets')&&fs.existsSync(b)&&!held){engage(h,b);held=true;}try{return rename(a,b);}catch(e){if(held){attempts++;fs.writeFileSync(h.control+'.go','go');}throw e;}};syncBuiltinESMExports();
  try{const release=takeJournalLock(dir);release();assert.ok(held&&attempts>1);assert.equal(fs.readdirSync(join(dir,'journal.writer.tickets')).length,0);}finally{fs.renameSync=rename;syncBuiltinESMExports();await h.close();}
 });
 await test('FIX11 journal ticket read retries real exclusive handle',async()=>{
  writerIdentity();const dir=join(root,'ticket-read'),tickets=join(dir,'journal.writer.tickets');fs.mkdirSync(tickets,{recursive:true});const file=join(tickets,'other.json');fs.writeFileSync(file,JSON.stringify({owner:writerIdentity(),number:999}));
  const h=await holder(),read=fs.readFileSync;let attempts=0;engage(h,file,true);
  fs.readFileSync=function(p,...args){try{const value=read(p,...args);if(p===file&&attempts>0)fs.unlinkSync(file);return value;}catch(e){if(p===file){attempts++;fs.writeFileSync(h.control+'.go','go');}throw e;}};syncBuiltinESMExports();
  try{const release=takeJournalLock(dir);release();assert.ok(attempts>1,'real read failed and retried');}finally{fs.readFileSync=read;syncBuiltinESMExports();await h.close();}
 });
 await test('FIX11 journal retry total deadline and error classes stay bounded',async()=>{
  const file=join(root,'deadline.json');fs.writeFileSync(file,'old');const h=await holder();engage(h,file,true);let attempts=0;
  try{const t=performance.now();assert.throws(()=>retryJournalIO(()=>{attempts++;return fs.readFileSync(file);},Date.now()+40),e=>['EPERM','EACCES','EBUSY'].includes(e.code));assert.ok(attempts>1&&performance.now()-t>=30&&performance.now()-t<200);}
  finally{await h.close();}
  for(const code of ['EPERM','EACCES','EBUSY']){let calls=0;assert.equal(retryJournalIO(()=>{if(++calls===1)throw Object.assign(Error(code),{code});return 7;}),7);assert.equal(calls,2);}
  let calls=0;assert.throws(()=>retryJournalIO(()=>{calls++;throw Object.assign(Error('permanent'),{code:'ENOENT'});}),/permanent/);assert.equal(calls,1);
 });
}else console.log('SKIP FIX11 Windows handles');
console.log('FIX11: '+failed+' failed');if(!failed)try{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}catch(e){console.warn('Fixture cleanup deferred: '+root+' '+e.message);}process.exitCode=failed?1:0;
