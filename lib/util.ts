import crypto from 'node:crypto';

export const now = (): number => Date.now();

/** Canonical JSON: object keys sorted recursively, so equal values hash equally (TECH §5.10). */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJSON(o[k])).join(',') + '}';
}
export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (): string => crypto.randomBytes(32).toString('base64url');
export const uuid = (): string => crypto.randomUUID();

/** Local midnight (budget day window, TECH §5.5). */
export function localMidnight(t = now()): number {
  const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime();
}
/** backoff(n) = min(30s * 2^(n-1), 10min) * uniform(0.8,1.2); SB_BACKOFF_SCALE shrinks it for tests. */
export function backoffMs(attempt: number, rand = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 600_000) * (0.8 + 0.4 * rand());
  const scale = Number(process.env.SB_BACKOFF_SCALE || '1');
  return Math.round(base * scale);
}
export class DomainError extends Error {
  constructor(public code: string, public hint = '', public status = 409) { super(code); }
}
