'use client';
import { Hash, Inbox, Settings as SettingsIcon } from 'lucide-react';
import { useStore } from './store';
import { AgentsList } from './AgentsList';
import { Icon, STATUS_ICON, STATUS_ICON_CLS, SECTION_LABEL, SIDEBAR_ITEM } from './ui';

export function Sidebar({ now }: { now: number }) {
  const { boot, view, setView } = useStore();
  if (!boot) return null;
  const count = boot.needsYou.length;
  const counts = (st: string) => boot.tasks.filter((t: any) => t.status === st).length;
  return (
    <nav aria-label="Workspace" className="w-60 shrink-0 border-r border-separator bg-sidebar overflow-y-auto overscroll-contain px-2 py-3 hidden md:block">
      <button className={SIDEBAR_ITEM} onClick={() => setView('inbox')} aria-current={view === 'inbox' ? 'page' : undefined}>
        <Icon as={Inbox} className="text-fg-secondary" /> Needs you
        {count > 0
          ? <span className="ml-auto min-w-5 h-5 px-1.5 rounded-full bg-accent-fill text-fg-on-accent text-caption font-semibold tabular-nums grid place-items-center" aria-label={`${count} items`}>{count}</span>
          : <span className="ml-auto text-caption text-fg-tertiary tabular-nums" aria-label={`${count} items`}>{count}</span>}
      </button>
      <h2 className={SECTION_LABEL}>Channels</h2>
      <button className={SIDEBAR_ITEM} onClick={() => setView('chat')} aria-current={view === 'chat' ? 'page' : undefined}><Icon as={Hash} className="text-fg-tertiary" /> general</button>
      <AgentsList now={now} />
      <h2 className={SECTION_LABEL}>Board summary</h2>
      <ul>
        {[['proposed', 'Proposed'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['blocked', 'Blocked']].map(([k, l]) => (
          <li key={k}><button className={SIDEBAR_ITEM} onClick={() => setView('board')}>
            <Icon as={STATUS_ICON(k)} size={14} className={STATUS_ICON_CLS(k)} />{l}{' '}
            <span className="ml-auto text-callout text-fg-tertiary tabular-nums">{counts(k)}</span></button></li>
        ))}
      </ul>
      <button className={`${SIDEBAR_ITEM} mt-4`} onClick={() => setView('settings')} aria-current={view === 'settings' ? 'page' : undefined}><Icon as={SettingsIcon} className="text-fg-secondary" /> Settings</button>
    </nav>
  );
}
