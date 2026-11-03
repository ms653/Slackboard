import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import type { DB } from '@/lib/db';
import { now } from '@/lib/util';
import { paths, ensureDir, repoRoot } from '@/lib/paths';
import { emit } from '@/lib/domain/events';
import { kindSettings } from '@/lib/domain/jobs';
import { procStart, pidsByArgv, killGroup, setArgvFallback } from '@/lib/proc';
import { newState, parseLine, type ParseState } from './parser';
import { buildArgs, childEnv } from './spawn';
import type { Tokens } from './toolserver';

export interface Check { id: string; ok: boolean; level: 'fail' | 'warn' | 'info'; detail: string }

export function resolveBin(bin: string): string | null {
  if (bin.includes('/')) return fs.existsSync(bin) ? path.resolve(bin) : null;
  for (const d of (process.env.PATH ?? '').split(':')) { const p = path.join(d, bin); if (d && fs.existsSync(p)) return p; }
  return null;
}
export function binSignature(bin: string): string {
  const p = resolveBin(bin); if (!p) return 'missing';
  try { const st = fs.statSync(p); return `${p}:${st.mtimeMs}`; } catch { return 'missing'; }
}

/** Live doctor probe child pids, so a signal during doctor can kill them (F2). */
export const liveProbePids = new Set<number>();
let stopped = false;
export function resetDoctorStop(): void { stopped = false; }
export function killDoctorProbes(): void { stopped = true; for (const pid of liveProbePids) { try { killGroup(pid, 'SIGKILL'); } catch {} } liveProbePids.clear(); }

export async function probe(bin: string, port: number, tokens: Tokens, prompt: string, extraAllowed: string[], sep: string, prefix: string,
                     watchArgv: boolean): Promise<{ s: ParseState; code: number | null; pid?: number; startOk: boolean; argvSeen: boolean; calls: unknown[] }> {
  if (stopped) return { s: newState(), code: -1, startOk: false, argvSeen: false, calls: [] };
  const dir = ensureDir(path.join(paths.doctorDir(), crypto.randomBytes(6).toString('hex')));
  const calls: unknown[] = [];
  const dt = tokens.issueDoctor((_t, input) => calls.push(input));
  const mcp = path.join(dir, '.probe-mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { slackboard: { command: process.execPath,
    args: [path.join(repoRoot(), 'orchestrator', 'mcp-shim.js'), '--sb-job=doctor'],
    env: { SB_RPC_URL: `http://127.0.0.1:${port}/rpc`, SB_RUN_TOKEN: dt.token } } } }), { mode: 0o600 });
  const ks = kindSettings('director', 'respond');
  const session = crypto.randomUUID();
  const args = buildArgs({ prompt, model: 'sonnet', maxTurns: 3, budget: 0.05, allowed: [...ks.builtins, ...extraAllowed, ...ks.tools.map((t) => prefix + t)],
    sep, mcpConfig: mcp, systemPrompt: 'You are a Slackboard health probe. Do exactly what the prompt says, then stop.', sessionId: session, resume: false });
  return new Promise((resolve) => {
    const s = newState();
    let p;
    try { p = spawn(bin, args, { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }); }
    catch { return resolve({ s, code: -1, startOk: false, argvSeen: false, calls }); }
    if (!p.pid) { p.on('error', () => resolve({ s, code: -1, startOk: false, argvSeen: false, calls })); return; }
    dt.bind(p.pid); liveProbePids.add(p.pid);
    const startOk = procStart(p.pid) !== null;
    let argvSeen = false;
    const iv = watchArgv ? setInterval(() => { if (pidsByArgv(session, bin).includes(p!.pid!)) argvSeen = true; }, 50) : null;
    let buf = '';
    p.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { parseLine(s, buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.stderr!.on('data', () => {});
    const timer = setTimeout(() => killGroup(p!.pid!, 'SIGKILL'), 120_000);
    p.on('close', (code) => { liveProbePids.delete(p!.pid!); clearTimeout(timer); if (iv) clearInterval(iv); if (buf) parseLine(s, buf);
      fs.rmSync(dir, { recursive: true, force: true }); resolve({ s, code, pid: p!.pid, startOk, argvSeen, calls }); });
  });
}

export async function runDoctor(db: DB, bin: string, port: number, tokens: Tokens): Promise<{ ok: boolean; checks: Check[] }> {
  // `stopped` is cleared only by the caller (resetDoctorStop) when it is not shutting down; never here,
  // or a shutdown signal that arrived before this call would be forgotten and probes would spawn.
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, level: Check['level'], detail: string) => checks.push({ id, ok, level: ok ? 'info' : level, detail });
  const resolved = resolveBin(bin);
  add('D1 binary', !!resolved, 'fail', resolved ?? `${bin} not found on PATH`);
  add('D2 env', !process.env.ANTHROPIC_API_KEY, 'warn', process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY is set in the parent env (children never get it)' : 'no API key in env');
  let prefix = 'mcp__slackboard__', sep = ',', argvFallback = true, model: string | undefined, version: string | null = null;
  if (resolved) {
    try { version = execFileSync(resolved, ['--version'], { encoding: 'utf8', timeout: 10_000, env: childEnv() }).trim(); } catch {}
    const d3 = await probe(resolved, port, tokens, 'Reply OK', [], sep, prefix, true);
    const tools = d3.s.init?.tools ?? [];
    const pm = tools.find((t) => t.endsWith('post_message'));
    if (pm) prefix = pm.slice(0, -'post_message'.length);
    const need = kindSettings('director', 'respond').tools.map((t) => prefix + t);
    const missing = need.filter((n) => !tools.includes(n));
    model = d3.s.init?.model;
    add('D3 init', !!d3.s.init && missing.length === 0 && d3.s.result?.subtype === 'success', 'fail',
      !d3.s.init ? `no init event (exit ${d3.code})` : missing.length ? `missing tools: ${missing.join(', ')}` : `ok, prefix ${prefix}, model ${model ?? '?'}`);
    add('D6 no subagents', !tools.includes('Task') && !tools.includes('Agent'), 'warn', 'Task/Agent tools not exposed');
    add('D7 process identity', d3.startOk, 'fail', d3.startOk ? 'start time readable' : 'cannot read process start time');
    argvFallback = d3.argvSeen;
    if (!d3.argvSeen) checks.push({ id: 'D7 argv', ok: false, level: 'warn', detail: 'session id not visible in argv; fallback matcher disabled' });
    if (checks.every((c) => c.ok || c.level !== 'fail')) {
      let d4 = await probe(resolved, port, tokens, "Call the add_note tool with task_id 0 and body 'probe', then stop.", [], sep, prefix, false);
      if (!(d4.calls.length && d4.s.permissionDenials === 0)) { sep = ' '; d4 = await probe(resolved, port, tokens, "Call the add_note tool with task_id 0 and body 'probe', then stop.", [], sep, prefix, false); }
      add('D4 allowlist', d4.calls.length > 0 && d4.s.permissionDenials === 0, 'fail', d4.calls.length ? `add_note received (separator ${JSON.stringify(sep)})` : 'tool call never reached the server');
      const target = path.join('/tmp', `sb-probe-${crypto.randomBytes(4).toString('hex')}`);
      await probe(resolved, port, tokens, `Use the Write tool to create the file ${target} containing x. Then stop.`, ['Write(./**)'], sep, prefix, false);
      const leaked = fs.existsSync(target); if (leaked) fs.rmSync(target, { force: true });
      add('D5 path scope', !leaked, 'warn', leaked ? 'Write outside cwd succeeded: path-scoped rules not enforced' : 'write outside cwd denied');
    }
  }
  if (stopped) return { ok: false, checks };
  setArgvFallback(argvFallback);
  const ok = checks.every((c) => c.ok || c.level !== 'fail');
  const report = { at: now(), ok, checks, prefix, sep, argv_fallback: argvFallback, model, bin_sig: binSignature(bin) };
  db.prepare(`UPDATE system_state SET doctor_report=?, doctor_ok_at=?, mcp_tool_prefix=?, claude_version=? WHERE id=1`)
    .run(JSON.stringify(report), ok ? now() : null, prefix, version);
  emit(db, 'settings.changed', 'system', 'system', 1, { doctor: ok ? 'ok' : 'failed' });
  return { ok, checks };
}
