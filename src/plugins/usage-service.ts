/**
 * Usage service — 查詢各 CLI agent 剩餘 token/quota。
 * 支援 Claude、Codex、agy（皆為 PTY）。Kiro 於 5.0.0 隨 agent 一起移除。
 * 結果快取 120 秒，error 快取 30 秒。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../core/ansi.js';

const _patchRequire = createRequire(import.meta.url);
let _ptyModule: any = null;

function _loadPtyModule(): any {
  if (_ptyModule) return _ptyModule;
  _ptyModule = _patchRequire('@homebridge/node-pty-prebuilt-multiarch');
  return _ptyModule;
}

function _cleanUsageText(text: string): string {
  return stripAnsi(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function _cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) ? 2 : 1;
}

/**
 * 把 TUI 的輸出「播放」到一個簡易畫面緩衝區，回傳畫面上實際看得到的文字（捲出畫面的歷史也保留）。
 *
 * 為什麼不是清掉跳脫碼就好：codex 0.160 與 claude 的 TUI 只重畫變動的格子。`ESC[列;欄H` 換列、
 * `ESC[nC` 是「跳過 n 格、保留原內容」、`ESC[nX` 清格、`ESC[K` 清到行尾。只刪跳脫碼時，codex 的
 * `Pro␛[1C100` 變 `Pro100`、下一列的 `Model:` 黏到上一行；claude 的 `Current sess␛[1Con`（那個 i
 * 沒變所以跳過）若把跳過當成空格，又會變成 `Current sess on`。照終端機的規則播放一次才對得上畫面。
 */
export function renderTerminal(input: string, cols = 200, rows = 50): string {
  const lines: string[][] = [[]];
  let top = 0, row = 0, col = 0;
  let saved = { row: 0, col: 0 };
  const line = (r: number) => { const i = top + r; while (lines.length <= i) lines.push([]); return lines[i]; };
  const clampRow = (r: number) => Math.min(Math.max(r, 0), rows - 1);
  const clampCol = (c: number) => Math.min(Math.max(c, 0), cols - 1);
  // 換行回到行首：ConPTY 送 \r\n；純文字（測試、舊版輸出）只有 \n，也要回到行首。
  const newline = () => { if (row < rows - 1) row++; else top++; line(row); col = 0; };
  const s = input ?? '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\x1b') {
      if (s[i + 1] === '[') {
        // 參數位元組是 0x30–0x3F，含 `<` `=` `>` `?` 前綴（例：`ESC[>1u`、`ESC[?2026h`）；漏掉會把序列印成文字。
        const m = /^\x1b\[([0-?]*)[ -/]*([@-~])/.exec(s.slice(i, i + 40));
        if (!m) { i++; continue; }
        i += m[0].length;
        const p = m[1].replace(/[<=>?]/g, '').split(';').map((v) => (v === '' ? NaN : Number(v)));
        const n = Number.isFinite(p[0]) && p[0] > 0 ? p[0] : 1;
        const cur = line(row);
        switch (m[2]) {
          case 'H': case 'f': row = clampRow((p[0] || 1) - 1); col = clampCol((p[1] || 1) - 1); line(row); break;
          case 'A': row = clampRow(row - n); break;
          case 'B': row = clampRow(row + n); line(row); break;
          case 'C': col = clampCol(col + n); break;
          case 'D': col = clampCol(col - n); break;
          case 'G': col = clampCol((p[0] || 1) - 1); break;
          case 'd': row = clampRow((p[0] || 1) - 1); line(row); break;
          case 'X': for (let k = col; k < col + n && k < cur.length; k++) cur[k] = ' '; break;
          case 'K': {
            const mode = p[0] || 0;
            if (mode === 0) cur.length = Math.min(cur.length, col);
            else if (mode === 1) for (let k = 0; k <= col && k < cur.length; k++) cur[k] = ' ';
            else cur.length = 0;
            break;
          }
          case 'J': {
            const mode = p[0] || 0;
            if (mode === 0) { cur.length = Math.min(cur.length, col); for (let r = row + 1; r < rows; r++) line(r).length = 0; }
            else if (mode === 2 || mode === 3) for (let r = 0; r < rows; r++) line(r).length = 0;
            break;
          }
          // 存／取游標位置；只認沒有參數的形式（`ESC[<u`、`ESC[>1u` 是鍵盤協定，不是取游標）。
          case 's': if (m[1] === '') saved = { row, col }; break;
          case 'u': if (m[1] === '') { row = saved.row; col = saved.col; line(row); } break;
          default: break; // m（顏色）、h / l（模式）等不影響文字位置
        }
        continue;
      }
      if (s[i + 1] === ']') { // OSC（例：超連結），到 BEL 或 ST 為止
        const rest = s.slice(i);
        const end = rest.search(/\x07|\x1b\\/);
        i += end < 0 ? rest.length : end + (rest[end] === '\x07' ? 1 : 2);
        continue;
      }
      if (s[i + 1] === '7') { saved = { row, col }; i += 2; continue; }
      if (s[i + 1] === '8') { row = saved.row; col = saved.col; line(row); i += 2; continue; }
      if ('()*+'.includes(s[i + 1] ?? '')) { i += 3; continue; } // 字集指定（ESC ( B）是三個字元
      i += 2; continue;
    }
    if (c === '\r') { col = 0; i++; continue; }
    if (c === '\t') { col = clampCol((Math.floor(col / 8) + 1) * 8); i++; continue; }
    if (c === '\n') { newline(); i++; continue; }
    if (c === '\b') { col = Math.max(0, col - 1); i++; continue; }
    if (c < ' ') { i++; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 32);
    i += ch.length;
    const w = _cellWidth(ch);
    if (col + w > cols) newline();
    const cur = line(row);
    while (cur.length < col) cur.push(' ');
    cur[col] = ch;
    if (w === 2) cur[col + 1] = '';
    col += w;
  }
  return lines.map((l) => l.join('').replace(/\s+$/, '')).join('\n');
}

function _toNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function _toBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['enabled', 'enable', 'on', 'true', 'yes'].includes(normalized)) return true;
  if (['disabled', 'disable', 'off', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function _extractFirstNumber(text: string, regex: RegExp): number | null {
  const match = text.match(regex);
  return match ? _toNumber(match[1]) : null;
}

function _extractLooseNumbers(text: string): number[] {
  const matches = text.match(/(?<![\w.-])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\w.-])/g) ?? [];
  return matches.map((v) => _toNumber(v)).filter((v): v is number => v !== null);
}

function _parseLooseUsage(text: string): Record<string, unknown> {
  const raw = _cleanUsageText(text);
  const usage: Record<string, unknown> = { raw };
  const resetDate = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const percentUsed = _extractFirstNumber(raw, /(\d+(?:\.\d+)?)\s*%/);
  const costUsd = _extractFirstNumber(raw, /(?:est\.?\s*)?cost[^$\d]*(?:\$|USD\s*)?([\d,.]+)/i);
  const numbers = _extractLooseNumbers(raw);
  if (resetDate) usage.resetDate = resetDate[1];
  if (percentUsed !== null) usage.percentUsed = percentUsed;
  if (costUsd !== null) usage.costUsd = costUsd;
  if (numbers.length > 0) usage.numbers = numbers;
  return usage;
}


export function parseClaudeUsage(text: string) {
  const raw = _cleanUsageText(renderTerminal(text));
  // 移除進度條方塊字元，讓 regex 易於匹配
  const s = raw.replace(/[█▌▎▍▋▊▉▏▐▀▄■□▪▫]+/g, ' ');

  const sessionPct     = _extractFirstNumber(s, /Current\s+session\s+(\d+(?:\.\d+)?)\s*%/i);
  const sessionReset   = s.match(/Current\s+session\s+[\d\s%used]+Rese[st]+\s+([^\n]+?)(?=Current|\n|$)/i)?.[1]?.trim() ?? null;
  const weekAllPct     = _extractFirstNumber(s, /Current\s+week\s*\(?all\s+models\)?\s+(\d+(?:\.\d+)?)\s*%/i);
  const weekAllReset   = s.match(/Current\s+week\s*\(?all\s+models\)?\s+[\d\s%used]+Resets?\s+([^\n]+?)(?=Current|\n|$)/i)?.[1]?.trim() ?? null;
  const weekSonnetPct  = _extractFirstNumber(s, /Current\s+week\s*\(?Sonnet\s+only\)?\s+(\d+(?:\.\d+)?)\s*%/i);
  const weekSonnetReset= s.match(/Current\s+week\s*\(?Sonnet\s+only\)?\s+[\d\s%used]+Resets?\s+([^\n]+?)(?=What|\n|$)/i)?.[1]?.trim() ?? null;
  const costUsd        = _extractFirstNumber(s, /Session\s+cost:\s*\$?([\d,.]+)/i);
  const inputTokens    = _extractFirstNumber(s, /(\d+)\s+input/i);
  const outputTokens   = _extractFirstNumber(s, /(\d+)\s+output/i);
  const cacheRead      = _extractFirstNumber(s, /(\d+)\s+cache\s+read/i);
  const cacheWrite     = _extractFirstNumber(s, /(\d+)\s+cache\s+write/i);

  // 量不到就是 unknown：一個額度百分比都沒有、也沒有 API key 帳號的成本，回 type 'error'
  // （2026-10-06 實測：Claude Code 的游標重繪讓 `Current session` 變 `Currentsession`，
  // 所有欄位都是 null，status 卻是 ok）。
  if (sessionPct === null && weekAllPct === null && weekSonnetPct === null && costUsd === null) {
    return { type: 'error', error: 'no usage panel in output', raw };
  }

  // 模型專屬的週額度（例：`Current week (Fable)`）。all models / Sonnet only 已有固定欄位，不重複列。
  const additionalLimits: { label: string; percentUsed: number; percentRemaining: number; basis: 'used'; resetAt: string | null }[] = [];
  for (const m of s.matchAll(/Current\s+week\s*\(([^)\n]+)\)\s+(\d+(?:\.\d+)?)\s*%\s*used\s*(?:Resets?\s+([^\n]+))?/gi)) {
    if (/^(all\s+models|Sonnet\s+only)$/i.test(m[1].trim())) continue;
    const used = _toNumber(m[2]);
    if (used === null) continue;
    additionalLimits.push({ label: m[1].trim(), percentUsed: used, percentRemaining: 100 - used, basis: 'used', resetAt: m[3]?.trim() ?? null });
  }

  return {
    raw,
    // 以下 *Percent 欄位都是「已用」百分比（畫面寫 N% used），跟 codex 的 percentRemaining 方向相反。
    percentBasis:          'used' as const,
    ...(additionalLimits.length > 0 ? { additionalLimits } : {}),
    sessionPercent:        sessionPct,
    sessionResetAt:        sessionReset,
    weekAllModelsPercent:  weekAllPct,
    weekAllModelsResetAt:  weekAllReset,
    weekSonnetPercent:     weekSonnetPct,
    weekSonnetResetAt:     weekSonnetReset,
    sessionCostUsd:        costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens:       cacheRead,
    cacheWriteTokens:      cacheWrite,
  };
}

export function parseCodexUsage(text: string) {
  const raw = _cleanUsageText(renderTerminal(text));
  // 去掉進度條方塊與框線字元，只留文字，方便比對
  const s = raw.replace(/[█░▓▒■□▪▫]+/g, ' ').replace(/[│╭╮╰╯┌┐└┘┃━]+/g, ' ');

  // 帳號 / 方案 / 模型都只在「單行」內擷取，避免 \s* 跨行誤抓下一行括號內容。
  const accountLine = s.match(/Account:[^\n]*/i)?.[0] ?? '';
  const plan  = accountLine.match(/\(([^)\n]+)\)/)?.[1]?.trim() ?? null;
  // 舊版是「Account: user@example.com (Plus)」；0.160 不再顯示 email，只有「Account: Pro 100」。
  // 沒有 email 時照畫面原樣回傳那個值，不去猜它代表帳號還是方案。
  const email = accountLine.match(/(\S+@\S+)/)?.[1]
    ?? (accountLine.replace(/^Account:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || null);
  // 用大小寫敏感的 "Model:" 只抓面板那行，避開啟動框的小寫 "model:     loading"。
  const modelLine = s.match(/^[ \t]*Model:[^\n]*/m)?.[0] ?? '';
  const model = modelLine
    ? (modelLine.replace(/^[ \t]*Model:[ \t]*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || null)
    : null;

  // 解析單一額度行；同時支援新版「N% left」與舊版「N% used」，統一輸出剩餘/已用百分比。
  const resetFrom = (str: string) =>
    str.match(/resets?\s+(?:in\s+)?([^)\n]+?)\s*\)/i)?.[1]?.trim()
    ?? str.match(/resets?\s+(?:in\s+)?([^\n)]+)/i)?.[1]?.trim()
    ?? null;
  const limitInfo = (labelRe: RegExp) => {
    const m = labelRe.exec(s);
    if (!m || m.index === undefined) return null;
    const lineEnd = s.indexOf('\n', m.index);
    const line = lineEnd === -1 ? s.slice(m.index) : s.slice(m.index, lineEnd);
    // 百分比只在「當前行」抓，避免某額度行無數字時誤抓到下一個額度行的數字。
    const pm = line.match(/(\d+(?:\.\d+)?)\s*%\s*(left|remaining|used)?/i);
    if (!pm) return null;
    const pct = _toNumber(pm[1]);
    const basis: 'left' | 'used' = /used/i.test(pm[2] ?? '') ? 'used' : 'left';
    const percentRemaining = pct === null ? null : (basis === 'used' ? 100 - pct : pct);
    const percentUsed      = pct === null ? null : (basis === 'used' ? pct : 100 - pct);
    // reset 先找當前行；窄終端會把「(resets …)」折到下一行，故下一行（非另一個 limit）也找。
    let resetAt = resetFrom(line);
    if (!resetAt && lineEnd !== -1) {
      const next2 = s.indexOf('\n', lineEnd + 1);
      const nextLine = s.slice(lineEnd + 1, next2 === -1 ? undefined : next2);
      if (nextLine && !/(?:5h|weekly|hour)[^\n]*limit\s*:/i.test(nextLine)) resetAt = resetFrom(nextLine);
    }
    return { percentRemaining, percentUsed, basis, resetAt };
  };

  const fiveHour = limitInfo(/5h\s*limit\s*:/i) ?? limitInfo(/\b5\s*hour[^:]*:/i);
  // 先找行首的 `Weekly limit:`：`Luna Reserve Weekly limit:` 這類額外額度若排在前面，不能被當成主額度。
  const weekly   = limitInfo(/^[ \t]*weekly\s*limit\s*:/im) ?? limitInfo(/weekly\s*limit\s*:/i) ?? limitInfo(/\bweek(?:ly)?[^:]*limit[^:]*:/i);

  // 抓不到任何額度行時，先試 Codex /status 格式：「N% context left」
  if (!fiveHour && !weekly) {
    const contextLeftMatch = s.match(/(\d+(?:\.\d+)?)\s*%\s*context\s+left/i);
    if (contextLeftMatch) {
      const contextLeft = _toNumber(contextLeftMatch[1]);
      const promptModel = s.match(/([^\n\s][^\n]+?)\s+·\s+~/)?.[1]?.trim() ?? model;
      return {
        type: 'context_usage',
        account: email,
        plan,
        model: promptModel ?? model,
        contextPercentLeft: contextLeft,
        contextPercentUsed: contextLeft !== null ? 100 - contextLeft : null,
        raw,
      };
    }
    // 沒有任何額度數字、畫面上卻有錯誤（例：管理員權限下 daemon 拒絕啟動）：量不到就是 unknown，
    // 不能折成 ok。帶出錯誤原文，UsageService 據此回 status error；raw 照樣保留。
    const errAt = s.search(/\berror:/i);
    if (errAt !== -1) {
      const error = s.slice(errAt).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('\n');
      return { type: 'error', account: email, plan, model, error, raw };
    }
    try { return { type: 'raw', ...(_parseLooseUsage(raw)) }; }
    catch { return { type: 'raw', raw }; }
  }

  // 主額度以外的額度行（例：0.160 的 `Luna Reserve Weekly limit:`，特定模型的保留額度）。
  // 原本只取第一個 weekly，其餘的默默丟掉。
  const additionalLimits: { label: string; percentRemaining: number | null; percentUsed: number | null; basis: 'left' | 'used'; resetAt: string | null }[] = [];
  for (const lm of s.matchAll(/^[ \t]*([A-Za-z][\w .+-]*?)\s+limit\s*:/gim)) {
    const label = lm[1].trim();
    if (/^(5h|weekly)$/i.test(label)) continue;
    const info = limitInfo(new RegExp(lm[0].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    if (info) additionalLimits.push({ label, ...info });
  }

  return {
    type: 'rate_limits',
    account: email,
    plan,
    model,
    fiveHour: fiveHour ?? null,
    weekly: weekly ?? null,
    ...(additionalLimits.length > 0 ? { additionalLimits } : {}),
    raw,
  };
}

export function parseAgyUsage(text: string) {
  const raw = _cleanUsageText(renderTerminal(text, 220));
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const models: Record<string, unknown>[] = [];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let group: string | null = null;

  for (let i = 0; i < lines.length - 1; i++) {
    // agy 1.2 的面板按群組列（`GEMINI MODELS`、`CLAUDE AND GPT MODELS`），每組有自己的週／5 小時額度。
    const header = lines[i].match(/([A-Z][A-Z0-9 &/,.+-]*\bMODELS)$/);
    if (header && !/%/.test(lines[i])) { group = header[1].trim(); continue; }
    const next = lines[i + 1] ?? '';
    const percentMatch = next.match(/(\d+(?:\.\d+)?)\s*%\s*$/);
    if (!percentMatch) continue;
    const nameLine = lines[i];
    if (/^[─═\-=│|>◉]+$/.test(nameLine)) continue;
    if (/↑|↓|pgup|pgdown|ctrl|esc/i.test(nameLine)) continue;
    if (/^\(\d+/.test(nameLine)) continue;
    const statusLine = lines[i + 2] ?? '';
    const isNav = /↑|↓|pgup|pgdown|ctrl|esc/i.test(statusLine);
    // 百分比行後面若直接是下一個額度標籤／群組標題，就沒有狀態行——不能把它吞掉當 status。
    const isNext = /limit\s+(remaining|used)\b/i.test(statusLine) || /\bMODELS$/.test(statusLine) || /%\s*$/.test(statusLine);
    const status = (!isNav && !isNext && statusLine) ? statusLine : null;
    const pct = _toNumber(percentMatch[1]);
    // 標籤寫明「Remaining／Used」時照標籤換算。2026-10-06 實測畫面是「Weekly Limit Remaining 99.86%」，
    // 原本把它原樣放進 percentUsed，讀的人會以為已經用掉 99.86%。
    const label = nameLine.match(/limit\s+(remaining|used)\b/i);
    if (label) {
      const remaining = /remaining/i.test(label[1]);
      models.push({
        model: group ?? nameLine,
        limit: nameLine,
        percentRemaining: pct === null ? null : (remaining ? pct : round2(100 - pct)),
        percentUsed: pct === null ? null : (remaining ? round2(100 - pct) : pct),
        basis: remaining ? 'remaining' : 'used',
        status,
      });
    } else {
      // 舊版畫面（每行一個模型名）：百分比是剩餘還是已用沒有驗證過，照舊放 percentUsed、不改語意。
      models.push({ model: nameLine, percentUsed: pct, status });
    }
    i += status ? 2 : 1;
  }

  if (models.length > 0) return { type: 'model_quota', models, raw };
  try { return { ...(_parseLooseUsage(raw)), type: 'raw' }; }
  catch { return { type: 'raw', raw }; }
}

// ─── providers ───────────────────────────────────────────────────────────────

interface PtyRunResult { output: string; exitCode: number | null; signal: string | null; timedOut: boolean }

// codex 0.160 起互動模式會啟動共用背景 daemon，而以系統管理員權限執行時 daemon 拒絕啟動，
// TUI 只印錯誤、不出 /status 面板。查額度只要一次性的 TUI，用不到 daemon。
const CODEX_USAGE_ARGS = ['--no-daemon'];

// 舊版 codex 不認得 --no-daemon，clap 印「unexpected argument '--no-daemon'」後直接退出。
// 不能只比對 "--no-daemon"：管理員權限的 daemon 錯誤本身就寫著「rerun ... with --no-daemon」。
export function isCodexNoDaemonUnsupported(output: string): boolean {
  return /unexpected argument\s+'--no-daemon'/i.test(_cleanUsageText(output));
}

// 就緒判斷（輸入是去掉 ANSI 的畫面）。舊版 TUI：標題框的 model 從 loading 換成真模型名。
// 0.160 起標題框一直停在 loading、模型名改到底部狀態列，所以另認「提示列出現」——
// 這條路不能拿 loading 當開機訊號，否則永遠不就緒、等到 60 秒逾時。
export function isCodexTuiReady(screen: string, idleMs: number): boolean {
  if (idleMs <= 1500) return false;
  const tail = screen.slice(-1500);
  if (/Starting MCP|Booting MCP/i.test(tail)) return false;
  let m: RegExpExecArray | null, model: string | null = null;
  const re = /model:\s+(\S+)/g;
  while ((m = re.exec(screen)) !== null) model = m[1];
  if (model && !/^loading$/i.test(model) && !/loading/i.test(tail)) return true;
  return /Ask Codex to do anything|\?\s*for shortcuts/i.test(tail);
}

// 送 /status 的按鍵。0.160 打 `/` 會開指令選單，跟文字同一次寫入的 Enter 會被吞掉，
// 畫面只剩輸入框裡的 `›/status`——所以文字與 Enter 分兩次寫。重試時若 /status 還在輸入框，
// 只補 Enter，不再打一次（否則變成 /status/status）。
export const CODEX_STATUS_ENTER_DELAY_MS = 500;
export function codexStatusWrites(screenTail: string): string[] {
  return /›\s*\/status\s*$/.test(screenTail.trimEnd()) ? ['\r'] : ['/status', '\r'];
}

export const CODEX_SESSION_RATE_LIMITS_MAX_AGE_MS = 10 * 60_000;

function _readTail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

function _codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

// 找最新一筆 rate_limits 事件：只看今天與昨天的資料夾、最多 5 個檔、每檔只讀尾端 256 KB。
function _latestCodexRateLimitEvent(codexHome: string, nowMs: number, maxAgeMs: number): { rl: any; ts: number; line: string } | null {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;
  const dayDir = (offsetDays: number) => {
    const t = new Date(nowMs - offsetDays * 86_400_000);
    return join(root, String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
  };
  const files = [dayDir(0), dayDir(1)].filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).filter((n) => n.endsWith('.jsonl')).map((n) => join(d, n)))
    .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f, mtime } of files.slice(0, 5)) {
    if (nowMs - mtime > maxAgeMs) break; // 更舊的檔案不可能有更新的事件
    const lines = _readTail(f, 256 * 1024).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let event: any;
      try { event = JSON.parse(lines[i]); } catch { continue; }
      const rl = event?.payload?.rate_limits;
      const ts = Date.parse(event?.timestamp ?? '');
      if (!rl || !Number.isFinite(ts)) continue;
      return { rl, ts, line: lines[i].trim() };
    }
  }
  return null;
}

/**
 * 讀 codex 最近的 session 檔裡最後一筆 `rate_limits`（codex 每個 turn 結束都會寫一筆 token_count 事件）。
 * 不用開 TUI：瞬間拿到，管理員權限、daemon、hook 信任畫面都不影響（2026-10-06 實測 session 檔有
 * `primary.used_percent`、`window_minutes`、`resets_at`、`plan_type`）。代價是只反映「最後一次有人用
 * codex」那一刻，所以事件超過 maxAgeMs、或視窗已經重置過就回 null，由呼叫端退回 TUI；結果附 asOf。
 */
export function readCodexSessionRateLimits(codexHome: string, nowMs = Date.now(), maxAgeMs = CODEX_SESSION_RATE_LIMITS_MAX_AGE_MS) {
  let event: ReturnType<typeof _latestCodexRateLimitEvent>;
  // 讀不到（權限、檔案剛被輪替）就回 null，讓呼叫端退回 TUI，不讓整個查詢變 error。
  try { event = _latestCodexRateLimitEvent(codexHome, nowMs, maxAgeMs); } catch { return null; }
  if (!event || nowMs - event.ts > maxAgeMs) return null;
  const { rl, ts, line } = event;
  // 事件雖新，但視窗已經重置過（resets_at 已過）：裡面的已用量不再是現況。
  if ([rl.primary, rl.secondary].some((w: any) => typeof w?.resets_at === 'number' && w.resets_at * 1000 <= nowMs)) return null;
  const win = (w: any) => (w && typeof w.used_percent === 'number' ? {
    percentRemaining: Math.round((100 - w.used_percent) * 100) / 100,
    percentUsed: w.used_percent,
    basis: 'used' as const,
    resetAt: typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : null,
    windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : null,
  } : null);
  const windows = [win(rl.primary), win(rl.secondary)].filter((w): w is NonNullable<ReturnType<typeof win>> => !!w);
  // 依視窗長度分：≤ 6 小時是 5h 額度，≥ 6 天是週額度。
  const fiveHour = windows.find((w) => w.windowMinutes !== null && w.windowMinutes <= 360) ?? null;
  const weekly = windows.find((w) => w.windowMinutes !== null && w.windowMinutes >= 8640) ?? null;
  if (!fiveHour && !weekly) return null;
  return {
    type: 'rate_limits', source: 'session-file', asOf: new Date(ts).toISOString(),
    account: null, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null, model: null,
    fiveHour, weekly, raw: line,
  };
}

/** 最近的 session 檔裡的方案（plan_type）。不看資料時間與重置——方案不常變。讀不到回 null。 */
export function readCodexSessionPlan(codexHome: string): string | null {
  try {
    const plan = _latestCodexRateLimitEvent(codexHome, Date.now(), Number.POSITIVE_INFINITY)?.rl?.plan_type;
    return typeof plan === 'string' ? plan : null;
  } catch { return null; }
}

export class CodexUsageProvider {
  provider = 'codex';
  transport = 'pty';
  constructor(private cliPath: string) {}

  async query({ fresh = false }: { fresh?: boolean } = {}) {
    // 有夠新的 session 檔就不開 TUI（瞬間、不受權限與信任畫面影響）。refresh=true 一律走 TUI。
    if (!fresh) {
      const fromFile = readCodexSessionRateLimits(_codexHome());
      if (fromFile) return fromFile;
    }
    // 先帶參數、不認得才拿掉重跑一次：新版不多付一次啟動成本，也不必另外 spawn `codex --help`
    // （cliPath 在 Windows 常是 .cmd shim，PTY 吃得下、child_process 直接 spawn 吃不下）。
    let result = await this._run(CODEX_USAGE_ARGS);
    if (isCodexNoDaemonUnsupported(result.output)) result = await this._run([]);
    const text = _cleanUsageText(renderTerminal(result.output));
    if (!text) throw new Error('codex usage: no output');
    const usage = parseCodexUsage(text);
    // 沒抓到額度面板也沒錯誤字樣（例：被 hook 信任等互動畫面擋住、/status 送不進去）：同樣是 unknown。
    if (usage.type === 'raw') {
      return { ...usage, type: 'error', error: `no quota panel in output${result.timedOut ? ' (timed out after 60s)' : ''}` };
    }
    // 0.160 的 /status 面板沒有方案欄位；方案不常變，從最近的 session 檔補（不設時間限制）。
    if (usage.type === 'rate_limits' && !usage.plan) {
      const plan = readCodexSessionPlan(_codexHome());
      if (plan) return { ...usage, plan };
    }
    return usage;
  }

  // Codex 啟動時會 booting MCP servers，model 框會先閃現真實模型再退回 "loading"，
  // 數秒後才穩定；若太早送 /status 會被吃掉。因此等輸出靜止(quiescence)再送，
  // 並在面板未出現時重試。
  private _run(args: string[]): Promise<PtyRunResult> {
    return new Promise((resolve, reject) => {
      let ptyProc: any;
      try {
        const pty = _loadPtyModule();
        // 在 homedir 啟動，盡量避免專案層級 MCP server 拖慢開機
        ptyProc = pty.spawn(this.cliPath, args, { name: 'xterm-color', cols: 200, rows: 50, cwd: homedir(), env: process.env });
      } catch (e) { reject(e); return; }
      if (!ptyProc?.pid) { try { ptyProc?.kill?.(); } catch {} reject(new Error('codex pty.spawn returned no pid')); return; }

      let output = '', timedOut = false, settled = false, sent = false, sends = 0;
      let lastDataAt = Date.now(), lastSendAt = 0;
      let pollT: ReturnType<typeof setTimeout> | null = null;
      let hardKillT: ReturnType<typeof setTimeout> | null = null;
      const clearPoll = () => { if (pollT) { clearTimeout(pollT); pollT = null; } };
      const cleanup = () => { clearPoll(); if (hardKillT) { clearTimeout(hardKillT); hardKillT = null; } };
      const kill = () => {
        const pid = ptyProc?.pid;
        try { ptyProc.kill(); } catch {}
        // codex 會 fork 多個子程序（MCP servers），ptyProc.kill 未必收得掉整棵樹；
        // Windows 上用 taskkill /T 連同子孫一起終止，只針對本次 spawn 的 pid，不影響其他 codex。
        if (pid && process.platform === 'win32') {
          try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: false }).on('error', () => {}); } catch {}
        }
        // 保險：若 graceful kill 沒讓進程退出，1 秒後再強制 SIGKILL
        setTimeout(() => { try { ptyProc.kill('SIGKILL'); } catch {} }, 1000);
      };
      const settle = (v: PtyRunResult) => {
        if (settled) return; settled = true; cleanup(); kill(); resolve(v);
      };

      const strip = (x: string) => x.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
      const panelRe = /(?:5h|weekly|rate)\s*limit|%\s*(?:left|used)|resets?\s+\d{1,2}:\d{2}|\d+%\s*context\s+left/i;
      const sendStatus = () => {
        sent = true; sends++; lastSendAt = Date.now();
        const [first, ...rest] = codexStatusWrites(strip(output).slice(-400));
        try { ptyProc.write(first); } catch {}
        for (const keys of rest) setTimeout(() => { if (!settled) { try { ptyProc.write(keys); } catch {} } }, CODEX_STATUS_ENTER_DELAY_MS);
      };

      hardKillT = setTimeout(() => { timedOut = true; settle({ output, exitCode: null, signal: null, timedOut }); }, 60_000);

      ptyProc.onData((d: string) => { output += d; lastDataAt = Date.now(); });
      ptyProc.onExit(({ exitCode, signal }: { exitCode: number; signal: string }) => settle({ output, exitCode, signal, timedOut }));

      const poll = () => {
        pollT = null;
        if (settled) return;
        const s = strip(output);
        const idleMs = Date.now() - lastDataAt;

        if (!sent) {
          if (isCodexTuiReady(s, idleMs)) sendStatus();
        } else if (!panelRe.test(s)) {
          // 重試以「距上次送出」計時，避免畫面持續刷新時 idleMs 偏低而永遠不重試
          if (sends < 3 && Date.now() - lastSendAt > 2500) sendStatus();
          else if (sends >= 3 && idleMs > 2000) {
            // Codex 未輸出 rate limit 面板，快速 settle 避免等到 60s hardKillT
            settle({ output, exitCode: null, signal: null, timedOut: false }); return;
          }
        } else {
          // 面板已出現：等輸出靜止再擷取，確保 5h 與 weekly 兩行都到齊
          if (idleMs > 800) { settle({ output, exitCode: null, signal: null, timedOut: false }); return; }
        }
        pollT = setTimeout(poll, 250);
      };
      pollT = setTimeout(poll, 500);
    });
  }
}

class AgyUsageProvider {
  provider = 'agy';
  transport = 'pty';
  constructor(private cliPath: string) {}

  async query() {
    const result = await this._run();
    const text = _cleanUsageText(renderTerminal(result.output, 220));
    if (!text) throw new Error('agy usage: no output');
    return parseAgyUsage(text);
  }

  private _run(): Promise<PtyRunResult> {
    return new Promise((resolve, reject) => {
      let ptyProc: any;
      try {
        const pty = _loadPtyModule();
        ptyProc = pty.spawn(this.cliPath, ['--dangerously-skip-permissions'], { name: 'xterm-color', cols: 220, rows: 50, cwd: process.cwd(), env: process.env });
      } catch (e) { reject(e); return; }
      if (!ptyProc?.pid) { reject(new Error('agy pty.spawn returned no pid')); return; }

      let output = '', timedOut = false, settled = false, commandSent = false;
      let captureT: ReturnType<typeof setTimeout> | null = null;
      let hardKillT: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => { if (captureT) clearTimeout(captureT); if (hardKillT) clearTimeout(hardKillT); };
      const settle = (v: PtyRunResult) => {
        if (settled) return; settled = true; cleanup();
        try { ptyProc.kill(); } catch {}
        resolve(v);
      };

      hardKillT = setTimeout(() => { timedOut = true; settle({ output, exitCode: null, signal: null, timedOut }); }, 20_000);

      ptyProc.onData((data: string) => {
        output += data;
        if (!commandSent && output.includes('? for shortcuts')) {
          commandSent = true;
          setTimeout(() => {
            try { ptyProc.write('/usage\r'); } catch {}
            const poll = () => {
              if (output.includes('Model Quota') || output.includes('Quota available')) {
                if (captureT) clearTimeout(captureT);
                captureT = setTimeout(() => settle({ output, exitCode: null, signal: null, timedOut: false }), 2000);
              } else {
                captureT = setTimeout(poll, 250);
              }
            };
            captureT = setTimeout(poll, 500);
          }, 800);
        }
      });

      ptyProc.onExit(({ exitCode, signal }: { exitCode: number; signal: string }) => settle({ output, exitCode, signal, timedOut }));
    });
  }
}

class ClaudeUsageProvider {
  provider = 'claude';
  transport = 'pty';
  constructor(private cliPath: string) {}

  async query() {
    const result = await this._run();
    const text = _cleanUsageText(renderTerminal(result.output));
    if (!text) throw new Error('claude usage: no output');
    return parseClaudeUsage(text);
  }

  private _run(): Promise<PtyRunResult> {
    return new Promise((resolve, reject) => {
      let ptyProc: any;
      try {
        const pty = _loadPtyModule();
        ptyProc = pty.spawn(this.cliPath, [], { name: 'xterm-color', cols: 200, rows: 50, cwd: process.cwd(), env: process.env });
      } catch (e) { reject(e); return; }
      if (!ptyProc?.pid) { reject(new Error('claude pty.spawn returned no pid')); return; }

      let output = '', timedOut = false, settled = false, commandSent = false;
      let captureT: ReturnType<typeof setTimeout> | null = null;
      let hardKillT: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => { if (captureT) clearTimeout(captureT); if (hardKillT) clearTimeout(hardKillT); };
      const settle = (v: PtyRunResult) => {
        if (settled) return; settled = true; cleanup();
        try { ptyProc.kill(); } catch {}
        resolve(v);
      };

      hardKillT = setTimeout(() => { timedOut = true; settle({ output, exitCode: null, signal: null, timedOut }); }, 25_000);

      ptyProc.onData((data: string) => {
        output += data;
        // 等 Claude Code prompt 出現後才送 /usage
        if (!commandSent && output.includes('❯')) {
          commandSent = true;
          setTimeout(() => {
            try { ptyProc.write('/usage\r'); } catch {}
            // 等 Claude Max usage 資料真正載入後再截取
            const poll = () => {
              const cleaned = _cleanUsageText(output);
              // 等實際的配額百分比數字出現（"Current session N%" 或 "N% used"）
              // 且確保 "Loading usage data" 已消失
              const hasActualData = /Current\s+session|Current\s+week|session\s+\d+\s*%|\d+\s*%\s*used/i.test(cleaned)
                && !/Loading usage data/i.test(cleaned);
              // 退路：若整個 Usage tab 已渲染但此帳號無配額限制（e.g. 純 API key）
              const hasCostOnly = /Session\s+cost.*\$[\d.]+/i.test(cleaned)
                && !/Loading usage data/i.test(cleaned)
                && (output.match(/❯/g) ?? []).length >= 3;
              if (hasActualData || hasCostOnly) {
                if (captureT) clearTimeout(captureT);
                captureT = setTimeout(() => settle({ output, exitCode: null, signal: null, timedOut: false }), 500);
              } else {
                captureT = setTimeout(poll, 250);
              }
            };
            captureT = setTimeout(poll, 500);
          }, 500);
        }
      });

      ptyProc.onExit(({ exitCode, signal }: { exitCode: number; signal: string }) => settle({ output, exitCode, signal, timedOut }));
    });
  }
}

// ─── UsageService ─────────────────────────────────────────────────────────────

export interface UsageCliPaths {
  claude?: string;
  codex?: string;
  antigravity?: string;
}

const ALL_AGENTS = ['claude', 'codex', 'agy'] as const;
type AgentKey = typeof ALL_AGENTS[number];
const DEFAULT_TTL = 120_000;
const NEG_TTL = 30_000;

function _norm(agent: string): string {
  return agent === 'antigravity' ? 'agy' : agent;
}

function _cacheInfo(hit: boolean, ageMs: number, ttlMs: number) {
  return { hit, ageSeconds: Math.max(0, Math.floor(ageMs / 1000)), ttlSeconds: Math.round(ttlMs / 1000) };
}

function _makeResult(provider: string, status: string, usage: unknown, error: string | null, ttlMs: number) {
  return { provider, transport: 'pty', status, cache: _cacheInfo(false, 0, ttlMs), usage, error };
}

function _errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class UsageService {
  private cache = new Map<string, { result: ReturnType<typeof _makeResult>; capturedAt: number; ttlMs: number }>();
  private inflight = new Map<string, Promise<ReturnType<typeof _makeResult>>>();
  private providers: Map<string, { query(opts?: { fresh?: boolean }): Promise<unknown> }>;

  constructor(cliPaths: UsageCliPaths = {}) {
    const entries: [string, { query(opts?: { fresh?: boolean }): Promise<unknown> }][] = [
      ['claude', new ClaudeUsageProvider(cliPaths.claude ?? '')],
      ['codex',  new CodexUsageProvider(cliPaths.codex ?? '')],
      ['agy',    new AgyUsageProvider(cliPaths.antigravity ?? '')],
    ];
    this.providers = new Map(entries);
  }

  async queryAll({ agents, refresh = false }: { agents?: string[]; refresh?: boolean } = {}) {
    const selected = (agents?.length ? agents.map(_norm) : [...ALL_AGENTS]) as string[];
    const providers = await Promise.all(selected.map((a) => this.queryProvider(a, { refresh })));
    return { ok: true, capturedAt: new Date().toISOString(), providers };
  }

  async queryProvider(agent: string, { refresh = false } = {}): Promise<ReturnType<typeof _makeResult>> {
    const key = _norm(agent);
    if (!(ALL_AGENTS as readonly string[]).includes(key)) {
      return _makeResult(key, 'unavailable', null, `Unknown provider: ${agent}`, NEG_TTL);
    }
    if (!refresh) {
      const cached = this.cache.get(key);
      if (cached) {
        const age = Date.now() - cached.capturedAt;
        if (age < cached.ttlMs) return { ...cached.result, cache: _cacheInfo(true, age, cached.ttlMs) };
      }
    }
    const inFlight = this.inflight.get(key);
    if (inFlight) return inFlight;

    const p = this._queryUncached(key, refresh).then((result) => {
      const ttl = result.status === 'ok' ? DEFAULT_TTL : NEG_TTL;
      const r = { ...result, cache: _cacheInfo(false, 0, ttl) };
      this.cache.set(key, { result: r, capturedAt: Date.now(), ttlMs: ttl });
      return r;
    }).finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  private async _queryUncached(agent: string, fresh = false): Promise<ReturnType<typeof _makeResult>> {
    const provider = this.providers.get(agent);
    if (!provider) return _makeResult(agent, 'unavailable', null, `${agent} CLI not configured`, NEG_TTL);
    try {
      const usage = await provider.query({ fresh });
      // 解析器判定「量不到、畫面是錯誤」（type: 'error'）時回 error，但 usage（含 raw 原文）照樣帶回去。
      const parsed = usage as { type?: unknown; error?: unknown } | null;
      if (parsed?.type === 'error') {
        return _makeResult(agent, 'error', usage, `${agent} usage: ${String(parsed.error ?? 'unknown error')}`, NEG_TTL);
      }
      return _makeResult(agent, 'ok', usage, null, DEFAULT_TTL);
    } catch (e) {
      return _makeResult(agent, 'error', null, _errMsg(e), NEG_TTL);
    }
  }
}

export function createUsageService(cliPaths: UsageCliPaths): UsageService {
  return new UsageService(cliPaths);
}
