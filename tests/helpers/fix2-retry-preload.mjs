// Only the explicitly named harmless fixture has a deliberately unresponsive kill.
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
import {WinJobClient} from '../../dist/core/win-job-client.js';
const spawn=cp.spawn;
cp.spawn=function(command,args,options){
  const child=spawn(command,args,{...options,windowsHide:true});
  if(args?.some(arg=>arg.includes('FIX2_RETRY_WORKER') && !arg.includes('KILL_WORKS')))child.kill=()=>false;
  return child;
};
syncBuiltinESMExports();
WinJobClient.prototype.terminate=async function(){
  if(process.env.FIX2_RETRY_DELAY)await new Promise(r=>setTimeout(r,Number(process.env.FIX2_RETRY_DELAY)));
  appendFileSync(process.env.FIX2_RETRY_LOG,JSON.stringify({at:Date.now(),pid:process.pid})+'\n');
  return {state:'unknown',reason:'injected unreachable broker'};
};
