'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { Presence, presenceLabel, hhmm, usd } from './ui';
import { PAUSE_LABEL } from './Header';

/** Sub-lines under an agent row (PHASE2 §B1): always text. Returns the plain strings; actions are rendered separately. */
export function agentLines(a: any): string[] {
  const out: string[] = [];
  if (['working', 'reviewing'].includes(a.presence) && a.presence_detail) out.push(a.presence_detail);
  else if (a.presence === 'idle' && a.presence_detail?.startsWith('waiting on ')) out.push(a.presence_detail.replace(/^waiting on/, 'Waiting on'));
  else if (a.presence === 'paused' && a.presence_detail === 'agent budget' && a.budget)
    out.push(a.budget.limit_jobs != null && a.budget.started >= a.budget.limit_jobs ? `${a.budget.started}/${a.budget.limit_jobs} runs today`
      : `${usd(a.budget.spent + a.budget.reserved)}/${usd(a.budget.limit_usd)} est. today`, 'until 00:00');
  else if (['queued', 'paused'].includes(a.presence) && a.queue_reason) out.push(`Queued: ${a.queue_reason}`);
  return out;
}

export function AgentsList({ now }: { now: number }) {
  const { boot, open, setView, openSettingsAgent } = useStore();
  const [showRetired, setShowRetired] = useState(false);
  const [announce, setAnnounce] = useState('');
  const prev = useRef<Record<string, string>>({});
  const agents: any[] = boot?.agents ?? [];
  useEffect(() => {                                    // transitions into Paused / Failed are announced once (PHASE2 §B1)
    for (const a of agents) {
      const key = `${a.presence}:${a.presence === 'paused' ? a.presence_detail ?? '' : ''}`;
      if (prev.current[a.id] !== undefined && prev.current[a.id] !== key && ['paused', 'failed'].includes(a.presence))
        setAnnounce(`${a.id} ${a.presence}${a.presence_detail === 'agent budget' ? ': agent budget' : ''}`);
      prev.current[a.id] = key;
    }
  }, [agents]);
  if (!boot) return null;
  const live = agents.filter((a) => !a.retired_at), retired = agents.filter((a) => a.retired_at);
  const workers = live.filter((a) => a.role === 'worker');
  const pauseLabel = PAUSE_LABEL[boot.system.blocked_by] ?? undefined;

  const openAgent = (a: any) => {                      // running job thread, else oldest queued job thread, else the waiting task thread, else Settings
    const thread = a.running_thread ?? a.queued_thread ?? a.waiting_thread;
    if (thread) open({ kind: 'thread', id: thread }); else openSettingsAgent({ agent: a.id, field: 'row' });
  };
  const rowName = (a: any) => [a.display_name, presenceLabel(a, now, pauseLabel), agentLines(a).join(', '),
    ['working', 'reviewing'].includes(a.presence) && a.presence_detail ? `last tool ${a.presence_detail}` : ''].filter(Boolean).join(', ');
  const onKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'j' && e.key !== 'k') return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-agent-row]'));
    const cur = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) return;
    e.preventDefault(); e.stopPropagation();
    rows[Math.max(0, Math.min(rows.length - 1, cur + (e.key === 'j' ? 1 : -1)))]?.focus();
  };
  const row = (a: any) => {
    const lines = agentLines(a);
    const reason = a.queue_reason as string | null;
    return (
      <li key={a.id} className="px-1">
        <button data-agent-row={a.id} className="w-full text-left px-2 py-1 rounded hover:bg-slate-800 focus:outline focus:outline-2 focus:outline-sky-400"
          aria-label={rowName(a)} onClick={() => openAgent(a)}>
          <div className="font-medium">{a.display_name}</div>
          <div className="text-xs"><Presence a={a} now={now} pauseLabel={pauseLabel} /></div>
          {lines.map((l) => <div key={l} className="text-xs text-slate-400 truncate">{l}</div>)}
        </button>
        {reason === 'agent budget' && a.presence !== 'working' &&
          <button className="ml-2 text-xs underline text-sky-300" onClick={() => openSettingsAgent({ agent: a.id, field: 'usd' })}>Edit budget</button>}
        {reason === 'disabled' && a.role === 'worker' && !a.retired_at &&
          <button className="ml-2 text-xs underline text-sky-300" onClick={() => openSettingsAgent({ agent: a.id, field: 'enabled' })}>Enable</button>}
      </li>);
  };
  return (
    <section aria-labelledby="agents-h">
      <h2 id="agents-h" className="mt-4 mb-1 px-3 text-xs uppercase tracking-wide text-slate-400">Agents <span className="normal-case">1 director · {workers.length}/3 workers</span></h2>
      <ul aria-label={`Agents, 1 director, ${workers.length} of 3 workers`} onKeyDown={onKey} data-agents-list>{live.map(row)}</ul>
      {workers.length === 1 && (
        <p className="px-3 mt-1 text-xs text-slate-400">1 worker. The director can propose more (you approve).{' '}
          <button className="underline text-sky-300" onClick={() => { openSettingsAgent({ agent: '+add', field: 'row' }); setView('settings'); }}>Add worker</button></p>)}
      {retired.length > 0 && (
        <div className="px-3 mt-1 text-xs">
          <button aria-expanded={showRetired} aria-controls="retired-list" className="text-slate-400 hover:underline" onClick={() => setShowRetired((v) => !v)}>
            <span aria-hidden>{showRetired ? '▾' : '▸'}</span> Retired ({retired.length})</button>
          {showRetired && <ul id="retired-list" className="mt-1 space-y-0.5 text-slate-400">{retired.map((a) => <li key={a.id}>{a.display_name} <span>retired {hhmm(a.retired_at)}</span></li>)}</ul>}
        </div>)}
      <div className="sr-only" aria-live="polite" role="status">{announce}</div>
    </section>
  );
}
