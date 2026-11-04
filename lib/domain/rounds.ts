import type { DB } from '../db';
import type { WorkspaceFacts } from './git';

/** Round terms, defined once (TECH §3.1). */
export interface TaskRow {
  id: number; title: string; description: string; acceptance: string; status: string;
  assignee_agent_id: string | null; parent_id: number | null; thread_id: number;
  created_by_kind: 'user' | 'agent'; created_by_agent_id: string | null;
  claimed_by: string | null; claim_expires_at: number | null;
  review_round: number; review_cycle: number; blocked_reason: string | null;
  help_agent_id: string | null; base_commit: string | null; position: number; version: number; accepted_at: number | null;
  created_at: number; updated_at: number;
}
export interface ArtifactRow {
  id: number; task_id: number; review_cycle: number; review_round: number; base_commit: string; head_commit: string;
  diff_path: string; files: string; lines_added: number; lines_removed: number;
  verdict: string | null; verdict_by: string | null; verdict_note: string | null; created_at: number;
}

export function getTask(db: DB, id: number): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

export function currentArtifact(db: DB, t: TaskRow): ArtifactRow | undefined {
  if (t.review_round === 0) return undefined;
  return db.prepare(`SELECT * FROM artifacts WHERE task_id = ? AND review_cycle = ? AND review_round = ?
                     AND (verdict IS NULL OR verdict <> 'superseded')`).get(t.id, t.review_cycle, t.review_round) as ArtifactRow | undefined;
}

export function lastHead(db: DB, t: TaskRow): string | null {
  const a = db.prepare(`SELECT head_commit FROM artifacts WHERE task_id = ? AND (verdict IS NULL OR verdict <> 'superseded')
                        ORDER BY id DESC LIMIT 1`).get(t.id) as { head_commit: string } | undefined;
  return a ? a.head_commit : t.base_commit;
}

export function helpFailed(db: DB, t: TaskRow): boolean {
  if (t.status !== 'blocked' || t.blocked_reason !== 'job_failed') return false;
  const j = db.prepare(`SELECT kind, status FROM jobs WHERE task_id = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(t.id) as { kind: string; status: string } | undefined;
  return !!j && j.kind === 'help' && ['failed', 'killed', 'cancelled'].includes(j.status);
}

export interface ResumeTarget { status: 'blocked' | 'in_review' | 'todo'; agent: string; kind: 'help' | 'review' | 'work'; redo: boolean }

/** resumeTarget(task, via) — evaluated on the task row as it is; ws = workspace facts computed outside the txn. */
export function resumeTarget(db: DB, t: TaskRow, via: 'retry' | 'reply', ws: WorkspaceFacts): ResumeTarget {
  const assignee = t.assignee_agent_id as string;          // the task's assignee (PHASE2 §T3.1)
  if (via === 'retry' && helpFailed(db, t)) return { status: 'blocked', agent: 'director', kind: 'help', redo: false };
  if (t.blocked_reason === 'review_cap') return { status: 'todo', agent: assignee, kind: 'work', redo: false };
  const a = currentArtifact(db, t);
  if (a && a.verdict === null) {
    if (ws.clean && ws.head === a.head_commit) return { status: 'in_review', agent: 'director', kind: 'review', redo: false };
    return { status: 'todo', agent: assignee, kind: 'work', redo: true };
  }
  return { status: 'todo', agent: assignee, kind: 'work', redo: false };
}
