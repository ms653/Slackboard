import type { DB } from '../db';
import { now, localMidnight, uuid, sha256 } from '../util';
import { emit } from './events';
import { cancelQueued, refreshPresence, type JobRow } from './jobs';
import { capThreadForJobs } from './threads';

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
          WHERE j.status='queued' AND j.run_after <= @now AND a.enabled=1
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
      maxc: ss.max_concurrency }) as JobRow | undefined;
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
