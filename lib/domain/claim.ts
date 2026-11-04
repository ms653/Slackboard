import type { DB } from '../db';
import { now, localMidnight, uuid, sha256 } from '../util';
import { emit } from './events';
import { cancelQueued, refreshPresence, type JobRow } from './jobs';
import { capThreadForJobs } from './threads';
import { systemMessage } from './messages';

export function budgetNumbers(db: DB, t = now()) {
  const mid = localMidnight(t);
  const spent = (db.prepare(`SELECT ifnull(sum(json_extract(payload,'$.cost_usd')),0) AS v FROM events WHERE type='job.attempt_finished' AND ts >= ?`).get(mid) as any).v as number;
  const reserved = (db.prepare(`SELECT ifnull(sum(budget_reserved_usd),0) AS v FROM jobs WHERE status='running'`).get() as any).v as number;
  const jobsDay = (db.prepare(`SELECT count(*) AS v FROM events WHERE type='job.started' AND ts >= ?`).get(mid) as any).v as number;
  const jobs5h = (db.prepare(`SELECT count(*) AS v FROM events WHERE type='job.started' AND ts >= ?`).get(t - 18_000_000) as any).v as number;
  const day = db.prepare(`SELECT limit_usd, limit_jobs FROM budgets WHERE scope='global' AND period='day'`).get() as any;
  const h5 = db.prepare(`SELECT limit_jobs FROM budgets WHERE scope='global' AND period='rolling_5h'`).get() as any;
  return { spent, reserved, jobsDay, jobs5h,
    limitUsdDay: day?.limit_usd ?? 1e9, limitJobsDay: day?.limit_jobs ?? 1e9, limitJobs5h: h5?.limit_jobs ?? 1e9 };
}

export interface AgentNumbers { spent: number; reserved: number; started: number; limit_usd: number | null; limit_jobs: number | null }
/** Per-agent day numbers for an agent that has a scope='agent', period='day' row (PHASE2 §T5.1), else null. */
export function agentNumbers(db: DB, agentId: string, t = now()): AgentNumbers | null {
  const b = db.prepare(`SELECT limit_usd, limit_jobs FROM budgets WHERE scope='agent' AND agent_id=? AND period='day'`).get(agentId) as { limit_usd: number | null; limit_jobs: number | null } | undefined;
  if (!b) return null;
  const mid = localMidnight(t);
  const spent = (db.prepare(`SELECT ifnull(sum(json_extract(e.payload,'$.cost_usd')),0) AS v FROM events e JOIN jobs j ON j.id = e.job_id
    WHERE e.type='job.attempt_finished' AND e.ts >= ? AND j.agent_id = ?`).get(mid, agentId) as any).v as number;
  const reserved = (db.prepare(`SELECT ifnull(sum(budget_reserved_usd),0) AS v FROM jobs WHERE status='running' AND agent_id=?`).get(agentId) as any).v as number;
  const started = (db.prepare(`SELECT count(*) AS v FROM events WHERE type='job.started' AND ts >= ? AND json_extract(payload,'$.agent') = ?`).get(mid, agentId) as any).v as number;
  return { spent, reserved, started, limit_usd: b.limit_usd, limit_jobs: b.limit_jobs };
}
/** The @agentRoom JSON for the claim SQL: only agents that have a day row. A tiny epsilon keeps 1.00 - 0.00 claimable. */
export function agentRoom(db: DB, t = now()): Record<string, { usd: number; jobs: number }> {
  const room: Record<string, { usd: number; jobs: number }> = {};
  for (const r of db.prepare(`SELECT agent_id FROM budgets WHERE scope='agent' AND period='day'`).all() as { agent_id: string }[]) {
    const n = agentNumbers(db, r.agent_id, t)!;
    room[r.agent_id] = { usd: (n.limit_usd ?? 1e9) - n.spent - n.reserved + 1e-9, jobs: (n.limit_jobs ?? 1e9) - n.started };
  }
  return room;
}

/** queueReason(agent): the same predicates as the claim SQL, evaluated in the spec order; first failing wins (PHASE2 §T5.1). */
export function queueReason(db: DB, agentId: string, t = now()): string | null {
  const j = db.prepare(`SELECT * FROM jobs WHERE agent_id=? AND status='queued' ORDER BY priority, id LIMIT 1`).get(agentId) as JobRow | undefined;
  if (!j) return null;
  const a = db.prepare(`SELECT role, enabled, retired_at FROM agents WHERE id=?`).get(agentId) as { role: string; enabled: number; retired_at: number | null };
  if (!a.enabled || a.retired_at) return 'disabled';
  const own = db.prepare(`SELECT task_id FROM jobs WHERE agent_id=? AND status='running'`).get(agentId) as { task_id: number | null } | undefined;
  if (own) return own.task_id ? `busy (running T-${own.task_id})` : 'busy (running)';
  const maxc = (db.prepare(`SELECT max_concurrency m FROM system_state WHERE id=1`).get() as { m: number }).m;
  const running = (db.prepare(`SELECT count(*) n FROM jobs WHERE status='running'`).get() as { n: number }).n;
  if (running >= maxc) return `run slots ${running}/${maxc}`;
  const runningWorkers = (db.prepare(`SELECT count(*) n FROM jobs r JOIN agents ra ON ra.id=r.agent_id WHERE r.status='running' AND ra.role='worker'`).get() as { n: number }).n;
  if (a.role === 'worker' && maxc > 1 && runningWorkers >= maxc - 1) return 'director slot reserved';
  const b = budgetNumbers(db, t);
  if (b.jobsDay >= b.limitJobsDay || b.jobs5h >= b.limitJobs5h) return 'job cap';
  if (b.spent + b.reserved + j.budget_cap_usd > b.limitUsdDay) return 'daily budget';
  const room = agentRoom(db, t)[agentId];
  if (room && (j.budget_cap_usd > room.usd || room.jobs <= 0)) return 'agent budget';
  const th = db.prepare(`SELECT status, agent_job_count, max_agent_jobs FROM threads WHERE id=?`).get(j.thread_id) as any;
  if (th.status !== 'open' || th.agent_job_count >= th.max_agent_jobs) return 'thread capped';
  return null;
}

/** Once per agent per day: budget.hit {scope:'agent'} + one system line in the thread of the agent's first queued job (§T5.1, §B1). Caller runs it in a txn. */
export function agentBudgetHits(db: DB, t = now()): string[] {
  const hit: string[] = [];
  for (const r of db.prepare(`SELECT DISTINCT j.agent_id FROM jobs j JOIN budgets b ON b.agent_id=j.agent_id AND b.scope='agent' AND b.period='day'
                              WHERE j.status='queued'`).all() as { agent_id: string }[]) {
    if (queueReason(db, r.agent_id, t) !== 'agent budget') continue;
    const seen = db.prepare(`SELECT 1 FROM events WHERE type='budget.hit' AND ts >= ? AND json_extract(payload,'$.scope')='agent' AND json_extract(payload,'$.agent')=?`).get(localMidnight(t), r.agent_id);
    if (seen) continue;
    const n = agentNumbers(db, r.agent_id, t)!;
    const first = db.prepare(`SELECT thread_id FROM jobs WHERE agent_id=? AND status='queued' ORDER BY (task_id IS NULL), priority, id LIMIT 1`).get(r.agent_id) as { thread_id: number };
    const why = n.limit_jobs != null && n.started >= n.limit_jobs ? `${n.started}/${n.limit_jobs} runs` : `$${(n.spent + n.reserved).toFixed(2)}/$${(n.limit_usd ?? 0).toFixed(2)} est.`;
    emit(db, 'budget.hit', 'system', 'budget', null, { scope: 'agent', agent: r.agent_id });
    systemMessage(db, first.thread_id, `${r.agent_id} reached its daily allowance (${why}); its runs wait until 00:00. [Edit budget]`);
    refreshPresence(db, r.agent_id);
    hit.push(r.agent_id);
  }
  return hit;
}

/** Housekeeping before claims: J4 (dead tasks) and J3 (thread job cap). */
export function cancelDeadQueuedJobs(db: DB): void {
  cancelQueued(db, `task_id IN (SELECT id FROM tasks WHERE status IN ('cancelled','done'))`, [], 'task_not_claimable');
  const capped = db.prepare(`SELECT DISTINCT t.id FROM jobs j JOIN threads t ON t.id=j.thread_id
                             WHERE j.status='queued' AND t.status='open' AND t.agent_job_count >= t.max_agent_jobs`).all() as { id: number }[];
  for (const c of capped) capThreadForJobs(db, c.id);
}

/** §5.3 atomic claim: one UPDATE ... RETURNING inside an IMMEDIATE txn (run by the caller). Returns the job + its token. */
export function claimNext(db: DB, me: string, token: string): JobRow | null {
  const t = now();
  const b = budgetNumbers(db, t);
  const ss = db.prepare(`SELECT max_concurrency FROM system_state WHERE id=1`).get() as { max_concurrency: number };
  const room = JSON.stringify(agentRoom(db, t));
  const job = db.prepare(`
    UPDATE jobs
       SET status='running', attempts=attempts+1, lease_owner=@me, lease_expires_at=@now+60000, heartbeat_at=@now,
           last_output_at=@now, started_at=@now, finished_at=NULL, run_token_hash=@th, budget_reserved_usd=budget_cap_usd,
           error=NULL, failure_kind=NULL,
           session_id = CASE WHEN session_started=1 THEN session_id ELSE @uuid END, pid=NULL, proc_start=NULL
     WHERE status='queued'
       AND (SELECT kill_switch=0 AND ifnull(paused_until,0) <= @now AND pause_reason IS NOT 'user' FROM system_state WHERE id=1)
       AND id = (
         SELECT j.id FROM jobs j JOIN agents a ON a.id=j.agent_id JOIN threads t ON t.id=j.thread_id
          WHERE j.status='queued' AND j.run_after <= @now AND a.enabled=1 AND a.retired_at IS NULL
            AND (a.role <> 'worker' OR @maxc = 1 OR
                 (SELECT count(*) FROM jobs r JOIN agents ra ON ra.id = r.agent_id WHERE r.status = 'running' AND ra.role = 'worker') < @maxc - 1)
            AND j.budget_cap_usd <= ifnull(json_extract(@agentRoom, '$."' || j.agent_id || '".usd'), 1e9)
            AND ifnull(json_extract(@agentRoom, '$."' || j.agent_id || '".jobs'), 1) > 0
            AND (j.kind <> 'help' OR a.role = 'director' OR
                 (SELECT k.status = 'blocked' AND k.blocked_reason = 'help' AND k.help_agent_id = j.agent_id FROM tasks k WHERE k.id = j.task_id))
            AND t.status='open' AND t.agent_job_count < t.max_agent_jobs
            AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.status='running' AND r.agent_id=j.agent_id)
            AND (j.task_id IS NULL OR (SELECT status FROM tasks k WHERE k.id=j.task_id) IN ('todo','in_progress','in_review','blocked'))
            AND (j.kind <> 'review' OR (SELECT status FROM tasks k WHERE k.id=j.task_id) = 'in_review')
            AND @spent + @reserved + j.budget_cap_usd <= @limUsd
            AND @jobsDay < @limJobsDay AND @jobs5h < @limJobs5h
          ORDER BY j.priority, j.id LIMIT 1)
       AND (SELECT count(*) FROM jobs WHERE status='running') < @maxc
    RETURNING *`).get({ me, now: t, th: sha256(token), uuid: uuid(), spent: b.spent, reserved: b.reserved,
      limUsd: b.limitUsdDay, jobsDay: b.jobsDay, limJobsDay: b.limitJobsDay, jobs5h: b.jobs5h, limJobs5h: b.limitJobs5h,
      maxc: ss.max_concurrency, agentRoom: room }) as JobRow | undefined;
  if (!job) return null;
  if (job.kind === 'work') {                                                             // T6
    const ok = db.prepare(`UPDATE tasks SET status='in_progress', claimed_by=@a, claim_expires_at=@now+60000, blocked_reason=NULL,
                           updated_by='system', updated_at=@now, version=version+1
                           WHERE id=@task AND assignee_agent_id=@a
                             AND (status='todo' OR (status='in_progress' AND (claimed_by=@a OR claim_expires_at < @now)))
                           RETURNING id`).get({ a: job.agent_id, now: t, task: job.task_id });
    if (!ok) {
      db.prepare(`UPDATE jobs SET status='cancelled', failure_kind='task_not_claimable', finished_at=@now, lease_owner=NULL,
                  lease_expires_at=NULL, run_token_hash=NULL, budget_reserved_usd=0 WHERE id=@id`).run({ now: t, id: job.id });
      emit(db, 'job.finished', 'system', 'job', job.id, { status: 'cancelled', failure_kind: 'task_not_claimable' }, job.id);
      refreshPresence(db, job.agent_id);
      return null;
    }
    emit(db, 'task.claimed', job.agent_id, 'task', job.task_id!, { job_id: job.id }, job.id);
  }
  db.prepare(`UPDATE threads SET agent_job_count = agent_job_count + 1 WHERE id=?`).run(job.thread_id);
  emit(db, 'job.started', 'system', 'job', job.id, { agent: job.agent_id, kind: job.kind, attempt: job.attempts, task_id: job.task_id }, job.id);
  refreshPresence(db, job.agent_id);
  return job;
}

/** Whether the budget gate is what is holding queued work (for budget.hit + banner). */
export function budgetBlocked(db: DB): 'budget' | 'job_cap' | null {
  const b = budgetNumbers(db);
  if (b.jobsDay >= b.limitJobsDay || b.jobs5h >= b.limitJobs5h) return 'job_cap';
  const minCap = (db.prepare(`SELECT min(budget_cap_usd) AS m FROM jobs WHERE status='queued'`).get() as any).m as number | null;
  if (minCap != null && b.spent + b.reserved + minCap > b.limitUsdDay) return 'budget';
  return null;
}
