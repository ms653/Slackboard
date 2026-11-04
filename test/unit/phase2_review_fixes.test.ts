import { describe, it, expect } from 'vitest';
import { tx } from '@/lib/db';
import { freshEnv, claim } from './helpers';
import { callTool, type Caller } from '@/lib/domain/tools';
import { kindSettings } from '@/lib/domain/jobs';
import { createWorkerByUser, parseSpawnPayload, setEnabled } from '@/lib/domain/agents';
import { createThread } from '@/lib/domain/threads';
import { enqueueJob } from '@/lib/domain/jobs';
import { createTask } from '@/lib/domain/tasks';
import { budgetHitAgent, systemLineHasAction, reproposeDefault } from '@/lib/systemLines';

describe('phase 2 increment 1 review fixes', () => {
  it('spawn_worker is published to director respond jobs only', () => {
    expect(kindSettings('director', 'respond').tools).toContain('spawn_worker');
    expect(kindSettings('director', 'help').tools).not.toContain('spawn_worker');
    expect(kindSettings('director', 'review').tools).not.toContain('spawn_worker');
  });
  it('skill_note is trimmed; whitespace-only is a validation error', () => {
    const db = freshEnv();
    expect(() => tx(db, () => createWorkerByUser(db, { name: 'w2', skill_note: '   ', daily_usd: 2, daily_jobs: 5 }))).toThrow(/validation_error/);
    tx(db, () => createWorkerByUser(db, { name: 'w2', skill_note: '  docs  ', daily_usd: 2, daily_jobs: 5 }));
    expect((db.prepare(`SELECT skill_note s FROM agents WHERE id='w2'`).get() as any).s).toBe('docs');
    const pl = { action: 'spawn_worker', name: 'w3', skill_note: ' x ', model: 'sonnet', daily_usd: 2, daily_jobs: 5 };
    expect(parseSpawnPayload(pl).skill_note).toBe('x');
    expect(() => parseSpawnPayload({ ...pl, skill_note: '  ' })).toThrow();
  });
  it('spawn_worker tool rejects whitespace-only skill_note and stores the trimmed one', () => {
    const db = freshEnv();
    const th = tx(db, () => createThread(db, 'general', { kind: 'user' }));
    tx(db, () => enqueueJob(db, { agent: 'director', kind: 'respond', thread: th }));
    const d = claim(db)!;
    const c: Caller = { jobId: d.id, agent: 'director', role: 'director', kind: 'respond', threadId: th, taskId: null } as any;
    expect(callTool(db, c, 'spawn_worker', { name: 'w2', skill_note: '   ', why: 'x' })).toMatchObject({ ok: false, error: 'validation_error' });
    expect(callTool(db, c, 'spawn_worker', { name: 'w2', skill_note: ' docs ', why: 'x' })).toMatchObject({ ok: true });
    const p = JSON.parse((db.prepare(`SELECT payload p FROM approvals WHERE kind='spend'`).get() as any).p);
    expect(p.skill_note).toBe('docs');
  });
  it('user-created task validates assignee', () => {
    const db = freshEnv();
    tx(db, () => createWorkerByUser(db, { name: 'w2', skill_note: 'd', daily_usd: 2, daily_jobs: 5 }));
    const mk = (assignee: string) => () => tx(db, () => createTask(db, { title: 't', assignee, by: { kind: 'user' } }));
    expect(mk('nobody')).toThrow(/unknown_assignee/);
    try { mk('nobody')(); } catch (e: any) { expect(e.code).toBe('unknown_assignee'); }
    tx(db, () => setEnabled(db, 'w2', false));
    try { mk('w2')(); expect.unreachable(); } catch (e: any) { expect(e.code).toBe('unknown_assignee'); }
    expect(mk('worker')).not.toThrow();
    tx(db, () => setEnabled(db, 'worker', false));
    try { mk('worker')(); expect.unreachable(); } catch (e: any) { expect(e.code).toBe('no_enabled_worker'); }
  });
  it('system line helpers', () => {
    const b = 'w2 reached its daily allowance ($0.60/$1.50 est.); its runs wait until 00:00. [Edit budget]';
    expect(budgetHitAgent(b)).toBe('w2');
    expect(budgetHitAgent('T-1 approved by user')).toBeNull();
    expect(systemLineHasAction(b)).toBe(true);
    expect(systemLineHasAction('w2 joined (approved by you). Allowance $2.00 est./day, 5 runs/day.')).toBe(true);
    expect(systemLineHasAction('w2 added. Director not woken: thread closed.')).toBe(true);
    expect(systemLineHasAction('T-1 submitted for review')).toBe(false);
  });
  it('re-propose default: assignee if enabled, else first enabled worker', () => {
    const ws = [{ id: 'a' }, { id: 'b' }];
    expect(reproposeDefault('b', ws)).toBe('b');
    expect(reproposeDefault('retired', ws)).toBe('a');
    expect(reproposeDefault(null, ws)).toBe('a');
    expect(reproposeDefault('a', [])).toBeUndefined();
  });
});
