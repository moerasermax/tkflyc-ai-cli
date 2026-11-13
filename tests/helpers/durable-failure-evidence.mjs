/** Test-only failure evidence: copy before fixture cleanup; never stop a process. */
import { createRequire } from 'node:module';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// Keep fs's ESM facade lazy: alias-config tests inject reads before syncing it.
const require = createRequire(import.meta.url), fs = require('node:fs');
const TEST_STARTED = Date.now();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function stringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object') { if (seen.has(item)) return '[Circular]'; seen.add(item); }
    return item;
  }, 2);
}
export function preserveDurableFailure({ name = 'durable', result, roots = [], config, cacheRoot = tmpdir(), destination = join(ROOT, '.tmp', 'durable-failures') } = {}) {
  if (process.env.AI_CLI_MUTATION_TEST === '1') return;
  let lock;
  const lockPath=join(destination,'.capture.lock');
  try {
    fs.mkdirSync(destination, { recursive: true });
    try { lock=fs.openSync(lockPath,'wx'); } catch { return; }
    const previous = fs.readdirSync(destination, { withFileTypes: true }).filter(e=>e.name!=='.capture.lock');
    // This dedicated directory contains mkdtemp capture folders. Never follow or
    // evict links/foreign files; reserve room for the newest complete capture.
    const captureRoot=fs.realpathSync(destination);
    const oldest=previous.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/^[a-zA-Z0-9_-]{1,70}-[a-zA-Z0-9]{6}$/.test(e.name))
      .map(e=>({path:join(destination,e.name),mtime:fs.lstatSync(join(destination,e.name)).mtimeMs})).sort((a,b)=>a.mtime-b.mtime||a.path.localeCompare(b.path));
    let existingBytes=0, scanned=0, remaining=previous.length;
    function measure(dir) { for(const e of fs.readdirSync(dir,{withFileTypes:true})) { if(++scanned>4096) { existingBytes=32*1024*1024; return; } const p=join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())measure(p);else if(e.isFile())existingBytes+=fs.statSync(p).size; } }
    measure(destination);
    while(remaining>=20 || existingBytes>28*1024*1024) {
      const victim=oldest.shift();
      if(!victim){console.error('Durable evidence retention blocked by non-capture entries');return;}
      const info=fs.lstatSync(victim.path);
      if(!info.isDirectory()||info.isSymbolicLink()||dirname(fs.realpathSync(victim.path))!==captureRoot)continue;
      fs.rmSync(victim.path,{recursive:true,force:true});remaining--;
      existingBytes=0;scanned=0;measure(destination);
    }
    let budget=Math.min(4*1024*1024,32*1024*1024-existingBytes)-262144, visited=0;
    const target = fs.mkdtempSync(join(destination, name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 70) + '-'));
    const notes = [], jobs = [], seen = new Set();
    const copy = (source, dest) => {
      if(budget<=0 || ++visited>2048)return;
      try {
        const info=fs.lstatSync(source);if(info.isSymbolicLink())return;
        if(info.isDirectory()){fs.mkdirSync(dest,{recursive:true});for(const e of fs.readdirSync(source))copy(join(source,e),join(dest,e));return;}
        if(!info.isFile())return;
        const max=Math.min(info.size,1048576,budget),data=Buffer.alloc(max),fd=fs.openSync(source,'r');let n;
        try{n=fs.readSync(fd,data,0,max,0);}finally{fs.closeSync(fd);}
        fs.mkdirSync(dirname(dest),{recursive:true});fs.writeFileSync(dest,data.subarray(0,n));budget-=n;
        if(n<info.size && notes.length<100)notes.push(source+': truncated at evidence byte limit');
      } catch(e){if(notes.length<100)notes.push(source+': '+e.message);}
    };
    function walk(dir, depth = 0) {
      if (!dir || depth > 8 || seen.size >= 2048 || seen.has(resolve(dir))) return;
      seen.add(resolve(dir));
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (basename(dirname(dir)) === 'jobs' && /^[0-9a-f-]{36}$/i.test(basename(dir))) {
        const label = jobs.length + '-' + basename(dir);
        copy(dir, join(target, label));
        let stderr = ''; try { stderr = fs.readFileSync(join(dir, 'stderr.log'), 'utf8').slice(-16000); } catch {}
        jobs.push({ directory: dir, copy: label, stderrTail: stderr }); return;
      }
      for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !['node_modules', '.git'].includes(e.name)) walk(join(dir, e.name), depth + 1);
    }
    try {
      config ??= JSON.parse(process.env.AI_CLI_CONTAINMENT_TEST || 'null');
      if (config?.directory && /^TkflycAiCliContainmentBroker-test-/.test(config.name)) {
        fs.mkdirSync(join(target, 'containment'));
        for (const f of fs.readdirSync(config.directory)) if (f === 'broker.json' || /^[0-9a-f-]{36}\.json$/i.test(f)) copy(join(config.directory, f), join(target, 'containment', f));
      }
    } catch (e) { notes.push('containment: ' + e.message); }
    try {
      function collect(source, dest) {
        if(!/^broker-.*\.error\.log$|\.host-error$/.test(basename(source)))return;
        const info=fs.lstatSync(source);
        if(!config?.name || !/^TkflycAiCliContainmentBroker-test-/.test(config.name) || !info.isFile() || info.isSymbolicLink() || info.mtimeMs<TEST_STARTED || info.size>1048576)return;
        if(!fs.readFileSync(source,'utf8').includes(config.name))return;
        copy(source,dest);
      }
      for(const dir of fs.readdirSync(cacheRoot,{withFileTypes:true}).slice(0,128))if(dir.isDirectory()&&!dir.isSymbolicLink()&&dir.name.startsWith('ai-cli-windowless-')) {
        const base=join(cacheRoot,dir.name),to=join(target,'windowless',dir.name);
        for(const entry of fs.readdirSync(base,{withFileTypes:true}).slice(0,512)) {
          if(entry.isFile())collect(join(base,entry.name),join(to,entry.name));
          else if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^(bridge|broker)-/.test(entry.name))for(const f of fs.readdirSync(join(base,entry.name)).slice(0,32))collect(join(base,entry.name,f),join(to,entry.name,f));
        }
      }
    } catch (e) { notes.push('windowless: ' + e.message); }
    // Preserve small ownership/transport diagnostics before large job output.
    for (const root of [...roots, process.env.AI_CLI_STATE_DIR].filter(Boolean)) walk(root);
    const details = { name, at: new Date().toISOString(), result, jobs, notes };
    let serialized=stringify(details);
    if(Buffer.byteLength(serialized)>262144)serialized=stringify({name,at:details.at,truncated:true,preview:serialized.slice(0,40000)});
    fs.writeFileSync(join(target, 'failure.json'), serialized);
    console.error('DURABLE FAILURE EVIDENCE ' + target + '\n' + stringify(details));
    return target;
  } catch (e) { console.error('Unable to preserve durable evidence: ' + e.message); }
  finally { if(lock!==undefined){try{fs.closeSync(lock);}catch{}try{fs.unlinkSync(lockPath);}catch{}} }
}
export function assertDurableStatus(result, expected, options = {}) {
  if (result?.status !== expected) preserveDurableFailure({ ...options, result });
  require('node:assert/strict').equal(result?.status, expected, result?.status === expected ? undefined : stringify(result));
}
