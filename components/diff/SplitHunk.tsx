'use client';
import { sideBySide, type DiffHunk, type DiffLine } from '../../lib/domain/diff';
import { Code, LINE_CLS, type HunkCtx } from './UnifiedHunk';

export function SplitHunk({ hunk, ctx }: { hunk: DiffHunk; ctx: HunkCtx }) {
  const rows = sideBySide(hunk);
  const cell = (l: DiffLine | null, side: 'old' | 'new', row: number) => {
    if (!l) return <td key={side} colSpan={2} className="bg-slate-900" aria-hidden="true" data-empty={side} />;
    const key = `${ctx.lineId(l)}:${side}`;
    const html = side === 'old' ? ctx.html?.old.get(l) : ctx.html?.new.get(l);
    return [
      <td key={side + 'n'} className={`w-8 text-right pr-1 text-slate-300 select-none ${LINE_CLS[l.type]}`} aria-hidden="true">{side === 'old' ? l.oldNo : l.newNo}</td>,
      <td key={side} role="cell" tabIndex={ctx.activeKey === key ? 0 : -1} data-cell={key} data-hunk={ctx.hunkNo} data-side={side} data-row={row} data-line={ctx.lineId(l)}
        onFocus={() => ctx.setActive(key)} className={`whitespace-pre-wrap break-all pl-1 w-1/2 align-top outline-offset-[-2px] focus:outline focus:outline-2 focus:outline-sky-400 ${LINE_CLS[l.type]}`}>
        <Code line={l} html={html} side={side} />{side === 'new' || l.type === 'del' ? ctx.commentBtn(l) : null}
      </td>,
    ];
  };
  return (
    <table className="w-full text-xs font-mono border-collapse table-fixed" aria-label={`Side by side diff of ${ctx.path}, hunk ${ctx.hunkNo}`} aria-rowcount={rows.length + 1}>
      <colgroup><col className="w-8" /><col /><col className="w-8" /><col /></colgroup>
      <thead><tr><th scope="col" className="sr-only">Old line number</th><th scope="col" className="text-left text-slate-300 font-normal border-r border-slate-700">old</th>
        <th scope="col" className="sr-only">New line number</th><th scope="col" className="text-left text-slate-300 font-normal">new</th></tr></thead>
      <tbody>
        {rows.map((r, i) => [
          <tr key={i} className="group">{cell(r.old, 'old', i)}{cell(r.new, 'new', i)}</tr>,
          r.meta ? <tr key={i + 'm'}><td colSpan={4} className={LINE_CLS.meta}>{r.meta.text}</td></tr> : null,
          // comments sit under the row that holds their anchored line
          r.old && r.old.type === 'del' ? ctx.extra(r.old, 4) : null,
          r.new ? ctx.extra(r.new, 4) : null,
        ])}
      </tbody>
    </table>
  );
}
