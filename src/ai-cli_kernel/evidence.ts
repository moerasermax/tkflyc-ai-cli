/** Kernel 算出的交付證據；不使用模型的測試數字或檔案清單。 */
export interface FileChange { status: string; path: string; oldPath?: string }
export interface ReviewEvidence { diff: string; stat: string; files: string; baselineTests: FileChange[] }

export const STAT_CHARS = 8000;
export const FILE_LIST_CHARS = 16000;
export const TEST_SUMMARY_CHARS = 4000;

/** -z 不能用換行或 tab 切路徑：rename 有來源和目的兩個 NUL 欄位。 */
export function parseNameStatusZ(text: string): FileChange[] {
  const fields = text.split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    const source = fields[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status) || source === undefined || source === '') throw new Error('git 變更清單格式不完整');
    if (/^[RC]/.test(status)) {
      const path = fields[i++];
      if (!path) throw new Error('git rename/copy 缺少目的路徑');
      changes.push({ status, oldPath: source, path });
    } else changes.push({ status, path: source });
  }
  return changes;
}

export function isTestPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /(?:^|\/)(?:test|tests|__tests__|spec)\//.test(path)
    || /\.(?:test|spec)\./.test(name) || /^test_.*\.py$/.test(name) || /_test\./.test(name);
}

/** name-status 是基準到交付的比較，M/D/T 的來源必然在基準存在；R 看舊路徑。 */
export function changedBaselineTests(changes: readonly FileChange[]): FileChange[] {
  return changes.filter(change => /^[MDTR]/.test(change.status) && isTestPath(change.oldPath ?? change.path));
}

export function changeLabel(change: FileChange): string {
  return `${change.status} ${change.oldPath === undefined ? '' : `${JSON.stringify(change.oldPath)} -> `}${JSON.stringify(change.path)}`;
}

/** 清單只在項目邊界截斷，另保留總數；特殊字元路徑以 JSON 表示。 */
export function boundedList(lines: readonly string[], maxChars: number, label: string): string {
  let used = 0, shown = 0;
  const output: string[] = [];
  // 以最長數字與截斷形式預留標籤，避免大量短檔名剛好填滿額度時超限。
  const reserve = `${label}：共 ${lines.length} 項，顯示 ${lines.length} 項，截斷 ${lines.length} 項\n`.length;
  for (const line of lines) {
    if (used + line.length + 1 > Math.max(0, maxChars - reserve)) break;
    output.push(line); used += line.length + 1; shown++;
  }
  return `${label}：共 ${lines.length} 項，顯示 ${shown} 項${shown < lines.length ? `，截斷 ${lines.length - shown} 項` : '，完整'}\n${output.join('\n')}`;
}

export function boundedStat(stat: string): string {
  if (stat.length <= STAT_CHARS) return stat;
  const note = `\n（stat 共 ${stat.length} 字元，截斷；上限 ${STAT_CHARS} 字元）`;
  return stat.slice(0, STAT_CHARS - note.length) + note;
}

/** 只解析輸出結尾的完整終結摘要，不以 exit 0、零散 PASS 或中途小計猜數量。 */
export function testSummary(tail: string | undefined): string {
  const clean = (tail ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd();
  const runner = clean.match(/(?:^|\n)共 (\d+) 支：PASS (\d+)、FAIL (\d+)，總耗時 [\d.]+s$/);
  const simple = clean.match(/(?:^|\n)(\d+) passed, (\d+) failed$/);
  const tap = clean.match(/(?:^|\n)# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)(?:\r?\n# (?:cancelled|skipped|todo) \d+)*\r?\n# duration_ms [\d.]+$/);
  const tapOther = tap ? [...tap[0].matchAll(/^# (?:cancelled|skipped|todo) (\d+)\r?$/gm)].reduce((sum, match) => sum + Number(match[1]), 0) : 0;
  let counts: { passed: number; failed: number; unit: string } | null = null;
  if (runner && Number(runner[1]) === Number(runner[2]) + Number(runner[3])) counts = { passed: Number(runner[2]), failed: Number(runner[3]), unit: '測試腳本' };
  else if (simple) counts = { passed: Number(simple[1]), failed: Number(simple[2]), unit: '測試' };
  else if (tap && Number.isSafeInteger(Number(tap[1])) && Number(tap[1]) === Number(tap[2]) + Number(tap[3]) + tapOther) counts = { passed: Number(tap[2]), failed: Number(tap[3]), unit: '測試（TAP）' };
  const header = counts && Number.isSafeInteger(counts.passed) && Number.isSafeInteger(counts.failed)
    ? `通過 ${counts.passed}、失敗 ${counts.failed}（${counts.unit}）` : '未解析（輸出結尾沒有可確認的通過／失敗數）';
  const note = clean.length > TEST_SUMMARY_CHARS - 200 ? `\n（測試輸出尾段共 ${clean.length} 字元，截斷，僅附最後部分）` : '';
  return `${header}${note}\n${clean.slice(-(TEST_SUMMARY_CHARS - 200))}`;
}

/** 全量 diff 超額才逐檔取片段；不解析 git 的 quoted diff header。 */
export function segmentedDiff(changes: readonly FileChange[], full: string, maxChars: number, readDiff: (change: FileChange) => string): { diff: string; files: string } {
  const ordered = [...changes].sort((a, b) => Number(isTestPath(b.path) || isTestPath(b.oldPath ?? '')) - Number(isTestPath(a.path) || isTestPath(a.oldPath ?? '')));
  const labels: string[] = [];
  const pieces: string[] = [];
  let remaining = maxChars;
  for (const change of ordered) {
    let coverage = '完整';
    if (full.length > maxChars) {
      if (remaining <= 0) coverage = '全部省略';
      else {
        const text = readDiff(change);
        const piece = text.slice(0, remaining);
        pieces.push(piece);
        remaining -= piece.length;
        if (piece.length < text.length) coverage = '部分省略';
      }
    }
    labels.push(`${changeLabel(change)} [diff ${coverage}]`);
  }
  return {
    diff: full.length <= maxChars ? full : pieces.join(''),
    files: boundedList(labels, FILE_LIST_CHARS, `變更檔案（A/M/D/R 等狀態；diff 共 ${full.length} 字元、額度 ${maxChars}；測試優先；完整 ${labels.filter(line => line.endsWith('[diff 完整]')).length}、部分省略 ${labels.filter(line => line.endsWith('[diff 部分省略]')).length}、全部省略 ${labels.filter(line => line.endsWith('[diff 全部省略]')).length}）`),
  };
}

/** 每次從原始 worker 回覆重建再附加，不在舊 report.md 上追加，重啟不會重複。 */
export function kernelTestInventory(changes: readonly FileChange[]): string {
  return `\n\n## kernel 統計\n基準已存在、交付時遭修改或刪除的測試檔：共 ${changes.length} 個。重新命名列出來源與目的；此清單不判斷改動理由。\n${changes.length ? changes.map(change => `- ${changeLabel(change)}`).join('\n') : '無'}\n`;
}
