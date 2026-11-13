import '../tools/stubs/catalog-test-env.mjs';
import {mkdirSync,mkdtempSync,existsSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import cp,{spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {RunStore} from '../dist/ai-cli_kernel/journal.js';
import {writerIdentity} from '../dist/ai-cli_kernel/journal-owner.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mode=process.argv[2],dir=process.argv[3];
if(mode==='holder'){
 const store=new RunStore(dir);await store.withJournalWriter(async()=>{writeFileSync(join(dir,'owner.json'),JSON.stringify(writerIdentity()));writeFileSync(join(dir,'held'),'1');while(!existsSync(join(dir,'release')))await sleep(30);});
}else if(mode?.startsWith('waiter')){
 writerIdentity();writeFileSync(join(dir,'waiter-ready'),'1');while(!existsSync(join(dir,'go')))await sleep(30);
 let calls=0;const real=cp.execFileSync;
 cp.execFileSync=function(file,args,options){
  if(args?.[1]==='evidence'){
   calls++;writeFileSync(join(dir,'queries'),String(calls));
   if(mode==='waiter-slow'||mode==='waiter-budget'){const result=real(file,args,options);writeFileSync(join(dir,'query-started'),'1');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4500);writeFileSync(join(dir,'query-ended'),'1');return result;}
   if(mode==='waiter-refresh'&&calls===1){writeFileSync(join(dir,'query-started'),'1');return JSON.stringify({state:'alive'});}
  }
  return real(file,args,options);
 };syncBuiltinESMExports();
 const start=Date.now();new RunStore(dir).append({type:'state',state:'paused'});writeFileSync(join(dir,'elapsed'),String(Date.now()-start));
}else{
 let failed=0;const check=(n,b)=>{console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;};
 mkdirSync('.tmp',{recursive:true});const root=mkdtempSync(resolve('.tmp/journal-lock-')),children=[];
 const start=(mode,dir)=>{const child=spawn(process.execPath,[resolve('tests/verify-ai-cli_kernel-journal-lock.mjs'),mode,dir],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);const done=new Promise((r,j)=>{child.once('error',j);child.once('close',code=>r({code,output}));});children.push({child,done,dir});return {child,done};};
 const until=async fn=>{const end=Date.now()+20000;while(!fn()){if(Date.now()>end)throw Error('fixture timeout');await sleep(30);}};
 try{
  if(process.platform!=='win32')console.log('SKIP native Windows lock recovery');
  else {
   const dead=join(root,'dead');mkdirSync(dead);const h=start('holder',dead);await until(()=>existsSync(join(dead,'held')));
   const owner=JSON.parse(readFileSync(join(dead,'owner.json'),'utf8'));
   await powershell(nativeScript(`[AiCliContainment]::StopFixture(${owner.pid},'${owner.started}')`));await h.done;
   let reclaimed=true;try{new RunStore(dead).append({type:'state',state:'paused'});}catch{reclaimed=false;}
   check('native-dead writer ticket is safely reclaimed',reclaimed&&new RunStore(dead).read().length===1&&readdirSync(join(dead,'journal.writer.tickets')).filter(n=>n.endsWith('.json')).length===0);
   const race=join(root,'race');mkdirSync(race);const waiter=start('waiter',race);await until(()=>existsSync(join(race,'waiter-ready')));
   const holder=start('holder',race);await until(()=>existsSync(join(race,'held')));writeFileSync(join(race,'go'),'1');await sleep(1600);writeFileSync(join(race,'release'),'1');
   const [w,h2]=await Promise.all([waiter.done,holder.done]);
   check('later journal writer waits and succeeds',w.code===0&&h2.code===0&&Number(readFileSync(join(race,'elapsed'),'utf8'))>=500&&new RunStore(race).read().length===1);
   for(const kind of ['slow','budget','refresh','grace']){
    const folder=join(root,kind);mkdirSync(folder);const w=start('waiter-'+kind,folder);await until(()=>existsSync(join(folder,'waiter-ready')));
    const h=start('holder',folder);await until(()=>existsSync(join(folder,'held')));writeFileSync(join(folder,'go'),'1');
    if(kind==='grace'){await sleep(100);writeFileSync(join(folder,'release'),'1');}
    else {await until(()=>existsSync(join(folder,'query-started')));if(kind==='refresh'){const id=JSON.parse(readFileSync(join(folder,'owner.json'),'utf8'));await powershell(nativeScript(`[AiCliContainment]::StopFixture(${id.pid},'${id.started}')`));}else {if(kind==='budget'){await until(()=>existsSync(join(folder,'query-ended')));await sleep(150);}writeFileSync(join(folder,'release'),'1');}}
    const [wr]=await Promise.all([w.done,h.done]);
    const count=existsSync(join(folder,'queries'))?Number(readFileSync(join(folder,'queries'),'utf8')):0;
    check('journal '+kind+' evidence wait succeeds',wr.code===0&&new RunStore(folder).read().length===1&&(kind!=='refresh'||count>=2)&&(kind!=='grace'||count===0),wr.output);
   }
   const unknown=join(root,'unknown');mkdirSync(unknown);mkdirSync(join(unknown,'journal.writer.tickets'));writeFileSync(join(unknown,'journal.writer.tickets','unknown.json'),JSON.stringify({owner:{pid:process.pid,started:'unknown'},number:0}));let refused=false;
   try{new RunStore(unknown).append({type:'state',state:'paused'});}catch(e){refused=/bounded wait/.test(e.message);}
   check('unknown writer is never reclaimed',refused&&existsSync(join(unknown,'journal.writer.tickets','unknown.json')));
  }
 }catch(e){check('journal lock fixtures completed',false);console.error(e);}
 finally{
  for(const {child,done,dir} of children){if(child.exitCode===null&&child.signalCode===null){writeFileSync(join(dir,'release'),'1');writeFileSync(join(dir,'go'),'1');}const result=await done;if(result.code!==0&&existsSync(join(dir,'elapsed')))console.error(result.output);}
 }
 console.log(`Journal lock: ${failed} failed`);process.exitCode=failed?1:0;
}
