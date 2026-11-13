/** broker 啟動與 PowerShell 橋接。原始碼先載入記憶體；capability 不出現在命令列或 log。 */
import { ensureWindowlessHost, runWindowless } from './win-job-host.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { WIN_JOB_NATIVE } from './win-job-native.js';
import type { BrokerConfig } from './win-job-protocol.js';

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const prefix = '# AI_CLI_CACHED_NATIVE\n';
export function nativeScript(expression: string): string { return prefix + expression + '\n'; }
function ownTemporaryDirectory(directory: string): string {
  // Only marked, flat private directories are reclaimable. Query errors retain
  // the directory. PID reuse is distinguished by exact creation time; no kill.
  return `
$me=[Diagnostics.Process]::GetCurrentProcess()
$requesterStarted='unknown';try{$requester=[Diagnostics.Process]::GetProcessById(${process.pid});try{$requesterStarted=$requester.StartTime.ToUniversalTime().ToString('o')}finally{$requester.Dispose()}}catch{}
@{pid=$me.Id;started=$me.StartTime.ToUniversalTime().ToString('o');requesterPid=${process.pid};requesterStarted=$requesterStarted} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(join(directory,'owner.json'))}
foreach($old in [IO.Directory]::GetDirectories(${quote(dirname(directory))})) {
 if($old -eq ${quote(directory)} -or [IO.Path]::GetFileName($old) -notmatch '^(bridge|broker)-'){continue}
 try {
  if(([IO.File]::GetAttributes($old) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.Directory]::GetDirectories($old).Length -ne 0){continue}
  $ownerFile=[IO.Path]::Combine($old,'owner.json');if(![IO.File]::Exists($ownerFile)){continue}
  $owner=Get-Content -LiteralPath $ownerFile -ErrorAction Stop | ConvertFrom-Json
  if(!$owner.pid -or !$owner.started){continue}
  $gone=$false
  try {$p=[Diagnostics.Process]::GetProcessById([int]$owner.pid);try{$gone=$p.StartTime.ToUniversalTime().ToString('o') -ne $owner.started}finally{$p.Dispose()}}
  catch [ArgumentException] {$gone=$true}
  if($gone -and [IO.Path]::GetFileName($old).StartsWith('bridge-')) {
   # The PS child can exit before its Node requester reads output.txt.
   $gone=$false
   if($owner.requesterPid -and $owner.requesterStarted -ne 'unknown'){
    try{$p=[Diagnostics.Process]::GetProcessById([int]$owner.requesterPid);try{$gone=$p.StartTime.ToUniversalTime().ToString('o') -ne $owner.requesterStarted}finally{$p.Dispose()}}
    catch [ArgumentException] {$gone=$true}
   }
  }
  if($gone){[IO.Directory]::Delete($old,$true)}
 }catch{} # unknown ownership/access is never a cleanup authorization
}
`;
}
let library: Promise<string> | undefined;
async function ensureNativeLibrary(deadline?: number): Promise<string> {
  return library ??= (async () => {
    const root=dirname(await ensureWindowlessHost(deadline)), hash=createHash('sha256').update('cache-v3:'+WIN_JOB_NATIVE).digest('hex');
    return join(root,`native-${hash}.dll`);
  })().catch(error=>{library=undefined;throw error;});
}
async function loadNative(script: string, deadline?: number): Promise<string> {
  if(!script.includes(prefix))return script;
  const dll=await ensureNativeLibrary(deadline);
  return script.replace(prefix,()=>`$dll=${quote(dll)};$lock=$null;$until=[DateTime]::UtcNow.AddSeconds(30)
while(!$lock){try{$lock=[IO.File]::Open($dll+'.lock','OpenOrCreate','ReadWrite','None')}catch{if([DateTime]::UtcNow -gt $until){throw};Start-Sleep -Milliseconds 50}}
try {
foreach($path in @($dll,($dll+'.sha256'))){if([IO.File]::Exists($path) -and (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'native DLL reparse point'}}
$bytes=$null;$valid=$false
try {
  $bytes=[IO.File]::ReadAllBytes($dll)
  $valid=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','')) -eq [IO.File]::ReadAllText($dll+'.sha256')
}catch{}
if(!$valid) {
  $tmp=$dll+'.'+[Guid]::NewGuid().ToString()+'.dll'
  try {
  Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
${WIN_JOB_NATIVE}
'@ -OutputAssembly $tmp -OutputType Library
  $bytes=[IO.File]::ReadAllBytes($tmp)
  [IO.File]::WriteAllText($dll+'.sha256',([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','')))
  if([IO.File]::Exists($dll)){[IO.File]::Replace($tmp,$dll,($tmp+'.bak'))}else{[IO.File]::Move($tmp,$dll)}
  }finally{foreach($part in @($tmp,($tmp+'.bak'))){if([IO.File]::Exists($part)){[IO.File]::Delete($part)}}}
}
# Seven-day diagnostics retention; serialize scavenging with each publisher.
foreach($part in [IO.Directory]::GetFiles([IO.Path]::GetDirectoryName($dll))) {
 $leaf=[IO.Path]::GetFileName($part);$otherLock=$null
 try {
  if(([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.File]::GetLastWriteTimeUtc($part) -gt [DateTime]::UtcNow.AddDays(-7)){continue}
  if($leaf -match '^(native-[a-f0-9]{64}\\.dll)(\\.[a-f0-9-]{36}\\.dll(\\.bak)?|\\.sha256)?$') {
   $base=[IO.Path]::Combine([IO.Path]::GetDirectoryName($dll),$Matches[1]);if($base -eq $dll){if($part -ne $dll -and $part -ne ($dll+'.sha256')){[IO.File]::Delete($part)};continue}
   $otherLock=[IO.File]::Open($base+'.lock','OpenOrCreate','ReadWrite','None')
   [IO.File]::Delete($part)
  } elseif($leaf -match '^broker-[a-zA-Z0-9]+\\.error\\.log$') { [IO.File]::Delete($part) }
 }catch{}finally{if($otherLock){$otherLock.Dispose()}}
}
[Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions') | Out-Null
try { [Reflection.Assembly]::Load($bytes) | Out-Null } catch { throw ('Native containment assembly load refused (AMSI/antivirus or invalid assembly); worker not released: '+($_ | Out-String)) }
}finally{$lock.Dispose()}
`);
}
/** Only transport failures may replay an authenticated, unchanged request. */
export class ContainmentTransportError extends Error {}
export async function powershell(script: string, env: NodeJS.ProcessEnv = {}, deadline?: number): Promise<string> {
  const host=await ensureWindowlessHost(deadline);
  script = await loadNative(script, deadline);
  const directory = mkdtempSync(join(dirname(host), 'bridge-'));
  const file = join(directory, 'bridge.ps1'), output = join(directory, 'output.txt'), error = join(directory, 'error.txt');
  writeFileSync(file, `\ufeff$ErrorActionPreference='Stop'\ntry {\n${ownTemporaryDirectory(directory)}\n$result = & {\n${script}\n} | Out-String\n[IO.File]::WriteAllText(${quote(output)},$result,[Text.UTF8Encoding]::new($false))\nexit 0\n} catch { [IO.File]::WriteAllText(${quote(error)},($_ | Out-String)); exit 1 }\n`, { mode: 0o600 });
  try {
    try { await runWindowless(file, env, false, 45000, deadline); }
    catch (e) {
      let detail='';try { detail=readFileSync(error,'utf8').trim(); } catch {}
      let hostDetail='';try { hostDetail=readFileSync(file+'.host-error','utf8').slice(0,8000); } catch {}
      const diagnostic=[detail,hostDetail,String(e)].join('\n');
      const permanent=/ExecutionPolicy|AppLocker|Constrained\s*Language|ConstrainedLanguage|running scripts is disabled|blocked by (?:group |software restriction )?policy|PSSecurityException|UnauthorizedAccessException/i.test(diagnostic);
      const message=`PowerShell/Add-Type containment failed (process Bypass cannot override enforced Group Policy): ${detail || hostDetail || String(e)}`;
      // Native Call tags only connection/stream I/O. Native validation, ACL,
      // compiler/policy failures and explicit broker rejections are not retried.
      if (!permanent && (detail.includes('containment-transport:') || (!detail && /Windowless (PowerShell failed|host deadline)/.test(String(e))))) throw new ContainmentTransportError(message);
      throw new Error(message);
    }
    return readFileSync(output, 'utf8').trim();
  } finally { try { rmSync(directory,{recursive:true,force:true}); } catch { /* Preserve the bridge error; owner-based scavenger retries. */ } }
}
export async function launchBroker(config: BrokerConfig): Promise<void> {
  const directory = mkdtempSync(join(dirname(await ensureWindowlessHost()), 'broker-'));
  const script = join(directory, 'broker.ps1');
  writeFileSync(script, '\ufeff$ErrorActionPreference="Stop"\n' + `try {\n` + ownTemporaryDirectory(directory) + await loadNative(nativeScript(`[AiCliContainment]::Run(${quote(config.name)},${quote(config.directory)},${config.idleMs})`)) + `} catch { [IO.File]::WriteAllText(${quote(directory+'.error.log')},(${quote(config.name+'\n')}+($_ | Out-String))); exit 1 } finally { try { [IO.Directory]::Delete(${quote(directory)},$true) } catch { [Console]::Error.WriteLine('containment TEMP cleanup: '+($_ | Out-String)) } }\n`, { mode: 0o600 });
  try { await runWindowless(script, {}, true); }
  catch(error) { try { rmSync(directory,{recursive:true,force:true}); } catch {} throw error; }
}
export async function bridgeCall(config: BrokerConfig, payload: object, deadline?: number): Promise<unknown> {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const result = await powershell(nativeScript(`[AiCliContainment]::Call(${quote(config.name)},${quote(config.directory)},[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AI_CLI_CONTAINMENT_REQUEST)))`), { AI_CLI_CONTAINMENT_REQUEST: encoded }, deadline);
  const reply = JSON.parse(result);
  if (reply.ok !== true) throw new Error(String(reply.error || 'containment request rejected'));
  return reply.value;
}
