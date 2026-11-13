import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {WinJobClient} from '../../dist/core/win-job-client.js';
const spawn=cp.spawn;
cp.spawn=function(command,args,options){
 const child=spawn(command,args,{...options,windowsHide:true});
 if(args?.some(arg=>arg.includes('PHASE3_PIPE_LATE'))){
  const emit=child.emit;child.emit=function(event,...values){if(event==='close'){setTimeout(()=>emit.call(this,event,...values),2500);return true;}return emit.call(this,event,...values);};
  child.once('exit',()=>setTimeout(()=>{const directory=process.argv[2],meta=JSON.parse(readFileSync(join(directory,'meta.json'),'utf8'));writeFileSync(join(directory,'kill.json'),JSON.stringify({runner:meta.runner}));writeFileSync(process.env.PHASE3_PIPE_LOG+'.late','after native exit');},800));
 }
 return child;
};syncBuiltinESMExports();
WinJobClient.prototype.terminate=async function(){appendFileSync(process.env.PHASE3_PIPE_LOG,'terminate\n');return {state:'unknown'};};
