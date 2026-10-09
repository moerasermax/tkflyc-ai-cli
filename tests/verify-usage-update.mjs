import '../tools/stubs/catalog-test-env.mjs';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CodexUsageProvider, ClaudeUsageProvider, UsageService, hasUpdatePrompt } from '../dist/plugins/usage-service.js';

// PTY 與 taskkill 全用 stub；任何真 CLI／OS kill 都不能由這支測試觸發。
const cp = createRequire(import.meta.url)('node:child_process'), originalSpawn = cp.spawn;
cp.spawn = (file) => { assert.equal(file, 'taskkill'); return new EventEmitter(); };
syncBuiltinESMExports();
let passed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); passed++; } catch (e) { console.error('FAIL ' + name); throw e; } }
function ptyStub(chunks, onWrite) {
  const writes = [], calls = []; let killed = false;
  return { writes, calls, get killed() { return killed; }, factory: () => ({ spawn: (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: 2147483647, kill() { killed = true; }, write(keys) { writes.push(keys); onWrite?.(keys); },
      onData(fn) { chunks.forEach(([delay, text]) => setTimeout(() => fn(text), delay)); }, onExit() {} };
  } }) };
}
async function query(provider, key) { const service = new UsageService({}); service.providers.set(key, provider); return service.queryProvider(key, { refresh: true }); }
try {
  await test('PTY update prompt blocks Codex keys with explicit error and startup flag', async () => {
    const fake = ptyStub([[0, '✨ Update available! 0.160.1 -> 0.162.0\n❯ Update now\nPress Enter to continue']]);
    const result = await query(new CodexUsageProvider('codex-stub', fake.factory), 'codex');
    assert.equal(result.status, 'error'); assert.match(result.error, /update prompt detected/);
    assert.deepEqual(fake.writes, []); assert(fake.killed);
    assert(fake.calls[0].args.includes('check_for_update_on_startup=false'));
  });
  await test('PTY fragmented update cancels a queued Claude Enter', async () => {
    const fake = ptyStub([[0, '❯ ready'], [100, 'Update avail'], [150, 'able! Claude Code\nPress Enter to update']]);
    const result = await query(new ClaudeUsageProvider('claude-stub', fake.factory), 'claude');
    assert.equal(result.status, 'error'); assert.match(result.error, /update prompt detected/);
    await sleep(600); assert.deepEqual(fake.writes, []); assert(fake.killed);
  });
  await test('PTY delayed Codex status Enter cancelled if update arrives after slash command', async () => {
    let deliver; const writes = []; const fake = { spawn: () => ({ pid: 2147483647, kill() {},
      onExit() {}, onData(fn) { deliver = fn; fn('model: gpt-6-sol\n❯'); },
      write(keys) { writes.push(keys); if (!keys.includes('\r')) deliver('\n✨ Update available!\n❯ Update now\n  Skip update'); } }) };
    const result = await query(new CodexUsageProvider('codex-stub', () => fake), 'codex');
    assert.equal(result.status, 'error'); await sleep(400);
    assert.ok(writes.length === 1); assert(!writes.some(k => k.includes('\r')));
  });
  await test('M6 passive installer and update progress are not interactive prompts', () => {
    assert(hasUpdatePrompt('\x1b[2;1H✨ Update available!\n❯ Update now\n  Skip update'));
    assert(!hasUpdatePrompt('Updating Codex via `npm install -g @openai/codex`...'));
    assert(!hasUpdatePrompt('Claude Code has switched from npm to native installer. Run `claude install` or see docs for more options.'));
    assert(!hasUpdatePrompt('Update available! Run npm install -g @openai/codex when convenient.'));
    assert(!hasUpdatePrompt('Claude Code v2.1.0\n/status\nAccount: Pro\nWeekly limit: 90% left (resets 10:00)'));
    assert(!hasUpdatePrompt('Weekly limit: 90% left (resets 10:00)'));
  });
  await test('M6 blocked Codex refresh falls back to recent session quota', async () => {
    const now = new Date(), root = join(process.env.CODEX_HOME, 'sessions'), dir = join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stub.jsonl'), JSON.stringify({ timestamp: now.toISOString(), payload: { type: 'token_count', rate_limits: { primary: { used_percent: 21, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 }, plan_type: 'pro' } } }) + '\n');
    try {
      const fake = ptyStub([[0, 'Update available!\n❯ Update now\n  Skip update']]);
      const result = await new CodexUsageProvider('codex-stub', fake.factory).query({ fresh: true });
      assert.equal(result.source, 'session-file'); assert.equal(result.weekly.percentUsed, 21); assert.deepEqual(fake.writes, []);
    } finally { rmSync(join(dir, 'stub.jsonl')); }
  });
} finally { cp.spawn = originalSpawn; syncBuiltinESMExports(); }
console.log(`usage-update: ${passed} passed`);
