import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { Env, REPO } from './harness';
import { createThread } from '@/lib/domain/threads';

let env: Env, srv: ChildProcess, port = 0, logs = '', cookie = '';
const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const call = (method: string, p: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { cookie, origin: `http://127.0.0.1:${port}`,
    ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}) } },
    (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode!, json: t ? JSON.parse(t) : {} })); });
  r.on('error', reject); if (data) r.write(data); r.end();
});

beforeAll(async () => {
  if (!fs.existsSync(path.join(REPO, '.next/BUILD_ID'))) throw new Error('run `npm run build` first (.next/BUILD_ID missing)');
  env = new Env();
  port = await freePort();
  srv = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: REPO, env: { ...env.env(), SB_SESSION_TOKEN: 'e2e-session-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout!.on('data', (d) => (logs += d)); srv.stderr!.on('data', (d) => (logs += d));
  await env.until(() => /Ready|started server/i.test(logs), 60000, 'next start');
  await new Promise<void>((resolve) => http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { cookie = String(res.headers['set-cookie']).split(';')[0]; res.resume(); res.on('end', () => resolve()); }));
}, 90000);
afterAll(async () => {
  if (srv && srv.exitCode === null) await new Promise<void>((r) => { srv.on('exit', () => r()); srv.kill('SIGTERM'); setTimeout(() => srv.kill('SIGKILL'), 5000).unref(); });
});

describe('Phase 2 HTTP surface (PHASE2 §T5.5)', () => {
  it('spawn approval decide, agents API, budgets floor, retire hint, reassign, zero enabled workers', async () => {
    const th = env.tx(() => createThread(env.db, 'chat', { kind: 'user' }));
    env.db.prepare(`INSERT INTO messages(thread_id, author_kind, body, created_at) VALUES (?, 'user', 'Write docs/A.md and docs/B.md', ?)`).run(th, Date.now());
    const payload = { action: 'spawn_worker', name: 'writer2', skill_note: 'Writes docs', model: 'sonnet', daily_usd: 2, daily_jobs: 10 };
    const ap = Number(env.db.prepare(`INSERT INTO approvals(kind,requested_by_agent_id,thread_id,summary,payload,payload_hash,created_at,expires_at) VALUES ('spend','director',?,'why',?,'h',?,?)`)
      .run(th, JSON.stringify(payload), Date.now(), Date.now() + 1e8).lastInsertRowid);
    // bad raise -> 400 and still pending
    let r = await call('POST', `/api/approvals/${ap}/decide`, { decision: 'approved', raise_concurrency_to: 5 });
    expect(r.status).toBe(400);
    expect(env.one(`SELECT status s FROM approvals WHERE id=?`, ap).s).toBe('pending');
    r = await call('POST', `/api/approvals/${ap}/decide`, { decision: 'approved', raise_concurrency_to: 3 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, status: 'consumed', agent_id: 'writer2', reason: null });
    expect(typeof r.json.resumed).toBe('number');
    expect(env.one(`SELECT max_concurrency m FROM system_state`).m).toBe(3);
    // bootstrap carries the new fields
    r = await call('GET', '/api/bootstrap');
    const w2 = r.json.agents.find((a: any) => a.id === 'writer2');
    expect(w2).toMatchObject({ skill_note: 'Writes docs', retired_at: null, budget: { limit_usd: 2, limit_jobs: 10 } });
    expect('queue_reason' in w2).toBe(true);
    // add worker: floor, then ok, then cap
    r = await call('POST', '/api/agents', { name: 'w3', skill_note: 'x', daily_usd: 0.99, daily_jobs: 5 });
    expect([r.status, r.json.error]).toEqual([400, 'allowance_below_job_cap']);
    expect((await call('POST', '/api/agents', { name: 'w3', skill_note: 'x', daily_usd: 1.0, daily_jobs: 5 })).status).toBe(200);
    r = await call('POST', '/api/agents', { name: 'w4', skill_note: 'x', daily_usd: 1.0, daily_jobs: 5 });
    expect([r.status, r.json.error]).toEqual([409, 'worker_cap']);
    r = await call('POST', '/api/agents', { name: 'writer2', skill_note: 'x', daily_usd: 1.0, daily_jobs: 5 });
    expect([r.status, r.json.error]).toEqual([409, 'name_taken']);
    // budgets
    r = await call('PUT', '/api/budgets', { agents: { writer2: { day_usd: 0.5, day_jobs: 5 } } });
    expect([r.status, r.json.error]).toEqual([400, 'allowance_below_job_cap']);
    expect((await call('PUT', '/api/budgets', { agents: { writer2: { day_usd: 1.0, day_jobs: 5 } } })).status).toBe(200);
    // task for writer2 -> retire refused with the task list; reassign moves it
    r = await call('POST', '/api/tasks', { title: 'B', assignee: 'writer2' });
    expect(r.status).toBe(200);
    const tid = r.json.task_id;
    r = await call('PUT', '/api/agents/writer2', { retire: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'agent_has_open_tasks', tasks: [{ id: tid, actions: ['reassign', 'cancel'] }] });
    await call('PUT', '/api/agents/w3', { enabled: false });
    r = await call('POST', `/api/tasks/${tid}`, { action: 'reassign', assignee: 'w3' });
    expect([r.status, r.json.error]).toEqual([409, 'assignee_disabled']);
    r = await call('POST', `/api/tasks/${tid}`, { action: 'reassign', assignee: 'worker' });
    expect(r.status).toBe(200);
    expect(env.one(`SELECT assignee_agent_id a FROM tasks WHERE id=?`, tid).a).toBe('worker');
    
    // zero enabled workers
    for (const a of ['worker', 'writer2']) await call('PUT', `/api/agents/${a}`, { enabled: false });
    r = await call('POST', '/api/tasks', { title: 'nope' });
    expect([r.status, r.json.error]).toEqual([409, 'no_enabled_worker']);
    expect(env.one(`SELECT count(*) n FROM tasks WHERE title='nope'`).n).toBe(0);
    // retired agents cannot be re-enabled
    r = await call('PUT', '/api/agents/writer2', { retire: true });
    expect(r.status).toBe(200);
    r = await call('PUT', '/api/agents/writer2', { enabled: true });
    expect([r.status, r.json.error]).toEqual([409, 'agent_retired']);
    r = await call('PUT', '/api/agents/worker', { retire: true });
    expect(r.json.error).toBe('agent_has_open_tasks');                                         // the reassigned task is still open; last_worker is checked after
  });
});
