'use client';
import { useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { ActionButton, Dialog, NoteDialog, ago, usd } from './ui';

const TITLES: Record<string, [string, string]> = {
  approval: ['⚑', 'APPROVAL'], help: ['?', 'HELP REQUEST'], ready: ['✓', 'READY'], review_cap: ['⚑', 'REVIEW LIMIT REACHED'],
  failure: ['✕', 'FAILURE'], killed: ['■', 'STOPPED BY KILL SWITCH'], thread_capped: ['⊘', 'THREAD CAPPED'],
};
const FILTERS: [string, string[] | null][] = [['All', null], ['Approvals', ['approval']], ['Help', ['help']], ['Ready', ['ready']],
  ['Failures', ['failure', 'review_cap', 'killed', 'thread_capped']]];

export function retryToast(r: any, id: number): string {
  const t = r?.target;
  if (!t) return `T-${id} updated`;
  if (t.kind === 'help') return `T-${id}: asking the director again`;
  if (t.status === 'in_review') return `T-${id} back to In review`;
  return t.redo ? `T-${id} back to To do (round redone)` : `T-${id} back to To do`;
}

export function NeedsYou() {
  const { boot, open, refresh, toast, set, setView } = useStore();
  const [filter, setFilter] = useState<string[] | null>(null);
  const [dlg, setDlg] = useState<React.ReactNode>(null);
  const [expanded, setExpanded] = useState(false);
  const [raise, setRaise] = useState<Record<number, boolean>>({});
  const [spawnErr, setSpawnErr] = useState<Record<number, string>>({});
  if (!boot) return null;
  const killed = boot.needsYou.filter((n: any) => n.item_type === 'killed');
  const others = boot.needsYou.filter((n: any) => n.item_type !== 'killed');
  const list = (filter ? others.filter((n: any) => filter.includes(n.item_type)) : others);
  const showKilled = killed.length > 0 && (!filter || filter.includes('killed'));
  const killOn = boot.system.kill_switch;
  const pending = boot.system.kill_pending_runs;
  const act = async (fn: () => Promise<any>, msg?: string) => { const r = await fn(); await refresh(); if (msg) toast(msg); return r; };
  /** Same confirm dialog as the task pane (UX §9). */
  const confirmCancel = (id: number) => setDlg(<Dialog title={`Cancel T-${id}?`} onClose={() => setDlg(null)}>
    <p className="text-sm mb-3">Queued runs are cancelled and a running agent is stopped.</p>
    <div className="flex gap-2 justify-end"><button type="button" className="btn bg-slate-700" onClick={() => setDlg(null)}>Keep task</button>
      <ActionButton label="Cancel task" kind="danger" run={async () => { await act(() => api(`/api/tasks/${id}`, { body: { action: 'cancel' } }), `T-${id} cancelled`); setDlg(null); }} /></div></Dialog>);
  const conflict = (e: any) => { if (e.status === 409 && e.code === 'already_handled') { toast('Already handled'); refresh(); return true; } };
  const blocked = boot.system.blocked_by;

  const card = (n: any) => {
    const [icon, label] = TITLES[n.item_type] ?? ['•', n.item_type];
    const task = n.task ?? boot.tasks.find((t: any) => t.id === n.task_id);
    let body: React.ReactNode = null, actions: React.ReactNode = null;
    if (n.item_type === 'approval') {
      const a = n.approval;
      const isTask = a.kind === 'create_top_level_task';
      const isSpawn = a.kind === 'spend' && a.payload?.action === 'spawn_worker';
      const p = a.payload;
      const activeWorkers = boot.agents.filter((x: any) => x.role === 'worker' && !x.retired_at).length;
      const maxc: number = boot.system.max_concurrency;
      const showRaise = isSpawn && activeWorkers + 1 > maxc - 1 && maxc < 4;
      const raiseOn = showRaise && (raise[a.id] ?? true);
      const capReached = isSpawn && activeWorkers >= 3;
      body = isSpawn
        ? <><div>New worker &ldquo;{p.name}&rdquo; · model {p.model}</div>
            <div>Skill: &ldquo;{p.skill_note}&rdquo;</div>
            <div className="text-slate-300">Why: {a.summary}</div>
            <div className="text-slate-300">From: {n.origin?.thread_title || `thread ${a.thread_id}`}{n.origin?.user_message ? ` · you: "${n.origin.user_message}"` : ''}</div>
            <div>Allowance: up to {usd(p.daily_usd)} est./day (≈ {Math.floor(p.daily_usd / 1.0)} work runs/day), {p.daily_jobs} runs/day</div>
            <div className="text-slate-400 text-xs">Shares your daily caps: {usd(boot.usage.limit_usd_day)} est., {boot.usage.limit_jobs_day} runs/day, {boot.usage.limit_jobs_5h} per 5 h</div>
            <div className="text-slate-400 text-xs">Workers: {activeWorkers} → {activeWorkers + 1} of 3 · Run slots: {maxc} ({Math.max(1, maxc - 1)} for workers, {maxc > 1 ? 1 : 0} kept for director)</div>
            {showRaise && <label className="flex items-center gap-2"><input type="checkbox" checked={raiseOn} onChange={(e) => setRaise({ ...raise, [a.id]: e.target.checked })} />
              Also raise max concurrent agents {maxc} → {maxc + 1} ({activeWorkers + 1} workers can run at once)</label>}
            {capReached && <div role="alert" className="text-amber-200">Worker limit reached (3/3). Retire a worker first.</div>}
            {spawnErr[a.id] && <div role="alert" className="text-rose-300">{spawnErr[a.id]}</div>}</>
        : isTask
        ? <><div>T-{a.task_id} &ldquo;{a.payload.title}&rdquo; → assign: {a.payload.assignee}</div>
            <div className="text-slate-300">Why: {a.summary}</div>
            <details className="text-slate-300"><summary className="cursor-pointer">Acceptance</summary><pre className="whitespace-pre-wrap text-xs">{a.payload.acceptance}</pre></details>
            <div className="text-slate-400 text-xs">Est. cap: $1.00, 15 turns per run</div></>
        : <><div>{a.kind.replace('_', ' ')}: {a.summary}</div><pre className="text-xs bg-slate-900 p-2 rounded whitespace-pre-wrap">{JSON.stringify(a.payload, null, 2)}</pre></>;
      const spawnApprove = () => setDlg(<Dialog title={`Add worker ${p.name}?`} onClose={() => setDlg(null)}>
        <p className="text-sm mb-2">This uses allowance. Approving adds the worker now.</p>
        <pre className="text-xs bg-slate-900 p-2 rounded whitespace-pre-wrap mb-2">{JSON.stringify(p, null, 2)}</pre>
        {raiseOn && <p className="text-sm mb-2">Max concurrent agents {maxc} → {maxc + 1}</p>}
        <div className="flex gap-2 justify-end"><button className="btn bg-slate-700" onClick={() => setDlg(null)}>Cancel</button>
          <ActionButton label="Add worker" kind="primary" pending="Adding…" onError={(e) => {
              setDlg(null);
              if (e.code === 'worker_cap') setSpawnErr((m) => ({ ...m, [a.id]: 'Worker limit reached (3/3). Retire a worker first.' }));
              else if (e.code === 'name_taken') setSpawnErr((m) => ({ ...m, [a.id]: 'Name already used. Reject and ask the director for another name.' }));
              else if (e.code === 'invalid_payload') setSpawnErr((m) => ({ ...m, [a.id]: `This request is invalid (${e.hint}). Reject it.` }));
              else return conflict(e) ?? false;
              return true; }}
            run={async () => {
              const r: any = await api(`/api/approvals/${a.id}/decide`, { body: { decision: 'approved', ...(raiseOn ? { raise_concurrency_to: maxc + 1 } : {}) } });
              await refresh(); setDlg(null); spawnToast(r, p); }} /></div></Dialog>);
      const spawnToast = (r: any, pl: any) => {
        const nm = pl.name;
        if (boot.system.kill_switch) { toast(`Approved. ${nm} will start when agents resume.`); if (r.resumed) return; }
        else if (r.resumed) { toast(`${nm} added. Director woken to assign work.`); return; }
        const th = boot.threads.find((x: any) => x.id === a.thread_id);
        const why = r.reason === 'thread_capped' ? 'capped' : 'closed';
        const actions: NonNullable<Parameters<typeof toast>[2]> = [];
        if (r.reason === 'thread_capped' && th && th.cap_raises === 0)
          actions.push({ label: 'Raise cap', run: async () => { await api(`/api/threads/${a.thread_id}`, { body: { action: 'raise_cap' } }); await refresh(); toast('Cap raised. Reply in the thread to wake the director.'); } });
        if (r.reason === 'thread_closed')
          actions.push({ label: 'Reopen thread', run: async () => { await api(`/api/threads/${a.thread_id}`, { body: { action: 'reopen' } }); await refresh(); toast('Thread reopened. Reply in the thread to wake the director.'); } });
        toast(`${nm} added. Director not woken: thread ${why}. Raise the cap or reopen, then reply in the thread to wake it.`, 'info', actions);
      };
      const approve = async () => {
        if (isSpawn) { spawnApprove(); return; }
        if (a.kind === 'budget_increase') { await api(`/api/approvals/${a.id}/decide`, { body: { decision: 'approved' } });
          set({ settingsPrefill: a.payload, settingsFocus: 'day_usd' }); setView('settings'); await refresh(); return; }
        if (!isTask) { setDlg(<Dialog title={`Approve ${a.kind.replace('_', ' ')}?`} onClose={() => setDlg(null)}>
          <p className="text-sm mb-2">Slackboard cannot perform this. Approving records your decision; you do it yourself.</p>
          <pre className="text-xs bg-slate-900 p-2 rounded whitespace-pre-wrap mb-3">{JSON.stringify(a.payload, null, 2)}</pre>
          <div className="flex gap-2 justify-end">
            <button className="btn bg-slate-700" onClick={() => navigator.clipboard?.writeText(JSON.stringify(a.payload, null, 2))}>Copy</button>
            <ActionButton label="I'll do it myself" kind="primary" onError={conflict} run={async () => { await act(() => api(`/api/approvals/${a.id}/decide`, { body: { decision: 'approved' } })); setDlg(null); }} />
          </div></Dialog>); return; }
        await act(() => api(`/api/approvals/${a.id}/decide`, { body: { decision: 'approved' } }),
          blocked ? `Approved. T-${a.task_id} will start when agents resume.` : `Approved T-${a.task_id}`);
      };
      actions = <>
        <ActionButton label="Approve" pending="Approving…" kind="primary" shortcut="a" run={approve} onError={conflict} disabled={capReached} title={capReached ? 'Worker limit reached (3/3). Retire a worker first.' : undefined} />
        <ActionButton label="Reject" shortcut="r" run={async () => setDlg(<NoteDialog title="Reject" label="Note (optional)" required={false} confirm="Reject"
          onClose={() => setDlg(null)} onDone={(note) => act(() => api(`/api/approvals/${a.id}/decide`, { body: { decision: 'rejected', note } }), isSpawn ? `Add worker ${p.name} rejected` : 'Rejected')} />)} />
        <button className="btn bg-slate-700" onClick={() => open({ kind: 'thread', id: a.thread_id })}>Open thread</button></>;
    } else if (n.item_type === 'help') {
      body = <><div className="whitespace-pre-wrap">{n.message.body}</div>{task && <div className="text-slate-400 text-xs">T-{task.id} {task.title}</div>}</>;
      actions = <><button className="btn bg-sky-700" onClick={() => open({ kind: 'thread', id: n.thread_id })}>Reply</button>
        {task && <ActionButton label="Cancel task" kind="danger" run={async () => confirmCancel(task.id)} />}</>;
    } else if (n.item_type === 'ready') {
      const art = n.artifact;
      body = <div>T-{task.id} &ldquo;{task.title}&rdquo;{art ? ` · ${JSON.parse(art.files).length} file(s) changed (+${art.lines_added} -${art.lines_removed}) · reviewed (round ${art.review_round})` : ''}</div>;
      actions = <>
        <ActionButton label="Accept" kind="primary" shortcut="a" run={() => act(() => api(`/api/tasks/${task.id}`, { body: { action: 'accept' } }), `T-${task.id} accepted`)} />
        <ActionButton label="Reopen" shortcut="r" run={async () => setDlg(<NoteDialog title={`Reopen T-${task.id}`} label="What should change? (required)" confirm="Reopen"
          onClose={() => setDlg(null)} onDone={(note) => act(() => api(`/api/tasks/${task.id}`, { body: { action: 'reopen', note } }), `T-${task.id} reopened`)} />)} />
        {art && <button className="btn bg-slate-700" onClick={() => open({ kind: 'review', id: art.id })}>View diff</button>}</>;
    } else if (n.item_type === 'review_cap') {
      body = <><div>T-{task.id} &ldquo;{task.title}&rdquo;: the director requested changes in round 2 of 2.</div>
        {n.artifact?.verdict_note && <div className="text-slate-300 whitespace-pre-wrap">Reviewer: {n.artifact.verdict_note}</div>}</>;
      actions = <>
        {n.artifact && <button className="btn bg-slate-700" onClick={() => open({ kind: 'review', id: n.artifact.id })}>View diff + verdict</button>}
        <ActionButton label="Send back with note" run={async () => setDlg(<NoteDialog title={`Send T-${task.id} back`} label="Note for the worker (required). Review rounds reset to 0 of 2." confirm="Send back"
          onClose={() => setDlg(null)} onDone={async (note) => { const r = await act(() => api(`/api/tasks/${task.id}`, { body: { action: 'unblock', note } })); toast(retryToast(r, task.id)); }} />)} />
        <ActionButton label="Cancel task" kind="danger" run={async () => confirmCancel(task.id)} /></>;
    } else if (n.item_type === 'failure') {
      const lj = n.lastJob;
      const hfailed = task?.reason?.includes('help failed');
      body = <><div>{hfailed ? `${lj?.agent_id ?? 'director'} could not answer T-${task.id}'s help request` : `${lj?.agent_id ?? 'agent'} failed on T-${task.id}`}: {lj?.failure_kind ?? task?.reason}</div>
        <div className="text-slate-300">&ldquo;{task.title}&rdquo;</div></>;
      actions = <>
        <ActionButton label="Retry" kind="primary" run={async () => { const r = await act(() => api(`/api/tasks/${task.id}`, { body: { action: 'unblock' } })); toast(retryToast(r, task.id)); }} />
        <ActionButton label="Cancel task" kind="danger" run={async () => confirmCancel(task.id)} />
        {lj && <button className="btn bg-slate-700" onClick={() => open({ kind: 'log', id: lj.id })}>Open log</button>}</>;
    } else if (n.item_type === 'thread_capped') {
      const th = n.thread; const tk = boot.tasks.find((t: any) => t.thread_id === th.id);
      body = <div>&ldquo;{th.title}&rdquo; reached its limit (agent messages {th.agent_msg_count}/{th.max_agent_msgs}, runs {th.agent_job_count}/{th.max_agent_jobs}). Agents can no longer post here.{th.cap_raises ? ' Cap already raised once.' : ''}</div>;
      actions = <>
        {!th.cap_raises && <ActionButton label="Raise cap" kind="primary" run={async () => { const r: any = await act(() => api(`/api/threads/${th.id}`, { body: { action: 'raise_cap' } }));
          toast(r.resumed ? `Cap raised. T-${r.resumed.task_id} will resume.` : 'Cap raised.'); }} />}
        {tk && !['done', 'cancelled'].includes(tk.status) && <ActionButton label="Cancel task" kind="danger" run={async () => confirmCancel(tk.id)} />}
        <ActionButton label="Close thread" run={() => act(() => api(`/api/threads/${th.id}`, { body: { action: 'close' } }), tk ? `Thread closed. T-${tk.id} is waiting.` : 'Thread closed')} /></>;
    }
    return (
      <li key={n.key} tabIndex={0} className="border-b border-slate-700 p-4 focus:outline focus:outline-2 focus:outline-sky-400">
        <div className="flex justify-between text-xs text-slate-400 mb-1">
          <span className="font-semibold text-slate-200"><span aria-hidden>{icon}</span> {label}{n.approval && n.approval.kind === 'create_top_level_task' ? ' · New task' : ''}{n.approval?.payload?.action === 'spawn_worker' ? ' · Add worker (uses allowance)' : ''}</span>
          <span>{n.approval ? `from ${n.approval.requested_by_agent_id} · ` : ''}{ago(n.created_at, boot.now)}</span>
        </div>
        <div className="text-sm space-y-1 mb-2">{body}</div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </li>
    );
  };

  const reviewCount = killed.filter((n: any) => n.task?.review_round > 0).length;
  return (
    <section aria-labelledby="ny-h" className="h-full overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-700">
        <h2 id="ny-h" className="font-semibold mr-3">Needs you ({boot.needsYou.length})</h2>
        <span className="text-xs text-slate-400">Filter:</span>
        {FILTERS.map(([l, f]) => <button key={l} aria-pressed={JSON.stringify(filter) === JSON.stringify(f)}
          className={`px-2 py-0.5 rounded text-xs ${JSON.stringify(filter) === JSON.stringify(f) ? 'bg-sky-800' : 'bg-slate-800'}`} onClick={() => setFilter(f)}>{l}</button>)}
        <span className="ml-auto text-xs text-slate-400">Sort: oldest</span>
      </div>
      <ul aria-live="polite" data-nav-list="inbox">
        {boot.system.kill_switch && pending > 0 && (
          <li className="border-b border-slate-700 p-4 text-sm"><span aria-hidden>■</span> {pending} run{pending > 1 ? 's' : ''} stopped; will be marked when the orchestrator restarts.</li>)}
        {showKilled && (
          <li className="border-b border-slate-700 p-4 text-sm">
            <div className="font-semibold mb-1"><span aria-hidden>■</span> {killed.length} task{killed.length > 1 ? 's were' : ' was'} stopped by the kill switch.</div>
            {!killOn && <div className="text-slate-300 mb-2">Retry sends {reviewCount ? `${reviewCount} back to review, ` : ''}the rest back to To do (or review, if their submitted diff is untouched).</div>}
            <div className="flex flex-wrap gap-2">
              <ActionButton label="Retry all" kind="primary" disabled={killOn} title={killOn ? 'Resume agents first' : undefined}
                run={async () => { const r: any = await act(() => api('/api/tasks/unblock-killed', { body: {} }));
                  const rev = r.results.filter((x: any) => x.status === 'in_review').length; toast(`${rev} back to review, ${r.results.length - rev} back to To do`); }} />
              <button className="btn bg-slate-700" disabled={killOn} onClick={() => setExpanded((x) => !x)}>Review individually</button>
              {killOn && <span className="text-xs text-slate-400 self-center">Resume agents first</span>}
            </div>
            {expanded && !killOn && <ul className="mt-2 space-y-1">{killed.map((n: any) => (
              <li key={n.key} className="flex items-center gap-2">T-{n.task.id} {n.task.title}
                <ActionButton label="Retry" run={async () => { const r = await act(() => api(`/api/tasks/${n.task.id}`, { body: { action: 'unblock' } })); toast(retryToast(r, n.task.id)); }} />
                <ActionButton label="Cancel task" kind="danger" run={async () => confirmCancel(n.task.id)} /></li>))}</ul>}
          </li>)}
        {list.map(card)}
      </ul>
      {boot.needsYou.length === 0 && !pending && <p className="p-8 text-center text-slate-400">Nothing needs you.</p>}
      {boot.recentlyExpired.length > 0 && (
        <section aria-labelledby="exp-h" className="p-3 opacity-70">
          <h3 id="exp-h" className="text-xs uppercase text-slate-400 mb-1">Recently expired</h3>
          <ul>{boot.recentlyExpired.map((a: any) => (
            <li key={a.id} className="text-sm py-1 flex gap-2 items-center">Expired after 24 h: {a.task_title ? `T-${a.task_id} "${a.task_title}"` : a.kind === 'spend' && a.payload?.includes('"spawn_worker"') ? `Add worker ${JSON.parse(a.payload).name}` : a.summary}
              <button className="underline" onClick={() => { set({ composerPrefill: a.kind === 'create_top_level_task' ? `@director Please re-propose T-${a.task_id} "${a.task_title}"` : `@director Please ask again: ${a.summary}` }); setView('chat'); }}>
                {a.kind === 'create_top_level_task' ? 'Re-propose' : 'Ask the director again'}</button></li>))}</ul>
        </section>)}
      {dlg}
      <p className="sr-only">Budget used today {usd(boot.usage.spent_day)} est.</p>
    </section>
  );
}
