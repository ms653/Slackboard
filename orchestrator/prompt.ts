import fs from 'node:fs';
import type { DB } from '@/lib/db';
import type { JobRow } from '@/lib/domain/jobs';
import { getTask, currentArtifact } from '@/lib/domain/rounds';
import { agentRole } from '@/lib/domain/jobs';
import { enabledWorkerIds } from '@/lib/domain/agents';

/** XML-escape so embedded content cannot close or forge tags (TECH §6.3). */
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
const MAX = 24 * 1024;

export function renderPrompt(db: DB, j: JobRow, reason: string | null): string {
  const t = j.task_id ? getTask(db, j.task_id) : undefined;
  const parts: string[] = [];
  parts.push(`<job id="${j.id}" kind="${j.kind}" agent="${j.agent_id}" attempt="${j.attempts}"${t ? ` task="T-${t.id}"` : ''} thread="${j.thread_id}"${t ? ` review_round="${t.review_round}" max_review_rounds="2"` : ''} role="${agentRole(db, j.agent_id)}"/>`);
  parts.push(team(db));
  if (t) {
    parts.push(`<task id="T-${t.id}" status="${t.status}" assignee="${t.assignee_agent_id ?? ''}" parent="${t.parent_id ?? ''}">
  <title>${esc(t.title)}</title>
  <description>${esc(t.description)}</description>
  <acceptance>${esc(t.acceptance)}</acceptance>
</task>`);
    const notes = db.prepare(`SELECT * FROM notes WHERE task_id=? ORDER BY id DESC LIMIT 10`).all(t.id).reverse() as any[];
    if (notes.length) parts.push(`<notes>\n${notes.map((n) => `  <untrusted kind="note" author="${n.author_agent_id ?? 'user'}">${esc(n.body)}</untrusted>`).join('\n')}\n</notes>`);
  }
  const msgs = db.prepare(`SELECT * FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 30`).all(j.thread_id).reverse() as any[];
  const total = (db.prepare(`SELECT count(*) n FROM messages WHERE thread_id=?`).get(j.thread_id) as any).n as number;
  const lines = msgs.map((m) => m.author_kind === 'user' ? `  <user_message id="${m.id}" at="${iso(m.created_at)}">${esc(m.body)}</user_message>`
    : m.author_kind === 'system' ? `  <system id="${m.id}">${esc(m.body)}</system>`
    : `  <untrusted kind="agent_message" author="${m.author_agent_id}" id="${m.id}">${esc(m.body)}</untrusted>`);
  parts.push(`<thread>\n${total > msgs.length ? `  [${total - msgs.length} earlier messages omitted]\n` : ''}${lines.join('\n')}\n</thread>`);
  if (j.kind === 'review' && t) {
    const a = currentArtifact(db, t);
    if (a) {
      let diff = ''; try { diff = fs.readFileSync(a.diff_path, 'utf8'); } catch {}
      const files = (JSON.parse(a.files) as any[]).map((f) => `${f.path} (+${f.added} -${f.removed})`).join(', ');
      if (diff.length > 16 * 1024) diff = diff.slice(0, 16 * 1024) + `\n[diff truncated; files: ${files}]`;
      parts.push(`<review_bundle round="${a.review_round}" base="${a.base_commit.slice(0, 8)}" head="${a.head_commit.slice(0, 8)}" files="${esc(files)}">\n  <untrusted kind="diff">${esc(diff)}</untrusted>\n</review_bundle>`);
    }
  }
  if (j.attempts > 1 && reason && !['no_handoff', 'max_turns'].includes(reason))
    parts.unshift(`<retry attempt="${j.attempts}">Your previous run was interrupted. Tool calls you already made are recorded; repeating one returns its original result. Re-check the context, then continue.</retry>`);
  if (reason === 'max_turns') parts.unshift(`<continue>You hit the turn limit. In at most 3 tool calls, finish: submit_for_review, request_help, or update_task block.</continue>`);
  if (reason === 'no_handoff') parts.unshift(`<continue>You ended without a handoff. Do exactly one of: submit_for_review, request_help, update_task block.</continue>`);
  parts.push(`<instructions>${instructions(db, j, t)}</instructions>`);
  let out = parts.join('\n');
  if (out.length > MAX) out = out.slice(0, MAX - 200) + '\n[context truncated]\n' + parts[parts.length - 1];
  return out;
}

/** <team>: one line per active agent (PHASE2 §T4.3). The skill note is user-approved text, so escaped but not <untrusted>. */
export function team(db: DB): string {
  const rows = db.prepare(`SELECT id, role, enabled, presence, skill_note FROM agents WHERE retired_at IS NULL ORDER BY (role <> 'director'), created_at, rowid`).all() as any[];
  const lines = rows.map((a) => `  <agent id="${a.id}" role="${a.role}" enabled="${a.enabled}" presence="${a.presence}"${a.skill_note ? ` skill="${esc(a.skill_note)}"` : ''}/>`);
  if (!enabledWorkerIds(db).length) lines.push('  no enabled worker');
  return `<team>\n${lines.join('\n')}\n</team>`;
}

function instructions(db: DB, j: JobRow, t: ReturnType<typeof getTask>): string {
  if (j.kind === 'review' && t) return `Review T-${t.id} round ${t.review_round} of 2 against the acceptance criteria. End with update_task approve or request_changes.`;
  if (j.kind === 'work' && t) return `Do T-${t.id} in your working directory. End with exactly one handoff: update_task submit_for_review, request_help, or update_task block.`;
  if (j.kind === 'help' && t && agentRole(db, j.agent_id) === 'worker')               // peer help (PHASE2 §T4.3)
    return `${t.assignee_agent_id} asked you (${j.agent_id}) for help on T-${t.id}. You may Read files here; you cannot edit. Answer once with post_message {wake:true, mentions:["${t.assignee_agent_id}"]}. If you cannot answer, call request_help (it goes to the director). Post nothing else.`;
  if (j.kind === 'help' && t) return `The worker asked for help on T-${t.id}. Answer with post_message (wake: true, mentions ["${t.assignee_agent_id}"]), or escalate with request_help to the user.`;
  return `Respond to the latest message in thread ${j.thread_id}. Create a task if work is needed; otherwise answer with post_message. Post nothing if nothing needs saying.`;
}
