import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Process identity (TECH §5.7), defined once; used by the orchestrator and the Next.js kill fallback. */
export const ORCH_STALE_MS = 15_000;
const LINUX = process.platform === 'linux';

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}

/** Start time of pid: Linux /proc/<pid>/stat field 22 (parsed after the last ')'); macOS ps lstart. null if dead. */
export function procStart(pid: number | null | undefined): string | null {
  if (!pid || pid <= 0) return null;
  try {
    if (LINUX) {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
      if (rest[0] === 'Z') return null;               // zombie: treat as dead
      return rest[19] ?? null;                        // field 22 overall = index 19 after (pid, comm)
    }
    const out = execFileSync('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
    return out || null;
  } catch { return null; }
}
export const isOurs = (pid: number | null, start: string | null): boolean => !!pid && start != null && procStart(pid) === start;

/** Exact argv elements (Linux: NUL-separated /proc cmdline). macOS best effort (space split). */
export function argv(pid: number): string[] | null {
  try {
    if (LINUX) return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((x, i, a) => !(i === a.length - 1 && x === ''));
    const out = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? out.split(/ +/) : null;
  } catch { return null; }
}
function allPids(): number[] {
  if (LINUX) return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  try { return execFileSync('ps', ['-axo', 'pid='], { encoding: 'utf8' }).split('\n').map((s) => Number(s.trim())).filter(Boolean); } catch { return []; }
}

let argvFallbackEnabled = true;
export function setArgvFallback(on: boolean): void { argvFallbackEnabled = on; }

/** Positional match: argv[k] in {--session-id,--resume} and argv[k+1]===uuid and claude basename at argv[0] or argv[1]. */
export function pidsByArgv(uuid: string | null, bin = process.env.SLACKBOARD_CLAUDE_BIN || 'claude'): number[] {
  if (!uuid || !argvFallbackEnabled) return [];
  const base = path.basename(bin);
  const out: number[] = [];
  for (const p of allPids()) {
    if (p === process.pid) continue;
    const a = argv(p); if (!a || a.length < 3) continue;
    if (path.basename(a[0]) !== base && path.basename(a[1] ?? '') !== base) continue;
    const last = a.length - 2;
    const ks = LINUX ? a.map((_, k) => k).filter((k) => k < a.length - 1) : [last];
    if (ks.some((k) => (a[k] === '--session-id' || a[k] === '--resume') && a[k + 1] === uuid)) out.push(p);
  }
  return out;
}
/** Shim marker: argv[1] ends with mcp-shim.js and argv[2] === '--sb-job=<id>'. */
export function sweepByMarker(jobId: number): number[] {
  const out: number[] = [];
  for (const p of allPids()) {
    const a = argv(p); if (!a || a.length < 3) continue;
    if ((a[1] ?? '').endsWith('mcp-shim.js') && a[2] === `--sb-job=${jobId}` && (LINUX || a.length === 3)) out.push(p);
  }
  return out;
}

export function killGroup(p: number, sig: NodeJS.Signals): void {
  try { process.kill(-p, sig); } catch { try { process.kill(p, sig); } catch {} }
}
export async function waitDead(p: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!groupAlive(p)) return true; await new Promise((r) => setTimeout(r, 50)); }
  return !groupAlive(p);
}
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}

export interface ProcRow { id: number; pid: number | null; proc_start: string | null; session_id: string | null }
export function procTargets(j: ProcRow): number[] {
  if (j.pid != null) return isOurs(j.pid, j.proc_start) ? [j.pid] : [];
  return pidsByArgv(j.session_id);
}
export async function killJobProcs(j: ProcRow): Promise<void> {
  const pids = procTargets(j);
  for (const p of pids) killGroup(p, 'SIGTERM');
  for (const p of pids) if (!(await waitDead(p, 5000))) killGroup(p, 'SIGKILL');
  for (const p of sweepByMarker(j.id)) killGroup(p, 'SIGKILL');
}

/** Next.js kill fallback (TECH §5.9 step 1): signal verified groups; return survivors. Writes no DB rows. */
export async function killVerified(rows: ProcRow[]): Promise<number[]> {
  const first = rows.flatMap((r) => procTargets(r));
  for (const p of first) killGroup(p, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 3000));
  for (const p of first) if (groupAlive(p)) killGroup(p, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 2000));
  const second = Array.from(new Set(rows.flatMap((r) => [...procTargets(r), ...sweepByMarker(r.id)])));
  for (const p of second) killGroup(p, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 1000));
  return second.filter((p) => isAlive(p));
}
