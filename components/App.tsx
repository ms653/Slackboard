'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore, type View } from './store';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { NeedsYou } from './NeedsYou';
import { Board, Chat, Settings } from './Views';
import { QuickSwitcher } from './QuickSwitcher';
import { RightPane } from './RightPane';
import { api } from './api';
import { CircleX, Hash, Info, X } from 'lucide-react';
import { Icon, Presence } from './ui';
import { PAUSE_LABEL } from './Header';

const VIEWS: [View, string, string][] = [['inbox', 'Needs you', 'g i'], ['chat', 'Chat', 'g c'], ['board', 'Board', 'g b']];

function useLive() {
  const { refresh, set } = useStore();
  useEffect(() => {
    let es: EventSource | null = null, timer: any = null, offlineTimer: any = null, closed = false;
    const debounced = () => { clearTimeout(timer); timer = setTimeout(() => refresh(), 120); };
    const connect = () => {
      const after = useStore.getState().boot?.lastEventId ?? 0;
      es = new EventSource(`/api/stream?after=${after}`);
      es.onopen = () => { clearTimeout(offlineTimer); set({ sse: 'live' }); };
      es.onmessage = debounced;
      es.onerror = () => {
        set({ sse: 'reconnecting' });
        clearTimeout(offlineTimer);
        offlineTimer = setTimeout(() => { if (!closed) set({ sse: 'offline' }); }, 10_000);
      };
    };
    refresh().then(connect);
    const poll = setInterval(() => refresh(), 5000);                 // heartbeat/usage freshness; SSE carries events
    const onExpired = () => set({ sessionExpired: true });
    window.addEventListener('sb:session-expired', onExpired);
    return () => { closed = true; es?.close(); clearInterval(poll); clearTimeout(timer); window.removeEventListener('sb:session-expired', onExpired); };
  }, [refresh, set]);
}

function focusItem(el: HTMLElement | undefined) { if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); } }
const navItems = (list: Element) => Array.from(list.children).filter((c): c is HTMLElement => c.matches('li[tabindex="0"]'));

/** j/k (items in the focused list) and h/l (board columns) navigation, UX §10. */
function listNav(key: string, active: HTMLElement | null): boolean {
  if (key === 'j' || key === 'k') {
    let list = active?.closest('[data-nav-list]') ?? null;
    if (!list) list = Array.from(document.querySelectorAll('#main [data-nav-list], aside[aria-label="Detail"] [data-nav-list]')).find((l) => navItems(l).length) ?? null;
    if (!list) return false;
    const items = navItems(list); if (!items.length) return false;
    const cur = active?.closest('li[tabindex="0"]') as HTMLElement | null;
    const i = cur ? items.indexOf(cur) : -1;
    focusItem(items[key === 'j' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)]);
    return true;
  }
  const cols = Array.from(document.querySelectorAll('[data-board-col]'));
  if (!cols.length) return false;
  const cur = active?.closest('[data-board-col]') ?? null;
  const step = key === 'l' ? 1 : -1;
  for (let i = cur ? cols.indexOf(cur) + step : 0; i >= 0 && i < cols.length; i += step) {
    const first = navItems(cols[i].querySelector('[data-nav-list]')!)[0];
    if (first) { focusItem(first); return true; }
  }
  return true;
}

function useKeys(setHelp: (b: boolean) => void, toggleSwitcher: () => void) {
  const { setView, close, panes, set, open, toast } = useStore();
  const g = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        if (el?.closest?.('[data-diff-composer]')) return;                       // the comment textarea cancels itself first (PHASE2 §B4)
        if (useStore.getState().diffExpanded) { set({ diffExpanded: false }); return; }
        if (panes.length) close(); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); toggleSwitcher(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'g') { g.current = Date.now(); return; }
      if (Date.now() - g.current < 1000) {
        const v = ({ i: 'inbox', c: 'chat', b: 'board', s: 'settings' } as Record<string, View>)[e.key];
        if (v) { e.preventDefault(); setView(v); g.current = 0; return; }
      }
      if (['j', 'k', 'h', 'l'].includes(e.key) && !document.querySelector('[role="dialog"]')) { if (listNav(e.key, document.activeElement as HTMLElement | null)) e.preventDefault(); return; }
      if (e.key === '/') { e.preventDefault(); (document.querySelector('[data-composer]') as HTMLElement | null)?.focus(); }
      if (e.key === '?') setHelp(true);
      if ((e.key === 'a' || e.key === 'r' || e.key === 'd') && !document.querySelector('[role="dialog"]')) {
        const focused = document.activeElement as HTMLElement | null;
        const btn = (root: ParentNode | null | undefined) => root?.querySelector<HTMLButtonElement>(`button[data-shortcut="${e.key}"]:not(:disabled)`) ?? null;
        const card = focused?.closest<HTMLElement>('[data-task-card]');
        if (e.key === 'd' && card) {
          e.preventDefault();
          const id = Number(card.dataset.taskCard);
          api(`/api/tasks/${id}`).then((r: any) => {
            const art = (r.artifacts ?? []).filter((a: any) => a.verdict !== 'superseded').slice(-1)[0];
            if (art) open({ kind: 'review', id: art.id }); else toast(`T-${id} has no diff yet`);
          }, () => toast(`Couldn't load T-${id}`, 'error'));
          return;
        }
        const target = btn(focused?.closest('li[tabindex="0"]')) ?? btn(document.querySelector('aside[aria-label="Detail"]'));
        if (target) { e.preventDefault(); target.click(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, close, panes.length, set, setHelp, open, toast, toggleSwitcher]);
}

export default function App() {
  const { boot, loadError, view, setView, panes, toasts, dismiss, refresh, diffExpanded } = useStore();
  const [now, setNow] = useState(Date.now());
  const [help, setHelp] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const chose = useRef(false);
  useLive();
  useKeys(setHelp, () => setSwitcher((v) => !v));
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!boot) return;
    if (!chose.current) { chose.current = true; setView(boot.needsYou.length > 0 ? 'inbox' : 'chat'); }
    document.title = boot.needsYou.length ? `(${boot.needsYou.length}) Slackboard` : 'Slackboard';
  }, [boot, setView]);

  if (loadError && !boot) return (
    <main className="h-screen flex flex-col items-center justify-center gap-2 text-center">
      <div className="h-12 w-12 rounded-full bg-fill-strong grid place-items-center text-danger"><Icon as={CircleX} size={24} /></div>
      <p role="alert" className="text-headline">Couldn&apos;t load Slackboard. <span className="font-mono text-callout font-normal text-fg-tertiary">({loadError})</span></p>
      <button className="btn btn-primary mt-2" onClick={() => refresh()}>Retry</button>
    </main>);
  if (!boot) return <main className="h-screen flex items-center justify-center text-callout text-fg-tertiary" aria-busy="true">Loading…</main>;
  const pane = panes[panes.length - 1];
  const expandedPane = diffExpanded && pane?.kind === 'review';
  return (
    <div className="h-[100dvh] flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-elevated focus:px-3 focus:py-1.5 focus:shadow-md">Skip to main content</a>
      <Header onSearch={() => setSwitcher(true)} />
      <div className="md:hidden material-bar sticky top-0 z-20 border-b border-separator px-4 py-1.5">
        <div className="seg w-full grid grid-cols-4 h-9" role="tablist" aria-label="Views">
          {[...VIEWS, ['settings', 'Settings', 'g s'] as [View, string, string]].map(([v, l]) =>
            <button key={v} role="tab" aria-selected={view === v} className="seg-item h-8 justify-center px-1" onClick={() => setView(v)}>
              {v === 'inbox' ? `Inbox (${boot.needsYou.length})` : l}</button>)}
        </div>
      </div>
      <ul aria-label="Agents" className="md:hidden flex flex-wrap gap-x-4 gap-y-1 px-4 py-1.5 border-b border-separator material-bar text-callout">
        {boot.agents.filter((a: any) => !a.retired_at).map((a: any) => <li key={a.id} className="flex items-center gap-1.5"><span className="font-medium">{a.display_name}</span>
          <Presence a={a} now={now} pauseLabel={PAUSE_LABEL[boot.system.blocked_by] ?? undefined} />
          {a.presence === 'working' && a.presence_detail ? <span className="text-fg-tertiary truncate max-w-[10rem]">{a.presence_detail}</span> : null}</li>)}
      </ul>
      <div className="flex-1 flex min-h-0 relative">
        <Sidebar now={now} />
        <main id="main" className={`flex-1 min-w-0 flex flex-col ${view === 'chat' ? 'bg-content' : 'bg-window'}`}>
          {view !== 'settings' && (
            <div className="hidden md:flex h-12 shrink-0 items-center gap-2 px-5 border-b border-separator material-bar">
              <Icon as={Hash} className="text-fg-tertiary" /><span className="text-headline mr-3">general</span>
              <div role="tablist" aria-label="Centre view" className="seg">
                {VIEWS.map(([v, l, k]) => <button key={v} role="tab" aria-selected={view === v} title={k}
                  className="seg-item" onClick={() => setView(v)}>
                  {l}{v === 'inbox' ? <>{' '}<span className="ml-1 tabular-nums text-fg-tertiary">({boot.needsYou.length})</span></> : ''}</button>)}
              </div>
            </div>)}
          <div className="flex-1 min-h-0">
            {view === 'inbox' && <NeedsYou />}
            {view === 'chat' && <Chat />}
            {view === 'board' && <Board now={now} />}
            {view === 'settings' && <Settings />}
          </div>
        </main>
        {pane && (
          <aside aria-label="Detail" className={`border-l border-separator flex flex-col ${expandedPane ? 'absolute inset-y-0 right-0 left-0 xl:left-60 z-40 w-auto bg-content shadow-lg' : 'pane-aside w-[420px] max-w-[calc(100vw-240px)] max-md:max-w-full shrink-0 xl:static absolute inset-y-0 right-0 z-30 xl:z-auto'}`}>
            <RightPane pane={pane} />
          </aside>)}
      </div>
      <div aria-live="polite" className="fixed z-50 bottom-[calc(16px+env(safe-area-inset-bottom))] max-md:left-1/2 max-md:-translate-x-1/2 md:right-4 flex flex-col items-end gap-2 w-[min(360px,calc(100vw-32px))]">
        {toasts.slice(-3).map((t) => <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
          className="anim-in material rounded-xl shadow-md px-3.5 py-2.5 flex items-center gap-2.5 text-body text-fg-primary w-full">
          <Icon as={t.tone === 'error' ? CircleX : Info} className={t.tone === 'error' ? 'text-danger' : 'text-accent'} />
          <span className="flex-1 min-w-0">{t.text}</span>
          {t.actions?.map((a) => <button key={a.label} className="btn btn-link font-semibold" onClick={async () => { try { await a.run(); } finally { dismiss(t.id); } }}>{a.label}</button>)}
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(t.id)}><Icon as={X} size={14} /></button></div>)}
      </div>
      {switcher && <QuickSwitcher onClose={() => setSwitcher(false)} />}
      {help && (
        <div role="dialog" aria-modal="true" aria-labelledby="help-h" className="fixed inset-0 bg-black/25 dark:bg-black/50 z-50 flex items-start justify-center md:pt-[10vh] max-md:items-end anim-in" onClick={() => setHelp(false)}
          onKeyDown={(e) => e.key === 'Escape' && setHelp(false)}>
          <div className="anim-dialog bg-elevated shadow-lg rounded-xl max-md:rounded-b-none p-5 text-body w-[min(640px,100%)] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 id="help-h" className="text-headline mb-3">Keyboard shortcuts</h2>
            <table className="w-full"><tbody className="divide-y divide-separator">{[['g i / g c / g b / g s', 'Needs you / Chat / Board / Settings'], ['Ctrl/⌘+K', 'Quick switcher (channels, tasks, agents, New task)'], ['j / k', 'Next / previous item in the focused list'], ['h / l', 'Previous / next board column'], ['Drag', 'Board: drop a card on a column (legal moves only)'], ['/', 'Focus composer'], ['Enter', 'Open focused card'],
              ['m', 'Move focused card (legal targets only)'], ['a / r', 'Approve or Accept / Reject or Reopen (focused inbox item or open review pane)'], ['d', 'View diff (focused board card or open task pane)'], ['Diff: n / p', 'Next / previous hunk (Home / End: first / last; ] / [: next / previous file)'], ['Diff: ↑ ↓ ← →', 'Line up/down; old/new cell in side by side'], ['Diff: c', 'Comment on the focused line'], ['Diff: v / x', 'Unified or side by side / Expand or collapse the diff'], ['Diff: Esc', 'Cancel comment, then collapse, then close'], ['Esc', 'Close pane or dialog'], ['Ctrl+Shift+K', 'Kill switch'], ['?', 'This help']].map(([k, d]) =>
              <tr key={k}><td className="py-1.5 pr-4 align-top whitespace-nowrap font-mono text-callout text-fg-secondary">{k}</td><td className="py-1.5 text-fg-primary">{d}</td></tr>)}</tbody></table>
            <button autoFocus className="btn btn-secondary mt-4" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>)}
    </div>
  );
}
