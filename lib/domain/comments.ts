import fs from 'node:fs';
import type { DB } from '../db';
import { now, xmlEsc, DomainError } from '../util';
import { emit } from './events';
import { parseUnifiedDiff, anchorInDiff, type DiffFile } from './diff';
import { getTask, type ArtifactRow, type TaskRow } from './rounds';

/** Inline review comments (PHASE2 §T6.4, §T4.3, §T5.5). */
export const PER_ARTIFACT_CAP = 200;       // stored per artifact
export const PER_JOB_CAP = 20;             // director comments per review job
export const PROMPT_COMMENT_MAX = 50;      // rendered into one prompt ...
export const PROMPT_COMMENT_BUDGET = 12_000;   // ... and at most this many escaped characters, so truncation never drops one

export interface NoteRow { id: number; task_id: number; author_agent_id: string | null; body: string; created_at: number; artifact_id: number; path: string; line: number; side: 'old' | 'new' }

/** The task's latest non-superseded artifact (the only one whose comments are ever sent). */
export function latestArtifact(db: DB, taskId: number): ArtifactRow | undefined {
  return db.prepare(`SELECT * FROM artifacts WHERE task_id=? AND (verdict IS NULL OR verdict <> 'superseded') ORDER BY id DESC LIMIT 1`).get(taskId) as ArtifactRow | undefined;
}

export function artifactDiffText(a: ArtifactRow): string { try { return fs.readFileSync(a.diff_path, 'utf8'); } catch { return ''; } }
export function artifactDiffFiles(a: ArtifactRow): DiffFile[] { return parseUnifiedDiff(artifactDiffText(a)); }

export function anchoredNotes(db: DB, artifactId: number): NoteRow[] {
  return db.prepare(`SELECT * FROM notes WHERE artifact_id=? ORDER BY id`).all(artifactId) as NoteRow[];
}
const renderedLen = (n: NoteRow) => xmlEsc(n.body).length + xmlEsc(n.path).length + 120;

/** The note ids a run renders for this artifact: oldest first, at most 50 and within the character budget (always at least one). */
export function selectCommentIds(db: DB, artifactId: number): number[] {
  const ids: number[] = []; let used = 0;
  for (const n of anchoredNotes(db, artifactId)) {
    const len = renderedLen(n);
    if (ids.length >= PROMPT_COMMENT_MAX || (ids.length > 0 && used + len > PROMPT_COMMENT_BUDGET)) break;
    ids.push(n.id); used += len;
  }
  return ids;
}

/** Why a user comment can't be added right now, or null when open. */
export function commentGate(db: DB, a: ArtifactRow, t: TaskRow): { reason: 'superseded' | 'older_round' | 'task_closed' | 'worker_running'; hint: string } | null {
  if (a.verdict === 'superseded') return { reason: 'superseded', hint: 'this round was set aside' };
  if (latestArtifact(db, t.id)?.id !== a.id) return { reason: 'older_round', hint: 'comments closed for this round' };
  if (t.status === 'in_progress') return { reason: 'worker_running', hint: 'Worker is running; comment after it submits' };
  if (!['in_review', 'blocked', 'todo'].includes(t.status)) return { reason: 'task_closed', hint: `task is ${t.status}; comments closed for this round` };
  return null;
}

export type Delivery = { state: 'pending' | 'sent' | 'closed'; job_id?: number; reason?: 'round_closed' | 'over_limit' };
/** Delivery state per comment of one artifact (the only record is `job.started.review_note_ids`). */
export function commentsWithDelivery(db: DB, a: ArtifactRow, t: TaskRow): (NoteRow & { delivery: Delivery })[] {
  const notes = anchoredNotes(db, a.id);
  const open = !['done', 'cancelled'].includes(t.status) && latestArtifact(db, t.id)?.id === a.id;
  const eligible = new Set(selectCommentIds(db, a.id));
  const sent = db.prepare(`SELECT e.job_id AS job_id, x.value AS note_id FROM events e, json_each(e.payload, '$.review_note_ids') x
                           WHERE e.type='job.started' AND e.job_id IS NOT NULL AND json_extract(e.payload, '$.task_id') = ? ORDER BY e.id`).all(t.id) as { job_id: number; note_id: number }[];
  const by = new Map<number, number>();
  for (const s of sent) if (!by.has(s.note_id)) by.set(s.note_id, s.job_id);
  return notes.map((n) => ({ ...n, delivery: by.has(n.id) ? { state: 'sent', job_id: by.get(n.id)! }
    : !open ? { state: 'closed', reason: 'round_closed' }
    : eligible.has(n.id) ? { state: 'pending' } : { state: 'closed', reason: 'over_limit' } }));
}

/** Insert an anchored note after the shared guards. `author` NULL = user. */
export function insertAnchoredNote(db: DB, a: ArtifactRow, author: string | null, o: { path: string; line: number; side: 'old' | 'new'; body: string }): number {
  if (!anchorInDiff(artifactDiffFiles(a), o.path, o.side, o.line)) throw new DomainError('line_not_in_diff', `${o.side} line ${o.line} of ${o.path} is not a ${o.side === 'old' ? 'removed' : 'added or unchanged'} line in this diff`, 400);
  return insertNoteRow(db, a, author, o);
}
/** After the diff check: cap + insert + event. */
export function insertNoteRow(db: DB, a: ArtifactRow, author: string | null, o: { path: string; line: number; side: 'old' | 'new'; body: string }): number {
  if ((db.prepare(`SELECT count(*) n FROM notes WHERE artifact_id=?`).get(a.id) as any).n >= PER_ARTIFACT_CAP) throw new DomainError('comment_cap', `at most ${PER_ARTIFACT_CAP} comments per round`);
  const r = db.prepare(`INSERT INTO notes(task_id, author_agent_id, body, created_at, artifact_id, path, line, side) VALUES (?,?,?,?,?,?,?,?)`)
    .run(a.task_id, author, o.body, now(), a.id, o.path, o.line, o.side);
  const id = Number(r.lastInsertRowid);
  emit(db, 'note.added', author ?? 'user', 'task', a.task_id, { note_id: id, artifact_id: a.id, path: o.path, line: o.line, side: o.side });
  return id;
}

/** POST /api/artifacts/:id/comments body (user comment). Call inside an IMMEDIATE txn. */
export function addUserComment(db: DB, artifactId: number, input: any): { note_id: number } {
  const a = db.prepare(`SELECT * FROM artifacts WHERE id=?`).get(artifactId) as ArtifactRow | undefined;
  if (!a) throw new DomainError('not_found', 'no such artifact', 404);
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!input || typeof input.path !== 'string' || !input.path || input.path.length > 1000 || !Number.isInteger(input.line) || input.line < 1
      || !['old', 'new'].includes(input.side) || body.length < 1 || body.length > 4000) throw new DomainError('validation_error', 'need path, line >= 1, side old|new and a body of 1-4000 characters', 400);
  const t = getTask(db, a.task_id)!;
  const gate = commentGate(db, a, t);
  if (gate) throw new DomainError('comments_closed', gate.hint, 409);
  return { note_id: insertAnchoredNote(db, a, null, { path: input.path, line: input.line, side: input.side, body }) };
}

/** `<review_comments>` for a prompt (PHASE2 §T4.3): exactly `ids`, oldest first. Empty string when none. */
export function renderReviewComments(db: DB, a: ArtifactRow, ids: number[]): string {
  if (!ids.length) return '';
  const rows = db.prepare(`SELECT * FROM notes WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as NoteRow[];
  const lines = rows.map((n) => {
    const at = `path="${xmlEsc(n.path)}" line="${n.line}" side="${n.side}"`;
    return n.author_agent_id === null ? `  <user_comment ${at}>${xmlEsc(n.body)}</user_comment>`
      : `  <untrusted kind="review_comment" author="${xmlEsc(n.author_agent_id)}" ${at}>${xmlEsc(n.body)}</untrusted>`;
  });
  return `<review_comments artifact="${a.id}" round="${a.review_round}">\n${lines.join('\n')}\n</review_comments>`;
}

/**
 * Comments a job renders. Work jobs: exactly the ids fixed in the claim txn (`job.started.review_note_ids`).
 * Review jobs: the comments of the current-round artifact (same selection rule).
 */
export function reviewCommentsFor(db: DB, job: { id: number; kind: string; task_id: number | null }, t: TaskRow | undefined, current: ArtifactRow | undefined): string {
  if (!t) return '';
  if (job.kind === 'review') return current ? renderReviewComments(db, current, selectCommentIds(db, current.id)) : '';
  if (job.kind !== 'work') return '';
  const ev = db.prepare(`SELECT payload FROM events WHERE type='job.started' AND job_id=? ORDER BY id DESC LIMIT 1`).get(job.id) as { payload: string } | undefined;
  const ids: number[] = ev ? (JSON.parse(ev.payload).review_note_ids ?? []) : [];
  if (!ids.length) return '';
  const art = db.prepare(`SELECT a.* FROM artifacts a JOIN notes n ON n.artifact_id = a.id WHERE n.id = ?`).get(ids[0]) as ArtifactRow | undefined;
  return art ? renderReviewComments(db, art, ids) : '';
}
