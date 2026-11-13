/** 控制端共用 client。失聯不建同名 job、不落 drained、不以 PID/taskkill 降級。 */
import { randomUUID } from 'node:crypto';
import { bridgeCall, ContainmentTransportError, launchBroker, nativeScript, powershell } from './win-job-broker.js';
import type { IdentityLookup } from './live-jobs.js';
import { recordJobFailure } from './job-store.js';
import { drainedProof, readBroker, readContainment } from './containment-store.js';
import { brokerConfig, sameContainment, type BrokerConfig, type ContainmentRef, type ContainmentStatus } from './win-job-protocol.js';

export class WinJobClient {
  constructor(readonly config: BrokerConfig = brokerConfig()) {}
  async hello(): Promise<{ epoch: string; pid: number; version: number }> {
    const broker = readBroker(this.config);
    if (!broker) throw new Error('containment broker registry unavailable');
    return await bridgeCall(this.config, { op: 'hello', version: 1, brokerEpoch: broker.epoch }) as { epoch: string; pid: number; version: number };
  }
  async ensure(): Promise<string> {
    let peer: Awaited<ReturnType<WinJobClient['hello']>> | undefined;
    try { peer=await this.hello(); } catch { /* 選主仍須經原子 mutex 與 FIRST_PIPE_INSTANCE，不覆寫存活 broker。 */ }
    if(peer) {
      if(peer.version===1)return peer.epoch;
      await bridgeCall(this.config,{op:'retire',version:peer.version,brokerEpoch:peer.epoch}).catch(()=>undefined);
      throw Error('Incompatible broker protocol; admission handoff requested, wait for existing jobs to drain (never force-kill broker)');
    }
    await launchBroker(this.config);
    let error: unknown;
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        const current=await this.hello();
        if(current.version===1)return current.epoch;
        await bridgeCall(this.config,{op:'retire',version:current.version,brokerEpoch:current.epoch}).catch(()=>undefined);
        throw Error('Incompatible broker protocol; admission handoff requested');
      } catch (e) { error = e; }
    }
    throw new Error(`Windows containment broker unavailable; worker was not started: ${String(error)}`);
  }
  async prepare(jobId: string, resultDirectory?: string): Promise<ContainmentRef> {
    const brokerEpoch = await this.ensure();
    const ref: ContainmentRef = { version: 1, jobId, generation: randomUUID(), brokerEpoch };
    let result: ContainmentRef;
    try{result=await bridgeCall(this.config, { ...ref, op: 'prepare', requestId: randomUUID(), resultDirectory }) as ContainmentRef;
      if (!sameContainment(ref, result)) throw new Error('prepare identity mismatch');
    }
    catch(error){
      const record=readContainment(ref,this.config),directory=resultDirectory;
      if(directory)recordJobFailure(directory,`Containment prepare failed: ${(error as Error).message}`);
      if(record)await this.terminate(ref);
      throw error;
    }
    return ref;
  }
  private async call(ref: ContainmentRef, op: string, extra: object = {}): Promise<unknown> {
    const record = readContainment(ref, this.config);
    if (!record) throw new Error('containment record missing or identity mismatch');
    return bridgeCall(this.config, { ...ref, op, requestId: randomUUID(), capability: op === 'register' ? record.launchCapability : record.controlCapability, ...extra });
  }
  async register(ref: ContainmentRef): Promise<void> {
    const record = readContainment(ref, this.config);
    if (!record) throw new Error('containment record missing or identity mismatch');
    const request = { ...ref, op: 'register', requestId: randomUUID(), capability: record.launchCapability };
    const failures: string[] = [];
    const deadline = performance.now() + 50000;
    // Keep requestId AND payload: the broker authenticates the original runner's
    // PID/birth before replay. Never prepare a replacement generation on failure.
    for (let attempt = 0; ; attempt++) {
      try {
        if (performance.now() >= deadline) throw new Error('register total deadline exhausted');
        const result = await bridgeCall(this.config, request, deadline) as ContainmentRef & { ready?: boolean };
        if (result.ready !== true || !sameContainment(result, ref)) throw new Error('READY identity mismatch; worker was not started');
        return;
      } catch (error) {
        failures.push((error as Error).message);
        if (!(error instanceof ContainmentTransportError) || attempt >= 2) throw new Error(`Containment register failed after ${attempt + 1} attempt(s): ${failures.join(' | ')}`);
        const delay = 100 * 2 ** attempt;
        if (deadline - performance.now() <= delay) throw new Error(`Containment register total deadline exhausted: ${failures.join(' | ')}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  async inspect(ref: ContainmentRef): Promise<ContainmentStatus> {
    if (drainedProof(ref, this.config)) return { state: 'drained', runnerExited: true, activeProcesses: 0, termination: readContainment(ref, this.config)?.termination };
    try {
      const status = await this.call(ref, 'inspect') as ContainmentStatus;
      if (status.state === 'drained' && !drainedProof(ref, this.config)) return { state: 'unknown', reason: 'drained proof not durable' };
      if (!['active', 'preparing', 'drained'].includes(status.state)) return { state: 'unknown', reason: 'invalid broker response' };
      return status;
    } catch (error) {
      // A previous-boot record needs a live broker to publish a reboot proof.
      // Missing records never trigger recreation or a legacy downgrade.
      if(readContainment(ref,this.config))try{const epoch=await this.ensure();await bridgeCall(this.config,{...ref,op:'recover',brokerEpoch:epoch,targetEpoch:ref.brokerEpoch});if(drainedProof(ref,this.config))return {state:'drained',runnerExited:true,activeProcesses:0};}catch{}
      return { state: 'unknown', reason: `containment_lost or unavailable: ${(error as Error).message}` };
    }
  }
  async terminate(ref: ContainmentRef, reason: 'kill' | 'timeout' = 'kill'): Promise<ContainmentStatus> {
    if (drainedProof(ref, this.config)) return this.inspect(ref);
    try { await this.call(ref, 'terminate', { reason }); }
    catch (error) { return { state: 'unknown', reason: `termination unconfirmed: ${(error as Error).message}` }; }
    for (let i = 0; i < 6; i++) {
      const status = await this.inspect(ref);
      if (status.state === 'drained' || status.state === 'unknown') return status;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { state: 'unknown', reason: 'job has not drained after termination' };
  }
}
/** runner 不可用 execFile 建立 libuv kill-on-close 子 job；查身分也走 detached bridge。 */
export const lookupNativeIdentities: IdentityLookup = async pids => {
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('invalid identity PID');
  const rows = JSON.parse(await powershell(nativeScript(`[AiCliContainment]::Identities([int[]]@(${pids.join(',')}))`)));
  return new Map(rows.map((row: { pid: number; started: string; name: string }) => [row.pid, row]));
};
