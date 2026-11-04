'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { BLOCK_TEXT } from './Header';
import { ArrowUp, CircleSlash } from 'lucide-react';
import { Icon, hhmm } from './ui';

/** Hint computed from the server's wakePreview (TECH §5.1) — the same function that enqueues. */
export function hintText(p: any, threadStatus: string | null, boot: any): string[] {
  if (threadStatus === 'closed') return ['No agent will run (thread closed)'];
  if (threadStatus === 'capped' || !p) return ['No agent will run (thread capped)'];
  let first = p.unblocksTask
    ? (p.kind === 'review' ? `Will unblock T-${p.unblocksTask} and wake director to re-review`
      : p.kind === 'help' ? `Will ask the director again on T-${p.unblocksTask}` : `Will wake ${p.agent} and unblock T-${p.unblocksTask}`)
    : `Will wake ${p.agent}`;
  if (p.jobs && p.jobs.max && p.jobs.used / p.jobs.max >= 0.8) first += ` · Uses 1 of ${p.jobs.max - p.jobs.used} remaining agent runs`;
  const lines = [first];
  if (p.blocked_by) {
    const reason = p.blocked_by === 'usage_limit' && boot?.system?.paused_until ? `usage limit until ${hhmm(boot.system.paused_until)}` : BLOCK_TEXT[p.blocked_by];
    lines.push(`Saved; agents are paused (${reason}), will run after resume`);
  }
  return lines;
}

export function Composer({ threadId, preview, threadStatus, onSent, label, spawnQueued }: {
  threadId: number | null; preview: any; threadStatus: string | null; onSent?: (r: any) => void; label: string; spawnQueued?: boolean }) {
  const { boot, refresh, composerPrefill, set } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (composerPrefill && threadId === null) { setText(composerPrefill); set({ composerPrefill: null }); ref.current?.focus(); }
  }, [composerPrefill, threadId, set]);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try { const r = await api('/api/messages', { body: { thread_id: threadId, body: text } }); setText(''); await refresh(); onSent?.(r); }
    catch (e: any) { setErr(e.hint || e.code); }
    finally { setBusy(false); }
  };
  const hints = spawnQueued ? ['Director queued (after spawn approval)'] : hintText(preview, threadStatus, boot);
  const id = `composer-${threadId ?? 'root'}`;
  return (
    <div className="mx-4 mb-4 mt-2 rounded-xl bg-elevated shadow-sm ring-1 ring-separator-strong focus-within:ring-2 focus-within:ring-accent transition-shadow">
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea id={id} ref={ref} data-composer rows={2} aria-describedby={`${id}-hint`}
        className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-body-lg text-fg-primary placeholder:text-fg-tertiary focus:outline-none min-h-[44px] max-h-[200px] rounded-t-xl" placeholder={label} value={text}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <div className="flex items-end gap-2 px-2.5 pb-2">
        <div id={`${id}-hint`} className="flex-1 min-w-0 text-caption text-fg-secondary" aria-live="polite">
          {hints.map((h, i) => i === 0 ? <div key={h} className="truncate" title={h}>{h}</div>
            : <div key={h} className="flex items-start gap-1 text-status-warn"><Icon as={CircleSlash} size={14} className="mt-px" />{h}</div>)}
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Sending…' : <><Icon as={ArrowUp} size={14} />Send</>}</button>
      </div>
      {err && <div role="alert" className="px-3.5 pb-2 text-callout text-danger">Not sent: {err}. <button className="btn btn-link inline" onClick={send}>Retry</button></div>}
    </div>
  );
}
