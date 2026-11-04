import type { DB } from '../db';
import { tx } from '../db';
import { now, sha256, canonicalJSON, DomainError } from '../util';
import { emit } from './events';
import { enqueueJob, PRIORITY, kindSettings, refreshPresence, type JobRow } from './jobs';
import { insertMessage } from './messages';
import { getThread, generalChannel } from './threads';
import { getTask, lastHead } from './rounds';
import { createTask, applySubmitForReview, approveReview, requestChanges, blockTask, cancelTask, editTask, addNote, unblockTask } from './tasks';
import { workspaceFacts, workspaceChanged, captureRound, type Capture } from './git';
import { activeWorkerIds, enabledWorkerIds, nameTaken, MAX_WORKERS, WORK_CAP_USD } from './agents';

/** Identity always comes from the token (TECH §8), never tool input. */
export interface Caller { jobId: number; agent: string; role: string; kind: JobRow['kind']; threadId: number; taskId: number | null }
export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string; hint: string };

export const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  post_message: { description: 'Post a message in a Slackboard thread (defaults to the job thread).', inputSchema: { type: 'object', additionalProperties: false, required: ['body'], properties: {
    body: { type: 'string', minLength: 1, maxLength: 4000 }, thread_id: { type: 'integer' },
    mentions: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 4 },
    wake: { type: 'boolean', default: false, description: 'Director only: wake the task assignee (mention it).' }, kind: { enum: ['chat', 'status'], default: 'chat' } } } },
  create_task: { description: 'Create a task. Without parent_id it is a proposal that needs the user\'s approval.', inputSchema: { type: 'object', additionalProperties: false, required: ['title', 'description', 'acceptance'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 8000 },
    acceptance: { type: 'string', minLength: 1, maxLength: 4000 }, assignee: { type: 'string' },
    parent_id: { type: ['integer', 'null'], default: null }, why: { type: 'string', maxLength: 500 } } } },
  update_task: { description: 'Task actions: submit_for_review, approve, request_changes, block, cancel, edit.', inputSchema: { type: 'object', additionalProperties: false, required: ['task_id', 'action'], properties: {
    task_id: { type: 'integer' }, action: { enum: ['submit_for_review', 'approve', 'request_changes', 'block', 'cancel', 'edit'] },
    note: { type: 'string', maxLength: 4000 }, title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 8000 }, acceptance: { type: 'string', maxLength: 4000 } } } },
  add_note: { description: 'Record a plan or decision on a task.', inputSchema: { type: 'object', additionalProperties: false, required: ['task_id', 'body'], properties: {
    task_id: { type: 'integer' }, body: { type: 'string', minLength: 1, maxLength: 4000 } } } },
  request_help: { description: 'Ask for help: worker -> director, director -> user.', inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: {
    question: { type: 'string', minLength: 1, maxLength: 2000 }, task_id: { type: 'integer' },
    options: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 4 } } } },
  spawn_worker: { description: 'Ask the user to add a named worker (needs approval; uses allowance). Only when independent tasks are waiting and every worker is busy or unsuited.', inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'skill_note', 'why'], properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,23}$' }, skill_note: { type: 'string', minLength: 1, maxLength: 500, description: 'What this worker is for; shown to the user and in every prompt.' },
    why: { type: 'string', minLength: 1, maxLength: 500 },
    daily_usd: { type: 'number', minimum: 1.0, maximum: 3.0, default: 2.0, description: '>= worker work cap 1.00' },
    daily_jobs: { type: 'integer', minimum: 1, maximum: 20, default: 10 } } } },
  request_approval: { description: 'Ask the user to approve an action Slackboard cannot perform (send, spend, post_external, budget_increase).', inputSchema: { type: 'object', additionalProperties: false, required: ['kind', 'summary', 'payload'], properties: {
    kind: { enum: ['send', 'spend', 'post_external', 'budget_increase'] }, summary: { type: 'string', minLength: 1, maxLength: 500 },
    payload: { type: 'object' }, task_id: { type: 'integer' } } } },
};

const rej = (error: string, hint: string): ToolResult => ({ ok: false, error, hint });

/** Minimal JSON-schema validation for our flat schemas. */
export function validate(tool: string, input: any): string | null {
  const s = TOOL_SCHEMAS[tool]?.inputSchema as any;
  if (!s) return 'unknown tool';
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const r of s.required ?? []) if (input[r] === undefined) return `missing ${r}`;
  for (const [k, v] of Object.entries(input)) {
    const p = s.properties[k];
    if (!p) return `unknown field ${k}`;
    const types = Array.isArray(p.type) ? p.type : p.type ? [p.type] : null;
    const ok = (t: string) => t === 'integer' ? Number.isInteger(v) : t === 'null' ? v === null : t === 'array' ? Array.isArray(v)
      : t === 'object' ? (typeof v === 'object' && v !== null && !Array.isArray(v)) : typeof v === t;
    if (types && !types.some(ok)) return `${k} has the wrong type`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(', ')}`;
    if (typeof v === 'string' && p.pattern && !new RegExp(p.pattern).test(v)) return `${k} has the wrong format`;
    if (typeof v === 'number' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) return `${k} out of range`;
    if (typeof v === 'string' && ((p.minLength && v.length < p.minLength) || (p.maxLength && v.length > p.maxLength))) return `${k} length out of range`;
    if (Array.isArray(v)) { if (p.maxItems && v.length > p.maxItems) return `${k} has too many items`;
      if (p.items?.enum && v.some((x) => !p.items.enum.includes(x))) return `${k} items must be one of ${p.items.enum.join(', ')}`; }
  }
  return null;
}

export function allowedTools(c: Pick<Caller, 'role' | 'kind'>): string[] {
  return kindSettings(c.role, c.kind).tools;
}

/** Schemas published to the model: generated enums (create_task.assignee, post_message mentions) built per job from the live agent set (PHASE2 §T6). */
export function publishedTools(db: DB, c: Pick<Caller, 'role' | 'kind'>): { name: string; description: string; inputSchema: any }[] {
  const enabled = enabledWorkerIds(db), active = activeWorkerIds(db);
  return allowedTools(c).map((name) => {
    const s = JSON.parse(JSON.stringify(TOOL_SCHEMAS[name]));
    const props = s.inputSchema.properties;
    if (name === 'create_task') {
      if (enabled.length) props.assignee = { enum: enabled, description: 'Defaults to the enabled worker with the fewest open tasks.' };
      else delete props.assignee;                                                  // never an empty enum
    }
    if (name === 'post_message') props.mentions.items = { enum: ['user', 'director', ...active] };
    return { name, ...s };
  });
}

/** Idempotency wrapper + dispatch (TECH §5.10). Git for submit_for_review / approve happens before the txn. */
export function callTool(db: DB, c: Caller, tool: string, input: any): ToolResult {
  if (!allowedTools(c).includes(tool)) return record(db, c, tool, input, rej('not_allowed_for_role', `${c.agent} ${c.kind} jobs cannot call ${tool}`));
  if (tool === 'spawn_worker' && input && typeof input.daily_usd === 'number' && input.daily_usd < WORK_CAP_USD)
    return record(db, c, tool, input, rej('allowance_below_job_cap', 'one work run reserves $1.00'));
  const verr = validate(tool, input);
  if (verr) return record(db, c, tool, input, rej('validation_error', verr));
  const hash = sha256(canonicalJSON(input));
  const prior = db.prepare(`SELECT result FROM tool_calls WHERE job_id=? AND tool=? AND input_hash=? AND outcome='ok'`).get(c.jobId, tool, hash) as { result: string } | undefined;
  if (prior) { emit(db, 'tool.called', c.agent, 'job', c.jobId, { tool, replay: true }, c.jobId); return JSON.parse(prior.result); }
  // Pre-txn git work (repeatable).
  let pre: { cap?: Capture; ws?: ReturnType<typeof workspaceFacts> } = {};
  try {
    if (tool === 'update_task' && input.action === 'submit_for_review') {
      const t = getTask(db, input.task_id);
      if (t && t.status === 'in_progress' && t.claimed_by === c.agent && c.kind === 'work' && c.taskId === t.id && t.review_round < 2) {
        if (!workspaceChanged(t.id, lastHead(db, t)!)) return record(db, c, tool, input, rej('no_changes', 'the workspace has no changes since the last submitted round; make the changes first'));
        pre.cap = captureRound(t.id, t.base_commit!, t.review_round + 1);
      }
    }
    if (tool === 'update_task' && input.action === 'approve') pre.ws = workspaceFacts(input.task_id);
  } catch (e: any) { return record(db, c, tool, input, rej('internal_error', String(e.message).slice(0, 300))); }
  try {
    return tx(db, () => {
      const again = db.prepare(`SELECT result FROM tool_calls WHERE job_id=? AND tool=? AND input_hash=? AND outcome='ok'`).get(c.jobId, tool, hash) as { result: string } | undefined;
      if (again) return JSON.parse(again.result);
      const res = dispatch(db, c, tool, input, pre);
      db.prepare(`INSERT INTO tool_calls(job_id, agent_id, tool, input_hash, input, outcome, result, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(c.jobId, c.agent, tool, hash, JSON.stringify(input), res.ok ? 'ok' : 'rejected', JSON.stringify(res), now());
      emit(db, res.ok ? 'tool.called' : 'tool.rejected', c.agent, 'job', c.jobId, { tool, ...(res.ok ? {} : { error: (res as any).error }) }, c.jobId);
      return res;
    });
  } catch (e: any) {
    const code = e instanceof DomainError ? e.code : (String(e.message).match(/^[a-z_]+$/)?.[0] ?? 'internal_error');
    const hint = e instanceof DomainError ? e.hint : String(e.message).slice(0, 300);
    return record(db, c, tool, input, rej(code, hint));
  }
}
function record(db: DB, c: Caller, tool: string, input: unknown, res: ToolResult): ToolResult {
  try { emit(db, 'tool.rejected', c.agent, 'job', c.jobId, { tool, error: (res as any).error }, c.jobId); } catch {}
  return res;
}

function dispatch(db: DB, c: Caller, tool: string, input: any, pre: { cap?: Capture; ws?: any }): ToolResult {
  switch (tool) {
    case 'post_message': {
      const threadId = input.thread_id ?? c.threadId;
      const th = getThread(db, threadId);
      if (!th) return rej('wrong_thread', 'no such thread');
      const isTaskThread = !!db.prepare(`SELECT 1 FROM tasks WHERE thread_id=?`).get(threadId);
      if (threadId !== c.threadId && !(c.role === 'director' && c.kind === 'respond' && !isTaskThread && th.channel_id === generalChannel(db)))
        return rej('wrong_thread', 'post only in your job thread');
      const mentions: string[] = input.mentions ?? [];
      const valid = ['user', 'director', ...activeWorkerIds(db)];
      const unknown = mentions.find((m) => !valid.includes(m));
      if (unknown) return rej('unknown_agent', `${unknown} is not a valid mention; use ${valid.join(', ')}`);
      if (mentions.includes('user')) {
        const task = db.prepare(`SELECT status FROM tasks WHERE thread_id=?`).get(threadId) as { status: string } | undefined;
        if (c.role !== 'director' || (task && task.status !== 'done')) return rej('cannot_address_user', 'use request_help');
      }
      const wakeTask = input.wake ? db.prepare(`SELECT * FROM tasks WHERE thread_id=?`).get(threadId) as any : undefined;
      if (input.wake) {
        if (c.role !== 'director') return rej('validation_error', 'wake is director-only');
        if (!mentions.some((m) => m !== 'user' && m !== 'director')) return rej('validation_error', 'wake needs mentions:[<the task assignee>]');
        if (wakeTask && !mentions.includes(wakeTask.assignee_agent_id)) return rej('wrong_agent', `wake only the task assignee (${wakeTask.assignee_agent_id})`);
      }
      const id = insertMessage(db, { thread: threadId, authorKind: 'agent', agent: c.agent, kind: input.kind ?? 'chat', body: input.body, mentions, wakes: !!input.wake, jobId: c.jobId });
      if (input.wake) {
        const task = wakeTask;
        if (task && task.status === 'blocked' && task.blocked_reason === 'help') unblockTask(db, task, c.agent, 'reply', { clean: true, head: null });
        else if (task && !['done', 'cancelled'].includes(task.status) && task.assignee_agent_id)
          enqueueJob(db, { agent: task.assignee_agent_id, kind: 'respond', thread: threadId, task: task.id, trigger: id, priority: PRIORITY.directorWake, actor: c.agent });
      }
      return { ok: true, message_id: id };
    }
    case 'create_task': {
      const n = (db.prepare(`SELECT count(*) AS n FROM tool_calls WHERE job_id=? AND tool='create_task' AND outcome='ok'`).get(c.jobId) as any).n;
      if (n >= 3) return rej('validation_error', 'at most 3 create_task calls per job');
      const enabled = enabledWorkerIds(db);
      if (!enabled.length) return rej('no_enabled_worker', 'Enable a worker in Settings');
      if (input.assignee !== undefined && !enabled.includes(input.assignee)) return rej('unknown_assignee', `assignee must be one of: ${enabled.join(', ')}`);
      const r = createTask(db, { title: input.title, description: input.description, acceptance: input.acceptance, assignee: input.assignee,
        parentId: input.parent_id ?? null, why: input.why, by: { kind: 'agent', agent: c.agent, jobId: c.jobId } });
      return { ok: true, ...r };
    }
    case 'update_task': {
      const t = getTask(db, input.task_id);
      if (!t) return rej('wrong_task', 'no such task');
      const a = input.action;
      if (a === 'submit_for_review') {
        if (c.kind !== 'work' || c.taskId !== t.id || t.claimed_by !== c.agent || t.status !== 'in_progress') return rej('illegal_transition', 'submit only the task your work job holds');
        if (t.review_round >= 2) return rej('round_limit', 'review limit reached; use request_help');
        if (!pre.cap) return rej('no_changes', 'the workspace has no changes since the last submitted round');
        const round = applySubmitForReview(db, t, c.agent, c.jobId, pre.cap, input.note);
        return { ok: true, task_id: t.id, status: 'in_review', review_round: round };
      }
      if (a === 'approve' || a === 'request_changes') {
        if (c.role !== 'director' || c.kind !== 'review' || c.taskId !== t.id) return rej('not_allowed_for_role', 'only the director review job for this task');
        if (t.status !== 'in_review') return rej('illegal_transition', `task is ${t.status}`);
        if (a === 'approve') approveReview(db, t, c.agent, pre.ws, input.note);
        else { if (!input.note) return rej('validation_error', 'note required'); requestChanges(db, t, c.agent, input.note, c.jobId); }
      } else if (a === 'block') {
        if (t.assignee_agent_id !== c.agent) return rej('not_allowed_for_role', 'only the assignee can block');
        if (!['todo', 'in_progress'].includes(t.status)) return rej('illegal_transition', `task is ${t.status}`);
        if (!input.note) return rej('validation_error', 'note required');
        blockTask(db, t, c.agent, input.note);
      } else if (a === 'cancel') {
        if (c.role !== 'director' || t.created_by_agent_id !== c.agent) return rej('not_allowed_for_role', 'director can cancel only tasks it created');
        cancelTask(db, t, c.agent);
      } else if (a === 'edit') {
        if (c.role !== 'director') return rej('not_allowed_for_role', 'director only');
        editTask(db, t, c.agent, { title: input.title, description: input.description, acceptance: input.acceptance });
      }
      const f = getTask(db, t.id)!;
      return { ok: true, task_id: f.id, status: f.status, review_round: f.review_round };
    }
    case 'add_note': {
      const t = getTask(db, input.task_id);
      if (!t) return rej('wrong_task', 'no such task');
      if (c.role !== 'director' && t.assignee_agent_id !== c.agent) return rej('wrong_task', 'only the assignee or director can add notes');
      return { ok: true, note_id: addNote(db, t.id, c.agent, input.body) };
    }
    case 'request_help': {
      const taskId = input.task_id ?? c.taskId;
      const open = taskId ? (db.prepare(`SELECT count(*) AS n FROM messages m JOIN tasks t ON t.thread_id=m.thread_id WHERE t.id=? AND m.kind='help'
                     AND NOT EXISTS (SELECT 1 FROM messages u WHERE u.thread_id=m.thread_id AND u.id>m.id AND u.author_kind<>'system' AND u.author_agent_id IS NOT m.author_agent_id)`).get(taskId) as any).n : 0;
      if (open >= 2) return rej('validation_error', 'max 2 open help requests per task');
      const opts = input.options?.length ? '\n' + input.options.map((o: string, i: number) => `${i + 1}. ${o}`).join('\n') : '';
      const to = c.role === 'director' ? 'user' : 'director';
      const id = insertMessage(db, { thread: c.threadId, authorKind: 'agent', agent: c.agent, kind: 'help', body: input.question + opts, mentions: [to], jobId: c.jobId });
      emit(db, 'help.requested', c.agent, 'message', id, { routed_to: to, task_id: taskId ?? null, options: input.options ?? [] }, c.jobId);
      const asked = taskId ? getTask(db, taskId) : undefined;
      if (asked?.assignee_agent_id) refreshPresence(db, asked.assignee_agent_id);       // the asker's label depends on who got the question
      return { ok: true, message_id: id, routed_to: to };
    }
    case 'spawn_worker': {
      if (c.role !== 'director' || c.kind !== 'respond') return rej('not_allowed_for_role', 'director respond jobs only');
      const usd = input.daily_usd ?? 2.0, jobs = input.daily_jobs ?? 10;
      const skillNote = typeof input.skill_note === 'string' ? input.skill_note.trim() : '';
      if (skillNote.length < 1 || skillNote.length > 500) return rej('validation_error', 'skill_note must be 1-500 non-blank characters');
      if (usd < WORK_CAP_USD) return rej('allowance_below_job_cap', 'one work run reserves $1.00');
      if ((db.prepare(`SELECT count(*) AS n FROM tool_calls WHERE job_id=? AND tool='spawn_worker' AND outcome='ok'`).get(c.jobId) as any).n >= 1)
        return rej('validation_error', 'at most 1 spawn_worker call per job');
      if (nameTaken(db, input.name)) return rej('name_taken', 'pick another name (reserved or already used, including retired agents)');
      if (db.prepare(`SELECT 1 FROM approvals WHERE kind='spend' AND status='pending' AND json_extract(payload,'$.action')='spawn_worker'`).get())
        return rej('spawn_pending', 'a spawn request is already waiting for the user');
      if (activeWorkerIds(db).length >= MAX_WORKERS) return rej('worker_cap', 'assign to an existing worker or ask the user to retire one');
      const t = now();
      const payload = { action: 'spawn_worker', name: input.name, skill_note: skillNote, model: 'sonnet', daily_usd: usd, daily_jobs: jobs };
      let aid: number;
      try {
        aid = Number(db.prepare(`INSERT INTO approvals(kind, requested_by_agent_id, job_id, thread_id, task_id, summary, payload, payload_hash, created_at, expires_at)
                                 VALUES ('spend',?,?,?,NULL,?,?,?,?,?)`).run(c.agent, c.jobId, c.threadId, input.why, JSON.stringify(payload), sha256(canonicalJSON(payload)), t, t + 86_400_000).lastInsertRowid);
      } catch (e: any) {
        if (/UNIQUE constraint failed/.test(String(e.message))) return rej('spawn_pending', 'a spawn request is already waiting for the user');
        throw e;
      }
      emit(db, 'approval.requested', c.agent, 'approval', aid, { kind: 'spend', action: 'spawn_worker', name: input.name }, c.jobId);
      insertMessage(db, { thread: c.threadId, authorKind: 'agent', agent: c.agent, kind: 'approval', body: `Approval requested (add worker ${input.name}): ${input.why}`, jobId: c.jobId });
      return { ok: true, approval_id: aid, status: 'pending' };
    }
    case 'request_approval': {
      if (c.role !== 'director') return rej('not_allowed_for_role', 'director only');
      if (input.payload?.action === 'spawn_worker') return rej('validation_error', 'use spawn_worker');
      const t = now();
      const r = db.prepare(`INSERT INTO approvals(kind, requested_by_agent_id, job_id, thread_id, task_id, summary, payload, payload_hash, created_at, expires_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.kind, c.agent, c.jobId, c.threadId, input.task_id ?? null, input.summary,
                            JSON.stringify(input.payload), sha256(canonicalJSON(input.payload)), t, t + 86_400_000);
      const aid = Number(r.lastInsertRowid);
      emit(db, 'approval.requested', c.agent, 'approval', aid, { kind: input.kind }, c.jobId);
      insertMessage(db, { thread: c.threadId, authorKind: 'agent', agent: c.agent, kind: 'approval', body: `Approval requested (${input.kind}): ${input.summary}`, jobId: c.jobId });
      return { ok: true, approval_id: aid, status: 'pending' };
    }
  }
  return rej('validation_error', 'unknown tool');
}
