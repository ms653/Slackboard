'use client';
import type { DiffHunk, DiffLine } from '../../lib/domain/diff';
import type { HunkHtml } from '../../lib/highlight';

export interface HunkCtx {
  path: string; hunkNo: number; lineId: (l: DiffLine) => number; html?: HunkHtml; activeKey: string; setActive: (k: string) => void;
  extra: (l: DiffLine, colSpan: number) => React.ReactNode; commentBtn: (l: DiffLine) => React.ReactNode;
}
export const LINE_CLS = { add: 'bg-diff-add', del: 'bg-diff-del', ctx: 'bg-content', meta: 'bg-content text-fg-tertiary italic' } as const;
export const GUTTER = 'w-11 pr-2 text-right align-top select-none tabular-nums text-caption leading-5 text-fg-tertiary';
const GLYPH_CLS = { add: 'text-diff-add-fg', del: 'text-diff-del-fg', ctx: '', meta: '' } as const;
export const GLYPH = { add: '+', del: '−', ctx: ' ', meta: '' } as const;

export function Code({ line, html, side }: { line: DiffLine; html?: string; side: 'old' | 'new' | 'u' }) {
  const noL = line.type === 'add' ? line.newNo : line.type === 'del' ? line.oldNo : side === 'old' ? line.oldNo : line.newNo;
  const pre = side === 'u'
    ? (line.type === 'add' ? `added line ${noL}:` : line.type === 'del' ? `removed line ${noL}:` : `unchanged line ${noL}:`)
    : `${side} line ${noL}, ${line.type === 'add' ? 'added' : line.type === 'del' ? 'removed' : 'unchanged'}:`;
  return <>
    <span className="sr-only">{pre} </span><span aria-hidden="true" className={`inline-block w-5 text-center select-none font-semibold ${GLYPH_CLS[line.type]}`}>{GLYPH[line.type]}</span>
    {html !== undefined ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{line.text}</code>}
  </>;
}

export function UnifiedHunk({ hunk, ctx }: { hunk: DiffHunk; ctx: HunkCtx }) {
  let r = 0;
  return (
    <table className="w-full font-mono text-mono border-collapse" aria-label={`Unified diff of ${ctx.path}, hunk ${ctx.hunkNo}`} aria-rowcount={hunk.lines.length + 1}>
      <thead className="sr-only"><tr><th scope="col">Old line</th><th scope="col">New line</th><th scope="col">Change</th></tr></thead>
      <tbody>
        {hunk.lines.map((l, i) => {
          if (l.type === 'meta') return <tr key={i}><td colSpan={3} className={`pl-[5.5rem] ${LINE_CLS.meta}`}>{l.text}</td></tr>;
          const key = `${ctx.lineId(l)}:u`, row = r++;
          const html = l.type === 'del' ? ctx.html?.old.get(l) : ctx.html?.new.get(l);
          return [
            <tr key={i} className={`group ${LINE_CLS[l.type]}`}>
              <td className={GUTTER} aria-hidden="true">{l.oldNo ?? ''}</td>
              <td className={GUTTER} aria-hidden="true">{l.newNo ?? ''}</td>
              <td role="cell" tabIndex={ctx.activeKey === key ? 0 : -1} data-cell={key} data-hunk={ctx.hunkNo} data-side="u" data-row={row} data-line={ctx.lineId(l)}
                onFocus={() => ctx.setActive(key)} className="focus-inset relative pr-4 align-top whitespace-pre-wrap break-words text-fg-primary">
                <Code line={l} html={html} side="u" />{ctx.commentBtn(l)}
              </td>
            </tr>,
            ctx.extra(l, 3),
          ];
        })}
      </tbody>
    </table>
  );
}
