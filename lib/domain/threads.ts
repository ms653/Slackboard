import type { DB } from '../db';
import { now, DomainError } from '../util';
import { emit } from './events';
import { cancelQueued, enqueueJob, PRIORITY } from './jobs';

export interface ThreadRow {
  id: number; channel_id: number; title: string; status: 'open' | 'capped' | 'closed'; agent_msg_count: number;
  max_agent_msgs: number; agent_job_count: number; max_agent_jobs: number; cap_raises: number;
  created_by_kind: string; created_by_agent_id: string | null; created_at: number; closed_at: number | null;
}
export const getThread = (db: DB, id: number) => db.prepare(`SELECT * FROM threads WHERE id=?`).get(id) as ThreadRow | undefined;
export function generalChannel(db: DB): number {
  return (db.prepare(`SELECT id FROM channels WHERE name='general'`).get() as { id: number }).id;
}
export function createThread(db: DB, title: string, by: { kind: 'user' | 'agent' | 'system'; agent?: string }): number {
  const r = db.prepare(`INSERT INTO threads(channel_id, title, created_by_kind, created_by_agent_id, created_at) VALUES (?,?,?,?,?)`)
    .run(generalChannel(db), title.slice(0, 200), by.kind, by.kind === 'agent' ? by.agent : null, now());
  const id = Number(r.lastInsertRowid);
  emit(db, 'thread.status_changed', by.kind === 'agent' ? by.agent! : by.kind, 'thread', id, { from: null, to: 'open', title });
  return id;
}
function setStatus(db: DB, th: ThreadRow, to: ThreadRow['status'], actor: string): void {
  if (th.status === to) return;
  db.prepare(`UPDATE threads SET status=?, closed_at=? WHERE id=?`).run(to, to === 'closed' ? now() : null, th.id);
  emit(db, 'thread.status_changed', actor, 'thread', th.id, { from: th.status, to });
}
const atCap = (th: ThreadRow) => th.agent_msg_count >= th.max_agent_msgs || th.agent_job_count >= th.max_agent_jobs;

/** Thread resume rule (TECH §3.3): task todo -> work; in_review -> review; else nothing. */
export function resumeThread(db: DB, threadId: number, actor: string): { task_id: number; kind: string } | null {
  const t = db.prepare(`SELECT id, status, assignee_agent_id FROM tasks WHERE thread_id=?`).get(threadId) as any;
  if (!t) return null;
  if (t.status === 'todo') { enqueueJob(db, { agent: t.assignee_agent_id, kind: 'work', thread: threadId, task: t.id, actor }); return { task_id: t.id, kind: 'work' }; }
  if (t.status === 'in_review') { enqueueJob(db, { agent: 'director', kind: 'review', thread: threadId, task: t.id, priority: PRIORITY.review, actor }); return { task_id: t.id, kind: 'review' }; }
  return null;
}

export function closeThread(db: DB, threadId: number, actor: string): void {
  const th = getThread(db, threadId); if (!th) throw new DomainError('not_found', '', 404);
  if (th.status === 'closed') return;
  setStatus(db, th, 'closed', actor);
  cancelQueued(db, 'thread_id = ?', [threadId], 'cancelled', actor);
}

/** User reopen (or T18): open, or capped if a count is at its cap. */
export function reopenThread(db: DB, threadId: number, actor: string, runResume = true) {
  const th = getThread(db, threadId); if (!th) throw new DomainError('not_found', '', 404);
  if (th.status !== 'closed') throw new DomainError('illegal_transition', 'thread is not closed');
  const to = atCap(th) ? 'capped' : 'open';
  setStatus(db, th, to, actor);
  return { status: to, resumed: to === 'open' && runResume ? resumeThread(db, threadId, actor) : null };
}

export function raiseCap(db: DB, threadId: number, actor: string) {
  const th = getThread(db, threadId); if (!th) throw new DomainError('not_found', '', 404);
  if (th.status !== 'capped') throw new DomainError('illegal_transition', 'thread is not capped');
  if (th.cap_raises >= 1) throw new DomainError('cap_already_raised', 'cap already raised once; cancel the task or close the thread');
  db.prepare(`UPDATE threads SET max_agent_msgs = max_agent_msgs + 10, max_agent_jobs = max_agent_jobs + 4, cap_raises = 1 WHERE id=?`).run(threadId);
  const fresh = getThread(db, threadId)!;
  const to = atCap(fresh) ? 'capped' : 'open';
  setStatus(db, fresh, to, actor);
  return { status: to, resumed: to === 'open' ? resumeThread(db, threadId, actor) : null };
}

/** J3: job cap hit -> thread capped, queued jobs cancelled. */
export function capThreadForJobs(db: DB, threadId: number): void {
  const th = getThread(db, threadId)!;
  if (th.status === 'open') setStatus(db, th, 'capped', 'system');
  cancelQueued(db, 'thread_id = ?', [threadId], 'thread_capped');
}
