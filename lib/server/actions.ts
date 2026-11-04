import fs from 'node:fs';
import { db as getDb, tx } from '../db';
import { now, DomainError } from '../util';
import { emit } from '../domain/events';
import { getTask } from '../domain/rounds';
import { workspaceFacts } from '../domain/git';
import { createTask, decideApproval, cancelTask, reopenTask, acceptTask, unblockTask, reassignTask, rerouteHelp } from '../domain/tasks';
import { createWorkerByUser, setEnabled, retireAgent, setAgentBudget, setMaxConcurrency, ensureAgentDir } from '../domain/agents';
import { closeThread, reopenThread, raiseCap, createThread } from '../domain/threads';
import { postUserMessage, wakePreview } from '../domain/wake';
import { cancelQueued, refreshAllPresence, refreshPresence } from '../domain/jobs';
import { control, engageKill, resume as resumeKill } from '../domain/control';
import { paths } from '../paths';
import { helpEnded } from '../domain/finish';
import { addUserComment } from '../domain/comments';

/** User actions behind the API routes. Git facts are read before the write txn (TECH §3.1, §5.9). */
const db = () => getDb();
const wake = () => { control(db(), 'wake', {}, 500).catch(() => {}); };
const facts = (threadOrTask: { taskId?: number | null }) => threadOrTask.taskId ? workspaceFacts(threadOrTask.taskId) : undefined;

export function sendMessage(threadId: number | null, body: string) {
  if (!body.trim()) throw new DomainError('validation_error', 'message is empty', 400);
  const d = db();
  let tid = threadId;
  if (!tid) tid = tx(d, () => createThread(d, body.trim().split('\n')[0].slice(0, 120), { kind: 'user' }));
  const task = d.prepare(`SELECT id FROM tasks WHERE thread_id=?`).get(tid) as { id: number } | undefined;
  const ws = facts({ taskId: task?.id });
  const r = tx(d, () => postUserMessage(d, tid!, body.slice(0, 8000), ws));
  wake();
  return { thread_id: tid, ...r };
}

export function preview(threadId: number) {
  const d = db();
  const task = d.prepare(`SELECT id FROM tasks WHERE thread_id=?`).get(threadId) as { id: number } | undefined;
  return wakePreview(d, threadId, facts({ taskId: task?.id }));
}

export function newTask(o: { title: string; description?: string; acceptance?: string; assignee?: string }) {
  if (!o.title?.trim()) throw new DomainError('validation_error', 'title is required', 400);
  const d = db();
  const r = tx(d, () => createTask(d, { title: o.title.trim().slice(0, 200), description: o.description ?? '', acceptance: o.acceptance ?? '',
    assignee: o.assignee, by: { kind: 'user' } }));
  wake(); return r;
}

export function taskAction(id: number, action: string, note?: string, assignee?: string) {
  const d = db();
  const t0 = getTask(d, id); if (!t0) throw new DomainError('not_found', 'no such task', 404);
  const ws = action === 'unblock' ? workspaceFacts(id) : undefined;
  const r = tx(d, () => {
    const t = getTask(d, id)!;
    switch (action) {
      case 'cancel': cancelTask(d, t, 'user'); return {};
      case 'reopen': reopenTask(d, t, note ?? ''); return {};
      case 'accept': acceptTask(d, t); return {};
      case 'reassign':
        if (typeof assignee !== 'string') throw new DomainError('validation_error', 'assignee is required', 400);
        reassignTask(d, t, assignee); return {};
      case 'reroute_help': rerouteHelp(d, t, 'user'); return {};
      case 'unblock': return { target: unblockTask(d, t, 'user', 'retry', ws!, note) };
      default: throw new DomainError('validation_error', `unknown action ${action}`, 400);
    }
  });
  wake(); return { ...r, task: getTask(d, id) };
}

export function unblockKilled() {
  const d = db();
  if ((d.prepare(`SELECT kill_switch FROM system_state WHERE id=1`).get() as any).kill_switch) throw new DomainError('kill_engaged', 'resume agents first');
  const ids = (d.prepare(`SELECT id FROM tasks WHERE status='blocked' AND blocked_reason='killed'`).all() as { id: number }[]).map((r) => r.id);
  const ws = new Map(ids.map((i) => [i, workspaceFacts(i)]));
  const out = tx(d, () => ids.map((i) => { const t = getTask(d, i)!; return t.status === 'blocked' ? { id: i, ...unblockTask(d, t, 'user', 'retry', ws.get(i)!) } : null; }).filter(Boolean));
  wake(); return { results: out };
}

export function jobAction(id: number, action: 'cancel' | 'retry_now') {
  const d = db();
  const r = tx(d, () => {
    const j = d.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as any;
    if (!j) throw new DomainError('not_found', '', 404);
    if (action === 'retry_now') {
      if (j.status !== 'queued' || j.attempts === 0) throw new DomainError('not_retrying', 'only a queued retry can run now');
      d.prepare(`UPDATE jobs SET run_after=? WHERE id=?`).run(now(), id); return { status: 'queued' };
    }
    if (j.status === 'queued') {
      cancelQueued(d, 'id = ?', [id], 'cancelled', 'user');
      if (j.kind === 'help') helpEnded(d, { ...j, status: 'cancelled' });
      return { status: 'cancelled' };
    }
    if (j.status === 'running') { d.prepare(`UPDATE jobs SET cancel_requested=1 WHERE id=?`).run(id); return { status: 'running', cancel_requested: true }; }
    throw new DomainError('illegal_transition', `job is ${j.status}`);
  });
  if (action === 'cancel') control(d, 'cancel', { job_id: id }).catch(() => {});
  wake(); return r;
}

export function jobLog(id: number) {
  const d = db();
  const j = d.prepare(`SELECT id, kind, agent_id, status, failure_kind, error, exit_code FROM jobs WHERE id=?`).get(id) as any;
  if (!j) throw new DomainError('not_found', '', 404);
  let lines: string[] = [];
  try { lines = fs.readFileSync(`${paths.runDir(id)}/stdout.jsonl`, 'utf8').trim().split('\n').slice(-200); } catch {}
  return { ...j, lines };
}

export function decide(id: number, decision: 'approved' | 'rejected', note?: string, raiseTo?: number) {
  const d = db();
  const r = tx(d, () => decideApproval(d, id, decision, note, { raise_concurrency_to: raiseTo })); wake(); return r;
}

export function threadAction(id: number, action: 'close' | 'reopen' | 'raise_cap') {
  const d = db();
  const r = tx(d, () => action === 'close' ? (closeThread(d, id, 'user'), { status: 'closed', resumed: null })
    : action === 'reopen' ? reopenThread(d, id, 'user') : raiseCap(d, id, 'user'));
  wake(); return r;
}

export async function kill() { return engageKill(db()); }
export function resume() { resumeKill(db()); wake(); return {}; }
export function pause(action: 'resume' | 'hold') {
  const d = db();
  tx(d, () => {
    if (action === 'resume') d.prepare(`UPDATE system_state SET paused_until=NULL, pause_reason=NULL WHERE id=1`).run();
    else d.prepare(`UPDATE system_state SET paused_until=NULL, pause_reason='user' WHERE id=1`).run();
    emit(d, 'settings.changed', 'user', 'system', 1, { pause: action });
    refreshAllPresence(d);
  });
  wake(); return {};
}

export function setBudgets(b: { day_usd?: number; day_jobs?: number; jobs_5h?: number; max_concurrency?: number; agents?: Record<string, { day_usd?: unknown; day_jobs?: unknown }> }) {
  const d = db();
  const bad = (v: unknown) => v !== undefined && !(typeof v === 'number' && v > 0);
  if (bad(b.day_usd) || bad(b.day_jobs) || bad(b.jobs_5h)) throw new DomainError('validation_error', 'values must be > 0', 400);
  if (b.max_concurrency !== undefined && !(Number.isInteger(b.max_concurrency) && b.max_concurrency >= 1 && b.max_concurrency <= 4))
    throw new DomainError('validation_error', 'max concurrency must be 1-4', 400);
  tx(d, () => {
    const old = budgetsView();
    if (b.day_usd !== undefined || b.day_jobs !== undefined)
      d.prepare(`UPDATE budgets SET limit_usd=coalesce(?,limit_usd), limit_jobs=coalesce(?,limit_jobs), updated_at=? WHERE scope='global' AND period='day'`).run(b.day_usd ?? null, b.day_jobs ?? null, now());
    if (b.jobs_5h !== undefined) d.prepare(`UPDATE budgets SET limit_jobs=?, updated_at=? WHERE scope='global' AND period='rolling_5h'`).run(b.jobs_5h, now());
    if (b.max_concurrency !== undefined) d.prepare(`UPDATE system_state SET max_concurrency=? WHERE id=1`).run(b.max_concurrency);
    for (const [aid, v] of Object.entries(b.agents ?? {})) setAgentBudget(d, aid, v?.day_usd, v?.day_jobs);       // PHASE2 §T5.5: validates 1.00-3.00 / 1-20
    emit(d, 'settings.changed', 'user', 'budget', null, { old, new: budgetsView() });
    refreshAllPresence(d);
  });
  wake(); return budgetsView();
}
export function budgetsView() {
  const d = db();
  const day = d.prepare(`SELECT limit_usd, limit_jobs FROM budgets WHERE scope='global' AND period='day'`).get() as any;
  const h5 = d.prepare(`SELECT limit_jobs FROM budgets WHERE scope='global' AND period='rolling_5h'`).get() as any;
  const s = d.prepare(`SELECT max_concurrency FROM system_state WHERE id=1`).get() as any;
  return { day_usd: day.limit_usd, day_jobs: day.limit_jobs, jobs_5h: h5.limit_jobs, max_concurrency: s.max_concurrency };
}
export function setAgent(id: string, enabled: boolean) {
  const d = db();
  tx(d, () => setEnabled(d, id, enabled));
  wake(); return {};
}
export function retire(id: string) {
  const d = db();
  tx(d, () => retireAgent(d, id));
  wake(); return {};
}
export function addAgent(b: { name?: unknown; skill_note?: unknown; daily_usd?: unknown; daily_jobs?: unknown }) {
  const d = db();
  const name = tx(d, () => createWorkerByUser(d, b));
  ensureAgentDir(name);
  wake(); return { agent_id: name };
}
export async function doctor() {
  const r = await control(db(), 'doctor', {}, 2000);
  if (!r) throw new DomainError('orchestrator_down', 'start the orchestrator to run checks', 503);
  return { started: true };
}

/** POST /api/artifacts/:id/comments: a user's inline comment (PHASE2 §T5.5). One IMMEDIATE txn; wakes nobody. */
export function postComment(artifactId: number, input: any) {
  return tx(db(), () => addUserComment(db(), artifactId, input));
}
