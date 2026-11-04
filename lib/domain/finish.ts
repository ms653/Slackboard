import type { DB } from '../db';
import { now, backoffMs } from '../util';
import { emit } from './events';
import { enqueueJob, refreshPresence, agentRole, PRIORITY, type JobRow } from './jobs';
import { systemMessage } from './messages';
import { getTask } from './rounds';
import { setStatus } from './tasks';

export interface Outcome {
  exitCode?: number | null; signal?: string | null;
  result?: { subtype?: string; total_cost_usd?: number; num_turns?: number } | null;
  killedFor?: 'kill' | 'cancelled' | 'timeout_wall' | 'timeout_idle' | 'lease_lost' | 'shutdown' | null;
  failure?: 'orphaned' | 'spawn_error' | 'mcp_not_connected' | 'tools_missing' | 'workspace_drift' | null;
  initSeen?: boolean; sawUsageLimit?: boolean; permissionDenials?: number; error?: string | null;
}
export type Classified = { rule: string; status: 'succeeded' | 'failed' | 'cancelled' | 'killed' | 'queued'; failure: string | null };

const SUBTYPES = ['success', 'error_max_turns', 'error_max_budget_usd', 'error_during_execution'];
const hasToolCall = (db: DB, jobId: number, tool: string) =>
  !!db.prepare(`SELECT 1 FROM tool_calls WHERE job_id=? AND tool=? AND outcome='ok'`).get(jobId, tool);

/** The `routed_to` of the job's last ok request_help ('director' or a peer id). */
export function lastOkRequestHelp(db: DB, jobId: number): { routed_to: string } {
  const r = db.prepare(`SELECT result FROM tool_calls WHERE job_id=? AND tool='request_help' AND outcome='ok' ORDER BY id DESC LIMIT 1`).get(jobId) as { result: string } | undefined;
  return { routed_to: r ? JSON.parse(r.result).routed_to ?? 'director' : 'director' };
}

/** Help-end rule (TECH §3.2): a help job ended without handoff and its task is still blocked/help. */
export function helpEnded(db: DB, job: JobRow): void {
  if (job.kind !== 'help' || !job.task_id) return;
  const t = getTask(db, job.task_id);
  if (!t || t.status !== 'blocked' || t.blocked_reason !== 'help') return;
  const peer = db.prepare(`SELECT role FROM agents WHERE id=?`).get(job.agent_id) as { role: string } | undefined;
  if (peer?.role === 'worker' && t.help_agent_id !== job.agent_id) return;     // PHASE2 §T3.2: T11c/T16 cancellations never fire it
  const other = db.prepare(`SELECT 1 FROM jobs WHERE task_id=? AND kind='help' AND status IN ('queued','running') AND id<>?`).get(t.id, job.id);
  if (other) return;
  db.prepare(`UPDATE tasks SET blocked_reason='job_failed', updated_by='system', updated_at=?, version=version+1 WHERE id=?`).run(now(), t.id);
  emit(db, 'task.updated', 'system', 'task', t.id, { blocked_reason: 'job_failed' });
  systemMessage(db, t.thread_id, `${job.agent_id} could not answer the help request (${job.failure_kind ?? job.status}). Retry, or reply here to unblock the worker yourself.`);
}

/** Requeue preserving id/attempts/session; merge a colliding queued sibling into it (TECH §3.2). */
function requeue(db: DB, j: JobRow, reason: string, runAfter: number, extra: Record<string, unknown> = {}): void {
  const sib = db.prepare(`SELECT id, trigger_count FROM jobs WHERE agent_id=? AND thread_id=? AND kind=? AND status='queued' AND id<>?`)
    .get(j.agent_id, j.thread_id, j.kind, j.id) as { id: number; trigger_count: number } | undefined;
  let add = 0;
  if (sib) {
    db.prepare(`UPDATE jobs SET status='cancelled', failure_kind='cancelled', finished_at=? WHERE id=?`).run(now(), sib.id);
    emit(db, 'job.finished', 'system', 'job', sib.id, { status: 'cancelled', merged_into: j.id }, sib.id);
    add = sib.trigger_count;
  }
  const f: Record<string, unknown> = { status: 'queued', lease_owner: null, lease_expires_at: null, run_token_hash: null,
    budget_reserved_usd: 0, run_after: runAfter, failure_kind: reason, trigger_count: j.trigger_count + add, pid: null, proc_start: null, ...extra };
  const keys = Object.keys(f);
  db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k}=@${k}`).join(',')} WHERE id=@__id`).run({ ...f, __id: j.id });
  emit(db, 'job.requeued', 'system', 'job', j.id, { reason, run_after: runAfter, attempts: j.attempts }, j.id);
}

/** Pure classification of an attempt (J5–J18). Reads tool_calls and the task; no writes. */
export function classify(db: DB, j: JobRow, o: Outcome, killOn: boolean): Classified {
  let killedFor = o.killedFor ?? null;
  const subtype = o.result?.subtype ? (SUBTYPES.includes(o.result.subtype) ? o.result.subtype : 'error_during_execution') : null;
  const success = subtype === 'success' && o.exitCode === 0 && !killedFor && !o.failure;
  if (killOn && !killedFor && !success) killedFor = 'kill';
  if (killedFor === 'kill') return { rule: 'J15', status: 'killed', failure: 'killed' };
  if (killedFor === 'cancelled') {
    const t = j.task_id ? getTask(db, j.task_id) : undefined;
    return { rule: t?.status === 'cancelled' ? 'J16' : 'J17', status: 'cancelled', failure: 'cancelled' };
  }
  if (o.failure === 'mcp_not_connected' || o.failure === 'tools_missing') return { rule: 'J13', status: 'failed', failure: o.failure };
  if (o.failure === 'workspace_drift') return { rule: 'J18', status: 'failed', failure: 'workspace_drift' };
  const cancelReq = j.cancel_requested === 1;
  const asRequeue = (rule: string, failure: string): Classified => cancelReq
    ? { rule: j.task_id && getTask(db, j.task_id)?.status === 'cancelled' ? 'J16' : 'J17', status: 'cancelled', failure: 'cancelled' }
    : { rule, status: 'queued', failure };
  if (!success && o.sawUsageLimit) return asRequeue('J14', 'usage_limit');
  if (success) {
    const t = j.task_id ? getTask(db, j.task_id) : undefined;
    if (j.kind === 'work') {
      if (t && t.status === 'in_progress' && hasToolCall(db, j.id, 'request_help')) return { rule: 'J5+T11', status: 'succeeded', failure: null };
      if (t && t.status !== 'in_progress') return { rule: 'J5', status: 'succeeded', failure: null };
    } else if (j.kind === 'review') {
      if (t && t.status !== 'in_review') return { rule: 'J5', status: 'succeeded', failure: null };
    } else if (j.kind === 'help') {
      if (t && t.status === 'blocked' && t.blocked_reason === 'help' && !hasToolCall(db, j.id, 'request_help'))
        return { rule: 'J5-no_handoff', status: 'failed', failure: 'no_handoff' };
      return { rule: 'J5', status: 'succeeded', failure: null };
    } else return { rule: 'J5', status: 'succeeded', failure: null };
    return j.continuations === 0 ? asRequeue('J6', 'no_handoff') : { rule: 'J7', status: 'failed', failure: 'no_handoff' };
  }
  if (subtype === 'error_max_turns') return j.continuations === 0 ? asRequeue('J8', 'max_turns') : { rule: 'J9', status: 'failed', failure: 'max_turns' };
  if (subtype === 'error_max_budget_usd') return { rule: 'J10', status: 'failed', failure: 'max_budget' };
  const failure = (killedFor === 'shutdown' ? 'orphaned' : killedFor) ?? o.failure ?? (subtype === 'error_during_execution' ? 'error_during_execution'
    : (o.exitCode ?? 0) !== 0 ? 'exit_nonzero' : 'no_result');
  return j.attempts < j.max_attempts ? asRequeue('J11', failure) : { rule: 'J12', status: 'failed', failure };
}

/** finishAttempt(job, outcome, expectedOwner) — one IMMEDIATE txn by the caller. Returns the classification or null (not ours). */
export function finishAttempt(db: DB, jobId: number, o: Outcome, expectedOwner: string): Classified | null {
  const j = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(jobId) as JobRow | undefined;
  if (!j || j.status !== 'running' || j.lease_owner !== expectedOwner) return null;
  const ss = db.prepare(`SELECT kill_switch, pause_reason FROM system_state WHERE id=1`).get() as { kill_switch: number; pause_reason: string | null };
  const c = classify(db, j, o, ss.kill_switch === 1);
  const t = now();
  const pastInit = o.initSeen !== undefined ? o.initSeen : j.session_started === 1 && (j.last_output_at ?? 0) > (j.started_at ?? 0);
  const estimated = !o.result && j.pid != null && pastInit && o.failure !== 'spawn_error' && o.failure !== 'workspace_drift'
    && o.failure !== 'tools_missing' && o.failure !== 'mcp_not_connected';   // estimate from the cap only if a process actually started
  const cost = o.result ? o.result.total_cost_usd ?? 0 : estimated ? j.budget_reserved_usd ?? 0 : 0;
  const subtype = o.result?.subtype ? (SUBTYPES.includes(o.result.subtype) ? o.result.subtype : 'error_during_execution') : null;
  db.prepare(`UPDATE jobs SET cost_usd = cost_usd + ?, num_turns = ?, result_subtype = ?, exit_code = ?, error = ?,
              permission_denials = permission_denials + ? WHERE id = ?`)
    .run(cost, o.result?.num_turns ?? null, subtype, o.exitCode ?? null, o.error?.slice(0, 2000) ?? null, o.permissionDenials ?? 0, j.id);
  emit(db, 'job.attempt_finished', 'system', 'job', j.id, { cost_usd: cost, num_turns: o.result?.num_turns ?? null, subtype, rule: c.rule, ...(estimated ? { estimated_from_cap: true } : {}) }, j.id);
  const task = j.task_id ? getTask(db, j.task_id) : undefined;

  if (c.status === 'queued') {
    if (c.rule === 'J14') {
      requeue(db, j, 'usage_limit', t, { attempts: Math.max(0, j.attempts - 1) });
      if (ss.pause_reason !== 'user') db.prepare(`UPDATE system_state SET paused_until=?, pause_reason='usage_limit' WHERE id=1`).run(t + 30 * 60_000);
      emit(db, 'limit.suspected', 'system', 'system', 1, { job_id: j.id });
    } else if (c.rule === 'J6' || c.rule === 'J8') {
      requeue(db, j, c.failure!, t, { continuations: 1 });
    } else requeue(db, j, c.failure!, t + backoffMs(j.attempts));
    if (j.kind === 'work' && task?.status === 'in_progress') setStatus(db, task, 'todo', 'system');      // T9
  } else {
    db.prepare(`UPDATE jobs SET status=?, failure_kind=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL,
                run_token_hash=NULL, budget_reserved_usd=0 WHERE id=?`).run(c.status, c.failure, t, j.id);
    emit(db, 'job.finished', 'system', 'job', j.id, { status: c.status, failure_kind: c.failure, rule: c.rule }, j.id);
    const fresh = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(j.id) as JobRow;
    const live = (s: string[]) => task && s.includes(task.status);
    if (c.rule === 'J5+T11' && task) {
      const target = lastOkRequestHelp(db, j.id).routed_to;                                          // T11: 'director' or a peer
      setStatus(db, task, 'blocked', 'system', { blocked_reason: 'help', help_agent_id: target });
      enqueueJob(db, { agent: target, kind: 'help', thread: task.thread_id, task: task.id, priority: PRIORITY.help });
      if (target !== 'director') systemMessage(db, task.thread_id, `T-${task.id} blocked: waiting on ${target} (help) · director can see this`);
    } else if (j.kind === 'help' && task && task.status === 'blocked' && task.blocked_reason === 'help'
        && task.help_agent_id === j.agent_id && agentRole(db, j.agent_id) === 'worker' && hasToolCall(db, j.id, 'request_help')) {   // T11b: a peer escalates to the director, on any terminal outcome once its ok request_help exists
      db.prepare(`UPDATE tasks SET help_agent_id='director', updated_by='system', updated_at=?, version=version+1 WHERE id=?`).run(now(), task.id);
      emit(db, 'task.updated', 'system', 'task', task.id, { help_agent_id: 'director' });
      enqueueJob(db, { agent: 'director', kind: 'help', thread: task.thread_id, task: task.id, priority: PRIORITY.help });
      if (task.assignee_agent_id) refreshPresence(db, task.assignee_agent_id);
    } else if (c.status === 'killed') {
      if ((j.kind === 'work' || j.kind === 'review') && live(['in_progress', 'in_review'])) setStatus(db, task!, 'blocked', 'system', { blocked_reason: 'killed' });
      helpEnded(db, fresh);
    } else if (c.rule === 'J17') {
      if ((j.kind === 'work' || j.kind === 'review') && live(['in_progress', 'in_review'])) setStatus(db, task!, 'blocked', 'user', { blocked_reason: 'user' });
      helpEnded(db, fresh);
    } else if (c.status === 'failed') {
      if (c.rule === 'J13') db.prepare(`UPDATE system_state SET doctor_ok_at=NULL WHERE id=1`).run();
      if ((j.kind === 'work' || j.kind === 'review') && live(['in_progress', 'in_review'])) {
        setStatus(db, task!, 'blocked', 'system', { blocked_reason: 'job_failed' });                    // T10
        systemMessage(db, task!.thread_id, `${j.agent_id} ${j.kind} job failed (${c.failure}). Retry from Needs you.`);
      } else if (j.kind === 'help') helpEnded(db, fresh);
      else if (j.kind === 'respond') systemMessage(db, j.thread_id, `${j.agent_id} failed ${j.attempts} times: ${c.failure}. Send your message again to retry.`);
    }
  }
  refreshPresence(db, j.agent_id);
  return c;
}
