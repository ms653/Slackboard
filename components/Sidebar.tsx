'use client';
import { useStore } from './store';
import { AgentsList } from './AgentsList';

export function Sidebar({ now }: { now: number }) {
  const { boot, view, setView } = useStore();
  if (!boot) return null;
  const count = boot.needsYou.length;
  const counts = (st: string) => boot.tasks.filter((t: any) => t.status === st).length;
  const item = (active: boolean) => `w-full text-left px-3 py-1.5 rounded ${active ? 'bg-slate-700' : 'hover:bg-slate-800'}`;
  return (
    <nav aria-label="Workspace" className="w-60 shrink-0 border-r border-slate-700 bg-slate-900 overflow-y-auto p-2 text-sm hidden md:block">
      <button className={item(view === 'inbox')} onClick={() => setView('inbox')} aria-current={view === 'inbox' ? 'page' : undefined}>
        <span aria-hidden>▸</span> Needs you <span className="float-right font-semibold" aria-label={`${count} items`}>({count})</span>
      </button>
      <h2 className="mt-4 mb-1 px-3 text-xs uppercase tracking-wide text-slate-400">Channels</h2>
      <button className={item(view === 'chat')} onClick={() => setView('chat')}># general</button>
      <AgentsList now={now} />
      <h2 className="mt-4 mb-1 px-3 text-xs uppercase tracking-wide text-slate-400">Board summary</h2>
      <ul className="px-3 space-y-0.5">
        {[['proposed', 'Proposed'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['blocked', 'Blocked']].map(([k, l]) => (
          <li key={k}><button className="hover:underline" onClick={() => setView('board')}>{l} {counts(k)}</button></li>
        ))}
      </ul>
      <button className={`${item(view === 'settings')} mt-4`} onClick={() => setView('settings')}><span aria-hidden>⚙</span> Settings</button>
    </nav>
  );
}
