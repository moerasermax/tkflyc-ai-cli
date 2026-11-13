import '../tools/stubs/catalog-test-env.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {descendantEvidence} from '../dist/ai-cli_kernel/containment-descendants.js';
import {RunStore} from '../dist/ai-cli_kernel/journal.js';
import {settleRunnerRun} from '../dist/ai-cli_kernel/runner-settle.js';
let failed=0;const check=(n,b)=>{console.log(`${b?'PASS':'FAIL'} ${n}`);if(!b)failed++;};
const born=n=>new Date(1700000000000+n*1000).toISOString();
const roots=[{pid:10,started:born(0)},{pid:20,started:born(1)}];
const snap={complete:true,unknown:[],rows:[{pid:30,ppid:20,started:born(2),name:'node.exe'},{pid:40,ppid:30,started:born(3),name:'nested.exe'},{pid:50,ppid:20,started:born(-2),name:'older.exe'}]};
check('dead roots still anchor live orphan descendants',descendantEvidence(roots,snap).alive.map(p=>p.pid).join(',')==='30,40');
check('incomplete or ambiguous descendant table stays unknown',descendantEvidence(roots,{...snap,complete:false}).unknown.length>0&&descendantEvidence(roots,{...snap,unknown:[{pid:60,ppid:20}]}).unknown.length>0&&descendantEvidence(roots,{...snap,rows:[{pid:70,ppid:20,started:born(1),name:'ambiguous'}]}).unknown.length>0);
mkdirSync('.tmp',{recursive:true});const dir=mkdtempSync(resolve('.tmp/fix4-unit-'));
const store=new RunStore(join(dir,'run'));mkdirSync(store.dir,{recursive:true});
store.append({type:'state',state:'running'});store.append({type:'action_intent',action:{actionId:'a',kind:'worker',mode:'write',marker:'fixture',prompt:'stub'}});store.append({type:'action_started',actionId:'a',job:{pid:2147483645,jobId:'fixture'}});
writeFileSync(join(store.dir,'journal.writer.lock'),'{}');const before=JSON.stringify(store.read());let kills=0,releases=0;
let state;try{state=await settleRunnerRun(store,{kill:async()=>{kills++;return false;},isGone:async()=>false},async()=>{store.append({type:'state',state:'paused'});return 'paused';},async()=>{releases++;},{confirmMs:1,pollMs:1});}catch(error){state='threw';console.log('OBSERVED',error.message);}
check('journal timeout preserves open actions without kill',state==='running'&&kills===0&&releases===0&&JSON.stringify(store.read())===before&&existsSync(join(store.dir,'journal-reconcile.json')));
console.log(`FIX4 units: ${failed} failed`);process.exitCode=failed?1:0;
