/** Human CLI only. Acknowledging lost containment is never proof of termination. */
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {inspectDescendants} from './containment-descendants.js';
import {readJobMetas} from '../core/job-store.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {jobStateDir} from '../core/live-jobs.js';
import {findContainmentRef,readContainment,readBroker,readBrokerEpoch,drainedProof} from '../core/containment-store.js';
import {WinJobClient} from '../core/win-job-client.js';
import {nativeScript,powershell} from '../core/win-job-broker.js';
import type {ContainmentRef,BrokerIdentity} from '../core/win-job-protocol.js';
import {RunStore,kernelRunDir,releaseActiveLock} from './journal.js';
import {replayJournal} from './replay.js';
import {FileJobExecutor} from './executor.js';
import {withProcessMutex} from './process-mutex.js';
import {isTerminalState,type ContainmentConfirmation,type JobRef} from './types.js';

const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
interface DeathEvidence {state:'dead'|'alive'|'unknown';reason:string;at:string;pid?:number;started?:string;error?:number}
async function evidence(identity:{pid:number;started:string}):Promise<DeathEvidence> {
  if(!Number.isSafeInteger(identity.pid)||identity.pid<=0||typeof identity.started!=='string'||!identity.started)throw Error('exact process identity unavailable');
  return JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ProcessEvidence(${identity.pid},${quote(identity.started)})`)));
}
async function runnerGone(store:RunStore):Promise<void> {
  // Admission mutex plus journal ownership fences unclaimed launchers; cancel.request is written only after confirmation.
  // An existing runner must relinquish BOTH its identity files or be proved dead.
  for(const path of [store.runnerPath,store.runnerLockPath])if(existsSync(path)) {
    const identity=JSON.parse(readFileSync(path,'utf8'));
    if((await evidence(identity)).state!=='dead')throw Error('kernel runner alive or unknown; wait for it to release journal ownership');
  }
}
interface Diagnosis {jobs:ContainmentRef[];observations:Array<Record<string,unknown>>;blockers:string[]}
async function diagnose(store:RunStore,executor:FileJobExecutor,client:WinJobClient):Promise<Diagnosis> {
  const view=replayJournal(store.read()),result:Diagnosis={jobs:[],observations:[],blockers:[]};
  if(view.openCheck)result.blockers.push(`check PID ${view.openCheck.pid}: termination unconfirmed`);
  const seen=new Set<string>();
  for(const action of view.actions.values()) {
    const job:JobRef|undefined=action.job;
    if(!job){if(!action.outcome&&!action.abandoned)result.blockers.push(`${action.spec.actionId}: start unknown`);continue;}
    if(seen.has(job.jobId))continue;seen.add(job.jobId);
    const ref=findContainmentRef(jobStateDir(),job.jobId);
    if(!ref){if(!await executor.isGone(job))result.blockers.push(`${job.jobId}: missing containment or legacy blocker`);continue;}
    const status=await client.inspect(ref);
    if(typeof status.activeProcesses==='number'&&status.activeProcesses>0)throw Error(`ActiveProcesses > 0: ${job.jobId}; refused, use normal cancel/drain`);
    if(status.state==='drained'&&drainedProof(ref,client.config))continue;
    if(status.state==='active'||status.state==='preparing'){
      if((await client.terminate(ref)).state==='drained')continue;
      result.blockers.push(`${job.jobId}: tracking restored; normal termination has not drained`);continue;
    }
    const record=readContainment(ref,client.config);
    // Older records may use broker.json only while it still names the exact epoch.
    const current=readBroker(client.config),broker:BrokerIdentity|undefined=record?.broker??readBrokerEpoch(ref.brokerEpoch,client.config)??(current?.epoch===ref.brokerEpoch?current:undefined);
    if(!record||record.phase!=='released'||!Number.isSafeInteger(record.runnerPid)||!record.runnerStarted||!broker||broker.version!==1||broker.epoch!==ref.brokerEpoch||!broker.sid?.startsWith('S-')){
      result.blockers.push(`${job.jobId}: takeover/original broker evidence unavailable`);continue;
    }
    let death:DeathEvidence;try{death=await evidence(broker);}catch{result.blockers.push(`${job.jobId}: broker identity query failed`);continue;}
    if(death.state!=='dead'){result.blockers.push(`${job.jobId}: broker ${death.state}, no exception for timeout/access errors`);continue;}
    const processDeaths:Record<string,DeathEvidence>={};
    let meta;try{meta=JSON.parse(readFileSync(join(jobStateDir(),'jobs',job.jobId,'meta.json'),'utf8'));}catch{}
    for(const [kind,identity] of [['runner',{pid:record.runnerPid,started:record.runnerStarted}],['worker',meta?.worker]] as const) {
      let death:DeathEvidence;
      try{death=await evidence(identity);}catch{death={state:'unknown',reason:'identity unavailable',at:new Date().toISOString()};}
      if(death.state==='alive')throw Error(`ActiveProcesses > 0: ${job.jobId} ${kind} alive; refused, use normal cancel/drain`);
      processDeaths[kind]=death;
    }
    if(Object.values(processDeaths).some(death=>death.state!=='dead')){result.blockers.push(`${job.jobId}: runner/worker death unconfirmed`);continue;}
    const descendants=await inspectDescendants([{pid:record.runnerPid,started:record.runnerStarted},meta?.worker]);
    if(descendants.alive.length)throw Error(`ActiveProcesses > 0: ${job.jobId} descendants alive: ${descendants.alive.map(p=>`PID ${p.pid} ${p.name}`).join(', ')}; refused: 核對 PID、建立時間與用途後，手動結束所列程序再重試；勿按名稱終止`);
    if(descendants.unknown.length){result.blockers.push(`${job.jobId}: descendant query unknown: ${descendants.unknown.join('; ')}`);continue;}
    // Only this broker owned the non-inheritable handle; no live-handle migration.
    result.jobs.push(ref);
    result.observations.push({jobId:ref.jobId,generation:ref.generation,brokerEpoch:ref.brokerEpoch,brokerDeath:death,processDeaths,descendants,observedAt:new Date().toISOString(),lastActiveProcesses:status.activeProcesses??null,lastCountAt:typeof status.activeProcesses==='number'?new Date().toISOString():null,recheck:status.state,reason:'broker_exited_handle_lost'});
  }
  return result;
}
export interface ExceptionResult {runId:string;detail:string;state?:string;worktreeRemoved?:boolean;branchRemoved?:boolean}
/** No injectable terminal/answer/diagnosis dependencies in the production path. */
export async function confirmContainmentLostCli(runId:string,scope:'cancel'|'cleanup',cleanup:(store:RunStore)=>ExceptionResult):Promise<ExceptionResult> {
  if(process.env.AI_CLI_WORKER==='1')throw Error('worker cannot confirm containment loss');
  if(process.platform!=='win32'||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('containment loss confirmation requires stdin/stdout TTY and a Windows console');
  const targets=readJobMetas(jobStateDir()).flatMap(meta=>[meta.runner,...(meta.worker?[meta.worker]:[])]).filter(id=>id?.pid>0);
  const ancestry=await powershell(nativeScript(`[AiCliContainment]::WorkerAncestry(${process.pid},${quote(JSON.stringify(targets))})`));
  if(ancestry!=='none')throw Error('worker ancestry is '+ancestry+'; cannot confirm containment loss');
  const actor=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::ConsoleActor(${process.pid})`))) as ContainmentConfirmation['actor'];
  const store=new RunStore(kernelRunDir(runId)),contract=store.readContract();
  if(scope==='cleanup'&&!contract.develop)throw Error('only develop runs have a worktree');
  await withProcessMutex('admission',async()=>{await runnerGone(store);});
  const executor=new FileJobExecutor(),client=new WinJobClient();
  try{return await store.withJournalWriter(async()=>{
    await runnerGone(store);
    const before=replayJournal(store.read());
    if(scope==='cancel'&&isTerminalState(before.state))throw Error('run already terminal; cancel confirmation cannot authorize cleanup');
    if(scope==='cleanup'&&!isTerminalState(before.state))throw Error('cancel first; cleanup requires a terminal run');
    if(scope==='cancel')for(const action of before.actions.values())if(action.job)await executor.kill(action.job);
    const first=await diagnose(store,executor,client);
    if(first.jobs.length===0)throw Error(`No eligible lost containment: ${first.blockers.join('; ')||'tracking recovered; use normal cancel/cleanup'}`);
    const observedSeq=replayJournal(store.read()).lastSeq;
    process.stdout.write(`程序可能仍在執行。scope=${scope}；這不是 drained 證明，取消不會拆 worktree。\n`);
    for(const row of first.observations)process.stdout.write(JSON.stringify(row)+'\n');
    if(first.blockers.length)process.stdout.write('其他 blocker（不豁免）：'+first.blockers.join('; ')+'\n');
    const code=randomBytes(4).toString('hex');
    const terminal=createInterface({input:process.stdin,output:process.stdout,terminal:true});let answer:string;
    const abort=new AbortController(),interrupt=()=>abort.abort(new Error('confirmation interrupted'));
    const timer=setTimeout(()=>abort.abort(new Error('confirmation timed out')),30000);
    terminal.on('SIGINT',interrupt);process.on('SIGINT',interrupt);
    try{answer=await terminal.question(`輸入 ${runId} ${code}：`,{signal:abort.signal});}
    finally{clearTimeout(timer);terminal.off('SIGINT',interrupt);process.off('SIGINT',interrupt);terminal.close();}
    if(answer.trim()!==`${runId} ${code}`)throw Error('runId or confirmation code mismatch');
    return await withProcessMutex('admission',async()=>{
    await runnerGone(store);
    const recheck=await diagnose(store,executor,client);
    const keys=(refs:ContainmentRef[])=>refs.map(r=>`${r.jobId}/${r.generation}/${r.brokerEpoch}`).sort().join('|');
    if(keys(first.jobs)!==keys(recheck.jobs)||replayJournal(store.read()).lastSeq!==observedSeq)throw Error('containment changed during confirmation; diagnose again');
    if(scope==='cleanup'&&recheck.blockers.length)throw Error('cleanup blocked: '+recheck.blockers.join('; '));
    if(scope==='cancel'){store.requestCancel();if(before.state!=='stop_pending')store.append({type:'state',state:'stop_pending',reason:'containment_diagnosis',detail:'人工診斷通過；記錄確認意圖'});}
    const event:ContainmentConfirmation={type:'containment_lost_confirmed',runId,jobs:recheck.jobs.map(({jobId,generation,brokerEpoch})=>({jobId,generation,brokerEpoch})),actor,scope,observedSeq:replayJournal(store.read()).lastSeq,requestId:randomUUID(),remainingBlockers:recheck.blockers,diagnostics:{reason:'broker_exited_handle_lost',errors:recheck.blockers,observations:recheck.observations}};
    store.append(event); // fsync must succeed before cancellation or cleanup.
    if(scope==='cleanup'){
      if(recheck.blockers.length)throw Error('cleanup blocked: '+recheck.blockers.join('; '));
      return cleanup(store); // fresh scope only; ordinary API never reads this exemption.
    }
    if(recheck.blockers.length===0)store.append({type:'state',state:'cancelled',reason:'containment_lost_confirmed',detail:'程序可能仍在執行；未證明 drained；cleanup 需重新確認'});
    return {runId,state:recheck.blockers.length?'stop_pending':'cancelled',detail:recheck.blockers.length?'仍有其他 blocker，維持 stop_pending':'人工承認 containment_lost；程序可能仍在執行，未證明 drained；worktree 保留'};
    });
  });}finally{executor.dispose();try{if(replayJournal(store.read()).state==='cancelled')await releaseActiveLock(runId);}catch{/* Preserve the operation error; admission reconciles retained slots. */}}
}
