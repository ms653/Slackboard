'use client';
import { useEffect, useRef, useState } from 'react';
import type { DiffLine } from '../../lib/domain/diff';

export interface Comment { id: number; author_agent_id: string | null; body: string; path: string; line: number; side: 'old' | 'new'; delivery: { state: 'pending' | 'sent' | 'closed'; job_id?: number; reason?: string } }
export const authorOf = (c: Pick<Comment, 'author_agent_id'>) => c.author_agent_id ?? 'you';
export const deliveryText = (d: Comment['delivery']) => d.state === 'sent' ? `Sent to worker run #${d.job_id}`
  : d.state === 'pending' ? "Will be sent with the worker's next run" : d.reason === 'over_limit' ? 'Not sent: over the 50-comment limit per run' : 'Not sent: round closed';

export function CommentItem({ c, readOnlyLabel }: { c: Comment; readOnlyLabel?: boolean }) {
  return (
    <div role="note" aria-label={`Comment by ${authorOf(c)} on ${c.side} line ${c.line}`} className="my-1 ml-10 border-l-2 border-sky-500 pl-2 text-xs font-sans text-slate-100 bg-slate-800/60 rounded-r py-1 pr-2" data-comment={c.id}>
      <span className="inline-block px-1.5 rounded bg-slate-700 mr-1 font-semibold">{authorOf(c)}</span>
      <span className="text-slate-300">{c.side} line {c.line}</span>
      <p className="whitespace-pre-wrap break-words">{c.body}</p>
      {!readOnlyLabel && <p className="text-slate-300">{deliveryText(c.delivery)}</p>}
    </div>
  );
}

export interface ComposerState { line: DiffLine; path: string; side: 'old' | 'new'; label: string; invoker: HTMLElement | null }

/** Inline textarea: Ctrl+Enter saves, Esc cancels (and does not close the pane). */
export function CommentComposer({ id, label, onSave, onCancel }: { id: string; label: string; onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await onSave(body.trim()); } catch (e: any) { setErr(e.hint || e.code || 'error'); setBusy(false); }
  };
  return (
    <div data-diff-composer className="ml-10 my-1 text-xs font-sans">
      <label htmlFor={id} className="block mb-1">{label}</label>
      <textarea id={id} ref={ref} className="input w-full h-16" maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(); }
        }} />
      {err && <p role="alert" className="text-rose-300">Couldn&apos;t save comment: {err}.</p>}
      <div className="flex gap-2 mt-1">
        <button type="button" className="btn bg-sky-700" disabled={!body.trim() || busy} onClick={save}>{err ? 'Retry' : 'Save'}</button>
        <button type="button" className="btn bg-slate-700" onClick={onCancel}>Cancel</button>
        <span className="text-slate-400 self-center">Ctrl+Enter saves, Esc cancels</span>
      </div>
    </div>
  );
}
