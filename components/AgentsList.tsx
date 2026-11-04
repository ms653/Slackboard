'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { ChevronRight, Plus } from 'lucide-react';
import { Icon, SECTION_LABEL, presenceIcon, presenceLabel, presenceTone, hhmm, usd } from './ui';
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
    const I = presenceIcon(a.presence);
    const bad = a.presence === 'blocked' || a.presence === 'failed';
    return (
      <li key={a.id} className="flex flex-col">
        <button data-agent-row={a.id} className="focus-inset flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill transition-colors duration-fast ease-out"
          aria-label={rowName(a)} onClick={() => openAgent(a)}>
          <span className={`mt-px ${presenceTone(a.presence)}`}><Icon as={I} className={a.presence === 'working' ? 'animate-pulse' : ''} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="text-body font-medium text-fg-primary">{a.display_name}</span>
              <span className={`text-callout truncate ${bad ? 'text-danger' : 'text-fg-secondary'}`}>{presenceLabel(a, now, pauseLabel)}</span>
            </span>
            {lines.map((l) => <span key={l} className="block text-caption text-fg-tertiary truncate">{l}</span>)}
          </span>
        </button>
        {((reason === 'agent budget' && a.presence !== 'working') || (reason === 'disabled' && a.role === 'worker' && !a.retired_at)) && <div className="pl-8 pb-1 flex gap-1">
          {reason === 'agent budget' && a.presence !== 'working' &&
            <button className="btn btn-link text-callout" aria-label={`Edit budget for ${a.id}`} onClick={() => openSettingsAgent({ agent: a.id, field: 'usd' })}>Edit budget</button>}
          {reason === 'disabled' && a.role === 'worker' && !a.retired_at &&
            <button className="btn btn-link text-callout" aria-label={`Enable ${a.id}`} onClick={() => openSettingsAgent({ agent: a.id, field: 'enabled' })}>Enable</button>}
        </div>}
      </li>);
  };
  return (
    <section aria-labelledby="agents-h">
      <h2 id="agents-h" className={SECTION_LABEL}>Agents <span className="font-normal">1 director · {workers.length}/3 workers</span></h2>
      <ul aria-label={`Agents, 1 director, ${workers.length} of 3 workers`} onKeyDown={onKey} data-agents-list>{live.map(row)}</ul>
      {workers.length === 1 && (
        <div className="px-2 pt-2 text-caption text-fg-tertiary">1 worker. The director can propose more (you approve).{' '}
          <button className="btn btn-secondary btn-sm mt-2" onClick={() => { openSettingsAgent({ agent: '+add', field: 'row' }); setView('settings'); }}><Icon as={Plus} size={14} />Add worker</button></div>)}
      {retired.length > 0 && (
        <div className="mt-1">
          <button aria-expanded={showRetired} aria-controls="retired-list" className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-callout text-fg-tertiary hover:bg-fill" onClick={() => setShowRetired((v) => !v)}>
            <Icon as={ChevronRight} size={14} className={`transition-transform duration-fast ${showRetired ? 'rotate-90' : ''}`} /> Retired ({retired.length})</button>
          {showRetired && <ul id="retired-list" className="mt-0.5">{retired.map((a) => <li key={a.id} className="px-2 pl-7 py-1 text-fg-tertiary"><span className="block text-callout">{a.display_name}</span> <span className="block text-caption">retired {hhmm(a.retired_at)}</span></li>)}</ul>}
        </div>)}
      <div className="sr-only" aria-live="polite" role="status">{announce}</div>
    </section>
  );
}
