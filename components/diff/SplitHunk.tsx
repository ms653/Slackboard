'use client';
import { sideBySide, type DiffHunk, type DiffLine } from '../../lib/domain/diff';
import { Code, GUTTER, LINE_CLS, type HunkCtx } from './UnifiedHunk';

export function SplitHunk({ hunk, ctx }: { hunk: DiffHunk; ctx: HunkCtx }) {
  const rows = sideBySide(hunk);
  const cell = (l: DiffLine | null, side: 'old' | 'new', row: number) => {
    if (!l) return <td key={side} colSpan={2} className="bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(var(--sep)/.05)_6px_7px)]" aria-hidden="true" data-empty={side} />;
    const key = `${ctx.lineId(l)}:${side}`;
    const html = side === 'old' ? ctx.html?.old.get(l) : ctx.html?.new.get(l);
    return [
      <td key={side + 'n'} className={`${GUTTER} ${LINE_CLS[l.type]}`} aria-hidden="true">{side === 'old' ? l.oldNo : l.newNo}</td>,
      <td key={side} role="cell" tabIndex={ctx.activeKey === key ? 0 : -1} data-cell={key} data-hunk={ctx.hunkNo} data-side={side} data-row={row} data-line={ctx.lineId(l)}
        onFocus={() => ctx.setActive(key)} className={`focus-inset relative pr-4 w-1/2 align-top whitespace-pre-wrap break-words text-fg-primary ${side === 'new' ? 'border-l border-separator-strong' : ''} ${LINE_CLS[l.type]}`}>
        <Code line={l} html={html} side={side} />{side === 'new' || l.type === 'del' ? ctx.commentBtn(l) : null}
      </td>,
    ];
  };
  return (
    <table className="w-full font-mono text-mono border-collapse table-fixed" aria-label={`Side by side diff of ${ctx.path}, hunk ${ctx.hunkNo}`} aria-rowcount={rows.length + 1}>
      <colgroup><col className="w-11" /><col /><col className="w-11" /><col /></colgroup>
      <thead><tr><th scope="col" className="sr-only">Old line number</th><th scope="col" className="h-7 px-4 text-left text-caption font-semibold text-fg-tertiary bg-sunken">old</th>
        <th scope="col" className="sr-only">New line number</th><th scope="col" className="h-7 px-4 text-left text-caption font-semibold text-fg-tertiary bg-sunken border-l border-separator-strong">new</th></tr></thead>
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
