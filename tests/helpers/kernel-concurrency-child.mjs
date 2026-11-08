/** IPC barriers drive real independent admission/command processes; no vendor CLI. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, mode, sourceFlag, encoded] = process.argv.slice(2);
const source = sourceFlag === 'source', options = JSON.parse(encoded);
const load = name => import(pathToFileURL(join(root, source ? 'src' : 'dist', 'ai-cli_kernel', `${name}.${source ? 'ts' : 'js'}`)).href);
const { RunStore, kernelRunDir, kernelStateDir } = await load('journal');
const store = new RunStore(kernelRunDir(options.runId));
const receive = type => new Promise(resolve => {
  const listener = message => { if (message.type === type) { process.off('message', listener); resolve(message); } };
  process.on('message', listener);
});
const stop = receive('stop');
process.send({ type: 'ready' });
await receive('go');
try {
  if (mode === 'admit') {
    const { aiCliKernelApprove, aiCliKernelCancel } = await load('api');
    const { readActiveRuns } = await load('admission');
    let admitted = false;
    try {
      await aiCliKernelApprove({ runId: store.runId }, { launch: async () => {}, quota: async agent => options.quota && Object.hasOwn(options.quota, agent) ? options.quota[agent] : 80 });
      admitted = true;
      process.send({ type: 'result', ok: true, active: readActiveRuns().map(run => run.runId) });
    } catch (error) { process.send({ type: 'result', ok: false, reason: error.reason, error: error.message }); }
    await stop;
    if (admitted && !options.crash) await aiCliKernelCancel({ runId: store.runId });
  } else if (mode === 'mutex-crash') {
    const { withProcessMutex } = await load('process-mutex');
    await withProcessMutex('admission', async () => {
      process.send({ type: 'locked' });
      await stop;
      process.exit(0); // Deliberately skip finally, leaving an actual dead owner's ticket.
    });
  } else if (mode === 'lease') {
    const { waitForTestLock } = await load('test-lock');
    const { realWorkspace } = await load('workspace');
    const lease = await waitForTestLock(store, () => store.cancelRequested(), heldBy => process.send({ type: 'wait', heldBy }));
    if (!lease) { process.send({ type: 'result', cancelled: true }); }
    else {
      const command = `"${process.execPath}" "${join(root, 'tests/helpers/kernel-check-command.mjs')}" "${options.control}" "${store.runId}"`;
      const handle = realWorkspace.startCheck(command, options.control, join(store.dir, 'command.log'), undefined, true);
      await lease.command({ pid: handle.pid, started: '', name: '' });
      handle.begin?.();
      const identity = await handle.identify();
      await lease.command({ pid: handle.pid, ...identity });
      const deadline = Date.now() + 15000;
      while (!existsSync(join(options.control, `started-${store.runId}`))) {
        const done = await handle.wait(20);
        if (done || Date.now() > deadline) throw new Error(`command ${store.runId} did not reach barrier: exit=${done?.exitCode} log=${handle.tail()} busy=${existsSync(join(options.control, 'busy')) ? readFileSync(join(options.control, 'busy'), 'utf8') : 'none'}`);
      }
      process.send({ type: 'command', kind: options.kind, lease: JSON.parse(readFileSync(join(kernelStateDir(), 'test.lock'), 'utf8')) });
      if (options.crash) { await stop; process.exit(0); }
      if (options.cancel) {
        await stop;
        const stopped = await handle.kill();
        if (stopped) await lease.release();
        process.send({ type: 'result', stopped });
        process.disconnect();
        process.exit(0);
      }
      let done;
      do { done = await handle.wait(30); } while (!done);
      await lease.release();
      process.send({ type: 'result', ...done });
    }
  } else if (mode === 'loop') {
    // Fake git/workspace I/O, with the production runCheck and deadline calculation.
    const { runKernelLoop } = await load('loop');
    const contract = store.readContract();
    let clock = Date.now(), starts = 0;
    const workspace = {
      prepare() {}, inspect() { return { branch: contract.develop.branch, head: 'head', dirty: [], changed: ['feature'], ancestorOk: true }; },
      refs() { return []; }, commitHistory() { return []; }, restore() {},
      startCheck(command) {
        starts++;
        process.send({ type: 'command', command, starts });
        return { pid: 99999999, identify: async () => ({ started: '', name: '' }), tail: () => '', kill: async () => true,
          wait: async () => { if (options.timeout) { clock += 60000; return null; } return { exitCode: options.exitCode ?? 0, tail: 'fake local command' }; } };
      },
    };
    const executor = { async start() { throw new Error('No vendor calls permitted'); } };
    const state = await runKernelLoop({ store, contract, executor, workspace, quota: async () => 80, boundary: async () => 'PASS',
      agentFor: () => 'codex', versionId: () => 'test', snapshot: () => null, now: () => Math.max(clock, Date.now()),
      sleep: async () => {}, pollMs: 1, killConfirmMs: 1, pid: process.pid });
    const { replayJournal } = await load('replay');
    const view = replayJournal(store.read());
    process.send({ type: 'result', state, verification: view.verification, testFailures: view.testFailures, starts });
  }
} catch (error) { process.send({ type: 'error', message: error.stack }); process.exitCode = 1; }
finally { process.disconnect(); }
