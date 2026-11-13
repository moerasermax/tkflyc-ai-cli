import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {descendantEvidence} from '../dist/ai-cli_kernel/containment-descendants.js';
import {WIN_JOB_NATIVE} from '../dist/core/win-job-native.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
let failed=0;
async function test(name,fn){if(process.env.FIX6_TEST_FILTER&&!name.includes(process.env.FIX6_TEST_FILTER))return;try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+' '+e.stack);}}
mkdirSync('.tmp',{recursive:true});const root=mkdtempSync(resolve('.tmp/fix6-'));console.log('EVIDENCE '+root);
const born=n=>new Date(1700000000000+n*1000).toISOString(),row=(pid,ppid,n)=>({pid,ppid,started:born(n),name:'fixture.exe'});
await test('FIX6 reused root occupant and its children remain real descendants',()=>{
 const roots=[{pid:10,started:born(1)},{pid:20,started:born(2)}];
 for(const rows of [[row(31,30,7),row(30,10,6),row(10,20,5)],[row(10,20,5),row(31,30,7),row(30,10,6)]]){
  const result=descendantEvidence(roots,{complete:true,unknown:[],rows});assert.deepEqual(result.alive.map(p=>p.pid).sort((a,b)=>a-b),[10,30,31]);
 }
 const unrelated=descendantEvidence(roots,{complete:true,unknown:[],rows:[row(10,999,5),row(30,10,6),row(31,30,7)]});assert.deepEqual(unrelated,{alive:[],unknown:[]});
 const historical=descendantEvidence(roots,{complete:true,unknown:[],rows:[row(30,10,4),row(31,30,7),row(10,20,5)]});assert.deepEqual(historical.alive.map(p=>p.pid).sort((a,b)=>a-b),[10,30,31]);
});
const q=s=>"'"+s.replaceAll("'","''")+"'";
async function nativeVariant(source,expression){return JSON.parse(await powershell(`Add-Type -TypeDefinition @'\n${source}\n'@ -ReferencedAssemblies System.Web.Extensions\n${expression}`));}
if(process.platform==='win32'){
 await test('FIX6 inaccessible identity uses real system birth without declaring same identity dead',async()=>{
  for(const mode of ['denied','sid']){
   let source=WIN_JOB_NATIVE.replaceAll('AiCliContainment','Fix6Identity');
   source=mode==='denied'?source.replace('pid=id; handle=OpenProcess','if(id==Process.GetCurrentProcess().Id)throw new Win32Exception(5); pid=id; handle=OpenProcess'):source.replace('Require(!requireOwner || sid==SID,"owner SID mismatch");','Require(id!=Process.GetCurrentProcess().Id,"owner SID mismatch");');
   const result=await nativeVariant(source,`$me=[Diagnostics.Process]::GetCurrentProcess();$birth=$me.StartTime.ToUniversalTime();$flags=[Reflection.BindingFlags]'Static,NonPublic';$ticks=[Fix6Identity].GetMethod('SystemStarted',$flags).Invoke($null,@($me.Id))
@{ticks=$ticks.ToString();expected=$birth.ToFileTimeUtc().ToString();same=([Fix6Identity]::ProcessEvidence($me.Id,$birth.ToString('o'))|ConvertFrom-Json);near=([Fix6Identity]::ProcessEvidence($me.Id,$birth.AddMilliseconds(-999).ToString('o'))|ConvertFrom-Json);old=([Fix6Identity]::ProcessEvidence($me.Id,$birth.AddSeconds(-1).ToString('o'))|ConvertFrom-Json);bad=([Fix6Identity]::ProcessEvidence($me.Id,'unknown')|ConvertFrom-Json)}|ConvertTo-Json -Compress`);
   assert.equal(result.ticks,result.expected);assert.equal(result.same.state,'unknown');assert.equal(result.near.state,'unknown');assert.equal(result.bad.state,'unknown');assert.equal(result.old.state,'dead');assert.equal(result.old.reason,'system_identity_changed');
  }
 });
 await test('FIX6 inaccessible intermediary cannot hide a known worker ancestor',async()=>{
  const source=WIN_JOB_NATIVE.replaceAll('AiCliContainment','Fix6Ancestry').replace('pid=id; handle=OpenProcess','if(id==2147483644)throw new Win32Exception(5); pid=id; handle=OpenProcess');
  const result=await nativeVariant(source,`$me=[Diagnostics.Process]::GetCurrentProcess();$map=[Collections.Generic.Dictionary[int,int]]::new();$map.Add(${process.pid},2147483644);$map.Add(2147483644,$me.Id);$map.Add($me.Id,0)
$m=[Fix6Ancestry].GetMethod('WorkerAncestrySnapshot',[Reflection.BindingFlags]'Static,NonPublic');$known='['+(@{pid=$me.Id;started=$me.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress)+']'
@{worker=$m.Invoke($null,@(${process.pid},$known,$map));protected=$m.Invoke($null,@(${process.pid},'[{"pid":2147483644,"started":"2000-01-01T00:00:00Z"}]',$map))}|ConvertTo-Json -Compress`);
  assert.equal(result.worker,'worker');assert.equal(result.protected,'unknown');
 });
 await test('FIX6 outer host deadline reaps a tree before native wait begins',async()=>{
  const dir=join(root,'outer');mkdirSync(dir);const marker=join(dir,'owned.json'),script=join(dir,'hang.ps1'),preload=join(dir,'preload.mjs'),entry=join(dir,'entry.mjs');
  writeFileSync(script,`$ErrorActionPreference='Stop'
$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=${q(process.execPath)};$start.Arguments='-e "setInterval(()=>{},1000)"';$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$c=[Diagnostics.Process]::Start($start);$me=[Diagnostics.Process]::GetCurrentProcess();$parentId=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$me.Id)).ParentProcessId;$parent=[Diagnostics.Process]::GetProcessById($parentId)
@(@{pid=$me.Id;started=$me.StartTime.ToUniversalTime().ToString('o')},@{pid=$c.Id;started=$c.StartTime.ToUniversalTime().ToString('o')},@{pid=$parent.Id;started=$parent.StartTime.ToUniversalTime().ToString('o')})|ConvertTo-Json|Set-Content -LiteralPath ${q(marker)}
Start-Sleep -Seconds 120`);
  writeFileSync(preload,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const spawn=cp.spawn;cp.spawn=function(file,args,options){if(file===process.execPath&&args[0]==='-e'){const m=args[1].match(/'-EncodedCommand',("[A-Za-z0-9+/=]+")/);if(m){let script=Buffer.from(JSON.parse(m[1]),'base64').toString('utf16le');script=script.replace('uint wait=WaitForMultipleObjects','System.Threading.Thread.Sleep(120000);uint wait=WaitForMultipleObjects');args=[...args];args[1]=args[1].replace(m[1],JSON.stringify(Buffer.from(script,'utf16le').toString('base64')));}}return spawn(file,args,{...options,windowsHide:true});};syncBuiltinESMExports();`);
  writeFileSync(entry,`import{runWindowless}from ${JSON.stringify(pathToFileURL(resolve('dist/core/win-job-host.js')).href)};try{await runWindowless(${JSON.stringify(script)},{},false,2500);console.log('unexpected success')}catch(e){console.error(e.message);process.exitCode=1;}`);
  const child=cp.spawn(process.execPath,['--import',pathToFileURL(preload).href,entry],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TEMP:dir,TMP:dir}});let text='';child.stdout.on('data',d=>text+=d);child.stderr.on('data',d=>text+=d);
  const guard=setTimeout(()=>child.kill('SIGKILL'),30000);const start=Date.now();const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r)});clearTimeout(guard);
  let ids=[];try{
   assert.ok(existsSync(marker),'host actually started its descendant tree');ids=JSON.parse(readFileSync(marker,'utf8').replace(/^\uFEFF/,''));assert.equal(code,1,text);assert.match(text,/host deadline; containment unknown/);assert.ok(Date.now()-start<20000,'outer host deadline bounded');
   for(const id of ids){const e=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${id.pid},'${id.started}')`)));assert.equal(e.state,'dead',JSON.stringify({id,e}));}
  }finally{for(const id of ids)await powershell(nativeScript(`$e=[AiCliContainment]::ProcessEvidence(${id.pid},'${id.started}')|ConvertFrom-Json;if($e.state -eq 'alive'){[AiCliContainment]::StopFixture(${id.pid},'${id.started}')}elseif($e.state -ne 'dead'){throw 'fixture identity unknown'}`));}
 });
 await test('FIX6 compiler preserves large diagnostics without pipe deadlock',async()=>{
  const dir=join(root,'diagnostics');mkdirSync(dir);const replacement=join(dir,'compiler-error.mjs'),preload=join(dir,'preload.mjs'),entry=join(dir,'entry.mjs');
  writeFileSync(replacement,`process.stdout.write('O'.repeat(262144));process.stderr.write('E'.repeat(262144)+'FIX6_REAL_COMPILER_ERROR');process.exitCode=7;`);
  const command=`$start.FileName=${q(process.execPath)}\n  $start.Arguments=${q('"'+replacement+'"')};`;
  writeFileSync(preload,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const spawn=cp.spawn;cp.spawn=function(file,args,options){if(file===process.execPath&&args[0]==='-e'){const m=args[1].match(/'-EncodedCommand',("[A-Za-z0-9+/=]+")/);if(m){let script=Buffer.from(JSON.parse(m[1]),'base64').toString('utf16le');script=script.replace(/\\$start.FileName=Join-Path[^\\n]+\\n  \\$start.Arguments=[^;]+;/,${JSON.stringify(command)});args=[...args];args[1]=args[1].replace(m[1],JSON.stringify(Buffer.from(script,'utf16le').toString('base64')));}}return spawn(file,args,{...options,windowsHide:true});};syncBuiltinESMExports();`);
  writeFileSync(entry,`import{ensureWindowlessHost}from ${JSON.stringify(pathToFileURL(resolve('dist/core/win-job-host.js')).href)};try{await ensureWindowlessHost();console.log('unexpected success')}catch(e){console.error(e.message);process.exitCode=1;}`);
  const start=Date.now(),child=cp.spawnSync(process.execPath,['--import',pathToFileURL(preload).href,entry],{windowsHide:true,timeout:60000,killSignal:'SIGKILL',encoding:'utf8',env:{...process.env,TEMP:dir,TMP:dir}});
  assert.equal(child.status,1,String(child.error));assert.match(child.stderr,/FIX6_REAL_COMPILER_ERROR/);assert.doesNotMatch(child.stderr,/deadline/);assert.ok(Date.now()-start<20000,'diagnostic pipes drained while compiler runs');
 });
}
console.log(`FIX6: ${failed} failed`);process.exitCode=failed?1:0;
