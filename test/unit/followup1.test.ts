import { describe, it, expect } from 'vitest';
import http from 'node:http';
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
