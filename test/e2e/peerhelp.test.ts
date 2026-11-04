import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Env } from './harness';
import { setDbForTests } from '@/lib/db';
import { createTask, unblockTask } from '@/lib/domain/tasks';
import { createWorkerByUser, setEnabled } from '@/lib/domain/agents';
import { emit } from '@/lib/domain/events';
import { workspaceFacts } from '@/lib/domain/git';
import { getTask } from '@/lib/domain/rounds';
import { bootstrap } from '@/lib/server/read';
import { taskAction } from '@/lib/server/actions';

let env: Env;
let stateDir = '';
afterEach(async () => { setDbForTests(null); delete process.env.SB_FAKE_STATE; await env?.stop(); });
const doctor = () => env.until(() => env.one(`SELECT doctor_ok_at FROM system_state`).doctor_ok_at, 30000, 'doctor');
const addWorker = (name: string, skill = `skill of ${name}`) => env.tx(() => createWorkerByUser(env.db, { name, skill_note: skill, daily_usd: 3, daily_jobs: 20 }));
const mk = (assignee: string, title: string) => env.tx(() => createTask(env.db, { title, description: 'd', acceptance: '1. ok', assignee, by: { kind: 'user' } })).task_id;
const finishWork = [{ write: { path: 'OUT.md', content: '# done\n' } }, { tool: { name: 'update_task', input: { task_id: '{{task_id}}', action: 'submit_for_review', note: 'done' } } }];
const setup = (script: Record<string, unknown>) => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fake-state-'));
  process.env.SB_FAKE_STATE = stateDir;
  env = new Env(script);
  setDbForTests(env.db);
  env.tx(() => env.db.prepare(`UPDATE system_state SET max_concurrency=4`).run());
};
const statusSeq = (tid: number) => env.q(`SELECT payload FROM events WHERE type='task.status_changed' AND entity_type='task' AND entity_id=? ORDER BY id`, String(tid)).map((e) => JSON.parse(e.payload).to);

describe('P2-S6 peer help (PHASE2 §A6)', () => {
  it('worker asks writer2; writer2 answers with a wake; worker resumes; help_cap and the chain refusal hold', async () => {
    setup({
      'worker:work:answered': [{ tool: { name: 'post_message', input: { body: 'thanks', mentions: ['writer2'] } } }, ...finishWork],
      'worker:work': [{ tool: { name: 'request_help', input: { question: 'Which heading style does README use?', options: ['ATX', 'Setext'], target_agent: 'writer2' } } }],
      'writer2:help': [{ tool: { name: 'request_help', input: { question: 'ask the worker back?', target_agent: 'worker' } } },
        { tool: { name: 'post_message', input: { body: 'ATX; see README.md line 3.', mentions: ['{{asker}}'], wake: true } } }],
      'tester:work:answered': finishWork,
      'tester:work': [{ tool: { name: 'request_help', input: { question: 'third peer ask', target_agent: 'writer2' } } },
        { tool: { name: 'request_help', input: { question: 'fall back to the director' } } }],
    });
    addWorker('writer2', 'Writes user-facing docs'); addWorker('tester', 'Tests');
    env.start(); await doctor();
    const A = mk('worker', 'Write docs/INSTALL.md');
    await env.until(() => env.one(`SELECT count(*) n FROM tasks WHERE id=? AND status='done'`, A).n === 1, 90000, 'T-A done');

    // (a) in_progress -> blocked(help, writer2) -> todo -> in_progress
    expect(statusSeq(A)).toEqual(['in_progress', 'blocked', 'todo', 'in_progress', 'in_review', 'done']);
    const hr = env.one(`SELECT * FROM events WHERE type='help.requested' AND json_extract(payload,'$.task_id')=?`, A);
    expect(JSON.parse(hr.payload)).toMatchObject({ routed_to: 'writer2', peer: 1 });
    const blockedEv = env.q(`SELECT payload FROM events WHERE type='task.status_changed' AND entity_id=? AND json_extract(payload,'$.to')='blocked'`, String(A));
    expect(blockedEv).toHaveLength(1);
    // (b) zero director jobs between help.requested and the worker's next job.started
    const jobs = env.q(`SELECT * FROM jobs WHERE task_id=? ORDER BY id`, A);
    expect(jobs.map((j) => `${j.agent_id}:${j.kind}`)).toEqual(['worker:work', 'writer2:help', 'worker:work', 'director:review']);   // (e) the "thanks" woke nobody
    const next = env.one(`SELECT ts FROM events WHERE type='job.started' AND json_extract(payload,'$.agent')='worker' AND json_extract(payload,'$.task_id')=? ORDER BY id DESC LIMIT 1`, A);
    expect(env.one(`SELECT count(*) n FROM jobs WHERE agent_id='director' AND created_at BETWEEN ? AND ?`, hr.ts, next.ts).n).toBe(0);
    // (c) writer2's help job ran in T-A's workspace with no Write/Edit
    const hj = jobs[1];
    const st = JSON.parse(fs.readFileSync(path.join(stateDir, `job-${hj.id}.json`), 'utf8'));
    expect(st.cwd).toBe(fs.realpathSync(path.join(env.home, 'workspaces', `T-${A}`)));
    expect(st.allowed).not.toMatch(/Write|Edit/);
    expect(st.allowed).toContain('mcp__slackboard__request_help');
    expect(hj.status).toBe('succeeded');
    // (d) the resumed prompt carries the answer as untrusted agent text
    const p = fs.readFileSync(path.join(env.home, 'runs', String(jobs[2].id), 'prompt.md'), 'utf8');
    expect(p).toMatch(/<untrusted kind="agent_message" author="writer2" id="\d+">ATX; see README.md line 3\.<\/untrusted>/);
    // (f) the peer could not ask the worker back; the thread shows the exchange; director was only mentioned
    const rej = env.one(`SELECT result FROM tool_calls WHERE job_id=? AND tool='request_help'`, hj.id);
    expect(JSON.parse(rej.result)).toMatchObject({ ok: false, error: 'not_allowed_for_role' });
    expect(env.one(`SELECT mentions m FROM messages WHERE kind='help' AND thread_id=(SELECT thread_id FROM tasks WHERE id=?)`, A).m).toBe('["writer2","director"]');
    expect(env.one(`SELECT count(*) n FROM messages WHERE body LIKE 'writer2 answered; worker resumes%'`).n).toBe(1);
    expect(env.one(`SELECT presence p FROM agents WHERE id='writer2'`).p).not.toBe('failed');

    // help_cap: tester is refused a third peer request on its task and falls back to the director, who answers
    const T = env.tx(() => {
      const r = createTask(env.db, { title: 'Test it', description: 'd', acceptance: '1. ok', assignee: 'tester', by: { kind: 'user' } });
      for (let i = 0; i < 2; i++) emit(env.db, 'help.requested', 'tester', 'message', 1, { routed_to: 'writer2', task_id: r.task_id, options: [], peer: 1 });
      return r.task_id;
    });
    await env.until(() => getTask(env.db, T)?.status === 'done', 90000, 'tester task done');
    const cap = env.q(`SELECT result FROM tool_calls WHERE agent_id='tester' AND tool='request_help' ORDER BY id`).map((r) => JSON.parse(r.result));
    expect(cap[0]).toMatchObject({ ok: false, error: 'help_cap' });
    expect(cap[1]).toMatchObject({ ok: true, routed_to: 'director' });
    expect(env.q(`SELECT agent_id FROM jobs WHERE task_id=? AND kind='help'`, T).map((j) => j.agent_id)).toEqual(['director']);
  }, 150000);
});

describe('P2-S7 peer help fails (PHASE2 §A6)', () => {
  it('writer2 help exits 1 on 3 attempts -> blocked/job_failed, one failure item, "writer2 could not answer", Retry asks the director', async () => {
    setup({ 'writer2:help': [{ exit: 1 }], 'worker:work:answered': finishWork,
      'worker:work': [{ tool: { name: 'request_help', input: { question: 'Which style?', target_agent: 'writer2' } } }] });
    addWorker('writer2');
    env.start(); await doctor();
    const A = mk('worker', 'Write docs/INSTALL.md');
    await env.until(() => getTask(env.db, A)?.blocked_reason === 'job_failed', 60000, 'help-end');
    const hj = env.one(`SELECT * FROM jobs WHERE task_id=? AND kind='help'`, A);
    expect(hj).toMatchObject({ agent_id: 'writer2', status: 'failed', attempts: 3 });
    expect(env.one(`SELECT count(*) n FROM needs_you WHERE item_type='failure'`).n).toBe(1);
    expect(env.one(`SELECT body FROM messages WHERE author_kind='system' AND body LIKE 'writer2 could not answer%'`).body).toMatch(/^writer2 could not answer the help request \(exit_nonzero\)/);
    expect(bootstrap().tasks.find((t: any) => t.id === A)!.reason).toBe('Blocked: writer2 could not answer (help failed)');
    const rt = env.tx(() => unblockTask(env.db, getTask(env.db, A)!, 'user', 'retry', workspaceFacts(A)));
    expect(rt).toMatchObject({ kind: 'help', agent: 'director' });
    expect(getTask(env.db, A)).toMatchObject({ blocked_reason: 'help', help_agent_id: 'director' });
    expect(env.q(`SELECT agent_id FROM jobs WHERE task_id=? AND kind='help' AND status IN ('queued','running','succeeded') ORDER BY id`, A).map((j) => j.agent_id)[0]).toBe('director');
    await env.until(() => getTask(env.db, A)?.status === 'done', 60000, 'worker resumed after the director answered');
  }, 120000);
});

describe('P2-S10 peer cannot run (PHASE2 §A6)', () => {
  const setupBusy = async () => {
    setup({ 'writer2:work': [{ sleep: 40000 }, ...finishWork], 'worker:work:answered': finishWork,
      'worker:work': [{ tool: { name: 'request_help', input: { question: 'Which style?', target_agent: 'writer2' } } }] });
    addWorker('writer2');
    env.start(); await doctor();
    const B = mk('writer2', 'Long job B');
    await env.until(() => env.one(`SELECT count(*) n FROM jobs WHERE task_id=? AND status='running'`, B).n === 1, 30000, 'writer2 busy');
    const A = mk('worker', 'Write docs/INSTALL.md');
    await env.until(() => getTask(env.db, A)?.status === 'blocked', 30000, 'T-A blocked on help');
    return { A, B };
  };
  it('card shows the busy reason; the 10 min sweep reroutes without a help-end; one director help job', async () => {
    const { A, B } = await setupBusy();
    expect(getTask(env.db, A)).toMatchObject({ blocked_reason: 'help', help_agent_id: 'writer2' });
    expect(bootstrap().tasks.find((t: any) => t.id === A)!.reason).toBe(`Blocked: waiting on writer2 (help) · writer2: busy (running T-${B})`);
    await env.until(() => env.one(`SELECT count(*) n FROM messages WHERE body = ?`, `writer2 hasn't started: busy (running T-${B})`).n === 1, 20000, 'not-started line');
    const pj = env.one(`SELECT id FROM jobs WHERE task_id=? AND kind='help' AND agent_id='writer2'`, A).id;
    // "clock advanced": the job has been queued for 11 minutes
    env.tx(() => env.db.prepare(`UPDATE jobs SET created_at=? WHERE id=?`).run(Date.now() - 11 * 60_000, pj));
    await env.until(() => env.one(`SELECT count(*) n FROM messages WHERE body LIKE '%can''t answer now%'`).n === 1, 20000, 'T11c sweep');
    expect(env.one(`SELECT count(*) n FROM events WHERE type='task.updated' AND entity_id=? AND json_extract(payload,'$.help_agent_id')='director'`, String(A)).n).toBe(1);
    expect(env.one(`SELECT status, failure_kind FROM jobs WHERE id=?`, pj)).toEqual({ status: 'cancelled', failure_kind: 'cancelled' });
    expect(env.one(`SELECT count(*) n FROM messages WHERE body LIKE '%could not answer%'`).n).toBe(0);
    expect(env.one(`SELECT count(*) n FROM jobs WHERE task_id=? AND agent_id='director' AND kind='help'`, A).n).toBe(1);
    expect(env.one(`SELECT body FROM messages WHERE author_kind='system' AND body LIKE '%can''t answer now%'`).body)
      .toBe(`writer2 can't answer now (busy (running T-${B})); asking the director instead.`);
    await env.until(() => getTask(env.db, A)?.status === 'done', 60000, 'worker resumed via the director');
  }, 150000);
  it('variant: the user clicks "Ask the director instead" at once (same end state)', async () => {
    const { A, B } = await setupBusy();
    taskAction(A, 'reroute_help');
    expect(getTask(env.db, A)).toMatchObject({ blocked_reason: 'help', help_agent_id: 'director' });
    expect(env.one(`SELECT body FROM messages WHERE author_kind='system' AND body LIKE '%can''t answer now%'`).body)
      .toBe(`writer2 can't answer now (busy (running T-${B})); asking the director instead.`);
    expect(env.one(`SELECT count(*) n FROM jobs WHERE task_id=? AND agent_id='writer2' AND kind='help' AND status='cancelled'`, A).n).toBe(1);
  }, 120000);
  it('variant: writer2 disabled -> rerouted on the next sweep', async () => {
    const { A } = await setupBusy();
    env.tx(() => setEnabled(env.db, 'writer2', false));
    await env.until(() => env.one(`SELECT count(*) n FROM messages WHERE body LIKE '%can''t answer now%'`).n === 1, 20000, 'sweep after disable');
    expect(env.one(`SELECT count(*) n FROM events WHERE type='task.updated' AND entity_id=? AND json_extract(payload,'$.help_agent_id')='director'`, String(A)).n).toBe(1);
    expect(env.one(`SELECT body FROM messages WHERE author_kind='system' AND body LIKE '%can''t answer now%'`).body).toBe("writer2 can't answer now (disabled); asking the director instead.");
  }, 120000);
});
