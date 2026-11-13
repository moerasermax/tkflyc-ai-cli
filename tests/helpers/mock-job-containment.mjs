// Unit-test boundary only. No production import, environment switch, or vendor spawn.
// Native containment and cleanup are exercised by the win-job / FIX suites.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WinJobClient} from '../../dist/core/win-job-client.js';
export function mockJobContainment(){
 const calls=[],originals={prepare:WinJobClient.prototype.prepare,inspect:WinJobClient.prototype.inspect,terminate:WinJobClient.prototype.terminate};
 if(process.platform==='win32'){
  WinJobClient.prototype.prepare=async function(jobId,directory){assert.ok(directory);const ref={version:1,jobId,generation:randomUUID(),brokerEpoch:randomUUID()};calls.push(ref);return ref;};
  const terminal=async function(ref){assert.ok(calls.some(c=>c.jobId===ref.jobId&&c.generation===ref.generation&&c.brokerEpoch===ref.brokerEpoch),'only simulated generation');return {state:'drained',runnerExited:true,activeProcesses:0};};
  WinJobClient.prototype.inspect=terminal;WinJobClient.prototype.terminate=terminal;
 }
 return {calls,assertMeta(meta){if(process.platform==='win32'){assert.equal(meta.containmentProtocol,1);assert.deepEqual(meta.containment,calls.find(c=>c.jobId===meta.jobId));assert.ok(meta.containment);}},restore(){Object.assign(WinJobClient.prototype,originals);}};
}
