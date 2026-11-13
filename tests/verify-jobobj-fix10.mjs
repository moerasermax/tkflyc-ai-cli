import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {JobStore,readJobExit} from '../dist/core/job-store.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {readBroker,readContainment,drainedProof} from '../dist/core/containment-store.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
import {WIN_JOB_NATIVE} from '../dist/core/win-job-native.js';
import {preserveDurableFailure,assertDurableStatus} from './helpers/durable-failure-evidence.mjs';
fs.mkdirSync('.tmp',{recursive:true});
const root=fs.mkdtempSync(resolve('.tmp/fix10-fixture-'));console.log('EVIDENCE '+root);
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),quote=s=>"'"+s.replaceAll("'","''")+"'";
let failed=0;
async function test(name,fn){if(process.env.FIX10_TEST_FILTER&&!name.includes(process.env.FIX10_TEST_FILTER))return;try{await fn();console.log('PASS '+name);}catch(e){failed++;preserveDurableFailure({name,result:{error:e.stack},roots:[root]});console.log('FAIL '+name+'\n'+e.stack);}}
async function until(fn,ms=20000){const end=Date.now()+ms;do{if(await fn())return;await sleep(10);}while(Date.now()<end);throw Error('fixture deadline');}
const identity=async pid=>JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${pid})`)));
const evidence=async o=>JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${o.pid},'${o.started}')`)));
async function stop(o){if(o?.started&&(await evidence(o)).state==='alive'){try{await powershell(nativeScript(`[AiCliContainment]::StopFixture(${o.pid},'${o.started}')`));}catch(e){if((await evidence(o)).state!=='dead')throw e;}}}
const config=label=>({name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(root,label),idleMs:5000});
async function cleanup(c){const b=readBroker(c);if(!b)return;const client=new WinJobClient(c);try{for(const n of fs.readdirSync(c.directory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){const r=JSON.parse(fs.readFileSync(join(c.directory,n)));if(r.brokerEpoch===b.epoch)await client.terminate(r);}}finally{await stop(b);}}
if(process.platform==='win32'){
 for(const mode of ['short','long'])await test(mode==='short'?'FIX10 ordinary reader during register recovers and job completes':'FIX10 exhausted reader preserves Win32 cause next job and idle exit',async()=>{
  const c={...config(mode),idleMs:60000},old=process.env.AI_CLI_CONTAINMENT_TEST;await new WinJobClient({...c,idleMs:5000}).ensure();process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(c);
  const store=new JobStore(join(root,'state-'+mode));await store.ready;const client=new WinJobClient(c);let job;
  async function start(reader){const prev={node:process.env.NODE_OPTIONS,reader:process.env.FIX10_READER};try{process.env.NODE_OPTIONS='--import '+JSON.stringify(pathToFileURL(resolve('tests/helpers/fix10-reader-preload.mjs')).href);process.env.FIX10_READER=reader;return await store.start({cliPath:process.execPath,args:[resolve('tools/stubs/durable-agent.mjs'),'claude'],cwd:root,agent:'claude',prompt:'{}',stdinPrompt:'{}',resolvedModel:'fixture'});}finally{for(const[k,v]of [['NODE_OPTIONS',prev.node],['FIX10_READER',prev.reader]])if(v===undefined)delete process.env[k];else process.env[k]=v;}}
  try{
   job=await start(mode);const [result]=await store.wait([job.pid],40);await until(()=>fs.existsSync(join(job.directory,'fix10-reader.json')));
   const trace=JSON.parse(fs.readFileSync(join(job.directory,'fix10-reader.json')));assert.equal(trace.seen,true,'real reader overlapped Persist temp');
   if(mode==='short'){assertDurableStatus(result,'completed',{name:mode,roots:[root]});assert.match(result.agentOutput.message,/PONG/);assert.ok(trace.ms>=300);}
   else{assertDurableStatus(result,'failed',{name:mode,roots:[root]});assert.equal(result.exitCode,1);assert.match(readJobExit(job.directory).error,/durable registry replace: win32=5 after \d+ attempt\(s\)/);assert.match(readJobExit(job.directory).error,/after 1 attempt\(s\):/);assert.equal(readJobExit(job.directory).killed,false);const attempts=Number(readJobExit(job.directory).error.match(/win32=5 after (\d+) attempt/)[1]);assert.ok(attempts>=5&&attempts<=31,'bounded attempt count');assert.ok(trace.ms>=650&&trace.ms<5000,'bounded real lock failure');}
   const ref=JSON.parse(fs.readFileSync(join(job.directory,'meta.json'))).containment;await until(async()=> (await client.inspect(ref)).state==='drained');assert.ok(drainedProof(ref,c));
   if(mode==='long'){const broker=readBroker(c),next=await start('');const [result2]=await store.wait([next.pid],40);assertDurableStatus(result2,'completed',{name:'next-job',roots:[root]});assert.equal(readBroker(c).pid,broker.pid,'same broker serves following job');await until(async()=> (await evidence(broker)).state==='dead');}
  }finally{store.dispose();await cleanup(c);if(old===undefined)delete process.env.AI_CLI_CONTAINMENT_TEST;else process.env.AI_CLI_CONTAINMENT_TEST=old;}
 });
 await test('FIX10 pre Assign Save rollback permits identical request replay once',async()=>{
  const c=config('rollback'),client=new WinJobClient(c),ref=await client.prepare(randomUUID()),record=readContainment(ref,c),dir=join(root,'replay');fs.mkdirSync(dir);
  const payload={...ref,op:'register',requestId:randomUUID(),capability:record.launchCapability};const file=join(c.directory,ref.generation+'.json');let fd=fs.openSync(file,'r'),owner,child;
  const script=join(dir,'caller.mjs');fs.writeFileSync(script,`import{bridgeCall}from ${JSON.stringify(new URL('../dist/core/win-job-broker.js',import.meta.url).href)};import fs from'node:fs';const c=${JSON.stringify(c)},p=${JSON.stringify(payload)},d=${JSON.stringify(dir)};try{await bridgeCall(c,p);fs.writeFileSync(d+'/first','unexpected READY')}catch(e){fs.writeFileSync(d+'/first',e.message)}while(!fs.existsSync(d+'/go'))await new Promise(r=>setTimeout(r,10));try{const second=await bridgeCall(c,p),third=await bridgeCall(c,p);fs.writeFileSync(d+'/ready',JSON.stringify({second,third}));}catch(e){fs.writeFileSync(d+'/error',e.stack)}setInterval(()=>{},1000);`);
  try{child=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});owner=await identity(child.pid);await until(()=>fs.existsSync(join(dir,'first')));assert.match(fs.readFileSync(join(dir,'first'),'utf8'),/durable registry replace: win32=5/);assert.equal(readContainment(ref,c).phase,'preparing');assert.equal(readContainment(ref,c).runnerPid,undefined);fs.closeSync(fd);fd=undefined;fs.writeFileSync(join(dir,'go'),'go');await until(()=>fs.existsSync(join(dir,'ready'))||fs.existsSync(join(dir,'error')));assert.equal(fs.existsSync(join(dir,'error')),false,fs.existsSync(join(dir,'error'))?fs.readFileSync(join(dir,'error'),'utf8'):'');const reply=JSON.parse(fs.readFileSync(join(dir,'ready')));assert.equal(reply.second.ready,true);assert.deepEqual(reply.second,reply.third);assert.equal(readContainment(ref,c).runnerPid,child.pid);assert.equal((await client.inspect(ref)).activeProcesses,1);await client.terminate(ref);await until(async()=> (await client.inspect(ref)).state==='drained');}
  finally{if(fd!==undefined)fs.closeSync(fd);await client.terminate(ref);await stop(owner);if(child&&child.exitCode===null&&child.signalCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}await cleanup(c);}
 });
 await test('FIX10 exit publication preserves competing natural result',async()=>{
  const c=config('exit'),dir=join(root,'exit','jobs',randomUUID());fs.mkdirSync(dir,{recursive:true});const barrier=join(root,'exit-barrier'),go=barrier+'.go';
  // Scheduling rendezvous only: leave Persist, MoveFileEx and all proof logic intact.
  const needle='if(File.Exists(file)) return; // Preserve natural result.';
  assert.ok(WIN_JOB_NATIVE.includes(needle));const instrumented=WIN_JOB_NATIVE.replace(needle,needle+'\n    File.WriteAllText('+JSON.stringify(barrier)+',"ready"); var rendezvous=Stopwatch.StartNew(); while(!File.Exists('+JSON.stringify(go)+')) { if(rendezvous.ElapsedMilliseconds>15000)throw new Exception("test rendezvous deadline"); Thread.Sleep(5); }');
  let pending=powershell(`Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'\n${instrumented}\n'@\n[AiCliContainment]::Run(${quote(c.name)},${quote(c.directory)},${c.idleMs})`).then(()=>({ok:true}),e=>({error:e.message}));
  const client=new WinJobClient(c);let fd,release,broker;
  try{await until(()=>!!readBroker(c));broker=readBroker(c);const ref=await client.prepare(dir.split(/[\\/]/).at(-1),dir);const terminate=client.terminate(ref);await until(()=>fs.existsSync(barrier));const file=join(dir,'exit.json');const winner={exitCode:0,signal:null,endTime:new Date().toISOString(),killed:false,timedOut:false};fs.writeFileSync(file,JSON.stringify(winner));fd=fs.openSync(file,'r');fs.writeFileSync(go,'go');const status=await terminate;assert.equal(status.state,'drained');assert.ok(drainedProof(ref,c));assert.deepEqual(readJobExit(dir),winner);assert.doesNotMatch(fs.existsSync(join(dir,'stderr.log'))?fs.readFileSync(join(dir,'stderr.log'),'utf8'):'',/Process terminated by user|Process timed out|Process stopped by system reboot/,'preserved natural exit must not log a synthetic termination');assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')).length,0);await until(async()=> (await evidence(broker)).state==='dead');const ended=await pending;assert.equal(ended.error,undefined,ended.error);}
  finally{clearTimeout(release);if(fd!==undefined)fs.closeSync(fd);fs.writeFileSync(go,'go');await cleanup(c);await pending;}
 });
}else console.log('SKIP FIX10 native Windows reader contention');
console.log('FIX10: '+failed+' failed');process.exitCode=failed?1:0;

if(!failed)try{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}catch(e){console.warn('Fixture cleanup deferred: '+root+' '+e.message);}
