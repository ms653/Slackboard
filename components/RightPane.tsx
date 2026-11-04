'use client';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useStore, type Pane } from './store';
import { api } from './api';
import { Composer } from './Composer';
import { ChevronLeft, ChevronRight, CirclePause, CircleCheck, CircleMinus, CircleX, Clock, CornerDownRight, Info, LoaderCircle, Maximize2, Minimize2, OctagonX, RefreshCw, RotateCcw, X, Circle, CircleDot, Eye } from 'lucide-react';
import { ActionButton, Avatar, Dialog, DialogFooter, Icon, NoteDialog, Rich, RoleChip, SelectWrap, TaskStatus, Time, usd } from './ui';
import { retryToast } from './NeedsYou';
import { DiffView, type Show } from './diff/DiffView';
import { EDIT_BUDGET, budgetHitAgent, systemLineHasAction, reproposeDefault, notWokenReason, peerNotStartedAgent } from '../lib/systemLines';

function useFetch<T>(url: string | null) {
  const rev = useStore((s) => s.rev);
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!url) return;
    try { const r = await api(url); setData(r); setErr(null); } catch (e: any) { setErr(`${e.status ? 'HTTP ' + e.status + ' ' : ''}${e.code}`); }
  }, [url]);
  useEffect(() => { load(); }, [load, rev]);
  return { data, err, load };
}

function PaneShell({ title, children, footer, actions }: { title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; actions?: React.ReactNode }) {
  const { back, close, panes } = useStore();
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => { h.current?.focus(); }, []);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-separator material-bar">
        {panes.length > 1 && <button className="btn btn-ghost btn-icon" onClick={back} aria-label="Back" title="Back"><Icon as={ChevronLeft} size={18} /></button>}
        <h2 ref={h} tabIndex={-1} className="text-headline flex-1 min-w-0 truncate outline-none">{title}</h2>
        {actions}
        <button className="btn btn-ghost btn-icon" onClick={close} aria-label="Close pane (Esc)" title="Close"><Icon as={X} size={18} /></button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain min-h-0">{children}</div>
      {footer}
    </div>
  );
}

/** System line text plus inline real buttons: [Edit budget], [Raise cap]/[Reopen thread] (director not woken), [Ask the director instead] (peer hasn't started). */
function SystemBody({ body, thread, task, lastPeerLine, peerQueued }: { body: string; thread: any; task: any; lastPeerLine: boolean; peerQueued: boolean }) {
  const { openSettingsAgent, refresh, toast } = useStore();
  const agent = budgetHitAgent(body);
  const btn = 'btn btn-link ml-1 text-callout inline';
  if (agent) {
    const i = body.indexOf(EDIT_BUDGET);
    return <>{body.slice(0, i)}<button type="button" className="btn btn-link text-callout inline" onClick={() => openSettingsAgent({ agent, field: 'usd' })}>Edit budget</button>{body.slice(i + EDIT_BUDGET.length)}</>;
  }
  const why = notWokenReason(body);
  if (why === 'thread_capped' && thread.status === 'capped' && thread.cap_raises === 0)
    return <>{body} <button type="button" className={btn} onClick={async () => { try { await api(`/api/threads/${thread.id}`, { body: { action: 'raise_cap' } }); await refresh(); toast('Cap raised. Reply in the thread to wake the director.'); } catch (e: any) { toast(e.hint || e.code, 'error'); } }}>Raise cap</button></>;
  if (why === 'thread_closed' && thread.status === 'closed')
    return <>{body} <button type="button" className={btn} onClick={async () => { try { await api(`/api/threads/${thread.id}`, { body: { action: 'reopen' } }); await refresh(); toast('Thread reopened. Reply in the thread to wake the director.'); } catch (e: any) { toast(e.hint || e.code, 'error'); } }}>Reopen thread</button></>;
  const peer = peerNotStartedAgent(body);
  if (peer && lastPeerLine && peerQueued && task && task.status === 'blocked' && task.blocked_reason === 'help' && task.help_agent_id === peer)
    return <>{body} <button type="button" className={btn} onClick={async () => {
      try { await api(`/api/tasks/${task.id}`, { body: { action: 'reroute_help' } }); await refresh(); } catch (e: any) { toast(e.code === 'help_running' ? `${peer} is answering right now` : (e.hint || e.code), 'error'); } }}>Ask the director instead</button></>;
  return <>{body}</>;
}
/** Chip text for a message in a task thread: "help → <target>" on a request, "peer help · read-only" on a peer's answer (PHASE2 §B3). */
function msgChip(m: any): string {
  if (m.kind === 'help' && m.author_kind === 'agent') {
    const mentions: string[] = JSON.parse(m.mentions || '[]');
    return `help → ${m.author_agent_id === 'director' ? 'you' : mentions.find((x) => x !== 'director') ?? 'director'}`;
  }
  if (m.author_kind === 'agent' && m.job_kind === 'help' && m.author_agent_id !== 'director') return 'peer help · read-only';
  return m.kind !== 'chat' ? m.kind : '';
}
const roleChip = (m: any) => m.author_kind === 'user' ? 'you' : m.author_kind === 'system' ? 'system' : m.author_agent_id;

function ThreadPane({ id }: { id: number }) {
  const { data, err } = useFetch<any>(`/api/threads/${id}`);
  const { boot, open, refresh, toast } = useStore();
  const [showSys, setShowSys] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.messages?.length]);
  if (err) return <PaneShell title="Thread"><p role="alert" className="p-4 text-body text-danger">Couldn&apos;t load thread ({err}).</p></PaneShell>;
  if (!data) return <PaneShell title="Thread"><p className="p-4 text-callout text-fg-tertiary">Loading messages…</p></PaneShell>;
  const th = data.thread, task = data.task;
  const sys = data.messages.filter((m: any) => m.author_kind === 'system').length;
  const pct = (a: number, b: number) => a / b >= 0.8;
  const lastPeerIdx = data.messages.reduce((acc: number, m: any, i: number) => m.author_kind === 'system' && peerNotStartedAgent(m.body) ? i : acc, -1);
  const peerQueued = !!task && !!task.help_agent_id && (data.queued_help ?? []).includes(task.help_agent_id);
  const threadAct = async (action: string) => {
    const r: any = await api(`/api/threads/${id}`, { body: { action } }); await refresh();
    const tk = task ? `T-${task.id}` : '';
    if (r.resumed) toast(action === 'raise_cap' ? `Cap raised. ${tk} will resume.` : `Thread reopened. ${tk} will resume.`);
    else if (r.status === 'capped' && action === 'reopen') toast(`Thread reopened but still capped. ${tk} will not resume.`);
    else toast(action === 'close' ? (task && !['done', 'cancelled'].includes(task.status) ? `Thread closed. ${tk} is waiting.` : 'Thread closed') : action === 'raise_cap' ? 'Cap raised.' : 'Thread reopened.');
  };
  return (
    <PaneShell title={<>Thread: {th.title}</>} footer={<div className="shrink-0 border-t border-separator">
      <div className="px-5 py-1.5 text-caption text-fg-tertiary tabular-nums">
        Agent messages {th.agent_msg_count}/{th.max_agent_msgs} · Agent runs {th.agent_job_count}/{th.max_agent_jobs}{data.peer_help > 0 && <> · Peer help {data.peer_help}/2</>}
        {(pct(th.agent_msg_count, th.max_agent_msgs) || pct(th.agent_job_count, th.max_agent_jobs)) && <span className="pill bg-tint-warn text-status-warn ml-1.5">Near limit</span>}
      </div>
      {th.status === 'closed'
        ? <div className="mx-4 mb-4 rounded-xl bg-fill px-4 py-3 text-body text-fg-secondary flex items-center gap-2 flex-wrap">Thread closed.{task && !['done', 'cancelled'].includes(task.status) ? ` T-${task.id} is waiting.` : ''}
            <ActionButton small label="Reopen" run={() => threadAct('reopen')} /></div>
        : th.status === 'capped'
          ? <div className="mx-4 mb-4 rounded-xl bg-fill px-4 py-3 text-body text-fg-secondary flex flex-wrap items-center gap-2">Thread reached its limit. Agents can no longer post here.
              {th.cap_raises ? <span>Cap already raised once.</span> : <ActionButton small label="Raise cap" kind="primary" run={() => threadAct('raise_cap')} />}
              <ActionButton small label="Close thread" run={() => threadAct('close')} /></div>
          : <Composer threadId={id} preview={data.preview} threadStatus={th.status} label="Reply…" spawnQueued={data.spawn_queued} />}
    </div>}>
      <div className="px-4 py-2.5 flex gap-2 items-center flex-wrap text-body border-b border-separator">
        {(task || sys > 0) && <div className="flex w-full items-center gap-2">
          {task && <button className="btn btn-link inline-flex" onClick={() => open({ kind: 'task', id: task.id })}>Task T-{task.id} · <TaskStatus s={task.status} /></button>}
          {task && task.review_round > 0 && <span className="text-callout text-fg-secondary">Round {task.review_round} of 2</span>}
          {sys > 0 && <button className="btn btn-ghost btn-sm text-fg-tertiary ml-auto" onClick={() => setShowSys((s) => !s)}><Icon as={ChevronRight} size={14} className={showSys ? 'rotate-90' : ''} />{showSys ? 'Hide' : 'Show'} {sys} system event{sys === 1 ? '' : 's'}</button>}
        </div>}
        {th.status !== 'closed' && <ActionButton small label="Close thread" run={() => threadAct('close')} />}
      </div>
      <ol className="py-2" aria-live="polite" data-nav-list="messages">
        {data.messages.map((m: any, i: number) => {
          if (m.author_kind === 'system') return (showSys || systemLineHasAction(m.body)) && <li key={m.id} tabIndex={0} className="focus-inset flex items-start gap-2 px-4 py-1 text-callout text-fg-tertiary"><span className="mt-px"><Icon as={Info} size={14} /></span><span className="min-w-0">system · <Time t={m.created_at} now={boot.now} /> <SystemBody body={m.body} thread={th} task={task} lastPeerLine={lastPeerIdx === i} peerQueued={peerQueued} /></span></li>;
          const prev = data.messages[i - 1];
          const grouped = !!prev && prev.author_kind === m.author_kind && prev.author_agent_id === m.author_agent_id && m.created_at - prev.created_at < 300_000 && m.kind === 'chat' && prev.kind === 'chat';
          const you = m.author_kind === 'user';
          return <li key={m.id} tabIndex={0} className={`focus-inset group flex gap-3 px-4 py-1.5 hover:bg-fill/60 ${m.kind === 'help' ? 'border-l-2 border-status-warn' : ''}`}>
            {grouped ? <span className="w-7 shrink-0" aria-hidden /> : <Avatar name={roleChip(m)} you={you} />}
            <div className="min-w-0 flex-1">
              {grouped
                ? <span className="sr-only">{roleChip(m)} <Time t={m.created_at} now={boot.now} /></span>
                : <div className="flex items-baseline gap-2 flex-wrap"><span className="text-body font-semibold text-fg-primary">{roleChip(m)}</span>
                    {msgChip(m) && <RoleChip>{msgChip(m)}</RoleChip>}
                    <span className="text-caption text-fg-tertiary tabular-nums"><Time t={m.created_at} now={boot.now} /></span></div>}
              <div className="text-body-lg text-fg-primary whitespace-pre-wrap break-words"><Rich text={m.body} /></div>
            </div>
          </li>; })}
        {data.running.map((r: any) => <li key={r.agent_id} className="px-4 py-1 text-callout text-fg-secondary flex items-center gap-2"><Icon as={LoaderCircle} size={14} className="animate-spin text-accent" />{r.agent_id} is working…</li>)}
      </ol>
      {data.artifacts.length > 0 && <div className="px-4 pb-3 flex gap-2 flex-wrap">{data.artifacts.map((a: any) =>
        <button key={a.id} className="btn btn-secondary btn-sm" onClick={() => open({ kind: 'review', id: a.id })}>View diff (cycle {a.review_cycle}, round {a.review_round}{a.verdict ? `, ${a.verdict.replace('_', ' ')}` : ''})</button>)}</div>}
      <div ref={end} />
    </PaneShell>
  );
}

const JOB_ICON: Record<string, [typeof Clock, string]> = {
  queued: [Clock, 'text-fg-secondary'], running: [CircleDot, 'text-status-progress'], succeeded: [CircleCheck, 'text-status-done'],
  failed: [CircleX, 'text-danger'], cancelled: [CircleMinus, 'text-fg-tertiary'], killed: [OctagonX, 'text-danger'],
};
const SECTION = 'text-caption font-semibold text-fg-tertiary mb-1';

function TaskPane({ id }: { id: number }) {
  const { data, err } = useFetch<any>(`/api/tasks/${id}`);
  const { boot, open, refresh, toast, openSettingsAgent, set, setView, close } = useStore();
  const [dlg, setDlg] = useState<React.ReactNode>(null);
  const [reTo, setReTo] = useState('');
  const [rsErr, setRsErr] = useState<string | null>(null);
  if (err) return <PaneShell title={`T-${id}`}><p role="alert" className="p-4 text-body text-danger">Couldn&apos;t load task ({err}).</p></PaneShell>;
  if (!data) return <PaneShell title={`T-${id}`}><p className="p-4 text-callout text-fg-tertiary">Loading…</p></PaneShell>;
  const t = data.task;
  const card = boot.tasks.find((x: any) => x.id === id) ?? {};
  const post = async (action: string, note?: string) => { const r = await api(`/api/tasks/${id}`, { body: { action, note } }); await refresh(); return r; };
  const note = (title: string, label: string, confirm: string, action: string, required = true) =>
    setDlg(<NoteDialog title={title} label={label} confirm={confirm} required={required} onClose={() => setDlg(null)} onDone={async (n) => { const r = await post(action, n); if (action === 'unblock') toast(retryToast(r, id)); }} />);
  const enabledWorkers = boot.agents.filter((a: any) => a.role === 'worker' && a.enabled && !a.retired_at);
  const reToId = reTo || reproposeDefault(t.assignee_agent_id, enabledWorkers) || '';
  const agentTop = t.created_by_kind === 'agent' && !t.parent_id;
  const cancel = () => setDlg(<Dialog title={`Cancel T-${id}?`} onClose={() => setDlg(null)}>
    <p className="text-body text-fg-secondary">Queued runs are cancelled and a running agent is stopped.</p>
    {agentTop && enabledWorkers.length > 0 && <div className="mt-3 text-body">
      <label htmlFor="re-to" className="field-label block mb-1">Re-propose to</label>
      <SelectWrap className="block"><select id="re-to" className="input select" value={reToId} onChange={(e) => setReTo(e.target.value)}>
        {enabledWorkers.map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></SelectWrap>
      <div className="mt-2"><ActionButton label={`Cancel and ask the director to re-propose to ${reToId}`} run={async () => {
        const to = reToId;
        await post('cancel'); setDlg(null); toast(`T-${id} cancelled`);
        set({ composerPrefill: `@director Re-propose T-${id} "${t.title}" assigned to ${to}.` }); setView('chat'); close(); }} /></div></div>}
    <DialogFooter><button className="btn btn-secondary" onClick={() => setDlg(null)}>Keep</button>
      <ActionButton label="Cancel task" kind="danger" run={async () => { await post('cancel'); setDlg(null); toast(`T-${id} cancelled`); }} /></DialogFooter></Dialog>);
  const helper: string | null = t.help_agent_id ?? null;
  const reassignable = t.status === 'todo' || (t.status === 'blocked' && t.blocked_reason !== 'help');
  const reassignTo = enabledWorkers.filter((a: any) => a.id !== helper && a.id !== t.assignee_agent_id);
  const cancelJob = (j: any) => setDlg(<Dialog title="Cancel this job?" onClose={() => setDlg(null)}>
    {j.status === 'running' && ['work', 'review'].includes(j.kind) && <p className="text-body text-fg-secondary mb-3">T-{id} becomes Blocked: you cancelled the run</p>}
    <DialogFooter><button className="btn btn-secondary" data-autofocus onClick={() => setDlg(null)}>Keep</button>
      <ActionButton label="Cancel job" kind="danger" run={async () => { await api(`/api/jobs/${j.id}`, { body: { action: 'cancel' } }); await refresh(); setDlg(null); }} /></DialogFooter></Dialog>);
  const lastArt = data.artifacts.filter((a: any) => a.verdict !== 'superseded').slice(-1)[0];
  const actions: React.ReactNode[] = [];
  if (t.status === 'proposed' && data.approval?.status === 'pending') {
    actions.push(<ActionButton key="ap" label="Approve" kind="primary" run={async () => { await api(`/api/approvals/${data.approval.id}/decide`, { body: { decision: 'approved' } }); await refresh(); }} />);
    actions.push(<ActionButton key="rj" label="Reject" run={async () => setDlg(<NoteDialog title="Reject" label="Note (optional)" required={false} confirm="Reject" onClose={() => setDlg(null)}
      onDone={async (n) => { await api(`/api/approvals/${data.approval.id}/decide`, { body: { decision: 'rejected', note: n } }); await refresh(); }} />)} />);
  }
  if (t.status === 'blocked') actions.push(t.blocked_reason === 'review_cap'
    ? <ActionButton key="ub" label="Send back with note" run={async () => note(`Send T-${id} back`, 'Note for the worker (required). Review rounds reset to 0 of 2.', 'Send back', 'unblock')} />
    : <ActionButton key="ub" label="Unblock with note" kind="primary" run={async () => note(`Unblock T-${id}`, 'Note (optional)', 'Unblock', 'unblock', false)} />);
  if (t.status === 'done' && !t.parent_id && !t.accepted_at) actions.push(<ActionButton key="ac" label="Accept" kind="primary" run={async () => { await post('accept'); toast(`T-${id} accepted`); }} />);
  if (t.status === 'done') actions.push(<ActionButton key="ro" label="Reopen with note" run={async () => note(`Reopen T-${id}`, 'What should change? (required)', 'Reopen', 'reopen')} />);
  if (card.waiting?.action === 'reopen') actions.push(<ActionButton key="rt" label="Reopen thread" run={async () => { const r: any = await api(`/api/threads/${t.thread_id}`, { body: { action: 'reopen' } }); await refresh();
    toast(r.resumed ? `Thread reopened. T-${id} will resume.` : r.status === 'capped' ? `Thread reopened but still capped. T-${id} will not resume.` : 'Thread reopened.'); }} />);
  if (card.waiting?.action === 'raise_cap') actions.push(<ActionButton key="rc" label="Raise cap" run={async () => { const r: any = await api(`/api/threads/${t.thread_id}`, { body: { action: 'raise_cap' } }); await refresh();
    toast(r.resumed ? `Cap raised. T-${id} will resume.` : 'Cap raised.'); }} />);
  if (!['done', 'cancelled'].includes(t.status)) actions.push(<ActionButton key="cx" label="Cancel task" kind="danger-ghost" run={async () => cancel()} />);
  if (lastArt) actions.push(<button key="df" data-shortcut="d" aria-keyshortcuts="d" className="btn btn-secondary" onClick={() => open({ kind: 'review', id: lastArt.id })}>View diff <kbd aria-hidden className="kbd">d</kbd></button>);
  return (
    <PaneShell title={<>T-{t.id} · <TaskStatus s={t.status} /> <span className="text-callout font-normal text-fg-secondary">· assignee: {t.assignee_agent_id}{card.round ? ` · ${card.round}` : ''}</span></>}
      footer={<div className="shrink-0 border-t border-separator px-4 py-3 flex flex-wrap items-center gap-2 bg-content">{actions}</div>}>
      <div className="px-4 py-4 flex flex-col gap-5 text-body">
        {(card.reason || card.waiting || card.queued || (t.status === 'blocked' && t.blocked_reason === 'help') || card.peer_help?.status === 'queued' || (reassignable && agentTop)) && <div className="flex flex-col gap-2">
        {card.reason && <p className="flex items-start gap-1.5 text-callout text-danger"><Icon as={CirclePause} size={14} className="mt-px" /> {card.reason}</p>}
        {card.waiting && <p className="flex items-start gap-1.5 text-callout text-status-warn"><Icon as={CirclePause} size={14} className="mt-px" /> {card.waiting.text}</p>}
        {card.queued && <p className="flex items-start gap-1.5 text-callout text-fg-secondary"><Icon as={Clock} size={14} className="mt-px" /><span>Queued: {card.queued}{' '}
          {card.queued === 'agent budget' && <button className="btn btn-link text-callout inline" onClick={() => openSettingsAgent({ agent: t.assignee_agent_id, field: 'usd' })}>Edit budget</button>}
          {card.queued === 'disabled' && <button className="btn btn-link text-callout inline" onClick={() => openSettingsAgent({ agent: t.assignee_agent_id, field: 'enabled' })}>Enable</button>}</span></p>}
        {t.status === 'blocked' && t.blocked_reason === 'help' && <p className="text-callout text-fg-secondary">Waiting on {helper ?? 'the helper'}; reroute help or reply first</p>}
        {card.peer_help?.status === 'queued' && <p><ActionButton small label="Ask the director instead" run={async () => {
          try { await post('reroute_help'); toast(`Asking the director instead of ${card.peer_help.agent}`); }
          catch (e: any) { if (e.code === 'help_running') { toast(`${card.peer_help.agent} is answering right now`, 'error'); return; } throw e; } }} /></p>}
        {reassignable && agentTop && <p className="text-callout text-fg-secondary">Proposed by the director; to move it, cancel and ask the director to re-propose.</p>}
        </div>}
        {reassignable && !agentTop && (enabledWorkers.length === 0
          ? <p className="text-callout text-fg-secondary">No worker is enabled. <button className="btn btn-link text-callout inline" onClick={() => openSettingsAgent({ agent: t.assignee_agent_id, field: 'enabled' })}>Enable</button></p>
          : <div className="flex items-center gap-2"><label htmlFor="reassign" className="text-callout text-fg-secondary">Reassign</label>
              <SelectWrap><select id="reassign" className="input select w-auto" value="" onChange={async (e) => {
                const to = e.target.value; if (!to) return; setRsErr(null);
                try { await api(`/api/tasks/${id}`, { body: { action: 'reassign', assignee: to } }); await refresh(); toast(`T-${id} reassigned to ${to}`); }
                catch (er: any) { setRsErr(er.hint || er.code); } }}>
                <option value="">Reassign…</option>{reassignTo.map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select>
              </SelectWrap>
              {rsErr && <span role="alert" className="field-error mt-0">{rsErr}</span>}</div>)}
        <div>
          <h3 className="text-headline">{t.title}</h3>
          <div className="mt-1 flex items-center gap-3">
            <button className="btn btn-link text-callout" onClick={() => open({ kind: 'thread', id: t.thread_id })}>Open thread</button>
            {t.parent_id && <button className="btn btn-link text-callout" onClick={() => open({ kind: 'task', id: t.parent_id })}><Icon as={CornerDownRight} size={14} /> subtask of T-{t.parent_id}</button>}
          </div>
        </div>
        <div><h4 className={SECTION}>Description</h4><p className="text-body-lg whitespace-pre-wrap">{t.description || '—'}</p></div>
        <div><h4 className={SECTION}>Acceptance</h4><p className="text-body-lg whitespace-pre-wrap">{t.acceptance || '—'}</p></div>
        {data.children.length > 0 && <div><h4 className={SECTION}>Subtasks</h4><ul className="space-y-1">{data.children.map((c: any) =>
          <li key={c.id} className="flex items-center gap-2"><button className="btn btn-link" onClick={() => open({ kind: 'task', id: c.id })}>T-{c.id} {c.title}</button> · <TaskStatus s={c.status} /></li>)}</ul></div>}
        <div><h4 className={SECTION}>Notes (latest 10)</h4>
          {data.notes.length ? <ul className="space-y-1">{data.notes.map((n: any) => <li key={n.id}><span className="text-fg-tertiary">{n.author_agent_id ?? 'you'}:</span> <span className="whitespace-pre-wrap">{n.body}</span></li>)}</ul> : <p className="text-fg-tertiary">None.</p>}</div>
        <div><h4 className={SECTION}>Jobs</h4>
          <table className="w-full text-callout"><tbody>{data.jobs.map((j: any) => {
            const [JI, jc] = JOB_ICON[j.status] ?? [Circle, ''];
            const hasActions = ['queued', 'running'].includes(j.status) || j.attempts > 0;
            return (<Fragment key={j.id}>
            <tr className={`h-8 ${hasActions ? '' : 'border-b border-separator'}`}>
              <td className="pr-3">{j.kind} · {j.agent_id}</td><td className="pr-3 tabular-nums text-fg-secondary">attempt {j.attempts}/{j.max_attempts}</td>
              <td className="pr-3"><span className="inline-flex items-center gap-1"><span className={jc}><Icon as={JI} size={14} /></span> {j.status}{j.failure_kind ? ` (${j.failure_kind})` : ''}</span></td>
              <td className="text-right tabular-nums text-fg-secondary">{j.status === 'running' ? `cap ${usd(j.budget_cap_usd)}` : `${usd(j.cost_usd)} est.`}</td></tr>
            {hasActions && <tr className="border-b border-separator"><td colSpan={4} className="pb-2 text-right"><span className="inline-flex gap-1 items-center">
                {['queued', 'running'].includes(j.status) && <ActionButton small label="Cancel job" run={async () => cancelJob(j)} />}
                {j.status === 'queued' && j.attempts > 0 && <ActionButton small label="Retry now" run={async () => { await api(`/api/jobs/${j.id}`, { body: { action: 'retry_now' } }); await refresh(); }} />}
                {j.attempts > 0 && <button className="btn btn-link text-callout" onClick={() => open({ kind: 'log', id: j.id })}>Open log</button>}
              </span></td></tr>}</Fragment>); })}</tbody></table></div>
      </div>
      {dlg}
    </PaneShell>
  );
}

function ReviewPane({ id }: { id: number }) {
  const [show, setShow] = useState<Show>({ kind: 'round', id });
  const curId = show.kind === 'round' ? show.id : show.to;
  const { data, err, load } = useFetch<any>(`/api/artifacts/${curId}`);
  const { boot, refresh, toast, diffExpanded: expanded, set } = useStore();
  const [dlg, setDlg] = useState<React.ReactNode>(null);
  const expandBtn = useRef<HTMLButtonElement>(null);
  const first = useRef(true);
  const toggle = useCallback(() => set({ diffExpanded: !useStore.getState().diffExpanded }), [set]);
  useEffect(() => { if (first.current) { first.current = false; return; }
    setTimeout(() => (expanded ? document.querySelector<HTMLElement>('aside[aria-label="Detail"] h2') : expandBtn.current)?.focus(), 0); }, [expanded]);
  useEffect(() => () => { set({ diffExpanded: false }); }, [set]);
  if (err && !data) return <PaneShell title="Review"><p role="alert" className="p-4 text-body text-danger">Couldn&apos;t load diff ({err}). <button className="btn btn-link inline" onClick={() => load()}>Retry</button></p></PaneShell>;
  if (!data) return <PaneShell title="Review"><p className="p-4 text-callout text-fg-tertiary" aria-busy="true">Loading diff…</p></PaneShell>;
  const v = data.verdict;
  const vpill = (cls: string, I: typeof Eye) => `pill ${cls}`;
  const verdict = v === 'approved' ? <span className={vpill('bg-status-done/[.12] text-status-done', CircleCheck)}><Icon as={CircleCheck} size={14} />Approved by {data.verdict_by}</span>
    : v === 'changes_requested' ? <span className={vpill('bg-status-blocked/[.12] text-status-blocked', CircleX)}><Icon as={CircleX} size={14} />Changes requested by {data.verdict_by}{data.review_round === 2 ? ' · Round 2 of 2 · review limit reached' : ''}</span>
    : v === 'superseded' ? <span className={vpill('bg-tint-warn text-status-warn', RotateCcw)}><Icon as={RotateCcw} size={14} />Set aside: workspace changed before review; round redone</span>
    : <span className={vpill('bg-status-review/[.12] text-status-review', Eye)}><Icon as={Eye} size={14} />Awaiting director review</span>;
  const post = async (action: string, note?: string) => { const r = await api(`/api/tasks/${data.task_id}`, { body: { action, note } }); await refresh(); return r; };
  let footer: React.ReactNode = null;
  if (data.current && data.task_status === 'done' && !data.parent_id && !data.accepted_at) footer = <>
    <ActionButton label="Accept" kind="primary" shortcut="a" run={async () => { await post('accept'); toast(`T-${data.task_id} accepted`); }} />
    <ActionButton label="Reopen with note" shortcut="r" run={async () => setDlg(<NoteDialog title="Reopen" label="What should change? (required)" confirm="Reopen" onClose={() => setDlg(null)} onDone={(n) => post('reopen', n)} />)} /></>;
  else if (data.current && data.task_status === 'blocked' && data.blocked_reason === 'review_cap') footer = <>
    <ActionButton label="Send back with note" shortcut="r" run={async () => setDlg(<NoteDialog title="Send back" label="Note (required). Review rounds reset to 0 of 2." confirm="Send back" onClose={() => setDlg(null)} onDone={async (n) => toast(retryToast(await post('unblock', n), data.task_id))} />)} />
    <ActionButton label="Cancel task" kind="danger-ghost" run={async () => { await post('cancel'); }} /></>;
  return (
    <PaneShell title={<>Review · T-{data.task_id} · round {data.review_round} of 2</>} footer={footer && <div className="shrink-0 border-t border-separator px-4 py-3 flex items-center gap-2 bg-content">{footer}</div>}
      actions={<button ref={expandBtn} className="btn btn-ghost btn-sm" aria-expanded={expanded} aria-keyshortcuts="x" onClick={toggle}><Icon as={expanded ? Minimize2 : Maximize2} size={14} />{expanded ? 'Collapse' : 'Expand'} <kbd aria-hidden className="kbd">x</kbd></button>}>
      <div className="px-4 py-3 text-body space-y-2 border-b border-separator">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">Verdict: {verdict} <span className="text-caption text-fg-tertiary">Captured by server <Time t={data.created_at} now={boot.now} /></span></p>
        {data.verdict_note && <p className="whitespace-pre-wrap text-fg-secondary">Reviewer notes: &ldquo;{data.verdict_note}&rdquo;</p>}
      </div>
      <DiffView data={data} show={show} setShow={setShow} reload={() => load()} expanded={expanded} toggleExpand={toggle} />
      {dlg}
    </PaneShell>
  );
}

function LogPane({ id }: { id: number }) {
  const { data, err } = useFetch<any>(`/api/jobs/${id}/log`);
  if (err) return <PaneShell title={`Log · job ${id}`}><p role="alert" className="p-4 text-body text-danger">Couldn&apos;t load log ({err}).</p></PaneShell>;
  if (!data) return <PaneShell title={`Log · job ${id}`}><p className="p-4 text-callout text-fg-tertiary">Loading…</p></PaneShell>;
  return (
    <PaneShell title={<>Log · {data.agent_id} {data.kind} · job {id}</>}>
      <p className="px-4 py-3 text-body">Status: {data.status}{data.failure_kind ? ` · Failed: ${data.failure_kind}` : ''}{data.exit_code != null ? ` · exit ${data.exit_code}` : ''}</p>
      {data.error && <pre className="px-4 text-callout text-danger whitespace-pre-wrap">{data.error}</pre>}
      <pre className="font-mono text-mono mx-4 mb-4 rounded-md bg-sunken p-3 whitespace-pre-wrap break-all">{data.lines.length ? data.lines.join('\n') : 'No transcript lines.'}</pre>
    </PaneShell>
  );
}

function NewTaskPane() {
  const { refresh, open, toast, boot } = useStore();
  const enabled = boot.agents.filter((a: any) => a.role === 'worker' && a.enabled && !a.retired_at);
  const open_ = (id: string) => boot.tasks.filter((t: any) => t.assignee_agent_id === id && ['proposed', 'todo', 'in_progress', 'in_review', 'blocked'].includes(t.status)).length;
  const fewest = enabled.slice().sort((a: any, b: any) => open_(a.id) - open_(b.id))[0]?.id ?? '';     // T1: fewest open tasks, ties by created_at
  const [f, setF] = useState({ title: '', description: '', acceptance: '', assignee: '' });
  const assignee = enabled.some((a: any) => a.id === f.assignee) ? f.assignee : fewest;
  const { openSettingsAgent } = useStore();
  return (
    <PaneShell title="New task">
      <form className="px-4 py-4 flex flex-col gap-4 text-body" onSubmit={(e) => e.preventDefault()}>
        <div><label htmlFor="nt-title" className="field-label block mb-1.5">Title (required)</label><input id="nt-title" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div><label htmlFor="nt-desc" className="field-label block mb-1.5">Description</label><textarea id="nt-desc" className="textarea h-24" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div><label htmlFor="nt-acc" className="field-label block mb-1.5">Acceptance criteria</label><textarea id="nt-acc" className="textarea h-20" value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} /></div>
        <div><label htmlFor="nt-as" className="field-label block mb-1.5">Assignee</label>
          {enabled.length === 0
            ? <p id="nt-as-none" className="text-callout text-fg-secondary">No worker is enabled. <button type="button" className="btn btn-link text-callout inline" onClick={() => openSettingsAgent({ agent: boot.agents.find((a: any) => a.role === 'worker' && !a.retired_at)?.id ?? 'worker', field: 'enabled' })}>Enable</button></p>
            : <SelectWrap className="block"><select id="nt-as" className="input select" value={assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
                {enabled.map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></SelectWrap>}</div>
        <ActionButton label="Create" kind="primary" disabled={!f.title.trim() || enabled.length === 0} title={enabled.length === 0 ? 'No worker is enabled' : undefined} run={async () => {
          const r: any = await api('/api/tasks', { body: { ...f, assignee } }); await refresh(); toast(`T-${r.task_id} created`); open({ kind: 'task', id: r.task_id }); }} />
        <p className="field-hint">Will wake {assignee || 'the assignee'}. Lands in To do; no approval needed (you are acting).</p>
      </form>
    </PaneShell>
  );
}

export function RightPane({ pane }: { pane: Pane }) {
  switch (pane.kind) {
    case 'thread': return <ThreadPane key={pane.id} id={pane.id} />;
    case 'task': return <TaskPane key={pane.id} id={pane.id} />;
    case 'review': return <ReviewPane key={pane.id} id={pane.id} />;
    case 'log': return <LogPane key={pane.id} id={pane.id} />;
    case 'newtask': return <NewTaskPane />;
  }
}
