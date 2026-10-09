#!/usr/bin/env node
/** Opt-in 真模型重啟驗收；入口可注入 stub，npm test 不派真模型。 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processSnapshot, command } from './worker-identity-runtime.mjs';
import { processKey, creationTime } from './worker-identity-logic.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FAMILIES = ['claude', 'codex', 'grok'];
const DEFAULTS = [{ family: 'claude', model: 'haiku' }, { family: 'codex', model: 'gpt-6.1-sol' }, { family: 'grok', model: 'grok-4.7-build-fast' }];
export const HELP = `重啟接回驗收（會呼叫真模型，消耗額度；不屬於 npm test）
用法：npm run verify:restart-recovery -- [--family claude,codex,grok] [--models haiku,gpt-6.1-sol,grok-4.7-build-fast]
  --out <dir>       Markdown + JSON 報告目錄（預設獨立暫存目錄）
  --timeout <sec>   結果等待上限，預設 240 秒
  --help            只顯示說明
每家明確送 reasoning_effort medium；獨立 state/work 目錄，8 秒後重啟 MCP。
`;
export function parseArgs(args) {
  const options = { timeoutMs: 240000, restartMs: 8000 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!['--family', '--models', '--out', '--timeout'].includes(flag)) throw Error(`Unknown option: ${flag}`);
    const value = args[++i]; if (!value || value.startsWith('--')) throw Error(`${flag} requires a value`);
    if (flag === '--out') options.out = resolve(value);
    else if (flag === '--timeout') { const n = Number(value); if (!Number.isFinite(n) || n <= 0 || n > 86400) throw Error('Invalid timeout'); options.timeoutMs = n * 1000; }
    else { const values = value.split(',').map(s => s.trim()).filter(Boolean); if (!values.length) throw Error(`${flag} is empty`); options[flag === '--family' ? 'families' : 'models'] = values; }
  }
  if (options.families?.some(f => !FAMILIES.includes(f))) throw Error('Only claude,codex,grok support this acceptance');
  return options;
}
export function selectJobs(options, familyFor) {
  const jobs = options.models ? [...new Set(options.models)].map(model => ({ model, family: familyFor(model) })) : DEFAULTS;
  if (jobs.some(j => !FAMILIES.includes(j.family))) throw Error('Selected model does not support durable recovery');
  const selected = jobs.filter(j => !options.families || options.families.includes(j.family));
  if (!selected.length) throw Error('No models selected');
  return selected.map(j => ({ ...j, reasoning_effort: 'medium' }));
}
export const recoveryPrompt = family => `用 shell 執行一次並等結束：Windows 用 ping -n 25 127.0.0.1；POSIX 用 sleep 25。完成後只回一行 DONE-${family}。不要派工或做其他事。`;
const cell = v => String(v ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
export function renderReport(report) {
  return `# Restart recovery acceptance\n\n${report.startedAt}；${report.status}\n\nState: ${report.stateDir}\n\n| Family | Model | PID | jobId | Recovered/running | Result | Session | Usage | Verdict |\n|---|---|---|---|---|---|---|---|---|\n`
    + report.jobs.map(j => `| ${j.family} | ${cell(j.model)} | ${j.pid ?? '—'} | ${cell(j.jobId)} | ${!!j.recovered?.recovered}/${j.recovered?.status ?? '—'} | ${j.result?.status ?? '—'} | ${cell(j.result?.session_id ?? j.result?.agentOutput?.session_id)} | ${!!j.result?.agentOutput?.usage} | ${j.passed ? 'PASS' : 'FAIL'} |`).join('\n')
    + `\n\nStore jobs: ${report.storeCount ?? '—'} / expected ${report.jobs.length}\n\n`
    + [...report.errors, ...report.cleanupErrors].map(e => `- ${cell(e)}`).join('\n') + '\n';
}
/** 流程與真 CLI 完全分離；deps 可用記憶體 stub，也可用真 MCP + stub vendor。 */
export async function runRecovery(options, deps) {
  const jobs = selectJobs(options, deps.familyFor);
  const report = { startedAt: new Date().toISOString(), status: 'running', jobs: jobs.map(j => ({ ...j })), errors: [], cleanupErrors: [] };
  let first, second;
  const checkStopped = () => { if (deps.control?.stopped) throw Error('Acceptance interrupted'); };
  const save = async () => {
    await writeFile(join(report.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(report.out, 'report.md'), renderReport(report));
  };
  try {
    report.out = options.out ?? await mkdtemp(join(tmpdir(), 'ai-cli-restart-report-'));
    await mkdir(report.out, { recursive: true });
    report.stateDir = await mkdtemp(join(tmpdir(), 'ai-cli-restart-state-'));
    report.workFolder = await mkdtemp(join(tmpdir(), 'ai-cli-restart-work-'));
    await save();
    first = await deps.server(report.stateDir); await first.init();
    for (const job of report.jobs) {
      checkStopped();
      const started = await first.call('run', { model: job.model, reasoning_effort: 'medium', workFolder: report.workFolder, prompt: recoveryPrompt(job.family) });
      if (!Number.isSafeInteger(started.pid) || started.pid <= 0) throw Error(`run ${job.family} returned no PID`);
      Object.assign(job, { pid: started.pid, jobId: started.jobId });
      await deps.capture(report.stateDir); await save();
    }
    const restartAt = deps.now() + options.restartMs;
    while (deps.now() < restartAt) { checkStopped(); await deps.sleep(Math.min(1000, restartAt - deps.now())); await deps.capture(report.stateDir); }
    await first.stop();
    second = await deps.server(report.stateDir); await second.init();
    const listed = await second.call('list_processes');
    if (!Array.isArray(listed) || listed.length !== jobs.length) throw Error('Recovered list count differs from dispatch count');
    for (const job of report.jobs) {
      job.recovered = listed.find(row => job.jobId ? row.jobId === job.jobId : row.pid === job.pid);
      if (!job.recovered?.recovered || job.recovered.status !== 'running') throw Error(`${job.family}: expected recovered:true and running`);
      job.jobId ??= job.recovered.jobId;
    }
    await save();
    const deadline = deps.now() + options.timeoutMs;
    while (deps.now() < deadline && report.jobs.some(j => !j.result)) {
      checkStopped();
      for (const job of report.jobs.filter(j => !j.result)) {
        const result = await second.call('get_result', { pid: job.pid, ...(job.jobId ? { jobId: job.jobId } : {}) });
        if (result.status !== 'running') {
          job.result = result;
          const output = result.agentOutput;
          job.passed = result.status === 'completed' && result.recovered === true
            && (output?.message ?? output?.result ?? '').includes('DONE-' + job.family)
            && !!(result.session_id ?? output?.session_id) && !!output?.usage
            && (!job.jobId || result.jobId === job.jobId);
          if (!job.passed) report.errors.push(`${job.family}/${job.model}: recovered result incomplete or failed`);
        }
      }
      await deps.capture(report.stateDir); await save();
      if (report.jobs.some(j => !j.result)) await deps.sleep(1000);
    }
    for (const job of report.jobs.filter(j => !j.result)) report.errors.push(`${job.family}/${job.model}: timed out`);
    const metas = await deps.metas(report.stateDir); report.storeCount = metas.length;
    if (metas.length !== report.jobs.length || report.jobs.some(j => !metas.some(m => m.jobId === j.jobId && m.pid === j.pid))) report.errors.push('Store count/UUID differs: job missing or redispatched');
    report.status = report.errors.length ? 'failed' : 'passed';
  } catch (error) { report.errors.push(error.message); report.status = 'failed'; }
  finally {
    if (report.stateDir) {
      try { await deps.capture(report.stateDir); } catch (e) { report.cleanupErrors.push(e.message); }
      try { report.cleanupErrors.push(...await deps.cleanup(report.stateDir)); } catch (e) { report.cleanupErrors.push(e.message); }
    }
    for (const server of [second, first].filter(Boolean)) try { await server.stop(); } catch (e) { report.cleanupErrors.push(e.message); }
    if (report.cleanupErrors.length) report.status = 'failed';
    if (report.out) await save();
  }
  return { report, exitCode: report.status === 'passed' ? 0 : 1 };
}

/** 每個 PID 都重查 name、command、建立時間；個別終止，不使用 /T 或批次 node。 */
export async function stopOwned(expected, deps) {
  const current = (await deps.snapshot()).find(p => p.pid === expected.pid);
  if (!current) return;
  if (creationTime(expected) === null || processKey(current) !== processKey(expected) || current.name !== expected.name || current.command !== expected.command) throw Error(`Refusing unverified/reused PID ${expected.pid}`);
  await deps.kill(current.pid);
}
/** 直接子行程必須通過全部核對；診斷保留候選，絕不拿相近的行程取代。 */
export function verifySpawnedServer(rows, pid, ppid, platform = process.platform) {
  const checks = p => ({ pid: p.pid === pid, ppid: p.ppid === ppid,
    node: /^(node|nodejs)(\.exe)?$/i.test(p.name.replace(/^.*[\\/]/, '')),
    command: p.command.includes('ai-cli-mcp.js'), started: creationTime(p) !== null });
  const identity = rows.find(p => Object.values(checks(p)).every(Boolean));
  if (!identity) throw Error('Cannot verify spawned Node MCP server: ' + JSON.stringify({
    platform, expectedPid: pid, expectedPpid: ppid, snapshotCount: rows.length,
    candidates: rows.filter(p => p.pid === pid || p.ppid === ppid || p.command.includes('ai-cli-mcp.js'))
      .map(p => ({ pid: p.pid, ppid: p.ppid, name: p.name, command: p.command.slice(0, 120), checks: checks(p) })),
  }));
  return identity;
}
export async function liveDeps() {
  const { readJobMetas, sameIdentity } = await import('../../dist/core/job-store.js');
  const { lookupIdentities } = await import('../../dist/core/live-jobs.js');
  const { selectAgentForModel } = await import('../../dist/agents/registry.js');
  const owned = new Map();
  const snapshot = () => processSnapshot();
  const safety = { snapshot, kill: async pid => {
    if (process.platform === 'win32') { const r = await command('taskkill.exe', ['/PID', String(pid), '/F']); if (r.code) throw Error(r.stderr); }
    else process.kill(pid, 'SIGKILL');
  } };
  const remember = p => { if (p && creationTime(p) !== null) owned.set(processKey(p), p); };
  const capture = async state => {
    const rows = await snapshot(), metas = readJobMetas(state);
    const ids = await lookupIdentities([process.pid, ...metas.flatMap(m => [m.runner.pid, ...(m.worker ? [m.worker.pid] : [])])]);
    for (const meta of metas) {
      if (!sameIdentity(meta.principal, ids.get(process.pid))) continue;
      for (const id of [meta.runner, meta.worker].filter(Boolean)) if (sameIdentity(id, ids.get(id.pid))) remember(rows.find(p => p.pid === id.pid));
    }
    let changed;
    do { changed = false; for (const p of rows) {
      if (owned.has(processKey(p))) continue;
      const parent = rows.find(a => a.pid === p.ppid && owned.has(processKey(a)));
      if (parent && creationTime(p) !== null && creationTime(p) >= creationTime(parent)) { remember(p); changed = true; }
    } } while (changed);
  };
  return { familyFor: model => selectAgentForModel(model).id, now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)), capture,
    metas: async state => readJobMetas(state),
    cleanup: async () => { const errors = []; for (const p of [...owned.values()].reverse()) { try { await stopOwned(p, safety); } catch (e) { errors.push(e.message); } } return errors; },
    server: async state => {
      const child = spawn(process.execPath, [join(ROOT, 'dist/bin/ai-cli-mcp.js')], { env: { ...process.env, AI_CLI_STATE_DIR: state, AI_CLI_AUTO_UPDATE: 'off' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let identity, buffer = '', stderr = '', seq = 0, closed = false; const pending = new Map();
      const closedPromise = new Promise(r => child.once('close', () => { closed = true; r(); }));
      child.stdin.on('error', () => {}); child.stderr.on('data', b => stderr += b);
      const rejectAll = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
      child.on('error', rejectAll); child.on('close', () => rejectAll(Error('MCP server closed: ' + stderr.slice(-2000))));
      child.stdout.setEncoding('utf8').on('data', b => {
        buffer += b; let at; while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          const p = pending.get(m.id); if (!p) continue; clearTimeout(p.timer); pending.delete(m.id);
          m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
        }
      });
      const send = (method, params) => new Promise((resolve, reject) => {
        if (closed) { reject(Error('MCP server closed')); return; }
        const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout ${method}: ${stderr.slice(-2000)}`)); }, 60000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      const stop = async () => { if (closed) return; if (!identity) throw Error('MCP server identity unavailable'); await stopOwned(identity, safety); await closedPromise; };
      // spawn 的直接子行程，核對 Node 身分與命令；未核對的行程絕不終止。
      let rows;
      try { rows = await snapshot(); }
      catch (error) { child.stdin.end(); throw Error(`Cannot snapshot spawned MCP server pid=${child.pid} ppid=${process.pid}: ${error.message}`); }
      try { identity = verifySpawnedServer(rows, child.pid, process.pid); }
      catch (error) { child.stdin.end(); throw error; }
      remember(identity);
      return { child, stop, init: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'restart-recovery', version: '1' } }),
        call: async (name, args = {}) => { const r = await send('tools/call', { name, arguments: args }); if (r.isError) throw Error(JSON.stringify(r)); return JSON.parse(r.content.find(c => c.type === 'text').text); } };
    } };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const options = parseArgs(process.argv.slice(2)); if (options.help) console.log(HELP);
    else {
      const deps = await liveDeps(); deps.control = { stopped: false };
      const stop = () => { deps.control.stopped = true; };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      try { const { report, exitCode } = await runRecovery(options, deps); console.log(`${report.status}: ${report.out}`); process.exitCode = exitCode; }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
