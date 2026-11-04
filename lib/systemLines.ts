/** Client-safe helpers for system thread lines that carry an action (PHASE2 §B1/§B2). */
export const EDIT_BUDGET = '[Edit budget]';

/** Agent id of a budget-hit line ("<agent> reached its daily allowance ..."), else null. */
export function budgetHitAgent(body: string): string | null {
  const m = /^([a-z][a-z0-9_]*) reached its daily allowance/.exec(body);
  return m && body.includes(EDIT_BUDGET) ? m[1] : null;
}

/** System lines shown even when other system events are collapsed. */
export const systemLineHasAction = (body: string): boolean =>
  budgetHitAgent(body) !== null || / joined \(approved by you\)/.test(body) || body.includes('Director not woken');

/** "Re-propose to" default: the assignee if it is an enabled worker, else the first enabled worker. */
export function reproposeDefault(assignee: string | null | undefined, enabledWorkers: { id: string }[]): string | undefined {
  return enabledWorkers.some((w) => w.id === assignee) ? (assignee as string) : enabledWorkers[0]?.id;
}
