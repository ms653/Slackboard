import type { DB } from '../db';
import { now } from '../util';

export type EntityType = 'message' | 'thread' | 'task' | 'job' | 'approval' | 'agent' | 'budget' | 'system';

/** Append-only event log (TECH §2 events). Every row change appends one. */
export function emit(db: DB, type: string, actor: string, entityType: EntityType | null, entityId: string | number | null,
                     payload: Record<string, unknown> = {}, jobId: number | null = null): number {
  const r = db.prepare(`INSERT INTO events(ts, type, actor, entity_type, entity_id, job_id, payload) VALUES (?,?,?,?,?,?,?)`)
    .run(now(), type, actor, entityType, entityId == null ? null : String(entityId), jobId, JSON.stringify(payload));
  return Number(r.lastInsertRowid);
}
