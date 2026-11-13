/** Add-Type 的完整來源：啟動時一次載入，活躍期間不再讀安裝目錄。無原生 npm 相依。 */
export const WIN_JOB_NATIVE = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class AiCliContainment {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr reserved1, peb, reserved2, reserved3, pid, parent; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateMutexW(ref SA sa, bool owner, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReleaseMutex(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, out PBI info, int size, out int returned);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr info, int size, out int returned);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateNamedPipeW(string name, uint mode, uint pipeMode, uint max, uint outSize, uint inSize, uint timeout, ref SA sa);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle h, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafeFileHandle h, out uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(ref SA sa, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out Accounting value, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileExW(string source, string dest, uint flags);
  delegate bool WindowEnum(IntPtr window,IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowEnum callback,IntPtr context);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle,int kind,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor,uint revision,uint info,out IntPtr text,out uint length);
  static string SecurityText(IntPtr descriptor) {
    IntPtr text;uint length;Require(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor,1,0x15,out text,out length),"security text");
    try{return Marshal.PtrToStringUni(text);}finally{LocalFree(text);}
  }
  static Exception Error(string message) { int error=Marshal.GetLastWin32Error(); return new Win32Exception(error, message+": win32="+error); }
  static void Require(bool b, string m) { if (!b) throw new InvalidOperationException(m); }
  static string SID = WindowsIdentity.GetCurrent().User.Value;
  static SA Security(bool medium=false) {
    IntPtr p; uint n;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+SID+"D:P(A;;GA;;;"+SID+")"+(medium?"S:(ML;;NW;;;ME)":""), 1, out p, out n)) throw Error("owner SID ACL");
    return new SA { length=Marshal.SizeOf(typeof(SA)), descriptor=p, inherit=0 };
  }
  sealed class Identity : IDisposable {
    public IntPtr handle; public int pid; public string started, sid; public long ticks;
    public Identity(int id, uint extra=0, bool requireOwner=true) {
      pid=id; handle=OpenProcess(0x00101000 | extra, false, id);
      if (handle==IntPtr.Zero) throw Error("OpenProcess identity");
      try {
        long e,k,u; if (!GetProcessTimes(handle,out ticks,out e,out k,out u)) throw Error("GetProcessTimes");
        started=DateTime.FromFileTimeUtc(ticks).ToString("o");
        IntPtr token; if (!OpenProcessToken(handle,8,out token)) throw Error("OpenProcessToken");
        try { using(var identity=new WindowsIdentity(token)) sid=identity.User.Value; } finally { CloseHandle(token); }
        Require(!requireOwner || sid==SID,"owner SID mismatch");
      } catch { Dispose(); throw; }
    }
    public bool Exited { get { uint w=WaitForSingleObject(handle,0); Require(w==0 || w==258,"process wait failed"); return w==0; } }
    public int Parent() { PBI b; int n; Require(NtQueryInformationProcess(handle,0,out b,Marshal.SizeOf(typeof(PBI)),out n)==0,"parent identity unavailable"); return b.parent.ToInt32(); }
    public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
  }
  static Identity Caller(Identity bridge) {
    using(var shell=new Identity(bridge.Parent())) {
      Require(Process.GetProcessById(shell.pid).ProcessName.Equals("ai-cli-windowless-host",StringComparison.OrdinalIgnoreCase),"bridge host mismatch");
      var caller=new Identity(shell.Parent());
      if(caller.ticks>shell.ticks || shell.ticks>bridge.ticks || caller.Exited || shell.Exited) { caller.Dispose(); throw new InvalidOperationException("bridge ancestry changed"); }
      return caller;
    }
  }
  static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength=65536 }; }
  static Dictionary<string,object> Parse(string s) { return Serializer().Deserialize<Dictionary<string,object>>(s); }
  static string Json(object o) { return Serializer().Serialize(o); }
  static string S(Dictionary<string,object> d,string key) { object v; return d.TryGetValue(key,out v) && v!=null ? Convert.ToString(v,System.Globalization.CultureInfo.InvariantCulture) : ""; }
  static int N(Dictionary<string,object> d,string key) { return Convert.ToInt32(d[key]); }
  static string Secret() { byte[] b=new byte[32]; using(var r=RandomNumberGenerator.Create()) r.GetBytes(b); return Convert.ToBase64String(b); }
  static string ReadLine(Stream stream) { var b=new List<byte>(); for(int i=0;i<65536;i++) { int c=stream.ReadByte(); if(c<0) throw new EndOfStreamException(); if(c==10) return Encoding.UTF8.GetString(b.ToArray()); b.Add((byte)c); } throw new IOException("frame too large"); }
  static void WriteLine(Stream stream, object o) { byte[] b=Encoding.UTF8.GetBytes(Json(o)+"\n"); stream.Write(b,0,b.Length); stream.Flush(); }
  static void ProtectDirectory(string path) {
    Directory.CreateDirectory(path);
    Require((File.GetAttributes(path)&FileAttributes.ReparsePoint)==0,"registry must not be a reparse point");
    var sid=new SecurityIdentifier(SID); var acl=new DirectorySecurity();
    acl.SetOwner(sid); acl.SetAccessRuleProtection(true,false);
    acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    // Re-applying inheritable ACLs traverses retained children on Windows.
    // Validate the exact protected owner ACL; only initialization/repair writes it.
    var current=Directory.GetAccessControl(path,AccessControlSections.Owner|AccessControlSections.Access);
    var rules=current.GetAccessRules(true,true,typeof(SecurityIdentifier));
    var rule=rules.Count==1?rules[0] as FileSystemAccessRule:null;
    // Windows adds the auto-inherited control bit even on this protected DACL;
    // compare effective owner/rules, not that bookkeeping flag (D:PAI vs D:P).
    bool protectedOwner=current.AreAccessRulesProtected && current.GetOwner(typeof(SecurityIdentifier)).Equals(sid) && rule!=null && !rule.IsInherited && rule.IdentityReference.Equals(sid) && rule.AccessControlType==AccessControlType.Allow && rule.FileSystemRights==FileSystemRights.FullControl && rule.InheritanceFlags==(InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit) && rule.PropagationFlags==PropagationFlags.None;
    if(!protectedOwner) Directory.SetAccessControl(path,acl);
  }
  static bool Persist(string path, object value, bool createOnly=false, bool background=false) {
    string temp=path+"."+Guid.NewGuid().ToString()+".tmp";
    byte[] b=Encoding.UTF8.GetBytes(Json(value)+"\n");
    using(var f=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough)) { f.Write(b,0,b.Length); f.Flush(true); }
    // Same-volume write-through; exit publication never replaces a winner.
    // Reader handles can transiently deny replacement. Keep the same flushed
    // temp; never delete the old record. 750ms / 31 attempts is well below the
    // 15s pipe timer even for register's two writes under Gate.
    var clock=Stopwatch.StartNew();
    try { for(int attempt=1;;attempt++) {
      if(MoveFileExW(temp,path,createOnly?8u:9u)) return true;
      int error=Marshal.GetLastWin32Error();
      if(createOnly && (error==183 || error==80)) return false;
      long remaining=750-clock.ElapsedMilliseconds;
      if(background || (error!=5 && error!=32 && error!=33) || attempt>=31 || remaining<=0)
        throw new Win32Exception(error,"durable registry replace: win32="+error+" after "+attempt+" attempt(s)");
      int delay=attempt==1?1:attempt==2?2:attempt==3?5:attempt==4?10:25;
      Thread.Sleep((int)Math.Min(delay,remaining));
    }} finally { try { File.Delete(temp); } catch {} } // Only our GUID temp; never a proof.
  }
  sealed class Job {
    public Dictionary<string,object> record; public IntPtr handle; public Identity runner;
    public Dictionary<string,object> replies=new Dictionary<string,object>();
  }
  static readonly object Gate=new object();
  static Dictionary<string,Job> Jobs=new Dictionary<string,Job>();
  static string DirectoryPath, Epoch, Boot, ProofBoot; static bool Stopping, Retiring; static int Requests;
  static DateTime IdleSince; static IntPtr Mutex; static object BrokerOwner;
  public static string BootIdentity() {
    // TimeOfDayInformation is advisory: kernel time can be adjusted. Never use
    // this value alone to prove that processes from a previous boot are gone.
    IntPtr buffer=Marshal.AllocHGlobal(48);
    try { int returned; if(NtQuerySystemInformation(3,buffer,48,out returned)==0 && returned>=8) {
      long boot=Marshal.ReadInt64(buffer); if(boot>0) return "nt-time:"+boot;
    }} catch { } finally { Marshal.FreeHGlobal(buffer); }
    return Pid4BootIdentity();
  }
  public static string Pid4BootIdentity() {
    // PID 4 is the kernel System process, never reused during a boot. Its fixed
    // creation FILETIME avoids wall-clock/uptime-derived boot-time drift.
    IntPtr h=OpenProcess(0x1000,false,4); if(h==IntPtr.Zero) return "";
    try { long c,e,k,u; return GetProcessTimes(h,out c,out e,out k,out u) && c>0 ? c.ToString() : ""; }
    finally { CloseHandle(h); }
  }
  static bool PreviousBoot(Dictionary<string,object> old) {
    // Old numeric bootId was PID4 FILETIME. New source cannot be compared with it.
    string prior=old.ContainsKey("proofBootId")?S(old,"proofBootId"):S(old,"bootId"); long p,c;
    return Boot!="" && long.TryParse(prior,out p) && p>0 && long.TryParse(ProofBoot,out c) && c>0 && p!=c;
  }
  static object Recover(Dictionary<string,object> r) {
    string gen=S(r,"generation"),id=S(r,"jobId"),epoch=S(r,"targetEpoch"); Guid g;
    Require(Guid.TryParse(gen,out g) && Guid.TryParse(id,out g) && Guid.TryParse(epoch,out g),"invalid recovery identity");
    Job live;
    if(Jobs.TryGetValue(gen,out live)) {
      Require(S(live.record,"jobId")==id && S(live.record,"brokerEpoch")==epoch,"recovery identity mismatch");
      return Status(live);
    }
    string file=Path.Combine(DirectoryPath,gen+".json");
    // Missing/corrupt/unreadable records throw; none is an empty job.
    var old=Parse(File.ReadAllText(file));
    Require(N(old,"version")==1 && S(old,"jobId")==id && S(old,"generation")==gen && S(old,"brokerEpoch")==epoch,"recovery record mismatch");
    if(S(old,"phase")!="drained" && PreviousBoot(old)) {
      old["phase"]="drained";old["termination"]="reboot";
      old["terminalProof"]=new {runnerExited=true,activeProcesses=0,at=DateTime.UtcNow.ToString("o"),reason="reboot",observedBootId=Boot};
      var priorJob=new Job {record=old};PublishExit(priorJob);Save(priorJob);
      old=Parse(File.ReadAllText(file));
    }
    var proof=old.ContainsKey("terminalProof")?old["terminalProof"] as Dictionary<string,object>:null;DateTime at;
    if(S(old,"phase")!="drained" || proof==null || !proof.ContainsKey("runnerExited") || !(proof["runnerExited"] is bool) || !(bool)proof["runnerExited"] || !proof.ContainsKey("activeProcesses") || N(proof,"activeProcesses")!=0 || !DateTime.TryParse(S(proof,"at"),out at)) return new {state="unknown",reason="original broker handles unavailable"};
    if((DateTime.UtcNow-at.ToUniversalTime()).TotalDays>=30) {
      foreach(string key in new[]{"launchCapability","controlCapability","creatorPid","creatorStarted","prepareRequest","resultDirectory"}) old.Remove(key);
      Persist(file,old);
    }
    return new {state="drained",activeProcesses=0,runnerExited=true};
  }
  static void Save(Job j, bool background=false) { Persist(Path.Combine(DirectoryPath,S(j.record,"generation")+".json"),j.record,false,background); }
  static void PublishExit(Job j, bool background=false) {
    string directory=S(j.record,"resultDirectory"), termination=S(j.record,"termination");
    if(directory=="" || termination=="" || !Directory.Exists(directory)) return;
    string file=Path.Combine(directory,"exit.json");
    // This only runs after the original runner is gone or admission is closed.
    if(File.Exists(Path.Combine(directory,"stdin.tmp"))) File.Delete(Path.Combine(directory,"stdin.tmp"));
    if(File.Exists(file)) return; // Preserve natural result.
    string failureFile=Path.Combine(directory,"runner-error.json");
    Dictionary<string,object> failure=null;
    try {
      using(var input=new FileStream(failureFile,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
        Require(input.Length<=32768,"oversized runner failure record");
        var bytes=new byte[32769];int count=0,n;
        while(count<bytes.Length && (n=input.Read(bytes,count,bytes.Length-count))>0)count+=n;
        Require(count<=32768,"oversized runner failure record");
        failure=Parse(Encoding.UTF8.GetString(bytes,0,count));DateTime end;
        Require(failure!=null && N(failure,"exitCode")==1 && S(failure,"error").Length>0 && S(failure,"error").Length<=4096 && failure.ContainsKey("signal") && failure["signal"]==null && DateTime.TryParse(S(failure,"endTime"),out end) && failure.ContainsKey("killed") && failure["killed"] is bool && !(bool)failure["killed"] && failure.ContainsKey("timedOut") && failure["timedOut"] is bool && !(bool)failure["timedOut"],"invalid runner failure record");
      }
    } catch(FileNotFoundException) { failure=null; }
    catch(DirectoryNotFoundException) { failure=null; }
    catch(Exception e) {
      failure=null;
      // Diagnostic availability is unrelated to the kernel's drained proof.
      try { File.AppendAllText(Path.Combine(directory,"stderr.log"),"\nIgnored invalid runner-error.json: "+e.GetType().Name+"\n"); } catch {}
    }
    if(failure!=null) { Persist(file,failure,true,background); return; }
    var proof=(Dictionary<string,object>)Serializer().DeserializeObject(Json(j.record["terminalProof"]));
    // Runner has exited and ActiveProcesses is zero; no worker writes remain.
    if(Persist(file,new {exitCode=143,signal=(string)null,endTime=S(proof,"at"),killed=termination=="kill",timedOut=termination=="timeout"},true,background))
      File.AppendAllText(Path.Combine(directory,"stderr.log"),termination=="kill"?"\nProcess terminated by user\n":termination=="timeout"?"\nProcess timed out\n":"\nProcess stopped by system reboot\n");
  }
  static object Status(Job j, bool background=false) {
    string phase=S(j.record,"phase");
    if(phase=="preparing" && j.handle==IntPtr.Zero && S(j.record,"termination")!="") {
      // Admission is already closed in memory, even if its first Save failed.
      // Retry publication on idle ticks; diagnostic failure cannot reopen it.
      j.record["phase"]="drained"; j.record["terminalProof"]=new {runnerExited=true,activeProcesses=0,at=DateTime.UtcNow.ToString("o")};
      try { PublishExit(j,background); Save(j,background); } catch { j.record["phase"]="preparing"; j.record.Remove("terminalProof"); throw; }
      phase="drained";
    }
    if(phase=="drained") { PublishExit(j,background); if(j.handle!=IntPtr.Zero) { CloseHandle(j.handle); j.handle=IntPtr.Zero; } if(j.runner!=null) { j.runner.Dispose(); j.runner=null; } return new {state="drained", activeProcesses=0, runnerExited=true, termination=S(j.record,"termination")}; }
    if(j.handle==IntPtr.Zero || j.runner==null) return new {state="preparing"};
    Accounting a; if(!QueryInformationJobObject(j.handle,1,out a,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw Error("QueryInformationJobObject");
    bool exited=j.runner.Exited;
    if(exited && a.active==0) {
      var previous=S(j.record,"phase");
      j.record["phase"]="drained"; j.record["terminalProof"]=new {runnerExited=true,activeProcesses=0,at=DateTime.UtcNow.ToString("o")};
      // Publish the stopped runner's result before the proof becomes readable.
      // A failed proof write still leaves the job blocked and the handles open.
      try { PublishExit(j,background); Save(j,background); } catch { j.record["phase"]=previous; j.record.Remove("terminalProof"); throw; }
      CloseHandle(j.handle); j.handle=IntPtr.Zero; j.runner.Dispose(); j.runner=null;
      return new {state="drained",activeProcesses=0,runnerExited=true,termination=S(j.record,"termination")};
    }
    return new {state="active",activeProcesses=a.active,runnerExited=exited,termination=S(j.record,"termination")};
  }
  static NamedPipeServerStream Listener(string name,bool first) {
    var sa=Security(true); IntPtr h;
    try { h=CreateNamedPipeW(@"\\.\pipe\"+name,3u|0x40000000u|(first?0x00080000u:0u),8u,255,65536,65536,0,ref sa); }
    finally { LocalFree(sa.descriptor); }
    if(h==new IntPtr(-1)) throw Error("CreateNamedPipe FIRST_PIPE_INSTANCE / REJECT_REMOTE_CLIENTS");
    return new NamedPipeServerStream(PipeDirection.InOut,true,false,new SafePipeHandle(h,true));
  }
  static object Dispatch(Dictionary<string,object> r, Identity caller) {
    Require(!Stopping,"broker admission closed");
    string op=S(r,"op");
    if(op=="hello") return new {version=1,epoch=Epoch,pid=Process.GetCurrentProcess().Id, sid=SID};
    Require(N(r,"version")==1,"incompatible protocol");
    Require(S(r,"brokerEpoch")==Epoch,"broker epoch mismatch");
    if(op=="recover") return Recover(r);
    if(op=="retire") { Retiring=true; return new {retiring=true}; }
    string id=S(r,"jobId"), gen=S(r,"generation"), request=S(r,"requestId"); Guid parsed;
    Require(Guid.TryParse(id,out parsed) && Guid.TryParse(gen,out parsed) && Guid.TryParse(request,out parsed),"invalid request identity");
    Job j;
    if(op=="prepare") {
      Require(!Retiring,"broker retiring for protocol handoff; wait for owned jobs to drain");
      if(Jobs.TryGetValue(gen,out j) && S(j.record,"jobId")==id && S(j.record,"prepareRequest")==request && N(j.record,"creatorPid")==caller.pid && S(j.record,"creatorStarted")==caller.started)
        return new {version=1,jobId=id,generation=gen,brokerEpoch=Epoch};
      Require(!Jobs.ContainsKey(gen) && !File.Exists(Path.Combine(DirectoryPath,gen+".json")),"generation already exists; never recreate a lost job");
      j=new Job {record=new Dictionary<string,object>{{"version",1},{"jobId",id},{"generation",gen},{"brokerEpoch",Epoch},{"bootId",Boot},{"proofBootId",ProofBoot},{"phase","preparing"},{"broker",BrokerOwner},{"launchCapability",Secret()},{"controlCapability",Secret()},{"creatorPid",caller.pid},{"creatorStarted",caller.started}}};
      string resultDirectory=S(r,"resultDirectory");
      if(resultDirectory!="") { Require(Path.IsPathRooted(resultDirectory) && Path.GetFileName(resultDirectory)==id && Path.GetFileName(Path.GetDirectoryName(resultDirectory))=="jobs","invalid result directory"); j.record["resultDirectory"]=Path.GetFullPath(resultDirectory); }
      j.record["prepareRequest"]=request; Save(j); Jobs.Add(gen,j); return new {version=1,jobId=id,generation=gen,brokerEpoch=Epoch};
    }
    if(!Jobs.TryGetValue(gen,out j)) {
      string saved=Path.Combine(DirectoryPath,gen+".json");
      if(File.Exists(saved)) { var record=Parse(File.ReadAllText(saved)); if(S(record,"phase")=="drained" && S(record,"brokerEpoch")==Epoch) j=new Job {record=record}; }
    }
    Require(j!=null && S(j.record,"jobId")==id,"unknown containment generation");
    bool register=op=="register";
    Require(S(r,"capability")==S(j.record,register?"launchCapability":"controlCapability") && S(r,"capability").Length>=40,"unauthorized operation");
    string replayKey=caller.pid+"|"+caller.started+"|"+op+"|"+request;
    if(register) Require(S(j.record,"termination")=="","runner admission closed by termination");
    object cached; if(j.replies.TryGetValue(replayKey,out cached)) return cached;
    object result;
    if(register) {
      Require(S(j.record,"phase")=="preparing" && j.handle==IntPtr.Zero,"runner already assigned; READY is one-shot");
      // caller 是經 pipe bridge 驗證的父程序，只能把自己加入，沒有任意 PID 欄位。
      var runner=new Identity(caller.pid,0x101);
      try { Require(runner.started==caller.started && !runner.Exited,"runner identity changed"); } catch { runner.Dispose(); throw; }
      var sa=Security(); IntPtr job; int error;
      try { job=CreateJobObjectW(ref sa,"Local\\TkflycAiCliJob-"+gen); error=Marshal.GetLastWin32Error(); } finally { LocalFree(sa.descriptor); }
      if(job==IntPtr.Zero || error==183) { if(job!=IntPtr.Zero) CloseHandle(job); runner.Dispose(); throw new InvalidOperationException("CreateJobObject failed or name occupied"); }
      // 預設 limit flags=0：不開 breakaway，也不開 KILL_ON_JOB_CLOSE。
      j.handle=job; j.runner=runner;
      j.record["runnerPid"]=runner.pid; j.record["runnerStarted"]=runner.started;
      j.record["phase"]="assigned";
      try { Save(j); } // Persist intent before Assign; no READY on any failure.
      catch {
        // No Assign has happened. Disk still contains preparing. Release only
        // the newly opened handles; do not terminate this unassigned caller.
        CloseHandle(job); runner.Dispose(); j.handle=IntPtr.Zero; j.runner=null;
        j.record["phase"]="preparing"; j.record.Remove("runnerPid"); j.record.Remove("runnerStarted");
        throw;
      }
      if(!AssignProcessToJobObject(job,runner.handle)) throw Error("AssignProcessToJobObject");
      j.record["phase"]="released"; Save(j);
      result=new {ready=true,version=1,jobId=id,generation=gen,brokerEpoch=Epoch};
    } else if(op=="inspect") result=Status(j);
    else if(op=="terminate") {
      j.record["termination"]=S(r,"reason")=="timeout"?"timeout":"kill"; Save(j);
      if(j.handle!=IntPtr.Zero && !TerminateJobObject(j.handle,143)) throw Error("TerminateJobObject");
      result=Status(j);
    } else throw new InvalidOperationException("unsupported operation");
    if(j.replies.Count>=256) j.replies.Clear();
    j.replies[replayKey]=result; return result;
  }
  static void Serve(NamedPipeServerStream pipe) {
    using(pipe) using(var timeout=new Timer(delegate { try { pipe.Dispose(); } catch {} },null,15000,Timeout.Infinite)) {
      try {
        uint peer; if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out peer)) throw Error("client PID");
        using(var bridge=new Identity((int)peer)) using(var caller=Caller(bridge)) {
          Require(caller.ticks<=bridge.ticks && !caller.Exited,"caller identity changed");
          var r=Parse(ReadLine(pipe)); Require(S(r,"callerStarted")==caller.started && N(r,"callerPid")==caller.pid,"caller binding mismatch");
          object value; lock(Gate) { value=Dispatch(r,caller); IdleSince=DateTime.UtcNow; }
          WriteLine(pipe,new {ok=true,value=value});
        }
      } catch(Exception e) { try { WriteLine(pipe,new {ok=false,error=e.Message}); } catch {} }
      finally { lock(Gate) { Requests--; } }
    }
  }
  public static void Run(string name,string directory,int idleMs) {
    Require(name=="TkflycAiCliContainmentBroker" || name.StartsWith("TkflycAiCliContainmentBroker-test-"),"invalid broker name");
    var sa=Security(true); try { Mutex=CreateMutexW(ref sa,false,"Global\\"+name); } finally { LocalFree(sa.descriptor); }
    if(Mutex==IntPtr.Zero) throw Error("global mutex access");
    uint wait=WaitForSingleObject(Mutex,0);
    if(wait!=0 && wait!=128) { CloseHandle(Mutex); if(wait==258) return; throw Error("global mutex wait"); }
    // Run 所在專用執行緒持有 mutex，直到 listener 關閉、registry 落盤完成。
    NamedPipeServerStream listener=null;
    try {
      ProtectDirectory(directory); DirectoryPath=directory; Epoch=Guid.NewGuid().ToString(); Boot=BootIdentity(); ProofBoot=Pid4BootIdentity(); IdleSince=DateTime.UtcNow;
      // Historical generations are addressed directly by UUID in Recover().
      // Startup performs no registry enumeration, regardless of retained proofs.
      listener=Listener(name,true);
      using(var me=new Identity(Process.GetCurrentProcess().Id)) BrokerOwner=new {version=1,epoch=Epoch,bootId=Boot,pid=me.pid,started=me.started,sid=SID};
      // Constant work: preserve at most the immediately preceding epoch identity.
      // This migrates FIX2 records without embedding an owner; no history scan.
      string epochs=Path.Combine(directory,"epochs");ProtectDirectory(epochs);
      try {
        var prior=Parse(File.ReadAllText(Path.Combine(directory,"broker.json")));Guid priorEpoch;
        if(N(prior,"version")==1 && S(prior,"sid")==SID && Guid.TryParse(S(prior,"epoch"),out priorEpoch) && N(prior,"pid")>0 && S(prior,"started")!="") {
          string priorPath=Path.Combine(epochs,priorEpoch.ToString()+".json");if(!File.Exists(priorPath))Persist(priorPath,prior);
        }
      }catch{ /* Missing/corrupt prior identity is not a death proof. */ }
      Persist(Path.Combine(epochs,Epoch+".json"),BrokerOwner);
      Persist(Path.Combine(directory,"broker.json"),BrokerOwner);
      IdleSince=DateTime.UtcNow; // Startup scanning is not idle serving time.
      while(true) {
        var accepting=Task.Factory.FromAsync(listener.BeginWaitForConnection,listener.EndWaitForConnection,null);
        while(!accepting.Wait(250)) {
          string[] generations; lock(Gate) { generations=new List<string>(Jobs.Keys).ToArray(); }
          foreach(var gen in generations) {
            if(accepting.IsCompleted) break; // Serve an accepted request before more background I/O.
            lock(Gate) {
              Job pending;
              if(Jobs.TryGetValue(gen,out pending)) {
                try { if(S(pending.record,"phase")!="drained") Status(pending,true); if(S(pending.record,"phase")=="drained") Jobs.Remove(gen); }
                catch { /* Retain hold; a background write has no retry sleep. */ }
              }
            }
            Thread.Yield(); // No registry I/O for another job under this hold.
          }
          lock(Gate) {
            bool drained=true; foreach(var j in Jobs.Values) if(S(j.record,"phase")!="drained") drained=false;
            if(!accepting.IsCompleted && Requests==0 && drained && (Retiring || (DateTime.UtcNow-IdleSince).TotalMilliseconds>=idleMs)) { Stopping=true; return; }
          }
        }
        var connected=listener; listener=Listener(name,false); // 始終保留 listener，才把連線交出去。
        lock(Gate) { Requests++; IdleSince=DateTime.UtcNow; }
        ThreadPool.QueueUserWorkItem(delegate { Serve(connected); });
      }
    } finally { if(listener!=null) listener.Dispose(); ReleaseMutex(Mutex); CloseHandle(Mutex); }
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WaitNamedPipeW(string name,uint timeout);
  static IntPtr OpenPipe(string name) { return OpenPipe(name,null); }
  static IntPtr OpenPipe(string name, Identity server) {
    var clock=Stopwatch.StartNew();
    for(int attempt=0;;attempt++) {
      IntPtr raw=CreateFileW(@"\\.\pipe\"+name,0x00120183,0,IntPtr.Zero,3,0x00110000,IntPtr.Zero); // SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
      if(raw!=new IntPtr(-1)) return raw;
      int error=Marshal.GetLastWin32Error();
      if((error!=231 && error!=2) || attempt>=199 || clock.ElapsedMilliseconds>=5000) {
        if(error==2 || error==231 || error==121 || error==109) throw new IOException("containment-transport: pipe-connect ("+error+")");
        throw new Win32Exception(error,"connect containment pipe");
      }
      // No request bytes have been sent. Availability is advisory: another
      // client can win the next instance, so retry CreateFile within this budget.
      uint remaining=(uint)Math.Max(1,5000-clock.ElapsedMilliseconds);
      if(error==2) { if(server!=null && server.Exited) throw new IOException("containment-transport: broker exited during pipe-connect"); Thread.Sleep((int)Math.Min(25u,remaining)); continue; }
      if(!WaitNamedPipeW(@"\\.\pipe\"+name,Math.Min(100u,remaining))) {
        int waitError=Marshal.GetLastWin32Error();
        if(waitError!=121 && waitError!=231 && waitError!=2) {
          throw new Win32Exception(waitError,"wait containment pipe");
        }
      }
    }
  }
  public static string Call(string name,string registry,string payload) {
    var expected=Parse(File.ReadAllText(Path.Combine(registry,"broker.json")));
    using(var server=new Identity(N(expected,"pid"))) {
      Require(server.started==S(expected,"started") && server.sid==S(expected,"sid") && !server.Exited,"broker identity lost");
      // 不要求 GENERIC_WRITE（含 FILE_CREATE_PIPE_INSTANCE），僅具體讀／寫權限。
      IntPtr raw=OpenPipe(name,server);
      using(var handle=new SafeFileHandle(raw,true)) {
        uint actual; if(!GetNamedPipeServerProcessId(handle,out actual)) throw Error("server PID");
        Require(actual==server.pid && !server.Exited,"pipe server identity mismatch");
        var r=Parse(payload);
        Require(S(r,"brokerEpoch")==S(expected,"epoch"),"registry epoch changed");
        using(var self=new Identity(Process.GetCurrentProcess().Id)) using(var parent=Caller(self)) {
          Require(parent.ticks<=self.ticks && !parent.Exited,"bridge parent changed"); r["callerPid"]=parent.pid; r["callerStarted"]=parent.started;
          using(var stream=new FileStream(handle,FileAccess.ReadWrite,4096,false)) {
            try { WriteLine(stream,r); return ReadLine(stream); }
            catch(IOException e) { throw new IOException("containment-transport: pipe-I/O: "+e.Message,e); }
          }
        }
      }
    }
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetConsoleMode(IntPtr handle,out uint mode);
  public static string ConsoleActor(int pid) {
    using(var self=new Identity(Process.GetCurrentProcess().Id)) using(var actor=Caller(self)) {
      Require(actor.pid==pid && !actor.Exited,"console actor changed");
      FreeConsole(); // PowerShell may attach its own console during host initialization.
      if(!AttachConsole((uint)pid))throw Error("actual console attachment required: "+Marshal.GetLastWin32Error());
      try {
        IntPtr input=CreateFileW("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero),output=CreateFileW("CONOUT$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
        try { uint mode;Require(input!=new IntPtr(-1) && output!=new IntPtr(-1) && GetConsoleMode(input,out mode) && GetConsoleMode(output,out mode),"actual console handles required"); }
        finally {if(input!=new IntPtr(-1))CloseHandle(input);if(output!=new IntPtr(-1))CloseHandle(output);}
        return Json(new {pid=actor.pid,started=actor.started,sid=actor.sid,sessionId=Process.GetProcessById(pid).SessionId});
      }finally{FreeConsole();}
    }
  }
  static bool TryStarted(string value,out DateTimeOffset result) {
    result=default(DateTimeOffset);
    // WMI DMTF: yyyyMMddHHmmss.ffffff+mmm (offset is minutes).
    if(value.Length==25 && value[14]=='.' && (value[21]=='+' || value[21]=='-')) {
      try {
        var date=DateTime.ParseExact(value.Substring(0,14),"yyyyMMddHHmmss",System.Globalization.CultureInfo.InvariantCulture);
        int micros=int.Parse(value.Substring(15,6)),minutes=int.Parse(value.Substring(22,3));
        result=new DateTimeOffset(date.AddTicks(micros*10L),TimeSpan.FromMinutes(value[21]=='-'?-minutes:minutes));return true;
      }catch{return false;}
    }
    if(!System.Text.RegularExpressions.Regex.IsMatch(value,@"(?:[zZ]|[+-]\d{2}:\d{2})$"))return false;
    return DateTimeOffset.TryParse(value,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.AssumeUniversal,out result);
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint size,usage,pid; public IntPtr heap; public uint module,threads,parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string image;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref ProcessEntry entry);
  static Dictionary<int,int> ProcessParents() {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))throw new Win32Exception();
    try {var parents=new Dictionary<int,int>();var entry=new ProcessEntry();entry.size=(uint)Marshal.SizeOf(entry);
      if(!Process32FirstW(snapshot,ref entry))throw new Win32Exception();
      do{parents[(int)entry.pid]=(int)entry.parent;}while(Process32NextW(snapshot,ref entry));
      if(Marshal.GetLastWin32Error()!=18)throw new Win32Exception();return parents;
    }finally{CloseHandle(snapshot);}
  }
  static bool AncestryTail(long parentTicks,long childTicks,string sid) { return parentTicks>childTicks || sid!=SID; }
  static bool InaccessibleAncestorTail(int depth,int error) { return depth>0 && (error==5 || error==87); }
  public static string WorkerAncestry(int pid,string targetsJson) {
    Dictionary<int,int> parents;try{parents=ProcessParents();}catch{return "unknown";}
    return WorkerAncestrySnapshot(pid,targetsJson,parents);
  }
  static string WorkerAncestrySnapshot(int pid,string targetsJson,Dictionary<int,int> parents) {
    var targets=Serializer().Deserialize<List<Dictionary<string,object>>>(targetsJson);
    var seen=new HashSet<int>(); long childTicks=long.MaxValue;
    for(int depth=0;pid>0 && depth<64 && seen.Add(pid);depth++) {
      // Known worker identities are checked before permitting an inaccessible tail.
      foreach(var target in targets)if(N(target,"pid")==pid) {
        string state=S(Parse(ProcessEvidence(pid,S(target,"started"))),"state");
        if(state=="alive")return "worker";
        if(state=="unknown")return "unknown";
      }
      try { using(var p=new Identity(pid,0,false)) {
        if(AncestryTail(p.ticks,childTicks,p.sid))return "none";
        childTicks=p.ticks;int parent;if(!parents.TryGetValue(pid,out parent))return "none";pid=parent;
      }}catch(Win32Exception e){
        if(!InaccessibleAncestorTail(depth,e.NativeErrorCode))return "unknown";
        // Inaccessible intermediates do not hide a known worker farther up.
        // Keep the last comparable child time; skip only this time/SID query.
        int parent;if(!parents.TryGetValue(pid,out parent))return "none";pid=parent;
      }
      catch{return "unknown";}
    }
    return pid<=0?"none":"unknown";
  }
  // SYSTEM_PROCESS_INFORMATION prefix (Vista+), naturally aligned on x86/x64.
  // Layout: phnt/ntexapi.h; query needs no per-process handle or token access.
  [StructLayout(LayoutKind.Sequential)] struct SystemProcessPrefix {
    public uint next,threads;public ulong working;public uint faults,peakThreads;
    public ulong cycles;public long created,user,kernel;public ushort nameLength,nameMax;
    public IntPtr name;public int priority;public IntPtr pid,parent;
  }
  static long SystemStarted(int pid) {
    for(int size=65536;size<=67108864;) {
      IntPtr buffer=Marshal.AllocHGlobal(size);
      try {
        int returned,status=NtQuerySystemInformation(5,buffer,size,out returned);
        if(status==unchecked((int)0xC0000004)){size=Math.Max(size*2,returned);continue;}
        if(status!=0 || returned<=0 || returned>size)return 0;
        int header=Marshal.SizeOf(typeof(SystemProcessPrefix)),offset=0;
        while(offset<=returned-header) {
          var row=(SystemProcessPrefix)Marshal.PtrToStructure(IntPtr.Add(buffer,offset),typeof(SystemProcessPrefix));
          if(row.pid.ToInt64()==pid)return row.created>0?row.created:0;
          if(row.next==0)return 0;
          if(row.next<header || row.next>returned-offset)return 0;
          offset+=(int)row.next;
        }
        return 0;
      }finally{Marshal.FreeHGlobal(buffer);}
    }
    return 0;
  }
  static string UnopenedEvidence(int pid,string started,string error) {
    long ticks=0;try{ticks=SystemStarted(pid);}catch{}
    DateTimeOffset expected;bool different=false;
    try{different=ticks>0 && TryStarted(started,out expected) && Math.Abs((new DateTimeOffset(DateTime.FromFileTimeUtc(ticks))-expected).TotalSeconds)>=1;}catch{}
    // A missing row or same/near timestamp proves nothing about this owner.
    return Json(new {state=different?"dead":"unknown",pid=pid,started=started,observedTicks=ticks.ToString(),reason=different?"system_identity_changed":"identity_unavailable",error=error,at=DateTime.UtcNow.ToString("o")});
  }
  public static string ProcessEvidence(int pid,string started) {
    Require(pid>0 && started!="","exact process identity required");
    try { using(var p=new Identity(pid)) {
      // Exact native and known microsecond-normalized identities are comparable.
      // Millisecond/CIM or close-but-different tokens cannot prove PID reuse.
      bool same=p.started==started || DateTime.FromFileTimeUtc(p.ticks-p.ticks%10).ToString("o")==started;
      DateTimeOffset expected; bool parsed=TryStarted(started,out expected);
      bool different=parsed && Math.Abs((new DateTimeOffset(DateTime.FromFileTimeUtc(p.ticks))-expected).TotalSeconds)>=1;
      string state=p.Exited || different?"dead":same?"alive":"unknown";
      return Json(new {state=state,pid=pid,started=started,observedStarted=p.started,reason=p.Exited?"signaled":different?"identity_changed":same?"running":"time_precision_unknown",at=DateTime.UtcNow.ToString("o")});
    }}catch(Win32Exception e) {
      if(e.NativeErrorCode==87)return Json(new {state="dead",pid=pid,started=started,reason="pid_absent",error=e.NativeErrorCode,at=DateTime.UtcNow.ToString("o")});
      return UnopenedEvidence(pid,started,e.Message);
    }catch(Exception e){return UnopenedEvidence(pid,started,e.Message);}
  }
  public static void StopFixture(int pid,string started) {
    using(var process=new Identity(pid,1)) { Require(process.started==started,"fixture identity changed"); if(!process.Exited && !TerminateProcess(process.handle,99)) throw Error("fixture stop"); }
  }
  public static void HoldMutexFixture(string name,string ready,int milliseconds) {
    var sa=Security(true); IntPtr h; try { h=CreateMutexW(ref sa,false,"Global\\"+name); } finally { LocalFree(sa.descriptor); }
    Require(h!=IntPtr.Zero && WaitForSingleObject(h,0)==0,"fixture mutex unavailable");
    try { File.WriteAllText(ready,"ready"); Thread.Sleep(milliseconds); } finally { ReleaseMutex(h); CloseHandle(h); }
  }
  public static void HoldPipeFixture(string name,string ready,int milliseconds) {
    using(var pipe=Listener(name,true)) { File.WriteAllText(ready,"ready"); Thread.Sleep(milliseconds); }
  }
  public static string InspectFixture(int pid) {
    using(var p=new Identity(pid)) return Json(new {pid=p.pid,started=p.started,exited=p.Exited,parent=p.Parent(),sid=p.sid});
  }
  public static string Identities(int[] pids) {
    var result=new List<object>();
    foreach(int pid in pids) { try { using(var p=new Identity(pid)) if(!p.Exited) result.Add(new {pid=pid,started=DateTime.FromFileTimeUtc(p.ticks-p.ticks%10).ToString("o"),name=Process.GetProcessById(pid).ProcessName}); } catch {} }
    return Json(result);
  }
  public static string VisibleWindows(int[] roots) {
    var result=new List<object>(); var known=new HashSet<int>(roots);
    EnumWindows(delegate(IntPtr window,IntPtr context) {
      if(!IsWindowVisible(window)) return true; uint id; GetWindowThreadProcessId(window,out id);
      int current=(int)id; var seen=new HashSet<int>();
      while(current>0 && seen.Add(current)) {
        if(known.Contains(current)) { result.Add(new {pid=id,window=window.ToInt64()}); break; }
        try { using(var p=new Identity(current)) current=p.Parent(); } catch { break; }
      }
      return true;
    },IntPtr.Zero);
    return Json(result);
  }
  public static string SecurityFixture(string name,string directory) {
    IntPtr h=CreateFileW(@"\\.\pipe\"+name,0x00020000,0,IntPtr.Zero,3,0,IntPtr.Zero);
    Require(h!=new IntPtr(-1),"pipe ACL open");
    try {
      IntPtr owner,group,dacl,sacl,descriptor;
      Require(GetSecurityInfo(h,1,0x15,out owner,out group,out dacl,out sacl,out descriptor)==0,"pipe ACL query");
      try {
        byte[] bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);
        var pipe=new RawSecurityDescriptor(bytes,0);
        using(var mutex=System.Threading.Mutex.OpenExisting("Global\\"+name,MutexRights.ReadPermissions)) {
          IntPtr mo,mg,md,ms,mr;
          Require(GetSecurityInfo(mutex.SafeWaitHandle.DangerousGetHandle(),6,0x15,out mo,out mg,out md,out ms,out mr)==0,"mutex security query");
          try { byte[] mb=new byte[GetSecurityDescriptorLength(mr)];Marshal.Copy(mr,mb,0,mb.Length);
            return Json(new {sid=SID,pipe=SecurityText(descriptor),mutex=SecurityText(mr),directory=Directory.GetAccessControl(directory).GetSecurityDescriptorSddlForm(AccessControlSections.All)});
          }finally{LocalFree(mr);}
        }
      } finally { LocalFree(descriptor); }
    } finally { CloseHandle(h); }
  }
}
`;
