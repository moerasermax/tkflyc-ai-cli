/** 解析設定檔的版控格式。只讀頂端的單層 YAML 字串對映。 */
import { readFileSync } from 'node:fs';

export const SETTINGS = '_流程設定.md';
const required = [...Array.from({ length: 12 }, (_, i) => 'S' + (i + 1)), 'limits'];
const placeholder = /^<[^<>\r\n]*>$|\bTODO\b/u;

function scalar(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error('單引號字串格式錯誤');
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[-?:](?:\s|$)|^[!&*#|>@%{}\[\]`]|:\s|\s#|^(?:null|~|true|false|\d+)$/iu.test(value)) {
    throw new Error('請使用單行字串，特殊字元請加引號');
  }
  return value;
}

export function parseSettings(text) {
  const block = /^\uFEFF?[ \t]*(?:\r?\n[ \t]*)*```yaml[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!block || block.index !== 0) throw new Error('檔案頂端缺有效的 yaml 區塊');
  const values = Object.create(null);
  for (const [i, line] of block[1].split(/\r?\n/).entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const pair = /^([A-Za-z][A-Za-z0-9]*):[ \t]+(\S.*)$/.exec(line.trimEnd());
    if (!pair) throw new Error('yaml 區塊第 ' + (i + 1) + ' 行格式錯誤');
    const [, key, raw] = pair;
    if (Object.hasOwn(values, key)) throw new Error('yaml 區塊有重複鍵 ' + key);
    if (key === 'schemaVersion') {
      if (raw !== '1') throw new Error('schemaVersion 必須是 1');
      values[key] = 1;
    } else {
      if (!required.includes(key)) throw new Error('yaml 區塊第 ' + (i + 1) + ' 行有未定義的鍵');
      const value = scalar(raw);
      if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error(key + ' 必須是非空的單行字串');
      }
      values[key] = value;
    }
  }
  const missing = ['schemaVersion', ...required].filter(key => !Object.hasOwn(values, key));
  const placeholders = required.filter(key => placeholder.test(values[key]?.trim() ?? ''));
  const problems = [];
  if (missing.length) problems.push('缺少 ' + missing.join('、'));
  if (placeholders.length) problems.push('仍為佔位值：' + placeholders.join('、'));
  if (problems.length) throw new Error(problems.join('。'));
  return values;
}

export function loadSettings(path) {
  try {
    return { state: 'READY', values: parseSettings(readFileSync(path, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'INIT' };
    const problem = error instanceof SyntaxError ? '雙引號字串格式錯誤'
      : error.code ? '設定檔無法讀取（' + error.code + '）' : error.message;
    return { state: 'INVALID', problem };
  }
}
