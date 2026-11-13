/** Fault injection only in the runner started by verify-jobobj-fix8. */
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
if (process.argv[1]?.endsWith('job-runner.js')) {
  const mode = process.env.FIX8_REGISTER_FAULT, directory = process.argv[2];
  const trace = value => fs.appendFileSync(join(directory, 'fix8-trace.jsonl'), JSON.stringify(value) + '\n');
  const original = cp.spawn; let attempts = 0;
  cp.spawn = function(file, args, options) {
    let request; try { request = JSON.parse(Buffer.from(options?.env?.AI_CLI_CONTAINMENT_REQUEST || '', 'base64').toString()); } catch {}
    if (request?.op === 'terminate') {
      let saved; try { saved = JSON.parse(fs.readFileSync(join(directory, 'runner-error.json'))); } catch {}
      trace({ termination: true, saved, stderr: fs.existsSync(join(directory, 'stderr.log')) ? fs.readFileSync(join(directory, 'stderr.log'), 'utf8') : '' });
    }
    if (request?.op !== 'register') return original(file, args, { ...options, windowsHide: true });
    attempts++;
    trace({ attempt: attempts, requestId: request.requestId, hash: createHash('sha256').update(JSON.stringify(request)).digest('hex') });
    const fake = new EventEmitter(); fake.kill = () => true;
    if (mode === 'always' || (mode === 'once' && attempts === 1)) {
      queueMicrotask(() => fake.emit('close', 92)); return fake;
    }
    if (mode === 'identity') {
      fs.writeFileSync(join(dirname(args[0]), 'output.txt'), JSON.stringify({ ok: true, value: { ...request, generation: 'wrong', ready: true } }));
      queueMicrotask(() => fake.emit('close', 0)); return fake;
    }
    if (mode === 'reject') options={...options,env:{...options.env,AI_CLI_CONTAINMENT_REQUEST:Buffer.from(JSON.stringify({...request,capability:'FIX9-invalid-capability'})).toString('base64')}};
    const child = original(file, args, { ...options, windowsHide: true });
    fake.kill = signal => child.kill(signal);
    child.once('error', e => fake.emit('error', e));
    child.once('close', code => {
      // The real request succeeded, including broker assignment/cache publication.
      // Hide its reply by reporting a transport exit instead of changing payload.
      const lost = mode?.startsWith('lost-always') || (mode === 'lost-once' && attempts === 1);
      if (lost && code === 0) {
        const output = JSON.parse(fs.readFileSync(join(dirname(args[0]), 'output.txt'), 'utf8'));
        trace({ realReplyReady: output.ok === true && output.value?.ready === true });
      }
      fake.emit('close', lost && code === 0 ? 92 : code);
    });
    return fake;
  };
  if (mode === 'outer') {
    const read = fs.readFileSync;
    fs.readFileSync = function(path, ...rest) {
      if (String(path) === join(directory, 'launch.tmp')) throw Error('FIX8 original launch read failure');
      return read(path, ...rest);
    };
  }
  if (mode === 'lost-always-rename') {
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (String(to) === join(directory, 'exit.json')) throw Object.assign(Error('FIX8 persistent exit rename'), { code: 'EPERM' });
      return rename(from, to);
    };
  }
  syncBuiltinESMExports();
  const { lookupNativeIdentities } = await import('../../dist/core/win-job-client.js');
  trace({ runner: (await lookupNativeIdentities([process.pid])).get(process.pid) });
}
