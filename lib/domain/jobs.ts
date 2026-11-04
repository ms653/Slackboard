import type { DB } from '../db';
import { now } from '../util';
import { emit } from './events';
import { queueReason } from './claim';
import { helpEscalatedToUser } from './tasks';
import type { TaskRow } from './rounds';

export type JobKind = 'respond' | 'work' | 'review' | 'help';
export interface JobRow {
  id: number; agent_id: string; kind: JobKind; thread_id: number; task_id: number | null; trigger_message_id: number | null;
  trigger_count: number; status: string; priority: number; run_after: number; attempts: number; max_attempts: number;
  continuations: number; session_id: string | null; session_started: number; lease_owner: string | null;
  lease_expires_at: number | null; heartbeat_at: number | null; last_output_at: number | null; pid: number | null;
  proc_start: string | null; run_token_hash: string | null; cancel_requested: number; budget_cap_usd: number;
  budget_reserved_usd: number; cost_usd: number; num_turns: number | null; result_subtype: string | null;
  exit_code: number | null; failure_kind: string | null; permission_denials: number; error: string | null;
  created_at: number; started_at: number | null; finished_at: number | null;
}

/** Per-(role, kind) settings, TECH §6.1. */
export interface KindSettings { cwd: 'agent' | 'workspace'; maxTurns: number; budget: number; builtins: string[]; tools: string[]; wallMs: number }
export function kindSettings(role: string, kind: JobKind): KindSettings {
  const ro = ['Read', 'Glob', 'Grep'];
  if (role === 'director') {
    if (kind === 'review') return { cwd: 'workspace', maxTurns: 6, budget: 0.40, builtins: ro, wallMs: 360_000,
      tools: ['post_message', 'update_task', 'add_note', 'request_help'] };
    return { cwd: 'agent', maxTurns: 8, budget: 0.40, builtins: ro, wallMs: 240_000,
      tools: ['post_message', 'create_task', 'update_task', 'add_note', 'request_help', 'request_approval', 'spawn_worker'] };
  }
  if (kind === 'work') return { cwd: 'workspace', maxTurns: 15, budget: 1.00, builtins: [...ro, 'Write', 'Edit'], wallMs: 900_000,
    tools: ['post_message', 'update_task', 'add_note', 'request_help'] };
  return { cwd: 'agent', maxTurns: 6, budget: 0.30, builtins: ro, wallMs: 240_000, tools: ['post_message', 'add_note', 'request_help'] };
}
export function agentRole(db: DB, agentId: string): string {
  const a = db.prepare(`SELECT role FROM agents WHERE id = ?`).get(agentId) as { role: string } | undefined;
  if (!a) throw new Error(`unknown agent ${agentId}`);
  return a.role;
}

export const PRIORITY = { work: 100, respond: 80, help: 60, review: 50, directorWake: 90 } as const;

/** J1: enqueue with coalescing on (agent, thread, kind). Returns job id. */
export function enqueueJob(db: DB, o: { agent: string; kind: JobKind; thread: number; task?: number | null;
  trigger?: number | null; priority?: number; actor?: string }): number {
  const existing = db.prepare(`SELECT id FROM jobs WHERE agent_id=? AND thread_id=? AND kind=? AND status='queued'`)
    .get(o.agent, o.thread, o.kind) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE jobs SET trigger_count = trigger_count + 1, trigger_message_id = coalesce(?, trigger_message_id) WHERE id = ?`)
      .run(o.trigger ?? null, existing.id);
    return existing.id;
  }
  const s = kindSettings(agentRole(db, o.agent), o.kind);
  const t = now();
  const r = db.prepare(`INSERT INTO jobs(agent_id, kind, thread_id, task_id, trigger_message_id, priority, run_after, budget_cap_usd, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(o.agent, o.kind, o.thread, o.task ?? null, o.trigger ?? null, o.priority ?? PRIORITY[o.kind], t, s.budget, t);
  const id = Number(r.lastInsertRowid);
  emit(db, 'job.enqueued', o.actor ?? 'system', 'job', id, { agent: o.agent, kind: o.kind, thread_id: o.thread, task_id: o.task ?? null }, id);
  refreshPresence(db, o.agent);
  return id;
}

/** Cancel queued jobs (J4 / thread close / J3). */
export function cancelQueued(db: DB, where: string, params: unknown[], kind: string, actor = 'system'): JobRow[] {
  const rows = db.prepare(`SELECT * FROM jobs WHERE status='queued' AND ${where}`).all(...params) as JobRow[];
  const t = now();
  for (const j of rows) {
    db.prepare(`UPDATE jobs SET status='cancelled', failure_kind=?, finished_at=? WHERE id=? AND status='queued'`).run(kind, t, j.id);
    emit(db, 'job.finished', actor, 'job', j.id, { status: 'cancelled', failure_kind: kind }, j.id);
    refreshPresence(db, j.agent_id);
  }
  return rows;
}

/** Presence derived from state (UX §4, PHASE2 §B1/§T5.1). failed persists until the agent's next succeeded job. */
export function refreshPresence(db: DB, agentId: string): void {
  const a = db.prepare(`SELECT enabled, presence, presence_detail FROM agents WHERE id=?`).get(agentId) as { enabled: number; presence: string; presence_detail: string | null } | undefined;
  if (!a) return;
  const ss = db.prepare(`SELECT kill_switch, paused_until, pause_reason FROM system_state WHERE id=1`).get() as any;
  const running = db.prepare(`SELECT kind FROM jobs WHERE agent_id=? AND status='running'`).get(agentId) as { kind: string } | undefined;
  let p: string, detail: string | null = null;
  if (!a.enabled) p = 'disabled';
  else if (running) { p = running.kind === 'review' ? 'reviewing' : 'working'; detail = ['working', 'reviewing'].includes(a.presence) ? a.presence_detail : null; }
  else if (ss.kill_switch || ss.pause_reason === 'user' || (ss.paused_until ?? 0) > now()) p = 'paused';
  else {
    const last = db.prepare(`SELECT status FROM jobs WHERE agent_id=? AND finished_at IS NOT NULL AND status IN ('succeeded','failed')
                             ORDER BY finished_at DESC, id DESC LIMIT 1`).get(agentId) as { status: string } | undefined;
    const queued = db.prepare(`SELECT 1 FROM jobs WHERE agent_id=? AND status='queued'`).get(agentId);
    const blocked = db.prepare(`SELECT * FROM tasks WHERE assignee_agent_id=? AND status='blocked' AND blocked_reason='help' ORDER BY id LIMIT 1`).get(agentId) as TaskRow | undefined;
    if (last?.status === 'failed') p = 'failed';
    else if (queued && queueReason(db, agentId) === 'agent budget') { p = 'paused'; detail = 'agent budget'; }
    else if (queued) p = 'queued';
    else if (blocked) {
      if (helpEscalatedToUser(db, blocked)) { p = 'blocked'; detail = 'waiting on you'; }
      else { p = 'idle'; detail = blocked.help_agent_id ? `waiting on ${blocked.help_agent_id} · T-${blocked.id}` : null; }
    } else p = 'idle';
  }
  if (p !== a.presence || detail !== a.presence_detail) {
    db.prepare(`UPDATE agents SET presence=?, presence_detail=? WHERE id=?`).run(p, detail, agentId);
    if (p !== a.presence) emit(db, 'agent.presence', 'system', 'agent', agentId, { presence: p, ...(detail ? { detail } : {}) });
  }
}
export function refreshAllPresence(db: DB): void {
  for (const a of db.prepare(`SELECT id FROM agents`).all() as { id: string }[]) refreshPresence(db, a.id);
}
