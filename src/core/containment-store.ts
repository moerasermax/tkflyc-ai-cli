/** 獨立於可回收 log 的證明庫；唯一 writer 是持有原始 handle 的 broker。 */
import { existsSync, statSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { brokerConfig, sameContainment, type BrokerConfig, type BrokerIdentity, type ContainmentRecord, type ContainmentRef } from './win-job-protocol.js';

export function readBroker(config: BrokerConfig = brokerConfig()): BrokerIdentity | undefined {
  try { const v = JSON.parse(readFileSync(join(config.directory, 'broker.json'), 'utf8')); return v.version === 1 && typeof v.epoch === 'string' && Number.isSafeInteger(v.pid) && typeof v.started === 'string' && typeof v.sid === 'string' ? v : undefined; } catch { return undefined; }
}
/** Immutable epoch identity, including a pre-upgrade broker.json captured at handoff. */
export function readBrokerEpoch(epoch:string,config:BrokerConfig=brokerConfig()):BrokerIdentity|undefined {
  if(!/^[0-9a-f-]{36}$/.test(epoch))return undefined;
  try{const v=JSON.parse(readFileSync(join(config.directory,'epochs',epoch+'.json'),'utf8'));return v.version===1&&v.epoch===epoch&&Number.isSafeInteger(v.pid)&&typeof v.started==='string'&&typeof v.sid==='string'?v:undefined;}catch{return undefined;}
}
export function readContainment(ref: ContainmentRef, config: BrokerConfig = brokerConfig()): ContainmentRecord | undefined {
  if (!/^[0-9a-f-]{36}$/.test(ref.generation)) return undefined;
  try { const v = JSON.parse(readFileSync(join(config.directory, ref.generation + '.json'), 'utf8')); return sameContainment(v, ref) ? v : undefined; } catch { return undefined; }
}
export function drainedProof(ref: ContainmentRef, config: BrokerConfig = brokerConfig()): boolean {
  const v = readContainment(ref, config);
  return v?.phase === 'drained' && v.terminalProof?.runnerExited === true && v.terminalProof.activeProcesses === 0 && Number.isFinite(Date.parse(v.terminalProof.at));
}
/** 每個 stateDir 的不可變索引；log GC 之後仍可找到同 generation 的證明。 */
export function saveContainmentRef(stateDir: string, ref: ContainmentRef): void {
  const directory = join(stateDir, 'containment'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, ref.jobId + '.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(ref)); fsyncSync(fd); } finally { closeSync(fd); }
}
export function findContainmentRef(stateDir: string, jobId: string): ContainmentRef | undefined {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) return undefined;
  try { const ref = JSON.parse(readFileSync(join(stateDir, 'containment', jobId + '.json'), 'utf8')); return ref.version === 1 && ref.jobId === jobId && typeof ref.generation === 'string' && typeof ref.brokerEpoch === 'string' ? ref : undefined; } catch { return undefined; }
}
/** Written before prepare/READY, independently of GC-able metadata and ref. */
export function markContainmentIntent(stateDir: string, jobId: string): void {
  const dir=join(stateDir,'containment-intents');mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,jobId+'.json');
  if(existsSync(file)) { const v=JSON.parse(readFileSync(file,'utf8'));if(v.jobId!==jobId||v.containmentProtocol!==1)throw Error('invalid containment intent');return; }
  const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,JSON.stringify({jobId,containmentProtocol:1}));fsyncSync(fd);}finally{closeSync(fd);}
}
/** Corruption or any modern evidence forbids downgrade to legacy semantics. */
function presentOrUnreadable(path: string): boolean {
  try { statSync(path); return true; }
  catch(error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
export function hasContainmentIntent(stateDir: string, jobId: string): boolean {
  if(!/^[0-9a-f-]{36}$/.test(jobId))return true;
  if(presentOrUnreadable(join(stateDir,'containment-intents',jobId+'.json'))||presentOrUnreadable(join(stateDir,'containment',jobId+'.json')))return true;
  for(const name of ['meta.json','bootstrap.json','hold.json','launch.tmp']) {
    const path=join(stateDir,'jobs',jobId,name);if(!presentOrUnreadable(path))continue;
    try{const value=JSON.parse(readFileSync(path,'utf8'));const m=name==='launch.tmp'?value.meta:value;
      if(!m||Object.hasOwn(m,'containmentProtocol')||Object.hasOwn(m,'containment'))return true;
    }catch{return true;}
  }
  return false;
}
export const LEGACY_CONTAINMENT_NOTICE='舊版 job，子孫未驗證（containment 未確認）';
