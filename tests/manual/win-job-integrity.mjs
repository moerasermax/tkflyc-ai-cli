/** Run manually from a normal terminal; never part of npm test.
 * normal: node tests/manual/win-job-integrity.mjs
 * elevated: node tests/manual/win-job-integrity.mjs --serve <shared-directory>
 * normal: node tests/manual/win-job-integrity.mjs --connect <same-directory>
 * Both terminals must use the same Windows user. No elevation is requested here.
 */
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobStore} from '../../dist/core/job-store.js';
import {WinJobClient} from '../../dist/core/win-job-client.js';
import {readBroker} from '../../dist/core/containment-store.js';
import {powershell,nativeScript} from '../../dist/core/win-job-broker.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let failed=0;const check=(n,b)=>{console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;};
if(process.platform!=='win32')throw Error('Windows only');
const [mode,arg]=process.argv.slice(2);if(mode&&!['--serve','--connect'].includes(mode))throw Error('Use no args, --serve directory, or --connect directory');
mkdirSync('.tmp',{recursive:true});const dir=arg?resolve(arg):mkdtempSync(resolve('.tmp/manual-integrity-'));mkdirSync(dir,{recursive:true});
const config=mode==='--connect'?JSON.parse(readFileSync(join(dir,'config.json'),'utf8')):{name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'registry'),idleMs:60000};
if(mode!=='--connect')writeFileSync(join(dir,'config.json'),JSON.stringify(config));
process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(config);process.env.AI_CLI_STATE_DIR=join(dir,'state');
const client=new WinJobClient(config);let broker,store,ref;
try{
 const admin=(await powershell('[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'))==='True';
 check(mode==='--serve'?'server terminal is elevated':'client terminal is not elevated',mode==='--serve'?admin:!admin);
 if(failed)throw Error('Use the requested terminal integrity level');
 if(mode==='--connect'){const expected=readBroker(config);check('elevated broker already exists',!!expected);if(!expected)throw Error('Start --serve first');check('normal client reaches existing elevated epoch',(await client.hello()).epoch===expected.epoch);}
 else{await client.ensure();broker=readBroker(config);check('broker starts and boot identity is readable',!!broker&&typeof broker.bootId==='string');console.log('bootId:',broker.bootId||'(unavailable; reboot proof disabled)');}
 if(mode==='--serve'){
  console.log(`READY: in a normal terminal run node tests/manual/win-job-integrity.mjs --connect "${dir}" (within 10 minutes)`);
  const end=Date.now()+600000;while(!existsSync(join(dir,'done'))&&Date.now()<end){await client.hello();await sleep(5000);}
  check('normal client completed matrix',existsSync(join(dir,'done'))&&readFileSync(join(dir,'done'),'utf8')==='PASS');
 }else{
  store=new JobStore(process.env.AI_CLI_STATE_DIR,'cli');await store.ready;
  const job=await store.start({cliPath:process.execPath,args:['-e','console.log("integrity stub")'],cwd:dir,agent:'grok',resolvedModel:'stub',prompt:'manual harmless fixture'});
  const end=Date.now()+60000;while(!existsSync(join(job.directory,'exit.json'))&&Date.now()<end)await sleep(100);
  const meta=JSON.parse(readFileSync(join(job.directory,'meta.json'),'utf8'));ref=meta.containment;
  let status;do{status=await client.inspect(ref);if(status.state==='drained')break;await sleep(200);}while(Date.now()<end);
  check('stub completed and generation drained',JSON.parse(readFileSync(join(job.directory,'exit.json'),'utf8')).exitCode===0&&status.state==='drained');
  if(mode==='--connect')writeFileSync(join(dir,'done'),failed?'FAIL':'PASS');
 }
}catch(e){check(e.message,false);}
finally{
 if(ref)await client.terminate(ref).catch(()=>{});store?.dispose();
 // Only the terminal that created the broker may stop its exact identity.
 if(broker){await powershell(nativeScript(`[AiCliContainment]::StopFixture(${broker.pid},'${broker.started}')`)).catch(()=>{});check('owned manual broker identity exited',JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${broker.pid},'${broker.started}')`))).state==='dead');}
}
console.log(`Manual integrity: ${failed} failed`);process.exitCode=failed?1:0;
