import { describe, it, expect } from 'vitest';
import { tx } from '@/lib/db';
import { freshEnv, claim, userTask, task, job, writeWs, ME } from './helpers';
import { finishAttempt } from '@/lib/domain/finish';
import { callTool, type Caller } from '@/lib/domain/tools';
import { decideApproval, unblockTask } from '@/lib/domain/tasks';
import { workspaceFacts } from '@/lib/domain/git';
import { wakePreview, postUserMessage } from '@/lib/domain/wake';
import { enqueueJob } from '@/lib/domain/jobs';

const caller = (j: any, role: string): Caller => ({ jobId: j.id, agent: j.agent_id, role, kind: j.kind, threadId: j.thread_id, taskId: j.task_id });
const ok = { exitCode: 0, result: { subtype: 'success', total_cost_usd: 0.01, num_turns: 2 } };

describe('claim (TECH §5.3)', () => {
  it('claims once; second claim returns nothing; T6 moves task in_progress', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const j = claim(db)!;
    expect(j.kind).toBe('work');
    expect(j.session_id).toHaveLength(36);
    expect(j.pid).toBeNull();
    expect(task(db, task_id).status).toBe('in_progress');
    expect(claim(db)).toBeNull();
  });
  it('kill switch and pause block claims inside the UPDATE', () => {
    const db = freshEnv();
    userTask(db);
    db.prepare(`UPDATE system_state SET kill_switch=1, kill_engaged_at=1`).run();
    expect(claim(db)).toBeNull();
    db.prepare(`UPDATE system_state SET kill_switch=0, kill_engaged_at=NULL, paused_until=?, pause_reason='usage_limit'`).run(Date.now() + 60000);
    expect(claim(db)).toBeNull();
  });
  it('budget gate excludes a job whose cap exceeds the day limit; reservation = cap', () => {
    const db = freshEnv();
    userTask(db);
    db.prepare(`UPDATE budgets SET limit_usd=0.5 WHERE period='day'`).run();
    expect(claim(db)).toBeNull();
    db.prepare(`UPDATE budgets SET limit_usd=5 WHERE period='day'`).run();
    const j = claim(db)!;
    expect(j.budget_reserved_usd).toBe(1.0);
  });
});

describe('full review loop with real git', () => {
  it('work -> submit -> review approve -> done; idempotent replay', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const w = claim(db)!;
    writeWs(task_id, 'out.txt', 'hello\n');
    const input = { task_id, action: 'submit_for_review', note: 'done' };
    const r1 = callTool(db, caller(w, 'worker'), 'update_task', input);
    expect(r1).toMatchObject({ ok: true, status: 'in_review', review_round: 1 });
    const r2 = callTool(db, caller(w, 'worker'), 'update_task', input);
    expect(r2).toEqual(r1);
    expect((db.prepare(`SELECT count(*) n FROM events WHERE type='tool.called' AND json_extract(payload,'$.replay')=1`).get() as any).n).toBe(1);
    tx(db, () => finishAttempt(db, w.id, ok, ME));
    expect(job(db, w.id).status).toBe('succeeded');
    const rv = claim(db)!;
    expect(rv.kind).toBe('review');
    expect(callTool(db, caller(rv, 'director'), 'update_task', { task_id, action: 'approve' })).toMatchObject({ ok: true, status: 'done' });
    tx(db, () => finishAttempt(db, rv.id, ok, ME));
    expect(task(db, task_id).status).toBe('done');
  });
  it('approve rejects workspace drift (T13 guard)', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const w = claim(db)!;
    writeWs(task_id, 'a.txt', '1');
    callTool(db, caller(w, 'worker'), 'update_task', { task_id, action: 'submit_for_review' });
    tx(db, () => finishAttempt(db, w.id, ok, ME));
    const rv = claim(db)!;
    writeWs(task_id, 'a.txt', 'tampered');
    expect(callTool(db, caller(rv, 'director'), 'update_task', { task_id, action: 'approve' })).toMatchObject({ ok: false, error: 'workspace_drift' });
    expect(task(db, task_id).status).toBe('in_review');
  });
  it('request_changes twice -> review_cap; send back resets round and cycle', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    for (let round = 1; round <= 2; round++) {
      const w = claim(db)!;
      writeWs(task_id, 'a.txt', String(round));
      expect(callTool(db, caller(w, 'worker'), 'update_task', { task_id, action: 'submit_for_review' })).toMatchObject({ ok: true });
      tx(db, () => finishAttempt(db, w.id, ok, ME));
      const rv = claim(db)!;
      callTool(db, caller(rv, 'director'), 'update_task', { task_id, action: 'request_changes', note: 'fix it' });
      tx(db, () => finishAttempt(db, rv.id, ok, ME));
    }
    expect(task(db, task_id)).toMatchObject({ status: 'blocked', blocked_reason: 'review_cap' });
    tx(db, () => unblockTask(db, task(db, task_id), 'user', 'retry', workspaceFacts(task_id), 'try again'));
    expect(task(db, task_id)).toMatchObject({ status: 'todo', review_round: 0, review_cycle: 1 });
  });
  it('kill during review with clean workspace -> Retry returns to in_review + review job', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const w = claim(db)!;
    writeWs(task_id, 'a.txt', '1');
    callTool(db, caller(w, 'worker'), 'update_task', { task_id, action: 'submit_for_review' });
    tx(db, () => finishAttempt(db, w.id, ok, ME));
    const rv = claim(db)!;
    tx(db, () => finishAttempt(db, rv.id, { killedFor: 'kill', exitCode: null }, ME));
    expect(task(db, task_id)).toMatchObject({ status: 'blocked', blocked_reason: 'killed' });
    const rt = tx(db, () => unblockTask(db, task(db, task_id), 'user', 'retry', workspaceFacts(task_id)));
    expect(rt).toMatchObject({ status: 'in_review', kind: 'review' });
  });
  it('redo after drift: artifact superseded, round decremented, resubmit passes', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const w = claim(db)!;
    writeWs(task_id, 'a.txt', '1');
    callTool(db, caller(w, 'worker'), 'update_task', { task_id, action: 'submit_for_review' });
    tx(db, () => finishAttempt(db, w.id, ok, ME));
    const rv = claim(db)!;
    writeWs(task_id, 'a.txt', 'drift');
    tx(db, () => finishAttempt(db, rv.id, { failure: 'workspace_drift', exitCode: 0 }, ME));
    expect(task(db, task_id)).toMatchObject({ status: 'blocked', blocked_reason: 'job_failed' });
    tx(db, () => unblockTask(db, task(db, task_id), 'user', 'retry', workspaceFacts(task_id)));
    expect(task(db, task_id)).toMatchObject({ status: 'todo', review_round: 0 });
    const w2 = claim(db)!;
    writeWs(task_id, 'a.txt', '1');  // revert the drift: still differs from last non-superseded head (base)
    expect(callTool(db, caller(w2, 'worker'), 'update_task', { task_id, action: 'submit_for_review' })).toMatchObject({ ok: true, review_round: 1 });
  });
});

describe('job state machine (TECH §3.2)', () => {
  it('J11 retry keeps id/attempts and moves task back to todo (T9); J12 after max -> blocked/job_failed', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    let j = claim(db)!;
    for (let i = 1; i <= 3; i++) {
      tx(db, () => finishAttempt(db, j.id, { exitCode: 1 }, ME));
      if (i < 3) { expect(job(db, j.id)).toMatchObject({ status: 'queued', attempts: i }); j = claim(db)!; }
    }
    expect(job(db, j.id)).toMatchObject({ status: 'failed', failure_kind: 'exit_nonzero' });
    expect(task(db, task_id)).toMatchObject({ status: 'blocked', blocked_reason: 'job_failed' });
  });
  it('J6 then J7 for work success without handoff', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    let j = claim(db)!;
    tx(db, () => finishAttempt(db, j.id, ok, ME));
    expect(job(db, j.id)).toMatchObject({ status: 'queued', continuations: 1, failure_kind: 'no_handoff' });
    j = claim(db)!;
    tx(db, () => finishAttempt(db, j.id, ok, ME));
    expect(job(db, j.id).status).toBe('failed');
    expect(task(db, task_id).blocked_reason).toBe('job_failed');
  });
  it('work + request_help -> T11 blocked/help and director help job enqueued at finish, not at call', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const j = claim(db)!;
    callTool(db, caller(j, 'worker'), 'request_help', { question: 'which format?', options: ['md', 'txt'] });
    expect(db.prepare(`SELECT count(*) n FROM jobs WHERE kind='help'`).get()).toEqual({ n: 0 });
    tx(db, () => finishAttempt(db, j.id, ok, ME));
    expect(task(db, task_id)).toMatchObject({ status: 'blocked', blocked_reason: 'help' });
    expect(db.prepare(`SELECT count(*) n FROM jobs WHERE kind='help' AND status='queued'`).get()).toEqual({ n: 1 });
  });
  it('help-end rule: help job killed -> task blocked/job_failed; Retry re-enqueues help', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const j = claim(db)!;
    callTool(db, caller(j, 'worker'), 'request_help', { question: 'q' });
    tx(db, () => finishAttempt(db, j.id, ok, ME));
    const h = claim(db)!;
    expect(h.kind).toBe('help');
    tx(db, () => finishAttempt(db, h.id, { result: { subtype: 'error_max_budget_usd' }, exitCode: 0 }, ME));
    expect(task(db, task_id)).toMatchObject({ status: 'blocked', blocked_reason: 'job_failed' });
    const rt = tx(db, () => unblockTask(db, task(db, task_id), 'user', 'retry', workspaceFacts(task_id)));
    expect(rt).toMatchObject({ status: 'blocked', kind: 'help' });
    expect(task(db, task_id).blocked_reason).toBe('help');
    expect(wakePreview(db, task(db, task_id).thread_id)).toMatchObject({ agent: 'worker', kind: 'work' });
  });
  it('kill_switch on + non-success finish -> J15, never requeued', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const j = claim(db)!;
    db.prepare(`UPDATE system_state SET kill_switch=1, kill_engaged_at=1`).run();
    tx(db, () => finishAttempt(db, j.id, { failure: 'orphaned' }, ME));
    expect(job(db, j.id).status).toBe('killed');
    expect(task(db, task_id).blocked_reason).toBe('killed');
  });
  it('finishAttempt with a foreign owner is a no-op', () => {
    const db = freshEnv();
    userTask(db);
    const j = claim(db)!;
    expect(tx(db, () => finishAttempt(db, j.id, ok, 'someone-else'))).toBeNull();
    expect(job(db, j.id).status).toBe('running');
  });
  it('cancel_requested turns a requeue into J17 and T21', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const j = claim(db)!;
    db.prepare(`UPDATE jobs SET cancel_requested=1 WHERE id=?`).run(j.id);
    tx(db, () => finishAttempt(db, j.id, { exitCode: 1 }, ME));
    expect(job(db, j.id).status).toBe('cancelled');
    expect(task(db, task_id)).toMatchObject({ status: 'blocked', blocked_reason: 'user' });
  });
  it('requeue merge keeps the retrying job id and sums trigger counts', () => {
    const db = freshEnv();
    const th = db.prepare(`INSERT INTO threads(channel_id,title,created_by_kind,created_at) VALUES (1,'chat','user',1)`).run().lastInsertRowid as number;
    tx(db, () => enqueueJob(db, { agent: 'director', kind: 'respond', thread: th }));
    const j = claim(db)!;
    const q = tx(db, () => enqueueJob(db, { agent: 'director', kind: 'respond', thread: th }));
    tx(db, () => finishAttempt(db, j.id, { exitCode: 1 }, ME));
    expect(job(db, q).status).toBe('cancelled');
    expect(job(db, j.id)).toMatchObject({ status: 'queued', attempts: 1, trigger_count: 2 });
  });
});

describe('approvals and tool server rules', () => {
  it('director create_task top-level -> proposed + approval; approve -> todo + work job', () => {
    const db = freshEnv();
    const th = db.prepare(`INSERT INTO threads(channel_id,title,created_by_kind,created_at) VALUES (1,'chat','user',1)`).run().lastInsertRowid as number;
    tx(db, () => postUserMessage(db, th, 'please write docs'));
    const d = claim(db)!;
    const r: any = callTool(db, caller(d, 'director'), 'create_task', { title: 'Docs', description: 'x', acceptance: '1. y' });
    expect(r).toMatchObject({ ok: true, status: 'proposed' });
    expect(db.prepare(`SELECT count(*) n FROM jobs WHERE kind='work'`).get()).toEqual({ n: 0 });
    tx(db, () => decideApproval(db, r.approval_id, 'approved'));
    expect(task(db, r.task_id).status).toBe('todo');
    expect(db.prepare(`SELECT count(*) n FROM jobs WHERE kind='work' AND status='queued'`).get()).toEqual({ n: 1 });
    expect(() => db.prepare(`UPDATE tasks SET title='changed' WHERE id=?`).run(r.task_id)).toThrow(/approved_task_immutable/);
  });
  it('role checks: worker cannot create_task or address user', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const w = claim(db)!;
    expect(callTool(db, caller(w, 'worker'), 'create_task', { title: 'x', description: '', acceptance: 'y' })).toMatchObject({ error: 'not_allowed_for_role' });
    expect(callTool(db, caller(w, 'worker'), 'post_message', { body: 'hi', mentions: ['user'] })).toMatchObject({ error: 'cannot_address_user' });
    expect(callTool(db, caller(w, 'worker'), 'add_note', { task_id, body: 'plan' })).toMatchObject({ ok: true });
  });
});
