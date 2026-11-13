import '../tools/stubs/catalog-test-env.mjs';
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync,utimesSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {WIN_JOB_NATIVE} from '../dist/core/win-job-native.js';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {readBroker} from '../dist/core/containment-store.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
import {ensureWindowlessHost} from '../dist/core/win-job-host.js';
let failed=0;const check=(n,b)=>{console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;};
check('startup does not enumerate historical records',!WIN_JOB_NATIVE.slice(WIN_JOB_NATIVE.indexOf('public static void Run('),WIN_JOB_NATIVE.indexOf('public static string Call(')).includes('Directory.GetFiles'));
check('identity requests only synchronize and limited query',WIN_JOB_NATIVE.includes('OpenProcess(0x00101000 | extra, false, id)')&&!WIN_JOB_NATIVE.includes('0x00101400'));
check('only pipe and mutex explicitly use Medium no-write-up label',WIN_JOB_NATIVE.includes('static SA Security(bool medium=false)')&&WIN_JOB_NATIVE.includes('var sa=Security(); IntPtr job;')&&WIN_JOB_NATIVE.includes('S:(ML;;NW;;;ME)'));
if(process.platform==='win32'){
 mkdirSync('.tmp',{recursive:true});const dir=mkdtempSync(resolve('.tmp/phase3-foundation-'));
 const config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'registry'),idleMs:60000},client=new WinJobClient(config);let broker;
 try{
  await client.ensure();broker=readBroker(config);
  const identity=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${process.pid})`)));
  check('limited query GetProcessTimes token wait and parent work',identity.pid===process.pid&&!!identity.started&&identity.sid.startsWith('S-')&&identity.parent>0&&!identity.exited);
  const times=JSON.parse(await powershell(nativeScript(`$id=[AiCliContainment]::InspectFixture(${process.pid}) | ConvertFrom-Json;$date=[DateTime]::Parse($id.started).ToUniversalTime();@{
 exact=([AiCliContainment]::ProcessEvidence(${process.pid},$id.started)|ConvertFrom-Json).state;
 millis=([AiCliContainment]::ProcessEvidence(${process.pid},$date.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"))|ConvertFrom-Json).state;
 cim=([AiCliContainment]::ProcessEvidence(${process.pid},($date.ToString("yyyyMMddHHmmss.ffffff")+'+000'))|ConvertFrom-Json).state;
 cimOffset=([AiCliContainment]::ProcessEvidence(${process.pid},($date.AddHours(8).ToString("yyyyMMddHHmmss.ffffff")+'+480'))|ConvertFrom-Json).state;
 old=([AiCliContainment]::ProcessEvidence(${process.pid},($date.AddSeconds(-2).ToString("yyyyMMddHHmmss.ffffff")+'+000'))|ConvertFrom-Json).state;
 nozone=([AiCliContainment]::ProcessEvidence(${process.pid},$date.AddSeconds(-2).ToString("yyyy-MM-ddTHH:mm:ss.fffffff"))|ConvertFrom-Json).state;
 invalid=([AiCliContainment]::ProcessEvidence(${process.pid},'unknown')|ConvertFrom-Json).state
 }|ConvertTo-Json -Compress`)));
  check('native death evidence preserves ambiguous milliseconds and CIM precision',times.exact==='alive'&&times.millis==='unknown'&&times.cim==='unknown'&&times.cimOffset==='unknown'&&times.old==='dead'&&times.invalid==='unknown');
  check('timezone-free identity remains unknown',times.nozone==='unknown');
  const tails=JSON.parse(await powershell(nativeScript(`$m=[AiCliContainment].GetMethod('AncestryTail',[Reflection.BindingFlags]'NonPublic,Static');$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;@{different=$m.Invoke($null,@([long]1,[long]2,'S-1-5-18'));reused=$m.Invoke($null,@([long]3,[long]2,$sid));same=$m.Invoke($null,@([long]1,[long]2,$sid));worker=[AiCliContainment]::WorkerAncestry(${process.pid},'[{"pid":${process.pid},"started":"${identity.started}"}]')}|ConvertTo-Json -Compress`)));
  check('ancestry stops at foreign SID or reused parent but detects worker',tails.different&&tails.reused&&!tails.same&&tails.worker==='worker');
  const security=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::SecurityFixture('${config.name}','${config.directory.replaceAll("'","''")}')`)));
  console.log('SECURITY',JSON.stringify(security));
  for(const object of ['pipe','mutex'])check(object+' has actual Medium mandatory label and owner ACL',security[object].includes('(ML;;NW;;;ME)')&&[security.sid,...(security.sid.endsWith('-500')?['LA']:[])].some(id=>security[object].includes(`;;;${id})`)));
  const root=dirname(await ensureWindowlessHost()),base=join(root,'native-'+'f'.repeat(64)+'.dll');
  const artifacts=[base,base+'.sha256',base+'.'+randomUUID()+'.dll',base+'.'+randomUUID()+'.dll.bak',join(root,'broker-PHASE3fixture.error.log')];
  for(const file of artifacts){writeFileSync(file,'owned expired fixture');utimesSync(file,new Date(0),new Date(0));}
  await powershell(nativeScript('[AiCliContainment]::BootIdentity()'));
  check('expired DLL sidecar temporary backup and error artifacts reclaimed',artifacts.every(f=>!existsSync(f)));
  // Assembly load refusal must fail before an expression can release any worker.
  const marker=join(dir,'must-not-execute');let error='';
  const dll=join(root,'native-'+createHash('sha256').update('cache-v3:'+WIN_JOB_NATIVE).digest('hex')+'.dll'),original=readFileSync(dll),sidecar=readFileSync(dll+'.sha256');
  const invalid=Buffer.from('valid hash but not a loadable assembly');writeFileSync(dll,invalid);writeFileSync(dll+'.sha256',createHash('sha256').update(invalid).digest('hex').toUpperCase());
  try{await powershell(nativeScript(`[IO.File]::WriteAllText('${marker}','bad')`));}catch(e){error=e.message;}
  finally{writeFileSync(dll,original);writeFileSync(dll+'.sha256',sidecar);}
  check('bridge errors remain readable and fail closed',error.includes('assembly load refused (AMSI/antivirus or invalid assembly)')&&!existsSync(marker));
 }finally{if(broker){await powershell(nativeScript(`[AiCliContainment]::StopFixture(${broker.pid},'${broker.started}')`)).catch(()=>{});check('owned foundation broker identity exited',JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${broker.pid},'${broker.started}')`))).state==='dead');}}
}
console.log(`Phase3 foundation: ${failed} failed`);process.exitCode=failed?1:0;
