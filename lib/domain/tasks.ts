import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db';
import { now, sha256, canonicalJSON, DomainError } from '../util';
import { paths, ensureDir } from '../paths';
import { emit } from './events';
import { enqueueJob, cancelQueued, refreshPresence, PRIORITY } from './jobs';
import { insertMessage, systemMessage } from './messages';
import { createThread, closeThread, reopenThread } from './threads';
import { getTask, currentArtifact, resumeTarget, type TaskRow } from './rounds';
import { ensureWorkspace, type WorkspaceFacts, type Capture } from './git';

/** Update status with bookkeeping; the DB triggers are the backstop (tasks_legal_transition etc). */
export function setStatus(db: DB, t: TaskRow, to: string, actor: string, extra: Record<string, unknown> = {}): void {
  const fields: Record<string, unknown> = { status: to, updated_by: actor, updated_at: now(), ...extra };
  if (to !== 'blocked' && !('blocked_reason' in extra)) fields.blocked_reason = null;
  if (to !== 'in_progress') { fields.claimed_by = null; fields.claim_expires_at = null; }
  const keys = Object.keys(fields);
  db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, version = version + 1 WHERE id = @__id`)
    .run({ ...fields, __id: t.id });
}

export function taskPayloadHash(t: { title: string; description: string; acceptance: string; assignee_agent_id: string | null }): string {
  return sha256(canonicalJSON({ title: t.title, description: t.description, acceptance: t.acceptance, assignee: t.assignee_agent_id }));
}

function initWorkspace(db: DB, taskId: number): void {
  const base = ensureWorkspace(taskId);
  db.prepare(`UPDATE tasks SET base_commit = ? WHERE id = ? AND base_commit IS NULL`).run(base, taskId);
}

/** T1 (user), T2 (agent, top-level -> proposed + approval), T3 (agent subtask). */
export function createTask(db: DB, o: { title: string; description?: string; acceptance?: string; assignee?: string;
  parentId?: number | null; by: { kind: 'user' } | { kind: 'agent'; agent: string; jobId?: number }; why?: string }) {
  const parent = o.parentId ? getTask(db, o.parentId) : undefined;
  if (o.parentId && !parent) throw new DomainError('validation_error', 'parent task does not exist');
  if (parent && ['proposed', 'done', 'cancelled'].includes(parent.status)) throw new DomainError('illegal_transition', 'parent is not active');
  if (parent && parent.parent_id) throw new DomainError('validation_error', 'max task depth is 1');
  const assignee = o.assignee ?? 'worker';
  const isAgent = o.by.kind === 'agent';
  const status = isAgent && !o.parentId ? 'proposed' : 'todo';
  const actor = isAgent ? (o.by as any).agent : 'user';
  const t = now();
  const placeholder = createThread(db, o.title, isAgent ? { kind: 'agent', agent: actor } : { kind: 'user' });
  const pos = (db.prepare(`SELECT ifnull(max(position),0)+1 AS p FROM tasks WHERE status = ?`).get(status) as { p: number }).p;
  const r = db.prepare(`INSERT INTO tasks(title, description, acceptance, status, assignee_agent_id, parent_id, thread_id,
                          created_by_kind, created_by_agent_id, position, updated_by, created_at, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(o.title, o.description ?? '', o.acceptance ?? '', status, assignee, o.parentId ?? null, placeholder,
         isAgent ? 'agent' : 'user', isAgent ? actor : null, pos, actor, t, t);
  const id = Number(r.lastInsertRowid);
  db.prepare(`UPDATE threads SET title = ? WHERE id = ?`).run(`T-${id} ${o.title}`.slice(0, 200), placeholder);
  emit(db, 'task.created', actor, 'task', id, { status, parent_id: o.parentId ?? null, assignee });
  let approvalId: number | undefined;
  if (status === 'proposed') {
    const payload = { title: o.title, description: o.description ?? '', acceptance: o.acceptance ?? '', assignee };
    const ar = db.prepare(`INSERT INTO approvals(kind, requested_by_agent_id, job_id, thread_id, task_id, summary, payload, payload_hash, created_at, expires_at)
                           VALUES ('create_top_level_task',?,?,?,?,?,?,?,?,?)`)
      .run(actor, (o.by as any).jobId ?? null, placeholder, id, (o.why || `New task: ${o.title}`).slice(0, 500),
           JSON.stringify(payload), taskPayloadHash({ ...payload, assignee_agent_id: assignee }), t, t + 86_400_000);
    approvalId = Number(ar.lastInsertRowid);
    emit(db, 'approval.requested', actor, 'approval', approvalId, { kind: 'create_top_level_task', task_id: id });
    systemMessage(db, placeholder, `T-${id} proposed by ${actor}. Waiting for your approval.`);
  } else {
    initWorkspace(db, id);
    enqueueJob(db, { agent: assignee, kind: 'work', thread: placeholder, task: id, actor });
  }
  return { task_id: id, thread_id: placeholder, status, approval_id: approvalId };
}

/** The only writer of approval decisions (TECH §1.1). T4 / T5 for task approvals. */
export function decideApproval(db: DB, id: number, decision: 'approved' | 'rejected', note?: string) {
  const a = db.prepare(`SELECT * FROM approvals WHERE id=?`).get(id) as any;
  if (!a) throw new DomainError('not_found', '', 404);
  if (a.status !== 'pending') throw new DomainError('already_handled', `approval is ${a.status}`);
  const t = now();
  db.prepare(`UPDATE approvals SET status=?, decided_by='user', decided_at=?, decision_note=? WHERE id=?`).run(decision, t, note ?? null, id);
  emit(db, 'approval.decided', 'user', 'approval', id, { decision, kind: a.kind, task_id: a.task_id });
  if (a.kind === 'create_top_level_task') {
    const task = getTask(db, a.task_id)!;
    if (decision === 'approved') {
      if (taskPayloadHash(task) !== a.payload_hash) throw new DomainError('payload_mismatch', 'task differs from what was approved');
      setStatus(db, task, 'todo', 'user');                                   // T4
      initWorkspace(db, task.id);
      enqueueJob(db, { agent: task.assignee_agent_id!, kind: 'work', thread: task.thread_id, task: task.id, actor: 'user' });
      systemMessage(db, task.thread_id, `You approved T-${task.id}.`);
    } else {
      setStatus(db, task, 'cancelled', 'user');                              // T5
      systemMessage(db, task.thread_id, `You rejected T-${task.id}.${note ? ' Note: ' + note : ''}`);
      closeThread(db, task.thread_id, 'user');
    }
  } else {
    systemMessage(db, a.thread_id, `You ${decision} the ${a.kind.replace('_', ' ')} request.${decision === 'approved' ? ' Slackboard does not execute it: do it yourself.' : ''}`);
  }
}

/** Sweep: pending approvals past expires_at -> expired (system) -> T5. */
export function expireApprovals(db: DB): number {
  const rows = db.prepare(`SELECT * FROM approvals WHERE status='pending' AND expires_at < ?`).all(now()) as any[];
  for (const a of rows) {
    db.prepare(`UPDATE approvals SET status='expired', decided_by='system', decided_at=? WHERE id=?`).run(now(), a.id);
    emit(db, 'approval.decided', 'system', 'approval', a.id, { decision: 'expired', kind: a.kind });
    if (a.kind === 'create_top_level_task') {
      const task = getTask(db, a.task_id)!;
      if (task.status === 'proposed') { setStatus(db, task, 'cancelled', 'system'); closeThread(db, task.thread_id, 'system'); }
    }
  }
  return rows.length;
}

/** T8 DB half; git capture (cap) was done by the caller before the txn (TECH §5.10). */
export function applySubmitForReview(db: DB, t: TaskRow, actor: string, jobId: number, cap: Capture, note?: string) {
  const round = t.review_round + 1;
  const dir = ensureDir(paths.runDir(jobId));
  const diffPath = path.join(dir, `review-${t.review_cycle}-${round}.diff`);
  fs.writeFileSync(diffPath, cap.diff);
  setStatus(db, t, 'in_review', actor, { review_round: round });
  const ar = db.prepare(`INSERT INTO artifacts(task_id, review_cycle, review_round, base_commit, head_commit, diff_path, files, lines_added, lines_removed, created_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(t.id, t.review_cycle, round, t.base_commit, cap.head, diffPath, JSON.stringify(cap.files), cap.added, cap.removed, now());
  emit(db, 'artifact.captured', actor, 'task', t.id, { artifact_id: Number(ar.lastInsertRowid), round, files: cap.files.length }, jobId);
  if (note) addNote(db, t.id, actor, note);
  systemMessage(db, t.thread_id, `T-${t.id} submitted for review, round ${round} of 2 (${cap.files.length} files, +${cap.added} -${cap.removed}).`);
  enqueueJob(db, { agent: 'director', kind: 'review', thread: t.thread_id, task: t.id, priority: PRIORITY.review, actor });
  return round;
}

/** T13 (ws facts computed outside the txn). */
export function approveReview(db: DB, t: TaskRow, actor: string, ws: WorkspaceFacts, note?: string) {
  const a = currentArtifact(db, t);
  if (!a || a.verdict !== null) throw new DomainError('illegal_transition', 'no unreviewed artifact for this round');
  if (!ws.clean || ws.head !== a.head_commit) throw new DomainError('workspace_drift', 'workspace changed after capture; the review fails');
  db.prepare(`UPDATE artifacts SET verdict='approved', verdict_by=?, verdict_note=? WHERE id=?`).run(actor, note ?? null, a.id);
  setStatus(db, t, 'done', actor);
  systemMessage(db, t.thread_id, `T-${t.id} approved by ${actor} (round ${t.review_round}).`);
  if (t.parent_id) {
    const open = db.prepare(`SELECT count(*) AS n FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled')`).get(t.parent_id) as { n: number };
    const parent = getTask(db, t.parent_id)!;
    if (open.n === 0) systemMessage(db, parent.thread_id, `All subtasks of T-${parent.id} are done.`);
  }
}

/** T14 / T15. */
export function requestChanges(db: DB, t: TaskRow, actor: string, note: string, jobId: number | null) {
  const a = currentArtifact(db, t);
  if (!a || a.verdict !== null) throw new DomainError('illegal_transition', 'no unreviewed artifact for this round');
  db.prepare(`UPDATE artifacts SET verdict='changes_requested', verdict_by=?, verdict_note=? WHERE id=?`).run(actor, note, a.id);
  addNote(db, t.id, actor, note);
  insertMessage(db, { thread: t.thread_id, authorKind: 'agent', agent: actor, kind: 'review', body: `Changes requested (round ${t.review_round}):\n${note}`, jobId });
  if (t.review_round < 2) {
    setStatus(db, t, 'todo', actor);                                          // T14
    enqueueJob(db, { agent: t.assignee_agent_id!, kind: 'work', thread: t.thread_id, task: t.id, actor });
  } else {
    setStatus(db, t, 'blocked', actor, { blocked_reason: 'review_cap' });     // T15
  }
}

export function blockTask(db: DB, t: TaskRow, actor: string, note: string) {                    // T12
  setStatus(db, t, 'blocked', actor, { blocked_reason: 'agent_blocked' });
  addNote(db, t.id, actor, note);
  systemMessage(db, t.thread_id, `T-${t.id} blocked by ${actor}: ${note}`);
}

export function cancelTask(db: DB, t: TaskRow, actor: string) {                                  // T17
  if (['done', 'cancelled'].includes(t.status)) throw new DomainError('illegal_transition', `task is ${t.status}`);
  setStatus(db, t, 'cancelled', actor);
  cancelQueued(db, 'task_id = ?', [t.id], 'cancelled', actor);
  db.prepare(`UPDATE jobs SET cancel_requested = 1 WHERE task_id = ? AND status = 'running'`).run(t.id);
  if (t.status === 'proposed') {
    const ap = db.prepare(`SELECT id FROM approvals WHERE task_id=? AND status='pending'`).get(t.id) as { id: number } | undefined;
    if (ap) { db.prepare(`UPDATE approvals SET status='expired', decided_by='system', decided_at=? WHERE id=?`).run(now(), ap.id);
              emit(db, 'approval.decided', 'system', 'approval', ap.id, { decision: 'expired', reason: 'task_cancelled' }); }
  }
  closeThread(db, t.thread_id, actor);
}

export function reopenTask(db: DB, t: TaskRow, note: string) {                                    // T18
  if (t.status !== 'done') throw new DomainError('illegal_transition', 'only done tasks can be reopened');
  if (!note) throw new DomainError('validation_error', 'a note is required to reopen');
  setStatus(db, t, 'todo', 'user', { accepted_at: null, review_round: 0, review_cycle: t.review_cycle + 1 });
  addNote(db, t.id, null, note);
  const th = db.prepare(`SELECT status FROM threads WHERE id=?`).get(t.thread_id) as { status: string };
  if (th.status === 'closed') reopenThread(db, t.thread_id, 'user', false);
  enqueueJob(db, { agent: t.assignee_agent_id!, kind: 'work', thread: t.thread_id, task: t.id, actor: 'user' });
}

export function acceptTask(db: DB, t: TaskRow) {                                                  // T19
  if (t.status !== 'done' || t.parent_id) throw new DomainError('illegal_transition', 'only done top-level tasks can be accepted');
  if (t.accepted_at) return;
  db.prepare(`UPDATE tasks SET accepted_at=?, updated_by='user', updated_at=?, version=version+1 WHERE id=?`).run(now(), now(), t.id);
  emit(db, 'task.updated', 'user', 'task', t.id, { accepted: true });
  closeThread(db, t.thread_id, 'user');
}

/** T16 via resumeTarget. Director may trigger only for reason help; user for any. */
export function unblockTask(db: DB, t: TaskRow, actor: string, via: 'retry' | 'reply', ws: WorkspaceFacts, note?: string) {
  if (t.status !== 'blocked') throw new DomainError('illegal_transition', 'task is not blocked');
  if (actor !== 'user' && t.blocked_reason !== 'help') throw new DomainError('not_allowed_for_role', 'only the user can unblock this');
  if (t.blocked_reason === 'review_cap' && !note) throw new DomainError('validation_error', 'a note is required to send back');
  const rt = resumeTarget(db, t, via, ws);
  if (note) addNote(db, t.id, actor === 'user' ? null : actor, note);
  if (rt.kind === 'help' && rt.status === 'blocked') {                                             // case 0
    db.prepare(`UPDATE tasks SET blocked_reason='help', updated_by=?, updated_at=?, version=version+1 WHERE id=?`).run(actor, now(), t.id);
    emit(db, 'task.updated', actor, 'task', t.id, { blocked_reason: 'help' });
    enqueueJob(db, { agent: 'director', kind: 'help', thread: t.thread_id, task: t.id, priority: PRIORITY.help, actor });
    return rt;
  }
  const extra: Record<string, unknown> = {};
  if (t.blocked_reason === 'review_cap') { extra.review_round = 0; extra.review_cycle = t.review_cycle + 1; }
  if (rt.redo) {
    const a = currentArtifact(db, t)!;
    db.prepare(`UPDATE artifacts SET verdict='superseded', verdict_by=NULL WHERE id=?`).run(a.id);
    extra.review_round = t.review_round - 1;
  }
  setStatus(db, t, rt.status, actor, extra);
  enqueueJob(db, { agent: rt.agent, kind: rt.kind, thread: t.thread_id, task: t.id,
                   priority: rt.kind === 'review' ? PRIORITY.review : PRIORITY.work, actor });
  refreshPresence(db, t.assignee_agent_id ?? 'worker');
  return rt;
}

export function editTask(db: DB, t: TaskRow, actor: string, f: { title?: string; description?: string; acceptance?: string }) {
  if (!['todo', 'blocked'].includes(t.status)) throw new DomainError('illegal_transition', 'edit only in todo or blocked');
  if (t.parent_id === null && t.created_by_kind === 'agent') throw new DomainError('approved_task_immutable', 'create_task a new proposal');
  db.prepare(`UPDATE tasks SET title=coalesce(?,title), description=coalesce(?,description), acceptance=coalesce(?,acceptance),
              updated_by=?, updated_at=?, version=version+1 WHERE id=?`).run(f.title ?? null, f.description ?? null, f.acceptance ?? null, actor, now(), t.id);
  emit(db, 'task.updated', actor, 'task', t.id, { fields: Object.keys(f) });
}

export function addNote(db: DB, taskId: number, agent: string | null, body: string): number {
  const r = db.prepare(`INSERT INTO notes(task_id, author_agent_id, body, created_at) VALUES (?,?,?,?)`).run(taskId, agent, body.slice(0, 4000), now());
  const id = Number(r.lastInsertRowid);
  emit(db, 'note.added', agent ?? 'user', 'task', taskId, { note_id: id });
  return id;
}
