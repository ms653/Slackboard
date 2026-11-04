'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { api, ApiError } from './api';
import { ChevronRight, CircleX, Plus } from 'lucide-react';
import { ActionButton, Dialog, DialogFooter, Icon, hhmm, usd } from './ui';

const MIN_MSG = 'At least $1.00: one work run reserves $1.00';

/** Settings → Agents (PHASE2 §B6): workers, per-agent budget, add / retire / enable, deep links, zero-enabled confirm. */
export function AgentsSettings() {
  const { boot, refresh, toast, open, settingsAgentFocus, set } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [bud, setBud] = useState({ usd: '', jobs: '' });
  const [dlg, setDlg] = useState<React.ReactNode>(null);
  const [add, setAdd] = useState({ name: '', skill: '', usd: '2.00', jobs: '10' });
  const [addErr, setAddErr] = useState<string | null>(null);
  const [retireErr, setRetireErr] = useState<Record<string, any>>({});
  const [showRetired, setShowRetired] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const agents: any[] = boot?.agents ?? [];
  const live = agents.filter((a) => !a.retired_at), workers = live.filter((a) => a.role === 'worker'), retired = agents.filter((a) => a.retired_at);

  useEffect(() => {                                           // deep link from the agents list / task detail
    const f = settingsAgentFocus;
    if (!f || !boot) return;
    set({ settingsAgentFocus: null });
    if (f.agent === '+add') { setTimeout(() => root.current?.querySelector<HTMLElement>('#add-name')?.focus(), 60); return; }
    const a = agents.find((x) => x.id === f.agent);
    if (f.field === 'usd' && a) { setEditing(a.id); setBud({ usd: String(a.budget?.limit_usd ?? 2), jobs: String(a.budget?.limit_jobs ?? 10) }); }
    setTimeout(() => {
      const sel = f.field === 'usd' ? `#agent-${f.agent}-usd` : f.field === 'enabled' ? `#agent-${f.agent}-enabled` : `#agent-row-${f.agent}`;
      const el = root.current?.querySelector<HTMLElement>(sel);
      el?.scrollIntoView?.({ block: 'center' }); el?.focus();
    }, 80);
  }, [settingsAgentFocus, boot]);                             // eslint-disable-line react-hooks/exhaustive-deps

  if (!boot) return null;
  const enabledWorkers = workers.filter((a) => a.enabled);
  const setEnabled = async (a: any, v: boolean) => {
    try { await api(`/api/agents/${a.id}`, { method: 'PUT', body: { enabled: v } }); await refresh(); if (!v) toast('Queued jobs wait until re-enabled'); }
    catch (err: any) { toast(`Couldn't update: ${err.hint || err.code}`, 'error'); }
  };
  const toggle = (a: any, v: boolean) => {
    if (!v && a.role === 'worker' && enabledWorkers.length === 1 && enabledWorkers[0].id === a.id)
      setDlg(<Dialog title="No worker will be enabled" onClose={() => setDlg(null)}>
        <p className="text-body text-fg-secondary">No worker will be enabled. New tasks can&apos;t be created and queued work waits until you enable one.</p>
        <DialogFooter><button className="btn btn-secondary" data-autofocus onClick={() => setDlg(null)}>Keep enabled</button>
          <ActionButton label="Disable" kind="danger" run={async () => { await setEnabled(a, false); setDlg(null); }} /></DialogFooter></Dialog>);
    else setEnabled(a, v);
  };
  const budgetErr = (u: string) => (u !== '' && Number(u) < 1 ? MIN_MSG : null);
  const saveBudget = (a: any) => setDlg(<Dialog title="Save changes?" onClose={() => setDlg(null)}>
    <p className="text-body text-fg-secondary">{a.id}: {a.budget ? `${usd(a.budget.limit_usd)} / ${a.budget.limit_jobs} runs` : 'no own budget'} → {usd(Number(bud.usd))} est. / {bud.jobs} runs per day</p>
    <DialogFooter><button className="btn btn-secondary" onClick={() => setDlg(null)}>Cancel</button>
      <ActionButton label="Save" kind="primary" pending="Saving…" onError={(e) => { setDlg(null); toast(`Couldn't save: ${e.hint || e.code}`, 'error'); return true; }} run={async () => {
        await api('/api/budgets', { method: 'PUT', body: { agents: { [a.id]: { day_usd: Number(bud.usd), day_jobs: Number(bud.jobs) } } } });
        await refresh(); setDlg(null); setEditing(null); toast('Settings saved'); }} /></DialogFooter></Dialog>);
  const retire = (a: any) => setDlg(<Dialog title={`Retire ${a.id}?`} onClose={() => setDlg(null)}>
    <p className="text-body text-fg-secondary">Retire {a.id}? This is permanent; the name can&apos;t be reused.</p>
    <DialogFooter><button className="btn btn-secondary" data-autofocus onClick={() => setDlg(null)}>Keep</button>
      <ActionButton label="Retire" kind="danger" pending="Retiring…" onError={(e: ApiError) => { setRetireErr((m) => ({ ...m, [a.id]: e })); setDlg(null); return true; }}
        run={async () => { await api(`/api/agents/${a.id}`, { method: 'PUT', body: { retire: true } }); setRetireErr((m) => ({ ...m, [a.id]: null })); await refresh(); setDlg(null); toast(`${a.id} retired`); }} /></DialogFooter></Dialog>);
  const retireMsg = (a: any, e: ApiError | null) => {
    if (!e) return null;
    if (e.code === 'agent_has_open_tasks') return <div role="alert" className="field-error px-4 pb-2.5 mt-0">Finish or cancel these first:
      <ul>{(e.data.tasks ?? []).map((t: any) => <li key={t.id}><button className="btn btn-link text-callout inline" onClick={() => open({ kind: 'task', id: t.id })}>T-{t.id}</button>{' '}
        ({t.actions.includes('re-propose') ? 'cancel, then ask the director to re-propose' : t.actions.includes('reassign') ? 'reassign or cancel' : 'finish or cancel'})</li>)}</ul></div>;
    if (e.code === 'agent_busy') return <div role="alert" className="field-error px-4 pb-2.5 mt-0">{a.id} is running; cancel its run or wait</div>;
    if (e.code === 'last_worker') return <div role="alert" className="field-error px-4 pb-2.5 mt-0">Keep at least one worker</div>;
    return <div role="alert" className="field-error px-4 pb-2.5 mt-0">Couldn&apos;t retire: {e.hint || e.code}</div>;
  };
  const budgetText = (a: any) => a.budget ? `${usd(a.budget.spent)}/${usd(a.budget.limit_usd)} est. · ${a.budget.started}/${a.budget.limit_jobs} runs` : 'no own budget (global only)';
  const worker = (a: any) => (
    <li key={a.id}>
      <div className="px-4 py-2.5">
      <div className="flex items-center gap-3 flex-wrap">
        <span id={`agent-row-${a.id}`} tabIndex={-1} className="text-body font-semibold">{a.display_name}</span>
        <span className="pill bg-fill-strong text-fg-secondary font-normal">{a.model}</span>
        <span className="text-callout text-fg-secondary tabular-nums">{budgetText(a)}</span>
        <span className="ml-auto flex items-center gap-3 flex-wrap">
        <label className="inline-flex items-center gap-2 text-body"><input id={`agent-${a.id}-enabled`} type="checkbox" className="checkbox" checked={!!a.enabled} onChange={(e) => toggle(a, e.target.checked)} /> Enabled</label>
        <button className="btn btn-secondary btn-sm" onClick={() => { setEditing(editing === a.id ? null : a.id); setBud({ usd: String(a.budget?.limit_usd ?? 2), jobs: String(a.budget?.limit_jobs ?? 10) }); }}>{a.budget ? 'Edit budget' : 'Set budget'}</button>
        <button className="btn btn-ghost btn-sm text-danger hover:bg-tint-danger hover:text-danger" onClick={() => retire(a)}>Retire</button>
        </span>
      </div>
      {a.skill_note && <div className="mt-1 text-caption text-fg-tertiary truncate" title={a.skill_note}>Skill: {a.skill_note} · added {hhmm(a.created_at)} {a.spawn_approval_id ? `via approval #${a.spawn_approval_id}` : 'in Settings'}</div>}
      {editing === a.id && (
        <div className="grid grid-cols-2 gap-3 pt-3 items-start">
          <div><label htmlFor={`agent-${a.id}-usd`} className="field-label block mb-1">$/day (est.)</label>
            <input id={`agent-${a.id}-usd`} className="input input-num w-full" inputMode="decimal" value={bud.usd} aria-invalid={!!budgetErr(bud.usd)} aria-describedby={`agent-${a.id}-usd-err`} onChange={(e) => setBud({ ...bud, usd: e.target.value })} />
            <div id={`agent-${a.id}-usd-err`} role="alert" className="field-error">{budgetErr(bud.usd)}</div></div>
          <div><label htmlFor={`agent-${a.id}-jobs`} className="field-label block mb-1">Runs/day</label>
            <input id={`agent-${a.id}-jobs`} className="input input-num w-full" inputMode="numeric" value={bud.jobs} onChange={(e) => setBud({ ...bud, jobs: e.target.value })} /></div>
          <div className="col-span-2 flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!!budgetErr(bud.usd) || !(Number(bud.usd) <= 3) || !Number.isInteger(Number(bud.jobs)) || Number(bud.jobs) < 1 || Number(bud.jobs) > 20} onClick={() => saveBudget(a)}>Save</button>
          </div>
        </div>)}
      </div>
      {retireMsg(a, retireErr[a.id])}
    </li>);
  const atCap = workers.length >= 3;
  const addErrText = budgetErr(add.usd);
  const canAdd = !atCap && /^[a-z][a-z0-9_]{1,23}$/.test(add.name) && add.skill.trim().length >= 1 && add.skill.length <= 500 && !addErrText && Number(add.usd) <= 3 && Number.isInteger(Number(add.jobs)) && Number(add.jobs) >= 1 && Number(add.jobs) <= 20;
  return (
    <div ref={root}>
      <h3 className="text-headline px-1 mb-2">Agents ({1} director · {workers.length}/3 workers)</h3>
      <ul className="group-list">
        {live.filter((a) => a.role !== 'worker').map((a) => (
          <li key={a.id} className="group-row">
            <span className="text-body font-semibold">{a.display_name}</span><span className="pill bg-fill-strong text-fg-secondary font-normal">{a.model}</span>
            <label className="ml-auto inline-flex items-center gap-2 text-body"><input id={`agent-${a.id}-enabled`} type="checkbox" className="checkbox" checked={!!a.enabled} onChange={(e) => toggle(a, e.target.checked)} /> Enabled</label>
          </li>))}
        {workers.map(worker)}
      </ul>
      <form className="mt-4 group-list" onSubmit={(e) => e.preventDefault()} aria-labelledby="add-h">
        <div className="px-4 py-2.5">
        <h4 id="add-h" className="text-body font-semibold text-accent flex items-center gap-1.5"><Icon as={Plus} /> Add worker</h4>
        <p className="mt-1 text-caption text-fg-tertiary">No approval needed: you are acting. {atCap && <span role="status" className="text-status-warn">Worker limit reached (3)</span>}</p>
        </div>
        <div className="px-4 py-3 flex gap-3 flex-wrap items-start">
          <div><label htmlFor="add-name" className="field-label block mb-1">Name</label><input id="add-name" className="input w-36" value={add.name} disabled={atCap} onChange={(e) => setAdd({ ...add, name: e.target.value })} aria-describedby="add-name-hint" />
            <div id="add-name-hint" className="field-hint">a–z, 0–9, _ (2–24)</div></div>
          <div className="flex-1 min-w-[12rem]"><label htmlFor="add-skill" className="field-label block mb-1">Skill note</label><input id="add-skill" className="input" maxLength={500} value={add.skill} disabled={atCap} onChange={(e) => setAdd({ ...add, skill: e.target.value })} /></div>
          <div><label htmlFor="add-usd" className="field-label block mb-1">$/day</label><input id="add-usd" className="input input-num w-20" inputMode="decimal" value={add.usd} disabled={atCap} aria-invalid={!!addErrText} onChange={(e) => setAdd({ ...add, usd: e.target.value })} /></div>
          <div><label htmlFor="add-jobs" className="field-label block mb-1">Runs/day</label><input id="add-jobs" className="input input-num w-20" inputMode="numeric" value={add.jobs} disabled={atCap} onChange={(e) => setAdd({ ...add, jobs: e.target.value })} /></div>
        </div>
        {(addErrText || addErr) && <div className="px-4 pb-2">
          {addErrText && <div role="alert" className="field-error"><Icon as={CircleX} size={14} />{addErrText}</div>}
          {addErr && <div role="alert" className="field-error"><Icon as={CircleX} size={14} />{addErr}</div>}</div>}
        <div className="px-4 py-3 flex justify-end">
        <ActionButton label="Add worker" kind="primary" pending="Adding…" disabled={!canAdd} onError={(e) => { setAddErr(e.code === 'name_taken' ? 'Name already used.' : e.code === 'allowance_below_job_cap' ? MIN_MSG : `Couldn't add worker: ${e.hint || e.code}`); return true; }}
          run={async () => { setAddErr(null); await api('/api/agents', { body: { name: add.name, skill_note: add.skill.trim(), daily_usd: Number(add.usd), daily_jobs: Number(add.jobs) } });
            setAdd({ name: '', skill: '', usd: '2.00', jobs: '10' }); await refresh(); toast(`${add.name} added`); }} />
        </div>
      </form>
      {retired.length > 0 && <div className="mt-3">
        <button aria-expanded={showRetired} className="inline-flex items-center gap-1.5 px-1 text-body text-fg-secondary hover:text-fg-primary text-left" onClick={() => setShowRetired((v) => !v)}><Icon as={ChevronRight} size={14} className={`transition-transform duration-fast ${showRetired ? 'rotate-90' : ''}`} /> Retired ({retired.length}){!showRetired && `: ${retired.map((a) => `${a.id} (retired ${hhmm(a.retired_at)})`).join(', ')}`}</button>
        {showRetired && <ul className="mt-1 px-6 text-callout text-fg-tertiary">{retired.map((a) => <li key={a.id}>{a.id} · retired {hhmm(a.retired_at)}</li>)}</ul>}
      </div>}
      {dlg}
    </div>
  );
}
