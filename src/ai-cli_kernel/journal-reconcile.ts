/** Advisory evidence only; never changes journal state or authorizes an action. */
import {readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
export function readJournalReconcile(dir:string):{raw:string;detail:string}|null {
  try {
    const raw=readFileSync(join(dir,'journal-reconcile.json'),'utf8');
    try {const value=JSON.parse(raw);return {raw,detail:typeof value.detail==='string'?value.detail:'journal 對帳標記格式不明'};}
    catch{return {raw,detail:'journal 對帳標記損毀，請保留檔案並對帳'};}
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;return {raw:'',detail:'journal 對帳標記無法讀取，請核對存取權限'};}
}
export function clearJournalReconcile(dir:string,observed:ReturnType<typeof readJournalReconcile>):void {
  // Called only after a resumed runner's runner_started append has fsynced.
  if(observed?.raw && readJournalReconcile(dir)?.raw===observed.raw)rmSync(join(dir,'journal-reconcile.json'),{force:true});
}
