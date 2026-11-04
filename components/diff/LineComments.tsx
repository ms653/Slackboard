'use client';
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleMinus, Clock } from 'lucide-react';
import type { DiffLine } from '../../lib/domain/diff';
import { Icon } from '../ui';

export interface Comment { id: number; author_agent_id: string | null; body: string; path: string; line: number; side: 'old' | 'new'; delivery: { state: 'pending' | 'sent' | 'closed'; job_id?: number; reason?: string } }
export const authorOf = (c: Pick<Comment, 'author_agent_id'>) => c.author_agent_id ?? 'you';
export const deliveryText = (d: Comment['delivery']) => d.state === 'sent' ? `Sent to worker run #${d.job_id}`
  : d.state === 'pending' ? "Will be sent with the worker's next run" : d.reason === 'over_limit' ? 'Not sent: over the per-run limit' : 'Not sent: round closed';

export function CommentItem({ c, readOnlyLabel }: { c: Comment; readOnlyLabel?: boolean }) {
  const d = c.delivery;
  return (
    <div role="note" aria-label={`Comment by ${authorOf(c)} on ${c.side} line ${c.line}`} className="my-1 max-w-[560px] rounded-lg bg-elevated shadow-sm p-3 font-sans whitespace-normal" data-comment={c.id}>
      <div className="flex items-center gap-2">
        <span className={`pill font-normal ${authorOf(c) === 'you' ? 'bg-accent/[.12] text-accent' : 'bg-fill-strong text-fg-secondary'}`}>{authorOf(c)}</span>
        <span className="text-caption text-fg-tertiary">{c.side} line {c.line}</span>
      </div>
      <p className="mt-1 text-body text-fg-primary whitespace-pre-wrap break-words">{c.body}</p>
      {!readOnlyLabel && <p className={`mt-2 text-caption flex items-center gap-1.5 ${d.state === 'pending' ? 'text-fg-secondary' : 'text-fg-tertiary'}`}>
        <Icon as={d.state === 'sent' ? CircleCheck : d.state === 'pending' ? Clock : CircleMinus} size={14} className={d.state === 'sent' ? 'text-status-done' : ''} />{deliveryText(d)}</p>}
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
    <div data-diff-composer className="my-1 max-w-[560px] rounded-lg bg-elevated shadow-sm p-3 text-body font-sans whitespace-normal">
      <label htmlFor={id} className="field-label block mb-1.5">{label}</label>
      <textarea id={id} ref={ref} className="textarea min-h-[64px] h-16" maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(); }
        }} />
      {err && <p role="alert" className="field-error">Couldn&apos;t save comment: {err}.</p>}
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-caption text-fg-tertiary">Ctrl+Enter saves, Esc cancels</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!body.trim() || busy} onClick={save}>{err ? 'Retry' : 'Save'}</button>
      </div>
    </div>
  );
}
