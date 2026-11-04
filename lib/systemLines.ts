/** Client-safe helpers for system thread lines that carry an action (PHASE2 §B1/§B2). */
export const EDIT_BUDGET = '[Edit budget]';

/** Agent id of a budget-hit line ("<agent> reached its daily allowance ..."), else null. */
export function budgetHitAgent(body: string): string | null {
  const m = /^([a-z][a-z0-9_]*) reached its daily allowance/.exec(body);
  return m && body.includes(EDIT_BUDGET) ? m[1] : null;
}

/** Peer that has not started a help job ("writer2 hasn't started: <reason>"), else null (PHASE2 §B3). */
export function peerNotStartedAgent(body: string): string | null {
  const m = /^([a-z][a-z0-9_]*) hasn't started: /.exec(body);
  return m ? m[1] : null;
}

/** Why the director was not woken after a spawn approval ("... Director not woken: thread capped|closed. ..."), else null (PHASE2 §B2). */
export function notWokenReason(body: string): 'thread_capped' | 'thread_closed' | null {
  const m = /Director not woken: thread (capped|closed)\./.exec(body);
  return m ? (m[1] === 'capped' ? 'thread_capped' : 'thread_closed') : null;
}

/** System lines shown even when other system events are collapsed. */
export const systemLineHasAction = (body: string): boolean =>
  budgetHitAgent(body) !== null || / joined \(approved by you\)/.test(body) || notWokenReason(body) !== null || peerNotStartedAgent(body) !== null;

/** "Re-propose to" default: the assignee if it is an enabled worker, else the first enabled worker. */
export function reproposeDefault(assignee: string | null | undefined, enabledWorkers: { id: string }[]): string | undefined {
  return enabledWorkers.some((w) => w.id === assignee) ? (assignee as string) : enabledWorkers[0]?.id;
}
