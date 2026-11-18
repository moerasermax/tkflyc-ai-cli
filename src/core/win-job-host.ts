/** GUI subsystem host: CreateProcess(CREATE_NO_WINDOW), never a console + later hide. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SOURCE = String.raw`
using System; using System.IO; using System.Text; using System.Runtime.InteropServices;
public static class WindowlessHost {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,cx,cy,xc,yc,fill,flags; public short show,extra; public IntPtr extraData,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
  [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int cls,IntPtr info,uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
  static IntPtr OwnedJob() {
    IntPtr job=CreateJobObjectW(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("helper job unavailable");
    int size=IntPtr.Size==8?144:112;IntPtr info=Marshal.AllocHGlobal(size);
    try {for(int i=0;i<size;i++)Marshal.WriteByte(info,i,0);Marshal.WriteInt32(info,16,0x2000);
      if(!SetInformationJobObject(job,9,info,(uint)size)){CloseHandle(job);throw new Exception("helper job limits unavailable");}return job;
    }finally{Marshal.FreeHGlobal(info);}
  }
  public static int Main(string[] args) {
    try {
      var si=new SI(); si.cb=Marshal.SizeOf(si); PI p;
      string exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");
      var command=new StringBuilder("\""+exe+"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+args[0]+"\"");
      bool background=args.Length>1 && args[1]=="background";
      IntPtr owner=IntPtr.Zero,job=IntPtr.Zero;long born=0,e,k,u;bool released=false,selfOwned=false;
      try {
        if(!background) {
          int requester=int.Parse(args[1]);owner=OpenProcess(0x00101000,false,requester);
          long requesterBorn,selfBorn;
          if(owner==IntPtr.Zero || GetProcessId(owner)!=requester || !GetProcessTimes(owner,out requesterBorn,out e,out k,out u) || !GetProcessTimes(GetCurrentProcess(),out selfBorn,out e,out k,out u) || requesterBorn>selfBorn || WaitForSingleObject(owner,0)==0)throw new Exception("requester identity unavailable");
          job=OwnedJob();
          if(!AssignProcessToJobObject(job,GetCurrentProcess()))throw new Exception("host assignment refused");
          selfOwned=true; // Keep the Job handle until host exit, including outer timeout.
        }
        // Suspended + CREATE_NO_WINDOW: no user code before private Job assignment.
        if(!CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x08000004u,IntPtr.Zero,null,ref si,out p))throw new System.ComponentModel.Win32Exception();
        try {
          if(!GetProcessTimes(p.process,out born,out e,out k,out u))throw new Exception("child identity unavailable");
          bool inside;if(!background && (!IsProcessInJob(p.process,job,out inside)||!inside))throw new Exception("helper inheritance refused");
          if(ResumeThread(p.thread)==0xffffffff)throw new Exception("helper resume refused");
          if(background){released=true;return 0;}
          uint wait=WaitForMultipleObjects(2,new[]{p.process,owner},false,uint.Parse(args[2]));
          if(wait!=0) {
            long current;if(GetProcessId(p.process)==p.pid && GetProcessTimes(p.process,out current,out e,out k,out u) && current==born) {
              if(!TerminateJobObject(job,124))throw new Exception("helper termination refused");
              WaitForSingleObject(p.process,5000);
            }
            return 124;
          }
          uint code;if(!GetExitCodeProcess(p.process,out code))return 125;return (int)code;
        } finally {
          // Includes descendants even if PowerShell exited first; no breakaway flags.
          if(job!=IntPtr.Zero && !selfOwned){CloseHandle(job);job=IntPtr.Zero;}
          if(born!=0 && WaitForSingleObject(p.process,0)!=0 && !released) {
            long current;if(GetProcessId(p.process)==p.pid && GetProcessTimes(p.process,out current,out e,out k,out u) && current==born)TerminateProcess(p.process,125);
          }
          CloseHandle(p.thread);CloseHandle(p.process);
        }
      }finally{if(job!=IntPtr.Zero && !selfOwned)CloseHandle(job);if(owner!=IntPtr.Zero)CloseHandle(owner);}
    } catch(Exception e) { if(args.Length>0) File.WriteAllText(args[0]+".host-error",(Environment.GetEnvironmentVariable("AI_CLI_CONTAINMENT_TEST")??"")+"\n"+e.ToString()); return 126; }
  }
}`;
let ready: Promise<string> | undefined;
const SOURCE_SHA256 = createHash('sha256').update(SOURCE, 'utf8').digest('hex').toUpperCase();
/**
 * 輔助程式的位置。目錄名由輔助程式原始碼與模組位置算出，所以不同 checkout／版本互不共用。
 * 抽出來是為了讓 doctor 能回報路徑而不必真的編譯（#25）。
 */
export function windowlessHostPath(): { directory: string; target: string } {
  // Include install location: tests/builds cannot reuse another checkout's helper.
  const hash = createHash('sha256').update('private-acl-v1\0' + SOURCE + import.meta.url).digest('hex').slice(0,24);
  const directory = join(tmpdir(), 'ai-cli-windowless-' + hash);
  return { directory, target: join(directory, 'ai-cli-windowless-host.exe') };
}
/**
 * #25：第三方防毒（實例：McAfee 個人版）會把現場編出來、沒有簽章的輔助程式刪掉。
 * 舊訊息只寫「ACL unavailable」，加上 Move 的「file already exists」，會把人帶去查權限。
 * 這裡只在有「編好了卻不見」的跡象時才加提示：bootstrap 成功但目標不存在，或
 * bootstrap 自己印出 VANISHED_MARKER（編譯輸出或搬過去的目標在來源也不在時才印；
 * 來源還在的搬檔失敗照原例外丟，不算防毒）。其他失敗維持原訊息，不亂指防毒。
 * 用固定標記而不是比對一般文字：路徑或其他診斷碰巧含同樣字樣時不會誤判（稽核 gpt-6.2-sol）。
 */
export const VANISHED_MARKER = 'AI_CLI_HELPER_VANISHED';
/**
 * 編好的輔助程式用不了（被防毒移除或封鎖）。只有這個錯誤會讓 runWindowless 改走 PowerShell host；
 * 它只會在腳本開始執行之前丟出（bootstrap 失敗、spawn 失敗），所以改走另一條不會重跑已啟動的腳本。
 */
export class WindowlessHelperUnavailableError extends Error {}
export const ANTIVIRUS_HINT = 'the helper was built but is gone; antivirus software may have quarantined it. Allow this file in your antivirus (or restore it from quarantine) and retry';
export const ANTIVIRUS_BLOCKED_HINT = 'the helper exists but could not be started; antivirus or another security product may be blocking it. Allow this file and retry';
export function windowlessBootstrapError(code: number | null, stderr: string, target: string, targetExists: boolean): Error {
  const base = `PowerShell/Add-Type or private helper ACL unavailable (${code}): ${stderr}`;
  const vanished = (code === 0 && !targetExists) || stderr.includes(VANISHED_MARKER);
  return vanished ? new WindowlessHelperUnavailableError(`Windowless helper missing: ${target} — ${ANTIVIRUS_HINT}. ${base}`) : new Error(base);
}
/**
 * 啟動輔助程式時的 spawn 錯誤。檔案不在＝missing；檔案還在、但 EACCES／EPERM／UNKNOWN＝
 * blocked（只說「可能」，不把一般錯誤當成被隔離的證據）。其他錯誤原樣回傳。
 */
const SPAWN_SECURITY_CODES = ['ENOENT', 'EACCES', 'EPERM', 'UNKNOWN'];
export function windowlessSpawnError(error: NodeJS.ErrnoException, host: string, hostExists: boolean): Error {
  if (!SPAWN_SECURITY_CODES.includes(error.code ?? '')) return error;
  return hostExists
    ? new WindowlessHelperUnavailableError(`Windowless helper blocked (${error.code}): ${host} — ${ANTIVIRUS_BLOCKED_HINT}. ${error.message}`)
    : new WindowlessHelperUnavailableError(`Windowless helper missing (${error.code}): ${host} — ${ANTIVIRUS_HINT}. ${error.message}`);
}
export function remainingTime(deadline: number | undefined, limit: number): number {
  const remaining = deadline === undefined ? limit : Math.min(limit, deadline - performance.now());
  if (remaining <= 0) throw new Error('Windowless host deadline; containment unknown');
  return Math.max(1, Math.floor(remaining));
}
/**
 * #25：第三方防毒（McAfee 個人版）會刪掉現場編出來的 exe，使用者又無法事先加例外。
 * 所以 exe 用不了時改走「PowerShell host」：由系統內建、微軟簽章的 powershell.exe 以 P/Invoke
 * 做和 exe 一樣的事（私有 kill-on-close Job、核對呼叫者、逾時或呼叫者消失就終止整個 Job），
 * 不寫任何執行檔到磁碟。切換後同一個行程一直用它（不會每次都再編一次再被砍）。
 * AI_CLI_WINDOWLESS_HOST=powershell 可強制使用（測試兩條路徑等價，也是使用者的逃生口）。
 */
export type WindowlessHostMode = 'compiled' | 'powershell';
let fallbackMode: WindowlessHostMode | undefined;
export function windowlessHostMode(): WindowlessHostMode {
  return process.env.AI_CLI_WINDOWLESS_HOST === 'powershell' ? 'powershell' : (fallbackMode ?? 'compiled');
}
let rootReady: Promise<string> | undefined;
/**
 * 私有目錄（bridge／broker 暫存、native DLL 快取都放這裡）。compiled 模式＝輔助程式所在目錄；
 * exe 用不了時，bootstrap 只建立並驗證目錄的 ACL，不編譯。
 */
export async function ensureWindowlessRoot(deadline?: number): Promise<string> {
  if (windowlessHostMode() === 'compiled') {
    try { return dirname(await ensureWindowlessHost(deadline)); }
    catch (error) { if (!(error instanceof WindowlessHelperUnavailableError)) throw error; fallbackMode = 'powershell'; }
  }
  remainingTime(deadline, 55000);
  if (!rootReady) { const created: Promise<string> = compileHost(deadline, false).catch(error => { if (rootReady === created) rootReady = undefined; throw error; }); rootReady = created; }
  const pending = rootReady;
  // 共用同一個 bootstrap，但每個等待者各自受自己的期限約束（稽核 gpt-6.2-astra）。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const directory = deadline === undefined ? await pending : await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Windowless host deadline; containment unknown')), remainingTime(deadline, 55000)); })]);
    if (existsSync(directory)) return directory;
    if (rootReady === pending) rootReady = undefined;
    return await ensureWindowlessRoot(deadline);
  } finally { clearTimeout(timer); }
}
export async function ensureWindowlessHost(deadline?: number): Promise<string> {
  remainingTime(deadline, 55000);
  // 只清掉「自己這一代」的快取：舊的失敗不可以清掉別人剛開始的重編（稽核 gpt-6.2-sol）。
  if (!ready) { const created: Promise<string> = compileHost(deadline).catch(error => { if (ready === created) ready = undefined; throw error; }); ready = created; }
  const pending = ready;
  // Another caller may own an in-flight bootstrap; do not kill its process.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const target = deadline === undefined ? await pending : await Promise.race([pending, new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Windowless host deadline; containment unknown')),remainingTime(deadline,55000));})]);
    if (existsSync(target)) return target;
    if(ready===pending)ready=undefined;return await ensureWindowlessHost(deadline);
  }
  finally { clearTimeout(timer); }
}
async function compileHost(deadline?: number, compile = true): Promise<string> {
  const { directory, target } = windowlessHostPath();
  const expected = compile ? target : directory;
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  // TEMP may be shared and Node mode bits do not set Windows ACLs. Create with
  // an explicit DACL atomically, reject pre-existing insecure/reparse roots.
  // The bootstrap is inline: no executable script is written into shared TEMP.
  const script = `$ErrorActionPreference='Stop'\n$compiled=$null;$source=$null
# #25: remove this run's temp files on every exit path; never fail the bootstrap over cleanup.
$compile=${compile ? '$true' : '$false'}
function Clear-Temp{try{foreach($f in @($source,$compiled)){if($f -and (Test-Path -LiteralPath $f)){Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue}}}catch{}}
try {
$directory=${quote(directory)}; $target=${quote(target)}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow'))
[IO.Directory]::CreateDirectory($directory,$acl) | Out-Null
$item=Get-Item -LiteralPath $directory -Force
if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'helper root is a reparse point'}
$actual=$item.GetAccessControl(); $rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl'){throw 'helper root ACL mismatch'}
# Reflection.Emit defines native calls without starting a compiler. Place this
# PowerShell in its own non-breakaway kill-on-close Job before invoking csc.
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('CompilerOwner'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$type=$assembly.DefineDynamicModule('Native').DefineType('CompilerOwner',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
function Native($name,$result,[Type[]]$parameters){$m=$type.DefinePInvokeMethod($name,'kernel32.dll',[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$result,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode);$m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)}
Native 'CreateJobObjectW' ([IntPtr]) @([IntPtr],[string]);Native 'SetInformationJobObject' ([bool]) @([IntPtr],[int],[IntPtr],[uint32]);Native 'AssignProcessToJobObject' ([bool]) @([IntPtr],[IntPtr]);Native 'GetCurrentProcess' ([IntPtr]) @()
$native=$type.CreateType();$job=$native::CreateJobObjectW([IntPtr]::Zero,$null)
$size=if([IntPtr]::Size -eq 8){144}else{112};$info=[Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {for($i=0;$i -lt $size;$i++){[Runtime.InteropServices.Marshal]::WriteByte($info,$i,0)};[Runtime.InteropServices.Marshal]::WriteInt32($info,16,0x2000)
if($job -eq [IntPtr]::Zero -or !$native::SetInformationJobObject($job,9,$info,$size) -or !$native::AssignProcessToJobObject($job,$native::GetCurrentProcess())){throw 'compiler ownership refused'}
}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($info)}
# Keep the private Job handle until process exit. The short Node parent owns this
# PS handle; its exit closes the whole compiler Job, not just a detached child.
$requester=[Diagnostics.Process]::GetProcessById(${process.pid});$requesterHandle=$requester.Handle
if($requester.StartTime.ToUniversalTime() -gt [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime() -or $requester.HasExited){throw 'compiler requester lost'}
# #25: earlier failed or killed builds left <GUID>.exe / <GUID>.exe.cs behind. Only GUID-named
# files older than an hour: a concurrent bootstrap's fresh files and other caches are untouched.
$stale=[DateTime]::UtcNow.AddHours(-1)
Get-ChildItem -LiteralPath $directory -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.exe(\\.cs)?$' -and $_.LastWriteTimeUtc -lt $stale -and (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
# Keep the target-exists test below as its own literal line: fix5 rewrites that exact text to inject a hanging compiler.
if($compile) {
if(!(Test-Path -LiteralPath $target)) {
  $compiled=Join-Path $directory (([Guid]::NewGuid().ToString())+'.exe');$source=$compiled+'.cs'
  # The C# source arrives through the environment, not the command line: inlined, the UTF-16 base64
  # command came within ~80 characters of the 32767 limit (#25). Its hash is pinned in this script.
  $text=[Environment]::GetEnvironmentVariable('AI_CLI_WINDOWLESS_SOURCE')
  if(!$text -or ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-','')) -ne '${SOURCE_SHA256}'){throw 'helper source mismatch'}
  [IO.File]::WriteAllText($source,$text)
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  $start.Arguments='/nologo /target:winexe /out:"'+$compiled+'" "'+$source+'"';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $compiler=[Diagnostics.Process]::Start($start);$compilerHandle=$compiler.Handle;$compilerPid=$compiler.Id;$compilerBorn=$compiler.StartTime.ToUniversalTime()
  $compilerOutput=$compiler.StandardOutput.ReadToEndAsync();$compilerError=$compiler.StandardError.ReadToEndAsync()
  $until=[DateTime]::UtcNow.AddSeconds(25)
  while(!$compiler.WaitForExit(50)){if($requester.HasExited -or [DateTime]::UtcNow -ge $until){if($compiler.Id -eq $compilerPid -and $compiler.StartTime.ToUniversalTime() -eq $compilerBorn){$compiler.Kill();$compiler.WaitForExit()};throw ('compiler deadline/requester exit: '+$compilerOutput.GetAwaiter().GetResult()+$compilerError.GetAwaiter().GetResult())}}
  if($compiler.ExitCode -ne 0){throw ($compilerOutput.GetAwaiter().GetResult()+$compilerError.GetAwaiter().GetResult())}
  $compiler.Dispose();$requester.Dispose()
  if(!(Test-Path -LiteralPath $compiled)){throw ('${VANISHED_MARKER}: compiler succeeded but '+$compiled+' is gone before install')}
  try{[IO.File]::Move($compiled,$target)}catch{if(!(Test-Path -LiteralPath $target)){if(Test-Path -LiteralPath $compiled){throw}else{throw ('${VANISHED_MARKER}: '+$target+' missing after move: '+$_)}}}
}
}
Clear-Temp
exit 0
}catch{[Console]::Error.WriteLine($_);Clear-Temp;exit 1}
`;
  // The detached Node owns its non-detached PS handle; PS installs a private
  // non-breakaway Job before csc, since libuv alone does not contain grandchildren.
  // The runner itself never acquires libuv's Job before containment registration.
  const bootstrapTimeout=Math.max(1,remainingTime(deadline,45000)-(deadline===undefined?0:1000));
  const bootstrap = `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'))},['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${JSON.stringify(Buffer.from(script,'utf16le').toString('base64'))}],{windowsHide:true,timeout:${bootstrapTimeout},killSignal:'SIGKILL',stdio:['ignore','pipe','pipe']});c.stdout.resume();c.stderr.pipe(process.stderr);c.on('error',e=>{console.error(e);process.exitCode=1;});c.on('close',code=>process.exitCode=code??124);`;
  await new Promise<void>((resolve,reject) => {
    const child=spawn(process.execPath,['-e',bootstrap],{detached:true,windowsHide:true,timeout:remainingTime(deadline,55000),killSignal:'SIGKILL',stdio:['ignore','ignore','pipe'],env:{...process.env,AI_CLI_WINDOWLESS_SOURCE:SOURCE}});
    let error='';child.stderr.on('data',data=>{error=(error+String(data)).slice(-4000);});
    // Bound the caller independently of a close event (including a failed kill).
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}reject(new Error('Windowless bootstrap deadline; containment unknown'));},remainingTime(deadline,55000));
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);const exists=existsSync(expected);code===0 && exists?resolve():reject(windowlessBootstrapError(code,error,expected,exists));});
  });
  return expected;
}

export async function runWindowless(script: string, env: NodeJS.ProcessEnv = {}, background = false, timeoutMs = 45000, deadline?: number): Promise<void> {
  if (windowlessHostMode() === 'compiled') {
    try { return await runCompiled(script, env, background, timeoutMs, deadline); }
    catch (error) { if (!(error instanceof WindowlessHelperUnavailableError)) throw error; fallbackMode = 'powershell'; }
  }
  return runViaPowerShellHost(script, env, background, timeoutMs, deadline);
}

const POWERSHELL_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;
/**
 * WindowlessHost.Main 的 PowerShell 版本（見 SOURCE）。差異只有兩處，都不放寬包容：
 * - 子行程用 Process.Start(CreateNoWindow) 而不是 CREATE_SUSPENDED：host 先把自己放進沒有 breakaway 的
 *   私有 Job 再建子行程，子行程在建立當下就屬於這個 Job；建立後仍核對 IsProcessInJob，不在就殺掉並失敗。
 * - 等待用 50ms 輪詢（子行程結束／呼叫者消失／逾時）取代 WaitForMultipleObjects。
 * Job handle 由 host 持有到結束（kill-on-close）：host 被 Node 的逾時殺掉時，整個 Job 一起結束。
 */
export function powerShellHostScript(script: string, background: boolean, requesterPid: number, timeoutMs: number): string {
  return `$ErrorActionPreference='Stop'
$scriptPath=${psQuote(script)}
try {
$exe=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\\v1.0\\powershell.exe'
$start=[Diagnostics.ProcessStartInfo]::new($exe,'-NoLogo -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "'+$scriptPath+'"')
$start.UseShellExecute=$false;$start.CreateNoWindow=$true
${background ? `$p=[Diagnostics.Process]::Start($start);$p.Dispose();[Environment]::Exit(0)` : `$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('WindowlessPsHost'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$type=$assembly.DefineDynamicModule('Native').DefineType('WindowlessPsHost',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
function Native($name,$result,[Type[]]$parameters){$m=$type.DefinePInvokeMethod($name,'kernel32.dll',[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$result,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode);$m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)}
Native 'CreateJobObjectW' ([IntPtr]) @([IntPtr],[string]);Native 'SetInformationJobObject' ([bool]) @([IntPtr],[int],[IntPtr],[uint32]);Native 'AssignProcessToJobObject' ([bool]) @([IntPtr],[IntPtr]);Native 'GetCurrentProcess' ([IntPtr]) @()
Native 'IsProcessInJob' ([bool]) @([IntPtr],[IntPtr],[bool].MakeByRefType());Native 'TerminateJobObject' ([bool]) @([IntPtr],[uint32])
$native=$type.CreateType()
$owner=[Diagnostics.Process]::GetProcessById(${requesterPid});$ownerHandle=$owner.Handle
if($owner.HasExited -or $owner.StartTime.ToUniversalTime() -gt [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime()){throw 'requester identity unavailable'}
$job=$native::CreateJobObjectW([IntPtr]::Zero,$null);if($job -eq [IntPtr]::Zero){throw 'helper job unavailable'}
$size=if([IntPtr]::Size -eq 8){144}else{112};$info=[Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {for($i=0;$i -lt $size;$i++){[Runtime.InteropServices.Marshal]::WriteByte($info,$i,0)};[Runtime.InteropServices.Marshal]::WriteInt32($info,16,0x2000)
if(!$native::SetInformationJobObject($job,9,$info,$size)){throw 'helper job limits unavailable'}}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($info)}
if(!$native::AssignProcessToJobObject($job,$native::GetCurrentProcess())){throw 'host assignment refused'}
$p=[Diagnostics.Process]::Start($start);$child=$p.Handle
$inside=$false;if(!$native::IsProcessInJob($child,$job,[ref]$inside) -or !$inside){try{$p.Kill()}catch{};throw 'helper inheritance refused'}
$until=[DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
while(!$p.WaitForExit(50)){if($owner.HasExited -or [DateTime]::UtcNow -ge $until){if(!$native::TerminateJobObject($job,124)){throw 'helper termination refused'};$p.WaitForExit(5000)|Out-Null;[Environment]::Exit(124)}}
$p.WaitForExit()
[Environment]::Exit($p.ExitCode)`}
} catch { try{[IO.File]::WriteAllText($scriptPath+'.host-error',([string][Environment]::GetEnvironmentVariable('AI_CLI_CONTAINMENT_TEST'))+"\`n"+($_ | Out-String))}catch{}; [Environment]::Exit(126) }
`;
}
/**
 * 為什麼中間要隔一個 detached Node（和 bootstrap 同一個模式）：
 * - powershell.exe 以 DETACHED_PROCESS（沒有主控台）啟動時會直接 exit 0、什麼都不執行
 *   （2026-11-19 本機實測；這也是原設計用 GUI exe＋CREATE_NO_WINDOW 的原因）。所以 PowerShell 必須
 *   非 detached＋windowsHide（libuv 給 CREATE_NO_WINDOW：有隱藏主控台、不閃視窗）。
 * - 但呼叫端（runner）自己不可以做非 detached 的 spawn：那會在 runner 建立 libuv 的 Job。
 *   所以由 detached 的中介 Node 去 spawn，libuv Job 留在中介 Node 那邊。
 * - 中介 Node 被逾時殺掉 → 它的 libuv Job（kill-on-close）收掉 PowerShell host → host 的私有 Job 收掉腳本子孫。
 *   背景模式（broker）：host 不建私有 Job，子行程經 libuv Job 的 silent breakaway 脫離，所以中介結束後 broker 仍在。
 */
function relayScript(encoded: string): string {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  // windowsHide＝CREATE_NO_WINDOW：有隱藏主控台、不閃視窗。不可 detached（見上）。
  return `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(POWERSHELL_EXE)},${JSON.stringify(args)},{stdio:'ignore',windowsHide:true});c.on('error',()=>{process.exitCode=126;});c.on('close',code=>{process.exitCode=code===null?124:code;});`;
}
async function runViaPowerShellHost(script: string, env: NodeJS.ProcessEnv, background: boolean, timeoutMs: number, deadline?: number): Promise<void> {
  const limit = remainingTime(deadline, Math.max(1, Math.min(45000, timeoutMs)));
  const encoded = Buffer.from(powerShellHostScript(script, background, process.pid, limit), 'utf16le').toString('base64');
  // 外層期限：host 自己的逾時之外再多 5 秒；被殺時中介的 libuv Job 收掉 host，host 的私有 Job 收掉腳本子孫。
  const outer = remainingTime(deadline, limit + 5000);
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    // The relay is an internal one-liner: NODE_OPTIONS (user --require/--import hooks, test preloads) must not run in it.
    const relayEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    for (const key of Object.keys(relayEnv)) if (key.toUpperCase() === 'NODE_OPTIONS') delete relayEnv[key];
    try { child = spawn(process.execPath, ['-e', relayScript(encoded)], { detached: true, windowsHide: true, stdio: 'ignore', env: relayEnv }); }
    catch (error) { reject(error); return; }
    let expired = false;
    const timer = setTimeout(() => { expired = true; try { child.kill('SIGKILL'); } catch {} reject(new Error('Windowless host deadline; containment unknown')); }, outer);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error('Windowless host deadline; containment unknown'));
      else if (code === 0) resolve();
      else reject(new Error(`Windowless PowerShell failed (${code}); ${script}`));
    });
  });
}

async function runCompiled(script: string, env: NodeJS.ProcessEnv, background: boolean, timeoutMs: number, deadline?: number): Promise<void> {
  const host=await ensureWindowlessHost(deadline);
  const generation=ready;
  timeoutMs=remainingTime(deadline,Math.max(1,Math.min(45000,timeoutMs)));
  // #25：ENOENT＝ensure 之後到 spawn 之間被刪；EACCES／EPERM／UNKNOWN＝常見的防毒封鎖執行。
  // Node 對 EPERM／UNKNOWN 會在 spawn() 同步丟出，所以同步與 error 事件走同一條（稽核 gpt-6.2-sol）。
  // 檔案不見時只清自己這一代的快取，下次呼叫會重編；這次照樣失敗，但講得出是哪個檔。
  const spawnFailure=(error: NodeJS.ErrnoException): Error=>{const exists=existsSync(host);if(!exists && ready===generation)ready=undefined;return windowlessSpawnError(error,host,exists);};
  await new Promise<void>((resolve,reject)=>{
    let child: ReturnType<typeof spawn>;
    try{child=spawn(host,[script,...(background?['background']:[String(process.pid),String(Math.max(1,Math.min(45000,timeoutMs)))])],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,...env}});}
    catch(error){reject(spawnFailure(error as NodeJS.ErrnoException));return;}
    // Node's retained ChildProcess handle cannot target a reused PID. A foreground
    // host joins its private Job before creating children; killing it closes that Job.
    let expired=false;
    const timer=setTimeout(()=>{expired=true;try{child.kill('SIGKILL');}catch{}reject(new Error('Windowless host deadline; containment unknown'));},remainingTime(deadline,Math.max(1,Math.min(45000,timeoutMs))+5000));
    // 只有「還沒啟動」的錯誤才能改走 PowerShell host 重試。child.kill() 失敗時 Node 會同步發出 error，
    // 那時腳本可能已在跑：逾時之後或已收到 spawn 事件的錯誤一律原樣回報，不重跑（稽核 gpt-6.2-astra）。
    let spawned=false;child.once('spawn',()=>{spawned=true;});
    child.once('error',(error: NodeJS.ErrnoException)=>{clearTimeout(timer);if(expired)return;reject(spawned?error:spawnFailure(error));});
    child.once('close',code=>{
      clearTimeout(timer);
      if(expired){reject(new Error('Windowless host deadline; containment unknown'));return;}
      if(code===0){resolve();return;}
      // #25：非 0 結束而且 exe 已經不見＝防毒在執行掃描時殺掉並移除它。這次不重跑（腳本可能已部分執行），
      // 但之後改走 PowerShell host；前綴維持 "Windowless PowerShell failed"，呼叫端既有的傳輸錯誤重送照常運作。
      if(!existsSync(host)){if(ready===generation)ready=undefined;fallbackMode='powershell';reject(new Error(`Windowless PowerShell failed (${code}); ${script} — helper ${host} disappeared during launch; ${ANTIVIRUS_HINT}. Later calls use the PowerShell host.`));return;}
      reject(new Error(`Windowless PowerShell failed (${code}); ${script}`));
    });
  });
}
