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
    expect(badgeOf(task_id)).toMatch(/^✕ Run failed \(exit_nonzero\)\. Retrying in \d+ s \(1\/3\)$/);
  });

  it('kill interim: kill on, orchestrator down, task has a running job', () => {
    const db = freshEnv(); setDbForTests(db);
    const { task_id } = userTask(db);
    claim(db)!;
    expect(badgeOf(task_id)).toBeNull();
    db.prepare(`UPDATE system_state SET kill_switch=1, kill_engaged_at=?, orchestrator_heartbeat_at=NULL WHERE id=1`).run(Date.now());
    expect(badgeOf(task_id)).toBe('⏸ Stopped by kill, waiting for orchestrator');
  });
});
