import type { DB } from '../db';
import { now, DomainError } from '../util';
import { emit } from './events';

export interface MessageRow {
  id: number; thread_id: number; author_kind: 'user' | 'agent' | 'system'; author_agent_id: string | null;
  kind: string; body: string; mentions: string; wakes: number; job_id: number | null; created_at: number;
}

export function insertMessage(db: DB, o: { thread: number; authorKind: 'user' | 'agent' | 'system'; agent?: string | null;
  kind?: string; body: string; mentions?: string[]; wakes?: boolean; jobId?: number | null }): number {
  const before = db.prepare(`SELECT status FROM threads WHERE id=?`).get(o.thread) as { status: string } | undefined;
  if (!before) throw new DomainError('wrong_thread', 'thread does not exist', 404);
  let r;
  try {
    r = db.prepare(`INSERT INTO messages(thread_id, author_kind, author_agent_id, kind, body, mentions, wakes, job_id, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(o.thread, o.authorKind, o.agent ?? null, o.kind ?? 'chat', o.body.slice(0, 8000), JSON.stringify(o.mentions ?? []),
           o.wakes ? 1 : 0, o.jobId ?? null, now());
  } catch (e: any) {
    if (String(e.message).includes('thread_not_open')) throw new DomainError('thread_not_open', 'this thread is capped or closed; stop posting');
    throw e;
  }
  const id = Number(r.lastInsertRowid);
  emit(db, 'message.created', o.authorKind === 'agent' ? o.agent! : o.authorKind, 'message', id,
       { thread_id: o.thread, kind: o.kind ?? 'chat' }, o.jobId ?? null);
  const after = db.prepare(`SELECT status FROM threads WHERE id=?`).get(o.thread) as { status: string };
  if (after.status !== before.status) emit(db, 'thread.status_changed', 'system', 'thread', o.thread, { from: before.status, to: after.status });
  return id;
}

export const systemMessage = (db: DB, thread: number, body: string) =>
  insertMessage(db, { thread, authorKind: 'system', kind: 'system', body });
