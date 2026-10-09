/** 三平台主導者回歸：只跑自己的 Node／shell stub，透過真 OS 身分查詢驗祖先鏈。 */
import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePrincipal, isPackageLauncher } from '../dist/core/principal.js';

const temp = await mkdtemp(join(tmpdir(), 'ai-cli-principal-'));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + '\n' + error.stack); }
}
const id = (name, commandLine) => ({ pid: 100, ppid: 101, started: 'stub', name, commandLine });
try {
  await test('principal basename handles POSIX executable and shell paths', async () => {
    assert(isPackageLauncher(id('/opt/node/bin/node', 'node /npm/npx-cli.js -y package')));
    assert(isPackageLauncher(id('/bin/sh', 'sh -c "npx -y package"')));
    const chain = [id('/bin/sh', 'sh -c ai-cli-mcp'),
      { ...id('/opt/node/bin/node', 'node /npm/npx-cli.js package'), pid: 101, ppid: 102 },
      { ...id('/opt/node/bin/node', 'node /claude-code/cli.js'), pid: 102, ppid: 0 }];
    const principal = await resolvePrincipal(100, async pids => new Map(chain.filter(p => pids.includes(p.pid)).map(p => [p.pid, p])));
    assert.equal(principal.pid, 102);
  });
  await test('principal recognizes exact POSIX npm titles and script shells', async () => {
    for (const title of ['npm exec @tkflyc/ai-cli-mcp', 'npm x package', 'npx package',
      'npm run verify:worker-identity', 'npm run-script verify:worker-identity', 'npm test']) {
      // Linux comm 截短、macOS 完整 title（含套件的 slash）或原始 node 路徑。
      for (const name of [title.slice(0, 15), title, '/opt/bin/node']) assert(isPackageLauncher(id(name, title)), name + '/' + title);
    }
    for (const title of ['npm run verify', 'npm run-script verify', 'npm test']) {
      const rows = [id('/bin/sh', 'sh -c "node verify.mjs"'),
        { ...id(title, title), pid: 101, ppid: 102 },
        { ...id('node', 'node /claude-code/cli.js'), pid: 102, ppid: 0 }];
      const principal = await resolvePrincipal(100, async pids => new Map(rows.filter(p => pids.includes(p.pid)).map(p => [p.pid, p])));
      assert.equal(principal.pid, 102, title);
    }
  });
  await test('principal retains ordinary Node and rejects title lookalikes', async () => {
    for (const command of ['node /claude-code/cli.js', 'node /user/script.mjs npm exec package',
      'node npm-test.mjs', 'node /npm/npm-cli.js install package', 'npm execute package',
      'npm testing', 'npx-other package', 'npm install package']) assert(!isPackageLauncher(id('/opt/bin/node', command)), command);
    assert(!isPackageLauncher(id('python', 'npm exec package')));
    assert(!isPackageLauncher(id('npm exec package', 'node /user/script.mjs')));
    assert.equal(await resolvePrincipal(100, async () => new Map([[100, id('npm exec package', '')]])), null);
    const principal = await resolvePrincipal(100, async () => new Map([[100, id('/opt/bin/node', 'node /claude-code/cli.js')]]));
    assert.equal(principal.pid, 100);
  });

  const principalUrl = new URL('../dist/core/principal.js', import.meta.url).href;
  const lookupUrl = new URL('../dist/core/live-jobs.js', import.meta.url).href;
  const leaf = join(temp, 'leaf.mjs');
  await writeFile(leaf, `import {resolvePrincipal} from ${JSON.stringify(principalUrl)};
import {lookupPrincipalIdentities} from ${JSON.stringify(lookupUrl)};
const chain=[], seen=new Set(); let pid=process.ppid;
while(pid>0 && !seen.has(pid) && chain.length<16) {
 seen.add(pid); const row=(await lookupPrincipalIdentities([pid])).get(pid);
 if(!row){chain.push({pid,missing:true});break;}
 chain.push({pid:row.pid,ppid:row.ppid,name:row.name,commandLine:row.commandLine?.slice(0,120)});
 if(pid===Number(process.argv[2]))break; pid=row.ppid??0;
}
try {const principal=await resolvePrincipal(process.ppid); console.log('PRINCIPAL_RESULT '+JSON.stringify({principal,chain}));}
catch(e){console.log('PRINCIPAL_RESULT '+JSON.stringify({error:e.stack,chain}));process.exitCode=1;}
`);
  for (const [label, filename, title, shell] of [
    ['real titled npx chain reaches test principal', 'npx-cli.js', 'npm exec @tkflyc/ai-cli-mcp', false],
    ['real unmodified npx chain reaches test principal', 'npx-cli.js', '', false],
    ['real npm test script shell reaches test principal', 'npm-cli.js', 'npm test', true],
    ['real ordinary Node stays principal', 'ordinary.js', '', false],
  ]) await test(label, async () => {
    const middle = join(temp, filename);
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    const shellFile = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'sh';
    const shellArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', `""${process.execPath}" "${leaf}" ${process.pid}"`]
      : ['-c', `${quote(process.execPath)} ${quote(leaf)} ${process.pid}; status=$?; exit "$status"`];
    await writeFile(middle, `const {spawn}=require('node:child_process');
${title ? `process.title=${JSON.stringify(title)};` : ''}
const child=spawn(${shell ? JSON.stringify(shellFile) : 'process.execPath'},${shell ? JSON.stringify(shellArgs) : JSON.stringify([leaf, String(process.pid)])},
 {stdio:'inherit',windowsHide:true,windowsVerbatimArguments:${shell && process.platform === 'win32'}});
child.on('error',e=>{console.error(e);process.exitCode=1;});
child.on('close',code=>{process.exitCode=code??1;});
`);
    // 長路徑本身也為 Linux process.title 預留足夠 argv 空間，避免 title 被截成 npm ex。
    const child = spawn(process.execPath, [middle, ...(shell ? ['test'] : [])], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('process chain timed out: ' + stdout + stderr)); }, 45000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith('PRINCIPAL_RESULT '));
    assert(resultLine, JSON.stringify({ code, stdout, stderr }));
    const result = JSON.parse(resultLine.slice('PRINCIPAL_RESULT '.length));
    console.log('ANCESTORS ' + label + ': ' + JSON.stringify({ principalPid: result.principal?.pid, chain: result.chain }));
    assert.equal(code, 0, JSON.stringify({ result, stderr }));
    if (process.platform !== 'win32' && title) assert.match(result.chain.find(p => p.pid === child.pid)?.commandLine ?? '',
      /^npm\s+(?:exec|test)(?:\s|$)/, 'process.title must exercise POSIX title lookup: ' + JSON.stringify(result.chain));
    assert.equal(result.principal?.pid, filename === 'ordinary.js' ? child.pid : process.pid, JSON.stringify(result));
    assert.equal(result.principal.commandLine, undefined);
  });
} finally { await rm(temp, { recursive: true, force: true }); }
console.log(`principal-process: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
