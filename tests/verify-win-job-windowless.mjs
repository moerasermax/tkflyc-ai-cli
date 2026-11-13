import '../tools/stubs/catalog-test-env.mjs';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {WinJobClient} from '../dist/core/win-job-client.js';
import {powershell,nativeScript} from '../dist/core/win-job-broker.js';
import {ensureWindowlessHost} from '../dist/core/win-job-host.js';
import {dirname} from 'node:path';
const files=['src/core/win-job-broker.ts','src/core/win-job-host.ts','src/core/job-runner.ts','src/core/job-store.ts','src/core/job-launcher.ts','tests/verify-win-job-broker.mjs','tests/verify-win-job-gates.mjs','tests/verify-process-tree-live.mjs','tests/verify-launcher-jobs.mjs','tests/verify-pty-jobs.mjs','tests/verify-durable-jobs.mjs','tests/verify-durable-audit.mjs','tests/verify-jobs.mjs','tests/verify-adopt.mjs','tests/verify-restart-recovery.mjs','tests/verify-ai-cli_kernel.mjs','tests/helpers/containment-cleanup.mjs','tools/stubs/catalog-test-env.mjs'];
files.push('tests/verify-jobobj-fix7.mjs','tests/verify-mcp-capabilities.mjs','tests/verify-job-usage.mjs','tests/helpers/mock-job-containment.mjs');
files.push('tests/verify-jobobj-fix10.mjs','tests/helpers/fix10-reader-preload.mjs','tests/verify-jobobj-fix8.mjs', 'tests/verify-jobobj-fix9.mjs','tests/helpers/fix8-register-preload.mjs','tests/helpers/durable-failure-evidence.mjs');
files.push('tests/verify-jobobj-fix12.mjs','tests/verify-jobobj-fix11.mjs','tests/helpers/fix11-register-preload.mjs');
let failures=0;function check(name,b){console.log(`${b?'PASS':'FAIL'} ${name}`);if(!b)failures++;}
files.push('tests/helpers/fix2-retry-preload.mjs','tests/verify-win-job-fix2.mjs','tests/helpers/fix2-normal-child.mjs','tests/verify-win-job-fix1.mjs','tests/verify-win-job-unknown.mjs','src/core/live-jobs.ts','src/core/process-tree.ts','tools/stubs/tree-worker.mjs','tests/verify-ai-cli_kernel-terminal.mjs','tests/verify-process-tree.mjs');
files.push('tests/verify-ai-cli_kernel-containment-exception.mjs','tests/helpers/phase3-human-cli.mjs','tests/verify-win-job-phase3-foundation.mjs','tests/verify-win-job-scale.mjs','tests/manual/win-job-integrity.mjs','tools/run-tests.mjs','tools/verify-release.mjs');
files.push('tests/verify-jobobj-fix6.mjs','tests/verify-jobobj-fix5.mjs','tests/verify-jobobj-fix4.mjs','src/ai-cli_kernel/journal-owner.ts','tests/verify-ai-cli_kernel-journal-lock.mjs','tests/helpers/phase3-pipe-late-preload.mjs','tests/verify-win-job-late-exit.mjs');
function allSpawnsHidden(source,depth=0){
  const tree=ts.createSourceFile('fixture.js',source,ts.ScriptTarget.Latest,true);let valid=true;
  function visit(n){
    if(ts.isCallExpression(n)){
      const name=ts.isIdentifier(n.expression)?n.expression.text:ts.isPropertyAccessExpression(n.expression)?n.expression.name.text:'';
      // These two are node-pty / its native test proxy, not child_process.
      // ConPTY owns a pseudoconsole; its no-visible-window behavior is checked
      // by the live pipe/PTY PID-tree tests (windowsHide is not a PTY option).
      const conpty=['loadPtyModule().spawn','native.spawn'].includes(n.expression.getText(tree));
      if(!conpty&&(['spawn','execFile','spawnSync','execFileSync'].includes(name)||(name==='exec'&&n.arguments[0]?.text==='powershell.exe'))){
        const opts=n.arguments[2]??n.arguments[1];
        valid&&=!!opts&&ts.isObjectLiteralExpression(opts)&&opts.properties.some(p=>p.name?.getText(tree)==='windowsHide'&&p.initializer?.kind===ts.SyntaxKind.TrueKeyword);
      }
    }
    // Generated fixture/compiler scripts are also launch paths. Parse their
    // literal parts with inert placeholders instead of executing interpolation.
    if(depth<3){
      const embedded=ts.isTemplateExpression(n)?n.head.text+n.templateSpans.map(s=>'__fixture_value__'+s.literal.text).join(''):
        ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)?n.text:'';
      if(/\b(?:spawn|execFile|spawnSync|execFileSync)\s*\(/.test(embedded))valid&&=allSpawnsHidden(embedded,depth+1);
    }
    ts.forEachChild(n,visit);
  }
  visit(tree);return valid;
}
check('static scanner rejects hidden-flag mutations inside generated scripts',allSpawnsHidden("const code=\"require('child_process').spawn('node',[],{windowsHide:true})\"")&&!allSpawnsHidden("const code=\"require('child_process').spawn('node',[],{windowsHide:false})\""));
for(const file of files){
  check('Windows spawn hides windows: '+file,allSpawnsHidden(readFileSync(new URL('../'+file,import.meta.url),'utf8')));
}
check('normal token native launcher uses CREATE_NO_WINDOW',readFileSync(new URL('./helpers/fix2-normal-token.cs',import.meta.url),'utf8').includes('0x08000000,IntPtr.Zero,cwd'));
const host=readFileSync(new URL('../src/core/win-job-host.ts',import.meta.url),'utf8');
check('native host uses GUI subsystem and CREATE_NO_WINDOW',host.includes('/target:winexe')&&host.includes('false,0x08000004u,IntPtr.Zero')&&host.includes("windowsHide:true,timeout:${bootstrapTimeout},killSignal:'SIGKILL',stdio:['ignore','pipe','pipe']"));
check('native compiler starts without a console shell or visible window',host.includes('$start.UseShellExecute=$false;$start.CreateNoWindow=$true;'));
const bridge=readFileSync(new URL('../src/core/win-job-broker.ts',import.meta.url),'utf8');
check('bridge has no console shell or hide-after-launch',!bridge.includes('cmd.exe')&&!bridge.includes('Start-Process')&&!bridge.includes('-WindowStyle'));
if(process.platform==='win32'&&!failures){
  const root=dirname(await ensureWindowlessHost()).replaceAll("'","''");
  const acl=JSON.parse(await powershell(`$a=[IO.Directory]::GetAccessControl('${root}');$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$r=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;sid=$sid;protected=$a.AreAccessRulesProtected;count=$r.Count;trustee=$r[0].IdentityReference.Value}|ConvertTo-Json -Compress`));
  check('helper executable and scripts have owner-only protected parent ACL',acl.protected&&acl.count===1&&acl.owner===acl.sid&&acl.trustee===acl.sid);
  const client=new WinJobClient();await client.ensure();const broker=await client.hello();
  const visible=JSON.parse(await powershell(nativeScript(`[AiCliContainment]::VisibleWindows([int[]]@(${process.pid},${broker.pid}))`)));
  check('live broker and bridge PID trees have no visible top-level windows',visible.length===0);
}
console.log(`Windowless verification: ${failures} failed`);process.exitCode=failures?1:0;
