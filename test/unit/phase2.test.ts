import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tx, migrate, type DB } from '@/lib/db';
import { SCHEMA_SQL } from '@/lib/db/schema';
import { MIGRATION_2_SQL } from '@/lib/db/migrations';
import { freshEnv, claim, userTask, task, job, ME } from './helpers';
import { callTool, validate, publishedTools, type Caller } from '@/lib/domain/tools';
import { decideApproval, createTask, expireApprovals, reassignTask, reopenTask, unblockTask, helpEscalatedToUser } from '@/lib/domain/tasks';
import { enqueueJob, refreshPresence } from '@/lib/domain/jobs';
import { finishAttempt } from '@/lib/domain/finish';
import { queueReason, agentBudgetHits } from '@/lib/domain/claim';
import { createWorkerByUser, retireAgent, setAgentBudget, setEnabled, setMaxConcurrency } from '@/lib/domain/agents';
import { renderPrompt, team } from '@/orchestrator/prompt';
import { createThread } from '@/lib/domain/threads';
import { postUserMessage } from '@/lib/domain/wake';
import { getTask } from '@/lib/domain/rounds';

const caller = (j: any, role: string): Caller => ({ jobId: j.id, agent: j.agent_id, role, kind: j.kind, threadId: j.thread_id, taskId: j.task_id });
const ok = { exitCode: 0, result: { subtype: 'success', total_cost_usd: 0.01, num_turns: 2 } };
const one = (db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as any;
const all = (db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as any[];

/** A running director respond job in a fresh general thread. */
function directorJob(db: DB) {
  const th = tx(db, () => createThread(db, 'general chat', { kind: 'user' }));
  tx(db, () => enqueueJob(db, { agent: 'director', kind: 'respond', thread: th }));
  return claim(db)!;
}
const spawnInput = (name = 'writer2', extra: Record<string, unknown> = {}) => ({ name, skill_note: 'Writes docs', why: 'two independent docs', ...extra });
function spawnApproval(db: DB, name = 'writer2', extra: Record<string, unknown> = {}) {
  const d = directorJob(db);
  const r: any = callTool(db, caller(d, 'director'), 'spawn_worker', spawnInput(name, extra));
  expect(r.ok).toBe(true);
  tx(db, () => finishAttempt(db, d.id, ok, ME));
  return { approval: r.approval_id as number, thread: d.thread_id as number };
}
const addWorker = (db: DB, name: string, usd = 2, jobs = 10) => tx(db, () => createWorkerByUser(db, { name, skill_note: `skill of ${name}`, daily_usd: usd, daily_jobs: jobs }));

describe('migration 2 (PHASE2 §T1)', () => {
  it('fresh DB reaches user_version 2, foreign_key_check is empty, seeds intact', () => {
    const db = freshEnv();
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(all(db, `SELECT id FROM agents ORDER BY id`).map((r) => r.id)).toEqual(['director', 'worker']);
  });
  it('MIGRATION_2_SQL equals the block in docs/PHASE2.md', () => {
    const md = fs.readFileSync(path.join(__dirname, '../../docs/PHASE2.md'), 'utf8');
    const m = md.match(/-- MIGRATION 2 BEGIN\n([\s\S]*?)-- MIGRATION 2 END/)!;
    expect(MIGRATION_2_SQL).toBe('-- MIGRATION 2 BEGIN\n' + m[1] + '-- MIGRATION 2 END');
  });
  it('a v1 database upgrades: tool_calls carried over, help_agent_id backfilled, second migrate() is a no-op', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    db.exec(`INSERT INTO channels(name, created_at) VALUES ('general', 1);
      INSERT INTO agents(id, display_name, role, allowed_tools, created_at) VALUES ('director','Director','director','[]',1), ('worker','Worker','worker','[]',1);
      INSERT INTO budgets(scope, period, limit_usd, limit_jobs, updated_at) VALUES ('global','day',5,60,1);`);
    db.pragma('user_version = 1');
    const th = (n: number) => Number(db.prepare(`INSERT INTO threads(channel_id,title,created_by_kind,created_at) VALUES (1,?,'user',1)`).run('t' + n).lastInsertRowid);
    const mk = (status: string, reason: string | null) => {
      const t = th(Math.random());
      const claimed = status === 'in_progress';
      return Number(db.prepare(`INSERT INTO tasks(title,status,assignee_agent_id,thread_id,created_by_kind,blocked_reason,claimed_by,claim_expires_at,created_at,updated_at)
        VALUES ('x',?,'worker',?,'user',?,?,?,1,1)`).run(status, t, reason, claimed ? 'worker' : null, claimed ? 1 : null).lastInsertRowid);
    };
    const helpTask = mk('blocked', 'help'), todo = mk('todo', null), workFailed = mk('blocked', 'job_failed'), helpFailed = mk('blocked', 'job_failed');
    const addJob = (task: number, kind: string, status: string) => db.prepare(`INSERT INTO jobs(agent_id,kind,thread_id,task_id,status,run_after,budget_cap_usd,created_at,finished_at)
      VALUES (?,?,(SELECT thread_id FROM tasks WHERE id=?),?,?,1,0.3,1,1)`).run(kind === 'help' ? 'director' : 'worker', kind, task, task, status);
    addJob(workFailed, 'work', 'failed'); addJob(helpFailed, 'help', 'failed');
    const jid = Number(addJob(todo, 'work', 'succeeded').lastInsertRowid);
    for (const [i, tool] of ['post_message', 'update_task', 'add_note'].entries())
      db.prepare(`INSERT INTO tool_calls(job_id,agent_id,tool,input_hash,input,outcome,result,created_at) VALUES (?,?,?,?,?,?,?,1)`).run(jid, 'worker', tool, 'h' + i, '{}', 'ok', '{}');
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(all(db, `SELECT tool FROM tool_calls ORDER BY id`).map((r) => r.tool)).toEqual(['post_message', 'update_task', 'add_note']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const h = (id: number) => one(db, `SELECT help_agent_id h FROM tasks WHERE id=?`, id).h;
    expect([h(helpTask), h(helpFailed), h(workFailed), h(todo)]).toEqual(['director', 'director', null, null]);
    migrate(db);                                                  // no-op
    expect(db.pragma('user_version', { simple: true })).toBe(2);
  });
});

describe('triggers (PHASE2 §T1)', () => {
  it('4th active worker aborts worker_cap; after retiring one it is ok', () => {
    const db = freshEnv();
    addWorker(db, 'w2'); addWorker(db, 'w3');
    const ins = (n: string) => db.prepare(`INSERT INTO agents(id,display_name,role,allowed_tools,created_at) VALUES (?,?,'worker','[]',1)`).run(n, n);
    expect(() => ins('w4')).toThrow(/worker_cap/);
    tx(db, () => { setEnabled(db, 'w3', false); retireAgent(db, 'w3'); });
    expect(() => ins('w4')).not.toThrow();
  });
  it('spawned insert needs an approved matching approval', () => {
    const db = freshEnv();
    const { approval } = spawnApproval(db);
    const ins = (id: string, skill: string, ap: number) => db.prepare(`INSERT INTO agents(id,display_name,role,allowed_tools,created_at,skill_note,spawn_approval_id) VALUES (?,?,'worker','[]',1,?,?)`).run(id, id, skill, ap);
    expect(() => ins('writer2', 'Writes docs', approval)).toThrow(/approval_required/);           // still pending
    db.prepare(`UPDATE approvals SET status='approved', decided_by='user', decided_at=1 WHERE id=?`).run(approval);
    expect(() => ins('other', 'Writes docs', approval)).toThrow(/approval_required/);             // name mismatch
    expect(() => ins('writer2', 'Something else', approval)).toThrow(/approval_required/);        // skill mismatch
    expect(() => ins('writer2', 'Writes docs', approval)).not.toThrow();
  });
  it('retire gate: director, enabled, open task, queued job, last worker, un-retire', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    expect(() => db.prepare(`UPDATE agents SET retired_at=1, enabled=0 WHERE id='director'`).run()).toThrow(/retire_invalid/);
    expect(() => db.prepare(`UPDATE agents SET retired_at=1 WHERE id='w2'`).run()).toThrow(/retire_invalid/);
    const { task_id } = tx(db, () => createTask(db, { title: 't', by: { kind: 'user' }, assignee: 'w2' }));
    db.prepare(`UPDATE agents SET enabled=0 WHERE id='w2'`).run();
    expect(() => db.prepare(`UPDATE agents SET retired_at=1, enabled=0 WHERE id='w2'`).run()).toThrow(/agent_has_open_tasks/);
    db.prepare(`UPDATE tasks SET status='cancelled' WHERE id=?`).run(task_id);
    expect(() => db.prepare(`UPDATE agents SET retired_at=1, enabled=0 WHERE id='w2'`).run()).toThrow(/agent_busy/);    // its queued work job
    db.prepare(`UPDATE jobs SET status='cancelled', finished_at=1 WHERE agent_id='w2'`).run();
    db.prepare(`UPDATE agents SET retired_at=1, enabled=0 WHERE id='w2'`).run();
    expect(() => db.prepare(`UPDATE agents SET enabled=1 WHERE id='w2'`).run()).toThrow(/agent_retired/);
    expect(() => db.prepare(`UPDATE agents SET retired_at=NULL WHERE id='w2'`).run()).toThrow(/agent_retired/);
    db.prepare(`UPDATE agents SET enabled=0 WHERE id='worker'`).run();
    expect(() => db.prepare(`UPDATE agents SET retired_at=1 WHERE id='worker'`).run()).toThrow(/last_worker/);
  });
  it('task assignee must be an active worker; help_agent_id only while blocked on help', () => {
    const db = freshEnv();
    const ins = (a: string) => db.prepare(`INSERT INTO tasks(title,status,assignee_agent_id,thread_id,created_by_kind,created_at,updated_at) VALUES ('x','todo',?,(SELECT id FROM threads LIMIT 1),'user',1,1)`).run(a);
    createThread(db, 'x', { kind: 'user' });
    expect(() => ins('director')).toThrow(/assignee_not_active_worker/);
    const { task_id } = userTask(db);
    expect(() => db.prepare(`UPDATE tasks SET assignee_agent_id='director' WHERE id=?`).run(task_id)).toThrow(/assignee_not_active_worker/);
    expect(() => db.prepare(`UPDATE tasks SET help_agent_id='director' WHERE id=?`).run(task_id)).toThrow(/help_agent_outside_help/);
  });
  it('only one pending spawn approval; tool_calls accepts spawn_worker only from the new list', () => {
    const db = freshEnv();
    spawnApproval(db, 'writer2');
    const d = directorJob(db);
    expect(callTool(db, caller(d, 'director'), 'spawn_worker', spawnInput('writer3'))).toMatchObject({ ok: false, error: 'spawn_pending' });
    const payload = JSON.stringify({ action: 'spawn_worker', name: 'x' });
    expect(() => db.prepare(`INSERT INTO approvals(kind,requested_by_agent_id,thread_id,summary,payload,payload_hash,created_at,expires_at) VALUES ('spend','director',?,'s',?,'h',1,2)`).run(d.thread_id, payload)).toThrow(/UNIQUE/);
    const ins = (tool: string) => db.prepare(`INSERT INTO tool_calls(job_id,agent_id,tool,input_hash,input,outcome,result,created_at) VALUES (?,?,?,?,?,?,?,1)`).run(d.id, 'director', tool, 'h' + tool, '{}', 'ok', '{}');
    expect(() => ins('foo')).toThrow(/CHECK/);
  });
});

describe('spawn approval A1-A3 (PHASE2 §T2, §T6.1)', () => {
  it('spawn_worker guards: auth, allowance, name, cap; replay returns the same approval', () => {
    const db = freshEnv();
    const d = directorJob(db);
    const c = caller(d, 'director');
    expect(callTool(db, c, 'spawn_worker', spawnInput('writer2', { daily_usd: 0.99 }))).toMatchObject({ error: 'allowance_below_job_cap' });
    expect(callTool(db, c, 'spawn_worker', spawnInput('worker'))).toMatchObject({ error: 'name_taken' });
    expect(callTool(db, c, 'spawn_worker', spawnInput('Bad-Name'))).toMatchObject({ error: 'validation_error' });
    const r1: any = callTool(db, c, 'spawn_worker', spawnInput('writer2', { daily_usd: 1 }));
    expect(r1).toMatchObject({ ok: true, status: 'pending' });
    expect(callTool(db, c, 'spawn_worker', spawnInput('writer2', { daily_usd: 1 }))).toEqual(r1);
    expect(callTool(db, c, 'spawn_worker', spawnInput('writer3'))).toMatchObject({ error: 'validation_error' });       // one per job
    const pay = JSON.parse(one(db, `SELECT payload p FROM approvals WHERE id=?`, r1.approval_id).p);
    expect(pay).toEqual({ action: 'spawn_worker', name: 'writer2', skill_note: 'Writes docs', model: 'sonnet', daily_usd: 1, daily_jobs: 10 });
    // a worker or a director review/help job cannot call it
    const w = userTask(db); const wj = (tx(db, () => finishAttempt(db, d.id, ok, ME)), claim(db)!);
    expect(callTool(db, caller(wj, 'worker'), 'spawn_worker', spawnInput('x1'))).toMatchObject({ error: 'not_allowed_for_role' });
    expect(w.task_id).toBeGreaterThan(0);
    expect(callTool(db, { ...caller(d, 'director'), kind: 'review' }, 'spawn_worker', spawnInput('x1'))).toMatchObject({ error: 'not_allowed_for_role' });
    expect(callTool(db, { ...caller(d, 'director'), kind: 'help' }, 'spawn_worker', spawnInput('x1'))).toMatchObject({ error: 'not_allowed_for_role' });
  });
  it('worker_cap: 3 active workers -> tool result worker_cap and no approval row', () => {
    const db = freshEnv();
    addWorker(db, 'w2'); addWorker(db, 'w3');
    const d = directorJob(db);
    expect(callTool(db, caller(d, 'director'), 'spawn_worker', spawnInput())).toMatchObject({ error: 'worker_cap' });
    expect(one(db, `SELECT count(*) n FROM approvals`).n).toBe(0);
  });
  it('request_approval refuses spawn payloads', () => {
    const db = freshEnv();
    const d = directorJob(db);
    const r = callTool(db, caller(d, 'director'), 'request_approval', { kind: 'spend', summary: 's', payload: { action: 'spawn_worker', name: 'sneaky' } });
    expect(r).toMatchObject({ ok: false, error: 'validation_error', hint: 'use spawn_worker' });
    expect(one(db, `SELECT count(*) n FROM approvals`).n).toBe(0);
  });
  it('approve: agent + budget row + consumed approval in one txn, one director respond job, system line', () => {
    const db = freshEnv();
    const { approval, thread } = spawnApproval(db, 'writer2', { daily_usd: 1.5, daily_jobs: 7 });
    const r = tx(db, () => decideApproval(db, approval, 'approved', undefined, { raise_concurrency_to: 3 }));
    expect(r).toMatchObject({ status: 'consumed', agent_id: 'writer2', reason: null });
    expect(typeof r.resumed).toBe('number');
    expect(one(db, `SELECT spawn_approval_id s, skill_note n, enabled e, model m FROM agents WHERE id='writer2'`)).toEqual({ s: approval, n: 'Writes docs', e: 1, m: 'sonnet' });
    expect(one(db, `SELECT limit_usd u, limit_jobs j FROM budgets WHERE scope='agent' AND agent_id='writer2' AND period='day'`)).toEqual({ u: 1.5, j: 7 });
    expect(one(db, `SELECT status, consumed_at IS NOT NULL c FROM approvals WHERE id=?`, approval)).toEqual({ status: 'consumed', c: 1 });
    expect(one(db, `SELECT max_concurrency m FROM system_state`).m).toBe(3);
    expect(one(db, `SELECT count(*) n FROM events WHERE type='settings.changed' AND entity_type='budget'`).n).toBe(1);
    expect(all(db, `SELECT id, thread_id FROM jobs WHERE agent_id='director' AND kind='respond' AND status='queued'`)).toEqual([{ id: r.resumed, thread_id: thread }]);
    expect(one(db, `SELECT body FROM messages WHERE thread_id=? AND author_kind='system'`, thread).body).toBe('writer2 joined (approved by you). Allowance $1.50 est./day, 7 runs/day. Director will assign work.');
    for (const t of ['approval.decided', 'approval.consumed']) expect(one(db, `SELECT count(*) n FROM events WHERE type=?`, t).n).toBe(1);
    expect(fs.existsSync(path.join(process.env.SLACKBOARD_HOME!, 'agents', 'writer2'))).toBe(true);
  });
  it('approve at the cap, with a taken name, an invalid stored payload or a bad raise: error and approval stays pending', () => {
    const db = freshEnv();
    const { approval } = spawnApproval(db);
    const state = () => ({ st: one(db, `SELECT status s FROM approvals WHERE id=?`, approval).s, agents: one(db, `SELECT count(*) n FROM agents`).n, jobs: one(db, `SELECT count(*) n FROM jobs WHERE status='queued'`).n });
    const before = state();
    expect(() => tx(db, () => decideApproval(db, approval, 'approved', undefined, { raise_concurrency_to: 5 }))).toThrow(/validation_error/);
    expect(state()).toEqual(before);
    addWorker(db, 'w2'); addWorker(db, 'w3');
    expect(() => tx(db, () => decideApproval(db, approval, 'approved'))).toThrow(/worker_cap/);
    expect(state().st).toBe('pending');
    // stored payload invalid (inserted directly): invalid_payload, nothing created
    const db2 = freshEnv();
    const th = tx(db2, () => createThread(db2, 'x', { kind: 'user' }));
    const bad = (payload: object) => Number(db2.prepare(`INSERT INTO approvals(kind,requested_by_agent_id,thread_id,summary,payload,payload_hash,created_at,expires_at,status)
      VALUES ('spend','director',?,'s',?,'h',1,?, 'pending')`).run(th, JSON.stringify({ action: 'spawn_worker', name: 'wx', skill_note: 's', model: 'sonnet', daily_usd: 2, daily_jobs: 5, ...payload }), Date.now() + 1e6).lastInsertRowid);
    db2.prepare(`UPDATE approvals SET status='rejected', decided_by='user', decided_at=1 WHERE status='pending'`).run();
    const a1 = bad({ daily_usd: 0.5 });
    expect(() => tx(db2, () => decideApproval(db2, a1, 'approved'))).toThrow(/invalid_payload/);
    db2.prepare(`UPDATE approvals SET status='rejected', decided_by='user', decided_at=1 WHERE id=?`).run(a1);
    const a2 = bad({ model: 'opus' });
    let err: any; try { tx(db2, () => decideApproval(db2, a2, 'approved')); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'invalid_payload', status: 400 });
    expect(one(db2, `SELECT status s FROM approvals WHERE id=?`, a2).s).toBe('pending');
    expect(one(db2, `SELECT count(*) n FROM agents WHERE id='wx'`).n).toBe(0);
  });
  it('a failing budget insert rolls back the agent too', () => {
    const db = freshEnv();
    const { approval } = spawnApproval(db);
    db.exec(`CREATE TRIGGER force_fail BEFORE INSERT ON budgets WHEN NEW.scope='agent' BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
    expect(() => tx(db, () => decideApproval(db, approval, 'approved'))).toThrow(/forced/);
    expect(one(db, `SELECT count(*) n FROM agents WHERE id='writer2'`).n).toBe(0);
    expect(one(db, `SELECT status s FROM approvals WHERE id=?`, approval).s).toBe('pending');
  });
  it('capped or closed origin thread: agent created, no director job, resumed null + reason, second system line; user reply wakes once', () => {
    for (const [status, reason, word] of [['capped', 'thread_capped', 'capped'], ['closed', 'thread_closed', 'closed']] as const) {
      const db = freshEnv();
      const { approval, thread } = spawnApproval(db);
      if (status === 'capped') db.prepare(`UPDATE threads SET status='capped' WHERE id=?`).run(thread);
      else db.prepare(`UPDATE threads SET status='closed', closed_at=1 WHERE id=?`).run(thread);
      const r = tx(db, () => decideApproval(db, approval, 'approved'));
      expect(r).toMatchObject({ status: 'consumed', agent_id: 'writer2', resumed: null, reason });
      expect(one(db, `SELECT count(*) n FROM jobs WHERE agent_id='director' AND status='queued'`).n).toBe(0);
      expect(all(db, `SELECT body FROM messages WHERE thread_id=? AND author_kind='system' ORDER BY id`, thread).map((m) => m.body)[1])
        .toBe(`writer2 added. Director not woken: thread ${word}. Raise the cap or reopen, then reply in the thread to wake it.`);
      if (status === 'capped') {
        db.prepare(`UPDATE threads SET status='open' WHERE id=?`).run(thread);                        // raise cap: still no job (task-less origin thread)
        expect(one(db, `SELECT count(*) n FROM jobs WHERE agent_id='director' AND status='queued'`).n).toBe(0);
        tx(db, () => postUserMessage(db, thread, 'go on'));
        expect(one(db, `SELECT count(*) n FROM jobs WHERE agent_id='director' AND status='queued'`).n).toBe(1);
      }
    }
  });
  it('reject and expire: system line only, no agent, no budget row, no job', () => {
    const db = freshEnv();
    const a = spawnApproval(db, 'writer2');
    tx(db, () => decideApproval(db, a.approval, 'rejected', 'no'));
    const b = spawnApproval(db, 'writer3');
    db.prepare(`UPDATE approvals SET expires_at=1 WHERE id=?`).run(b.approval);
    tx(db, () => expireApprovals(db));
    expect(one(db, `SELECT count(*) n FROM agents WHERE id IN ('writer2','writer3')`).n).toBe(0);
    expect(one(db, `SELECT count(*) n FROM budgets WHERE scope='agent'`).n).toBe(0);
    expect(one(db, `SELECT count(*) n FROM jobs WHERE status='queued'`).n).toBe(0);
    expect(one(db, `SELECT status s FROM approvals WHERE id=?`, b.approval).s).toBe('expired');
    expect(one(db, `SELECT body FROM messages WHERE thread_id=? AND author_kind='system'`, a.thread).body).toBe('Add worker writer2 rejected by you. Note: no');
    expect(one(db, `SELECT body FROM messages WHERE thread_id=? AND author_kind='system'`, b.thread).body).toBe('Add worker writer3 expired');
  });
  it('allowance minimum: 0.99 rejected by user-create and budgets, 1.00 accepted', () => {
    const db = freshEnv();
    expect(() => addWorker(db, 'w2', 0.99)).toThrow(/allowance_below_job_cap/);
    addWorker(db, 'w2', 1.0);
    expect(() => tx(db, () => setAgentBudget(db, 'w2', 0.5, 5))).toThrow(/allowance_below_job_cap/);
    tx(db, () => setAgentBudget(db, 'w2', 1.0, 5));
    try { tx(db, () => setAgentBudget(db, 'w2', 0.99, 5)); } catch (e: any) { expect(e.code).toBe('allowance_below_job_cap'); expect(e.status).toBe(400); }
  });
});

describe('retire A6, reassign R1, zero enabled workers', () => {
  it('retire order: open task -> agent_has_open_tasks (queued job untouched); running -> agent_busy; last worker; ok cancels queued', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    const { task_id } = tx(db, () => createTask(db, { title: 't', by: { kind: 'user' }, assignee: 'w2' }));
    let err: any; try { tx(db, () => retireAgent(db, 'w2')); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'agent_has_open_tasks' });
    expect(err.extra.tasks).toEqual([{ id: task_id, status: 'todo', actions: ['reassign', 'cancel'] }]);
    expect(one(db, `SELECT status s FROM jobs WHERE agent_id='w2'`).s).toBe('queued');
    const w2job = claim(db)!;                                         // worker is first? make sure we got w2's or worker's job
    if (w2job.agent_id !== 'w2') { /* only w2 has a job */ }
    expect(w2job.agent_id).toBe('w2');
    tx(db, () => { db.prepare(`UPDATE tasks SET status='cancelled', claimed_by=NULL, claim_expires_at=NULL WHERE id=?`).run(task_id); });
    expect(() => tx(db, () => retireAgent(db, 'w2'))).toThrow(/agent_busy/);
    tx(db, () => finishAttempt(db, w2job.id, ok, ME));
    const q = tx(db, () => enqueueJob(db, { agent: 'w2', kind: 'respond', thread: w2job.thread_id }));
    tx(db, () => retireAgent(db, 'w2'));
    expect(job(db, q).status).toBe('cancelled');
    expect(one(db, `SELECT retired_at IS NOT NULL r, enabled e, presence p FROM agents WHERE id='w2'`)).toEqual({ r: 1, e: 0, p: 'disabled' });
    expect(one(db, `SELECT count(*) n FROM budgets WHERE agent_id='w2'`).n).toBe(1);
    expect(() => tx(db, () => retireAgent(db, 'worker'))).toThrow(/last_worker/);
  });
  it('retired agent: removed from enums, create_task unknown_assignee, queued job never claimed, name stays taken', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    tx(db, () => { setEnabled(db, 'w2', false); retireAgent(db, 'w2'); });
    const d = directorJob(db);
    const tools = publishedTools(db, { role: 'director', kind: 'respond' });
    expect(tools.find((t) => t.name === 'create_task')!.inputSchema.properties.assignee.enum).toEqual(['worker']);
    expect(callTool(db, caller(d, 'director'), 'create_task', { title: 'x', description: '', acceptance: 'y', assignee: 'w2' })).toMatchObject({ error: 'unknown_assignee' });
    expect(callTool(db, caller(d, 'director'), 'spawn_worker', spawnInput('w2'))).toMatchObject({ error: 'name_taken' });
    expect(callTool(db, caller(d, 'director'), 'post_message', { body: 'hi', mentions: ['w2'] })).toMatchObject({ error: 'unknown_agent' });
  });
  it('reassign guard order and effects', () => {
    const db = freshEnv();
    addWorker(db, 'w2'); addWorker(db, 'w3');
    const { task_id } = userTask(db);
    const t = () => getTask(db, task_id)!;
    expect(() => tx(db, () => reassignTask(db, t(), 'director'))).toThrow(/assignee_not_active_worker/);
    tx(db, () => setEnabled(db, 'w3', false));
    expect(() => tx(db, () => reassignTask(db, t(), 'w3'))).toThrow(/assignee_disabled/);
    tx(db, () => reassignTask(db, t(), 'w2'));
    expect(t().assignee_agent_id).toBe('w2');
    expect(all(db, `SELECT agent_id, status FROM jobs WHERE task_id=? ORDER BY id`, task_id)).toEqual([{ agent_id: 'worker', status: 'cancelled' }, { agent_id: 'w2', status: 'queued' }]);
    // blocked/help -> help_pending, nothing changed; blocked/job_failed to its helper -> assignee_is_helper
    db.prepare(`UPDATE tasks SET status='blocked', blocked_reason='help', help_agent_id='director' WHERE id=?`).run(task_id);
    let e1: any; try { tx(db, () => reassignTask(db, t(), 'worker')); } catch (e) { e1 = e; }
    expect(e1).toMatchObject({ code: 'help_pending', hint: 'Waiting on director; reroute help or reply first' });
    db.prepare(`UPDATE tasks SET blocked_reason='job_failed', help_agent_id='w2' WHERE id=?`).run(task_id);
    expect(() => tx(db, () => reassignTask(db, t(), 'w2'))).toThrow(/assignee_is_helper/);
    // an approved agent top-level task is immutable
    const th = createThread(db, 'p', { kind: 'user' });
    const ag = Number(db.prepare(`INSERT INTO tasks(title,status,assignee_agent_id,thread_id,created_by_kind,created_by_agent_id,created_at,updated_at) VALUES ('a','proposed','worker',?,'agent','director',1,1)`).run(th).lastInsertRowid);
    db.prepare(`INSERT INTO approvals(kind,requested_by_agent_id,thread_id,task_id,summary,payload,payload_hash,status,decided_by,decided_at,created_at,expires_at) VALUES ('create_top_level_task','director',?,?,'s','{}','h','approved','user',1,1,2)`).run(th, ag);
    db.prepare(`UPDATE tasks SET status='todo' WHERE id=?`).run(ag);
    expect(() => tx(db, () => reassignTask(db, getTask(db, ag)!, 'w2'))).toThrow(/approved_task_immutable/);
  });
  it('retired assignee: reopen of a done task -> assignee_retired, no job; the unblock path runs the same check', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    const { task_id } = tx(db, () => createTask(db, { title: 't', by: { kind: 'user' }, assignee: 'w2' }));
    db.prepare(`UPDATE jobs SET status='cancelled', finished_at=1 WHERE task_id=?`).run(task_id);
    db.prepare(`UPDATE tasks SET status='in_progress', claimed_by='w2', claim_expires_at=1 WHERE id=?`).run(task_id);
    db.prepare(`UPDATE tasks SET status='in_review', claimed_by=NULL, claim_expires_at=NULL WHERE id=?`).run(task_id);
    db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(task_id);
    tx(db, () => { setEnabled(db, 'w2', false); retireAgent(db, 'w2'); });
    const before = one(db, `SELECT count(*) n FROM jobs`).n;
    let err: any; try { tx(db, () => reopenTask(db, task(db, task_id), 'again')); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'assignee_retired', status: 409 });
    expect(task(db, task_id).status).toBe('done');
    expect(one(db, `SELECT count(*) n FROM jobs`).n).toBe(before);
    let err2: any; try { tx(db, () => unblockTask(db, { ...task(db, task_id), status: 'blocked', blocked_reason: 'job_failed' }, 'user', 'retry', { clean: true, head: null })); } catch (e) { err2 = e; }
    expect(err2).toMatchObject({ code: 'assignee_retired' });
  });
  it('zero enabled workers: create_task/user create -> no_enabled_worker, enum omitted, <team> says so, grace on enable', () => {
    const db = freshEnv();
    const d = directorJob(db);
    tx(db, () => setEnabled(db, 'worker', false));
    const c = caller(d, 'director');
    expect(callTool(db, c, 'create_task', { title: 'x', description: '', acceptance: 'y', assignee: 'worker' })).toMatchObject({ error: 'no_enabled_worker' });
    expect(callTool(db, c, 'create_task', { title: 'x', description: '', acceptance: 'y' })).toMatchObject({ error: 'no_enabled_worker' });
    expect(() => userTask(db)).toThrow(/no_enabled_worker/);
    expect(one(db, `SELECT count(*) n FROM tasks`).n).toBe(0);
    expect(publishedTools(db, { role: 'director', kind: 'respond' }).find((t) => t.name === 'create_task')!.inputSchema.properties.assignee).toBeUndefined();
    expect(team(db)).toContain('no enabled worker');
    expect(one(db, `SELECT presence p FROM agents WHERE id='worker'`).p).toBe('disabled');
  });
});

describe('tools: generated enums vs validate() (PHASE2 §T6)', () => {
  it('static base schema accepts any string; membership is checked in dispatch', () => {
    const db = freshEnv();
    addWorker(db, 'writer2');
    expect(validate('create_task', { title: 'x', description: '', acceptance: 'y', assignee: 'writer2' })).toBeNull();
    expect(validate('post_message', { body: 'x', mentions: ['writer2'] })).toBeNull();
    expect(validate('spawn_worker', spawnInput('Bad'))).toMatch(/format/);
    expect(validate('spawn_worker', spawnInput('ok_name', { daily_usd: 3.5 }))).toMatch(/range/);
    const d = directorJob(db);
    const c = caller(d, 'director');
    const r: any = callTool(db, c, 'create_task', { title: 'Docs', description: '', acceptance: '1. y', assignee: 'writer2' });
    expect(r).toMatchObject({ ok: true, status: 'proposed' });
    expect(callTool(db, c, 'create_task', { title: 'x2', description: '', acceptance: 'y', assignee: 'nobody' })).toMatchObject({ error: 'unknown_assignee' });
    tx(db, () => setEnabled(db, 'writer2', false));
    expect(callTool(db, c, 'create_task', { title: 'x3', description: '', acceptance: 'y', assignee: 'writer2' })).toMatchObject({ error: 'unknown_assignee' });
    expect(callTool(db, c, 'post_message', { body: 'x', mentions: ['nobody'] })).toMatchObject({ error: 'unknown_agent' });
    expect(callTool(db, c, 'post_message', { body: 'x', mentions: ['writer2'] })).toMatchObject({ ok: true });      // active (disabled but not retired) is a valid mention
    expect(publishedTools(db, { role: 'director', kind: 'respond' }).map((t) => t.name)).toEqual(
      ['post_message', 'create_task', 'update_task', 'add_note', 'request_help', 'request_approval', 'spawn_worker']);
  });
  it('create_task default assignee is the enabled worker with the fewest open tasks (ties by created_at)', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    const a = tx(db, () => createTask(db, { title: 'a', by: { kind: 'user' } }));
    const b = tx(db, () => createTask(db, { title: 'b', by: { kind: 'user' } }));
    const c = tx(db, () => createTask(db, { title: 'c', by: { kind: 'user' } }));
    expect([a, b, c].map((x) => task(db, x.task_id).assignee_agent_id)).toEqual(['worker', 'w2', 'worker']);
  });
  it('director wake targets the task assignee only', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    const { task_id } = tx(db, () => createTask(db, { title: 't', by: { kind: 'user' }, assignee: 'w2' }));
    const t = task(db, task_id);
    const dd = { id: 0, agent_id: 'director', kind: 'respond', thread_id: t.thread_id, task_id: t.id } as any;
    const r = tx(db, () => enqueueJob(db, { agent: 'director', kind: 'respond', thread: t.thread_id, task: t.id }));
    db.prepare(`UPDATE jobs SET status='running', lease_owner='x', lease_expires_at=1, started_at=1 WHERE id=?`).run(r);
    const c = { ...caller(dd, 'director'), jobId: r };
    expect(callTool(db, c, 'post_message', { body: 'go', mentions: ['worker'], wake: true })).toMatchObject({ error: 'wrong_agent' });
    expect(callTool(db, c, 'post_message', { body: 'go', mentions: ['director'], wake: true })).toMatchObject({ error: 'validation_error' });
    expect(callTool(db, c, 'post_message', { body: 'go', mentions: ['w2'], wake: true })).toMatchObject({ ok: true });
    expect(one(db, `SELECT count(*) n FROM jobs WHERE agent_id='w2' AND kind='respond' AND status='queued'`).n).toBe(1);
  });
});

describe('claim: slots, per-agent budget, queueReason (PHASE2 §T5.1)', () => {
  const taskFor = (db: DB, agent: string, title = 't') => tx(db, () => createTask(db, { title, by: { kind: 'user' }, assignee: agent })).task_id;
  const directorQueued = (db: DB) => tx(db, () => enqueueJob(db, { agent: 'director', kind: 'respond', thread: createThread(db, 'c', { kind: 'user' }) }));

  it('(i) max_concurrency 3: 3 queued worker jobs + director -> 2 workers and the director run', () => {
    const db = freshEnv();
    addWorker(db, 'w2'); addWorker(db, 'w3');
    db.prepare(`UPDATE system_state SET max_concurrency=3`).run();
    for (const a of ['worker', 'w2', 'w3']) taskFor(db, a);
    directorQueued(db);
    const got = [claim(db), claim(db), claim(db), claim(db)].filter(Boolean).map((j) => j!.agent_id).sort();
    expect(got).toHaveLength(3);
    expect(got.filter((a) => a === 'director')).toHaveLength(1);
    expect(got.filter((a) => a !== 'director')).toHaveLength(2);
    // the third worker's reason
    const waiting = ['worker', 'w2', 'w3'].find((a) => !got.includes(a))!;
    expect(queueReason(db, waiting)).toBe('run slots 3/3');
  });
  it('director slot reserved: with max 2, a second worker waits even though a slot is free', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    taskFor(db, 'worker'); taskFor(db, 'w2');
    expect(claim(db)).not.toBeNull();
    expect(claim(db)).toBeNull();
    expect(queueReason(db, 'w2')).toBe('director slot reserved');
    directorQueued(db);
    expect(claim(db)!.agent_id).toBe('director');
  });
  it('(ii) max_concurrency 1: a worker job may run', () => {
    const db = freshEnv();
    db.prepare(`UPDATE system_state SET max_concurrency=1`).run();
    taskFor(db, 'worker');
    expect(claim(db)!.agent_id).toBe('worker');
  });
  it('(iii) per-agent room: over-limit agent excluded while others claim; queueReason agent budget; boundary at 1.00', () => {
    const db = freshEnv();
    addWorker(db, 'w2', 1.5, 10);
    db.prepare(`UPDATE system_state SET max_concurrency=4`).run();
    const ta = taskFor(db, 'w2', 'a'); taskFor(db, 'w2', 'b'); taskFor(db, 'worker', 'c');
    const first = claim(db)!;
    expect(first.agent_id).toBe('w2');
    tx(db, () => finishAttempt(db, first.id, { exitCode: 0, result: { subtype: 'success', total_cost_usd: 0.6, num_turns: 1 } }, ME));
    // room 0.90 < cap 1.00: the next w2 job stays queued, worker's is claimed
    expect(claim(db)!.agent_id).toBe('worker');
    expect(claim(db)).toBeNull();
    expect(queueReason(db, 'w2')).toBe('agent budget');
    expect(one(db, `SELECT presence p, presence_detail d FROM agents WHERE id='w2'`)).toEqual({ p: 'paused', d: 'agent budget' });
    expect(one(db, `SELECT count(*) n FROM events WHERE type='job.started' AND json_extract(payload,'$.agent')='w2'`).n).toBe(1);
    // budget.hit: once per agent per day, even after further ticks
    tx(db, () => agentBudgetHits(db)); tx(db, () => agentBudgetHits(db));
    expect(all(db, `SELECT payload FROM events WHERE type='budget.hit'`).map((e) => JSON.parse(e.payload))).toEqual([{ scope: 'agent', agent: 'w2' }]);
    const line = all(db, `SELECT thread_id, body FROM messages WHERE author_kind='system' AND body LIKE 'w2 reached%'`);
    expect(line).toHaveLength(1);
    expect(line[0].body).toBe('w2 reached its daily allowance ($0.60/$1.50 est.); its runs wait until 00:00. [Edit budget]');
    expect(line[0].thread_id).toBe(task(db, ta).thread_id);          // the first queued w2 job (a's no-handoff requeue)
    // exactly 1.00 limit, nothing spent: claimed; after 0.01 spent: not
    const db2 = freshEnv();
    addWorker(db2, 'w2', 1.0, 10); db2.prepare(`UPDATE system_state SET max_concurrency=4`).run();
    taskFor(db2, 'w2');
    expect(claim(db2)!.agent_id).toBe('w2');
    const db3 = freshEnv();
    addWorker(db3, 'w2', 1.0, 10); db3.prepare(`UPDATE system_state SET max_concurrency=4`).run();
    const x = taskFor(db3, 'w2');
    db3.prepare(`INSERT INTO events(ts,type,actor,job_id,payload) VALUES (?,?,?,?,?)`).run(Date.now(), 'job.attempt_finished', 'system',
      tx(db3, () => Number(db3.prepare(`INSERT INTO jobs(agent_id,kind,thread_id,task_id,status,run_after,budget_cap_usd,created_at,finished_at) VALUES ('w2','respond',?,NULL,'succeeded',1,0.3,1,1)`).run(task(db3, x).thread_id).lastInsertRowid)), '{"cost_usd":0.01}');
    expect(claim(db3)).toBeNull();
    expect(queueReason(db3, 'w2')).toBe('agent budget');
  });
  it('per-agent run limit gates too', () => {
    const db = freshEnv();
    addWorker(db, 'w2', 3, 1); db.prepare(`UPDATE system_state SET max_concurrency=4`).run();
    taskFor(db, 'w2', 'a');
    const j = claim(db)!;
    tx(db, () => finishAttempt(db, j.id, ok, ME));
    const t2 = taskFor(db, 'w2', 'b');
    expect(claim(db)).toBeNull();
    expect(queueReason(db, 'w2')).toBe('agent budget');
    expect(t2).toBeGreaterThan(0);
  });
  it('(iii-c) queueReason order: disabled > busy > run slots > director slot > job cap > daily budget > agent budget > thread capped', () => {
    const db = freshEnv();
    addWorker(db, 'w2', 1.5, 10);
    db.prepare(`UPDATE system_state SET max_concurrency=2`).run();
    const a = taskFor(db, 'worker'), b = taskFor(db, 'w2');
    const w = claim(db)!;
    expect(w.agent_id).toBe('worker');
    expect(queueReason(db, 'w2')).toBe('director slot reserved');
    db.prepare(`UPDATE budgets SET limit_jobs=1 WHERE scope='global' AND period='day'`).run();
    expect(queueReason(db, 'w2')).toBe('director slot reserved');
    tx(db, () => finishAttempt(db, w.id, { exitCode: 1 }, ME));                       // requeued (J11) with run_after
    expect(queueReason(db, 'worker')).toBe('job cap');
    db.prepare(`UPDATE budgets SET limit_jobs=60 WHERE scope='global' AND period='day'`).run();
    db.prepare(`UPDATE budgets SET limit_usd=0.5 WHERE scope='global' AND period='day'`).run();
    expect(queueReason(db, 'w2')).toBe('daily budget');
    db.prepare(`UPDATE budgets SET limit_usd=5 WHERE scope='global' AND period='day'`).run();
    db.prepare(`UPDATE threads SET status='capped' WHERE id=?`).run(task(db, b).thread_id);
    expect(queueReason(db, 'w2')).toBe('thread capped');
    db.prepare(`UPDATE agents SET enabled=0 WHERE id='w2'`).run();
    expect(queueReason(db, 'w2')).toBe('disabled');
    expect(a).toBeGreaterThan(0);
  });
  it('(iv) a retired agent never has a queued job claimed', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    const t = taskFor(db, 'w2');
    db.prepare(`UPDATE tasks SET status='cancelled' WHERE id=?`).run(t);
    db.prepare(`UPDATE jobs SET status='cancelled', finished_at=1 WHERE task_id=?`).run(t);
    db.prepare(`UPDATE agents SET retired_at=1, enabled=0 WHERE id='w2'`).run();
    // simulate a stray queued job on a retired agent (A6 normally cancels them), on a live task
    db.prepare(`INSERT INTO jobs(agent_id,kind,thread_id,status,run_after,budget_cap_usd,created_at) VALUES ('w2','respond',?,'queued',1,0.3,1)`).run(task(db, t).thread_id);
    expect(claim(db)).toBeNull();
    db.prepare(`UPDATE agents SET enabled=1 WHERE id='worker'`).run();
    expect(queueReason(db, 'w2')).toBe('disabled');
  });
  it('(vi) 1,000-race: never two running jobs per agent with 3 workers', () => {
    const db = freshEnv();
    addWorker(db, 'w2'); addWorker(db, 'w3');
    db.prepare(`UPDATE system_state SET max_concurrency=4`).run();
    for (let i = 0; i < 6; i++) for (const a of ['worker', 'w2', 'w3']) taskFor(db, a, `${a}${i}`);
    for (let i = 0; i < 1000; i++) {
      const j = claim(db);
      const running = all(db, `SELECT agent_id, count(*) n FROM jobs WHERE status='running' GROUP BY agent_id`);
      expect(running.every((r) => r.n === 1)).toBe(true);
      expect(running.length).toBeLessThanOrEqual(3);
      if (!j && i > 10) break;
    }
  });
});

describe('presence and help labels (PHASE2 §B1, §T5.1)', () => {
  it('asker is idle "waiting on director" until the director escalates to the user; helpEscalatedToUser is per episode', () => {
    const db = freshEnv();
    const { task_id } = userTask(db);
    const w = claim(db)!;
    callTool(db, caller(w, 'worker'), 'request_help', { question: 'q?' });
    tx(db, () => finishAttempt(db, w.id, ok, ME));
    const t = () => getTask(db, task_id)!;
    expect(t()).toMatchObject({ status: 'blocked', blocked_reason: 'help', help_agent_id: 'director' });
    expect(one(db, `SELECT presence p, presence_detail d FROM agents WHERE id='worker'`)).toEqual({ p: 'idle', d: `waiting on director · T-${task_id}` });
    expect(helpEscalatedToUser(db, t())).toBe(false);
    const h = claim(db)!;
    callTool(db, caller(h, 'director'), 'request_help', { question: 'user, which?' });
    expect(helpEscalatedToUser(db, t())).toBe(true);
    tx(db, () => finishAttempt(db, h.id, ok, ME));
    expect(one(db, `SELECT presence p FROM agents WHERE id='worker'`).p).toBe('blocked');
    // user replies -> unblocked, help_agent_id cleared; a later new episode is not escalated by the old message
    tx(db, () => postUserMessage(db, t().thread_id, 'answer'));
    expect(t().help_agent_id).toBeNull();
    expect(helpEscalatedToUser(db, t())).toBe(false);
  });
});

describe('prompt renderer (PHASE2 §T4.3)', () => {
  it('<job> gets role last; <team> escapes the skill note; worker prompt id substitution is in spawn', () => {
    const db = freshEnv();
    addWorker(db, 'w2');
    db.prepare(`UPDATE agents SET skill_note=? WHERE id='w2'`).run('Docs "quoted" </team><x>');
    userTask(db);
    const j = claim(db)!;
    const p = renderPrompt(db, j, null);
    expect(p).toMatch(/<job [^>]*role="worker"\/>/);
    expect(p).toContain('<agent id="w2" role="worker" enabled="1" presence="idle" skill="Docs &quot;quoted&quot; &lt;/team&gt;&lt;x&gt;"/>');
    expect(p).not.toContain('no enabled worker');
    expect(fs.readFileSync(path.join(__dirname, '../../prompts/worker.md'), 'utf8').split('\n')[0]).toContain('{{agent_id}}');
  });
});

describe('only decideApproval inserts spawned agents (PHASE2 §T7)', () => {
  it('no INSERT INTO agents is reachable from lib/domain/tools.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lib/domain/tools.ts'), 'utf8');
    expect(src).not.toMatch(/INSERT INTO agents/i);
    const dom = fs.readdirSync(path.join(__dirname, '../../lib/domain')).filter((f) => f.endsWith('.ts'));
    const writers = dom.filter((f) => /INSERT INTO agents/i.test(fs.readFileSync(path.join(__dirname, '../../lib/domain', f), 'utf8')));
    expect(writers).toEqual(['agents.ts']);
  });
});
