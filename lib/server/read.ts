import fs from 'node:fs';
import { db as getDb } from '../db';
import { now, localMidnight, DomainError } from '../util';
import { budgetNumbers, queueReason, agentNumbers } from '../domain/claim';
import { helpEscalatedToUser, peerHelpJob } from '../domain/tasks';
import { globalBlock } from '../domain/wake';
import { helpFailed, getTask, type TaskRow } from '../domain/rounds';
import { commentGate, commentsWithDelivery } from '../domain/comments';
import { diffBetween } from '../domain/git';
import { isOurs, ORCH_STALE_MS } from '../proc';
import { preview } from './actions';

const db = () => getDb();

function orchestratorStatus(s: any): 'up' | 'stale' | 'down' {
  if (!s.orchestrator_heartbeat_at) return 'down';
  const age = now() - s.orchestrator_heartbeat_at;
  if (age > ORCH_STALE_MS || !isOurs(s.orchestrator_pid, s.orchestrator_proc_start)) return 'down';
  return age > 5000 ? 'stale' : 'up';
}

export type Badge = { icon: string; text: string; retry?: { run_after: number; attempts: number; max_attempts: number } };
const FAIL_TEXT: Record<string, string> = { timeout_idle: 'no output for 3 min', timeout_wall: 'time limit', orphaned: 'orchestrator restarted', error_during_execution: 'error' };

/** Card lines derived once, server-side (UX §5). */
function decorate(t: TaskRow, ny: Set<string>, extra: { threadStatus: string; capRaises: number; replies: number; cost: number; files: number; drift: boolean; hfailed: boolean; escalated: boolean; helperReason?: string | null; failedHelper?: string | null; queued?: string | null; peerHelp?: { job_id: number; agent: string; status: string } | null; redo: boolean; workerNote?: string | null; badge: Badge | null }) {
  let reason: string | null = null;
  if (t.status === 'blocked') {
    reason = ({ help: extra.escalated ? 'Blocked: waiting on you (help)' : `Blocked: waiting on ${(t as any).help_agent_id ?? 'director'} (help)${extra.helperReason ? ` · ${(t as any).help_agent_id}: ${extra.helperReason}` : ''}`, review_cap: 'Blocked: you need to decide (review limit)',
      job_failed: extra.hfailed ? `Blocked: ${extra.failedHelper ?? 'director'} could not answer (help failed)` : extra.drift ? 'Blocked: workspace changed after review' : 'Blocked: failed 3 times',
      killed: 'Blocked: stopped by kill switch', agent_blocked: extra.workerNote ? `Blocked by worker: ${extra.workerNote}` : 'Blocked by worker', user: 'Blocked: you cancelled the run' } as Record<string, string>)[t.blocked_reason!] ?? 'Blocked';
  }
  let waiting: { text: string; action: 'reopen' | 'raise_cap' | 'cancel' } | null = null;
  if (['todo', 'in_progress', 'in_review'].includes(t.status) && extra.threadStatus !== 'open') {
    waiting = extra.threadStatus === 'closed' ? { text: 'Waiting: thread closed', action: 'reopen' }
      : extra.capRaises === 0 ? { text: 'Waiting: thread capped', action: 'raise_cap' } : { text: 'Waiting: thread capped, cap already raised', action: 'cancel' };
  }
  const flag = ny.has(`approval:task:${t.id}`) ? 'Needs approval' : ny.has(`help:${t.id}`) ? 'Needs reply' : ny.has(`ready:${t.id}`) ? 'Ready to accept'
    : ny.has(`review_cap:${t.id}`) ? 'Review limit' : ny.has(`killed:${t.id}`) ? 'Stopped by kill' : ny.has(`failure:${t.id}`) ? 'Failed'
    : ny.has(`thread_capped:${t.thread_id}`) ? 'Thread capped' : null;
  const round = t.review_round > 0 || extra.redo ? `round ${extra.redo ? t.review_round + 1 : t.review_round} of 2${extra.redo ? ', redo' : ''}` : null;
  const done = t.status === 'done' ? (t.parent_id ? 'Done' : t.accepted_at ? 'Accepted' : 'Ready, not accepted') : null;
  return { ...t, reason, waiting, flag, round, done, queued: extra.queued ?? null, help_escalated_to_user: extra.escalated, peer_help: extra.peerHelp ?? null, replies: extra.replies, cost: extra.cost, files: extra.files, badge: extra.badge };
}

export function bootstrap() {
  const d = db();
  const s = d.prepare(`SELECT * FROM system_state WHERE id=1`).get() as any;
  const b = budgetNumbers(d);
  const g = globalBlock(d);
  const lastKill = s.kill_switch && s.kill_engaged_at
    ? d.prepare(`SELECT payload FROM events WHERE type='kill.engaged' AND json_extract(payload,'$.followup')=1 AND ts>=? ORDER BY id DESC LIMIT 1`).get(s.kill_engaged_at) as { payload: string } | undefined
    : undefined;
  const ny = d.prepare(`SELECT * FROM needs_you ORDER BY created_at`).all() as any[];
  const keys = new Set<string>();
  const items = ny.map((n) => {
    let detail: any = {};
    if (n.item_type === 'approval') {
      const a = d.prepare(`SELECT * FROM approvals WHERE id=?`).get(n.ref_id) as any;
      detail = { approval: { ...a, payload: JSON.parse(a.payload) } };
      if (a.kind === 'create_top_level_task') keys.add(`approval:task:${a.task_id}`);
      else if (a.kind === 'spend' && detail.approval.payload?.action === 'spawn_worker') {            // PHASE2 §B2 "From:" line
        const th = d.prepare(`SELECT id, title FROM threads WHERE id=?`).get(a.thread_id) as any;
        const um = d.prepare(`SELECT body FROM messages WHERE thread_id=? AND author_kind='user' AND created_at <= ? ORDER BY id DESC LIMIT 1`).get(a.thread_id, a.created_at) as { body: string } | undefined;
        detail.origin = { thread_id: a.thread_id, thread_title: th?.title ?? '', user_message: um?.body.split('\n')[0].slice(0, 120) ?? null };
      }
    } else if (n.item_type === 'help') {
      detail = { message: d.prepare(`SELECT * FROM messages WHERE id=?`).get(n.ref_id) };
      if (n.task_id) keys.add(`help:${n.task_id}`);
    } else if (n.item_type === 'thread_capped') {
      detail = { thread: d.prepare(`SELECT * FROM threads WHERE id=?`).get(n.ref_id) };
      keys.add(`thread_capped:${n.ref_id}`);
    } else {
      keys.add(`${n.item_type}:${n.ref_id}`);
      const t = d.prepare(`SELECT * FROM tasks WHERE id=?`).get(n.ref_id) as any;
      const lastJob = d.prepare(`SELECT id, kind, agent_id, failure_kind, error, attempts FROM jobs WHERE task_id=? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get(n.ref_id);
      const art = d.prepare(`SELECT id, files, lines_added, lines_removed, review_round, verdict, verdict_note FROM artifacts WHERE task_id=? ORDER BY id DESC LIMIT 1`).get(n.ref_id);
      detail = { task: t, lastJob, artifact: art };
    }
    return { ...n, key: `${n.item_type}:${n.ref_id}`, ...detail };
  });
  const tasks = (d.prepare(`SELECT t.*, th.status AS thread_status, th.cap_raises FROM tasks t JOIN threads th ON th.id=t.thread_id ORDER BY position`).all() as any[]).map((t) => {
    const replies = (d.prepare(`SELECT count(*) n FROM messages WHERE thread_id=?`).get(t.thread_id) as any).n;
    const cost = (d.prepare(`SELECT ifnull(sum(cost_usd),0) c FROM jobs WHERE task_id=?`).get(t.id) as any).c;
    const art = d.prepare(`SELECT files FROM artifacts WHERE task_id=? AND (verdict IS NULL OR verdict<>'superseded') ORDER BY id DESC LIMIT 1`).get(t.id) as any;
    const lastFail = d.prepare(`SELECT failure_kind FROM jobs WHERE task_id=? AND status='failed' ORDER BY id DESC LIMIT 1`).get(t.id) as any;
    const escalated = helpEscalatedToUser(d, t);
    // "Queued: <reason>" for any queued job of this task whose agent's reason is not plain run slots (PHASE2 §B1)
    let queued: string | null = null, helperReason: string | null = null;
    for (const qj of d.prepare(`SELECT agent_id, kind FROM jobs WHERE task_id=? AND status='queued' ORDER BY id`).all(t.id) as { agent_id: string; kind: string }[]) {
      const qr = queueReason(d, qj.agent_id);
      if (!qr || qr.startsWith('run slots')) continue;
      if (qj.kind === 'help' && t.status === 'blocked' && t.blocked_reason === 'help' && qj.agent_id !== 'director') helperReason = qr;
      else if (!queued) queued = qr;
    }
    const failedHelper = helpFailed(d, t) ? (d.prepare(`SELECT agent_id FROM jobs WHERE task_id=? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get(t.id) as any)?.agent_id : null;
    const ph = peerHelpJob(d, t);
    const redo = !!d.prepare(`SELECT 1 FROM artifacts WHERE task_id=? AND review_cycle=? AND review_round=? AND verdict='superseded'`).get(t.id, t.review_cycle, t.review_round + 1)
      && ['todo', 'in_progress'].includes(t.status);
    const lastJob = d.prepare(`SELECT status, attempts, max_attempts, failure_kind, run_after, exit_code, continuations FROM jobs WHERE task_id=? ORDER BY id DESC LIMIT 1`).get(t.id) as any;
    let workerNote: string | null = null;
    if (t.status === 'blocked' && t.blocked_reason === 'agent_blocked') {
      const n = d.prepare(`SELECT body FROM notes WHERE task_id=? AND author_agent_id=? ORDER BY id DESC LIMIT 1`).get(t.id, t.assignee_agent_id) as { body: string } | undefined;
      const line = n?.body.split('\n').map((x) => x.trim()).find((x) => x) ?? '';
      workerNote = line ? (line.length > 80 ? line.slice(0, 79) + '…' : line) : null;
    }
    let badge: Badge | null = null;
    if (lastJob?.status === 'queued' && lastJob.attempts > 0 && lastJob.failure_kind) {
      const fk = lastJob.failure_kind as string;
      if (fk === 'orphaned' && d.prepare(`SELECT 1 FROM events WHERE type='job.requeued' AND entity_type='job' AND entity_id=(SELECT id FROM jobs WHERE task_id=? ORDER BY id DESC LIMIT 1)
          AND json_extract(payload,'$.reason')='orphaned' AND ts>=?`).get(t.id, now() - 10_000)) {
        badge = { icon: '⟲', text: 'Claim expired, requeued' };                          // UX §5: 10 s after crash recovery
      } else if (lastJob.continuations === 1 && (fk === 'no_handoff' || fk === 'max_turns')) {
        badge = { icon: '⟲', text: `Continuing (${fk === 'max_turns' ? 'turn limit' : 'no handoff'})` };
      } else {
        const why = fk === 'exit_nonzero' ? `exit ${lastJob.exit_code}` : FAIL_TEXT[fk] ?? fk;
        badge = { icon: '✕', text: `Run failed (${why})`, retry: { run_after: lastJob.run_after, attempts: lastJob.attempts, max_attempts: lastJob.max_attempts } };
      }
    } else if (s.kill_switch && orchestratorStatus(s) === 'down' && d.prepare(`SELECT 1 FROM jobs WHERE task_id=? AND status='running'`).get(t.id)) {
      badge = { icon: '⏸', text: 'Stopped by kill, waiting for orchestrator' };
    } else if (t.status === 'todo' && d.prepare(`SELECT 1 FROM events WHERE type='task.status_changed' AND entity_type='task' AND entity_id=? AND actor='system' AND ts>=?
        AND json_extract(payload,'$.from')='in_progress' AND json_extract(payload,'$.to')='todo'`).get(String(t.id), now() - 10_000)
      && !d.prepare(`SELECT 1 FROM jobs WHERE task_id=? AND failure_kind IS NOT NULL AND (finished_at>=? OR status='queued')`).get(t.id, now() - 10_000)) {
      badge = { icon: '⟲', text: 'Claim expired, requeued' };
    }
    return decorate(t, keys, { threadStatus: t.thread_status, capRaises: t.cap_raises, replies, cost, files: art ? JSON.parse(art.files).length : 0,
      drift: lastFail?.failure_kind === 'workspace_drift', hfailed: helpFailed(d, t), escalated, redo, workerNote, badge, helperReason, failedHelper, queued, peerHelp: ph ? { job_id: ph.id, agent: ph.agent_id, status: ph.status } : null });
  });
  const threads = d.prepare(`SELECT th.*, (SELECT id FROM tasks WHERE thread_id=th.id) AS task_id,
      (SELECT body FROM messages WHERE thread_id=th.id ORDER BY id LIMIT 1) AS first_body,
      (SELECT author_kind FROM messages WHERE thread_id=th.id ORDER BY id LIMIT 1) AS first_author,
      (SELECT author_agent_id FROM messages WHERE thread_id=th.id ORDER BY id LIMIT 1) AS first_agent,
      (SELECT count(*) FROM messages WHERE thread_id=th.id) AS replies,
      (SELECT max(created_at) FROM messages WHERE thread_id=th.id) AS last_at
    FROM threads th ORDER BY th.created_at DESC LIMIT 200`).all();
  const runningKilledPending = s.kill_switch && orchestratorStatus(s) === 'down'
    ? (d.prepare(`SELECT count(*) n FROM jobs WHERE status='running'`).get() as any).n : 0;
  const running_jobs = (d.prepare(`SELECT count(*) n FROM jobs WHERE status='running'`).get() as any).n as number;
  // Next run allowed when a job cap blocks (UX §9): 5 h window = oldest job.started in the window + 5 h; day cap = next local midnight.
  let next_run_at: number | null = null;
  if (b.jobs5h >= b.limitJobs5h) {
    const o = d.prepare(`SELECT min(ts) m FROM events WHERE type='job.started' AND ts >= ?`).get(now() - 18_000_000) as { m: number | null };
    if (o.m) next_run_at = o.m + 18_000_000;
  }
  if (b.jobsDay >= b.limitJobsDay) next_run_at = Math.max(next_run_at ?? 0, localMidnight() + 86_400_000);
  return {
    now: now(),
    lastEventId: (d.prepare(`SELECT ifnull(max(id),0) m FROM events`).get() as any).m,
    system: { kill_switch: !!s.kill_switch, kill_engaged_at: s.kill_engaged_at, paused_until: s.paused_until, pause_reason: s.pause_reason,
      orchestrator: orchestratorStatus(s), heartbeat_at: s.orchestrator_heartbeat_at, doctor_ok_at: s.doctor_ok_at,
      doctor_report: s.doctor_report ? JSON.parse(s.doctor_report) : null, claude_version: s.claude_version, max_concurrency: s.max_concurrency,
      blocked_by: g.blocked_by, kill_followup: lastKill ? JSON.parse(lastKill.payload) : null, kill_pending_runs: runningKilledPending, running_jobs,
      api_key_detected: !!process.env.ANTHROPIC_API_KEY },
    usage: { spent_day: b.spent, jobs_day: b.jobsDay, jobs_5h: b.jobs5h, limit_usd_day: b.limitUsdDay, limit_jobs_day: b.limitJobsDay,
      limit_jobs_5h: b.limitJobs5h, reset_at: localMidnight() + 86_400_000, next_run_at },
    agents: d.prepare(`SELECT a.*, (SELECT count(*) FROM jobs WHERE agent_id=a.id AND status='queued') AS queued,
      (SELECT started_at FROM jobs WHERE agent_id=a.id AND status='running') AS running_since,
      (SELECT task_id FROM jobs WHERE agent_id=a.id AND status='running') AS running_task,
      (SELECT attempts || '/' || max_attempts FROM jobs WHERE agent_id=a.id AND status='queued' AND attempts>0 ORDER BY id LIMIT 1) AS retrying,
      (SELECT thread_id FROM jobs WHERE agent_id=a.id AND status='running') AS running_thread,
      (SELECT task_id FROM jobs WHERE agent_id=a.id AND status='queued' ORDER BY created_at, id LIMIT 1) AS queued_task,
      (SELECT thread_id FROM jobs WHERE agent_id=a.id AND status='queued' ORDER BY created_at, id LIMIT 1) AS queued_thread,
      (SELECT t.thread_id FROM tasks t WHERE t.assignee_agent_id=a.id AND t.status='blocked' AND t.blocked_reason='help' ORDER BY t.id LIMIT 1) AS waiting_thread,
      (SELECT t.assignee_agent_id FROM jobs j JOIN tasks t ON t.id=j.task_id WHERE j.agent_id=a.id AND j.status='running' AND j.kind='help' AND a.role='worker') AS helping_asker
      FROM agents a ORDER BY (a.role <> 'director'), a.created_at, a.rowid`).all().map((a: any) => ({ ...a, queue_reason: queueReason(d, a.id),
        budget: agentNumbers(d, a.id) })),
    needsYou: items,
    recentlyExpired: d.prepare(`SELECT a.*, t.title AS task_title FROM approvals a LEFT JOIN tasks t ON t.id=a.task_id WHERE a.status='expired' AND a.decided_at >= ? ORDER BY a.decided_at DESC`).all(now() - 86_400_000),
    tasks, threads,
  };
}

export function threadView(id: number) {
  const d = db();
  const th = d.prepare(`SELECT * FROM threads WHERE id=?`).get(id) as any;
  if (!th) throw new DomainError('not_found', 'no such thread', 404);
  const messages = d.prepare(`SELECT m.*, (SELECT j.kind FROM jobs j WHERE j.id=m.job_id) AS job_kind FROM messages m WHERE m.thread_id=? ORDER BY m.id`).all(id);
  const task = d.prepare(`SELECT * FROM tasks WHERE thread_id=?`).get(id);
  const running = d.prepare(`SELECT agent_id, kind FROM jobs WHERE thread_id=? AND status='running'`).all(id);
  const artifacts = task ? d.prepare(`SELECT id, review_cycle, review_round, verdict, created_at FROM artifacts WHERE task_id=? ORDER BY id`).all((task as any).id) : [];
  // PHASE2 §B2: the director respond job queued by a spawn approval in this thread, until it starts
  const spawn_queued = !!d.prepare(`SELECT 1 FROM jobs j WHERE j.thread_id=? AND j.agent_id='director' AND j.kind='respond' AND j.status='queued' AND j.trigger_message_id IS NULL
    AND EXISTS (SELECT 1 FROM approvals a WHERE a.thread_id=j.thread_id AND a.kind='spend' AND a.status='consumed' AND json_extract(a.payload,'$.action')='spawn_worker')`).get(id);
  const peer_help = task ? (d.prepare(`SELECT count(*) n FROM events WHERE type='help.requested' AND json_extract(payload,'$.task_id')=? AND json_extract(payload,'$.peer')=1`).get((task as any).id) as any).n as number : 0;
  const queued_help = task ? (d.prepare(`SELECT agent_id FROM jobs WHERE task_id=? AND kind='help' AND status='queued'`).all((task as any).id) as any[]).map((r) => r.agent_id as string) : [];
  return { thread: th, messages, task, running, artifacts, spawn_queued, peer_help, queued_help, preview: th.status === 'open' ? preview(id) : null };
}

export function taskView(id: number) {
  const d = db();
  const t = d.prepare(`SELECT t.*, th.status AS thread_status, th.cap_raises FROM tasks t JOIN threads th ON th.id=t.thread_id WHERE t.id=?`).get(id) as any;
  if (!t) throw new DomainError('not_found', 'no such task', 404);
  return { task: t,
    notes: d.prepare(`SELECT * FROM notes WHERE task_id=? AND artifact_id IS NULL ORDER BY id DESC LIMIT 10`).all(id),
    jobs: d.prepare(`SELECT id, agent_id, kind, status, attempts, max_attempts, cost_usd, budget_cap_usd, failure_kind, run_after, created_at, started_at, finished_at FROM jobs WHERE task_id=? ORDER BY id`).all(id),
    artifacts: d.prepare(`SELECT id, review_cycle, review_round, verdict, verdict_by, verdict_note, lines_added, lines_removed, files, created_at FROM artifacts WHERE task_id=? ORDER BY id`).all(id),
    approval: d.prepare(`SELECT * FROM approvals WHERE task_id=? ORDER BY id DESC LIMIT 1`).get(id),
    children: d.prepare(`SELECT id, title, status FROM tasks WHERE parent_id=?`).all(id) };
}

export function artifactView(id: number) {
  const d = db();
  const a = d.prepare(`SELECT a.*, t.title, t.status AS task_status, t.blocked_reason, t.parent_id, t.accepted_at, t.review_round AS task_round, t.review_cycle AS task_cycle
                       FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.id=?`).get(id) as any;
  if (!a) throw new DomainError('not_found', 'no such artifact', 404);
  let diff = ''; try { diff = fs.readFileSync(a.diff_path, 'utf8'); } catch { diff = ''; }
  const lines = diff.split('\n');
  const task = getTask(d, a.task_id)!;
  const gate = commentGate(d, a, task);
  const siblings = d.prepare(`SELECT id, review_cycle AS cycle, review_round AS round, head_commit AS head FROM artifacts WHERE task_id=? AND (verdict IS NULL OR verdict<>'superseded') ORDER BY id`).all(a.task_id);
  return { ...a, files: JSON.parse(a.files), diff: lines.length > 2000 ? lines.slice(0, 2000).join('\n') : diff, truncated: lines.length > 2000,
    current: a.review_cycle === a.task_cycle && a.review_round === a.task_round,
    comments: commentsWithDelivery(d, a, task), siblings, comment_gate: gate };
}

/** GET /api/artifacts/:id/compare?from=<artifactId>: git diff between two round heads of one task (outside any write txn, not cached). */
export function compareView(id: number, fromId: number) {
  const d = db();
  const to = d.prepare(`SELECT * FROM artifacts WHERE id=?`).get(id) as any;
  const from = d.prepare(`SELECT * FROM artifacts WHERE id=?`).get(fromId) as any;
  if (!to || !from) throw new DomainError('not_found', 'no such artifact', 404);
  if (to.task_id !== from.task_id) throw new DomainError('wrong_task', 'both artifacts must belong to the same task', 400);
  let diff: string;
  try { diff = diffBetween(to.task_id, from.head_commit, to.head_commit); }
  catch (e: any) { throw new DomainError('compare_unavailable', String(e?.message ?? e).split('\n')[0].slice(0, 200), 409); }
  const lines = diff.split('\n');
  const task = getTask(d, to.task_id)!;
  return { from: { id: from.id, cycle: from.review_cycle, round: from.review_round, head: from.head_commit }, to: { id: to.id, cycle: to.review_cycle, round: to.review_round, head: to.head_commit },
    diff: lines.length > 2000 ? lines.slice(0, 2000).join('\n') : diff, truncated: lines.length > 2000, from_comments: commentsWithDelivery(d, from, task) };
}
