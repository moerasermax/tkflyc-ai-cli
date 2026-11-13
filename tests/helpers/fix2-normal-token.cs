using System; using System.Text; using System.Runtime.InteropServices;
public static class NormalTokenFixture {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,cx,cy,xc,yc,fill,flags; public short show,extra; public IntPtr extraData,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferCreateLevel(uint scope,uint level,uint flags,out IntPtr handle,IntPtr reserved);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferComputeTokenFromLevel(IntPtr level,IntPtr token,out IntPtr result,uint flags,IntPtr reserved);
 [DllImport("advapi32.dll")] static extern bool SaferCloseLevel(IntPtr level);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int length,out int returned);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("advapi32.dll",EntryPoint="GetTokenInformation",SetLastError=true)] static extern bool GetLinkedToken(IntPtr token,int kind,out IntPtr value,int length,out int returned);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint logon,string app,StringBuilder command,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int impersonation,int type,out IntPtr copy);
 static IntPtr DesktopToken() {
  // Read-only lookup: never signal or modify these pre-existing processes.
  var me=System.Diagnostics.Process.GetCurrentProcess();string sid=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
  foreach(var process in System.Diagnostics.Process.GetProcessesByName("explorer"))using(process){
   if(process.SessionId!=me.SessionId)continue;
   IntPtr handle=OpenProcess(0x1000,false,process.Id),token=IntPtr.Zero;
   if(handle==IntPtr.Zero)continue;
   try {if(!OpenProcessToken(handle,0xb,out token))continue;int elevated,returned;
    using(var identity=new System.Security.Principal.WindowsIdentity(token))if(identity.User.Value!=sid)continue;
    if(!GetTokenInformation(token,20,out elevated,4,out returned)||elevated!=0)continue;
    IntPtr copy;if(DuplicateTokenEx(token,0x02000000,IntPtr.Zero,2,1,out copy))return copy;
   }finally{if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(handle);}
  }
  throw new Exception("no same-SID same-session non-elevated desktop token available");
 }
 public static string Start(string exe,string args,string cwd) {
  IntPtr level=IntPtr.Zero,token=IntPtr.Zero;
  try {
   token=DesktopToken();
   int elevated,returned;
   if(!GetTokenInformation(token,20,out elevated,4,out returned)||elevated!=0)throw new Exception("desktop fixture token is elevated");
   SI si=new SI();si.cb=Marshal.SizeOf(si);PI pi;
   if(!CreateProcessAsUserW(token,exe,new StringBuilder("\""+exe+"\" "+args),IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,cwd,ref si,out pi))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"CreateProcessAsUser desktop token");
   try {long c,e,k,u;if(!GetProcessTimes(pi.process,out c,out e,out k,out u))throw new Exception("identity unavailable");return "{\"pid\":"+pi.pid+",\"started\":\""+DateTime.FromFileTimeUtc(c).ToString("o")+"\",\"elevated\":"+elevated+"}";}
   finally {CloseHandle(pi.thread);CloseHandle(pi.process);}
  }finally{if(token!=IntPtr.Zero)CloseHandle(token);if(level!=IntPtr.Zero)SaferCloseLevel(level);}
 }
}
