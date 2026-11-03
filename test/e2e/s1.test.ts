import { describe, it, expect, afterEach } from 'vitest';
import { Env } from './harness';
import { createThread } from '@/lib/domain/threads';
import { postUserMessage } from '@/lib/domain/wake';
import { decideApproval } from '@/lib/domain/tasks';
import { groupAlive } from '@/lib/proc';

let env: Env;
afterEach(async () => { await env?.stop(); });

describe('S1: request -> proposal -> approval -> work -> review (1 rework) -> done (PRD §5)', () => {
  it('meets P1-P6 with the fake binary', async () => {
    const started = Date.now();
    env = new Env({
      // P5: injected failure in the director respond job, attempt 1: post, then crash before create_task.
      'director:respond:a1': [{ tool: { name: 'post_message', input: { body: 'On it: proposing a task.' } } }, { exit: 1 }],
      'director:respond:a2': [{ tool: { name: 'post_message', input: { body: 'On it: proposing a task.' } } },
        { tool: { name: 'create_task', input: { title: 'Write INSTALL.md', description: 'Install guide', acceptance: '1. INSTALL.md exists', why: 'You asked.' } } }],
      'worker:work': [{ write: { path: 'INSTALL.md', content: '# Install\n\nround {{round}}\n' } },
        { tool: { name: 'update_task', input: { task_id: '{{task_id}}', action: 'submit_for_review', note: 'done' } } }],
      'director:review:r1': [{ tool: { name: 'update_task', input: { task_id: '{{task_id}}', action: 'request_changes', note: '1. add prerequisites' } } }],
      'director:review:r2': [{ tool: { name: 'update_task', input: { task_id: '{{task_id}}', action: 'approve' } } },
        { tool: { name: 'post_message', input: { body: 'T is done and reviewed.', mentions: ['user'] } } }],
    });
    env.start();
    await env.until(() => env.one(`SELECT doctor_ok_at FROM system_state`).doctor_ok_at, 30000, 'doctor');
    const th = env.tx(() => createThread(env.db, 'general chat', { kind: 'user' }));
    env.tx(() => postUserMessage(env.db, th, 'Please write INSTALL.md for the project.'));
    const ap = await env.until(() => env.one(`SELECT * FROM approvals WHERE status='pending'`), 30000, 'approval');
    // P2: no worker job may start before approval
    expect(env.one(`SELECT count(*) n FROM events WHERE type='job.started' AND json_extract(payload,'$.agent')='worker'`).n).toBe(0);
    env.tx(() => decideApproval(env.db, ap.id, 'approved'));
    const approvedAt = Date.now();
    const task = await env.until(() => env.one(`SELECT * FROM tasks WHERE id=? AND status='done'`, ap.task_id), 60000, 'task done');

    // P1: proposed then the exact status path
    const created = env.one(`SELECT json_extract(payload,'$.status') s FROM events WHERE type='task.created' AND entity_id=?`, String(task.id)).s;
    const path = env.q(`SELECT json_extract(payload,'$.to') t FROM events WHERE type='task.status_changed' AND entity_id=? ORDER BY id`, String(task.id)).map((r) => r.t);
    expect([created, ...path]).toEqual(['proposed', 'todo', 'in_progress', 'in_review', 'todo', 'in_progress', 'in_review', 'done']);
    // P2: first worker start after approval
    const firstWorker = env.one(`SELECT min(ts) t FROM events WHERE type='job.started' AND json_extract(payload,'$.agent')='worker'`).t;
    expect(firstWorker).toBeGreaterThanOrEqual(approvedAt - 50);
    // P3: needs-you items = 1 approval + 1 ready; no blocked; no help to user
    const p3 = env.one(`SELECT count(*) n FROM events WHERE type='approval.requested'`).n + env.q(`SELECT 1 FROM events WHERE type='task.status_changed' AND json_extract(payload,'$.to')='done'`).length;
    expect(p3).toBe(2);
    expect(env.one(`SELECT count(*) n FROM events WHERE type='task.status_changed' AND json_extract(payload,'$.to')='blocked'`).n).toBe(0);
    // P4: job count (respond counted once; 2 work + 2 review + respond) <= 6
    expect(env.one(`SELECT count(*) n FROM jobs WHERE status NOT IN ('cancelled')`).n).toBeLessThanOrEqual(6);
    // P5: retry produced no duplicate message; exactly one replay
    expect(env.one(`SELECT count(*) n FROM messages WHERE body='On it: proposing a task.'`).n).toBe(1);
    expect(env.one(`SELECT count(*) n FROM events WHERE type='tool.called' AND json_extract(payload,'$.replay')=1`).n).toBe(1);
    // P6: no leftover processes from any job
    await env.until(() => env.one(`SELECT count(*) n FROM jobs WHERE status='running'`).n === 0, 10000, 'jobs finished');
    for (const j of env.q(`SELECT pid FROM jobs WHERE pid IS NOT NULL`)) expect(groupAlive(j.pid)).toBe(false);
    // P7: the user mention happens only after done
    const mention = env.one(`SELECT min(m.created_at) t FROM messages m WHERE EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value='user')`).t;
    const done = env.one(`SELECT ts FROM events WHERE type='task.status_changed' AND entity_id=? AND json_extract(payload,'$.to')='done'`, String(task.id)).ts;
    expect(mention).toBeGreaterThanOrEqual(done);
    // P8 (fake): under 60 s
    expect(Date.now() - started).toBeLessThan(60000);
  });

  it('S2: reject -> zero worker jobs', async () => {
    env = new Env();
    env.start();
    await env.until(() => env.one(`SELECT doctor_ok_at FROM system_state`).doctor_ok_at, 30000, 'doctor');
    const th = env.tx(() => createThread(env.db, 'chat', { kind: 'user' }));
    env.tx(() => postUserMessage(env.db, th, 'Please draft a blog post.'));
    const ap = await env.until(() => env.one(`SELECT * FROM approvals WHERE status='pending'`), 30000, 'approval');
    env.tx(() => decideApproval(env.db, ap.id, 'rejected', 'not now'));
    await new Promise((r) => setTimeout(r, 2500));
    expect(env.one(`SELECT count(*) n FROM jobs WHERE agent_id='worker'`).n).toBe(0);
    expect(env.one(`SELECT status FROM tasks WHERE id=?`, ap.task_id).status).toBe('cancelled');
  });
});
