/**
 * 子孫程序追蹤：worker 退出後，被過繼的子孫（它在背景啟動的 node／測試／git）還在跑時，job 不能算「已消失」。
 *
 * runner 在 worker 存活期間定期列舉整張程序表，把 worker 的子孫（pid＋啟動時間）累積寫進 job 目錄的
 * tree.json，worker 結束後再列舉一次。之後由讀端拿同一份紀錄對當下的程序表重查（surveyTree）。
 * 不加原生模組：Windows 用 PowerShell 讀 Win32_Process，Linux 讀 /proc，其他 POSIX 用 ps。
 *
 * 兩條原則，衝突時以第一條為準：
 * 1. 寧可擋住，也不能誤殺別人的程序。只有「列舉當下父程序還活著、而且身分（pid＋啟動時間）對得上」這種直接證據，
 *    才把子程序列為確定（可終止）。時間上的推論（父程序剛死、時間窗很短、這是最後一次列舉）一律不算證據。
 * 2. 查不了就不能說「已消失」。程序表不完整、某個 pid 讀不出身分、追蹤中途有缺口，都要讓讀端擋住。
 *
 * 成員分三種：
 * - 確定：父程序活著時親眼看到的。終止時會砍，而且每一筆送出前再核對一次身分。
 * - loose：只有間接跡象（Windows：ParentProcessId 指向已經不在的已知成員；POSIX：和 worker 同一個 process group，
 *   但 group 裡沒有任何已記錄的成員還活著可以證明它沒被重用）。只擋「已消失」的判定，絕不自動終止。
 * - weak：啟動時間的精度不夠分辨 pid 重用（macOS 的 ps 只到秒，第一次看到它時還在它出生的那一秒內）。同樣只擋不殺。
 *
 * 追不到的：中間程序在兩次列舉之間出生又結束、從沒被記到時，它留下的子孫接不回來（Windows）；
 * POSIX 上先脫離 group（setsid／setpgid）、父程序又在下一次列舉前結束的子孫也一樣。
 */
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { atomicJson } from './job-store.js';
import { lookupIdentities, type IdentityLookup, type ProcessIdentity } from './live-jobs.js';

export const TREE_FILE = 'tree.json';
/** 兩次列舉之間的間隔。Windows 一次列舉要啟動 PowerShell（實測約 0.6 秒），太密會拖慢機器。 */
export const TREE_SCAN_MS = 5000;
/** 單次列舉的逾時。 */
export const TREE_SCAN_TIMEOUT_MS = 15000;
/** worker 存活期間，兩次成功列舉的開始時間最多可以相隔「間隔＋這個值」；超過就是追蹤缺口。剛好容得下一次慢列舉或一次失敗後的重試。 */
export const TREE_GAP_SLACK_MS = 17000;
/** worker 結束後，runner 為了補最後一次列舉最多再留多久。 */
export const TREE_SEAL_BUDGET_MS = 20000;
/** 被終止時，runner 補砍已記錄子孫最多再花多久。 */
export const TREE_KILL_BUDGET_MS = 15000;

const exec = promisify(execFile);

export interface ProcessRow { pid: number; ppid: number; pgid?: number; started: string; name: string }
export interface ProcessSnapshot {
  rows: ProcessRow[];
  /** 存在、但讀不出身分的 pid（沒有啟動時間、讀取被拒、看不懂的行）。父程序讀得出來就帶上，否則是 null。 */
  unknown: Array<{ pid: number; ppid: number | null }>;
  /** false＝表本身不完整（有連 pid 都看不出來的行）：缺席不能當成不存在。 */
  complete: boolean;
  /** 這次開機的識別。和紀錄裡的不同＝機器重開過，紀錄裡的程序不可能還在。取不到就沒有。 */
  boot?: string;
}
/** 列舉整張程序表。查不了要丟例外；讀不出來的個別 pid 放進 unknown，不能默默略過（會被讀成「不在了」）。 */
export type ProcessTable = (options?: { timeoutMs?: number }) => Promise<ProcessSnapshot>;

export interface TreeMember {
  pid: number;
  /** 和 lookupIdentities 同一種啟動時間 token。 */
  started: string;
  name: string;
  /** 第一次確認它不在的時間（ISO）。 */
  gone?: string;
  loose?: true;
  weak?: true;
}
/** worker。started 查不到時是空字串；since 是 runner 啟動它之前取的時間。 */
export interface TreeRoot { pid: number; started: string; name: string; since: string; gone?: string }
export interface TreeRecord {
  version: 2;
  platform: string;
  root: TreeRoot;
  members: TreeMember[];
  /** 成功（表完整）／失敗或不完整的列舉次數。檔案裡的 scans 可能比實際少：沒有新發現時不重寫。 */
  scans: number;
  failed: number;
  uncertainHistory?: true;
  intervalMs: number;
  /** worker 存活期間，最長一段沒有成功列舉的時間。 */
  maxGapMs: number;
  /** 最後一次成功列舉的開始時間。 */
  lastOk?: string;
  boot?: string;
  /** worker 結束的時間。 */
  ended?: string;
  /** worker 結束後成功列舉過一次。 */
  sealed?: true;
}

const DOTNET_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/;
/**
 * 兩個啟動時間的先後：負＝a 較早，比不出來回 null。
 * Windows 的 token 精度到 100 奈秒，格式固定，直接比字串；經過 Date 會被壓成毫秒，差不到一毫秒的先後會變成相等。
 */
export function compareStarted(a: string, b: string): number | null {
  if (DOTNET_UTC.test(a) && DOTNET_UTC.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = Date.parse(a), y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 其他 POSIX 的 ps 輸出：pid ppid pgid stat lstart(24 字元) comm。看不懂的行不能略過：讀得出 pid 就列為 unknown，否則整張表算不完整。 */
export function parsePsTable(stdout: string): Pick<ProcessSnapshot, 'rows' | 'unknown' | 'complete'> {
  const rows: ProcessRow[] = [], unknown: ProcessSnapshot['unknown'] = [];
  let complete = true;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/);
    if (!match) {
      const partial = line.trim().match(/^(\d+)(?:\s+(\d+))?/);
      if (partial) unknown.push({ pid: Number(partial[1]), ppid: partial[2] === undefined ? null : Number(partial[2]) });
      else complete = false;
      continue;
    }
    if (match[4].startsWith('Z')) continue; // zombie 不會再執行任何東西。
    const name = /^(?:npm|npx)(?:\s|$)/i.test(match[6]) ? match[6] : match[6].split('/').pop()!;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[5], name });
  }
  return { rows, unknown, complete };
}

export interface ProcReader { list(): string[]; stat(pid: string): string; boot(): string }
const realProc: ProcReader = {
  list: () => readdirSync('/proc'),
  stat: pid => readFileSync(`/proc/${pid}/stat`, 'utf8'),
  boot: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
};
/** Linux：讀 /proc。只有 ENOENT／ESRCH 代表程序在列舉途中結束；權限、I/O 或格式錯誤都是「存在但讀不出來」。 */
export function readProcTable(proc: ProcReader = realProc): ProcessSnapshot {
  const boot = proc.boot();
  const rows: ProcessRow[] = [], unknown: ProcessSnapshot['unknown'] = [];
  for (const entry of proc.list()) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let stat: string;
    try { stat = proc.stat(entry); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') unknown.push({ pid, ppid: null });
      continue;
    }
    const end = stat.lastIndexOf(')');
    const fields = end < 0 ? [] : stat.slice(end + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') continue;
    const ppid = Number(fields[1]), pgid = Number(fields[2]);
    if (fields.length < 20 || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !/^\d+$/.test(fields[19])) { unknown.push({ pid, ppid: null }); continue; }
    rows.push({ pid, ppid, pgid, started: `${boot}:${fields[19]}`, name: stat.slice(stat.indexOf('(') + 1, end) });
  }
  return { rows, unknown, complete: true, boot };
}

/** 真實的程序表。啟動時間的格式必須和 live-jobs 的 lookupIdentities 一致，meta 裡的身分才比得上。 */
export const listProcessTable: ProcessTable = async (options = {}) => {
  const timeout = Math.max(1000, options.timeoutMs ?? TREE_SCAN_TIMEOUT_MS);
  let snapshot: ProcessSnapshot;
  if (process.platform === 'win32') {
    const script = "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;started=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' });name=$_.Name} }) | ConvertTo-Json -Compress";
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || '[]');
    const rows: ProcessRow[] = [], unknown: ProcessSnapshot['unknown'] = [];
    let complete = true;
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!Number.isSafeInteger(row?.pid)) { complete = false; continue; }
      const ppid = Number.isSafeInteger(row.ppid) ? row.ppid : null;
      // 沒有建立時間的列（受保護的系統程序）認不出身分：它存在，但不能拿來比對。
      if (typeof row.started !== 'string' || !row.started || ppid === null) unknown.push({ pid: row.pid, ppid });
      else rows.push({ pid: row.pid, ppid, started: row.started, name: String(row.name ?? '') });
    }
    // System（pid 4）在開機時建立，它的建立時間就是這次開機的識別；不用另外查一次開機時間（那個值會隨校時漂移）。
    const system = rows.find(row => row.pid === 4);
    snapshot = { rows, unknown, complete, ...(system ? { boot: system.started } : {}) };
  } else if (process.platform === 'linux') {
    snapshot = readProcTable();
  } else {
    const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,comm='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout, maxBuffer: 32 * 1024 * 1024 });
    const boot = await exec('sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 5000 }).then(result => result.stdout.trim() || undefined, () => undefined);
    snapshot = { ...parsePsTable(stdout), ...(boot ? { boot } : {}) };
  }
  // 連自己都不在表裡，這張表就不可信。
  if (!snapshot.rows.some(row => row.pid === process.pid)) throw new Error('程序表不完整：找不到列舉者自己');
  return snapshot;
};

type MemberState = 'alive' | 'gone' | 'unknown';
const keyOf = (item: { pid: number; started: string }): string => `${item.pid}|${item.started}`;

export interface SurveyOptions {
  /** 這次列舉開始前、結束後的時間（毫秒）。 */
  before: number;
  now: number;
  platform?: string;
  /** runner 專用：它握著 worker 的 handle，列舉前後都還沒結束，所以那個 pid 一定是 worker。 */
  rootAlive?: boolean;
}
export interface TreeSurvey {
  record: TreeRecord;
  /** 身分對得上、還活著的子孫（不含 worker 本身；含 loose 與 weak）。 */
  alive: TreeMember[];
  /** 查不出狀態的已記錄成員：pid 還在但讀不出身分，或程序表不完整。不能當成不在了。 */
  unknown: TreeMember[];
  /** 存在、讀不出身分、父程序指向已知成員的 pid：可能是子孫，但記不下來。 */
  unverified: number[];
  /** 這張表不足以證明「沒有別的子孫」：表不完整，或有 pid 連父程序／group 都讀不出來。 */
  blind: boolean;
}

/** 純函式：拿紀錄對一張程序表，標出每個成員的狀態，並把新找到的子孫加進去。 */
export function surveyTree(input: TreeRecord, snapshot: ProcessSnapshot, options: SurveyOptions): TreeSurvey {
  const platform = options.platform ?? input.platform;
  const windows = platform === 'win32';
  // macOS 等用 ps 的平台，啟動時間只到秒。
  const coarse = !windows && platform !== 'linux';
  const nowIso = new Date(options.now).toISOString();
  const byPid = new Map(snapshot.rows.map(row => [row.pid, row]));
  const unknownPids = new Set(snapshot.unknown.map(item => item.pid));
  const held = options.rootAlive === true;
  const root = { ...input.root };
  const members = input.members.map(member => ({ ...member }));
  const rootRow = byPid.get(root.pid);
  // runner 還握著 handle 時，表裡那個 pid 就是 worker：趁這時補上當初沒查到的啟動時間。
  if (held && rootRow && !root.started) { root.started = rootRow.started; root.name = rootRow.name || root.name; }
  if (!held && !root.gone) root.gone = nowIso;
  const stateOf = (member: TreeMember): MemberState => {
    const row = byPid.get(member.pid);
    if (row) return row.started === member.started ? 'alive' : 'gone'; // 同一個 pid、啟動時間不同：原來那個已經結束，pid 被重用了。
    return unknownPids.has(member.pid) || !snapshot.complete ? 'unknown' : 'gone';
  };
  for (const member of members) if (!member.gone && stateOf(member) === 'gone') member.gone = nowIso;
  const known = new Set(members.map(keyOf));
  if (root.started) known.add(keyOf(root));
  const sureAlive = (member: TreeMember): boolean => !member.loose && !member.weak && stateOf(member) === 'alive';

  type Verdict = 'sure' | 'loose' | null;
  /** Windows：父程序死後 ParentProcessId 還指著它，所以分兩種。父程序活著＝直接證據；不在了＝只算間接跡象。 */
  const linkWindows = (row: ProcessRow): Verdict => {
    let verdict: Verdict = null;
    const consider = (parent: { pid: number; started: string; lower: string; gone?: string; uncertain: boolean }, alive: boolean): void => {
      if (alive) {
        // 父程序從出生起一直佔著這個 pid。子程序比它晚出生才是它生的；更早的是這個 pid 前一任生的。
        const order = parent.started ? compareStarted(row.started, parent.started) : null;
        if (order !== null && order < 0) return;
        if (order !== null && !parent.uncertain) verdict = 'sure';
        else verdict ??= 'loose';
        return;
      }
      // 父程序不在了（或查不出來）：下面只是在排除明顯不可能的，排除不掉的一律 loose，只擋不殺。
      const lower = compareStarted(row.started, parent.lower);
      if (lower !== null && lower < 0) return;
      if (parent.gone) { const upper = compareStarted(row.started, parent.gone); if (upper !== null && upper > 0) return; }
      const holder = byPid.get(parent.pid);
      if (holder && holder.started !== parent.started) { const order = compareStarted(row.started, holder.started); if (order !== null && order >= 0) return; }
      verdict ??= 'loose';
    };
    if (row.ppid === root.pid) consider({ pid: root.pid, started: root.started, lower: root.started || root.since, gone: root.gone, uncertain: false }, held && !!rootRow);
    for (const member of members) {
      if (verdict === 'sure') break;
      if (member.pid !== row.ppid) continue;
      consider({ pid: member.pid, started: member.started, lower: member.started, gone: member.gone, uncertain: !!(member.loose || member.weak) }, stateOf(member) === 'alive');
    }
    return verdict;
  };
  /** POSIX：ppid 是當下的事實，但只有父程序活著才看得到；group 要有身分對得上的既有成員還活著，才證明它沒被別人重用。 */
  const linkPosix = (row: ProcessRow): Verdict => {
    let verdict: Verdict = null;
    if (held && row.ppid === root.pid) verdict = 'sure';
    for (const member of members) {
      if (verdict === 'sure') break;
      if (member.pid !== row.ppid || stateOf(member) !== 'alive') continue;
      if (member.loose || member.weak) verdict ??= 'loose'; else verdict = 'sure';
    }
    if (verdict !== 'sure' && row.pgid === root.pid) {
      const proven = held || members.some(member => sureAlive(member) && byPid.get(member.pid)!.pgid === root.pid);
      verdict = proven ? 'sure' : 'loose';
    }
    return verdict;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const row of snapshot.rows) {
      if (held && row.pid === root.pid) continue;
      if (known.has(keyOf(row))) {
        // 先前只有間接跡象的成員，這次拿到直接證據（父程序活著、身分相符）就升為確定。反方向不降。
        const existing = members.find(member => member.loose && member.pid === row.pid && member.started === row.started);
        if (existing && (windows ? linkWindows(row) : linkPosix(row)) === 'sure') { delete existing.loose; changed = true; }
        continue;
      }
      const verdict = windows ? linkWindows(row) : linkPosix(row);
      if (!verdict) continue;
      // 啟動時間只到秒的平台：第一次看到它時還在它出生的那一秒內，之後同一秒被重用的 pid 就分不出來。
      const born = coarse ? Date.parse(`${row.started} UTC`) : NaN;
      const weak = coarse && !(Number.isFinite(born) && born + 1000 <= options.before);
      known.add(keyOf(row));
      members.push({ pid: row.pid, started: row.started, name: row.name, ...(verdict === 'loose' ? { loose: true as const } : {}), ...(weak ? { weak: true as const } : {}) });
      changed = true;
    }
  }
  const knownPids = new Set([root.pid, ...members.map(member => member.pid)]);
  const unverified = snapshot.unknown.filter(item => item.ppid !== null && knownPids.has(item.ppid) && !knownPids.has(item.pid)).map(item => item.pid);
  // POSIX 上讀不出身分的 pid 連 group 都不知道，可能就是留在 group 裡的孤兒。
  const blind = !snapshot.complete || snapshot.unknown.some(item => item.ppid === null) || (!windows && snapshot.unknown.length > 0);
  // 修剪：成員在「之前」的列舉就確認不在了，它生的、還活著的子程序這一次一定已經在表裡並且接上了。
  // 只有這張表完整、也沒有讀不出身分的 pid 指向它時才丟；未知的狀態不能拿來刪紀錄。
  const pointedAt = new Set(snapshot.unknown.map(item => item.ppid));
  const kept = members.filter(member => !(member.gone && Date.parse(member.gone) < options.before && !blind && !pointedAt.has(member.pid)));
  return {
    record: { ...input, platform, root, members: kept, ...(unverified.length ? { uncertainHistory: true as const } : {}) },
    alive: kept.filter(member => stateOf(member) === 'alive'),
    unknown: kept.filter(member => stateOf(member) === 'unknown'),
    unverified,
    blind,
  };
}

/** 追蹤缺口：有缺口時，「現在看不到子孫」不能證明沒有子孫。回傳說明；沒有缺口回 null。 */
export function treeGap(record: TreeRecord): string | null {
  if (record.uncertainHistory) return '曾有身分未知的可能子孫，後續成功不能補回歷史';
  if (!record.ended) return 'runner 沒有記到 worker 結束（可能被強制結束），之後的子孫沒有紀錄';
  if (!record.sealed) return `worker 結束後沒有成功列舉過（列舉失敗 ${record.failed} 次）`;
  const limit = record.intervalMs + TREE_GAP_SLACK_MS;
  if (record.maxGapMs > limit) return `worker 存活期間有 ${Math.round(record.maxGapMs / 1000)} 秒沒有成功列舉（上限 ${Math.round(limit / 1000)} 秒，列舉失敗 ${record.failed} 次）`;
  return null;
}

/** null＝檔案不存在；'corrupt'＝存在但讀不出來或格式不對。兩者都不能當成「沒有子孫」。 */
export function readTreeRecord(directory: string, file = TREE_FILE): TreeRecord | null | 'corrupt' {
  let text: string;
  try { text = readFileSync(join(directory, file), 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'corrupt'; }
  try {
    const record = JSON.parse(text) as TreeRecord;
    const identity = (value: { pid?: unknown; started?: unknown } | undefined): boolean => !!value && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.started === 'string';
    const count = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (record?.version !== 2 || !identity(record.root) || typeof record.root.since !== 'string' || !Array.isArray(record.members) || !record.members.every(identity)
      || !count(record.scans) || !count(record.failed) || !count(record.intervalMs) || !count(record.maxGapMs)) return 'corrupt';
    return record;
  } catch { return 'corrupt'; }
}

/**
 * 逐一終止。只收確定的成員，而且每一筆送出前重新查一次身分：處理前一筆的期間，這個 pid 可能已經換人。
 * 直接對那個 pid 送終止（Windows 是 TerminateProcess），不遞迴擴張到沒核對過的程序。
 * 重查只能把「核對」到「送出」之間的空窗縮到最小，消不掉；要完全消掉得握著程序 handle，這裡沒有。
 */
export async function terminateTreeMembers(members: TreeMember[], lookup: IdentityLookup = lookupIdentities, deadline = Infinity,
  send: (pid: number) => void = pid => { process.kill(pid, 'SIGKILL'); }): Promise<number> {
  let sent = 0;
  for (const member of members) {
    if (member.loose || member.weak || !member.started || Date.now() >= deadline) continue;
    let current: ProcessIdentity | undefined;
    try { current = (await lookup([member.pid])).get(member.pid); } catch { continue; }
    if (!current || current.started !== member.started || Date.now() >= deadline) continue;
    try { send(member.pid); sent++; } catch { /* 已退出。 */ }
  }
  return sent;
}

export interface TreeTrackerOptions {
  directory: string;
  /** worker 的 pid。 */
  pid: number;
  /** 查得到的 worker 身分；查不到給 null，之後的列舉會補。 */
  identity: ProcessIdentity | null;
  /** 啟動 worker 之前取的時間（毫秒）。 */
  since: number;
  /** worker 還沒結束（runner 握著 handle）。 */
  alive(): boolean;
  table?: ProcessTable;
  save?: typeof atomicJson;
  intervalMs?: number;
  lookup?: IdentityLookup;
  /** 測試注入：實際送出終止的函式。 */
  send?: (pid: number) => void;
  platform?: string;
  sealBudgetMs?: number;
  killBudgetMs?: number;
}
export interface TreeTracker {
  /** worker 結束的當下呼叫：記下時間，停止定期列舉。 */
  ended(): void;
  /** 補最後一次列舉，最多花 sealBudgetMs。回傳是否成功。 */
  seal(): Promise<boolean>;
  /** 重新列舉，終止確定還活著的子孫，最多花 killBudgetMs。回傳送出的數量。 */
  killRecorded(): Promise<number>;
}

/** runner 用：worker 存活期間定期列舉，結果累積進 tree.json。寫檔與列舉失敗都不影響 job 本身。 */
export function startTreeTracker(options: TreeTrackerOptions): TreeTracker {
  const table = options.table ?? listProcessTable, save = options.save ?? atomicJson, lookup = options.lookup ?? lookupIdentities;
  const interval = options.intervalMs ?? TREE_SCAN_MS;
  const since = new Date(options.since).toISOString();
  let record: TreeRecord = {
    version: 2, platform: options.platform ?? process.platform,
    root: { pid: options.pid, started: options.identity?.started ?? '', name: options.identity?.name ?? '', since },
    members: [], scans: 0, failed: 0, intervalMs: interval, maxGapMs: 0,
  };
  // 只在讀端會在意的內容變了才重寫：列舉次數、時間戳每次都變，為了它們每 5 秒寫一次檔不值得。
  const signature = (): string => JSON.stringify([record.root, record.members, record.failed, record.boot, record.ended, record.sealed, record.maxGapMs > interval + TREE_GAP_SLACK_MS]);
  let written = '';
  const persist = (force = false): void => {
    const current = signature();
    if (!force && current === written) return;
    try { save(join(options.directory, TREE_FILE), record); written = current; } catch (error) { console.error('ai-cli runner tree:', error); }
  };
  // 先落一份：meta 說有追蹤卻沒有這個檔，讀端會判成「查不了」而不是「沒有子孫」。
  persist(true);
  let stopped = false, wake: (() => void) | undefined, failures = 0, lastOkMs = options.since;
  let lastAlive: TreeMember[] = [];
  const nap = (duration: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, duration); wake = () => { clearTimeout(timer); resolve(); }; });
  // 列舉一次只跑一個：結果是讀了再改再寫，交錯會互相蓋掉。
  let chain: Promise<unknown> = Promise.resolve();
  const scan = (final: boolean, deadline = Infinity): Promise<boolean> => {
    const next = chain.then(async (): Promise<boolean> => {
      const timeoutMs = Math.min(TREE_SCAN_TIMEOUT_MS, deadline - Date.now());
      if (timeoutMs <= 0) return false;
      const aliveBefore = options.alive(), before = Date.now();
      let snapshot: ProcessSnapshot;
      try { snapshot = await table({ timeoutMs }); }
      catch (error) { failures++; record = { ...record, failed: record.failed + 1 }; persist(); console.error('ai-cli runner tree:', (error as Error).message); return false; }
      const survey = surveyTree(record, snapshot, { before, now: Date.now(), platform: record.platform, rootAlive: aliveBefore && options.alive() });
      lastAlive = survey.alive;
      record = { ...survey.record, ...(record.boot === undefined && snapshot.boot ? { boot: snapshot.boot } : {}) };
      // 表不完整的這一次仍然收下看到的成員，但不算成功：缺口照算，也不能拿來封存。
      if (survey.blind) { failures++; record = { ...record, failed: record.failed + 1 }; persist(); return false; }
      failures = 0;
      record = { ...record, scans: record.scans + 1, lastOk: new Date(before).toISOString() };
      // 開始時間在 worker 結束之前的才算存活期間的列舉。
      if (!record.ended || before < Date.parse(record.ended)) { record.maxGapMs = Math.max(record.maxGapMs, before - lastOkMs); lastOkMs = before; }
      if (final) record.sealed = true;
      persist(final);
      return true;
    });
    chain = next.catch(() => false);
    return next;
  };
  // 第一次稍微等一下：剛啟動的 worker 還沒有子孫，馬上列舉只是多花一次。
  // 失敗後先快速重試一次（免得一次偶發失敗就成了缺口），連續失敗再逐次拉長，最長 30 秒。
  const loop = (async () => {
    await nap(Math.min(1000, interval));
    while (!stopped) {
      await scan(false).catch(() => false);
      if (!stopped) await nap(failures === 0 ? interval : Math.min(Math.min(1000, interval) * 2 ** (failures - 1), 30000));
    }
  })();
  const ended = (): void => {
    if (stopped) return;
    stopped = true;
    const now = Date.now();
    record = { ...record, ended: new Date(now).toISOString(), root: { ...record.root, gone: record.root.gone ?? new Date(now).toISOString() }, maxGapMs: Math.max(record.maxGapMs, now - lastOkMs) };
    wake?.();
  };
  return {
    ended,
    async seal() {
      ended();
      const deadline = Date.now() + (options.sealBudgetMs ?? TREE_SEAL_BUDGET_MS);
      // 進行中的那次列舉自己有逾時（比收尾上限短），等它結束；之後的每一次都被 deadline 截住。
      await loop;
      for (let attempt = 0; Date.now() < deadline; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
        if (await scan(true, deadline).catch(() => false)) return true;
      }
      persist(true);
      return false;
    },
    async killRecorded() {
      const deadline = Date.now() + (options.killBudgetMs ?? TREE_KILL_BUDGET_MS);
      if (!await scan(stopped, deadline).catch(() => false)) return 0;
      return terminateTreeMembers(lastAlive, lookup, deadline, options.send);
    },
  };
}
