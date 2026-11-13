import '../tools/stubs/catalog-test-env.mjs';
import{FileJobExecutor}from'../dist/ai-cli_kernel/executor.js';
import{JobStore,jobResult}from'../dist/core/job-store.js';import{powershell,nativeScript}from'../dist/core/win-job-broker.js';import{readBroker,drainedProof}from'../dist/core/containment-store.js';
import{mkdirSync,mkdtempSync,readFileSync,existsSync}from'node:fs';import{join}from'node:path';import{randomUUID}from'node:crypto';
let failed=0;const check=(n,b)=>{console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;};
if(process.platform==='win32'){
 for(const mode of ['timeout','kill','pty-kill','executor-kill','executor-pty-kill']) {
 mkdirSync(join(process.cwd(),'.tmp'),{recursive:true});
 const dir=mkdtempSync(join(process.cwd(),'.tmp','fix1-unknown-')),config={name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(dir,'registry'),idleMs:60000};
 const original=process.env.AI_CLI_CONTAINMENT_TEST;process.env.AI_CLI_CONTAINMENT_TEST=JSON.stringify(config);
 const oldState=process.env.AI_CLI_STATE_DIR;process.env.AI_CLI_STATE_DIR=join(dir,'state');
 const store=new JobStore(join(dir,'state'),'cli');await store.ready;let broker,meta,executor;const pty=mode.includes('pty'),ttyFile=join(dir,'tty.json');
 const identity=async pid=>{try{return JSON.parse(await powershell(nativeScript(`[AiCliContainment]::InspectFixture(${pid})`)));}catch{return undefined;}};
 const stop=async id=>{if(!id)return;await powershell(nativeScript(`[AiCliContainment]::StopFixture(${id.pid},'${id.started}')`)).catch(()=>{});check('owned exact identity exited',(await identity(id.pid))?.started!==id.started);};
 let runner,worker,watch;
 try{
  const job=await store.start({cliPath:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(ttyFile)},JSON.stringify({tty:process.stdout.isTTY===true}));setInterval(()=>{},1000)`],cwd:dir,agent:pty?'antigravity':'grok',resolvedModel:'stub',prompt:'unknown '+mode,pty},undefined,mode==='timeout'?12000:undefined);
  for(let n=0;n<200&&!existsSync(join(job.directory,'meta.json'));n++)await new Promise(r=>setTimeout(r,100));
  meta=JSON.parse(readFileSync(join(job.directory,'meta.json'),'utf8'));runner=await identity(meta.runner.pid);worker=await identity(meta.worker.pid);broker=readBroker(config);if(pty){for(let n=0;n<100&&!existsSync(ttyFile);n++)await new Promise(r=>setTimeout(r,100));check('PTY fixture is a real ConPTY worker',existsSync(ttyFile)&&JSON.parse(readFileSync(ttyFile,'utf8')).tty===true);}await stop(broker);
  let sawKill=false;watch=setInterval(()=>{try{const request=JSON.parse(readFileSync(join(job.directory,'kill.json'),'utf8'));if(request.runner?.pid===meta.runner.pid&&request.runner?.started===meta.runner.started)sawKill=true;}catch{}},10);
  let killed;if(mode.startsWith('executor')){executor=new FileJobExecutor();check('executor unknown kill remains unconfirmed',await executor.kill({pid:job.pid,jobId:meta.jobId,containmentProtocol:1})===false);}else if(mode!=='timeout')killed=await store.kill(job.pid,meta.jobId);
  const until=Date.now()+25000;while(!existsSync(join(job.directory,'exit.json'))&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
  clearInterval(watch);
  const exit=existsSync(join(job.directory,'exit.json'))?JSON.parse(readFileSync(join(job.directory,'exit.json'),'utf8')):{},status=existsSync(join(job.directory,'containment-status.json'))?JSON.parse(readFileSync(join(job.directory,'containment-status.json'),'utf8')):{};
  check('broker loss '+mode+' stops held direct worker',exit.timedOut===(mode==='timeout')&&exit.killed===(mode!=='timeout')&&(await identity(worker.pid))?.started!==worker.started);
  if(mode==='executor-kill')check('real runner consumes identity-bound kill.json and stops direct worker',sawKill&&exit.killed===true&&(await identity(worker.pid))?.started!==worker.started);
  if(killed)check('kill after broker loss stays unknown',killed.containment==='unknown'&&killed.terminationConfirmed===false);
  const output=jobResult(store.get(job.pid,meta.jobId));check('ordinary job exposes containment_lost without termination proof',output.containment==='containment_lost'&&output.terminationConfirmed===false);
  check('broker loss remains unknown with bounded attempts',status.state==='unknown'&&status.attempts>=1&&status.attempts<=3&&!drainedProof(meta.containment,config));
 }finally{clearInterval(watch);executor?.service.dispose();store.dispose();await stop(worker);await stop(runner);await stop(broker);const replacement=readBroker(config);if(replacement?.started!==broker?.started)await stop(replacement);if(original===undefined)delete process.env.AI_CLI_CONTAINMENT_TEST;else process.env.AI_CLI_CONTAINMENT_TEST=original;if(oldState===undefined)delete process.env.AI_CLI_STATE_DIR;else process.env.AI_CLI_STATE_DIR=oldState;}
 }
}
console.log(`Unknown termination: ${failed} failed`);process.exitCode=failed?1:0;
