/** Windows containment 協定。識別碼不是授權；capability 僅存於 owner ACL registry。 */
import { join } from 'node:path';
import { homedir } from 'node:os';

export const WIN_JOB_PROTOCOL = 1;
export interface BrokerConfig { name: string; directory: string; idleMs: number }
export function brokerConfig(): BrokerConfig {
  // Only the verification harness sets these together. Never derive a production
  // broker from stateDir, installation path, version, or login session.
  const fixture = process.env.AI_CLI_CONTAINMENT_TEST;
  if (fixture) {
    const config = JSON.parse(fixture) as BrokerConfig;
    if (!/^TkflycAiCliContainmentBroker-test-[0-9a-f-]{36}$/.test(config.name) || !config.directory || config.idleMs !== 60000) throw new Error('invalid containment test namespace');
    return config;
  }
  // 不跟 AI_CLI_STATE_DIR／專案／版本／登入 session 分裂。
  return { name: 'TkflycAiCliContainmentBroker', directory: join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Tkflyc', 'AiCliContainment'), idleMs: 60000 };
}
export interface ContainmentRef { version: 1; jobId: string; generation: string; brokerEpoch: string }
export interface BrokerIdentity { version: number; epoch: string; pid: number; started: string; sid: string; bootId?: string }
export interface ContainmentRecord extends ContainmentRef {
  phase: 'preparing' | 'assigned' | 'released' | 'drained';
  bootId?: string;
  broker?: BrokerIdentity;
  runnerPid?: number; runnerStarted?: string;
  launchCapability: string; controlCapability: string;
  terminalProof?: { runnerExited: true; activeProcesses: 0; at: string };
  termination?: 'kill' | 'timeout' | 'reboot';
}
export interface ContainmentStatus {
  state: 'preparing' | 'active' | 'drained' | 'unknown';
  activeProcesses?: number; runnerExited?: boolean; reason?: string;
  termination?: 'kill' | 'timeout' | 'reboot';
}
export function sameContainment(a: ContainmentRef | undefined, b: ContainmentRef | undefined): boolean {
  return !!a && !!b && a.version === 1 && b.version === 1 && a.jobId === b.jobId && a.generation === b.generation && a.brokerEpoch === b.brokerEpoch;
}
