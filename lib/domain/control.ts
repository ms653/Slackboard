import fs from 'node:fs';
import http from 'node:http';
import type { DB } from '../db';
import { tx } from '../db';
import { now, DomainError } from '../util';
import { paths } from '../paths';
import { emit } from './events';
import { refreshAllPresence } from './jobs';
import { isOurs, killVerified, ORCH_STALE_MS, type ProcRow } from '../proc';

/** Call the orchestrator's /control endpoint (low latency only; the DB is the real channel). */
export function control(db: DB, p: string, body: unknown = {}, timeoutMs = 1000): Promise<{ status: number; body: any } | null> {
  const s = db.prepare(`SELECT tool_server_port FROM system_state WHERE id=1`).get() as { tool_server_port: number | null };
  let token = '';
  try { token = fs.readFileSync(paths.controlToken(), 'utf8').trim(); } catch { return Promise.resolve(null); }
  if (!s.tool_server_port) return Promise.resolve(null);
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: s.tool_server_port, path: `/control/${p}`, method: 'POST', timeout: timeoutMs,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Host: `127.0.0.1:${s.tool_server_port}`, 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode ?? 0, body: {} }); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(data);
  });
}

export function orchestratorLive(db: DB): boolean {
  const s = db.prepare(`SELECT orchestrator_pid, orchestrator_proc_start, orchestrator_heartbeat_at FROM system_state WHERE id=1`).get() as any;
  return isOurs(s.orchestrator_pid, s.orchestrator_proc_start) && !!s.orchestrator_heartbeat_at && now() - s.orchestrator_heartbeat_at <= ORCH_STALE_MS;
}

/** POST /api/kill (TECH §5.9 steps 1-2). */
export async function engageKill(db: DB): Promise<{ ok: true; path: 'orchestrator' | 'direct'; survivors?: number[] }> {
  tx(db, () => {
    const s = db.prepare(`SELECT kill_switch FROM system_state WHERE id=1`).get() as any;
    if (!s.kill_switch) {
      db.prepare(`UPDATE system_state SET kill_switch=1, kill_engaged_at=? WHERE id=1`).run(now());
      emit(db, 'kill.engaged', 'user', 'system', 1, {});
      refreshAllPresence(db);
    }
  });
  const r = await control(db, 'kill', {}, 1000);
  const fresh = db.prepare(`SELECT orchestrator_heartbeat_at h FROM system_state WHERE id=1`).get() as { h: number | null };
  if (r && r.status >= 200 && r.status < 300 && fresh.h && now() - fresh.h <= ORCH_STALE_MS) return { ok: true, path: 'orchestrator' };
  const rows = db.prepare(`SELECT id, pid, proc_start, session_id FROM jobs WHERE status='running'`).all() as ProcRow[];
  const survivors = await killVerified(rows);
  emit(db, 'kill.engaged', 'system', 'system', 1, { survivors, path: 'direct', followup: true });
  return { ok: true, path: 'direct', survivors };
}

/** POST /api/resume (TECH §5.9 step 5): 409 kill_recovery_pending unless recovery is safe. */
export function resume(db: DB): void {
  const pre = db.prepare(`SELECT orchestrator_pid p, orchestrator_proc_start s FROM system_state WHERE id=1`).get() as any;
  const orchOk = isOurs(pre.p, pre.s);
  tx(db, () => {
    const s = db.prepare(`SELECT * FROM system_state WHERE id=1`).get() as any;
    if (!s.kill_switch) return;
    const running = (db.prepare(`SELECT count(*) n FROM jobs WHERE status='running'`).get() as any).n as number;
    if (running > 0) {
      const sameOrch = s.orchestrator_pid === pre.p && s.orchestrator_proc_start === pre.s;
      const fresh = !!s.orchestrator_heartbeat_at && s.orchestrator_heartbeat_at >= now() - ORCH_STALE_MS;
      const foreign = db.prepare(`SELECT 1 FROM jobs WHERE status='running' AND lease_owner IS NOT (SELECT orchestrator_id FROM system_state WHERE id=1)`).get();
      if (!(orchOk && sameOrch && fresh && !foreign))
        throw new DomainError('kill_recovery_pending', `${running} run${running === 1 ? '' : 's'} not yet marked stopped; restart the orchestrator first`);
    }
    db.prepare(`UPDATE system_state SET kill_switch=0, kill_engaged_at=NULL WHERE id=1`).run();
    emit(db, 'kill.released', 'user', 'system', 1, {});
    refreshAllPresence(db);
  });
}
