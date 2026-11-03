import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, tx, type DB } from '@/lib/db';
import { claimNext } from '@/lib/domain/claim';
import { createTask } from '@/lib/domain/tasks';
import { getTask } from '@/lib/domain/rounds';

export function freshEnv(): DB {
  process.env.SLACKBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  process.env.SB_BACKOFF_SCALE = '0';
  const db = openDb(':memory:');
  db.prepare(`UPDATE system_state SET doctor_ok_at=?, orchestrator_heartbeat_at=? WHERE id=1`).run(Date.now(), Date.now());
  return db;
}
export const ME = 'test-orch';
export const claim = (db: DB) => tx(db, () => claimNext(db, ME, 'tok'));
export function userTask(db: DB, title = 'Write a file') {
  return tx(db, () => createTask(db, { title, description: 'd', acceptance: '1. file exists', by: { kind: 'user' } }));
}
export const task = (db: DB, id: number) => getTask(db, id)!;
export const job = (db: DB, id: number) => db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as any;
export function writeWs(taskId: number, file: string, content: string) {
  const p = path.join(process.env.SLACKBOARD_HOME!, 'workspaces', `T-${taskId}`, file);
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content);
}
