import { describe, it, expect, afterEach } from 'vitest';
import { Env } from './harness';
import { createTask } from '@/lib/domain/tasks';
import { engageKill, resume } from '@/lib/domain/control';
import { groupAlive, sweepByMarker } from '@/lib/proc';

let env: Env;
afterEach(async () => { await env?.stop('SIGKILL'); });
const hangWorker = { 'worker:work:a1': [{ write: { path: 'x.txt', content: 'x' } }, { hang: true }] };

async function startWithHangingWorker(e: Env) {
  e.start();
  await e.until(() => e.one(`SELECT doctor_ok_at FROM system_state`).doctor_ok_at, 30000, 'doctor');
  const t = e.tx(() => createTask(e.db, { title: 'hang', description: '', acceptance: '1', by: { kind: 'user' } }));
  const j = await e.until(() => e.one(`SELECT * FROM jobs WHERE task_id=? AND status='running' AND pid IS NOT NULL`, t.task_id), 20000, 'running job');
  await e.until(() => sweepByMarker(j.id).length > 0, 10000, 'shim up');
  return { t, j };
}

describe('kill switch', () => {
  it('S3: kill via orchestrator -> no processes, job killed, task blocked/killed, no claim while engaged', async () => {
    env = new Env(hangWorker);
    const { t, j } = await startWithHangingWorker(env);
    const r = await engageKill(env.db);
    expect(r.path).toBe('orchestrator');
    await env.until(() => !groupAlive(j.pid) && sweepByMarker(j.id).length === 0, 8000, 'processes dead');
    await env.until(() => env.one(`SELECT status FROM jobs WHERE id=?`, j.id).status === 'killed', 8000, 'job killed');
    expect(env.one(`SELECT status, blocked_reason FROM tasks WHERE id=?`, t.task_id)).toEqual({ status: 'blocked', blocked_reason: 'killed' });
    const before = env.one(`SELECT count(*) n FROM events WHERE type='job.started'`).n;
    await new Promise((r) => setTimeout(r, 2000));
    expect(env.one(`SELECT count(*) n FROM events WHERE type='job.started'`).n).toBe(before);
  });

  it('S3b: orchestrator kill -9, then Stop all -> direct path; Resume refused until restart; restart -> J15', async () => {
    env = new Env(hangWorker);
    const { t, j } = await startWithHangingWorker(env);
    await env.stop('SIGKILL');
    expect(groupAlive(j.pid)).toBe(true);                       // detached child outlives the orchestrator
    const r = await engageKill(env.db);
    expect(r).toMatchObject({ path: 'direct', survivors: [] });
    expect(groupAlive(j.pid)).toBe(false);
    expect(sweepByMarker(j.id)).toEqual([]);
    expect(env.one(`SELECT status FROM jobs WHERE id=?`, j.id).status).toBe('running');
    expect(() => resume(env.db)).toThrow(/kill_recovery_pending/);
    env.start();
    await env.until(() => env.one(`SELECT status FROM jobs WHERE id=?`, j.id).status === 'killed', 20000, 'recovered as killed');
    expect(env.one(`SELECT status, blocked_reason FROM tasks WHERE id=?`, t.task_id)).toEqual({ status: 'blocked', blocked_reason: 'killed' });
    expect(env.one(`SELECT count(*) n FROM events WHERE type='job.requeued'`).n).toBe(0);
    await env.until(() => { try { resume(env.db); return true; } catch { return false; } }, 10000, 'resume allowed');
    expect(env.one(`SELECT status FROM tasks WHERE id=?`, t.task_id).status).toBe('blocked');
  });

  it('S5: orchestrator kill -9 mid-run, restart -> orphan group killed, job requeued and completes', async () => {
    env = new Env({ 'worker:work:a1': [{ write: { path: 'x.txt', content: 'x' } }, { hang: true }] });
    const { t, j } = await startWithHangingWorker(env);
    await env.stop('SIGKILL');
    env.start();
    await env.until(() => !groupAlive(j.pid), 15000, 'orphan killed');
    await env.until(() => env.one(`SELECT status FROM tasks WHERE id=?`, t.task_id).status === 'done', 40000, 'task done after recovery');
    const req = env.one(`SELECT json_extract(payload,'$.reason') r FROM events WHERE type='job.requeued' AND entity_id=?`, String(j.id));
    expect(req.r).toBe('orphaned');
  });
});
