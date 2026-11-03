import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { Env, REPO } from './harness';
import { createTask } from '@/lib/domain/tasks';

let env: Env, srv: ChildProcess, port = 0, logs = '';
let approvalId = 0;

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
/** node:http so the Host header can be forged (fetch forbids it). */
const req = (method: string, p: string, headers: Record<string, string> = {}, body?: unknown) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers } },
    (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: t })); });
  r.on('error', reject); if (data) r.write(data); r.end();
});

beforeAll(async () => {
  if (!fs.existsSync(path.join(REPO, '.next/BUILD_ID'))) throw new Error('run `npm run build` first (.next/BUILD_ID missing)');
  env = new Env();
  const t = env.tx(() => createTask(env.db, { title: 'proposed by agent', description: 'd', acceptance: '1', by: { kind: 'agent', agent: 'director' } }));
  approvalId = env.one(`SELECT id FROM approvals WHERE task_id=?`, t.task_id).id;
  port = await freePort();
  srv = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)],
    { cwd: REPO, env: { ...env.env(), SB_SESSION_TOKEN: 'e2e-session-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout!.on('data', (d) => (logs += d)); srv.stderr!.on('data', (d) => (logs += d));
  await env.until(() => /Ready|started server/i.test(logs), 60000, 'next start');
}, 90000);
afterAll(async () => {
  if (srv && srv.exitCode === null) await new Promise<void>((r) => { srv.on('exit', () => r()); srv.kill('SIGTERM'); setTimeout(() => srv.kill('SIGKILL'), 5000).unref(); });
});

describe('PM-1: approval decision endpoint enforcement (middleware)', () => {
  const url = () => `/api/approvals/${approvalId}/decide`;
  const origin = () => `http://127.0.0.1:${port}`;
  const status = () => env.one(`SELECT status FROM approvals WHERE id=?`, approvalId).status;

  it('rejects missing cookie (401), wrong Origin (403), forged Host (403); approval stays pending', async () => {
    const home = await req('GET', '/');
    const cookie = String(home.headers['set-cookie']).split(';')[0];
    expect(cookie).toMatch(/^sb_session=/);
    expect((await req('POST', url(), { origin: origin() }, { decision: 'approved' })).status).toBe(401);
    expect((await req('POST', url(), { cookie, origin: 'http://evil.com' }, { decision: 'approved' })).status).toBe(403);
    expect((await req('POST', url(), { cookie, origin: origin(), host: 'evil.com' }, { decision: 'approved' })).status).toBe(403);
    expect(status()).toBe('pending');
  });

  it('invalid decision value -> 400 validation_error', async () => {
    const cookie = String((await req('GET', '/')).headers['set-cookie']).split(';')[0];
    const r = await req('POST', url(), { cookie, origin: origin() }, { decision: 'maybe' });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe('validation_error');
    expect(status()).toBe('pending');
  });

  it('valid cookie + matching Origin -> 200 and approval approved', async () => {
    const cookie = String((await req('GET', '/')).headers['set-cookie']).split(';')[0];
    const r = await req('POST', url(), { cookie, origin: origin() }, { decision: 'approved' });
    expect(r.status).toBe(200);
    expect(status()).toBe('approved');
    expect(env.one(`SELECT decided_by FROM approvals WHERE id=?`, approvalId).decided_by).toBe('user');
  });
});
