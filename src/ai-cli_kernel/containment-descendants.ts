/** Additional refusal evidence only: an empty snapshot never proves drained. */
import {listProcessTable,type ProcessSnapshot} from '../core/process-tree.js';
interface Root {pid:number;started:string}
export interface Descendants {alive:Array<{pid:number;name:string;started:string}>;unknown:string[]}
function time(value:string):number {
  return typeof value==='string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)?Date.parse(value):NaN;
}
export function descendantEvidence(roots:Root[],snapshot:ProcessSnapshot):Descendants {
  const result:Descendants={alive:[],unknown:[]},known=new Map<string,Root>();
  const key=(identity:Root)=>`${identity.pid}:${identity.started}`;
  const order=(identity:Root)=>{const born=time(identity.started);return Number.isFinite(born)?born:Infinity;};
  if(!snapshot.complete)result.unknown.push('process table incomplete');
  for(const root of roots){const born=time(root?.started);if(!Number.isSafeInteger(root?.pid)||root.pid<=0||!Number.isFinite(born))result.unknown.push('root identity unavailable');else known.set(key(root),root);}
  // Retain dead roots as anchors: Windows keeps the creator PID in orphan rows.
  // Never replace their birth with that of a later occupant of the same PID.
  // Creation order resolves any live parent before its children, regardless of
  // snapshot order. Invalid times remain blockers when their parent is related.
  const pending=snapshot.rows.filter(row=>!known.has(key(row))).sort((a,b)=>order(a)-order(b));
  const occupants=new Map(snapshot.rows.map(row=>[row.pid,row]));
  for(const row of pending){
    const parents=[...known.values()].filter(parent=>parent.pid===row.ppid);
    if(!parents.length)continue;
    const born=time(row.started);
    // A current occupant may itself descend from a different root. Earlier
    // candidates have already been evaluated before applying this upper bound.
    const occupant=occupants.get(row.ppid);
    const parent=Math.max(...parents.map(p=>time(p.started)).filter(t=>!Number.isFinite(born)||t<=born));
    if(parent===-Infinity)continue; // older than every related parent identity
    if(!Number.isFinite(born)||born===parent){result.unknown.push(`PID ${row.pid}: creation order ambiguous`);continue;}
    if(occupant && !known.has(key(occupant)) && time(occupant.started)!==parent) {
      const upper=time(occupant.started);
      if(!Number.isFinite(upper)||upper<parent){result.unknown.push(`PID ${row.ppid}: reused parent identity unavailable`);continue;}
      if(born>=upper)continue; // child of an unrelated new PID occupant
    }
    if(snapshot.unknown.some(p=>p.pid===row.ppid)){result.unknown.push(`PID ${row.ppid}: parent occupant unknown`);continue;}
    known.set(key(row),row);
    result.alive.push({pid:row.pid,name:row.name,started:row.started});
  }
  for(const row of snapshot.unknown)if(row.ppid===null||[...known.values()].some(p=>p.pid===row.ppid))result.unknown.push(`PID ${row.pid}: descendant identity unavailable`);
  return result;
}
export async function inspectDescendants(roots:Root[]):Promise<Descendants> {
  try{return descendantEvidence(roots,await listProcessTable());}
  catch(error){return {alive:[],unknown:['process table query failed: '+String(error)]};}
}
