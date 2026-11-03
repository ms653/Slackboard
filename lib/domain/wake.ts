import type { DB } from '../db';
import { now } from '../util';
import { enqueueJob, PRIORITY } from './jobs';
import { insertMessage } from './messages';
import { getThread } from './threads';
import { resumeTarget, type TaskRow } from './rounds';
import { unblockTask } from './tasks';
import { budgetBlocked } from './claim';
import type { WorkspaceFacts } from './git';

export const ORCH_STALE_MS = 15_000;
export type BlockedBy = 'kill' | 'orchestrator_down' | 'paused_user' | 'usage_limit' | 'budget' | 'job_cap' | null;

/** Single reason agents can't run right now, in precedence order (UX §6/§8). */
export function globalBlock(db: DB): { blocked_by: BlockedBy; paused_until: number | null } {
  const s = db.prepare(`SELECT * FROM system_state WHERE id=1`).get() as any;
  if (s.kill_switch) return { blocked_by: 'kill', paused_until: null };
  if (!s.orchestrator_heartbeat_at || now() - s.orchestrator_heartbeat_at > ORCH_STALE_MS) return { blocked_by: 'orchestrator_down', paused_until: null };
  if (s.pause_reason === 'user') return { blocked_by: 'paused_user', paused_until: null };
  if ((s.paused_until ?? 0) > now()) return { blocked_by: 'usage_limit', paused_until: s.paused_until };
  return { blocked_by: budgetBlocked(db), paused_until: null };
}

export interface WakePreview { agent: string; kind: string; unblocksTask?: number; blocked_by: BlockedBy; jobs: { used: number; max: number } }

/** wakePreview(thread, mentions, author) — the one place the user-message wake rules live (TECH §5.1). */
export function wakePreview(db: DB, threadId: number, ws?: WorkspaceFacts): WakePreview | null {
  const th = getThread(db, threadId);
  if (!th || th.status !== 'open') return null;
  const task = db.prepare(`SELECT * FROM tasks WHERE thread_id=?`).get(threadId) as TaskRow | undefined;
  const g = globalBlock(db);
  const jobs = { used: th.agent_job_count, max: th.max_agent_jobs };
  if (task && task.status === 'blocked') {
    const rt = resumeTarget(db, task, 'reply', ws ?? { clean: true, head: null });
    return { agent: rt.agent, kind: rt.kind, unblocksTask: task.id, blocked_by: g.blocked_by, jobs };
  }
  return { agent: 'director', kind: 'respond', blocked_by: g.blocked_by, jobs };
}

/** POST /api/messages: insert + wake (T16 for a blocked task thread, else director respond). */
export function postUserMessage(db: DB, threadId: number, body: string, ws?: WorkspaceFacts) {
  const th = getThread(db, threadId);
  if (!th) throw new Error('not_found');
  const mentions = Array.from(new Set((body.match(/@(director|worker)\b/g) ?? []).map((m) => m.slice(1))));
  const preview = wakePreview(db, threadId, ws);
  const msgId = insertMessage(db, { thread: threadId, authorKind: 'user', body, mentions });
  if (!preview) return { message_id: msgId, woke: null };
  const task = db.prepare(`SELECT * FROM tasks WHERE thread_id=?`).get(threadId) as TaskRow | undefined;
  if (task && task.status === 'blocked') {
    const rt = unblockTask(db, task, 'user', 'reply', ws ?? { clean: true, head: null });
    return { message_id: msgId, woke: { agent: rt.agent, kind: rt.kind } };
  }
  enqueueJob(db, { agent: 'director', kind: 'respond', thread: threadId, trigger: msgId, priority: PRIORITY.respond, actor: 'user' });
  return { message_id: msgId, woke: { agent: 'director', kind: 'respond' } };
}
