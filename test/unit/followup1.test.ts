import { describe, it, expect } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tx } from '@/lib/db';
import { freshEnv, claim, userTask, job, ME } from './helpers';
import { finishAttempt } from '@/lib/domain/finish';
import { markKilled, terminateChild } from '@/orchestrator/spawn';
import { startToolServer, Tokens } from '@/orchestrator/toolserver';

describe('F1 budget estimate', () => {
  it('attempt with no result charges the reserved cap and flags the event', () => {
    const db = freshEnv();
    userTask(db);
    const w = claim(db)!;
    expect(w.budget_reserved_usd).toBe(1.0);
    db.prepare(`UPDATE jobs SET pid=4242, session_started=1, started_at=1000, last_output_at=2000 WHERE id=?`).run(w.id);
    tx(db, () => finishAttempt(db, w.id, { failure: 'orphaned' }, ME));
    expect(job(db, w.id).cost_usd).toBe(1.0);
    const ev = db.prepare(`SELECT payload FROM events WHERE type='job.attempt_finished' AND entity_id=?`).get(String(w.id)) as any;
    expect(JSON.parse(ev.payload)).toMatchObject({ cost_usd: 1.0, estimated_from_cap: true });
  });
  it('attempt with a result charges the reported cost only', () => {
    const db = freshEnv();
    userTask(db);
    const w = claim(db)!;
    tx(db, () => finishAttempt(db, w.id, { exitCode: 1, result: { subtype: 'error_during_execution', total_cost_usd: 0.02 } }, ME));
    expect(job(db, w.id).cost_usd).toBe(0.02);
  });
});

describe('ENG-F1 no phantom spend', () => {
  for (const failure of ['spawn_error', 'workspace_drift'] as const)
    it(`${failure} with no process charges 0`, () => {
      const db = freshEnv(); userTask(db);
      const w = claim(db)!;
      tx(db, () => finishAttempt(db, w.id, { failure }, ME));
      expect(job(db, w.id).cost_usd).toBe(0);
      const ev = db.prepare(`SELECT payload FROM events WHERE type='job.attempt_finished' AND entity_id=?`).get(String(w.id)) as any;
      expect(JSON.parse(ev.payload).estimated_from_cap).toBeUndefined();
    });
  it('killed with a pid charges the cap', () => {
    const db = freshEnv(); userTask(db);
    const w = claim(db)!;
    db.prepare(`UPDATE jobs SET pid=4242 WHERE id=?`).run(w.id);
    tx(db, () => finishAttempt(db, w.id, { killedFor: 'timeout_wall', initSeen: true }, ME));
    expect(job(db, w.id).cost_usd).toBe(1.0);
  });
});

describe('ENG-F2 estimate only past init', () => {
  const run = (o: any, pre = '') => {
    const db = freshEnv(); userTask(db);
    const w = claim(db)!;
    db.prepare(`UPDATE jobs SET pid=4242${pre} WHERE id=?`).run(w.id);
    tx(db, () => finishAttempt(db, w.id, o, ME));
    return job(db, w.id).cost_usd;
  };
  it('exit 1 with pid and no init charges 0', () => expect(run({ exitCode: 1, initSeen: false })).toBe(0));
  it('tools_missing charges 0', () => expect(run({ failure: 'tools_missing', initSeen: true })).toBe(0));
  it('mcp_not_connected charges 0', () => expect(run({ failure: 'mcp_not_connected', initSeen: true })).toBe(0));
  it('killed after init charges the cap', () => expect(run({ killedFor: 'timeout_wall', initSeen: true })).toBe(1.0));
  it('orphan with session_started and output charges the cap', () =>
    expect(run({ failure: 'orphaned' }, ', session_started=1, started_at=1000, last_output_at=2000')).toBe(1.0));
  it('orphan with session_started=0 charges 0', () =>
    expect(run({ failure: 'orphaned' }, ', session_started=0, started_at=1000, last_output_at=2000')).toBe(0));
});

describe('ENG-F3 doctor stop flag', () => {
  it('probe spawns nothing after killDoctorProbes()', async () => {
    const { probe, killDoctorProbes, liveProbePids } = await import('@/orchestrator/doctor');
    killDoctorProbes();
    const r = await probe(path.resolve('test/fake-claude/claude'), 0, new Tokens(), 'x', [], ',', 'mcp__slackboard__', false);
    expect(r.code).toBe(-1); expect(r.pid).toBeUndefined(); expect(liveProbePids.size).toBe(0);
  });
});

describe('F4 kill-switch precedence', () => {
  it('kill overrides timeout/lease_lost/shutdown but not cancelled', () => {
    for (const k of ['timeout_wall', 'timeout_idle', 'lease_lost', 'shutdown'] as const) {
      const c: any = { killedFor: k }; markKilled(c, 'kill'); expect(c.killedFor).toBe('kill');
    }
    const c: any = { killedFor: 'cancelled' }; markKilled(c, 'kill'); expect(c.killedFor).toBe('cancelled');
    const d: any = { killedFor: 'timeout_wall' }; markKilled(d, 'shutdown'); expect(d.killedFor).toBe('timeout_wall');
  });
});

describe('F3 terminateChild', () => {
  it('revokes the token and escalates SIGTERM to SIGKILL for a TERM-ignoring child', async () => {
    const p = spawn('sh', ['-c', "trap '' TERM; while true; do sleep 1; done"], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));     // let the shell install its trap
    const revoked: number[] = [];
    terminateChild({ jobId: 7, pid: p.pid! }, { bindJob() {}, revokeJob: (id) => revoked.push(id) }, 300);
    expect(revoked).toEqual([7]);
    await new Promise((r) => setTimeout(r, 150));
    expect(p.exitCode === null && p.signalCode === null).toBe(true);     // survived SIGTERM
    const sig = await new Promise((r) => p.on('exit', (_c, sg) => r(sg)));    // reaped => really dead
    expect(sig).toBe('SIGKILL');
  });
});

describe('F5 doctor token', () => {
  it('rejects calls until bind(pid) has run', async () => {
    const db = freshEnv();
    const tokens = new Tokens();
    const server = await startToolServer({ db, tokens, controlToken: 'c', onControl: async () => ({}) });
    const port = (server.address() as any).port;
    const dt = tokens.issueDoctor(() => {});
    const get = (ppid: number) => new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/tools', headers: { Authorization: `Bearer ${dt.token}`, 'x-sb-parent-pid': String(ppid) } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    });
    expect(await get(4242)).toBe(401);
    dt.bind(4242);
    expect(await get(4242)).toBe(200);
    expect(await get(1)).toBe(401);
    server.close();
  });
});

import { afterEach } from 'vitest';
import { setDbForTests } from '@/lib/db';
import { bootstrap } from '@/lib/server/read';
afterEach(() => setDbForTests(null));

describe('F6 crash-recovery badge', () => {
  it('shows "Claim expired, requeued" for 10 s after an orphan requeue, then the failure badge', () => {
    const db = freshEnv(); setDbForTests(db);
    const { task_id } = userTask(db);
    const w = claim(db)!;
    tx(db, () => finishAttempt(db, w.id, { failure: 'orphaned' }, ME));
    const b = () => bootstrap().tasks.find((t: any) => t.id === task_id)!.badge as any;
    expect(b()).toEqual({ icon: '⟲', text: 'Claim expired, requeued' });
    const real = Date.now; Date.now = () => real() + 20_000;            // events are append-only: move the clock instead
    try { expect(b().text).toBe('Run failed (orchestrator restarted)'); } finally { Date.now = real; }
  });
});

describe('F7 header data', () => {
  it('exposes running_jobs and next_run_at (5 h window: oldest job.started + 5 h)', () => {
    const db = freshEnv(); setDbForTests(db);
    userTask(db);
    expect(bootstrap().usage.next_run_at).toBeNull();
    const w = claim(db)!;
    expect(bootstrap().system.running_jobs).toBe(1);
    const t0 = Date.now() - 3_600_000;
    db.prepare(`INSERT INTO events(ts,type,actor,entity_type,entity_id,payload) VALUES (?,?,?,?,?,?)`).run(t0, 'job.started', 'system', 'job', String(w.id), '{}');
    db.prepare(`UPDATE budgets SET limit_jobs=2 WHERE period='rolling_5h'`).run();
    expect(bootstrap().usage.next_run_at).toBe(t0 + 18_000_000);
  });
});

import tailwind from '../../tailwind.config';
describe('F9 breakpoints (UX §2)', () => {
  it('md = 800 px (one-pane below) and xl = 1200 px (right-pane overlay below)', () => {
    expect((tailwind.theme as any).screens).toMatchObject({ md: '800px', xl: '1200px' });
  });
});

import { dropMove, parseDragId, TASK_MIME } from '../../components/dnd';
describe('F10 board drop rules (UX §5)', () => {
  it('allows only user transitions', () => {
    expect(dropMove('blocked', 'todo')).toEqual({ kind: 'unblock' });
    expect(dropMove('blocked', 'in_review')).toEqual({ kind: 'unblock' });
    expect(dropMove('done', 'todo')).toEqual({ kind: 'reopen' });
    expect(dropMove('in_progress', 'cancelled')).toEqual({ kind: 'cancel' });
    expect(dropMove('todo', 'todo')).toEqual({ kind: 'noop' });
    expect(dropMove('in_review', 'done')).toEqual({ kind: 'reject', message: 'Only the reviewer can move In review → Done' });
    for (const [f, t] of [['todo', 'in_progress'], ['done', 'in_review'], ['done', 'cancelled'], ['cancelled', 'todo'], ['proposed', 'todo'], ['todo', 'proposed'], ['blocked', 'done']])
      expect(dropMove(f, t).kind).toBe('reject');
  });
});

describe('UX-safety drag data', () => {
  it('only the custom MIME type is accepted', () => {
    const dt = (m: Record<string, string>) => ({ getData: (t: string) => m[t] ?? '' });
    expect(parseDragId(dt({ [TASK_MIME]: '12' }))).toBe(12);
    expect(parseDragId(dt({ 'text/plain': '12' }))).toBeNull();
    expect(parseDragId(dt({ [TASK_MIME]: 'abc' }))).toBeNull();
  });
});

describe('F1 review 4: shutdown before doctor runs', () => {
  it('runDoctor after killDoctorProbes() spawns nothing and writes no report', async () => {
    const { runDoctor, killDoctorProbes, resetDoctorStop, liveProbePids } = await import('@/orchestrator/doctor');
    const db = freshEnv();
    db.prepare(`UPDATE system_state SET doctor_report=NULL, doctor_ok_at=NULL WHERE id=1`).run();
    killDoctorProbes();                                   // signal arrived before doctor() started
    const fake = path.resolve(__dirname, '../fake-claude/claude');
    const r = await runDoctor(db, fake, 1, new Tokens());
    expect(r.ok).toBe(false);
    expect(liveProbePids.size).toBe(0);
    expect((db.prepare(`SELECT doctor_report FROM system_state WHERE id=1`).get() as any).doctor_report).toBeNull();
    resetDoctorStop();                                    // leave module state clean for other tests
  });
});
