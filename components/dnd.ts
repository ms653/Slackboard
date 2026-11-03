/** Board drag-and-drop rules (UX §5): only the user transitions of TECH §3.1 (Unblock, Reopen, Cancel) are legal drops. */
export type DropResult = { kind: 'noop' } | { kind: 'unblock' } | { kind: 'reopen' } | { kind: 'cancel' } | { kind: 'reject'; message: string };

const LABEL: Record<string, string> = { proposed: 'Proposed', todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };

export function dropMove(from: string, to: string): DropResult {
  if (from === to) return { kind: 'noop' };
  if (to === 'cancelled') return from === 'done' || from === 'cancelled' ? { kind: 'reject', message: `${LABEL[from]} tasks can't be cancelled` } : { kind: 'cancel' };
  if (from === 'blocked' && (to === 'todo' || to === 'in_review')) return { kind: 'unblock' };
  if (from === 'done' && to === 'todo') return { kind: 'reopen' };
  if (from === 'in_review' && to === 'done') return { kind: 'reject', message: 'Only the reviewer can move In review → Done' };
  if (from === 'cancelled') return { kind: 'reject', message: "Cancelled tasks can't be moved" };
  if (from === 'done') return { kind: 'reject', message: 'Done tasks can only be reopened to To do' };
  if (from === 'proposed') return { kind: 'reject', message: 'Approve or reject proposed tasks in Needs you' };
  if (to === 'proposed') return { kind: 'reject', message: 'Only agents can propose tasks' };
  if (to === 'done') return { kind: 'reject', message: `Only the reviewer can move ${LABEL[from]} → Done` };
  if (from === 'blocked') return { kind: 'reject', message: `Blocked tasks can only move to To do or In review (Unblock)` };
  return { kind: 'reject', message: `Only agents can move ${LABEL[from]} → ${LABEL[to]}` };
}

/** Custom MIME type so dragging arbitrary selected text (e.g. "12") never acts as a task drag. */
export const TASK_MIME = 'application/x-slackboard-task';
export function parseDragId(dt: { getData(t: string): string }): number | null {
  const n = Number(dt.getData(TASK_MIME));
  return Number.isInteger(n) && n > 0 ? n : null;
}
