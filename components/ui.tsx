'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown, Circle, CircleCheck, CircleDashed, CircleDot, CircleMinus, CirclePause, CircleSlash, CircleX, Clock, Eye,
  LoaderCircle, RotateCcw, TriangleAlert, type LucideIcon,
} from 'lucide-react';
import type { ApiError } from './api';

/** One line-icon set (DESIGN §3). Icons are always aria-hidden; a text label sits next to every one. */
export function Icon({ as: I, size = 16, className = '' }: { as: LucideIcon; size?: 14 | 16 | 18 | 24; className?: string }) {
  return <I aria-hidden focusable={false} size={size} strokeWidth={size <= 14 ? 1.75 : 1.5} className={`shrink-0 ${className}`} />;
}

/** Server badge glyphs (lib/server/read.ts) mapped to icons. */
const GLYPH_ICON: Record<string, [LucideIcon, string]> = {
  '⟲': [RotateCcw, 'text-status-warn'], '✕': [CircleX, 'text-danger'], '⏸': [CirclePause, 'text-danger'],
};
export function GlyphIcon({ glyph }: { glyph: string }) {
  const [I, c] = GLYPH_ICON[glyph] ?? [TriangleAlert, 'text-status-warn'];
  return <Icon as={I} size={14} className={c} />;
}

/** Status = icon shape + text + colour, never colour alone (UX §1.2). Full class strings so Tailwind generates them. */
const TASK: Record<string, [LucideIcon, string, string, string]> = {
  proposed: [CircleDashed, 'Proposed', 'bg-status-proposed/[.12] text-status-proposed', 'text-status-proposed'],
  todo: [Circle, 'To do', 'bg-fill-strong text-fg-secondary', 'text-status-todo'],
  in_progress: [CircleDot, 'In progress', 'bg-status-progress/[.12] text-status-progress', 'text-status-progress'],
  in_review: [Eye, 'In review', 'bg-status-review/[.12] text-status-review', 'text-status-review'],
  blocked: [CirclePause, 'Blocked', 'bg-status-blocked/[.12] text-status-blocked', 'text-status-blocked'],
  done: [CircleCheck, 'Done', 'bg-status-done/[.12] text-status-done', 'text-status-done'],
  cancelled: [CircleMinus, 'Cancelled', 'bg-fill-strong text-fg-secondary', 'text-status-cancelled'],
};
export const STATUS_ICON_CLS = (s: string) => (TASK[s] ?? [Circle, s, '', ''])[3];
export const STATUS_ICON = (s: string): LucideIcon => (TASK[s] ?? [Circle])[0];
export function TaskStatus({ s, bare }: { s: string; bare?: boolean }) {
  const [I, t, pill] = TASK[s] ?? [Circle, s, 'bg-fill-strong text-fg-secondary', ''];
  return <span className={bare ? 'inline-flex items-center gap-1' : `pill ${pill}`}><Icon as={I} size={14} />{t}</span>;
}

const PRES: Record<string, [LucideIcon, string, string]> = {
  idle: [Circle, 'Idle', 'text-fg-tertiary'], queued: [Clock, 'Queued', 'text-fg-secondary'], working: [CircleDot, 'Working', 'text-status-progress'],
  reviewing: [Eye, 'Reviewing', 'text-status-review'], blocked: [CirclePause, 'Waiting on you', 'text-status-blocked'],
  failed: [CircleX, 'Failed', 'text-status-blocked'], paused: [CircleSlash, 'Paused', 'text-status-warn'], disabled: [CircleMinus, 'Disabled', 'text-fg-tertiary'],
};
/** Label variants for PHASE2 §B1; the `presence` enum is unchanged, the detail picks the text. */
export function presenceLabel(a: any, now: number, pauseLabel?: string): string {
  let label = (PRES[a.presence] ?? [Circle, a.presence, ''])[1];
  if (a.presence === 'working' && a.running_since) {
    const s = Math.max(0, Math.floor((now - a.running_since) / 1000));
    label = `Working · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  if (a.presence === 'working' && a.helping_asker && a.running_task) label = `Helping ${a.helping_asker} · T-${a.running_task}`;      // peer help job (PHASE2 §B1)
  if (a.presence === 'reviewing' && a.running_task) label = `Reviewing T-${a.running_task}`;
  if (a.presence === 'queued') label = `Queued (${a.queued})`;
  if (a.presence === 'failed' && a.retrying) label = `Failed · Retry ${a.retrying}`;
  if (a.presence === 'paused') label = a.presence_detail === 'agent budget' ? 'Paused: agent budget' : pauseLabel ? `Paused: ${pauseLabel}` : label;
  return label;
}
export const presenceIcon = (presence: string): LucideIcon => (PRES[presence] ?? [Circle])[0];
export const presenceTone = (presence: string): string => (PRES[presence] ?? [0, 0, ''])[2] as string;
export function Presence({ a, now, pauseLabel, size = 14 }: { a: any; now: number; pauseLabel?: string; size?: 14 | 16 }) {
  const [I, , c] = PRES[a.presence] ?? [Circle, a.presence, ''];
  const label = presenceLabel(a, now, pauseLabel);
  return <span className={`inline-flex items-center gap-1 ${c}`}><Icon as={I} size={size} className={a.presence === 'working' ? 'animate-pulse' : ''} />{label}</span>;
}

/** Mutating button: pending label, disabled while in flight, inline role=alert error (UX §8). */
export function ActionButton(p: {
  label: string; pending?: string; run: () => Promise<unknown>; kind?: 'default' | 'primary' | 'danger' | 'danger-ghost';
  disabled?: boolean; title?: string; onError?: (e: ApiError) => boolean | void; shortcut?: string; autoFocus?: boolean; small?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const [minW, setMinW] = useState<number | undefined>();
  const cls = p.kind === 'primary' ? 'btn-primary' : p.kind === 'danger' ? 'btn-destructive'
    : p.kind === 'danger-ghost' ? 'btn-ghost text-danger hover:bg-tint-danger hover:text-danger' : 'btn-secondary';
  const click = async () => {
    if (ref.current) setMinW(ref.current.offsetWidth);
    setBusy(true); setErr(null);
    try { await p.run(); }
    catch (e: any) { if (!p.onError?.(e)) setErr(`Couldn't ${p.label.toLowerCase()}: ${e.hint || e.code}`); }
    finally { setBusy(false); }
  };
  return (
    <span className="inline-flex flex-col">
      <button ref={ref} type="button" title={p.title} data-shortcut={p.shortcut} data-autofocus={p.autoFocus ? true : undefined} disabled={busy || p.disabled}
        aria-busy={busy || undefined} aria-keyshortcuts={p.shortcut} style={busy && minW ? { minWidth: minW } : undefined}
        className={`btn ${p.small ? 'btn-sm' : ''} ${cls}`} onClick={click}>
        {busy && <Icon as={LoaderCircle} size={14} className="animate-spin" />}
        {busy ? (p.pending ?? `${p.label}…`) : p.label}
        {p.shortcut && !busy ? <kbd aria-hidden className="kbd">{p.shortcut}</kbd> : null}
      </button>
      {err && <span role="alert" className="field-error max-w-xs"><Icon as={CircleX} size={14} />{err}</span>}
    </span>
  );
}

export function Dialog({ title, children, onClose, wide, hideTitle }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; hideTitle?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], textarea, input, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); } };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus(); };
  }, []);
  return (
    <div className={`fixed inset-0 z-50 ${wide ? 'bg-black/10 dark:bg-black/40' : 'bg-black/25 dark:bg-black/50'} flex justify-center items-end md:items-start md:px-4 md:pt-[18vh] anim-in`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dlg-title"
        className={`anim-dialog w-full ${wide ? 'md:max-w-[560px] md:pt-0 p-0 overflow-hidden bg-elevated/[.94] backdrop-blur-[30px] saturate-[180%]' : 'md:max-w-[440px] bg-elevated p-5'} shadow-lg rounded-t-2xl md:rounded-xl max-md:pb-[calc(20px+env(safe-area-inset-bottom))] max-h-[85vh] overflow-y-auto`}>
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-separator-strong md:hidden" aria-hidden />
        <h2 id="dlg-title" className={hideTitle ? 'sr-only' : 'text-headline mb-2'}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Dialog footer: Cancel (secondary) then confirm; full-width buttons on the mobile sheet. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2 max-md:[&_.btn]:flex-1 max-md:[&_.btn]:h-8 max-md:[&>span]:flex-1">{children}</div>;
}

export function NoteDialog(p: { title: string; label: string; required?: boolean; confirm: string;
  onDone: (note: string) => Promise<unknown>; onClose: () => void }) {
  const [note, setNote] = useState('');
  const required = p.required ?? true;
  return (
    <Dialog title={p.title} onClose={p.onClose}>
      <label className="field-label block mb-1.5" htmlFor="note">{p.label}</label>
      <textarea id="note" data-autofocus className="textarea h-28" value={note} onChange={(e) => setNote(e.target.value)} />
      <DialogFooter>
        <button type="button" className="btn btn-secondary" onClick={p.onClose}>Cancel</button>
        <ActionButton label={p.confirm} kind="primary" disabled={required && !note.trim()}
          run={async () => { await p.onDone(note.trim()); p.onClose(); }} />
      </DialogFooter>
    </Dialog>
  );
}

export const SIDEBAR_ITEM = 'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-body text-fg-primary hover:bg-fill transition-colors duration-fast ease-out aria-[current=page]:bg-selected aria-[current=page]:shadow-xs aria-[current=page]:font-medium';
export const SECTION_LABEL = 'px-2 pt-4 pb-1 text-caption font-semibold text-fg-tertiary';

export function Avatar({ name, you }: { name: string; you?: boolean }) {
  return <span aria-hidden className={`h-7 w-7 shrink-0 rounded-full grid place-items-center text-callout font-semibold mt-0.5 ${you ? 'bg-accent-fill text-fg-on-accent' : 'bg-fill-strong text-fg-secondary'}`}>{(name || '?').trim().charAt(0).toUpperCase()}</span>;
}

/** Role chip (DESIGN §4.5): `you` is accent, everything else neutral. */
export function RoleChip({ children, you }: { children: ReactNode; you?: boolean }) {
  return <span className={`pill font-normal ${you ? 'bg-accent/[.12] text-accent' : 'bg-fill-strong text-fg-secondary'}`}>{children}</span>;
}

/** Message body: fenced ``` blocks and inline `code` get code styling; everything else stays plain text (React-escaped). */
export function Rich({ text }: { text: string }) {
  const parts = String(text ?? '').split(/(```[\s\S]*?```)/g);
  return <>{parts.map((p0, i) => {
    const isCode = (x?: string) => !!x && x.startsWith('```') && x.endsWith('```') && x.length >= 6;
    let p = p0;
    if (isCode(parts[i + 1])) p = p.replace(/\n+$/, '');
    if (isCode(parts[i - 1])) p = p.replace(/^\n+/, '');
    if (p.startsWith('```') && p.endsWith('```') && p.length >= 6) {
      const inner = p.slice(3, -3).replace(/^[a-zA-Z0-9_+-]*\n/, '').replace(/\n$/, '');
      return <pre key={i} className="my-1.5 overflow-x-auto rounded-md bg-sunken p-3 font-mono text-mono text-fg-primary whitespace-pre">{inner}</pre>;
    }
    return <span key={i}>{p.split(/(`[^`\n]+`)/g).map((q, j) => q.length > 2 && q.startsWith('`') && q.endsWith('`')
      ? <code key={j} className="rounded-sm bg-fill-strong px-1 font-mono text-[12px]">{q.slice(1, -1)}</code> : q)}</span>;
  })}</>;
}

/** Wraps a `.select` with the chevron affordance (DESIGN §4.3). */
export function SelectWrap({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`relative inline-block ${className}`}>{children}<Icon as={ChevronDown} size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none" /></span>;
}

/** Modifier glyph for shortcut hints: ⌘ on Apple platforms, Ctrl elsewhere (DESIGN §4.13). Resolved after mount to keep hydration stable. */
export function useMod(): string {
  const [m, setM] = useState('⌘');
  useEffect(() => { if (!/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) setM('Ctrl'); }, []);
  return m;
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
