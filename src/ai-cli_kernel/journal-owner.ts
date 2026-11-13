/** Synchronous appenders use a short hidden helper for native process evidence.
 * Detached bridges retain the requester handle and a private descendant Job;
 * requester exit or the native deadline closes that owned tree.
 */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {nativeScript,powershell} from '../core/win-job-broker.js';
import {lookupIdentities} from '../core/live-jobs.js';
export interface WriterIdentity {pid:number;started:string}
let own:WriterIdentity|undefined;
const helper=fileURLToPath(import.meta.url);
function query(mode:'identity'|'evidence',pid:number,started='',budget=15000):any {
  return JSON.parse(execFileSync(process.execPath,[helper,mode,String(pid),started],{windowsHide:true,timeout:Math.min(15000,budget),killSignal:'SIGKILL',encoding:'utf8',stdio:['ignore','pipe','pipe']}));
}
export function writerIdentity():WriterIdentity {
  return own??=query('identity',process.pid);
}
export function writerDead(identity:WriterIdentity,budget=15000):boolean {
  if(!Number.isSafeInteger(identity?.pid)||identity.pid<=0||typeof identity.started!=='string'||!identity.started)return false;
  if(identity.pid===process.pid&&identity.started===writerIdentity().started)return false;
  try{return query('evidence',identity.pid,identity.started,budget).state==='dead';}catch{return false;}
}
if(process.argv[1]&&resolve(process.argv[1])===helper) {
  const [mode,raw,started='']=process.argv.slice(2),pid=Number(raw);
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('invalid process identity');
  let result:unknown;
  if(process.platform==='win32') {
    const expression=mode==='identity'?`[AiCliContainment]::InspectFixture(${pid})`:`[AiCliContainment]::ProcessEvidence(${pid},'${started.replaceAll("'","''")}')`;
    result=JSON.parse(await powershell(nativeScript(expression)));
  }else {
    const identity=(await lookupIdentities([pid])).get(pid);
    if(mode==='identity'){if(!identity?.started)throw Error('journal owner identity unavailable');result=identity;}
    else {
      let absent=false;try{process.kill(pid,0);}catch(e){absent=(e as NodeJS.ErrnoException).code==='ESRCH';}
      result={state:absent?'dead':identity?.started===started?'alive':'unknown'};
    }
  }
  process.stdout.write(JSON.stringify(result));
}
