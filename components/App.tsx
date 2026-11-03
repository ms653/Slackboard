'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore, type View } from './store';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { NeedsYou } from './NeedsYou';
import { Board, Chat, Settings } from './Views';
import { RightPane } from './RightPane';
import { api } from './api';
import { Presence } from './ui';
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

function useKeys(setHelp: (b: boolean) => void) {
  const { setView, close, panes, set, open, toast } = useStore();
  const g = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) { if (panes.length) close(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'g') { g.current = Date.now(); return; }
      if (Date.now() - g.current < 1000) {
        const v = ({ i: 'inbox', c: 'chat', b: 'board', s: 'settings' } as Record<string, View>)[e.key];
        if (v) { e.preventDefault(); setView(v); g.current = 0; return; }
      }
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
  }, [setView, close, panes.length, set, setHelp, open, toast]);
}

export default function App() {
  const { boot, loadError, view, setView, panes, toasts, dismiss, refresh } = useStore();
  const [now, setNow] = useState(Date.now());
  const [help, setHelp] = useState(false);
  const chose = useRef(false);
  useLive();
  useKeys(setHelp);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!boot) return;
    if (!chose.current) { chose.current = true; setView(boot.needsYou.length > 0 ? 'inbox' : 'chat'); }
    document.title = boot.needsYou.length ? `(${boot.needsYou.length}) Slackboard` : 'Slackboard';
  }, [boot, setView]);

  if (loadError && !boot) return (
    <main className="h-screen flex flex-col items-center justify-center gap-3">
      <p role="alert">Couldn&apos;t load Slackboard. <span className="text-slate-400">({loadError})</span></p>
      <button className="btn bg-sky-700" onClick={() => refresh()}>Retry</button>
    </main>);
  if (!boot) return <main className="h-screen flex items-center justify-center text-slate-400" aria-busy="true">Loading…</main>;
  const pane = panes[panes.length - 1];
  return (
    <div className="h-screen flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only">Skip to main content</a>
      <Header />
      <div className="md:hidden flex border-b border-slate-700" role="tablist" aria-label="Views">
        {[...VIEWS, ['settings', 'Settings', 'g s'] as [View, string, string]].map(([v, l]) =>
          <button key={v} role="tab" aria-selected={view === v} className={`flex-1 py-2 text-sm ${view === v ? 'bg-slate-700' : ''}`} onClick={() => setView(v)}>
            {v === 'inbox' ? `Inbox (${boot.needsYou.length})` : l}</button>)}
      </div>
      <ul aria-label="Agents" className="md:hidden flex flex-wrap gap-x-4 gap-y-1 px-3 py-1.5 border-b border-slate-700 text-xs">
        {boot.agents.map((a: any) => <li key={a.id} className="flex items-center gap-1.5"><span className="font-medium">{a.display_name}</span>
          <Presence a={a} now={now} pauseLabel={PAUSE_LABEL[boot.system.blocked_by] ?? undefined} />
          {a.presence === 'working' && a.presence_detail ? <span className="text-slate-400 truncate max-w-[10rem]">{a.presence_detail}</span> : null}</li>)}
      </ul>
      <div className="flex-1 flex min-h-0 relative">
        <Sidebar now={now} />
        <main id="main" className="flex-1 min-w-0 flex flex-col">
          {view !== 'settings' && (
            <div className="hidden md:flex items-center gap-1 p-2 border-b border-slate-700">
              <span className="font-semibold mr-3"># general</span>
              <div role="tablist" aria-label="Centre view" className="flex bg-slate-800 rounded">
                {VIEWS.map(([v, l, k]) => <button key={v} role="tab" aria-selected={view === v} title={k}
                  className={`px-3 py-1 rounded text-sm ${view === v ? 'bg-slate-600' : ''}`} onClick={() => setView(v)}>
                  {l}{v === 'inbox' ? ` (${boot.needsYou.length})` : ''}</button>)}
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
          <aside aria-label="Detail" className="w-[420px] max-w-full shrink-0 border-l border-slate-700 bg-slate-900 xl:static absolute inset-y-0 right-0 z-40 xl:z-auto">
            <RightPane pane={pane} />
          </aside>)}
      </div>
      <div aria-live="polite" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 space-y-2">
        {toasts.map((t) => <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
          className={`px-4 py-2 rounded shadow text-sm flex gap-3 ${t.tone === 'error' ? 'bg-rose-800' : 'bg-slate-700'}`}>
          {t.text}<button aria-label="Dismiss" onClick={() => dismiss(t.id)}>✕</button></div>)}
      </div>
      {help && (
        <div role="dialog" aria-modal="true" aria-labelledby="help-h" className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setHelp(false)}
          onKeyDown={(e) => e.key === 'Escape' && setHelp(false)}>
          <div className="bg-slate-800 rounded-lg p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 id="help-h" className="font-semibold mb-2">Keyboard shortcuts</h2>
            <table><tbody>{[['g i / g c / g b / g s', 'Needs you / Chat / Board / Settings'], ['/', 'Focus composer'], ['Enter', 'Open focused card'],
              ['m', 'Move focused card (legal targets only)'], ['a / r', 'Approve or Accept / Reject or Reopen (focused inbox item or open review pane)'], ['d', 'View diff (focused board card or open task pane)'], ['Esc', 'Close pane or dialog'], ['Ctrl+Shift+K', 'Kill switch'], ['?', 'This help']].map(([k, d]) =>
              <tr key={k}><td className="pr-4 font-mono">{k}</td><td>{d}</td></tr>)}</tbody></table>
            <button autoFocus className="btn bg-slate-700 mt-3" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>)}
    </div>
  );
}
