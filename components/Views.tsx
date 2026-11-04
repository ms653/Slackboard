'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { Composer } from './Composer';
import { CircleCheck, CirclePause, CircleX, Clock, CornerDownRight, Flag, MessageSquare, Plus, TriangleAlert } from 'lucide-react';
import { ActionButton, Avatar, Dialog, DialogFooter, GlyphIcon, Icon, NoteDialog, Presence, Rich, RoleChip, STATUS_ICON, STATUS_ICON_CLS, TaskStatus, Time, usd } from './ui';
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
      <ol className="flex-1 overflow-y-auto overscroll-contain py-2" aria-live="polite">
        {roots.length === 0 && <li className="mx-auto max-w-[320px] py-16 flex flex-col items-center text-center gap-2">
          <span className="h-12 w-12 rounded-full bg-fill-strong grid place-items-center text-fg-tertiary"><Icon as={MessageSquare} size={24} /></span>
          <span className="text-headline">Say what you need.</span> <span className="text-body text-fg-secondary">Mention @director to start.</span></li>}
        {roots.map((th: any) => {
          const you = th.first_author === 'user';
          const who = you ? 'You' : th.first_agent ?? 'system';
          return (
          <li key={th.id} className="group flex gap-3 px-5 py-1.5 hover:bg-fill/60 transition-colors duration-fast">
            <Avatar name={who} you={you} />
            <div className="min-w-0 max-w-[72ch]">
              <div className="flex items-baseline gap-2">
                <span className="text-body font-semibold text-fg-primary">{who}</span>
                {!you && <RoleChip>{th.first_agent ? (th.first_agent === 'director' ? 'director' : 'worker') : 'system'}</RoleChip>}
                {th.last_at && <span className="text-caption text-fg-tertiary tabular-nums"><Time t={th.created_at} now={boot.now} /></span>}
                {th.status !== 'open' && <span className="text-caption text-fg-tertiary">· thread {th.status}</span>}
              </div>
              <div className="text-body-lg text-fg-primary whitespace-pre-wrap break-words line-clamp-3"><Rich text={th.first_body ?? th.title} /></div>
              <button className="btn btn-link text-callout mt-1" onClick={() => open({ kind: 'thread', id: th.id })}>
                <Icon as={MessageSquare} size={14} /> {th.replies} message{th.replies === 1 ? '' : 's'}{th.task_id ? ` · T-${th.task_id}` : ''} — open thread
              </button>
            </div>
          </li>); })}
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
    <p className="text-body text-fg-secondary">Queued runs are cancelled and a running agent is stopped.</p>
    <DialogFooter><button className="btn btn-secondary" onClick={() => setDlg(null)}>Keep</button>
      <ActionButton label="Cancel task" kind="danger" run={async () => { await post('cancel'); setDlg(null); toast(`T-${t.id} cancelled`); }} /></DialogFooter></Dialog>);
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
      className="group relative rounded-lg bg-elevated p-3 shadow-sm hover:shadow-md active:shadow-lg active:rotate-[1deg] transition-shadow duration-fast cursor-pointer"
      onClick={() => open({ kind: 'task', id: t.id })}
      onKeyDown={(e) => { if (e.key === 'Enter') open({ kind: 'task', id: t.id }); if (e.key === 'm' && moves.length) { e.preventDefault(); setMenu(true); } }}>
      <div className="flex items-center gap-2"><span className="font-mono text-caption text-fg-tertiary">T-{t.id}</span><TaskStatus s={t.status} />{t.round && <span className="ml-auto text-caption text-fg-tertiary tabular-nums">{t.round}</span>}</div>
      <div className="mt-1.5 text-body font-semibold text-fg-primary line-clamp-2" title={t.title}>{t.title}</div>
      {t.parent_id && <div className="mt-1 flex items-center gap-1 text-callout text-fg-secondary"><Icon as={CornerDownRight} size={14} className="text-fg-tertiary" /> subtask of T-{t.parent_id}</div>}
      <div className="mt-2 flex items-center gap-2 text-callout text-fg-secondary">@{t.assignee_agent_id}{claimant && <> · <Presence a={claimant} now={now} /></>}</div>
      <div className="mt-1 text-caption text-fg-tertiary tabular-nums">{t.replies} msgs · {t.files} file{t.files === 1 ? '' : 's'} · {usd(t.cost)} est.</div>
      {t.reason && <div className="mt-2 flex items-start gap-1.5 text-callout text-danger"><Icon as={CirclePause} size={14} className="mt-px" /> {t.reason}</div>}
      {t.queued && <div className="mt-1 flex gap-1.5 text-callout text-fg-secondary"><Icon as={Clock} size={14} className="mt-px" />Queued: {t.queued}</div>}
      {t.waiting && <div className="mt-2 flex items-start gap-1.5 text-callout text-status-warn"><Icon as={CirclePause} size={14} className="mt-px" /> {t.waiting.text}</div>}
      {t.done && <div className="mt-2 flex gap-1.5 text-callout text-status-done"><Icon as={CircleCheck} size={14} className="mt-px" /> {t.done}</div>}
      {t.badge && <div className="mt-2 flex items-start gap-1.5 text-callout text-status-warn"><span className="mt-px"><GlyphIcon glyph={t.badge.icon} /></span> {t.badge.text}{t.badge.retry && `. Retrying in ${Math.max(0, Math.ceil((t.badge.retry.run_after - now) / 1000))} s (${t.badge.retry.attempts}/${t.badge.retry.max_attempts})`}</div>}
      {t.flag && <div className="mt-3 -mx-3 -mb-3 px-3 py-2 border-t border-separator rounded-b-lg flex items-center gap-1.5 text-callout font-medium text-accent"><Icon as={Flag} size={14} /> {t.flag}</div>}
      {moves.length > 0 && <button className="btn btn-ghost btn-sm absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 bg-elevated" aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}>Move… <kbd aria-hidden className="kbd">m</kbd></button>}
      {menu && <ul role="menu" className="mt-2 rounded-lg bg-sunken p-1" onClick={(e) => e.stopPropagation()}>
        {moves.map(([l, f]) => <li key={l} role="none"><button role="menuitem" className="w-full text-left h-7 px-2 rounded-md text-body hover:bg-fill-strong" onClick={() => { setMenu(false); f(); }}>{l}</button></li>)}
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
      <div className="flex items-center gap-3 px-5 pt-4 pb-1">
        <h2 id="board-h" className="text-title">Board</h2>
        <button className="btn btn-primary btn-sm" onClick={() => open({ kind: 'newtask' })}><Icon as={Plus} size={14} />New task</button>
        <label className="text-callout text-fg-secondary inline-flex items-center gap-2 ml-auto"><input type="checkbox" className="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled</label>
      </div>
      <div className="flex-1 min-h-0 overflow-x-auto flex gap-4 px-5 py-4 max-md:px-4 max-md:snap-x max-md:snap-mandatory">
        {cols.map(([k, l]) => {
          let ts = boot.tasks.filter((t: any) => t.status === k);
          const total = ts.length;
          if (k === 'done' && !allDone) ts = ts.slice(-20);
          return (
            <div key={k} data-board-col={k} className={`w-[272px] max-md:w-[85vw] max-md:snap-start shrink-0 flex flex-col gap-2 min-h-0 rounded-xl ${over === k ? 'bg-accent/[.06] ring-2 ring-accent/40' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDragEnter={() => setOver(k)}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === k ? null : o)); }}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = parseDragId(e.dataTransfer); if (id) dropHandlers.get(id)?.(k); }}>
              <h3 className="h-8 shrink-0 flex items-center gap-1.5 px-1 text-callout font-semibold text-fg-secondary">
                <Icon as={STATUS_ICON(k)} size={14} className={STATUS_ICON_CLS(k)} />{l} <span className="font-normal text-fg-tertiary tabular-nums">({total})</span></h3>
              <ul aria-label={`${l}, ${total} task${total === 1 ? '' : 's'}`} className="flex flex-col gap-2 overflow-y-auto overscroll-contain px-1 -mx-1 pb-2 min-h-0" data-nav-list="column">
                {ts.length === 0 && <li className="rounded-lg border border-dashed border-separator-strong px-3 py-6 text-center text-callout text-fg-tertiary">No tasks.</li>}
                {ts.map((t: any) => <TaskCard key={t.id} t={t} now={now} />)}
              </ul>
              {k === 'done' && total > 20 && !allDone && <button className="btn btn-link text-callout self-start" onClick={() => setAllDone(true)}>Show all</button>}
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
    <section aria-labelledby="set-h" className="h-full overflow-y-auto overscroll-contain bg-window">
      <div className="mx-auto max-w-[680px] px-6 py-8 max-sm:px-4 flex flex-col gap-8">
      <h2 id="set-h" className="text-title">Settings</h2>
      <div>
      <h3 className="text-headline px-1 mb-2">Budgets &amp; caps</h3>
      <div className="group-list">
        {fields.map(([k, l, hint]) => (
          <div key={k} className="group-row max-sm:flex-col max-sm:items-stretch max-sm:gap-1.5">
            <div className="flex-1 min-w-0"><label htmlFor={`f-${k}`} className="field-label">{l}</label>
              {invalid.some(([x]) => x === k) && <span role="alert" className="field-error">{k === 'max_concurrency' ? 'Must be 1–4' : 'Must be > 0'}</span>}</div>
            <input id={`f-${k}`} ref={(el) => { refs.current[k] = el; }} className="input input-num order-3" inputMode="decimal" value={vals[k] ?? ''}
              aria-invalid={invalid.some(([x]) => x === k)} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
            <span className="order-2 w-36 max-sm:w-auto text-right max-sm:text-left text-callout text-fg-tertiary tabular-nums">{hint}</span>
          </div>))}
      </div>
      <div className="mt-3 flex justify-end gap-2"><button className="btn btn-primary" disabled={invalid.length > 0 || changes.length === 0} onClick={() => setConfirm(true)}>Save</button></div>
      </div>
      {confirm && <Dialog title="Save changes?" onClose={() => setConfirm(false)}>
        <ul className="mt-3 divide-y divide-separator text-body">{changes.map(([k, l]) => <li key={k} className="py-1.5">{l}: <span className="text-fg-tertiary line-through">{k === 'day_usd' ? usd((cur as any)[k]) : (cur as any)[k]}</span> → <span className="font-medium">{k === 'day_usd' ? usd(parsed[k]) + ' est.' : parsed[k]}</span></li>)}</ul>
        <DialogFooter><button className="btn btn-secondary" onClick={() => setConfirm(false)}>Cancel</button>
          <ActionButton label="Save" kind="primary" pending="Saving…" run={async () => {
            await api('/api/budgets', { method: 'PUT', body: Object.fromEntries(changes.map(([k]) => [k, parsed[k]])) }); await refresh(); setConfirm(false); toast('Settings saved'); }} /></DialogFooter>
      </Dialog>}
      <AgentsSettings />
      <div>
      <h3 className="text-headline px-1 mb-2">Doctor</h3>
      <div className="group-list">
        <div className="group-row flex-wrap">
          <div className="flex-1 min-w-0 text-body flex items-center gap-2 flex-wrap">
            {dr ? <span className="inline-flex items-center gap-1.5 flex-wrap">{dr.ok ? <span className="inline-flex items-center gap-1.5 text-status-done"><Icon as={CircleCheck} /> all required checks passed</span> : <span className="inline-flex items-center gap-1.5 text-danger"><Icon as={CircleX} /> failed</span>}
              <span className="text-caption text-fg-tertiary">Last run <Time t={dr.at} now={boot.now} />{boot.system.claude_version ? ` · claude ${boot.system.claude_version}` : ''}</span></span> : <span>Not run yet</span>}
          </div>
          <ActionButton small label="Re-run" pending="Running…" run={async () => { await api('/api/doctor', { body: {} }); toast('Checks started; results appear here'); }} />
          {dr && <button className="btn btn-ghost btn-sm" onClick={() => setReport((r) => !r)}>{report ? 'Hide report' : 'Show report'}</button>}
        </div>
        {report && dr && <div className="px-4 py-3"><ul className="font-mono text-mono bg-sunken rounded-md p-3 space-y-0.5">{dr.checks.map((c: any) => (
          <li key={c.id} className="flex items-start gap-2"><span className="mt-0.5"><Icon as={c.ok ? CircleCheck : c.level === 'fail' ? CircleX : TriangleAlert} size={14} className={c.ok ? 'text-status-done' : c.level === 'fail' ? 'text-danger' : 'text-status-warn'} /></span><span>{c.id}: {c.ok ? 'ok' : c.level} — {c.detail}</span></li>))}</ul></div>}
      </div>
      </div>
      </div>
    </section>
  );
}
