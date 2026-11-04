import http from 'node:http';
import type { DB } from '@/lib/db';
import { sha256, randomToken } from '@/lib/util';
import { callTool, publishedTools, type Caller } from '@/lib/domain/tools';
import { agentRole, type JobRow } from '@/lib/domain/jobs';

/** In-memory tokens (plus hashes in jobs.run_token_hash). Doctor tokens never touch the DB (TECH §6.4). */
interface Live { jobId: number | null; doctorPid?: number; onCall?: (tool: string, input: unknown) => void }
export class Tokens {
  private m = new Map<string, Live>();
  bindJob(jobId: number, token: string): void { this.m.set(sha256(token), { jobId }); }
  issueDoctor(onCall: Live['onCall']): { token: string; bind: (pid: number) => void } {
    const t = randomToken(); const h = sha256(t); const live: Live = { jobId: null, onCall }; this.m.set(h, live);
    return { token: t, bind: (pid) => { live.doctorPid = pid; } };
  }
  revokeJob(jobId: number): void { for (const [h, v] of this.m) if (v.jobId === jobId) this.m.delete(h); }
  revokeHash(h: string): void { this.m.delete(h); }
  revokeAll(): void { this.m.clear(); }
  get(h: string): Live | undefined { return this.m.get(h); }
}

export interface ToolServerDeps { db: DB; tokens: Tokens; controlToken: string; onControl: (path: string, body: any) => Promise<any> }

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
}
const loopback = (a?: string) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

export function startToolServer(deps: ToolServerDeps): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      try {
        if (!loopback(req.socket.remoteAddress)) return json(res, 403, { ok: false, error: 'forbidden' });
        const port = (server.address() as any).port;
        if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { ok: false, error: 'bad_host' });
        const body = raw ? JSON.parse(raw) : {};
        const url = req.url ?? '';
        if (url.startsWith('/control/')) {
          if (req.headers.authorization !== `Bearer ${deps.controlToken}`) return json(res, 401, { ok: false, error: 'unauthorized' });
          return json(res, 200, { ok: true, ...(await deps.onControl(url.slice('/control/'.length), body)) });
        }
        const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const h = sha256(tok);
        const live = deps.tokens.get(h);
        const ppid = Number(req.headers['x-sb-parent-pid']);
        if (!live) return json(res, 401, { ok: false, error: 'unauthorized', hint: 'run token revoked or unknown' });
        if (live.jobId === null) {                                     // doctor mode
          if (live.doctorPid === undefined || live.doctorPid !== ppid) return json(res, 401, { ok: false, error: 'unauthorized' });
          if (url === '/tools') return json(res, 200, { ok: true, tools: publishedTools(deps.db, { role: 'director', kind: 'respond' }) });
          if (body.tool !== 'add_note') return json(res, 200, { ok: false, error: 'not_allowed_for_role', hint: 'doctor probe' });
          live.onCall?.(body.tool, body.input);
          return json(res, 200, { ok: true, note_id: 0 });
        }
        const j = deps.db.prepare(`SELECT * FROM jobs WHERE id=? AND status='running' AND run_token_hash=?`).get(live.jobId, h) as JobRow | undefined;
        if (!j) return json(res, 401, { ok: false, error: 'unauthorized', hint: 'job is not running' });
        if (j.pid == null || j.pid !== ppid) return json(res, 401, { ok: false, error: 'unauthorized', hint: 'parent pid mismatch' });
        const caller: Caller = { jobId: j.id, agent: j.agent_id, role: agentRole(deps.db, j.agent_id), kind: j.kind, threadId: j.thread_id, taskId: j.task_id };
        if (url === '/tools') return json(res, 200, { ok: true, tools: publishedTools(deps.db, caller) });
        if (url === '/rpc' && req.method === 'POST') return json(res, 200, callTool(deps.db, caller, String(body.tool), body.input));
        return json(res, 404, { ok: false, error: 'not_found' });
      } catch (e: any) {
        json(res, 500, { ok: false, error: 'internal_error', hint: String(e?.message).slice(0, 200) });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
