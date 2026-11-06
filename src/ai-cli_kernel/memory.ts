/**
 * 本機記憶：JSONL 保存完整版本，最後一筆為準；模型只能追加候選，人工升級才可參考。
 * 不連線任何私人服務，不持有 Planner 或 Knowledge 的寫入能力。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { digestText, kernelStateDir } from './journal.js';
import type { KernelContract } from './types.js';

const ScopeSchema = z.object({ paths: z.array(z.string()).min(1).optional(), template: z.string().min(1).optional() }).strict();
const MemorySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), text: z.string().trim().min(1).max(4000),
  source: z.object({ kind: z.enum(['human', 'run']), runId: z.string().min(1).optional() }).strict(),
  scope: ScopeSchema, status: z.enum(['candidate', 'active', 'revoked']), createdAt: z.string().datetime(),
}).strict();
export type KernelMemory = z.infer<typeof MemorySchema>;
export interface KernelMemoryOps {
  read(): KernelMemory[];
  candidates(items: KernelMemory[]): void;
  /** 相對 repo 根目錄的執行範圍；空陣列代表整個 repo。 */
  paths: string[];
}

function git(folder: string, ...args: string[]): string | null {
  const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return result.status === 0 ? result.stdout.trim() : null;
}
/** origin URL 原文雜湊；無 origin 時使用第一個（root）commit，linked worktree 共用身分。 */
export function aiCliKernelMemoryRepo(folder: string): { repoKey: string; root: string } | null {
  const root = git(folder, 'rev-parse', '--show-toplevel');
  if (!root) return null;
  const identity = git(folder, 'remote', 'get-url', 'origin') || git(folder, 'rev-list', '--max-parents=0', '--reverse', 'HEAD')?.split('\n')[0];
  if (!identity) return null;
  return { root, repoKey: digestText(identity) };
}
function pathScope(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '.' || normalized === '') return '';
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('記憶 paths 必須在 repo 內，不接受萬用字元或上層路徑');
  if (/[*?\x00-\x1f]/.test(normalized)) throw new Error('記憶 paths 不接受萬用字元或控制字元');
  return normalized;
}
function validate(item: unknown): KernelMemory {
  const memory = MemorySchema.parse(item);
  if (memory.scope.paths) memory.scope.paths = memory.scope.paths.map(pathScope);
  return memory;
}
function noLink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('記憶路徑不能是符號連結'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export class AiCliKernelMemoryStore {
  readonly path: string;
  private readonly dir: string;
  constructor(repoKey: string) {
    if (!/^[a-f0-9]{64}$/.test(repoKey)) throw new Error('無效的記憶 repoKey');
    this.dir = join(kernelStateDir(), 'memory');
    this.path = join(this.dir, `${repoKey}.jsonl`);
  }
  read(): KernelMemory[] {
    noLink(this.dir); noLink(this.path);
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    // 殘行可能是 revoke，不能忽略後把已撤銷的資料當 active。
    if (text && !text.endsWith('\n')) throw new Error('記憶紀錄殘行，請人工對帳');
    const latest = new Map<string, KernelMemory>();
    for (const line of text.split('\n').filter(Boolean)) { const item = validate(JSON.parse(line)); latest.set(item.id, item); }
    return [...latest.values()];
  }
  private mutate<T>(action: (items: KernelMemory[], append: (item: KernelMemory) => void) => T): T {
    noLink(this.dir); noLink(this.path);
    mkdirSync(this.dir, { recursive: true });
    const lock = `${this.path}.lock`;
    const fd = openSync(lock, 'wx', 0o600);
    try {
      return action(this.read(), item => {
        const valid = validate(item);
        const out = openSync(this.path, 'a', 0o600);
        try { writeFileSync(out, JSON.stringify(valid) + '\n'); fsyncSync(out); } finally { closeSync(out); }
      });
    } finally { closeSync(fd); rmSync(lock); }
  }
  add(text: string, scope: KernelMemory['scope'] = {}): KernelMemory {
    assertHuman();
    const item = validate({ id: `m-${randomBytes(12).toString('hex')}`, text, source: { kind: 'human' }, scope, status: 'candidate', createdAt: new Date().toISOString() });
    return this.mutate((_items, append) => { append(item); return item; });
  }
  status(id: string, status: 'active' | 'revoked'): KernelMemory {
    assertHuman();
    if (!['active', 'revoked'].includes(status)) throw new Error('記憶狀態只能由 promote 或 revoke 變更');
    return this.mutate((items, append) => {
      const item = items.find(item => item.id === id);
      if (!item) throw new Error('找不到記憶 id');
      const next = { ...item, status }; append(next); return next;
    });
  }
  candidates(items: KernelMemory[]): void {
    if (!items.length) return;
    this.mutate((known, append) => {
      const ids = new Set(known.map(item => item.id));
      for (const raw of items) {
        const item = validate(raw);
        if (item.source.kind !== 'run' || item.status !== 'candidate' || item.text.length > 500) throw new Error('模型只能新增 run candidate 記憶');
        if (!ids.has(item.id)) { append(item); ids.add(item.id); }
      }
    });
  }
}
function assertHuman(): void {
  if (process.env.AI_CLI_WORKER === '1') throw new Error('worker 不能新增、升級或撤銷人工記憶；請由人使用 CLI 決定');
}
export function aiCliKernelMemoryForContract(contract: KernelContract): KernelMemoryOps | undefined {
  const repo = aiCliKernelMemoryRepo(contract.workFolder);
  if (!repo) return undefined;
  const store = new AiCliKernelMemoryStore(repo.repoKey);
  const prefix = relative(repo.root, contract.workFolder).replace(/\\/g, '/');
  return { read: () => store.read(), candidates: items => store.candidates(items), paths: contract.develop?.allowedPaths.length ? contract.develop.allowedPaths : prefix ? [prefix] : [] };
}
export function aiCliKernelMemoryCandidates(lessons: string[], runId: string, actionId: string, scope: KernelMemory['scope'], createdAt: string): KernelMemory[] {
  return lessons.map((text, index) => validate({ id: `m-${digestText(`${runId}:${actionId}:${index}`).slice(0, 32)}`, text, source: { kind: 'run', runId }, scope, status: 'candidate', createdAt }));
}
/** 先 escape 再計算上限，外來文字無法用結束標籤冒充可信指示。 */
export function aiCliKernelUntrustedText(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function aiCliKernelMemoryText(items: KernelMemory[], template: string, paths: string[]): string {
  const selected: string[] = [];
  const overlap = (a: string, b: string) => !a || !b || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  for (const item of items) {
    if (item.status !== 'active') continue;
    if (item.scope.template && item.scope.template !== template) continue;
    if (item.scope.paths?.length && paths.length && !item.scope.paths.some(a => paths.some(b => overlap(pathScope(a), pathScope(b))))) continue;
    const left = 4000 - selected.join('\n').length - (selected.length ? 1 : 0);
    if (left <= 0 || selected.length >= 20) break;
    selected.push(aiCliKernelUntrustedText(item.text).slice(0, left));
  }
  return selected.join('\n');
}
