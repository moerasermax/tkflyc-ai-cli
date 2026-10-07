/** 唯讀靜態檢查、跨平台行程監控與安全收尾；模型啟動由 MCP 的 ProcessService 負責。 */
import { execFile } from 'node:child_process';
import { readFile, lstat, readdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import {
  LEADER_TITLE, WORKER_TITLE, hookFirstLine, commandTokens, processKey, ancestorPids,
  newWorkers, isRecursive, toolRecords, unblockedAiCliTools, creationTime, createOwnershipTracker,
} from './worker-identity-logic.mjs';

const exec = promisify(execFile);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function command(file, args, options = {}, deps = {}) {
  const execute = deps.exec ?? exec;
  const platform = deps.platform ?? process.platform;
  try {
    // /s /c 的命令引號由這裡處理；禁止 Node 再為含引號的參數加一層跳脫。
    if (platform === 'win32' && /\.cmd$/i.test(file)) {
      if (args.some(a => !/^[\w.-]+$/.test(a)) || /["%\r\n]/.test(file)) throw new Error('不安全的 cmd shim 參數');
      const result = await execute(deps.comSpec ?? process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`],
        { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024, ...options, windowsVerbatimArguments: true });
      return { ...result, code: 0 };
    }
    return { ...await execute(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024, ...options }), code: 0 };
  } catch (e) {
    return { code: Number.isInteger(e.code) ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
  }
}

export function expandPath(path, home = homedir()) {
  return path.replace(/^~(?=[\\/]|$)/, home).replace(/\$\{HOME\}|\$HOME|%USERPROFILE%/gi, home);
}

export function sessionReferences(settings, hookPath, home = homedir()) {
  const start = settings.hooks?.SessionStart ?? settings.SessionStart;
  if (!start) return false;
  const normalize = s => {
    const path = resolve(expandPath(s, home)).replace(/\\/g, '/');
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  const wanted = normalize(hookPath);
  const commands = [];
  const visit = obj => {
    if (typeof obj === 'string') commands.push(obj);
    else if (Array.isArray(obj)) obj.forEach(visit);
    else if (obj && typeof obj === 'object') Object.values(obj).forEach(visit);
  };
  visit(start);
  return commands.some(c => commandTokens(c).some(token => normalize(token) === wanted));
}

export async function staticChecks(options, deps = {}) {
  const run = deps.command ?? hookCommand;
  const read = deps.readFile ?? readFile;
  const home = deps.home ?? homedir();
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  try {
    const [installed, canonical] = await Promise.all([read(options.hook), read(options.canonicalHook)]);
    add('hook 逐位元組比對', Buffer.from(installed).equals(Buffer.from(canonical)) ? 'PASS' : 'FAIL', `${options.hook} ↔ ${options.canonicalHook}`);
  } catch (e) { add('hook 逐位元組比對', 'FAIL', e.message); }
  for (const [worker, title] of [[false, LEADER_TITLE], [true, WORKER_TITLE]]) {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    delete env.AI_CLI_WORKER;
    if (worker) env.AI_CLI_WORKER = '1';
    const response = await run(options.python, [options.hook], { env, input: '{}' });
    try {
      const first = hookFirstLine(response.stdout);
      add(worker ? 'worker hook 標題' : '主導者 hook 標題', response.code === 0 && first === title ? 'PASS' : 'FAIL', first);
    } catch (e) { add(worker ? 'worker hook 標題' : '主導者 hook 標題', 'FAIL', response.stderr || e.message); }
  }
  for (const name of ['.claude/settings.json', '.codex/hooks.json']) {
    try {
      const found = sessionReferences(JSON.parse(await read(join(home, name), 'utf8')), options.hook, home);
      add(`${name} SessionStart`, found ? 'PASS' : 'WARN', found ? '引用已安裝的 hook' : '找不到該 hook 引用；請主導者確認安裝，本工具不修改設定');
    } catch (e) { add(`${name} SessionStart`, 'WARN', `設定不存在或無法解析：${e.message}`); }
  }
  const version = await run(options.codexPath ?? 'codex', ['--version']);
  const match = version.stdout.match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  const sufficient = match && (Number(match[1]) > 0 || Number(match[2]) >= 160);
  add('codex --version', version.code === 0 && sufficient ? 'PASS' : 'WARN',
    `${version.stdout.trim() || version.stderr.trim() || '無法取得版本'}；gpt-6.1-sol 需要 ≥0.160`);
  return checks;
}

/** Python hook 會讀到 EOF；所有帶 input 的命令以 pipe 寫入再 end。 */
export async function hookCommand(file, args, options = {}) {
  if (options.input === undefined) return command(file, args, options);
  return new Promise(resolveResult => {
    const { input, ...rest } = options;
    const child = execFile(file, args, { windowsHide: true, timeout: 15000, ...rest }, (error, stdout, stderr) => {
      resolveResult({ code: error ? 1 : 0, stdout, stderr: stderr || error?.message || '' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function parseWindowsSnapshot(json) {
  const parsed = JSON.parse(json || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(p => ({
    pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: p.Name ?? '',
    command: p.CommandLine ?? '', started: p.CreationDate ?? '',
  }));
}
export function parsePosixSnapshot(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s*(.*)$/);
    if (!m) throw new Error(`無法解析 ps：${line}`);
    return { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], started: m[4], command: m[5] };
  });
}
export async function processSnapshot(run = command) {
  const win = process.platform === 'win32';
  const result = win
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name="CreationDate";Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString("o")} else {""}}}) | ConvertTo-Json -Compress'])
    : await run('ps', ['-axo', 'pid=,ppid=,comm=,lstart=,args='], { env: { ...process.env, LC_ALL: 'C' } });
  if (result.code !== 0) throw new Error(`行程掃描失敗：${result.stderr}`);
  return win ? parseWindowsSnapshot(result.stdout) : parsePosixSnapshot(result.stdout);
}

const isNode = p => /^(?:node|nodejs)(?:\.exe)?$/i.test(p.name.replace(/^.*[\\/]/, ''));

/** 每個目標都重查身分再逐 PID 收尾；不用 /T，避免殺掉未核對的即時新子行程。 */
export async function terminateTrees(snapshot, roots, protectedPids, run = command, platform = process.platform, safety = {}) {
  const errors = [];
  const killed = new Set();
  const refresh = safety.snapshot ?? (() => processSnapshot(run));
  const warn = safety.warn ?? (message => console.warn(message));
  for (const pid of roots) {
    if (protectedPids.has(pid)) continue;
    if (!snapshot.some(p => p.pid === pid)) { warn(`擊殺跳過：PID ${pid} 已消失`); continue; }
    // root 的其他 baseline 行程不能做 excluded；當前子樹另以建立順序驗證。
    const tree = [snapshot.find(p => p.pid === pid)].filter(Boolean);
    let changed;
    do {
      changed = false;
      for (const p of snapshot) if (!tree.includes(p) && tree.some(parent => parent.pid === p.ppid
        && creationTime(parent) !== null && creationTime(p) !== null && creationTime(parent) < creationTime(p))) {
        tree.push(p); changed = true;
      }
    } while (changed);
    const targets = tree.filter(p => !protectedPids.has(p.pid) && !isNode(p));
    if (tree.some(isNode)) errors.push(`PID ${pid} 子樹含 node：保留 node，只終止其他 PID`);
    for (const p of targets.reverse()) {
      if (killed.has(processKey(p))) continue;
      if (creationTime(p) === null || (safety.ownedKeys && !safety.ownedKeys.has(processKey(p)))) {
        warn(`擊殺跳過：PID ${p.pid} 缺建立時間或不屬於本次 run`); continue;
      }
      const current = (await refresh()).find(candidate => candidate.pid === p.pid);
      if (!current || processKey(current) !== processKey(p) || isNode(current)) {
        warn(`擊殺跳過：PID ${p.pid} 建立時間不符、已消失或目前是 node`); continue;
      }
      const response = platform === 'win32'
        ? await run('taskkill.exe', ['/PID', String(p.pid), '/F'])
        : await run('kill', ['-KILL', String(p.pid)]);
      if (response.code) errors.push(`kill ${p.pid}：${response.stderr}`);
      killed.add(processKey(p));
    }
  }
  return errors;
}

/** 與 MCP run 相同的 service；raw tap 只讀，避免 verbose 解析結果隱藏 stderr/未完成的工具事件。 */
export function serviceAdapter(service) {
  return {
    start: options => service.startProcess(options),
    read: pid => {
      const entry = service.processManager?.get(pid);
      if (!entry || typeof entry.stdout !== 'string' || typeof entry.stderr !== 'string') {
        throw new Error('ProcessService raw tap 結構已改變，停止驗收（不能假設沒有工具紀錄）');
      }
      const result = service.getProcessResult(pid, true);
      return { result, stdout: entry.stdout, stderr: entry.stderr,
        tools: [...toolRecords(entry.stdout, entry.stderr), ...(result.agentOutput?.tools ?? [])] };
    },
    abortDirect: pid => service.killProcess(pid),
  };
}

/** 每次 run 回傳後立刻存證，不能只保留即將失效的暫存 sessionPath。 */
export async function preserveRunEvidence(run, { family, workFolder, out, prefix }) {
  const sources = new Set();
  const sessionPath = run.result?.agentOutput?.sessionPath;
  if (typeof sessionPath === 'string' && sessionPath) sources.add(resolve(workFolder, sessionPath));
  if (family === 'direct-api') {
    const directory = join(workFolder, '.tmp', 'api_sessions');
    try {
      for (const name of await readdir(directory)) if (name.endsWith('.json')) sources.add(join(directory, name));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const evidence = [];
  for (const source of sources) {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`session 證據不是一般檔案：${source}`);
    const path = `evidence/${prefix}-session-${evidence.length + 1}${source.endsWith('.jsonl') ? '.jsonl' : '.json'}`;
    await copyFile(source, join(out, path));
    evidence.push({ kind: 'session', source, path });
  }
  return evidence;
}

/** 原始輸出已擷取並存證後，釋放已結束 job 的 pipe；不終止任何仍在跑的行程。 */
export function releaseCompletedStreams(service) {
  for (const entry of service?.processManager?.values() ?? []) {
    if (entry.status === 'running') continue;
    for (const stream of ['stdin', 'stdout', 'stderr']) entry.process?.[stream]?.destroy?.();
    entry.process?.unref?.();
  }
}

/** 可注入時鐘／快照／service 的監控流程，stub 不需要啟動任何 vendor。 */
export async function runMonitored(options, deps) {
  const { snapshot, adapter, terminate, control = {}, selfPid = process.pid,
    now = Date.now, pause = sleep, scanMs = 5000, settleMs = 30000 } = deps;
  const baselineSnapshot = await snapshot();
  const baseline = new Set(baselineSnapshot.map(processKey));
  const ancestors = ancestorPids(baselineSnapshot, selfPid);
  const protectedPids = new Set([...ancestors, ...baselineSnapshot.map(p => p.pid)]);
  const ownership = createOwnershipTracker(baselineSnapshot, selfPid);
  const tracked = new Set(); // 只追 vendor 樹的身分；不把掃描器算成殘留行程。
  const started = now();
  const state = { peak: 0, timedOut: false, cleanupErrors: [], warnings: [], baseline: [...baseline], ancestors: [...ancestors] };
  const warnedExternal = new Set();
  let active;
  let latest = baselineSnapshot;
  let lastScan = -Infinity;
  let stopping = false;
  let clean = 0;
  let delayedScanAt = null;
  let stoppedAt = null;
  const cleanupDeadline = () => stoppedAt !== null && now() - stoppedAt > 120000;
  const sample = async () => {
    latest = await snapshot();
    ownership.observe(latest, now());
    const candidates = newWorkers(latest, baseline, ancestors);
    // 這個 PID 集合只由當次快照中已驗明身分的行程建立，絕不跨快照累積 PID。
    const owned = new Set(latest.filter(p => ownership.has(p)).map(p => p.pid));
    const workers = candidates.filter(p => owned.has(p.pid));
    for (const p of candidates) if (!ownership.has(p) && !warnedExternal.has(processKey(p))) {
      warnedExternal.add(processKey(p));
      state.warnings.push(`外部 worker（不計數、不終止）PID ${p.pid}：${p.command.slice(0, 120)}`);
    }
    for (const p of workers) tracked.add(processKey(p));
    let changed;
    do {
      changed = false;
      for (const p of latest) if (ownership.has(p) && !tracked.has(processKey(p)) && (p.pid === active?.pid
        || latest.some(parent => parent.pid === p.ppid && tracked.has(processKey(parent))
          && creationTime(parent) < creationTime(p)))) { tracked.add(processKey(p)); changed = true; }
    } while (changed);
    for (const p of latest) if (creationTime(p) === null && !warnedExternal.has(`missing:${p.pid}`)) {
      warnedExternal.add(`missing:${p.pid}`); state.warnings.push(`PID ${p.pid} 缺建立時間：不推定子孫，不擊殺`);
    }
    state.peak = Math.max(state.peak, workers.length);
    return workers;
  };
  try {
    if (control.stopped) throw new Error(`已中斷：${control.stopped}`);
    active = adapter.start(options.start);
    state.pid = active.pid;
    state.agent = active.agent;
    while (true) {
      Object.assign(state, adapter.read(active.pid));
      const elapsed = now() - started;
      if (control.stopped) state.stopReason = `使用者中斷：${control.stopped}`;
      if (elapsed >= options.timeoutMs) state.timedOut = true;
      if (state.timedOut || state.stopReason || unblockedAiCliTools(state).length) stopping = true;
      const finished = state.result.status !== 'running';
      if (now() - lastScan >= scanMs || finished || stopping) {
        const workers = await sample();
        lastScan = now();
        if (isRecursive(state.peak)) stopping = true;
        if (stopping) {
          stoppedAt ??= now();
          if (active.agent === 'direct-api' && state.result.status === 'running') adapter.abortDirect(active.pid);
          const roots = [...new Set([
            ...workers.map(p => p.pid),
            ...latest.filter(p => ownership.has(p) && tracked.has(processKey(p)) && !protectedPids.has(p.pid)).map(p => p.pid),
          ])];
          state.cleanupErrors.push(...await terminate(latest, roots, protectedPids,
            { ownedKeys: ownership.owned, snapshot, warn: message => state.warnings.push(message) }));
          const runningOwned = latest.some(p => ownership.has(p) && tracked.has(processKey(p)) && !protectedPids.has(p.pid));
          if (!workers.length && !runningOwned) clean++; else clean = 0;
          if (clean >= 2 && delayedScanAt === null) delayedScanAt = now() + settleMs;
          if (delayedScanAt !== null && now() >= delayedScanAt) {
            if (!workers.length && !runningOwned) break;
            delayedScanAt = null;
            clean = 0;
          }
          if (cleanupDeadline()) {
            state.cleanupBlocked = true;
            state.cleanupErrors.push('收尾期限內無法確認子樹消失；停止後續模型');
            break;
          }
        } else if (finished && !workers.length) break;
      }
      await pause(scanMs);
    }
    Object.assign(state, adapter.read(active.pid));
  } catch (e) {
    state.monitorError = e.message;
    if (active) {
      if (active.agent === 'direct-api') adapter.abortDirect(active.pid);
      try {
        await sample();
        const roots = latest.filter(p => ownership.has(p) && tracked.has(processKey(p)) && !protectedPids.has(p.pid)).map(p => p.pid);
        state.cleanupErrors.push(...await terminate(latest, roots, protectedPids,
          { ownedKeys: ownership.owned, snapshot, warn: message => state.warnings.push(message) }));
        Object.assign(state, adapter.read(active.pid));
      } catch (cleanup) { state.cleanupErrors.push(cleanup.message); }
      // 監控失明後不啟動下一顆，以免遺留 worker 與下一顆重疊。
      state.cleanupBlocked = true;
    }
  }
  state.elapsedMs = now() - started;
  state.ownedIdentities = [...ownership.owned];
  state.ownedPids = [...new Set(state.ownedIdentities.map(key => Number(key.split(':')[0])))];
  state.cleanupErrors = [...new Set(state.cleanupErrors)];
  return state;
}

/** 除了執行自測，再驗 add 的數值行為與 __main__ 下確實有 assert。 */
export async function verifyAdd(path, python, run = command) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { passed: false, reason: 'add.py 必須是暫存目錄中的一般檔案' };
  } catch { return { passed: false, reason: 'add.py 不存在' }; }
  const self = await run(python, ['-B', path], { timeout: 15000 });
  if (self.code !== 0) return { passed: false, reason: `直接執行失敗：${self.stderr}`, selfExitCode: self.code };
  const verifier = [
    'import ast, runpy, sys',
    'p = sys.argv[1]',
    'with open(p, encoding="utf-8-sig") as f: tree = ast.parse(f.read())',
    'guards = [n for n in ast.walk(tree) if isinstance(n, ast.If) and "__name__" in ast.unparse(n.test) and "__main__" in ast.unparse(n.test)]',
    'assert any(isinstance(n, ast.Assert) for g in guards for body in g.body for n in ast.walk(body)), "missing __main__ assert"',
    'add = runpy.run_path(p)["add"]',
    'for a,b in [(2,3),(-2,1),(0,0),(1.25,2.5)]: assert add(a,b) == a+b, "incorrect add"',
  ].join('\n');
  const tested = await run(python, ['-B', '-c', verifier, path], { timeout: 15000 });
  return { passed: tested.code === 0, reason: tested.code === 0 ? '直接自測與外部 add 行為檢查通過' : tested.stderr,
    selfExitCode: self.code, verifierExitCode: tested.code };
}

export async function gitSnapshot(folder, run = command) {
  const head = await run('git', ['-C', folder, 'rev-parse', 'HEAD']);
  if (head.code !== 0) return null;
  const status = await run('git', ['-C', folder, 'status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) throw new Error(`git status 失敗：${status.stderr}`);
  return { head: head.stdout.trim(), status: status.stdout.trimEnd() };
}
export function gitChanges(before, after) {
  if (!before && !after) return [];
  if (!before || !after) return ['git repo 狀態變得無法取得'];
  const changes = [];
  if (before.head !== after.head) changes.push(`HEAD ${before.head} → ${after.head}`);
  if (before.status !== after.status) {
    const old = new Set(before.status.split('\n').filter(Boolean));
    const current = new Set(after.status.split('\n').filter(Boolean));
    changes.push(...[...old, ...current].filter(line => old.has(line) !== current.has(line)));
  }
  return changes;
}
