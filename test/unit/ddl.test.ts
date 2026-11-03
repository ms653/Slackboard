import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { freshEnv, userTask } from './helpers';

describe('DDL and triggers (TECH §11)', () => {
  it('openDb leaves WAL off for :memory: but foreign_keys on, and migrate is idempotent', () => {
    const db = freshEnv();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });
  it('file DB is WAL', () => {
    freshEnv();
    const db = openDb(process.env.SLACKBOARD_HOME + '/x.db');
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });
  it('events are append-only', () => {
    const db = freshEnv();
    db.prepare(`INSERT INTO events(ts,type,actor) VALUES (1,'settings.changed','user')`).run();
    expect(() => db.prepare(`UPDATE events SET actor='x'`).run()).toThrow(/events_append_only/);
    expect(() => db.prepare(`DELETE FROM events`).run()).toThrow(/events_append_only/);
  });
  it('agent top-level task cannot be inserted as todo', () => {
    const db = freshEnv();
    const th = db.prepare(`INSERT INTO threads(channel_id,title,created_by_kind,created_at) VALUES (1,'t','system',1)`).run().lastInsertRowid;
    expect(() => db.prepare(`INSERT INTO tasks(title,status,assignee_agent_id,thread_id,created_by_kind,created_by_agent_id,created_at,updated_at)
      VALUES ('x','todo','worker',?,'agent','director',1,1)`).run(th)).toThrow(/must_be_proposed/);
  });
  it('illegal task transition aborts; blocked -> in_review allowed', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    expect(() => db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(task_id)).toThrow(/illegal_task_transition/);
    db.prepare(`UPDATE tasks SET status='blocked', blocked_reason='user' WHERE id=?`).run(task_id);
    expect(() => db.prepare(`UPDATE tasks SET status='in_review', blocked_reason=NULL WHERE id=?`).run(task_id)).not.toThrow();
  });
  it('one running job per agent', () => {
    const db = freshEnv();
    const ins = () => db.prepare(`INSERT INTO jobs(agent_id,kind,thread_id,status,run_after,budget_cap_usd,lease_owner,lease_expires_at,created_at)
      VALUES ('director','respond',1,'running',0,0.4,'o',1,1)`).run();
    db.prepare(`INSERT INTO threads(channel_id,title,created_by_kind,created_at) VALUES (1,'t','system',1)`).run();
    ins();
    expect(ins).toThrow(/UNIQUE/);
  });
  it('system_state pause CHECKs', () => {
    const db = freshEnv();
    expect(() => db.prepare(`UPDATE system_state SET pause_reason='user', paused_until=5`).run()).toThrow();
    expect(() => db.prepare(`UPDATE system_state SET pause_reason='usage_limit', paused_until=NULL`).run()).toThrow();
  });
});
