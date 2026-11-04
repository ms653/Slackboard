import { describe, it, expect, afterEach } from 'vitest';
import { tx, setDbForTests } from '@/lib/db';
import { freshEnv, claim, ME } from './helpers';
import { callTool, type Caller } from '@/lib/domain/tools';
import { createTask, peerHelpNotices } from '@/lib/domain/tasks';
import { createWorkerByUser } from '@/lib/domain/agents';
import { finishAttempt } from '@/lib/domain/finish';
import { emit } from '@/lib/domain/events';

afterEach(() => setDbForTests(null));
const caller = (j: any, role: string): Caller => ({ jobId: j.id, agent: j.agent_id, role, kind: j.kind, threadId: j.thread_id, taskId: j.task_id });
const mk = (db: any, assignee: string) => tx(db, () => createTask(db, { title: 'T', description: 'd', acceptance: 'a', assignee, by: { kind: 'user' } })).task_id;
const addWorker = (db: any, name: string) => tx(db, () => createWorkerByUser(db, { name, skill_note: 's', daily_usd: 3, daily_jobs: 20 }));

describe('phase 2 increment 2 review fixes', () => {
  it('ENG-1: an identical rejected call repeated in the same job returns the real rejection, not internal_error', () => {
    const db = freshEnv(); addWorker(db, 'writer2');
    const tid = mk(db, 'worker');
    const w = claim(db)!;
    for (let i = 0; i < 2; i++) emit(db, 'help.requested', 'worker', 'message', 1, { routed_to: 'writer2', task_id: tid, options: [], peer: 1 });
    const inp = { question: 'q', target_agent: 'writer2' };
    expect(callTool(db, caller(w, 'worker'), 'request_help', inp)).toMatchObject({ ok: false, error: 'help_cap' });
    expect(callTool(db, caller(w, 'worker'), 'request_help', inp)).toMatchObject({ ok: false, error: 'help_cap' });
    const pm = { body: 'hi', mentions: ['user'] };
    expect(callTool(db, caller(w, 'worker'), 'post_message', pm)).toMatchObject({ ok: false, error: 'cannot_address_user' });
    expect(callTool(db, caller(w, 'worker'), 'post_message', pm)).toMatchObject({ ok: false, error: 'cannot_address_user' });
  });
  it('SPEC: a second ok request_help in the same job is a validation_error', () => {
    const db = freshEnv(); mk(db, 'worker');
    const w = claim(db)!;
    expect(callTool(db, caller(w, 'worker'), 'request_help', { question: 'one' })).toMatchObject({ ok: true });
    expect(callTool(db, caller(w, 'worker'), 'request_help', { question: 'two' })).toMatchObject({ ok: false, error: 'validation_error', hint: 'one help request per run' });
  });
  it('UX-3: "<peer> started" is posted once when the peer help job runs after a hasn\'t-started line', () => {
    const db = freshEnv(); addWorker(db, 'writer2'); db.prepare(`UPDATE system_state SET max_concurrency=4`).run();
    const tb = mk(db, 'writer2'); const wb = claim(db)!; expect(wb.agent_id).toBe('writer2');
    const ta = mk(db, 'worker'); const wa = claim(db)!;
    callTool(db, caller(wa, 'worker'), 'request_help', { question: 'q', target_agent: 'writer2' });
    tx(db, () => finishAttempt(db, wa.id, { exitCode: 0, result: { subtype: 'success', total_cost_usd: 0.01, num_turns: 2 } } as any, ME));
    tx(db, () => peerHelpNotices(db));
    const th = (db.prepare(`SELECT thread_id FROM tasks WHERE id=?`).get(ta) as any).thread_id;
    const q = () => (db.prepare(`SELECT body FROM messages WHERE thread_id=? AND body LIKE 'writer2 %' AND author_kind='system'`).all(th) as any[]).map((m) => m.body);
    expect(q()).toEqual([`writer2 hasn't started: busy (running T-${tb})`]);
    tx(db, () => finishAttempt(db, wb.id, { exitCode: 0, result: { subtype: 'success', total_cost_usd: 0.01, num_turns: 2 } } as any, ME));
    expect(claim(db)!.kind).toBe('help');
    tx(db, () => peerHelpNotices(db)); tx(db, () => peerHelpNotices(db));
    expect(q()).toEqual([`writer2 hasn't started: busy (running T-${tb})`, 'writer2 started']);
  });
});
