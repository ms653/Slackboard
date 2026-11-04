'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { Composer } from './Composer';
import { ActionButton, Dialog, NoteDialog, Presence, TaskStatus, Time, usd } from './ui';
import { retryToast } from './NeedsYou';
import { AgentsSettings } from './AgentsSettings';
import { dropMove, parseDragId, TASK_MIME } from './dnd';

/** Card drop handlers by task id; each TaskCard registers itself so the board can route a drop to the card's own dialogs. */
const dropHandlers = new Map<number, (target: string) => void>();

export function Chat() {
  const { boot, open } = useStore();
  const endRef = useRef<HTMLDivElement>(null);
  const roots = (boot?.threads ?? []).slice().reverse();
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [roots.length]);
  if (!boot) return null;
  return (
    <section aria-labelledby="chat-h" className="h-full flex flex-col">
      <h2 id="chat-h" className="sr-only"># general</h2>
      <ol className="flex-1 overflow-y-auto p-3 space-y-3" aria-live="polite">
        {roots.length === 0 && <li className="text-center text-slate-400 p-8">Say what you need. Mention @director to start.</li>}
        {roots.map((th: any) => (
          <li key={th.id} className="rounded hover:bg-slate-800/60 p-2">
            <div className="text-xs text-slate-400 flex gap-2">
              <span className="font-semibold text-slate-200">{th.first_author === 'user' ? 'You' : th.first_agent ?? 'system'}</span>
              {th.last_at && <Time t={th.created_at} now={boot.now} />}
              {th.status !== 'open' && <span>· thread {th.status}</span>}
            </div>
            <div className="text-sm whitespace-pre-wrap line-clamp-3">{th.first_body ?? th.title}</div>
            <button className="text-xs text-sky-300 hover:underline mt-1" onClick={() => open({ kind: 'thread', id: th.id })}>
              <span aria-hidden>└</span> {th.replies} message{th.replies === 1 ? '' : 's'}{th.task_id ? ` · T-${th.task_id}` : ''} — open thread
            </button>
          </li>
        ))}
        <div ref={endRef} />
      </ol>
      <Composer threadId={null} threadStatus="open" label="Message #general… (@director to mention)"
        preview={{ agent: 'director', kind: 'respond', blocked_by: boot.system.blocked_by }}
        onSent={(r) => r?.thread_id && open({ kind: 'thread', id: r.thread_id })} />
    </section>
  );
}

const COLUMNS: [string, string][] = [['proposed', 'Proposed'], ['todo', 'To do'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['blocked', 'Blocked'], ['done', 'Done']];

export function TaskCard({ t, now }: { t: any; now: number }) {
  const { boot, open, refresh, toast } = useStore();
  const [menu, setMenu] = useState(false);
  const [dlg, setDlg] = useState<React.ReactNode>(null);
  const claimant = boot.agents.find((a: any) => a.running_task === t.id);
  const name = `T-${t.id}, ${t.title}, ${({ todo: 'To do', in_progress: 'In progress', in_review: 'In review' } as any)[t.status] ?? t.status}${t.round ? ', ' + t.round : ''}, assigned to ${t.assignee_agent_id}`;
  const post = async (action: string, note?: string) => { const r = await api(`/api/tasks/${t.id}`, { body: { action, note } }); await refresh(); return r; };
  const moves: [string, () => void][] = [];
  const doUnblock = () => t.blocked_reason === 'review_cap'
    ? setDlg(<NoteDialog title={`Send T-${t.id} back`} label="Note (required)" confirm="Send back" onClose={() => setDlg(null)} onDone={async (n) => toast(retryToast(await post('unblock', n), t.id))} />)
    : post('unblock').then((r) => toast(retryToast(r, t.id)), (e) => toast(`Couldn't move T-${t.id}: ${e.hint || e.code}`, 'error'));
  const doReopen = () => setDlg(<NoteDialog title={`Reopen T-${t.id}`} label="What should change? (required)" confirm="Reopen" onClose={() => setDlg(null)} onDone={(n) => post('reopen', n)} />);
  const doCancel = () => setDlg(<Dialog title={`Cancel T-${t.id}?`} onClose={() => setDlg(null)}>
    <p className="text-sm mb-3">Queued runs are cancelled and a running agent is stopped.</p>
    <div className="flex justify-end gap-2"><button className="btn bg-slate-700" onClick={() => setDlg(null)}>Keep</button>
      <ActionButton label="Cancel task" kind="danger" run={async () => { await post('cancel'); setDlg(null); toast(`T-${t.id} cancelled`); }} /></div></Dialog>);
  if (t.status === 'blocked') moves.push([t.blocked_reason === 'review_cap' ? 'Send back with note' : 'Unblock (retry)', doUnblock]);
  if (t.status === 'done' && !t.parent_id && !t.accepted_at) moves.push(['Accept', () => post('accept').then(() => toast(`T-${t.id} accepted`))]);
  if (t.status === 'done') moves.push(['Reopen with note', doReopen]);
  if (!['done', 'cancelled'].includes(t.status)) moves.push(['Cancel task', doCancel]);
  dropHandlers.set(t.id, (target) => {
    const r = dropMove(t.status, target);
    if (r.kind === 'reject') toast(r.message, 'error');
    else if (r.kind === 'unblock') doUnblock();
    else if (r.kind === 'reopen') doReopen();
    else if (r.kind === 'cancel') doCancel();
  });
  useEffect(() => () => { dropHandlers.delete(t.id); }, [t.id]);
  return (
    <li aria-label={name} data-task-card={t.id} tabIndex={0} draggable onDragStart={(e) => { e.dataTransfer.setData(TASK_MIME, String(t.id)); e.dataTransfer.effectAllowed = 'move'; }}
      className="bg-slate-800 border border-slate-700 rounded p-2 text-sm focus:outline focus:outline-2 focus:outline-sky-400 cursor-pointer"
      onClick={() => open({ kind: 'task', id: t.id })}
      onKeyDown={(e) => { if (e.key === 'Enter') open({ kind: 'task', id: t.id }); if (e.key === 'm' && moves.length) { e.preventDefault(); setMenu(true); } }}>
      <div className="flex justify-between gap-2 text-xs"><span className="font-mono">T-{t.id}</span><TaskStatus s={t.status} />{t.round && <span className="text-slate-400">{t.round}</span>}</div>
      <div className="font-medium line-clamp-2 my-1">{t.title}</div>
      {t.parent_id && <div className="text-xs text-slate-400"><span aria-hidden>↳</span> subtask of T-{t.parent_id}</div>}
      <div className="text-xs text-slate-300">@{t.assignee_agent_id}{claimant && <> · <Presence a={claimant} now={now} /></>}</div>
      <div className="text-xs text-slate-400">{t.replies} msgs · {t.files} file{t.files === 1 ? '' : 's'} · {usd(t.cost)} est.</div>
      {t.reason && <div className="text-xs text-rose-200"><span aria-hidden>⏸</span> {t.reason}</div>}
      {t.queued && <div className="text-xs text-amber-200">Queued: {t.queued}</div>}
      {t.waiting && <div className="text-xs text-amber-200"><span aria-hidden>⏸</span> {t.waiting.text}</div>}
      {t.done && <div className="text-xs text-emerald-200"><span aria-hidden>✓</span> {t.done}</div>}
      {t.badge && <div className="text-xs text-amber-200"><span aria-hidden>{t.badge.icon}</span> {t.badge.text}{t.badge.retry && `. Retrying in ${Math.max(0, Math.ceil((t.badge.retry.run_after - now) / 1000))} s (${t.badge.retry.attempts}/${t.badge.retry.max_attempts})`}</div>}
      {t.flag && <div className="text-xs font-semibold text-amber-300"><span aria-hidden>⚑</span> {t.flag}</div>}
      {moves.length > 0 && <button className="text-xs underline mt-1" aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}>Move… <kbd>m</kbd></button>}
      {menu && <ul role="menu" className="mt-1 bg-slate-900 border border-slate-600 rounded" onClick={(e) => e.stopPropagation()}>
        {moves.map(([l, f]) => <li key={l} role="none"><button role="menuitem" className="w-full text-left px-2 py-1 hover:bg-slate-700" onClick={() => { setMenu(false); f(); }}>{l}</button></li>)}
      </ul>}
      <div onClick={(e) => e.stopPropagation()}>{dlg}</div>
    </li>
  );
}

export function Board({ now }: { now: number }) {
  const { boot, open } = useStore();
  const [showCancelled, setShowCancelled] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  if (!boot) return null;
  const cols = showCancelled ? [...COLUMNS, ['cancelled', 'Cancelled'] as [string, string]] : COLUMNS;
  return (
    <section aria-labelledby="board-h" className="h-full flex flex-col">
      <div className="flex items-center gap-3 p-3 border-b border-slate-700">
        <h2 id="board-h" className="font-semibold">Board</h2>
        <button className="btn bg-sky-700 hover:bg-sky-600" onClick={() => open({ kind: 'newtask' })}>+ New task</button>
        <label className="text-xs flex items-center gap-1 ml-auto"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled</label>
      </div>
      <div className="flex-1 overflow-x-auto flex gap-3 p-3">
        {cols.map(([k, l]) => {
          let ts = boot.tasks.filter((t: any) => t.status === k);
          const total = ts.length;
          if (k === 'done' && !allDone) ts = ts.slice(-20);
          return (
            <div key={k} data-board-col={k} className={`min-w-[11rem] flex-1 flex flex-col rounded ${over === k ? 'outline outline-2 outline-sky-500' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDragEnter={() => setOver(k)}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === k ? null : o)); }}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = parseDragId(e.dataTransfer); if (id) dropHandlers.get(id)?.(k); }}>
              <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">{l} ({total})</h3>
              <ul aria-label={`${l}, ${total} task${total === 1 ? '' : 's'}`} className="space-y-2 overflow-y-auto" data-nav-list="column">
                {ts.length === 0 && <li className="text-xs text-slate-500">No tasks.</li>}
                {ts.map((t: any) => <TaskCard key={t.id} t={t} now={now} />)}
              </ul>
              {k === 'done' && total > 20 && !allDone && <button className="text-xs underline mt-2" onClick={() => setAllDone(true)}>Show all</button>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Settings() {
  const { boot, refresh, toast, settingsFocus, settingsPrefill, set } = useStore();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [report, setReport] = useState(false);
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const cur = boot ? { day_usd: boot.usage.limit_usd_day, day_jobs: boot.usage.limit_jobs_day, jobs_5h: boot.usage.limit_jobs_5h, max_concurrency: boot.system.max_concurrency } : null;
  useEffect(() => {
    if (!cur) return;
    const base = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, String(v)]));
    if (settingsPrefill) for (const k of Object.keys(base)) if (settingsPrefill[k] !== undefined) base[k] = String(settingsPrefill[k]);
    setVals(base);
    if (settingsFocus) setTimeout(() => refs.current[settingsFocus]?.focus(), 50);
    set({ settingsFocus: null, settingsPrefill: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!boot]);
  if (!boot || !cur) return null;
  const fields: [keyof typeof cur, string, string][] = [['day_usd', 'Daily budget (est. USD)', `used today ${usd(boot.usage.spent_day)} est.`],
    ['day_jobs', 'Jobs per day', `used ${boot.usage.jobs_day}`], ['jobs_5h', 'Jobs per rolling 5 h', `used ${boot.usage.jobs_5h}`], ['max_concurrency', 'Max concurrent agents', '(1–4)']];
  const parsed = Object.fromEntries(fields.map(([k]) => [k, Number(vals[k])])) as Record<string, number>;
  const invalid = fields.filter(([k]) => !(parsed[k] > 0) || (k === 'max_concurrency' && !(Number.isInteger(parsed[k]) && parsed[k] <= 4)));
  const changes = fields.filter(([k]) => parsed[k] !== (cur as any)[k]);
  const dr = boot.system.doctor_report;
  return (
    <section aria-labelledby="set-h" className="h-full overflow-y-auto p-4 max-w-2xl">
      <h2 id="set-h" className="text-lg font-semibold mb-4">Settings</h2>
      <h3 className="font-semibold mb-2">Budgets &amp; caps</h3>
      <div className="space-y-2">
        {fields.map(([k, l, hint]) => (
          <div key={k} className="flex items-center gap-3 text-sm">
            <label htmlFor={`f-${k}`} className="w-48">{l}</label>
            <input id={`f-${k}`} ref={(el) => { refs.current[k] = el; }} className="input w-24" inputMode="decimal" value={vals[k] ?? ''}
              aria-invalid={invalid.some(([x]) => x === k)} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
            <span className="text-slate-400">{hint}</span>
            {invalid.some(([x]) => x === k) && <span role="alert" className="text-rose-300 text-xs">{k === 'max_concurrency' ? 'Must be 1–4' : 'Must be > 0'}</span>}
          </div>))}
      </div>
      <button className="btn bg-sky-700 hover:bg-sky-600 mt-3" disabled={invalid.length > 0 || changes.length === 0} onClick={() => setConfirm(true)}>Save</button>
      {confirm && <Dialog title="Save changes?" onClose={() => setConfirm(false)}>
        <ul className="text-sm mb-3 space-y-1">{changes.map(([k, l]) => <li key={k}>{l}: {k === 'day_usd' ? usd((cur as any)[k]) : (cur as any)[k]} → {k === 'day_usd' ? usd(parsed[k]) + ' est.' : parsed[k]}</li>)}</ul>
        <div className="flex justify-end gap-2"><button className="btn bg-slate-700" onClick={() => setConfirm(false)}>Cancel</button>
          <ActionButton label="Save" kind="primary" pending="Saving…" run={async () => {
            await api('/api/budgets', { method: 'PUT', body: Object.fromEntries(changes.map(([k]) => [k, parsed[k]])) }); await refresh(); setConfirm(false); toast('Settings saved'); }} /></div>
      </Dialog>}
      <AgentsSettings />
      <h3 className="font-semibold mt-6 mb-2">Doctor</h3>
      <div className="text-sm flex items-center gap-3 flex-wrap">
        {dr ? <span>Last run <Time t={dr.at} now={boot.now} /> · {dr.ok ? <span className="text-emerald-300"><span aria-hidden>✓</span> all required checks passed</span> : <span className="text-rose-300"><span aria-hidden>✕</span> failed</span>}</span> : <span>Not run yet</span>}
        {boot.system.claude_version && <span className="text-slate-400">claude {boot.system.claude_version}</span>}
        <ActionButton label="Re-run" pending="Running…" run={async () => { await api('/api/doctor', { body: {} }); toast('Checks started; results appear here'); }} />
        {dr && <button className="btn bg-slate-700" onClick={() => setReport((r) => !r)}>{report ? 'Hide report' : 'Show report'}</button>}
      </div>
      {report && dr && <ul className="mt-2 text-sm space-y-1">{dr.checks.map((c: any) => (
        <li key={c.id}><span aria-hidden>{c.ok ? '✓' : c.level === 'fail' ? '✕' : '⚠'}</span> {c.id}: {c.ok ? 'ok' : c.level} — {c.detail}</li>))}</ul>}
    </section>
  );
}
