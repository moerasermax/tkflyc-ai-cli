/**
 * 警告的長度上限。durable 結果（job-store）與 agy 的 parseOutput 共用，兩條路徑截法一致。
 *
 * 只截頭會把結尾的關鍵字截掉：超長 session id 的 `warning: conversation "<id>" not found`
 * 截到 1,000 字就沒了 `not found`，既認不出是續接失敗、內容也看不出發生什麼。
 * 所以超長時保留前段＋`…`＋結尾，總長仍不超過上限；判斷優先與否要用截斷前的原文。
 */
export const WARNING_MAX_COUNT = 20;
export const WARNING_MAX_CHARS = 1000;
const TAIL_CHARS = 200;

export function truncateWarning(text: string, max: number = WARNING_MAX_CHARS): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1 - TAIL_CHARS);
  let tail = text.slice(text.length - TAIL_CHARS);
  // 不留半個 UTF-16 代理對。
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head}…${tail}`;
}
