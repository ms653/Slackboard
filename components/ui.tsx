'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiError } from './api';

/** Status = icon shape + text + colour, never colour alone (UX §1.2). Icons are aria-hidden. */
const TASK: Record<string, [string, string, string]> = {
  proposed: ['◇', 'Proposed', 'text-violet-300'], todo: ['○', 'To do', 'text-slate-300'],
  in_progress: ['●', 'In progress', 'text-sky-300'], in_review: ['◐', 'In review', 'text-amber-300'],
  blocked: ['⏸', 'Blocked', 'text-rose-300'], done: ['✓', 'Done', 'text-emerald-300'], cancelled: ['–', 'Cancelled', 'text-slate-400'],
};
export function TaskStatus({ s }: { s: string }) {
  const [i, t, c] = TASK[s] ?? ['?', s, ''];
  return <span className={`inline-flex items-center gap-1 ${c}`}><span aria-hidden>{i}</span>{t}</span>;
}

const PRES: Record<string, [string, string, string]> = {
  idle: ['○', 'Idle', 'text-slate-400'], queued: ['◔', 'Queued', 'text-slate-300'], working: ['●', 'Working', 'text-sky-300'],
  reviewing: ['◐', 'Reviewing', 'text-amber-300'], blocked: ['⏸', 'Waiting on you', 'text-rose-300'],
  failed: ['✕', 'Failed', 'text-rose-300'], paused: ['⊘', 'Paused', 'text-amber-300'], disabled: ['–', 'Disabled', 'text-slate-400'],
};
export function Presence({ a, now, pauseLabel }: { a: any; now: number; pauseLabel?: string }) {
  const [i, t, c] = PRES[a.presence] ?? ['?', a.presence, ''];
  let label = t;
  if (a.presence === 'working' && a.running_since) {
    const s = Math.max(0, Math.floor((now - a.running_since) / 1000));
    label = `Working · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  if (a.presence === 'reviewing' && a.running_task) label = `Reviewing T-${a.running_task}`;
  if (a.presence === 'queued') label = `Queued (${a.queued})`;
  if (a.presence === 'failed' && a.retrying) label = `Failed · Retry ${a.retrying}`;
  if (a.presence === 'paused' && pauseLabel) label = `Paused: ${pauseLabel}`;
  return <span className={`inline-flex items-center gap-1 ${c}`}><span aria-hidden>{i}</span>{label}</span>;
}

/** Mutating button: pending label, disabled while in flight, inline role=alert error (UX §8). */
export function ActionButton(p: {
  label: string; pending?: string; run: () => Promise<unknown>; kind?: 'default' | 'primary' | 'danger';
  disabled?: boolean; title?: string; onError?: (e: ApiError) => boolean | void; shortcut?: string; autoFocus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cls = p.kind === 'primary' ? 'bg-sky-700 hover:bg-sky-600 text-white'
    : p.kind === 'danger' ? 'bg-rose-700 hover:bg-rose-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-100';
  const click = async () => {
    setBusy(true); setErr(null);
    try { await p.run(); }
    catch (e: any) { if (!p.onError?.(e)) setErr(`Couldn't ${p.label.toLowerCase()}: ${e.hint || e.code}`); }
    finally { setBusy(false); }
  };
  return (
    <span className="inline-flex flex-col">
      <button type="button" title={p.title} data-shortcut={p.shortcut} data-autofocus={p.autoFocus ? true : undefined} disabled={busy || p.disabled} className={`btn ${cls}`} onClick={click}>
        {busy ? (p.pending ?? `${p.label}…`) : p.label}
        {p.shortcut && !busy ? <kbd className="ml-1.5 opacity-60 text-[10px]">{p.shortcut}</kbd> : null}
      </button>
      {err && <span role="alert" className="text-xs text-rose-300 mt-1 max-w-xs">{err}</span>}
    </span>
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], textarea, input, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dlg-title"
        className="bg-slate-800 border border-slate-600 rounded-lg p-5 w-full max-w-md shadow-xl">
        <h2 id="dlg-title" className="text-lg font-semibold mb-3">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function NoteDialog(p: { title: string; label: string; required?: boolean; confirm: string;
  onDone: (note: string) => Promise<unknown>; onClose: () => void }) {
  const [note, setNote] = useState('');
  const required = p.required ?? true;
  return (
    <Dialog title={p.title} onClose={p.onClose}>
      <label className="block text-sm mb-1" htmlFor="note">{p.label}</label>
      <textarea id="note" data-autofocus className="input w-full h-28" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2 justify-end mt-3">
        <button type="button" className="btn bg-slate-700" onClick={p.onClose}>Cancel</button>
        <ActionButton label={p.confirm} kind="primary" disabled={required && !note.trim()}
          run={async () => { await p.onDone(note.trim()); p.onClose(); }} />
      </div>
    </Dialog>
  );
}

export const ago = (t: number, now: number) => {
  const s = Math.round((now - t) / 1000);
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export function Time({ t, now }: { t: number; now: number }) {
  return <time dateTime={new Date(t).toISOString()} title={new Date(t).toLocaleString()} aria-label={`${hhmm(t)}, ${ago(t, now)}`}>{hhmm(t)}</time>;
}
export const usd = (n: number) => `$${(n ?? 0).toFixed(2)}`;
