'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { BLOCK_TEXT } from './Header';
import { hhmm } from './ui';

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
  return (
    <div className="border-t border-slate-700 p-3">
      <label htmlFor={`composer-${threadId ?? 'root'}`} className="sr-only">{label}</label>
      <div className="flex gap-2">
        <textarea id={`composer-${threadId ?? 'root'}`} ref={ref} data-composer rows={2} className="input flex-1 resize-y" placeholder={label} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button type="button" className="btn bg-sky-700 hover:bg-sky-600 self-end" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
      {err && <div role="alert" className="text-xs text-rose-300 mt-1">Not sent: {err}. <button className="underline" onClick={send}>Retry</button></div>}
      <div className="text-xs text-slate-400 mt-1" aria-live="polite">{hints.map((h) => <div key={h}>{h}</div>)}</div>
    </div>
  );
}
