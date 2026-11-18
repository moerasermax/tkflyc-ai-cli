/** GUI subsystem host: CreateProcess(CREATE_NO_WINDOW), never a console + later hide. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
export const ANTIVIRUS_HINT = 'the helper was built but is gone; antivirus software may have quarantined it. Allow this file in your antivirus (or restore it from quarantine) and retry';
export const ANTIVIRUS_BLOCKED_HINT = 'the helper exists but could not be started; antivirus or another security product may be blocking it. Allow this file and retry';
export function windowlessBootstrapError(code: number | null, stderr: string, target: string, targetExists: boolean): Error {
  const base = `PowerShell/Add-Type or private helper ACL unavailable (${code}): ${stderr}`;
  const vanished = (code === 0 && !targetExists) || stderr.includes(VANISHED_MARKER);
  return new Error(vanished ? `Windowless helper missing: ${target} — ${ANTIVIRUS_HINT}. ${base}` : base);
}
/**
 * 啟動輔助程式時的 spawn 錯誤。檔案不在＝missing；檔案還在、但 EACCES／EPERM／UNKNOWN＝
 * blocked（只說「可能」，不把一般錯誤當成被隔離的證據）。其他錯誤原樣回傳。
 */
const SPAWN_SECURITY_CODES = ['ENOENT', 'EACCES', 'EPERM', 'UNKNOWN'];
export function windowlessSpawnError(error: NodeJS.ErrnoException, host: string, hostExists: boolean): Error {
  if (!SPAWN_SECURITY_CODES.includes(error.code ?? '')) return error;
  return hostExists
    ? new Error(`Windowless helper blocked (${error.code}): ${host} — ${ANTIVIRUS_BLOCKED_HINT}. ${error.message}`)
    : new Error(`Windowless helper missing (${error.code}): ${host} — ${ANTIVIRUS_HINT}. ${error.message}`);
}
export function remainingTime(deadline: number | undefined, limit: number): number {
  const remaining = deadline === undefined ? limit : Math.min(limit, deadline - performance.now());
  if (remaining <= 0) throw new Error('Windowless host deadline; containment unknown');
  return Math.max(1, Math.floor(remaining));
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
async function compileHost(deadline?: number): Promise<string> {
  const { directory, target } = windowlessHostPath();
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  // TEMP may be shared and Node mode bits do not set Windows ACLs. Create with
  // an explicit DACL atomically, reject pre-existing insecure/reparse roots.
  // The bootstrap is inline: no executable script is written into shared TEMP.
  const script = `$ErrorActionPreference='Stop'\n$compiled=$null;$source=$null
# #25: remove this run's temp files on every exit path; never fail the bootstrap over cleanup.
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
if(!(Test-Path -LiteralPath $target)) {
  $compiled=Join-Path $directory (([Guid]::NewGuid().ToString())+'.exe');$source=$compiled+'.cs'
  [IO.File]::WriteAllText($source,@'
${SOURCE}
'@)
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
    const child=spawn(process.execPath,['-e',bootstrap],{detached:true,windowsHide:true,timeout:remainingTime(deadline,55000),killSignal:'SIGKILL',stdio:['ignore','ignore','pipe']});
    let error='';child.stderr.on('data',data=>{error=(error+String(data)).slice(-4000);});
    // Bound the caller independently of a close event (including a failed kill).
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}reject(new Error('Windowless bootstrap deadline; containment unknown'));},remainingTime(deadline,55000));
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);const exists=existsSync(target);code===0 && exists?resolve():reject(windowlessBootstrapError(code,error,target,exists));});
  });
  return target;
}

export async function runWindowless(script: string, env: NodeJS.ProcessEnv = {}, background = false, timeoutMs = 45000, deadline?: number): Promise<void> {
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
    child.once('error',(error: NodeJS.ErrnoException)=>{clearTimeout(timer);reject(spawnFailure(error));});
    child.once('close',code=>{clearTimeout(timer);expired?reject(new Error('Windowless host deadline; containment unknown')):code===0?resolve():reject(new Error(`Windowless PowerShell failed (${code}); ${script}`));});
  });
}
