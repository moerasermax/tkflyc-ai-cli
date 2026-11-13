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
export function remainingTime(deadline: number | undefined, limit: number): number {
  const remaining = deadline === undefined ? limit : Math.min(limit, deadline - performance.now());
  if (remaining <= 0) throw new Error('Windowless host deadline; containment unknown');
  return Math.max(1, Math.floor(remaining));
}
export async function ensureWindowlessHost(deadline?: number): Promise<string> {
  remainingTime(deadline, 55000);
  const pending = ready ??= compileHost(deadline).catch(error => { ready = undefined; throw error; });
  // Another caller may own an in-flight bootstrap; do not kill its process.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const target = deadline === undefined ? await pending : await Promise.race([pending, new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Windowless host deadline; containment unknown')),remainingTime(deadline,55000));})]);
    if (existsSync(target)) return target;
    ready=undefined;return await ensureWindowlessHost(deadline);
  }
  finally { clearTimeout(timer); }
}
async function compileHost(deadline?: number): Promise<string> {
  // Include install location: tests/builds cannot reuse another checkout's helper.
  const hash = createHash('sha256').update('private-acl-v1\0' + SOURCE + import.meta.url).digest('hex').slice(0,24);
  const directory = join(tmpdir(), 'ai-cli-windowless-' + hash), target = join(directory, 'ai-cli-windowless-host.exe');
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  // TEMP may be shared and Node mode bits do not set Windows ACLs. Create with
  // an explicit DACL atomically, reject pre-existing insecure/reparse roots.
  // The bootstrap is inline: no executable script is written into shared TEMP.
  const script = `$ErrorActionPreference='Stop'\ntry {
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
  try{[IO.File]::Move($compiled,$target)}catch{if(!(Test-Path -LiteralPath $target)){throw}}
}

exit 0
}catch{[Console]::Error.WriteLine($_);exit 1}
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
    child.once('close',code=>{clearTimeout(timer);code===0 && existsSync(target)?resolve():reject(new Error(`PowerShell/Add-Type or private helper ACL unavailable (${code}): ${error}`));});
  });
  return target;
}

export async function runWindowless(script: string, env: NodeJS.ProcessEnv = {}, background = false, timeoutMs = 45000, deadline?: number): Promise<void> {
  const host=await ensureWindowlessHost(deadline);
  timeoutMs=remainingTime(deadline,Math.max(1,Math.min(45000,timeoutMs)));
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(host,[script,...(background?['background']:[String(process.pid),String(Math.max(1,Math.min(45000,timeoutMs)))])],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,...env}});
    // Node's retained ChildProcess handle cannot target a reused PID. A foreground
    // host joins its private Job before creating children; killing it closes that Job.
    let expired=false;
    const timer=setTimeout(()=>{expired=true;try{child.kill('SIGKILL');}catch{}reject(new Error('Windowless host deadline; containment unknown'));},remainingTime(deadline,Math.max(1,Math.min(45000,timeoutMs))+5000));
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);expired?reject(new Error('Windowless host deadline; containment unknown')):code===0?resolve():reject(new Error(`Windowless PowerShell failed (${code}); ${script}`));});
  });
}
