import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Env } from './harness';
import { setDbForTests } from '@/lib/db';
import { createThread } from '@/lib/domain/threads';
import { postUserMessage } from '@/lib/domain/wake';
import { decideApproval, acceptTask, createTask } from '@/lib/domain/tasks';
import { createWorkerByUser } from '@/lib/domain/agents';
import { publishedTools } from '@/lib/domain/tools';
import { getTask } from '@/lib/domain/rounds';
import { retire, addAgent, setBudgets } from '@/lib/server/actions';
import { bootstrap } from '@/lib/server/read';

let env: Env;
afterEach(async () => { setDbForTests(null); await env?.stop(); });
const doctor = () => env.until(() => env.one(`SELECT doctor_ok_at FROM system_state`).doctor_ok_at, 30000, 'doctor');

describe('P2-S1 spawn flow (PHASE2 §A6)', () => {
  it('spawn -> approve (raise to 3) -> two tasks in parallel -> both reviewed and approved', async () => {
    const started = Date.now();
    const work = (name: string) => [{ sleep: 3500 }, { write: { path: 'OUT.md', content: `# ${name}\n` } },
      { tool: { name: 'update_task', input: { task_id: '{{task_id}}', action: 'submit_for_review', note: 'done' } } }];
    env = new Env({
      'director:respond:joined': [
        { tool: { name: 'create_task', input: { title: 'Write docs/A.md', description: 'A', acceptance: '1. A exists', assignee: 'worker', why: 'independent' } } },
        { tool: { name: 'create_task', input: { title: 'Write docs/B.md', description: 'B', acceptance: '1. B exists', assignee: 'writer2', why: 'independent' } } }],
      'director:respond': [{ tool: { name: 'spawn_worker', input: { name: 'writer2', skill_note: 'Writes user-facing docs', why: 'two independent docs requested',
        daily_usd: 2, daily_jobs: 10 } } }],
      'worker:work': work('A'), 'writer2:work': work('B'),
    });
    env.start();
    await doctor();
    // sampler for (c): running jobs <= 3, running worker jobs <= 2, never two for one agent
    let maxRunning = 0, maxWorkers = 0, dup = 0;
    const sampler = setInterval(() => {
      const r = env.one(`SELECT count(*) n, sum(a.role='worker') w, count(DISTINCT j.agent_id) d FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE j.status='running'`);
      maxRunning = Math.max(maxRunning, r.n); maxWorkers = Math.max(maxWorkers, r.w ?? 0); if (r.d !== r.n) dup++;
    }, 50);
    try {
      env.tx(() => env.db.prepare(`UPDATE system_state SET max_concurrency=2`).run());
      const th = env.tx(() => createThread(env.db, 'Write docs/A.md and docs/B.md (independent)', { kind: 'user' }));
      env.tx(() => postUserMessage(env.db, th, '@director Write docs/A.md and docs/B.md (independent)'));
      const sp = await env.until(() => env.one(`SELECT * FROM approvals WHERE status='pending' AND kind='spend'`), 30000, 'spawn approval');
      expect(JSON.parse(sp.payload)).toMatchObject({ action: 'spawn_worker', name: 'writer2', model: 'sonnet', daily_usd: 2, daily_jobs: 10 });
      expect(sp.thread_id).toBe(th);
      const res = env.tx(() => decideApproval(env.db, sp.id, 'approved', undefined, { raise_concurrency_to: 3 }));
      expect(res).toMatchObject({ status: 'consumed', agent_id: 'writer2', reason: null });
      expect(env.one(`SELECT max_concurrency m FROM system_state`).m).toBe(3);
      expect(env.one(`SELECT count(*) n FROM events WHERE type='settings.changed' AND entity_type='budget'`).n).toBe(1);

      const aps = await env.until(() => { const r = env.q(`SELECT * FROM approvals WHERE kind='create_top_level_task' AND status='pending' ORDER BY id`); return r.length === 2 ? r : null; }, 30000, 'two task approvals');
      for (const a of aps) env.tx(() => decideApproval(env.db, a.id, 'approved'));
      await env.until(() => env.one(`SELECT count(*) n FROM tasks WHERE status='done'`).n === 2, 90000, 'both tasks done');
    } finally { clearInterval(sampler); }

    // (a)
    const ag = env.one(`SELECT * FROM agents WHERE id='writer2'`);
    const sp = env.one(`SELECT * FROM approvals WHERE kind='spend'`);
    expect(ag.spawn_approval_id).toBe(sp.id);
    expect(sp.status).toBe('consumed');
    expect(env.q(`SELECT limit_usd, limit_jobs FROM budgets WHERE scope='agent' AND period='day'`)).toEqual([{ limit_usd: 2, limit_jobs: 10 }]);
    // (b) the two work jobs overlap
    const [A, B] = ['worker', 'writer2'].map((a) => env.one(`SELECT j.*, t.title FROM jobs j JOIN tasks t ON t.id=j.task_id WHERE j.agent_id=? AND j.kind='work' ORDER BY j.id LIMIT 1`, a));
    expect(A.started_at).toBeLessThan(B.finished_at);
    expect(B.started_at).toBeLessThan(A.finished_at);
    // (c)
    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(maxWorkers).toBeLessThanOrEqual(2);
    expect(dup).toBe(0);
    // (d) each work job ran in its own workspace
    for (const j of [A, B]) {
      expect(fs.readFileSync(path.join(env.home, 'workspaces', `T-${j.task_id}`, 'OUT.md'), 'utf8')).toContain('#');
      expect(fs.readFileSync(path.join(env.home, 'runs', String(j.id), 'prompt.md'), 'utf8')).toContain(`task="T-${j.task_id}"`);
      expect(env.one(`SELECT count(*) n FROM artifacts WHERE task_id=?`, j.task_id).n).toBeGreaterThanOrEqual(1);
    }
    expect(A.task_id).not.toBe(B.task_id);
    // (e) no worker job starts before its task's approval was decided
    for (const j of [A, B]) {
      const d = env.one(`SELECT decided_at FROM approvals WHERE task_id=?`, j.task_id).decided_at;
      expect(j.started_at).toBeGreaterThan(d);
    }
    // (f)
    expect(Date.now() - started).toBeLessThan(90000);
    // (g) exactly one director respond job was enqueued by the approve txn, in the origin thread, and it is the one that called create_task
    const resumedJobs = env.q(`SELECT id FROM jobs WHERE agent_id='director' AND kind='respond' AND thread_id=? AND trigger_message_id IS NULL`, sp.thread_id);
    expect(resumedJobs).toHaveLength(1);
    expect(env.q(`SELECT DISTINCT job_id FROM tool_calls WHERE tool='create_task' AND outcome='ok'`).map((r) => r.job_id)).toEqual([resumedJobs[0].id]);
    // the worker prompt named itself and the system prompt id was substituted per agent
    expect(fs.readFileSync(path.join(env.home, 'runs', String(B.id), 'prompt.md'), 'utf8')).toMatch(/<job [^>]*agent="writer2"[^>]*role="worker"\/>/);
  });
});

describe('P2-S4 per-agent budget (PHASE2 §A6)', () => {
  it('writer2 at $1.50/day, cost 0.60 per run: next writer2 job stays queued, worker claimed, one budget.hit', async () => {
    const run = [{ write: { path: 'OUT.md', content: 'x\n' } }, { tool: { name: 'update_task', input: { task_id: '{{task_id}}', action: 'submit_for_review', note: 'ok' } } },
      { result: { subtype: 'success', cost: 0.6 } }];
    env = new Env({ 'writer2:work': run });
    setDbForTests(env.db);
    env.tx(() => createWorkerByUser(env.db, { name: 'writer2', skill_note: 'docs', daily_usd: 1.5, daily_jobs: 10 }));
    env.start();
    await doctor();
    const mk = (title: string, assignee: string) => createTask(env.db, { title, by: { kind: 'user' }, assignee });
    const [a, b, c] = env.tx(() => [mk('A', 'writer2'), mk('B', 'writer2'), mk('C', 'worker')]);
    await env.until(() => env.one(`SELECT count(*) n FROM events WHERE type='job.started' AND json_extract(payload,'$.agent')='worker'`).n >= 1, 40000, 'worker claimed');
    await env.until(() => env.one(`SELECT count(*) n FROM events WHERE type='budget.hit' AND json_extract(payload,'$.scope')='agent'`).n >= 1, 20000, 'agent budget.hit');
    await new Promise((r) => setTimeout(r, 3000));                          // further claim ticks
    expect(env.one(`SELECT count(*) n FROM events WHERE type='job.started' AND json_extract(payload,'$.agent')='writer2'`).n).toBe(1);
    expect(env.q(`SELECT payload FROM events WHERE type='budget.hit'`).map((e) => JSON.parse(e.payload)).filter((p) => p.scope === 'agent')).toEqual([{ scope: 'agent', agent: 'writer2' }]);
    expect(env.one(`SELECT presence p, presence_detail d FROM agents WHERE id='writer2'`)).toEqual({ p: 'paused', d: 'agent budget' });
    const boot = bootstrap();
    const w2 = boot.agents.find((x: any) => x.id === 'writer2');
    expect(w2.queue_reason).toBe('agent budget');
    expect(w2.budget).toMatchObject({ limit_usd: 1.5, limit_jobs: 10 });
    expect(w2.budget.spent).toBeCloseTo(0.6, 5);
    const queuedTask = boot.tasks.find((t: any) => t.status === 'todo' && t.assignee_agent_id === 'writer2');
    expect(queuedTask?.queued).toBe('agent budget');
    expect(env.q(`SELECT body FROM messages WHERE author_kind='system' AND body LIKE 'writer2 reached its daily allowance%'`)).toHaveLength(1);
    expect(env.one(`SELECT count(*) n FROM jobs WHERE agent_id='writer2' AND status='queued'`).n).toBe(1);
    expect([a, b, c].every((x) => x.task_id > 0)).toBe(true);
  });
});

describe('P2-S5 retire, P2-S11 minimum allowance (PHASE2 §A6)', () => {
  it('retire is refused while T-B is open, then works; enum and create_task drop the retired worker; last worker kept', async () => {
    env = new Env();
    setDbForTests(env.db);
    env.tx(() => createWorkerByUser(env.db, { name: 'writer2', skill_note: 'docs', daily_usd: 2, daily_jobs: 10 }));
    env.start();
    await doctor();
    const tb = env.tx(() => createTask(env.db, { title: 'B', by: { kind: 'user' }, assignee: 'writer2' }));
    expect(() => retire('writer2')).toThrow(/agent_has_open_tasks/);
    await env.until(() => getTask(env.db, tb.task_id)!.status === 'done', 60000, 'T-B done');
    env.tx(() => acceptTask(env.db, getTask(env.db, tb.task_id)!));
    await env.until(() => env.one(`SELECT count(*) n FROM jobs WHERE status IN ('queued','running')`).n === 0, 30000, 'idle');
    retire('writer2');
    expect(env.one(`SELECT retired_at IS NOT NULL r, enabled e, presence p FROM agents WHERE id='writer2'`)).toEqual({ r: 1, e: 0, p: 'disabled' });
    const tools = publishedTools(env.db, { role: 'director', kind: 'respond' });
    expect(tools.find((t) => t.name === 'create_task')!.inputSchema.properties.assignee.enum).toEqual(['worker']);
    expect(tools.find((t) => t.name === 'post_message')!.inputSchema.properties.mentions.items.enum).toEqual(['user', 'director', 'worker']);
    expect(() => retire('worker')).toThrow(/last_worker/);
    const bs = bootstrap();
    expect(bs.agents.find((a: any) => a.id === 'writer2').retired_at).toBeTruthy();
  }, 120000);
  it('P2-S11: allowance floor at every writer', () => {
    env = new Env();
    setDbForTests(env.db);
    expect(() => addAgent({ name: 'writer2', skill_note: 's', daily_usd: 0.99, daily_jobs: 5 })).toThrow(/allowance_below_job_cap/);
    addAgent({ name: 'writer2', skill_note: 's', daily_usd: 1.0, daily_jobs: 5 });
    let err: any; try { setBudgets({ agents: { writer2: { day_usd: 0.5, day_jobs: 5 } } }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'allowance_below_job_cap', status: 400 });
    setBudgets({ agents: { writer2: { day_usd: 1.0, day_jobs: 5 } } });
    expect(env.one(`SELECT limit_usd u FROM budgets WHERE agent_id='writer2'`).u).toBe(1);
    expect(publishedTools(env.db, { role: 'director', kind: 'respond' }).find((t) => t.name === 'create_task')!.inputSchema.properties.assignee.enum).toEqual(['worker', 'writer2']);
  });
});
