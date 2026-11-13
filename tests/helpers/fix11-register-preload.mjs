/** Rendezvous only: the parent holds the real generation reader across BOTH RPCs. */
import fs from 'node:fs';
import {join} from 'node:path';
import {WinJobClient} from '../../dist/core/win-job-client.js';
if(process.argv[1]?.endsWith('job-runner.js')&&process.env.FIX11_READER){
 const dir=process.env.FIX11_READER,register=WinJobClient.prototype.register,terminate=WinJobClient.prototype.terminate;
 WinJobClient.prototype.register=async function(ref){
  fs.writeFileSync(join(dir,'register'),JSON.stringify(ref));
  const end=Date.now()+20000;while(!fs.existsSync(join(dir,'go'))){if(Date.now()>end)throw Error('reader rendezvous deadline');await new Promise(r=>setTimeout(r,10));}
  return register.call(this,ref);
 };
 let terminated=0;
 WinJobClient.prototype.terminate=async function(...args){const attempt=++terminated;try{return await terminate.apply(this,args);}finally{fs.writeFileSync(join(dir,'terminated-'+attempt),'done');}};
}
