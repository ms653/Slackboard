import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { DB } from '@/lib/db';
import { tx } from '@/lib/db';
import { now } from '@/lib/util';
import { paths, ensureDir, repoRoot } from '@/lib/paths';
import { emit } from '@/lib/domain/events';
import { kindSettings, agentRole, type JobRow } from '@/lib/domain/jobs';
import { finishAttempt, type Outcome } from '@/lib/domain/finish';
import { ensureWorkspace, workspaceFacts } from '@/lib/domain/git';
import { getTask, currentArtifact } from '@/lib/domain/rounds';
import { procStart, killGroup } from '@/lib/proc';
import { renderPrompt } from './prompt';
import { newState, parseLine, USAGE_LIMIT_RE, type ParseState } from './parser';

export interface Child {
  jobId: number; agent: string; kind: JobRow['kind']; taskId: number | null; pid: number; proc: ChildProcess;
  startedAt: number; lastOutputAt: number; killedFor?: Outcome['killedFor']; failure?: Outcome['failure'];
  state: ParseState; stderrTail: string; lastOutputEvent: number;
}
export interface SpawnCtx { db: DB; me: string; children: Map<number, Child>; tokens: { bindJob(id: number, token: string): void; revokeJob(id: number): void };
  toolPort: () => number; bin: () => string; sep: () => string }

export const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  // test-only passthroughs for the fake binary (never ANTHROPIC_*)
  for (const k of ['SB_FAKE_SCRIPT', 'SB_FAKE_STATE']) if (process.env[k]) env[k] = process.env[k]!;
  env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1';
  return { ...env, ...extra } as unknown as NodeJS.ProcessEnv;
}
const PLANTED = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.claude'];
export function scrubCwd(cwd: string): void {
  for (const f of PLANTED) fs.rmSync(path.join(cwd, f), { recursive: true, force: true });
}

export function buildArgs(o: { prompt: string; model: string; maxTurns: number; budget: number; allowed: string[]; sep: string;
  mcpConfig: string; systemPrompt: string; sessionId: string; resume: boolean }): string[] {
  return ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--model', o.model,
    '--max-turns', String(o.maxTurns), '--max-budget-usd', o.budget.toFixed(2), '--permission-prompts', 'none',
    '--allowedTools', o.allowed.join(o.sep), '--disallowedTools', 'Bash,WebFetch,WebSearch,Task,Agent,NotebookEdit',
    '--strict-mcp-config', '--mcp-config', o.mcpConfig, '--append-system-prompt', o.systemPrompt,
    o.resume ? '--resume' : '--session-id', o.sessionId];                    // must stay the LAST argv pair (TECH §6.2)
}

function finish(ctx: SpawnCtx, jobId: number, o: Outcome, owner = ctx.me) {
  try { return tx(ctx.db, () => finishAttempt(ctx.db, jobId, o, owner)); }
  catch (e: any) { console.error(`[orch] finishAttempt ${jobId} failed:`, e.message); return null; }
}

export function spawnJob(ctx: SpawnCtx, j: JobRow, token: string): void {
  const db = ctx.db;
  const ss = db.prepare(`SELECT kill_switch, mcp_tool_prefix FROM system_state WHERE id=1`).get() as { kill_switch: number; mcp_tool_prefix: string };
  if (ss.kill_switch) { finish(ctx, j.id, { killedFor: 'kill' }); return; }
  const role = agentRole(db, j.agent_id);
  const ks = kindSettings(role, j.kind);
  const agent = db.prepare(`SELECT model FROM agents WHERE id=?`).get(j.agent_id) as { model: string };
  let cwd: string;
  try {
    if (ks.cwd === 'workspace' && j.task_id) {
      const t = getTask(db, j.task_id)!;
      const base = ensureWorkspace(t.id);
      if (!t.base_commit) db.prepare(`UPDATE tasks SET base_commit=? WHERE id=? AND base_commit IS NULL`).run(base, t.id);
      if (j.kind === 'review') {                                          // §5.11 pre-spawn drift check (J18)
        const a = currentArtifact(db, t); const ws = workspaceFacts(t.id);
        if (!a || !ws.clean || ws.head !== a.head_commit) { finish(ctx, j.id, { failure: 'workspace_drift', exitCode: 0 }); return; }
      }
      cwd = paths.workspace(t.id);
    } else cwd = ensureDir(paths.agentDir(j.agent_id));
    scrubCwd(cwd);
  } catch (e: any) { finish(ctx, j.id, { failure: 'spawn_error', error: e.message }); return; }

  const run = ensureDir(paths.runDir(j.id));
  ctx.tokens.bindJob(j.id, token);
  const mcpPath = path.join(run, 'mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { slackboard: { command: process.execPath,
    args: [path.join(repoRoot(), 'orchestrator', 'mcp-shim.js'), `--sb-job=${j.id}`],
    env: { SB_RPC_URL: `http://127.0.0.1:${ctx.toolPort()}/rpc`, SB_RUN_TOKEN: token } } } }), { mode: 0o600 });
  const reasonRow = db.prepare(`SELECT json_extract(payload,'$.reason') r FROM events WHERE type='job.requeued' AND entity_id=? ORDER BY id DESC LIMIT 1`).get(String(j.id)) as { r: string } | undefined;
  const prompt = renderPrompt(db, j, j.attempts > 1 ? reasonRow?.r ?? null : null);
  fs.writeFileSync(path.join(run, 'prompt.md'), prompt);
  const sysPrompt = fs.readFileSync(path.join(repoRoot(), 'prompts', `${role === 'director' ? 'director' : 'worker'}.md`), 'utf8').replace(/\{\{agent_id\}\}/g, j.agent_id);
  const builtins = ks.builtins.map((b) => (b === 'Write' || b === 'Edit') ? `${b}(./**)` : b);
  const allowed = [...builtins, ...ks.tools.map((t) => ss.mcp_tool_prefix + t)];
  const args = buildArgs({ prompt, model: agent.model, maxTurns: ks.maxTurns, budget: j.budget_cap_usd, allowed, sep: ctx.sep(),
    mcpConfig: mcpPath, systemPrompt: sysPrompt, sessionId: j.session_id!, resume: j.session_started === 1 });

  let proc: ChildProcess;
  try {
    proc = spawn(ctx.bin(), args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  } catch (e: any) { ctx.tokens.revokeJob(j.id); finish(ctx, j.id, { failure: 'spawn_error', error: e.message }); return; }
  if (!proc.pid) {
    proc.on('error', (e) => { ctx.tokens.revokeJob(j.id); finish(ctx, j.id, { failure: 'spawn_error', error: e.message }); });
    return;
  }
  const pid = proc.pid;
  db.prepare(`UPDATE jobs SET pid=?, proc_start=? WHERE id=? AND status='running' AND lease_owner=?`).run(pid, procStart(pid), j.id, ctx.me);
  const c: Child = { jobId: j.id, agent: j.agent_id, kind: j.kind, taskId: j.task_id, pid, proc, startedAt: now(), lastOutputAt: now(),
    state: newState(), stderrTail: '', lastOutputEvent: 0 };
  ctx.children.set(j.id, c);

  const out = fs.createWriteStream(path.join(run, 'stdout.jsonl'), { flags: 'a' });
  const errLog = fs.createWriteStream(path.join(run, 'stderr.log'), { flags: 'a' });
  let outBytes = 0, errBytes = 0, buf = '';
  const expected = ks.tools.map((t) => ss.mcp_tool_prefix + t);
  proc.stdout!.on('data', (d: Buffer) => {
    c.lastOutputAt = now();
    if (outBytes < 20 * 1024 * 1024) { out.write(d); outBytes += d.length; }
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const ev = parseLine(c.state, line);
      if (ev === 'init') {
        db.prepare(`UPDATE jobs SET session_started=1, last_output_at=? WHERE id=?`).run(now(), j.id);
        if (c.state.init!.session_id && c.state.init!.session_id !== j.session_id) console.warn(`[orch] job ${j.id}: init session_id differs from argv`);
        const missing = expected.filter((e) => !c.state.init!.tools.includes(e));
        if (missing.length) { c.failure = 'tools_missing'; terminateChild(c, ctx.tokens); }
      } else if (ev === 'tool_use' && now() - c.lastOutputEvent > 2000) {
        c.lastOutputEvent = now();
        db.prepare(`UPDATE agents SET presence_detail=? WHERE id=?`).run(c.state.lastToolUse?.replace(ss.mcp_tool_prefix, '') ?? null, j.agent_id);
        emit(db, 'job.output', j.agent_id, 'job', j.id, { tool: c.state.lastToolUse }, j.id);
      }
    }
  });
  proc.stderr!.on('data', (d: Buffer) => {
    c.lastOutputAt = now();
    if (errBytes < 1024 * 1024) { errLog.write(d); errBytes += d.length; }
    c.stderrTail = (c.stderrTail + d.toString('utf8')).slice(-4000);
  });
  proc.on('close', (code, signal) => {
    if (buf) parseLine(c.state, buf);
    out.end(); errLog.end();
    ctx.tokens.revokeJob(j.id);
    fs.rmSync(mcpPath, { force: true });
    ctx.children.delete(j.id);
    const r = c.state.result;
    const usage = r?.subtype !== 'success' && (USAGE_LIMIT_RE.test(c.stderrTail) || USAGE_LIMIT_RE.test(c.state.lastText) || USAGE_LIMIT_RE.test(r?.result ?? ''));
    finish(ctx, j.id, { exitCode: code, signal, result: r ?? null, killedFor: c.killedFor ?? null, failure: c.failure ?? null,
      initSeen: !!c.state.init, sawUsageLimit: usage, permissionDenials: c.state.permissionDenials, error: (c.stderrTail || '').slice(-1000) || null });
    try { killGroup(pid, 'SIGKILL'); } catch {}                         // leftovers in the group
  });
}

/** Revoke the job token, SIGTERM the group, SIGKILL after 3 s. Does not touch killedFor/failure. */
export function terminateChild(c: Pick<Child, 'jobId' | 'pid'>, tokens: SpawnCtx['tokens'], grace = 3000): void {
  tokens.revokeJob(c.jobId);
  killGroup(c.pid, 'SIGTERM');
  setTimeout(() => killGroup(c.pid, 'SIGKILL'), grace).unref();
}

export function killChild(c: Child, why: NonNullable<Outcome['killedFor']>, tokens: SpawnCtx['tokens']): void {
  c.killedFor ??= why;
  terminateChild(c, tokens);
}

/** Kill-switch precedence (F4): 'kill' overrides an earlier timeout_*, lease_lost or shutdown mark; cancelled stays. */
export function markKilled(c: Pick<Child, 'killedFor'>, why: 'kill' | 'shutdown'): void {
  const k = c.killedFor;
  if (why === 'kill' && (!k || k.startsWith('timeout_') || k === 'lease_lost' || k === 'shutdown')) c.killedFor = 'kill';
  else c.killedFor ??= why;
}
