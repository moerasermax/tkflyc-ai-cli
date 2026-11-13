import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProcessService} from '../dist/core/process-service.js';
import {FileProcessService} from '../dist/core/file-process-service.js';
import {ensureWindowlessHost} from '../dist/core/win-job-host.js';
let failed=0;
async function test(name,fn){if(process.env.FIX7_TEST_FILTER&&!name.includes(process.env.FIX7_TEST_FILTER))return;try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+' '+e.stack);}}
if(process.platform==='win32'){
 mkdirSync('.tmp',{recursive:true});const root=mkdtempSync(resolve('.tmp/fix7-never-close-'));
 const originalEnv={TEMP:process.env.TEMP,TMP:process.env.TMP,AI_CLI_STATE_DIR:process.env.AI_CLI_STATE_DIR,AI_CLI_CONTAINMENT_TEST:process.env.AI_CLI_CONTAINMENT_TEST};
 Object.assign(process.env,{TEMP:root,TMP:root,AI_CLI_CONTAINMENT_TEST:JSON.stringify({name:'TkflycAiCliContainmentBroker-test-'+randomUUID(),directory:join(root,'broker'),idleMs:60000})});
 try{
  for(const stage of ['bootstrap','host']){
   if(stage==='host')await ensureWindowlessHost(); // real cold compiler, before replacing spawn
   await test(`FIX7 startProcess ${stage} never-close is bounded for MCP and CLI`,async()=>{
    for(const Kind of [ProcessService,FileProcessService])for(const throws of [false,true]){
     process.env.AI_CLI_STATE_DIR=join(root,randomUUID());
     const cliPaths={codex:'never-spawn-vendor',claude:'never-spawn-vendor',antigravity:'never-spawn-vendor'},service=new Kind({stateDir:process.env.AI_CLI_STATE_DIR,cliPaths,breaker:{check(){}}});
     // Finish unrelated real identity lookup before timing the injected helper.
     await service.store.ready;await service.store.identify();
     const spawn=cp.spawn,set=globalThis.setTimeout,timers=[];let launches=0,kills=0,guard;
     try{
      cp.spawn=(file,args,options)=>{
       assert.equal(options.windowsHide,true);assert.ok(stage==='bootstrap'?file===process.execPath&&args[0]==='-e':String(file).endsWith('ai-cli-windowless-host.exe'),'only containment helper, never launcher/runner/vendor');
       launches++;const child=Object.assign(new EventEmitter(),{pid:2147483000,stderr:new PassThrough(),stdout:new PassThrough()});
       child.kill=function(signal){assert.equal(this,child,'original retained child handle');assert.equal(signal,'SIGKILL');kills++;if(throws)throw Error('injected handle failure');return true;};return child;
      };syncBuiltinESMExports();
      // Accelerate only the production deadline, without supplying a close event.
      globalThis.setTimeout=(fn,ms,...args)=>{const timer=set(fn,ms===(stage==='bootstrap'?55000:50000)?25:ms,...args);timers.push(timer);return timer;};
      const watchdog=new Promise((_,reject)=>{guard=set(()=>reject(Error('test watchdog: helper wait did not settle')),750);});
      await assert.rejects(Promise.race([service.startProcess({workFolder:root,cwd:root,prompt:'fixture',model:'codex'}),watchdog]),new RegExp(`Windowless ${stage} deadline; containment unknown`));
      assert.equal(launches,1);assert.equal(kills,1,'timeout stops only its retained child');
     }finally{for(const timer of timers)clearTimeout(timer);clearTimeout(guard);globalThis.setTimeout=set;cp.spawn=spawn;syncBuiltinESMExports();service.dispose();}
    }
   });
  }
 }finally{for(const[key,value]of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}else console.log('SKIP Windows containment helper deadline on non-Windows');
console.log(`FIX7: ${failed} failed`);if(failed)process.exitCode=1;
