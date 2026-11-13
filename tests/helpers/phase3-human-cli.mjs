// Faults are confined to this harmless test entrypoint, never production flags.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {WinJobClient} from '../../dist/core/win-job-client.js';
const [mode,scope,runId,signal]=process.argv.slice(2);let ancestryFile;
if(mode==='active'||mode==='recovered'){
 const inspect=WinJobClient.prototype.inspect;
 WinJobClient.prototype.inspect=async function(ref){
  if(mode==='active'||fs.existsSync(signal))return {state:'active',activeProcesses:1,runnerExited:false};
  return inspect.call(this,ref);
 };
}
if(mode==='desc-query-fail'){
 const cp=(await import('node:child_process')).default;
 cp.execFile=function(...args){args.at(-1)(new Error('injected process table failure'));};syncBuiltinESMExports();
}
if(mode==='fsync'){
 const open=fs.openSync,close=fs.closeSync,write=fs.writeSync,sync=fs.fsyncSync;
 const journals=new Set();let pending=false,failed=false;
 fs.openSync=function(path,...args){const fd=open(path,...args);if(String(path).endsWith('journal.jsonl'))journals.add(fd);return fd;};
 fs.writeSync=function(fd,data,...args){if(journals.has(fd)&&String(data).includes('"type":"containment_lost_confirmed"'))pending=true;return write(fd,data,...args);};
 fs.fsyncSync=function(fd){if(pending&&journals.has(fd)&&!failed){failed=true;throw Error('injected confirmation fsync failure');}return sync(fd);};
 fs.closeSync=function(fd){journals.delete(fd);return close(fd);};syncBuiltinESMExports();
}
if(mode==='no-kill'){
 const {FileJobExecutor}=await import('../../dist/ai-cli_kernel/executor.js');
 FileJobExecutor.prototype.kill=async()=>{console.log('KILL_ATTEMPT');};
}
if(mode==='ancestry'){
 const {powershell,nativeScript}=await import('../../dist/core/win-job-broker.js');
 const {join}=await import('node:path');const {randomUUID}=await import('node:crypto');
 const id=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${process.ppid})`)));
 const jobId=randomUUID(),dir=join(process.env.AI_CLI_STATE_DIR,'jobs',jobId);fs.mkdirSync(dir,{recursive:true});
 ancestryFile=join(dir,'bootstrap.json');fs.writeFileSync(ancestryFile,JSON.stringify({version:1,jobId,pid:id.pid,runner:id,source:'cli',startTime:new Date().toISOString()}));
 process.env.AI_CLI_WORKER='';
}
if(mode==='worker')process.env.AI_CLI_WORKER='1';
console.log(`ACTUAL_TTY ${process.stdin.isTTY===true} ${process.stdout.isTTY===true}`);
const {runKernelCli}=await import('../../dist/ai-cli_kernel/cli.js');
try{
 if(mode==='stdout-only'){
  const {spawn}=await import('node:child_process');const fd=fs.openSync(signal,'w');
  try{const child=spawn(process.execPath,[process.argv[1],'good',scope,runId,signal],{windowsHide:true,stdio:['inherit',fd,'inherit']});process.exitCode=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});}finally{fs.closeSync(fd);}
 }else process.exitCode=await runKernelCli([scope,runId,'--confirm-containment-lost'],{stdout:s=>process.stdout.write(s),stderr:s=>process.stderr.write(s)});
}finally{if(ancestryFile)fs.renameSync(ancestryFile,ancestryFile+'.fixture-ended');}
