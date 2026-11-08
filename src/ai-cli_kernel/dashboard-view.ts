/** 純畫面組裝：不寫終端機；所有外來文字移除控制序列後才量寬或換行。 */
import { stripVTControlCharacters } from 'node:util';
import { actionsFor, clockTime, startedAt, stateHelp, reasonLabel, templateLabel, shortState, stepLabel, progressLine,
  type KernelAction, type KernelDetail, type KernelSnapshot } from './dashboard-rules.js';

export const clean = (text: string): string => stripVTControlCharacters(text).replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const colorsEnabled = (env: NodeJS.ProcessEnv): boolean => !env.NO_COLOR && env.TERM !== 'dumb';
const RESET = '\x1b[0m';
// 僅套在 clean() 過的文字上；以局部關閉碼保留外層反白。
const paint = (text: string, code: string, color: boolean): string => color ? `\x1b[${code}m${text}\x1b[${code === '7' ? '27' : code === '1' || code === '2' ? '22' : '39'}m` : text;
const stateColor = (state: string): string => ({ completed: '32', running: '36', awaiting_approval: '33', waiting_human: '33', interrupted: '33', failed: '31', cancelled: '90', budget_exhausted: '90' }[state] ?? '39');
const warning = (text: string, color: boolean): string => paint(paint(text, '31', color), '1', color);
const heading = (text: string, color: boolean): string => paint(text, '1', color);
const field = (text: string, color: boolean): string => text.replace(/^([^：]*：)/, label => paint(label, '2', color));
const keys = (text: string, color: boolean): string => text.split(/(↑↓\/j\/k|↑↓ j\/k|PgUp\/PgDn|PgUp\/Dn|q\/Ctrl\+C|n／Esc|PgUp|PgDn|Esc|1–9|(?<!\w)[yqtrfg](?!\w))/).map((part, index) => paint(part, index % 2 ? '36' : '2', color)).join('');
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** 重用 app/jobs.ts 的 CJK／全形區間規則；不能 import jobs 的 process-service I/O 依賴。
 * 在它的基礎上按 grapheme 量寬，避免裁斷組合字與 ZWJ emoji。 */
function graphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return 2;
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (/\p{Mark}|\p{Cf}/u.test(character)) continue;
    width += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7ff || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300) ? 2 : 1;
  }
  return width;
}
export function displayWidth(text: string): number {
  return [...segments.segment(clean(text))].reduce((n, item) => n + graphemeWidth(item.segment), 0);
}
/** styled 僅供已清理外來文字後的內部 SGR；控制序列不佔格且不可切半。 */
export function clipCells(text: string, columns: number, styled = false): string {
  let out = '', used = 0;
  const parts = styled ? text.split(/(\x1b\[[0-9;]*m)/) : [clean(text)];
  outer: for (const part of parts) {
    if (styled && /^\x1b\[[0-9;]*m$/.test(part)) { out += part; continue; }
    for (const { segment } of segments.segment(clean(part).replace(/\r?\n/g, ' '))) {
      const width = graphemeWidth(segment);
      if (used + width > columns) break outer;
      out += segment; used += width;
    }
  }
  return out + (styled ? RESET : '');
}
export function wrapCells(text: string, columns: number): string[] {
  const max = Math.max(1, columns), lines: string[] = [];
  for (const part of clean(text).split(/\r?\n/)) {
    let line = '', used = 0;
    for (const { segment } of segments.segment(part)) {
      const width = graphemeWidth(segment);
      if (used + width > max && line) { lines.push(line); line = ''; used = 0; }
      // 一格視窗裝不下雙格字，使用佔位符，避免 terminal autowrap。
      line += width > max ? '?' : segment; used += width > max ? 1 : width;
    }
    lines.push(line);
  }
  return lines;
}
const missing = (value: string | null | undefined): string => value || '未提供';
export type CommandShell = 'posix' | 'powershell';
/** 確認畫面顯示可貼上的命令；雙引號無法保護分支名稱裡的 $ 或反引號。 */
export const commandLine = (args: readonly string[], shell: CommandShell = 'posix'): string => 'ai-cli kernel ' + args.map(a =>
  /^[\w./:@=-]+$/.test(a) ? a : shell === 'powershell' ? `'${a.replace(/'/g, "''")}'` : `'${a.replace(/'/g, "'\"'\"'")}'`).join(' ');

export function detailLines(d: KernelDetail | null, columns: number, color = false): string[] {
  if (!d) return ['沒有選中的 run，或正在讀取詳細資料。'];
  const dev = d.develop;
  const rows: Array<[string, string | null | undefined]> = [
    ['編號', d.runId], ['開始', startedAt(d.runId)], ['目標', d.goal], ['範本', templateLabel(d.template)],
    ['狀態', `${d.label}（${d.state}）`], ['說明', stateHelp(d)], ['原因', reasonLabel(d.reason)], ['細節', d.detail],
    ['來源', d.origin], ['工作目錄', d.workFolder], ['模型', d.models], ['權限', d.boundary], ['進度', progressLine(d.progress)],
    ['正在做', d.currentAction], ['驗收', d.accepted === null ? '尚無結果' : d.accepted ? '通過' : '沒過'],
    ['分支', dev?.branch], ['測試指令', dev?.testCommand], ['通過的 commit', dev?.verifiedCommit],
    ['可改路徑', dev ? dev.allowedPaths.length ? dev.allowedPaths.join('、') : '不限' : '不適用'],
    ['回復點', dev?.checkpointRef], ['下一步', d.nextAction],
  ];
  const lines = rows.flatMap(([label, value]) => wrapCells(`${label}：${missing(value)}`, columns).map((line, index) => {
    const at = index === 0 ? line.indexOf('：') + 1 : 0;
    const tone = label === '狀態' ? stateColor(d.state) : label === '驗收' && d.accepted !== null ? d.accepted ? '32' : '31' : null;
    return paint(line.slice(0, at), '2', color) + (tone ? paint(line.slice(at), tone, color) : line.slice(at));
  }));
  for (const notice of dev?.notices ?? []) lines.push(...wrapCells(`⚠ 注意：${notice}`, columns).map(line => warning(line, color)));
  lines.push('', heading('步驟', color));
  if (!d.steps.length) lines.push('尚無步驟。');
  for (const step of d.steps) lines.push(...wrapCells(`[${stepLabel(step.status)}] ${step.id} ${step.title}`, columns).map(line => paint(line, step.status === 'passed' ? '32' : step.status === 'failed' ? '31' : step.status === 'running' ? '36' : '33', color)));
  const actions = actionsFor(d);
  lines.push('', heading('可以做的事', color), ...wrapCells('r 看完整報告：閱讀這個 run 的全部報告，不改任何東西。', columns));
  if (!actions.length) lines.push('目前沒有可用操作。');
  for (const [i, action] of actions.entries()) lines.push(...wrapCells(`${i + 1} ${action.label}：${action.summary}`, columns));
  return lines;
}
export function confirmationLines(action: KernelAction, columns: number, shell: CommandShell = 'posix', color = false): string[] {
  return [
    `確定要「${action.label}」嗎？`, `對象：${action.runId ?? '全域自動觸發開關'}`,
    `會發生：${action.summary}`, `⚠ 注意：${action.warning ?? '這個操作會寫入狀態或改動資料。'}`,
    `綁定 commit：${action.confirmedCommit ?? action.commit ?? '不適用'}`, '實際指令：', commandLine(action.args, shell),
    ...(action.isRelease ? ['取得放行 id 後（結果不明不重試）：', 'ai-cli kernel release run <本次新建的 id>'] : []),
  ].flatMap((line, index) => wrapCells(line, columns).map(text => index === 0 ? heading(paint(text, '33', color), color) : index === 3 ? warning(text, color) : index === 6 ? text : field(text, color)));
}
export interface DashboardView {
  snapshot: KernelSnapshot; selected: string | null; detail: KernelDetail | null; pending: KernelAction | null;
  report: string | null; scroll: number; notice: string; busy: boolean; noticeTone?: 'success' | 'error' | 'running';
}
export interface DashboardFrame { text: string; scroll: number; confirmationFits: boolean; pageSize: number }
export function renderDashboard(view: DashboardView, columns: number, rows: number, shell: CommandShell = 'posix', color = false): DashboardFrame {
  const width = Math.max(1, columns - 1), height = Math.max(1, rows);
  if (width < 20 || height < 10) return {
    text: ['視窗太小，請放大（至少 21×10）。', view.pending ? '確認暫停；放大後 y／n／Esc' : 'q 離開，resize 重畫'].slice(0, height).map(s => clipCells(s, width, color)).join('\r\n'),
    scroll: view.scroll, confirmationFits: false, pageSize: 1,
  };
  const snap = view.snapshot;
  const top = [
    `更新於：${snap.at ? clockTime(snap.at) : '尚未成功更新'}${snap.error ? '（更新失敗，保留舊資料）' : ''}`,
    `執行中：${snap.at ? snap.active ?? '沒有' : '未知'}（${snap.active ? 5 : 30} 秒更新）`,
    `自動觸發：${snap.triggersOn === null ? '未知' : snap.triggersOn ? '開' : '關'}`,
    `待歸檔：${snap.at ? `${snap.pendingArchive} 筆` : '未知'}`,
  ].map(line => field(clean(line), color));
  const message = snap.error || view.notice || (view.busy ? '操作執行中…' : '');
  if (message) top.push(...wrapCells(`結果：${message}`, width).slice(0, 2).map(line => paint(line, snap.error || view.noticeTone === 'error' ? '31' : view.busy ? '36' : '32', color)));
  const footer = view.pending ? 'y 確定執行　n／Esc 取消（其他鍵忽略）'
    : view.report !== null ? 'PgUp/PgDn 捲報告　Esc 返回　q/Ctrl+C 離開'
      : width < 60 ? '↑↓/j/k 選 PgUp/Dn 捲\n1–9 操作 r 報告\nt 觸發 f 執行 g 更新\nq/Ctrl+C 離開'
        : '↑↓ j/k 選擇　PgUp/PgDn 捲動　1–9 操作　r 報告　t 觸發　f 執行中　g 更新　q/Ctrl+C 離開';
  let footerLines = wrapCells(footer, width).map(line => keys(line, color));
  const bodyHeight = Math.max(1, height - top.length - footerLines.length);
  let pageSize = bodyHeight;
  let body: string[] = [], scroll = view.scroll, confirmationFits = true;
  if (view.pending) {
    const lines = confirmationLines(view.pending, width, shell, color);
    confirmationFits = lines.length <= bodyHeight;
    body = confirmationFits ? lines : [...lines.slice(0, Math.max(0, bodyHeight - 1)), '內容未全顯示，請放大視窗才能確認。'];
  } else if (view.report !== null) {
    const lines = [heading('完整報告（Esc 返回）', color), ...wrapCells(view.report, width)];
    scroll = Math.min(scroll, Math.max(0, lines.length - bodyHeight));
    body = lines.slice(scroll, scroll + bodyHeight);
  } else {
    const wide = width >= 100, leftWidth = wide ? Math.min(40, Math.floor(width / 3)) : width;
    const selectedIndex = Math.max(0, snap.runs.findIndex(run => run.runId === view.selected));
    const listHeight = wide ? bodyHeight : Math.min(4, Math.max(1, bodyHeight - 2));
    const listStart = Math.max(0, selectedIndex - listHeight + 2);
    const list = [heading('最近的 run', color), ...snap.runs.slice(listStart, listStart + Math.max(0, listHeight - 1)).map(run => {
      const selected = run.runId === view.selected;
      const line = `${selected ? '▶' : ' '} ${clean(startedAt(run.runId))} ${paint(clean(shortState(run.state, run.label)), stateColor(run.state), color)} ${clean(run.goal)}`;
      return paint(line, '7', color && selected);
    })];
    if (!snap.runs.length) list.push(snap.at ? '還沒有 run。' : '尚未取得 run 清單。');
    const rightWidth = wide ? width - leftWidth - 3 : width;
    const detail = detailLines(view.detail?.runId === view.selected ? view.detail : null, rightWidth, color);
    const detailHeight = wide ? bodyHeight : Math.max(1, bodyHeight - list.length);
    pageSize = detailHeight;
    scroll = Math.min(scroll, Math.max(0, detail.length - detailHeight));
    const right = detail.slice(scroll, scroll + detailHeight);
    if (wide) body = Array.from({ length: bodyHeight }, (_, i) => {
      const left = clipCells(list[i] ?? '', leftWidth, color);
      return left + ' '.repeat(leftWidth - displayWidth(left)) + ' │ ' + (right[i] ?? '');
    });
    else body = [...list.map(line => clipCells(line, width, color)), ...right];
  }
  if (view.pending && !confirmationFits) footerLines = wrapCells('請放大視窗；n／Esc 取消，y 暫停', width).map(line => keys(line, color));
  const available = height - top.length - footerLines.length;
  if (view.pending && body.length > available) confirmationFits = false;
  body = body.slice(0, Math.max(0, available));
  const lines = [...top, ...body, ...Array(Math.max(0, available - body.length)).fill(''), ...footerLines];
  return { text: lines.slice(0, height).map(line => clipCells(line, width, color)).join('\r\n'), scroll, confirmationFits, pageSize };
}
