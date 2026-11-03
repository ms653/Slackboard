'use client';
import { useEffect, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { ActionButton, Dialog, hhmm, usd } from './ui';

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
      <p className="text-sm text-slate-300 mb-4">Running processes will be killed. Unsaved agent work may be lost.</p>
      {err && <p role="alert" className="text-sm text-rose-300 mb-3">Couldn&apos;t stop agents: {err}.
        <button className="underline ml-1" onClick={() => copy('pkill -f "claude -p"', toast)}>Copy kill command</button></p>}
      {result && <p className="text-sm mb-3" aria-live="polite">{result}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn bg-slate-700" onClick={onClose}>Cancel</button>
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
      </div>
    </Dialog>
  );
}

export function ResumeDialog({ onClose }: { onClose: () => void }) {
  const { refresh, toast } = useStore();
  return (
    <Dialog title="Resume agents?" onClose={onClose}>
      <p className="text-sm text-slate-300 mb-4">Agents start claiming queued runs again. Budgets and caps are unchanged. Tasks stopped by the kill switch stay Blocked until you retry them.</p>
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn bg-slate-700" onClick={onClose}>Cancel</button>
        <ActionButton label="Resume" pending="Resuming…" kind="primary"
          run={async () => { await api('/api/resume', { body: {} }); await refresh(); toast('Agents resumed'); onClose(); }} />
      </div>
    </Dialog>
  );
}

function Banner({ tone, icon, children }: { tone: 'red' | 'amber'; icon: string; children: React.ReactNode }) {
  const c = tone === 'red' ? 'bg-rose-950 border-rose-700 text-rose-100' : 'bg-amber-950 border-amber-700 text-amber-100';
  return <div role="alert" className={`flex flex-wrap items-center gap-3 px-4 py-2 border-b text-sm ${c}`}><span aria-hidden>{icon}</span>{children}</div>;
}

export function Header() {
  const { boot, sse, sessionExpired, setView, set, toast, refresh, killFailed } = useStore();
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
  const orchIcon = orch === 'up' ? '●' : orch === 'stale' ? '◔' : '✕';
  const lk = s.kill_followup;
  const killStatus = s.kill_switch
    ? (s.kill_pending_runs > 0 ? `${s.kill_pending_runs} run${s.kill_pending_runs > 1 ? 's' : ''} not yet marked stopped`
      : !lk ? (orch === 'down' || !(s.running_jobs > 0) ? 'Stopping…' : `Stopping ${s.running_jobs} process${s.running_jobs > 1 ? 'es' : ''}…`)
      : lk.survivors?.length ? `${lk.survivors.length} processes may still be running (pid ${lk.survivors.join(', ')})` : 'Stopped')
    : null;
  const doctorFailed = s.doctor_report && !s.doctor_report.ok;
  return (
    <header role="banner">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 bg-slate-900 border-b border-slate-700 text-sm">
        <h1 className="font-semibold text-base">Slackboard</h1>
        <span>Today: {u.jobs_day}/{u.limit_jobs_day} jobs</span>
        <span>5h: {u.jobs_5h}/{u.limit_jobs_5h}</span>
        <span>{usd(u.spent_day)}/{usd(u.limit_usd_day)} est.</span>
        <span className={orch === 'up' ? 'text-emerald-300' : orch === 'stale' ? 'text-amber-300' : 'text-rose-300'}>
          <span aria-hidden>{orchIcon}</span> orchestrator: {orch}</span>
        <span className="text-slate-400" aria-live="polite">{sse === 'live' ? '' : sse === 'reconnecting' ? '⟲ Live updates paused, reconnecting…' : ''}</span>
        {sse === 'offline' && <button className="text-amber-300 underline" onClick={() => location.reload()}>Offline. Retry</button>}
        {killFailed && !s.kill_switch && <span role="status" className="text-rose-300 font-semibold"><span aria-hidden>✕</span> Kill failed</span>}
        <span className="flex-1" />
        <button type="button" className="btn bg-slate-700" onClick={() => setView('settings')} aria-label="Settings (g s)"><span aria-hidden>⚙</span> Settings</button>
        {s.kill_switch
          ? <button type="button" className="btn bg-emerald-800 hover:bg-emerald-700" disabled={s.kill_pending_runs > 0}
              title={s.kill_pending_runs > 0 ? 'Restart the orchestrator first' : undefined} onClick={() => setResume(true)}>
              {s.kill_pending_runs > 0 ? `Restart the orchestrator first (${s.kill_pending_runs} run${s.kill_pending_runs > 1 ? 's' : ''} not yet marked stopped)` : 'Resume'}</button>
          : <button type="button" className="btn bg-rose-700 hover:bg-rose-600 font-semibold" onClick={() => setKill(true)} aria-keyshortcuts="Control+Shift+K"><span aria-hidden>■</span> KILL</button>}
      </div>
      {sessionExpired && <Banner tone="amber" icon="⚠">Session expired. <button className="underline" onClick={() => location.reload()}>Reload page</button></Banner>}
      {s.kill_switch && <Banner tone="red" icon="■">All agents stopped at {hhmm(s.kill_engaged_at)}. {killStatus}. No new runs until you resume.
        {lk?.survivors?.length ? <button className="underline" onClick={() => copy(`kill -9 ${lk.survivors.join(' ')}`, toast)}>Copy kill command</button> : null}</Banner>}
      {orch === 'down' && <Banner tone="red" icon="✕">Agents are not running (no heartbeat for 15 s). Your messages are saved and will be handled when it restarts.
        <button className="underline" onClick={() => copy(RESTART, toast)}>Copy restart command</button></Banner>}
      {doctorFailed && <Banner tone="red" icon="✕">Agents are disabled: {s.doctor_report.checks.filter((c: any) => !c.ok && c.level === 'fail').map((c: any) => `${c.id}: ${c.detail}`).join('; ')}
        <ActionButton label="Re-run checks" pending="Running…" run={async () => { await api('/api/doctor', { body: {} }); toast('Checks started'); }} /></Banner>}
      {s.pause_reason === 'usage_limit' && s.paused_until > boot.now && <Banner tone="amber" icon="⊘">Claude reported a usage limit. Agents paused until {hhmm(s.paused_until)} (30 min). This also affects your own Claude use.
        <ActionButton label="Resume now" run={async () => { await api('/api/pause', { body: { action: 'resume' } }); await refresh(); }} />
        <ActionButton label="Keep paused" run={async () => { await api('/api/pause', { body: { action: 'hold' } }); await refresh(); }} /></Banner>}
      {s.pause_reason === 'user' && <Banner tone="amber" icon="⊘">Agents paused until you resume. Queued work waits.
        <ActionButton label="Resume now" run={async () => { await api('/api/pause', { body: { action: 'resume' } }); await refresh(); }} /></Banner>}
      {!dismissBudget && (s.blocked_by === 'budget' || s.blocked_by === 'job_cap') && <Banner tone="amber" icon="⊘">
        {s.blocked_by === 'budget' ? `Daily budget reached (${usd(u.limit_usd_day)} est.). New agent runs are paused until 00:00 or you raise the budget. Running jobs finish.`
          : `Job cap reached (${u.jobs_day >= u.limit_jobs_day ? u.limit_jobs_day + ' per day' : u.limit_jobs_5h + ' per 5 h'}).${u.next_run_at ? ` Next run allowed at ${hhmm(u.next_run_at)}.` : ''}`}
        <button className="underline" onClick={() => { set({ settingsFocus: s.blocked_by === 'budget' ? 'day_usd' : u.jobs_day >= u.limit_jobs_day ? 'day_jobs' : 'jobs_5h' }); setView('settings'); }}>
          {s.blocked_by === 'budget' ? 'Raise budget' : 'Raise cap'}</button>
        <button className="underline" onClick={() => setDismissBudget(true)}>Dismiss</button></Banner>}
      {s.api_key_detected && !dismissKey && <Banner tone="amber" icon="⚠">ANTHROPIC_API_KEY is set in your environment. Agents run without it, on your subscription.
        <button className="underline" onClick={() => setDismissKey(true)}>Dismiss</button></Banner>}
      {kill && <KillDialog onClose={() => setKill(false)} />}
      {resume && <ResumeDialog onClose={() => setResume(false)} />}
    </header>
  );
}
