'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, type Pane } from './store';
import { api } from './api';
import { Composer } from './Composer';
import { ActionButton, Dialog, NoteDialog, TaskStatus, Time, usd } from './ui';
import { retryToast } from './NeedsYou';

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

function PaneShell({ title, children, footer }: { title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  const { back, close, panes } = useStore();
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => { h.current?.focus(); }, []);
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 p-3 border-b border-slate-700">
        {panes.length > 1 && <button className="btn bg-slate-700" onClick={back} aria-label="Back">←</button>}
        <h2 ref={h} tabIndex={-1} className="font-semibold flex-1 truncate outline-none">{title}</h2>
        <button className="btn bg-slate-700" onClick={close} aria-label="Close pane (Esc)">✕</button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
      {footer}
    </div>
  );
}

const roleChip = (m: any) => m.author_kind === 'user' ? 'you' : m.author_kind === 'system' ? 'system' : m.author_agent_id;

function ThreadPane({ id }: { id: number }) {
  const { data, err } = useFetch<any>(`/api/threads/${id}`);
  const { boot, open, refresh, toast } = useStore();
  const [showSys, setShowSys] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.messages?.length]);
  if (err) return <PaneShell title="Thread"><p role="alert" className="p-4 text-rose-300">Couldn&apos;t load thread ({err}).</p></PaneShell>;
  if (!data) return <PaneShell title="Thread"><p className="p-4 text-slate-400">Loading messages…</p></PaneShell>;
  const th = data.thread, task = data.task;
  const sys = data.messages.filter((m: any) => m.author_kind === 'system').length;
  const pct = (a: number, b: number) => a / b >= 0.8;
  const threadAct = async (action: string) => {
    const r: any = await api(`/api/threads/${id}`, { body: { action } }); await refresh();
    const tk = task ? `T-${task.id}` : '';
    if (r.resumed) toast(action === 'raise_cap' ? `Cap raised. ${tk} will resume.` : `Thread reopened. ${tk} will resume.`);
    else if (r.status === 'capped' && action === 'reopen') toast(`Thread reopened but still capped. ${tk} will not resume.`);
    else toast(action === 'close' ? (task && !['done', 'cancelled'].includes(task.status) ? `Thread closed. ${tk} is waiting.` : 'Thread closed') : action === 'raise_cap' ? 'Cap raised.' : 'Thread reopened.');
  };
  return (
    <PaneShell title={<>Thread: {th.title}</>} footer={<>
      <div className="px-3 pt-2 text-xs text-slate-400">
        Agent messages {th.agent_msg_count}/{th.max_agent_msgs} · Agent runs {th.agent_job_count}/{th.max_agent_jobs}
        {(pct(th.agent_msg_count, th.max_agent_msgs) || pct(th.agent_job_count, th.max_agent_jobs)) && <span className="text-amber-300 ml-1">· Near limit</span>}
      </div>
      {th.status === 'closed'
        ? <div className="p-3 text-sm flex items-center gap-2">Thread closed.{task && !['done', 'cancelled'].includes(task.status) ? ` T-${task.id} is waiting.` : ''}
            <ActionButton label="Reopen" run={() => threadAct('reopen')} /></div>
        : th.status === 'capped'
          ? <div className="p-3 text-sm flex flex-wrap items-center gap-2">Thread reached its limit. Agents can no longer post here.
              {th.cap_raises ? <span>Cap already raised once.</span> : <ActionButton label="Raise cap" kind="primary" run={() => threadAct('raise_cap')} />}
              <ActionButton label="Close thread" run={() => threadAct('close')} /></div>
          : <Composer threadId={id} preview={data.preview} threadStatus={th.status} label="Reply…" />}
    </>}>
      <div className="p-3 flex gap-2 items-center flex-wrap text-sm border-b border-slate-800">
        {task && <button className="underline" onClick={() => open({ kind: 'task', id: task.id })}>Task T-{task.id} · <TaskStatus s={task.status} /></button>}
        {task && task.review_round > 0 && <span className="text-slate-400">Round {task.review_round} of 2</span>}
        {th.status !== 'closed' && <ActionButton label="Close thread" run={() => threadAct('close')} />}
        {sys > 0 && <button className="text-xs underline ml-auto" onClick={() => setShowSys((s) => !s)}>{showSys ? 'Hide' : 'Show'} {sys} system events</button>}
      </div>
      <ol className="p-3 space-y-3" aria-live="polite" data-nav-list="messages">
        {data.messages.map((m: any) => m.author_kind === 'system'
          ? (showSys && <li key={m.id} tabIndex={0} className="text-xs text-slate-400 focus:outline focus:outline-2 focus:outline-sky-400"><span aria-hidden>▸</span> system · <Time t={m.created_at} now={boot.now} /> {m.body}</li>)
          : <li key={m.id} tabIndex={0} className={`focus:outline focus:outline-2 focus:outline-sky-400 ${m.kind === 'help' ? 'border-l-2 border-amber-400 pl-2' : ''}`}>
              <div className="text-xs text-slate-400"><span className="font-semibold text-slate-200">{roleChip(m)}</span>{m.kind !== 'chat' ? ` (${m.kind})` : ''} · <Time t={m.created_at} now={boot.now} /></div>
              <div className="text-sm whitespace-pre-wrap">{m.body}</div>
            </li>)}
        {data.running.map((r: any) => <li key={r.agent_id} className="text-xs text-sky-300">{r.agent_id} is working…</li>)}
      </ol>
      {data.artifacts.length > 0 && <div className="px-3 pb-3 flex gap-2 flex-wrap">{data.artifacts.map((a: any) =>
        <button key={a.id} className="text-xs underline" onClick={() => open({ kind: 'review', id: a.id })}>View diff (cycle {a.review_cycle}, round {a.review_round}{a.verdict ? `, ${a.verdict.replace('_', ' ')}` : ''})</button>)}</div>}
      <div ref={end} />
    </PaneShell>
  );
}

const JOB_ICON: Record<string, string> = { queued: '◔', running: '●', succeeded: '✓', failed: '✕', cancelled: '–', killed: '■' };

function TaskPane({ id }: { id: number }) {
  const { data, err } = useFetch<any>(`/api/tasks/${id}`);
  const { boot, open, refresh, toast } = useStore();
  const [dlg, setDlg] = useState<React.ReactNode>(null);
  if (err) return <PaneShell title={`T-${id}`}><p role="alert" className="p-4 text-rose-300">Couldn&apos;t load task ({err}).</p></PaneShell>;
  if (!data) return <PaneShell title={`T-${id}`}><p className="p-4 text-slate-400">Loading…</p></PaneShell>;
  const t = data.task;
  const card = boot.tasks.find((x: any) => x.id === id) ?? {};
  const post = async (action: string, note?: string) => { const r = await api(`/api/tasks/${id}`, { body: { action, note } }); await refresh(); return r; };
  const note = (title: string, label: string, confirm: string, action: string, required = true) =>
    setDlg(<NoteDialog title={title} label={label} confirm={confirm} required={required} onClose={() => setDlg(null)} onDone={async (n) => { const r = await post(action, n); if (action === 'unblock') toast(retryToast(r, id)); }} />);
  const cancel = () => setDlg(<Dialog title={`Cancel T-${id}?`} onClose={() => setDlg(null)}>
    <p className="text-sm mb-3">Queued runs are cancelled and a running agent is stopped.</p>
    <div className="flex justify-end gap-2"><button className="btn bg-slate-700" onClick={() => setDlg(null)}>Keep</button>
      <ActionButton label="Cancel task" kind="danger" run={async () => { await post('cancel'); setDlg(null); toast(`T-${id} cancelled`); }} /></div></Dialog>);
  const cancelJob = (j: any) => setDlg(<Dialog title="Cancel this job?" onClose={() => setDlg(null)}>
    {j.status === 'running' && ['work', 'review'].includes(j.kind) && <p className="text-sm mb-3">T-{id} becomes Blocked: you cancelled the run</p>}
    <div className="flex justify-end gap-2"><button className="btn bg-slate-700" data-autofocus onClick={() => setDlg(null)}>Keep</button>
      <ActionButton label="Cancel job" kind="danger" run={async () => { await api(`/api/jobs/${j.id}`, { body: { action: 'cancel' } }); await refresh(); setDlg(null); }} /></div></Dialog>);
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
  if (!['done', 'cancelled'].includes(t.status)) actions.push(<ActionButton key="cx" label="Cancel task" kind="danger" run={async () => cancel()} />);
  if (lastArt) actions.push(<button key="df" data-shortcut="d" className="btn bg-slate-700" onClick={() => open({ kind: 'review', id: lastArt.id })}>View diff <kbd className="opacity-60 text-[10px]">d</kbd></button>);
  return (
    <PaneShell title={<>T-{t.id} · <TaskStatus s={t.status} /> · assignee: {t.assignee_agent_id}{card.round ? ` · ${card.round}` : ''}</>}
      footer={<div className="p-3 border-t border-slate-700 flex flex-wrap gap-2">{actions}</div>}>
      <div className="p-3 space-y-3 text-sm">
        {card.reason && <p className="text-rose-200"><span aria-hidden>⏸</span> {card.reason}</p>}
        {card.waiting && <p className="text-amber-200"><span aria-hidden>⏸</span> {card.waiting.text}</p>}
        <h3 className="font-semibold text-base">{t.title}</h3>
        <button className="text-xs underline" onClick={() => open({ kind: 'thread', id: t.thread_id })}>Open thread</button>
        {t.parent_id && <p className="text-xs"><button className="underline" onClick={() => open({ kind: 'task', id: t.parent_id })}>↳ subtask of T-{t.parent_id}</button></p>}
        <div><h4 className="text-xs uppercase text-slate-400">Description</h4><p className="whitespace-pre-wrap">{t.description || '—'}</p></div>
        <div><h4 className="text-xs uppercase text-slate-400">Acceptance</h4><p className="whitespace-pre-wrap">{t.acceptance || '—'}</p></div>
        {data.children.length > 0 && <div><h4 className="text-xs uppercase text-slate-400">Subtasks</h4><ul>{data.children.map((c: any) =>
          <li key={c.id}><button className="underline" onClick={() => open({ kind: 'task', id: c.id })}>T-{c.id} {c.title}</button> · <TaskStatus s={c.status} /></li>)}</ul></div>}
        <div><h4 className="text-xs uppercase text-slate-400">Notes (latest 10)</h4>
          {data.notes.length ? <ul className="space-y-1">{data.notes.map((n: any) => <li key={n.id}><span className="text-slate-400">{n.author_agent_id ?? 'you'}:</span> <span className="whitespace-pre-wrap">{n.body}</span></li>)}</ul> : <p className="text-slate-400">None.</p>}</div>
        <div><h4 className="text-xs uppercase text-slate-400">Jobs</h4>
          <table className="w-full text-xs"><tbody>{data.jobs.map((j: any) => (
            <tr key={j.id} className="border-b border-slate-800">
              <td className="py-1">{j.kind}</td><td>{j.agent_id}</td><td>attempt {j.attempts}/{j.max_attempts}</td>
              <td><span aria-hidden>{JOB_ICON[j.status]}</span> {j.status}{j.failure_kind ? ` (${j.failure_kind})` : ''}</td>
              <td>{j.status === 'running' ? `cap ${usd(j.budget_cap_usd)}` : `${usd(j.cost_usd)} est.`}</td>
              <td className="text-right space-x-1">
                {['queued', 'running'].includes(j.status) && <ActionButton label="Cancel job" run={async () => cancelJob(j)} />}
                {j.status === 'queued' && j.attempts > 0 && <ActionButton label="Retry now" run={async () => { await api(`/api/jobs/${j.id}`, { body: { action: 'retry_now' } }); await refresh(); }} />}
                {j.attempts > 0 && <button className="underline" onClick={() => open({ kind: 'log', id: j.id })}>Open log</button>}
              </td></tr>))}</tbody></table></div>
      </div>
      {dlg}
    </PaneShell>
  );
}

function ReviewPane({ id }: { id: number }) {
  const { data, err } = useFetch<any>(`/api/artifacts/${id}`);
  const { boot, refresh, toast } = useStore();
  const [dlg, setDlg] = useState<React.ReactNode>(null);
  if (err) return <PaneShell title="Review"><p role="alert" className="p-4 text-rose-300">Couldn&apos;t load diff ({err}).</p></PaneShell>;
  if (!data) return <PaneShell title="Review"><p className="p-4 text-slate-400">Loading diff…</p></PaneShell>;
  const v = data.verdict;
  const verdict = v === 'approved' ? <><span aria-hidden>✓</span> Approved by {data.verdict_by}</>
    : v === 'changes_requested' ? <><span aria-hidden>✕</span> Changes requested by {data.verdict_by}{data.review_round === 2 ? ' · Round 2 of 2 · review limit reached' : ''}</>
    : v === 'superseded' ? <><span aria-hidden>⟲</span> Set aside: workspace changed before review; round redone</>
    : <><span aria-hidden>◐</span> Awaiting director review</>;
  const post = async (action: string, note?: string) => { const r = await api(`/api/tasks/${data.task_id}`, { body: { action, note } }); await refresh(); return r; };
  let footer: React.ReactNode = null;
  if (data.current && data.task_status === 'done' && !data.parent_id && !data.accepted_at) footer = <>
    <ActionButton label="Accept" kind="primary" shortcut="a" run={async () => { await post('accept'); toast(`T-${data.task_id} accepted`); }} />
    <ActionButton label="Reopen with note" shortcut="r" run={async () => setDlg(<NoteDialog title="Reopen" label="What should change? (required)" confirm="Reopen" onClose={() => setDlg(null)} onDone={(n) => post('reopen', n)} />)} /></>;
  else if (data.current && data.task_status === 'blocked' && data.blocked_reason === 'review_cap') footer = <>
    <ActionButton label="Send back with note" shortcut="r" run={async () => setDlg(<NoteDialog title="Send back" label="Note (required). Review rounds reset to 0 of 2." confirm="Send back" onClose={() => setDlg(null)} onDone={async (n) => toast(retryToast(await post('unblock', n), data.task_id))} />)} />
    <ActionButton label="Cancel task" kind="danger" run={async () => { await post('cancel'); }} /></>;
  return (
    <PaneShell title={<>Review · T-{data.task_id} · round {data.review_round} of 2</>} footer={footer && <div className="p-3 border-t border-slate-700 flex gap-2">{footer}</div>}>
      <div className="p-3 text-sm space-y-2">
        <p>Verdict: {verdict} · <span className="text-slate-400">Captured by server <Time t={data.created_at} now={boot.now} /></span></p>
        <p>Files ({data.files.length}): {data.files.map((f: any) => `${f.path} +${f.added} −${f.removed}`).join(', ') || 'none'}</p>
        {data.verdict_note && <p className="whitespace-pre-wrap">Reviewer notes: &ldquo;{data.verdict_note}&rdquo;</p>}
      </div>
      <pre className="text-xs font-mono px-3 pb-3 overflow-x-auto" aria-label="Unified diff">{data.diff ? data.diff.split('\n').map((l: string, i: number) => {
        const add = l.startsWith('+') && !l.startsWith('+++'), rem = l.startsWith('-') && !l.startsWith('---');
        return <div key={i} className={add ? 'bg-emerald-950 text-emerald-200' : rem ? 'bg-rose-950 text-rose-200' : l.startsWith('@@') ? 'text-sky-300' : ''}>
          {add && <span className="sr-only">added line </span>}{rem && <span className="sr-only">removed line </span>}{l || ' '}</div>;
      }) : 'No diff content.'}</pre>
      {data.truncated && <p className="px-3 pb-3 text-xs text-slate-400">Diff truncated at 2,000 lines.</p>}
      {dlg}
    </PaneShell>
  );
}

function LogPane({ id }: { id: number }) {
  const { data, err } = useFetch<any>(`/api/jobs/${id}/log`);
  if (err) return <PaneShell title={`Log · job ${id}`}><p role="alert" className="p-4 text-rose-300">Couldn&apos;t load log ({err}).</p></PaneShell>;
  if (!data) return <PaneShell title={`Log · job ${id}`}><p className="p-4 text-slate-400">Loading…</p></PaneShell>;
  return (
    <PaneShell title={<>Log · {data.agent_id} {data.kind} · job {id}</>}>
      <p className="p-3 text-sm">Status: {data.status}{data.failure_kind ? ` · Failed: ${data.failure_kind}` : ''}{data.exit_code != null ? ` · exit ${data.exit_code}` : ''}</p>
      {data.error && <pre className="px-3 text-xs text-rose-200 whitespace-pre-wrap">{data.error}</pre>}
      <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-all">{data.lines.length ? data.lines.join('\n') : 'No transcript lines.'}</pre>
    </PaneShell>
  );
}

function NewTaskPane() {
  const { refresh, open, toast, boot } = useStore();
  const [f, setF] = useState({ title: '', description: '', acceptance: '', assignee: 'worker' });
  return (
    <PaneShell title="New task">
      <form className="p-3 space-y-3 text-sm" onSubmit={(e) => e.preventDefault()}>
        <div><label htmlFor="nt-title" className="block mb-1">Title (required)</label><input id="nt-title" className="input w-full" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div><label htmlFor="nt-desc" className="block mb-1">Description</label><textarea id="nt-desc" className="input w-full h-24" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div><label htmlFor="nt-acc" className="block mb-1">Acceptance criteria</label><textarea id="nt-acc" className="input w-full h-20" value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} /></div>
        <div><label htmlFor="nt-as" className="block mb-1">Assignee</label>
          <select id="nt-as" className="input" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
            {boot.agents.filter((a: any) => a.role === 'worker').map((a: any) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></div>
        <ActionButton label="Create" kind="primary" disabled={!f.title.trim()} run={async () => {
          const r: any = await api('/api/tasks', { body: f }); await refresh(); toast(`T-${r.task_id} created`); open({ kind: 'task', id: r.task_id }); }} />
        <p className="text-xs text-slate-400">Will wake worker. Lands in To do; no approval needed (you are acting).</p>
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
