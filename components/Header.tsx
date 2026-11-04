'use client';
import { useEffect, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { CircleCheck, CircleSlash, CircleX, OctagonX, Play, RefreshCw, Search, Settings as SettingsIcon, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { ActionButton, Dialog, DialogFooter, Icon, hhmm, useMod, usd } from './ui';

export const PAUSE_LABEL: Record<string, string> = {
  kill: 'kill', paused_user: 'you', usage_limit: 'limit', budget: 'budget', job_cap: 'budget', orchestrator_down: 'orchestrator down',
};
export const BLOCK_TEXT: Record<string, string> = {
  kill: 'kill switch', paused_user: 'paused by you', usage_limit: 'usage limit', budget: 'budget reached',
  job_cap: 'job cap reached', orchestrator_down: 'orchestrator not running',
};
const RESTART = 'npm start   # or: npm run orchestrator';

function copy(text: string, toast: (t: string) => void) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast(text));
}

export function KillDialog({ onClose }: { onClose: () => void }) {
  const { toast, refresh, set } = useStore();
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog title="Stop all agents now?" onClose={onClose}>
      <p className="text-body text-fg-secondary">Running processes will be killed. Unsaved agent work may be lost.</p>
      {err && <p role="alert" className="field-error mt-3 flex-wrap"><Icon as={CircleX} size={14} />Couldn&apos;t stop agents: {err}.
        <button className="btn btn-link text-callout" onClick={() => copy('pkill -f "claude -p"', toast)}>Copy kill command</button></p>}
      {result && <p className="text-body mt-3" aria-live="polite">{result}</p>}
      <DialogFooter>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <ActionButton label="Stop all" pending="Stopping…" kind="danger" autoFocus onError={(e) => { setErr(e.hint || e.code); set({ killFailed: true }); return true; }}
          run={async () => {
            const r = await api('/api/kill', { body: {} });
            set({ killFailed: false });
            await refresh();
            if (r.path === 'direct') {
              const n = (r.survivors ?? []).length;
              toast(n ? `${n} processes may still be running (pid ${r.survivors.join(', ')})` : 'Stopped. Orchestrator was not running; runs will be marked when it restarts.');
            } else toast('Stopping agents…');
            onClose();
          }} />
      </DialogFooter>
    </Dialog>
  );
}

export function ResumeDialog({ onClose }: { onClose: () => void }) {
  const { refresh, toast } = useStore();
  return (
    <Dialog title="Resume agents?" onClose={onClose}>
      <p className="text-body text-fg-secondary">Agents start claiming queued runs again. Budgets and caps are unchanged. Tasks stopped by the kill switch stay Blocked until you retry them.</p>
      <DialogFooter>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <ActionButton label="Resume" pending="Resuming…" kind="primary"
          run={async () => { await api('/api/resume', { body: {} }); await refresh(); toast('Agents resumed'); onClose(); }} />
      </DialogFooter>
    </Dialog>
  );
}

function Banner({ tone, icon, children, actions }: { tone: 'red' | 'amber' | 'info'; icon: LucideIcon; children: React.ReactNode; actions?: React.ReactNode }) {
  const c = tone === 'red' ? 'banner-danger' : tone === 'amber' ? 'banner-warn' : 'banner-info';
  const ic = tone === 'red' ? 'text-danger' : tone === 'amber' ? 'text-status-warn' : 'text-accent';
  return <div role="alert" className={`banner ${c}`}><Icon as={icon} className={`mt-px ${ic}`} /><div className="flex-1 min-w-0">{children}</div>
    {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}</div>;
}
const HIGH = (used: number, limit: number) => limit > 0 && used / limit >= 0.8;
function StatPill({ warn, icon, className = '', children }: { warn?: boolean; icon?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <span className={`pill shrink-0 ${warn ? 'bg-tint-warn text-fg-primary' : 'bg-fill text-fg-secondary'} ${className}`}>{warn && <Icon as={TriangleAlert} size={14} className="text-status-warn" />}{icon}{children}</span>;
}

export function Header({ onSearch }: { onSearch?: () => void }) {
  const { boot, sse, sessionExpired, setView, set, toast, refresh, killFailed } = useStore();
  const mod = useMod();
  const [kill, setKill] = useState(false);
  const [resume, setResume] = useState(false);
  const [dismissKey, setDismissKey] = useState(false);
  const [dismissBudget, setDismissBudget] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setKill(true); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  if (!boot) return null;
  const s = boot.system, u = boot.usage;
  const orch = s.orchestrator as 'up' | 'stale' | 'down';
  const orchIcon = orch === 'up' ? <Icon as={CircleCheck} size={14} className="text-status-done" /> : orch === 'stale' ? <Icon as={TriangleAlert} size={14} className="text-status-warn" /> : <Icon as={CircleX} size={14} className="text-status-blocked" />;
  const lk = s.kill_followup;
  const killStatus = s.kill_switch
    ? (s.kill_pending_runs > 0 ? `${s.kill_pending_runs} run${s.kill_pending_runs > 1 ? 's' : ''} not yet marked stopped`
      : !lk ? (orch === 'down' || !(s.running_jobs > 0) ? 'Stopping…' : `Stopping ${s.running_jobs} process${s.running_jobs > 1 ? 'es' : ''}…`)
      : lk.survivors?.length ? `${lk.survivors.length} processes may still be running (pid ${lk.survivors.join(', ')})` : 'Stopped')
    : null;
  const doctorFailed = s.doctor_report && !s.doctor_report.ok;
  const pills = <>
    <StatPill warn={HIGH(u.jobs_day, u.limit_jobs_day)}>Today: {u.jobs_day}/{u.limit_jobs_day} jobs</StatPill>
    <StatPill warn={HIGH(u.jobs_5h, u.limit_jobs_5h)}>5h: {u.jobs_5h}/{u.limit_jobs_5h}</StatPill>
    <StatPill warn={HIGH(u.spent_day, u.limit_usd_day)}>{usd(u.spent_day)}/{usd(u.limit_usd_day)} est.</StatPill>
    <StatPill icon={orchIcon}>orchestrator: {orch}</StatPill>
  </>;
  return (
    <header role="banner" className="shrink-0">
      <div className="material-bar border-b border-separator relative z-30">
        <div className="h-12 max-md:h-11 px-4 flex items-center gap-3">
          <h1 className="text-headline text-fg-primary mr-2">Slackboard</h1>
          <div className="hidden md:flex items-center gap-1.5 min-w-0 overflow-x-auto">{pills}</div>
          <span className="text-callout text-fg-tertiary truncate min-w-0" aria-live="polite">{sse === 'live' ? '' : sse === 'reconnecting' ? <><Icon as={RefreshCw} size={14} className="inline mr-1 text-status-warn" />Live updates paused, reconnecting…</> : ''}</span>
          {sse === 'offline' && <button className="btn btn-link text-status-warn" onClick={() => location.reload()}>Offline. Retry</button>}
          {killFailed && !s.kill_switch && <span role="status" className="inline-flex items-center gap-1 text-callout font-semibold text-danger"><Icon as={CircleX} size={14} />Kill failed</span>}
          <span className="flex-1" />
          <button type="button" className="btn btn-ghost btn-sm hidden lg:inline-flex" onClick={onSearch} aria-label="Search (Ctrl+K)" title={`Search (${mod}K)`}><Icon as={Search} />Search<kbd aria-hidden className="kbd">{mod}K</kbd></button>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => setView('settings')} aria-label="Settings (g s)" title="Settings"><Icon as={SettingsIcon} size={18} /></button>
          {s.kill_switch
            ? <button type="button" className="btn btn-primary btn-sm" disabled={s.kill_pending_runs > 0}
                title={s.kill_pending_runs > 0 ? 'Restart the orchestrator first' : undefined} onClick={() => setResume(true)}><Icon as={Play} size={14} />Resume</button>
            : <button type="button" className="btn btn-destructive btn-sm" onClick={() => setKill(true)} aria-keyshortcuts="Control+Shift+K" title="Stop all agents (Ctrl+Shift+K)"><Icon as={OctagonX} size={14} />Kill</button>}
        </div>
        <div className="md:hidden flex items-center gap-1.5 overflow-x-auto px-4 pb-2">{pills}</div>
      </div>
      {sessionExpired && <Banner tone="amber" icon={TriangleAlert} actions={<button className="btn btn-link" onClick={() => location.reload()}>Reload page</button>}>Session expired.</Banner>}
      {s.kill_switch && <Banner tone="red" icon={OctagonX} actions={lk?.survivors?.length ? <button className="btn btn-link" onClick={() => copy(`kill -9 ${lk.survivors.join(' ')}`, toast)}>Copy kill command</button> : undefined}>
        All agents stopped at {hhmm(s.kill_engaged_at)}. {killStatus}. No new runs until you resume.
        {s.kill_pending_runs > 0 && <span className="block text-callout text-fg-secondary">Restart the orchestrator first ({s.kill_pending_runs} run{s.kill_pending_runs > 1 ? 's' : ''} not yet marked stopped)</span>}</Banner>}
      {orch === 'down' && <Banner tone="red" icon={CircleX} actions={<button className="btn btn-link" onClick={() => copy(RESTART, toast)}>Copy restart command</button>}>
        Agents are not running (no heartbeat for 15 s). Your messages are saved and will be handled when it restarts.</Banner>}
      {doctorFailed && <Banner tone="red" icon={CircleX} actions={<ActionButton small label="Re-run checks" pending="Running…" run={async () => { await api('/api/doctor', { body: {} }); toast('Checks started'); }} />}>
        Agents are disabled: {s.doctor_report.checks.filter((c: any) => !c.ok && c.level === 'fail').map((c: any) => `${c.id}: ${c.detail}`).join('; ')}</Banner>}
      {s.pause_reason === 'usage_limit' && s.paused_until > boot.now && <Banner tone="amber" icon={CircleSlash} actions={<>
        <ActionButton small label="Resume now" run={async () => { await api('/api/pause', { body: { action: 'resume' } }); await refresh(); }} />
        <ActionButton small label="Keep paused" run={async () => { await api('/api/pause', { body: { action: 'hold' } }); await refresh(); }} /></>}>
        Claude reported a usage limit. Agents paused until {hhmm(s.paused_until)} (30 min). <span className="text-fg-secondary">This also affects your own Claude use.</span></Banner>}
      {s.pause_reason === 'user' && <Banner tone="amber" icon={CircleSlash} actions={<ActionButton small label="Resume now" run={async () => { await api('/api/pause', { body: { action: 'resume' } }); await refresh(); }} />}>
        Agents paused until you resume. <span className="text-fg-secondary">Queued work waits.</span></Banner>}
      {!dismissBudget && (s.blocked_by === 'budget' || s.blocked_by === 'job_cap') && <Banner tone="amber" icon={CircleSlash} actions={<>
        <button className="btn btn-link" onClick={() => { set({ settingsFocus: s.blocked_by === 'budget' ? 'day_usd' : u.jobs_day >= u.limit_jobs_day ? 'day_jobs' : 'jobs_5h' }); setView('settings'); }}>
          {s.blocked_by === 'budget' ? 'Raise budget' : 'Raise cap'}</button>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissBudget(true)}><Icon as={X} size={14} /></button></>}>
        {s.blocked_by === 'budget' ? `Daily budget reached (${usd(u.limit_usd_day)} est.). New agent runs are paused until 00:00 or you raise the budget. Running jobs finish.`
          : `Job cap reached (${u.jobs_day >= u.limit_jobs_day ? u.limit_jobs_day + ' per day' : u.limit_jobs_5h + ' per 5 h'}).${u.next_run_at ? ` Next run allowed at ${hhmm(u.next_run_at)}.` : ''}`}</Banner>}
      {s.api_key_detected && !dismissKey && <Banner tone="amber" icon={TriangleAlert} actions={<button className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissKey(true)}><Icon as={X} size={14} /></button>}>
        ANTHROPIC_API_KEY is set in your environment. Agents run without it, on your subscription.</Banner>}
      {kill && <KillDialog onClose={() => setKill(false)} />}
      {resume && <ResumeDialog onClose={() => setResume(false)} />}
    </header>
  );
}
