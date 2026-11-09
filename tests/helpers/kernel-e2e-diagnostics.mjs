/** Failure-only diagnostics: no environment dump, contracts, prompts or raw journal. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export function commandResult(result, elapsedMs) {
  return { code: result.status, signal: result.signal ?? null, spawnError: result.error ?? null,
    elapsedMs: Math.round(elapsedMs), out: result.stdout ?? '', err: result.stderr ?? '' };
}
export function jsonResult(result) {
  try { return { ...result, data: JSON.parse(result.out), parseError: null }; }
  catch (error) { return { ...result, data: null, parseError: error }; }
}

function redactor(env) {
  const secrets = Object.entries(env).filter(([key, value]) => /key|token|secret|password|credential|authorization/i.test(key) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  return input => {
    let text = String(input ?? '');
    for (const value of secrets) {
      for (const spelling of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) text = text.split(spelling).join('<redacted>');
    }
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
      .replace(/((?:api[_-]?key|token|secret|password|credential|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, '$1<redacted>')
      .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,})/g, '<redacted>');
  };
}
const select = (value, keys) => Object.fromEntries(keys.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key]) || value?.[key] === null)
  .map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 160) : value[key]]));
const statusKeys = ['runId', 'state', 'effectiveState', 'reason'];

/** Reads are bounded and observational: no CLI/status call that could reconcile state. */
export function approvalDiagnostic(result, runId, stateDir, env = process.env) {
  const scrub = redactor(env);
  const bounded = value => {
    const text = scrub(value), limit = 2048;
    return { chars: String(value ?? '').length, truncated: text.length > limit,
      text: text.length > limit ? `${text.slice(0, limit / 2)}\n<omitted>\n${text.slice(-limit / 2)}` : text };
  };
  // V8 JSON errors can echo payload excerpts. Keep the kind and position only.
  const errorView = error => error ? { ...select(error, ['name', 'code', 'errno', 'syscall']),
    message: bounded(error instanceof SyntaxError ? error.message.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '<omitted>') : error.message) } : null;
  const read = (file, tail = false) => {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size, limit = 16384;
      if (!tail && size > limit) throw Object.assign(new Error('diagnostic file size limit'), { code: 'SIZE_LIMIT' });
      const start = tail ? Math.max(0, size - limit) : 0;
      const buffer = Buffer.alloc(Math.min(size, limit));
      const bytes = readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytes).toString('utf8');
      return { text: start ? text.slice(text.indexOf('\n') + 1) : text, truncated: start > 0 };
    } finally { closeSync(fd); }
  };
  const snapshot = {};
  // A missing/invalid id is evidence too; never join an untrusted id into a path.
  if (/^kr-\d{8}-\d{6}-[0-9a-f]{4}$/.test(runId ?? '')) {
    const directory = join(stateDir, 'kernel', 'runs', runId);
    for (const file of ['runner.json', 'launcher.json']) {
      try { snapshot[file] = select(JSON.parse(read(join(directory, file)).text), ['pid', 'started', 'at']); }
      catch (error) { snapshot[file] = { readError: errorView(error) }; }
    }
    try {
      const journal = read(join(directory, 'journal.jsonl'), true);
      const lines = journal.text.trim().split('\n').slice(-12);
      snapshot.journal = { truncated: journal.truncated, events: lines.filter(Boolean).map(line => {
        try { return select(JSON.parse(line), ['seq', 'at', 'type', 'state', 'reason']); }
        catch (error) { return { parseError: errorView(error) }; }
      }) };
    } catch (error) { snapshot.journal = { readError: errorView(error) }; }
  } else snapshot.readError = 'missing or invalid runId';
  // Valid status JSON is projected before logging, so context/goal/paths are omitted.
  // For malformed JSON, quoted payloads are removed while syntax remains visible.
  const stdout = result.parseError ? result.out.replace(/"(?:\\.|[^"\\])*"/g, '"<omitted>"') : JSON.stringify(select(result.data, statusKeys));
  const clean = value => typeof value === 'string' ? scrub(value).slice(0, 2100)
    : Array.isArray(value) ? value.map(clean)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
  return clean({ runId, capturedAt: new Date().toISOString(), code: result.code,
    signal: result.signal, elapsedMs: result.elapsedMs, spawnError: errorView(result.spawnError),
    parseError: errorView(result.parseError), returnedStatus: select(result.data, statusKeys),
    stdout: { ...bounded(stdout), originalChars: result.out.length, projected: !result.parseError },
    stderr: bounded(result.err), snapshot });
}
