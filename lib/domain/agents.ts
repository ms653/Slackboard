import type { DB } from '../db';
import { WORKER_TOOLS } from '../db';
import { now, DomainError } from '../util';
import { paths, ensureDir } from '../paths';
import { emit } from './events';
import { cancelQueued, refreshPresence } from './jobs';
import { helpEnded } from './finish';

/** PHASE2 §T4.1, §T6.1, §T5.1: names, bounds, active-worker queries and the agent lifecycle (A2/A4/A5/A6). */
export const NAME_RE = /^[a-z][a-z0-9_]{1,23}$/;
export const RESERVED_NAMES = ['user', 'system', 'director', 'worker', 'chief_of_staff'];
export const MAX_WORKERS = 3;
export const WORK_CAP_USD = 1.0;

export interface AgentRow {
  id: string; display_name: string; role: string; model: string; enabled: number; presence: string; presence_detail: string | null;
  created_at: number; retired_at: number | null; skill_note: string | null; spawn_approval_id: number | null;
}

/** Active (not retired) workers, oldest first. */
export const activeWorkerIds = (db: DB): string[] =>
  (db.prepare(`SELECT id FROM agents WHERE role='worker' AND retired_at IS NULL ORDER BY created_at, rowid`).all() as { id: string }[]).map((r) => r.id);
export const enabledWorkerIds = (db: DB): string[] =>
  (db.prepare(`SELECT id FROM agents WHERE role='worker' AND enabled=1 AND retired_at IS NULL ORDER BY created_at, rowid`).all() as { id: string }[]).map((r) => r.id);

/** T1/T2: the enabled worker with the fewest open tasks, ties by created_at. */
export function fewestOpenWorker(db: DB): string | null {
  const r = db.prepare(`SELECT a.id FROM agents a WHERE a.role='worker' AND a.enabled=1 AND a.retired_at IS NULL
    ORDER BY (SELECT count(*) FROM tasks t WHERE t.assignee_agent_id=a.id AND t.status IN ('proposed','todo','in_progress','in_review','blocked')), a.created_at, a.rowid LIMIT 1`)
    .get() as { id: string } | undefined;
  return r?.id ?? null;
}

export function checkAllowance(usd: unknown, jobs: unknown): void {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new DomainError('validation_error', 'daily_usd must be a number', 400);
  if (usd < WORK_CAP_USD) throw new DomainError('allowance_below_job_cap', 'at least $1.00: one work run reserves $1.00', 400);
  if (usd > 3) throw new DomainError('validation_error', 'daily_usd must be at most 3.00', 400);
  if (typeof jobs !== 'number' || !Number.isInteger(jobs) || jobs < 1 || jobs > 20) throw new DomainError('validation_error', 'daily_jobs must be an integer 1-20', 400);
}

export function nameTaken(db: DB, name: string): boolean {
  return RESERVED_NAMES.includes(name) || !!db.prepare(`SELECT 1 FROM agents WHERE id=?`).get(name);
}

export interface SpawnPayload { action: 'spawn_worker'; name: string; skill_note: string; model: 'sonnet'; daily_usd: number; daily_jobs: number }

/** A2 re-validation of a stored payload (also used by the tool). Throws 400 invalid_payload. */
export function parseSpawnPayload(p: any): SpawnPayload {
  const bad = (hint: string) => new DomainError('invalid_payload', hint, 400);
  if (!p || typeof p !== 'object' || p.action !== 'spawn_worker') throw bad('not a spawn_worker payload');
  if (typeof p.name !== 'string' || !NAME_RE.test(p.name) || RESERVED_NAMES.includes(p.name)) throw bad('name');
  if (typeof p.skill_note !== 'string' || p.skill_note.trim().length < 1 || p.skill_note.trim().length > 500) throw bad('skill_note');
  p = { ...p, skill_note: p.skill_note.trim() };
  if (p.model !== 'sonnet') throw bad('model');
  if (typeof p.daily_usd !== 'number' || !(p.daily_usd >= WORK_CAP_USD && p.daily_usd <= 3)) throw bad('daily_usd');
  if (!Number.isInteger(p.daily_jobs) || p.daily_jobs < 1 || p.daily_jobs > 20) throw bad('daily_jobs');
  return p as SpawnPayload;
}

/** Inserts the agent row and its per-agent day budget row (A2 / A4). The DB triggers are the backstop for cap and approval. */
export function insertWorker(db: DB, o: { name: string; skill_note: string; daily_usd: number; daily_jobs: number; spawnApprovalId: number | null }): void {
  const t = now();
  db.prepare(`INSERT INTO agents(id, display_name, role, model, max_turns, max_budget_usd, allowed_tools, created_at, skill_note, spawn_approval_id)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(o.name, o.name, 'worker', 'sonnet', 15, 1.0, JSON.stringify(WORKER_TOOLS), t, o.skill_note, o.spawnApprovalId);
  db.prepare(`INSERT INTO budgets(scope, agent_id, period, limit_usd, limit_jobs, updated_at) VALUES ('agent',?,'day',?,?,?)`).run(o.name, o.daily_usd, o.daily_jobs, t);
  emit(db, 'settings.changed', 'user', 'agent', o.name, { agent_created: { name: o.name, via: o.spawnApprovalId ? 'approval' : 'settings',
    approval_id: o.spawnApprovalId, daily_usd: o.daily_usd, daily_jobs: o.daily_jobs } });
  refreshPresence(db, o.name);
}
export const ensureAgentDir = (id: string): void => { ensureDir(paths.agentDir(id)); };

/** A4: user adds a worker in Settings (no approval). */
export function createWorkerByUser(db: DB, o: { name?: unknown; skill_note?: unknown; daily_usd?: unknown; daily_jobs?: unknown }): string {
  const name = o.name, skill = typeof o.skill_note === 'string' ? o.skill_note.trim() : '';
  if (typeof name !== 'string' || !NAME_RE.test(name) || RESERVED_NAMES.includes(name))
    throw new DomainError('validation_error', 'name must match ^[a-z][a-z0-9_]{1,23}$ and not be reserved', 400);
  if (skill.length < 1 || skill.length > 500) throw new DomainError('validation_error', 'skill note must be 1-500 characters', 400);
  checkAllowance(o.daily_usd, o.daily_jobs);
  if (nameTaken(db, name)) throw new DomainError('name_taken', 'Name already used', 409);
  if (activeWorkerIds(db).length >= MAX_WORKERS) throw new DomainError('worker_cap', 'Worker limit reached (3). Retire a worker first.', 409);
  insertWorker(db, { name, skill_note: skill, daily_usd: o.daily_usd as number, daily_jobs: o.daily_jobs as number, spawnApprovalId: null });
  return name;
}

/** A5. A retired agent can never be re-enabled (trigger agent_retired). */
export function setEnabled(db: DB, id: string, enabled: boolean): void {
  const a = db.prepare(`SELECT id, retired_at FROM agents WHERE id=?`).get(id) as { id: string; retired_at: number | null } | undefined;
  if (!a) throw new DomainError('not_found', '', 404);
  if (a.retired_at && enabled) throw new DomainError('agent_retired', 'a retired agent cannot be enabled');
  db.prepare(`UPDATE agents SET enabled=? WHERE id=?`).run(enabled ? 1 : 0, id);
  emit(db, 'settings.changed', 'user', 'agent', id, { enabled });
  refreshPresence(db, id);
}

/** Which actions the user still has on an open task, for the retire hint (§B6). */
function taskActions(t: any): string[] {
  const agentTop = t.created_by_kind === 'agent' && !t.parent_id;
  if (agentTop) return ['cancel', 're-propose'];
  if (t.status === 'todo' || (t.status === 'blocked' && t.blocked_reason !== 'help')) return ['reassign', 'cancel'];
  return ['finish', 'cancel'];
}

/** A6: one IMMEDIATE txn (the caller's), checks in the spec order, then cancel queued jobs and retire. */
export function retireAgent(db: DB, id: string): void {
  const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | undefined;
  if (!a) throw new DomainError('not_found', '', 404);
  if (a.retired_at) throw new DomainError('agent_retired', 'already retired');
  if (a.role !== 'worker') throw new DomainError('retire_invalid', 'only workers can be retired');
  const open = db.prepare(`SELECT id, status, blocked_reason, created_by_kind, parent_id FROM tasks WHERE assignee_agent_id=?
                           AND status IN ('proposed','todo','in_progress','in_review','blocked') ORDER BY id`).all(id) as any[];
  if (open.length) {
    const e = new DomainError("agent_has_open_tasks", "Finish or cancel these first", 409);
    (e as any).extra = { tasks: open.map((t) => ({ id: t.id, status: t.status, actions: taskActions(t) })) };
    throw e;
  }
  if (db.prepare(`SELECT 1 FROM jobs WHERE agent_id=? AND status='running'`).get(id)) throw new DomainError('agent_busy', `${id} is running; cancel its run or wait`);
  if (!db.prepare(`SELECT 1 FROM agents WHERE role='worker' AND retired_at IS NULL AND id<>?`).get(id)) throw new DomainError('last_worker', 'Keep at least one worker');
  const cancelled = cancelQueued(db, 'agent_id = ?', [id], 'cancelled', 'user');
  for (const j of cancelled) if (j.kind === 'help') helpEnded(db, { ...j, status: 'cancelled' });
  db.prepare(`UPDATE agents SET retired_at=?, enabled=0 WHERE id=?`).run(now(), id);
  emit(db, 'settings.changed', 'user', 'agent', id, { retired: true });
  refreshPresence(db, id);
}

/** Per-agent day budget upsert (PUT /api/budgets agents, POST /api/agents). */
export function setAgentBudget(db: DB, id: string, usd: unknown, jobs: unknown): void {
  checkAllowance(usd, jobs);
  const a = db.prepare(`SELECT role, retired_at FROM agents WHERE id=?`).get(id) as { role: string; retired_at: number | null } | undefined;
  if (!a) throw new DomainError('not_found', 'no such agent', 404);
  if (a.role !== 'worker' || a.retired_at) throw new DomainError('validation_error', 'only active workers have a budget', 400);
  const t = now();
  const old = db.prepare(`SELECT limit_usd, limit_jobs FROM budgets WHERE scope='agent' AND agent_id=? AND period='day'`).get(id);
  if (old) db.prepare(`UPDATE budgets SET limit_usd=?, limit_jobs=?, updated_at=? WHERE scope='agent' AND agent_id=? AND period='day'`).run(usd, jobs, t, id);
  else db.prepare(`INSERT INTO budgets(scope, agent_id, period, limit_usd, limit_jobs, updated_at) VALUES ('agent',?,'day',?,?,?)`).run(id, usd, jobs, t);
  emit(db, 'settings.changed', 'user', 'agent', id, { budget: { old: old ?? null, new: { limit_usd: usd, limit_jobs: jobs } } });
  refreshPresence(db, id);
}

export function setMaxConcurrency(db: DB, n: number, o: { minCurrent?: boolean; via?: string } = {}): void {
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new DomainError('validation_error', 'max concurrency must be 1-4', 400);
  const cur = (db.prepare(`SELECT max_concurrency m FROM system_state WHERE id=1`).get() as { m: number }).m;
  if (o.minCurrent && n < cur) throw new DomainError('validation_error', `max concurrency must be at least ${cur}`, 400);
  if (n === cur) return;
  db.prepare(`UPDATE system_state SET max_concurrency=? WHERE id=1`).run(n);
  emit(db, 'settings.changed', 'user', 'budget', null, { old: { max_concurrency: cur }, new: { max_concurrency: n }, ...(o.via ? { via: o.via } : {}) });
}
