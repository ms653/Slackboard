import { describe, it, expect, afterEach } from 'vitest';
import { tx, setDbForTests } from '@/lib/db';
import { freshEnv, claim, userTask, ME } from './helpers';
import { finishAttempt } from '@/lib/domain/finish';
import { bootstrap } from '@/lib/server/read';

afterEach(() => setDbForTests(null));
const badgeOf = (id: number) => bootstrap().tasks.find((t: any) => t.id === id)!.badge;

describe('card badges (UX §5/§8)', () => {
  it('retrying: queued job with attempts>0 and failure_kind', () => {
    const db = freshEnv(); setDbForTests(db);
    const { task_id } = userTask(db);
    expect(badgeOf(task_id)).toBeNull();
    const j = claim(db)!;
    tx(db, () => finishAttempt(db, j.id, { exitCode: 1 } as any, ME));
    const b: any = badgeOf(task_id);
    expect(b.icon).toBe('✕');
    expect(b.text).toBe('Run failed (exit 1)');
    expect(b.retry).toMatchObject({ attempts: 1, max_attempts: 3 });
    expect(typeof b.retry.run_after).toBe('number');
  });

  it('continuation requeue shows Continuing, not Run failed', () => {
    const db = freshEnv(); setDbForTests(db);
    const { task_id } = userTask(db);
    const j = claim(db)!;
    db.prepare(`UPDATE jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, attempts=1, continuations=1, failure_kind='max_turns' WHERE id=?`).run(j.id);
    expect(badgeOf(task_id)).toEqual({ icon: '⟲', text: 'Continuing (turn limit)' });
    db.prepare(`UPDATE jobs SET failure_kind='no_handoff' WHERE id=?`).run(j.id);
    expect((badgeOf(task_id) as any).text).toBe('Continuing (no handoff)');
  });

  it('agent_blocked reason carries first line of the assignee latest note (truncated)', () => {
    const db = freshEnv(); setDbForTests(db);
    const { task_id } = userTask(db);
    const reasonOf = () => bootstrap().tasks.find((t: any) => t.id === task_id)!.reason;
    db.prepare(`UPDATE tasks SET status='blocked', blocked_reason='agent_blocked' WHERE id=?`).run(task_id);
    expect(reasonOf()).toBe('Blocked by worker');
    const a = (db.prepare(`SELECT assignee_agent_id a FROM tasks WHERE id=?`).get(task_id) as any).a;
    db.prepare(`INSERT INTO notes(task_id, author_agent_id, body, created_at) VALUES (?,?,?,?)`).run(task_id, a, 'old', Date.now());
    db.prepare(`INSERT INTO notes(task_id, author_agent_id, body, created_at) VALUES (?,?,?,?)`).run(task_id, a, 'Need API key\nmore detail', Date.now());
    expect(reasonOf()).toBe('Blocked by worker: Need API key');
    db.prepare(`INSERT INTO notes(task_id, author_agent_id, body, created_at) VALUES (?,?,?,?)`).run(task_id, a, 'x'.repeat(200), Date.now());
    expect(reasonOf()).toBe(`Blocked by worker: ${'x'.repeat(79)}…`);
  });

  it('kill_followup ignores follow-ups from an earlier kill', () => {
    const db = freshEnv(); setDbForTests(db);
    const ev = (ts: number) => db.prepare(`INSERT INTO events(ts, type, actor, entity_type, entity_id, payload) VALUES (?,?,?,?,?,?)`)
      .run(ts, 'kill.engaged', 'system', 'system', '1', JSON.stringify({ survivors: [42], followup: true }));
    ev(1000);
    db.prepare(`UPDATE system_state SET kill_switch=1, kill_engaged_at=? WHERE id=1`).run(5000);
    expect(bootstrap().system.kill_followup).toBeNull();
    ev(6000);
    expect(bootstrap().system.kill_followup).toMatchObject({ survivors: [42] });
  });

  it('kill interim: kill on, orchestrator down, task has a running job', () => {
    const db = freshEnv(); setDbForTests(db);
    const { task_id } = userTask(db);
    claim(db)!;
    expect(badgeOf(task_id)).toBeNull();
    db.prepare(`UPDATE system_state SET kill_switch=1, kill_engaged_at=?, orchestrator_heartbeat_at=NULL WHERE id=1`).run(Date.now());
    expect(badgeOf(task_id)).toEqual({ icon: '⏸', text: 'Stopped by kill, waiting for orchestrator' });
  });
});
