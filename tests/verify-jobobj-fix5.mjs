import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {descendantEvidence} from '../dist/ai-cli_kernel/containment-descendants.js';
import {writerIdentity,writerDead} from '../dist/ai-cli_kernel/journal-owner.js';
import {takeJournalLock,JournalUnavailableError} from '../dist/ai-cli_kernel/journal-lock.js';
import {RunStore,newRunId,kernelRunDir} from '../dist/ai-cli_kernel/journal.js';
import {readJournalReconcile,clearJournalReconcile} from '../dist/ai-cli_kernel/journal-reconcile.js';
import {aiCliKernelStatus} from '../dist/ai-cli_kernel/api.js';
import {createDashboardEffects} from '../dist/ai-cli_kernel/dashboard-api.js';
import {detailLines} from '../dist/ai-cli_kernel/dashboard-view.js';
import {runKernelLoop} from '../dist/ai-cli_kernel/loop.js';
import {buildContract} from '../dist/ai-cli_kernel/templates.js';
import {runWindowless,ensureWindowlessHost} from '../dist/core/win-job-host.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
import {WIN_JOB_NATIVE} from '../dist/core/win-job-native.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let failed=0;
async function test(name,fn){if(process.env.FIX5_TEST_FILTER&&!name.includes(process.env.FIX5_TEST_FILTER))return;try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+' '+e.stack);}}
mkdirSync('.tmp',{recursive:true});const root=mkdtempSync(resolve('.tmp/fix5-'));console.log('EVIDENCE '+root);
const born=n=>new Date(1700000000000+n*1000).toISOString(),row=(pid,ppid,n)=>({pid,ppid,started:born(n),name:'fixture.exe'});
await test('FIX5 reused root occupant excludes new children but retains old orphans',()=>{
 const roots=[{pid:10,started:born(1)}],snapshot={complete:true,unknown:[],rows:[row(30,20,4),row(10,999,5),row(20,10,3),row(21,10,5),row(22,10,6)]};
 assert.deepEqual(descendantEvidence(roots,snapshot).alive.map(x=>x.pid),[20,30]);
 assert.equal(descendantEvidence(roots,{...snapshot,rows:[row(10,999,5),row(21,10,5),row(22,10,6)]}).alive.length,0);
});
await test('FIX5 descendant uncertainty never becomes an empty safe snapshot',()=>{
 const roots=[{pid:10,started:born(1)}],snapshot={complete:true,unknown:[],rows:[{...row(10,999,5),started:'unknown'},row(20,10,3)]};
 assert.ok(descendantEvidence(roots,snapshot).unknown.length);
 for(const snapshot of [{complete:false,unknown:[],rows:[]},{complete:true,unknown:[{pid:10,ppid:999}],rows:[row(20,10,3)]},{complete:true,unknown:[{pid:80,ppid:null}],rows:[]},{complete:true,unknown:[],rows:[row(20,10,1)]}])assert.ok(descendantEvidence(roots,snapshot).unknown.length);
 assert.equal(descendantEvidence(roots,{complete:true,unknown:[],rows:[row(20,10,0)]}).alive.length,0);
});
await test('FIX5 repeated evidence timeouts reach total deadline without reclaim',()=>{
 if(process.env.FIX5_LOCK_CHILD!=='1'){
  const child=cp.spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{windowsHide:true,timeout:20000,killSignal:'SIGKILL',encoding:'utf8',env:{...process.env,FIX5_LOCK_CHILD:'1',FIX5_TEST_FILTER:'FIX5 repeated evidence timeouts reach total deadline without reclaim'}});
  assert.equal(child.status,0,`bounded lock test failed: ${child.error??''} ${child.stdout} ${child.stderr}`);return;
 }
 writerIdentity();const dir=join(root,'deadline'),tickets=join(dir,'journal.writer.tickets');mkdirSync(tickets,{recursive:true});
 writeFileSync(join(tickets,'owner.json'),JSON.stringify({owner:{pid:2147483645,started:born(1)},number:0}));
 const exec=cp.execFileSync,now=Date.now;let clock=now(),calls=0,error;
 try{Date.now=()=>clock+=40;cp.execFileSync=(file,args,options)=>{calls++;clock+=options.timeout;throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});};syncBuiltinESMExports();try{takeJournalLock(dir);}catch(e){error=e;}}
 finally{cp.execFileSync=exec;Date.now=now;syncBuiltinESMExports();}
 assert.ok(error instanceof JournalUnavailableError);assert.match(error.message,/total deadline/);assert.ok(calls<=3);assert.deepEqual(readdirSync(tickets),['owner.json']);
});
await test('FIX5 status and dashboard expose reconciliation for stop_pending',async()=>{
 const runId=newRunId(),store=new RunStore(kernelRunDir(runId));store.create({version:1,runId,goal:'no model fixture',template:'readonly-audit',workFolder:root,decide:{model:'codex'},worker:{model:'codex'},allowedWorkerModels:['codex'],budget:{}});
 store.append({type:'state',state:'stop_pending',reason:'worker_still_alive'});
 const path=join(store.dir,'journal-reconcile.json');writeFileSync(path,JSON.stringify({detail:'fixture lock unavailable',observedSeq:2}));
 const status=await aiCliKernelStatus({runId});assert.equal(status.state,'stop_pending');assert.equal(status.reason,'worker_still_alive');assert.equal(status.reconciliation?.reason,'journal_unavailable');assert.match(status.detail,/fixture lock unavailable/);assert.match(status.nextAction,/kernel cancel/);assert.match(status.stateLabel,/需對帳/);
 const d=await createDashboardEffects().detail(runId),text=detailLines(d,160).join('\n');assert.match(text,/fixture lock unavailable/);assert.match(text.replaceAll('\n',''),/journal-reconcile/);
 const observed=readJournalReconcile(store.dir);writeFileSync(path,JSON.stringify({detail:'newer failure'}));clearJournalReconcile(store.dir,observed);assert.ok(existsSync(path));
 clearJournalReconcile(store.dir,readJournalReconcile(store.dir));assert.equal(existsSync(path),false);
});
await test('FIX5 successful runner reattach clears marker only after durable start',async()=>{
 for(const fail of [false,true]){
  const contract=buildContract({goal:'no dispatch',workFolder:root,model:'gpt-6.1-sol',decideModel:'gpt-6.1-sol'}),store=new RunStore(kernelRunDir(newRunId()));
  const digest=store.create(contract);store.append({type:'approved',kind:'contract',contractDigest:digest});store.append({type:'state',state:'running'});
  const marker=join(store.dir,'journal-reconcile.json');writeFileSync(marker,JSON.stringify({detail:'old unavailable'}));
  const append=store.append.bind(store);if(fail)store.append=e=>{if(e.type==='runner_started')throw new JournalUnavailableError('injected durable failure');return append(e)};
  let versions=0;const run=()=>runKernelLoop({store,contract,executor:{start(){throw Error('must not dispatch')},isGone:async()=>true},boundary:async()=> 'PASS',quota:async()=>80,agentFor:()=> 'codex',versionId:()=>String(versions++),snapshot:()=>null,now:Date.now,sleep:async()=>{},pid:process.pid,pollMs:1});
  if(fail){await assert.rejects(run,/injected durable failure/);assert.ok(existsSync(marker));}
  else{assert.equal(await run(),'version_drift');assert.equal(existsSync(marker),false);assert.ok(store.read().some(e=>e.type==='runner_started'));}
 }
});
const q=s=>"'"+s.replaceAll("'","''")+"'";
function hangScript(marker){return `$ErrorActionPreference='Stop'\n$p=[Diagnostics.ProcessStartInfo]::new();$p.FileName=${q(process.execPath)};$p.Arguments='-e "setInterval(()=>{},1000)"';$p.UseShellExecute=$false;$p.CreateNoWindow=$true\n$c=[Diagnostics.Process]::Start($p);$me=[Diagnostics.Process]::GetCurrentProcess();@(@{pid=$me.Id;started=$me.StartTime.ToUniversalTime().ToString('o')},@{pid=$c.Id;started=$c.StartTime.ToUniversalTime().ToString('o')})|ConvertTo-Json|Set-Content -LiteralPath ${q(marker)}\nStart-Sleep -Seconds 300\n`;}
async function assertGone(marker){assert.ok(existsSync(marker),'hanging fixture actually launched');const ids=JSON.parse(readFileSync(marker,'utf8').replace(/^\uFEFF/,''));
 for(const id of ids){const evidence=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${id.pid},'${id.started}')`)));assert.equal(evidence.state,'dead',JSON.stringify(id));}}
async function cleanup(marker){if(!existsSync(marker))return;for(const id of JSON.parse(readFileSync(marker,'utf8').replace(/^\uFEFF/,'')))await powershell(nativeScript(`$e=[AiCliContainment]::ProcessEvidence(${id.pid},'${id.started}')|ConvertFrom-Json;if($e.state -eq 'alive'){[AiCliContainment]::StopFixture(${id.pid},'${id.started}')}elseif($e.state -ne 'dead'){throw 'fixture cleanup identity unknown'}`));}
if(process.platform==='win32'&&process.env.FIX5_LOCK_CHILD!=='1'){
 await ensureWindowlessHost();
 await test('FIX5 Toolhelp external ancestor tail still rejects known worker',async()=>{
  // Force access denied for an otherwise absent intermediate, even when elevated.
  // Parent edges are injected; actual caller identity and Toolhelp snapshot are real.
  const source=WIN_JOB_NATIVE.replaceAll('AiCliContainment','Fix5Ancestry').replace('pid=id; handle=OpenProcess','if(id==2147483644)throw new Win32Exception(5); pid=id; handle=OpenProcess');
  const result=JSON.parse(await powershell(`Add-Type -TypeDefinition @'
${source}
'@ -ReferencedAssemblies System.Web.Extensions
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$t=[Fix5Ancestry];$parents=$t.GetMethod('ProcessParents',$flags).Invoke($null,@());$me=[Diagnostics.Process]::GetCurrentProcess()
$actual=$parents.ContainsKey($me.Id);$map=[Collections.Generic.Dictionary[int,int]]::new();$map.Add($me.Id,4);$map.Add(4,0)
$map[$me.Id]=2147483644;$map.Add(2147483644,0)
$m=$t.GetMethod('WorkerAncestrySnapshot',$flags);$own='['+(@{pid=$me.Id;started=$me.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress)+']'
@{actual=$actual;external=$m.Invoke($null,@($me.Id,'[]',$map));worker=$m.Invoke($null,@($me.Id,$own,$map));protected=$m.Invoke($null,@($me.Id,'[{"pid":2147483644,"started":"2000-01-01T00:00:00Z"}]',$map))}|ConvertTo-Json -Compress`));
  assert.equal(result.actual,true);assert.equal(result.external,'none');assert.equal(result.worker,'worker');assert.equal(result.protected,'unknown');
 });
 await test('FIX5 real bridge deadline reaps owned PowerShell and descendants',async()=>{
  const marker=join(root,'bridge-owned.json'),script=join(root,'hang.ps1');writeFileSync(script,hangScript(marker));
  try{const start=Date.now();await assert.rejects(runWindowless(script,{},false,2500),/failed \(124\)/);assert.ok(Date.now()-start<10000);await assertGone(marker);}finally{await cleanup(marker);}
 });
 await test('FIX5 real synchronous helper timeout reaps detached host tree',async()=>{
  const marker=join(root,'helper-owned.json'),preload=join(root,'helper-preload.mjs');
  writeFileSync(preload,`import cp from 'node:child_process';import{writeFileSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';const spawn=cp.spawn;cp.spawn=function(file,args,options){if(String(file).endsWith('ai-cli-windowless-host.exe')&&args[1]!=='background')writeFileSync(args[0],${JSON.stringify(hangScript(marker))});return spawn(file,args,{...options,windowsHide:true});};syncBuiltinESMExports();`);
  const options=process.env.NODE_OPTIONS;
  try{process.env.NODE_OPTIONS=`${options??''} --import ${JSON.stringify(pathToFileURL(preload).href)}`;const start=Date.now();assert.equal(writerDead({pid:2147483645,started:born(1)}),false);assert.ok(Date.now()-start<20000,'sync helper must time out within 15s plus cleanup');}
  finally{if(options===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=options;}
  try{await sleep(300);await assertGone(marker);}finally{await cleanup(marker);}
 });
 for(const killed of [false,true])await test(killed?'FIX5 killed compiler never becomes success':'FIX5 real compiler deadline reaps owned compiler tree and reports failure',async()=>{
  const marker=join(root,'compiler-owned.json'),preload=join(root,'compiler-preload.mjs'),entry=join(root,'compiler-entry.mjs');
  const childScript=join(root,'compiler-child.mjs'),childPid=join(root,'compiler-child-'+killed+'.pid');
  writeFileSync(childScript,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,detached:true,stdio:'ignore'});c.unref();writeFileSync(${JSON.stringify(childPid)},String(c.pid));setInterval(()=>{},1000);`);
  const replacement=`$start.FileName=${q(process.execPath)}\n  $start.Arguments=${q('"'+childScript+'"')};`;
  const record=`\n$wait=[DateTime]::UtcNow.AddSeconds(5);while(!(Test-Path -LiteralPath ${q(childPid)})){if([DateTime]::UtcNow -ge $wait){throw 'fixture child missing'};Start-Sleep -Milliseconds 50};$grand=[Diagnostics.Process]::GetProcessById([int](Get-Content -LiteralPath ${q(childPid)}))\n$me=[Diagnostics.Process]::GetCurrentProcess();@(@{pid=$me.Id;started=$me.StartTime.ToUniversalTime().ToString('o')},@{pid=$compiler.Id;started=$compilerBorn.ToString('o')},@{pid=$grand.Id;started=$grand.StartTime.ToUniversalTime().ToString('o')})|ConvertTo-Json|Set-Content -LiteralPath ${q(marker)}\n`;
  writeFileSync(preload,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const spawn=cp.spawn;cp.spawn=function(file,args,options){if(file===process.execPath&&args[0]==='-e'){const m=args[1].match(/'-EncodedCommand',("[A-Za-z0-9+/=]+")/);if(m){let script=Buffer.from(JSON.parse(m[1]),'base64').toString('utf16le');script=script.replace('if(!(Test-Path -LiteralPath $target))','if($true)').replace(/\\$start.FileName=Join-Path[^\\n]+\\n  \\$start.Arguments=[^;]+;/,${JSON.stringify(replacement)}).replace('$compilerBorn=$compiler.StartTime.ToUniversalTime()','$compilerBorn=$compiler.StartTime.ToUniversalTime()'+${JSON.stringify(record)});script=script.replace('AddSeconds(25)',${JSON.stringify(killed)}?'AddSeconds(120)':'AddSeconds(3)');args=[...args];if(${JSON.stringify(killed)})args[1]=args[1].replace('timeout:45000','timeout:5000');args[1]=args[1].replace(m[1],JSON.stringify(Buffer.from(script,'utf16le').toString('base64')));}}return spawn(file,args,{...options,windowsHide:true});};syncBuiltinESMExports();`);
  writeFileSync(entry,`import{ensureWindowlessHost}from ${JSON.stringify(pathToFileURL(resolve('dist/core/win-job-host.js')).href)};try{await ensureWindowlessHost();console.log('unexpected success')}catch(error){console.error(error.message);process.exitCode=1;}`);
  const start=Date.now(),child=cp.spawn(process.execPath,['--import',pathToFileURL(preload).href,entry],{windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',d=>text+=d);child.stderr.on('data',d=>text+=d);
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r)});
  try{assert.equal(code,1,text);if(!killed)assert.match(text,/compiler deadline/);assert.ok(Date.now()-start<20000);await assertGone(marker);}finally{await cleanup(marker);}
 });
}
console.log(`FIX5: ${failed} failed`);process.exitCode=failed?1:0;
