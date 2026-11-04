'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { Dialog } from './ui';

interface Entry { id: string; group: string; label: string; hint?: string; run: () => void }

/** ⌘K / Ctrl+K quick switcher (UX §10): channels, tasks (T-id or title), agents, New task. */
export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const { boot, open, setView, set } = useStore();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const all = useMemo<Entry[]>(() => {
    if (!boot) return [];
    const e: Entry[] = [{ id: 'new', group: 'Action', label: 'New task', run: () => { setView('board'); open({ kind: 'newtask' }); } },
      { id: 'ch-general', group: 'Channel', label: '#general', run: () => setView('chat') }];
    for (const t of boot.tasks) e.push({ id: `t-${t.id}`, group: 'Task', label: `T-${t.id} ${t.title}`, hint: t.status.replace('_', ' '), run: () => open({ kind: 'task', id: t.id }) });
    for (const a of boot.agents.filter((x: any) => !x.retired_at)) e.push({ id: `a-${a.id}`, group: 'Agent', label: `@${a.id}`, hint: a.display_name, run: () => { set({ composerPrefill: `@${a.id} ` }); setView('chat'); } });
    return e;
  }, [boot, open, setView, set]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase().replace(/^#/, '');
    if (!n) return all.slice(0, 50);
    return all.filter((x) => (x.label + ' ' + (x.hint ?? '')).toLowerCase().includes(n) || (x.id === 'new' && 'new task'.includes(n))).slice(0, 50);
  }, [all, q]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  const choose = (x?: Entry) => { if (!x) return; onClose(); x.run(); };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); choose(shown[active]); }
  };
  return (
    <Dialog title="Quick switcher" onClose={onClose} wide hideTitle>
      <input data-autofocus role="combobox" aria-label="Go to channel, task, or agent" aria-expanded="true" aria-controls="qs-list" aria-autocomplete="list"
        aria-activedescendant={shown[active] ? `qs-${shown[active].id}` : undefined} className="block w-full h-11 px-4 text-body-lg bg-transparent text-fg-primary placeholder:text-fg-tertiary border-b border-separator focus:outline-none" placeholder="Type a task, #channel or @agent…"
        value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
      <ul id="qs-list" ref={listRef} role="listbox" aria-label="Results" className="max-h-72 overflow-y-auto py-1">
        {shown.length === 0 && <li role="presentation" className="text-body text-fg-secondary px-4 py-3">No matches.</li>}
        {shown.map((x, i) => (
          <li key={x.id} id={`qs-${x.id}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(x)}
            className={`flex h-9 items-center justify-between gap-3 px-4 text-body cursor-pointer ${i === active ? 'bg-accent-fill text-fg-on-accent' : ''}`}>
            <span className="truncate">{x.label}</span><span className={`text-callout shrink-0 ${i === active ? 'text-fg-on-accent/90' : 'text-fg-secondary'}`}>{x.hint ? `${x.hint} · ` : ''}{x.group}</span>
          </li>))}
      </ul>
    </Dialog>
  );
}
