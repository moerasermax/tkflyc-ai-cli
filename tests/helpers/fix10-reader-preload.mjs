/** Real reader handles only; installed solely in the FIX10 job runner. */
import fs from 'node:fs';
import {join} from 'node:path';
import {WinJobClient} from '../../dist/core/win-job-client.js';
if(process.argv[1]?.endsWith('job-runner.js') && process.env.FIX10_READER){
 const original=WinJobClient.prototype.register;
 WinJobClient.prototype.register=async function(ref){
  const path=join(this.config.directory,ref.generation+'.json'),fd=fs.openSync(path,'r'),began=performance.now();
  let closed=false,seen=false,timer;const close=()=>{if(!closed){closed=true;fs.closeSync(fd);}};
  const poll=setInterval(()=>{if(!seen&&fs.readdirSync(this.config.directory).some(n=>n.startsWith(ref.generation+'.json.')&&n.endsWith('.tmp'))){seen=true;if(process.env.FIX10_READER==='short')timer=setTimeout(close,300);}},5);
  const safety=setTimeout(close,15000);
  try{return await original.call(this,ref);}
  finally{clearInterval(poll);clearTimeout(timer);clearTimeout(safety);close();fs.writeFileSync(join(process.argv[2],'fix10-reader.json'),JSON.stringify({seen,ms:performance.now()-began}));}
 };
}
