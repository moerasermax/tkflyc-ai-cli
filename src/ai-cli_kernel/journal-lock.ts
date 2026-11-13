/** Unique bakery tickets avoid read/unlink ABA when reclaiming a dead owner.
 * Only a ticket whose native owner is proved dead can be removed. Unknown stays.
 * No polling of journal contents and no lock held by a different helper process.
 */
import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writerIdentity,writerDead,type WriterIdentity} from './journal-owner.js';
interface Ticket {owner:WriterIdentity;number:number}
export class JournalUnavailableError extends Error { readonly code='JOURNAL_UNAVAILABLE'; }
/** Persistence failure cannot authorize stopping a live worker, even if not retryable. */
export function journalUnavailable(error:unknown):JournalUnavailableError {
  return error instanceof JournalUnavailableError ? error : new JournalUnavailableError('journal persistence unavailable; retain workers and reconcile: '+String(error),{cause:error});
}
/** Short synchronous retry; every ticket operation also consumes acquisition's total budget. */
export function retryJournalIO<T>(work:()=>T,totalUntil=Infinity):T {
  const until=performance.now()+250,pause=new Int32Array(new SharedArrayBuffer(4));
  for(let attempt=0;;attempt++) {
    try{return work();}catch(error){
      const code=(error as NodeJS.ErrnoException).code,remaining=Math.min(until-performance.now(),totalUntil-Date.now());
      if(!['EPERM','EACCES','EBUSY'].includes(code??'')||remaining<=0)throw error;
      Atomics.wait(pause,0,0,Math.min([1,2,5,10,25][Math.min(attempt,4)],remaining));
    }
  }
}
export function takeJournalLock(dir:string):()=>void {
  const totalUntil=Date.now()+20000; // includes own identity and every native query
  let owner:WriterIdentity;try{owner=writerIdentity();}catch(error){throw new JournalUnavailableError('journal owner identity unavailable; retry or reconcile writer',{cause:error});}
  const tickets=join(dir,'journal.writer.tickets'),id=randomUUID(),path=join(tickets,id+'.json');
  const publish=(number:number)=>{const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify({owner,number}),{mode:0o600});retryJournalIO(()=>renameSync(tmp,path),totalUntil);};
  const read=(file:string):Ticket|undefined=>{try{return JSON.parse(retryJournalIO(()=>readFileSync(file,'utf8'),totalUntil));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw new JournalUnavailableError('journal writer identity unreadable; reconcile writer: '+(e as NodeJS.ErrnoException).code,{cause:e});}};
  const release=()=>{
    let failure:unknown;
    for(const own of [path,path+'.tmp'])try{rmSync(own,{force:true});}catch(error){failure??=error;}
    if(failure!==undefined)throw journalUnavailable(failure);
  };
  try {
    mkdirSync(tickets,{recursive:true});
    publish(0); // choosing is visible before selecting the sequence number
    let number=1;
    for(const name of readdirSync(tickets).filter(n=>n.endsWith('.json'))) {
      const row=read(join(tickets,name));if(row&&Number.isSafeInteger(row.number))number=Math.max(number,row.number+1);
    }
    publish(number);
    let until=Date.now()+4000;
    const firstSeen=new Map<string,number>(),checked=new Map<string,number>();
    for(;;) {
      if(Date.now()>=totalUntil)throw new JournalUnavailableError('journal writer total deadline reached; identity unknown; retry or reconcile writer');
      let queried=false,busy=existsSync(join(dir,'journal.writer.lock')); // old pid-only locks are unknown
      for(const name of readdirSync(tickets).filter(n=>n.endsWith('.json')&&n!==id+'.json')) {
        if(Date.now()>=totalUntil)throw new JournalUnavailableError('journal writer total deadline reached; identity unknown; retry or reconcile writer');
        const file=join(tickets,name),row=read(file);if(!row)continue;
        if(!row.owner||!Number.isSafeInteger(row.number)||row.number<0)throw new JournalUnavailableError('journal writer identity unreadable; reconcile writer');
        if(row.number>number || row.number===number&&name>id+'.json')continue;
        const key=name+JSON.stringify(row.owner);
        const now=Date.now();if(!firstSeen.has(key))firstSeen.set(key,now);
        if(now-firstSeen.get(key)!>=300 && now-(checked.get(key)??0)>=500) {
          const start=Date.now();let dead=false;
          try{dead=writerDead(row.owner,Math.max(1,totalUntil-Date.now()));}finally{until+=Date.now()-start;checked.set(key,Date.now());queried=true;}
          if(dead && JSON.stringify(read(file)?.owner)===JSON.stringify(row.owner)){rmSync(file,{force:true});continue;}
        }
        busy=true;
      }
      if(!busy)return release;
      if(queried)continue; // re-read tickets after slow native evidence before any timeout
      if(Date.now()>=until)throw new JournalUnavailableError('journal writer busy or identity unknown after bounded wait; retry after owner exits');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
    }
  }catch(error){try{release();}catch{/* Retain the original cause; both own paths were attempted. */}throw journalUnavailable(error);}
}
