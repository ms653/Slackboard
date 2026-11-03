import fs from 'node:fs';
import os from 'node:os';
import { openDb, tx } from '@/lib/db';
import { now, randomToken, uuid } from '@/lib/util';
import { paths, ensureDir, dataDir } from '@/lib/paths';
import { emit } from '@/lib/domain/events';
import { claimNext, cancelDeadQueuedJobs, budgetBlocked } from '@/lib/domain/claim';
import { finishAttempt } from '@/lib/domain/finish';
import { refreshAllPresence, type JobRow } from '@/lib/domain/jobs';
import { expireApprovals, setStatus } from '@/lib/domain/tasks';
import { getTask } from '@/lib/domain/rounds';
import { procStart, isOurs, killJobProcs, procTargets, sweepByMarker, killGroup, setArgvFallback, groupAlive } from '@/lib/proc';
import { startToolServer, Tokens } from './toolserver';
import { spawnJob, killChild, markKilled, type Child, type SpawnCtx } from './spawn';
import { runDoctor, binSignature, killDoctorProbes } from './doctor';

const HEARTBEAT_MS = 15_000, IDLE_MS = Number(process.env.SB_IDLE_MS || 180_000);
const WALL: Record<string, number> = { respond: 240_000, help: 240_000, review: 360_000, work: 900_000 };
const ME = `${os.hostname()}:${process.pid}:${uuid().slice(0, 8)}`;
const BIN = () => process.env.SLACKBOARD_CLAUDE_BIN || 'claude';
const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[orch]', ...a);

const db = openDb();
const tokens = new Tokens();
const children = new Map<number, Child>();
let toolPort = 0, sep = ',', sweeping = false, lastBudgetHit = 0, doctorRunning = false, shuttingDown = false, killing = false;
const ctx: SpawnCtx = { db, me: ME, children, tokens, toolPort: () => toolPort, bin: BIN, sep: () => sep };

function acquireSingleton(): void {
  tx(db, () => {
    const s = db.prepare(`SELECT orchestrator_pid, orchestrator_proc_start, orchestrator_heartbeat_at FROM system_state WHERE id=1`).get() as any;
    if (s.orchestrator_pid && s.orchestrator_pid !== process.pid && isOurs(s.orchestrator_pid, s.orchestrator_proc_start)) {
      console.error(`orchestrator pid ${s.orchestrator_pid} alive; kill it to restart`);
      process.exit(1);
    }
    db.prepare(`UPDATE system_state SET orchestrator_id=?, orchestrator_pid=?, orchestrator_proc_start=?, orchestrator_heartbeat_at=? WHERE id=1`)
      .run(ME, process.pid, procStart(process.pid), now());
  });
}

async function recoverOrphans(): Promise<void> {
  const killOn = (db.prepare(`SELECT kill_switch FROM system_state WHERE id=1`).get() as any).kill_switch === 1;
  const rows = db.prepare(`SELECT * FROM jobs WHERE status='running'`).all() as JobRow[];
  for (const j of rows) {
    await killJobProcs(j);
    tx(db, () => finishAttempt(db, j.id, killOn ? { failure: 'orphaned', killedFor: 'kill' } : { failure: 'orphaned' }, j.lease_owner!));
  }
  tx(db, () => {
    for (const t of db.prepare(`SELECT id FROM tasks WHERE status='in_progress'`).all() as { id: number }[]) setStatus(db, getTask(db, t.id)!, 'todo', 'system');
  });
  db.prepare(`UPDATE jobs SET run_token_hash=NULL WHERE status<>'running'`).run();
  emit(db, 'orchestrator.recovered', 'system', 'system', 1, { jobs: rows.length, kill: killOn });
  if (rows.length) log(`recovered ${rows.length} orphaned job(s)${killOn ? ' as killed' : ''}`);
}

function tick(): void {
  if (shuttingDown) return;
  try {
    const s = db.prepare(`SELECT * FROM system_state WHERE id=1`).get() as any;
    db.prepare(`UPDATE system_state SET orchestrator_heartbeat_at=? WHERE id=1`).run(now());
    if (s.kill_switch) { if (children.size && !killing) { killing = true; killAll('kill').catch((e) => log('killAll error', e?.message)).finally(() => { killing = false; }); } return; }
    const cancels = db.prepare(`SELECT j.id FROM jobs j LEFT JOIN tasks k ON k.id=j.task_id WHERE j.status='running' AND j.lease_owner=?
                                AND (j.cancel_requested=1 OR k.status='cancelled')`).all(ME) as { id: number }[];
    for (const r of cancels) { const c = children.get(r.id); if (c && !c.killedFor) killChild(c, 'cancelled', tokens); }
    if (!s.doctor_ok_at || s.pause_reason === 'user' || (s.paused_until ?? 0) > now()) return;
    if (s.pause_reason === 'usage_limit' && (s.paused_until ?? 0) <= now()) db.prepare(`UPDATE system_state SET paused_until=NULL, pause_reason=NULL WHERE id=1`).run();
    tx(db, () => cancelDeadQueuedJobs(db));
    while (children.size < s.max_concurrency) {
      const token = randomToken();
      const job = tx(db, () => claimNext(db, ME, token));
      if (!job) break;
      log(`claimed job ${job.id} (${job.agent_id} ${job.kind}${job.task_id ? ' T-' + job.task_id : ''}, attempt ${job.attempts})`);
      spawnJob(ctx, job, token);
    }
    const why = budgetBlocked(db);
    if (why && now() - lastBudgetHit > 600_000 && db.prepare(`SELECT 1 FROM jobs WHERE status='queued'`).get()) {
      lastBudgetHit = now(); emit(db, 'budget.hit', 'system', 'budget', null, { reason: why }); refreshAllPresence(db);
    }
  } catch (e: any) { log('tick error', e.message); }
}

function heartbeat(): void {
  if (shuttingDown) return;
  for (const [id, c] of children) {
    const n = db.prepare(`UPDATE jobs SET lease_expires_at=?, heartbeat_at=?, last_output_at=? WHERE id=? AND status='running' AND lease_owner=?`)
      .run(now() + 60_000, now(), c.lastOutputAt, id, ME).changes;
    if (n === 0 && !c.killedFor) killChild(c, 'lease_lost', tokens);
    if (c.kind === 'work' && c.taskId) db.prepare(`UPDATE tasks SET claim_expires_at=? WHERE id=? AND claimed_by=?`).run(now() + 60_000, c.taskId, c.agent);
    if (!c.killedFor && now() - c.lastOutputAt > IDLE_MS) killChild(c, 'timeout_idle', tokens);
    if (!c.killedFor && now() - c.startedAt > WALL[c.kind]) killChild(c, 'timeout_wall', tokens);
  }
}

async function sweep(): Promise<void> {
  if (shuttingDown || sweeping) return; sweeping = true;
  try {
    tx(db, () => {
      const stale = db.prepare(`SELECT id FROM tasks WHERE status='in_progress' AND claim_expires_at < ?
                                AND NOT EXISTS (SELECT 1 FROM jobs WHERE task_id=tasks.id AND status='running')`).all(now()) as { id: number }[];
      for (const t of stale) setStatus(db, getTask(db, t.id)!, 'todo', 'system');                 // T9
      expireApprovals(db);
    });
    const orphans = db.prepare(`SELECT * FROM jobs WHERE status='running' AND lease_expires_at < ?`).all(now()) as JobRow[];
    for (const j of orphans) {
      if (children.has(j.id)) continue;
      await killJobProcs(j);
      tx(db, () => finishAttempt(db, j.id, { failure: 'orphaned' }, j.lease_owner!));
      log(`swept orphaned job ${j.id}`);
    }
  } catch (e: any) { log('sweep error', e.message); } finally { sweeping = false; }
}

async function killAll(why: 'kill' | 'shutdown'): Promise<number[]> {
  // Doctor probes are stopped only on shutdown (signal handler). The kill switch blocks every claim anyway, and
  // aborting a running doctor here would leave doctor_report unwritten (first boot) or a stale pass in place.
  const list = [...children.values()];
  tokens.revokeAll();
  for (const c of list) {
    markKilled(c, why);      // kill switch wins over an earlier timeout_*/lease_lost (TECH §3.2)
    killGroup(c.pid, 'SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 3000));
  for (const c of list) if (groupAlive(c.pid)) killGroup(c.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 2000));
  const rows = list.map((c) => db.prepare(`SELECT id, pid, proc_start, session_id FROM jobs WHERE id=?`).get(c.jobId) as any);
  const again = Array.from(new Set(rows.flatMap((r) => [...procTargets(r), ...sweepByMarker(r.id)])));
  for (const p of again) killGroup(p, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  const survivors = again.filter((p) => groupAlive(p));
  if (why === 'kill') emit(db, 'kill.engaged', 'system', 'system', 1, { survivors, path: 'orchestrator', followup: true });
  return survivors;
}

async function doctor(force = false): Promise<void> {
  if (doctorRunning) return; doctorRunning = true;
  try {
    const s = db.prepare(`SELECT doctor_ok_at, doctor_report FROM system_state WHERE id=1`).get() as any;
    const rep = s.doctor_report ? JSON.parse(s.doctor_report) : null;
    if (!force && s.doctor_ok_at && rep?.bin_sig === binSignature(BIN())) { sep = rep.sep ?? ','; setArgvFallback(rep.argv_fallback !== false); return; }
    log('running doctor probes against', BIN());
    db.prepare(`UPDATE agents SET presence='disabled'`).run();
    const r = await runDoctor(db, BIN(), toolPort, tokens);
    const raw = (db.prepare(`SELECT doctor_report FROM system_state WHERE id=1`).get() as any).doctor_report;
    const fresh = raw ? JSON.parse(raw) : null;               // null if doctor was stopped before writing a report
    sep = fresh?.sep ?? ',';
    log(`doctor ${r.ok ? 'passed' : 'FAILED'}:`, r.checks.map((c) => `${c.id}=${c.ok ? 'ok' : c.level}`).join(' '));
  } finally { doctorRunning = false; refreshAllPresence(db); }
}

const timers: NodeJS.Timeout[] = [];
function installSignalHandlers(): void {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true; timers.forEach(clearInterval);
    log(`${sig}: stopping children`);
    killDoctorProbes();
    try { await killAll('shutdown'); } catch (e: any) { log('killAll error', e?.message); }   // close handlers requeue them (J11 orphaned); anything left is recovered at next boot
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
  });
}

async function boot(): Promise<void> {
  installSignalHandlers();               // before recoverOrphans/doctor so a signal during probes still cleans up
  ensureDir(dataDir());
  acquireSingleton();
  await recoverOrphans();
  let control = '';
  try { control = fs.readFileSync(paths.controlToken(), 'utf8').trim(); } catch {}
  if (!control) { control = randomToken(); fs.writeFileSync(paths.controlToken(), control, { mode: 0o600 }); }
  const server = await startToolServer({ db, tokens, controlToken: control, onControl: async (p, body) => {
    if (p === 'wake') { setImmediate(tick); return {}; }
    if (p === 'kill') { if (!killing) { killing = true; killAll('kill').catch((e) => log('killAll error', e?.message)).finally(() => { killing = false; }); } return { accepted: true }; }   // survivors arrive in the kill.engaged follow-up event
    if (p === 'cancel') { const c = children.get(Number(body.job_id)); if (c) killChild(c, 'cancelled', tokens); return {}; }
    if (p === 'doctor') { doctor(true).catch((e) => log('doctor error', e?.message)); return { started: true }; }
    return { ok: false };
  } });
  toolPort = (server.address() as any).port;
  db.prepare(`UPDATE system_state SET tool_server_port=? WHERE id=1`).run(toolPort);
  if (process.argv.includes('--doctor-only')) { await doctor(true); process.exit(0); }
  await doctor();
  emit(db, 'orchestrator.started', 'system', 'system', 1, { me: ME, port: toolPort });
  refreshAllPresence(db);
  log(`started ${ME}, tool server 127.0.0.1:${toolPort}, data ${dataDir()}`);
  timers.push(setInterval(tick, 1000), setInterval(heartbeat, HEARTBEAT_MS), setInterval(sweep, 5000));
}

boot().catch((e) => { console.error(e); process.exit(1); });
