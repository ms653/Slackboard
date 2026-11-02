# Slackboard PRD

Status: Round 0 draft. Inputs: `docs/ASSUMPTIONS.md`, `docs/research.md`. Companion docs: `docs/UX.md`, `docs/TECH.md`.

## 1. Problem

One person driving several Claude Code agents today juggles terminals, copy-pastes between them and cannot see who is doing what. Agents talking to each other loop without bound, burn the shared Pro/Max allowance, and hand unreviewed work straight to the human (research.md §3). Existing kanban-for-agents tools are unstable or abandoned (research.md §1).

Slackboard is a **local, single-user agent workspace**: a Slack-style chat and a live kanban board where a director agent and worker agents talk in visible threads, create and track tasks, review each other's work before it reaches the user, and ask for help. The server, not the agents, owns lifecycle, limits and approvals.

## 2. Users and stories

Single user: the machine owner, logged in to their own Pro/Max subscription in the unmodified `claude` binary. No other users, ever (ASSUMPTIONS.md §2).

| # | As the user I want to... | So that... | MVP |
|---|---|---|---|
| U1 | post a request in a channel and @mention the director | the director plans it without me writing task cards | yes |
| U2 | see every agent message in channels/threads | nothing happens off-screen | yes |
| U3 | watch tasks move across a board live | I know progress without asking | yes |
| U4 | approve or reject every top-level task an agent proposes | agents cannot start new work on their own | yes |
| U5 | receive only reviewed work, plus anything that needs my decision, in one "Needs you" inbox | I am not interrupted by agent chatter | yes |
| U6 | see what the reviewer saw (server-captured diff) and its verdict | I can trust or overrule the review | yes |
| U7 | see each agent's presence (idle, working, blocked, failed, paused) | I know where things are stuck | yes |
| U8 | hit one kill switch that stops every agent process immediately | I can stop a runaway in seconds | yes |
| U9 | set a daily budget and job caps and see estimated spend | agents do not eat my whole subscription allowance | yes |
| U10 | be asked when an agent is stuck instead of it guessing | failures surface early (MAST "fail to ask") | yes (to director or user) |
| U11 | have the director spawn extra workers on demand | parallel work | Phase 2 |
| U12 | have workers ask peer workers for help | less escalation to me | Phase 2 |
| U13 | have a chief of staff agent write digests and triage for me | less reading | Phase 2 (MVP triage is rule-based) |

## 3. MVP scope

- **Agents:** exactly 1 director (`director`) and 1 worker (`worker`). The chief of staff in MVP is **deterministic server rules** (§6), not an LLM; its prompt is specified in TECH.md for Phase 2.
- **Channels:** exactly 1 channel, `#general`. Every message belongs to a thread; each task has exactly one thread.
- **Board:** columns Proposed, To do, In progress, In review, Blocked, Done (Cancelled hidden behind a filter).
- **Work type:** file-producing tasks inside a per-task git workspace (docs, code drafts). Worker tools: Read, Glob, Grep, Write, Edit plus the Slackboard MCP tools. **No Bash, no web, no email, no external integrations.**
- **Review:** every worker deliverable is reviewed by the director against a server-captured diff before the task can be Done. Max 2 review rounds, then escalation to the user.
- **Guardrails:** per-thread message and job caps, per-job turn and budget caps, daily and 5-hour job caps, daily estimated-USD budget, kill switch, approvals.
- **Runtime:** Next.js app on 127.0.0.1 plus a separate orchestrator Node process, both on one SQLite file (WAL).

## 4. Non-goals

- Multi-user, auth beyond localhost, remote access, tunnels, mobile.
- Any API key path. If `ANTHROPIC_API_KEY` is present it is stripped from agent processes (ASSUMPTIONS.md §1). `--bare` is never used.
- Offering Slackboard to others or running it for anyone but the subscription owner (ASSUMPTIONS.md §2).
- External side effects in MVP: sending email, posting to Slack/GitHub, purchases, web browsing. Approval records exist for them; executors do not.
- Arbitrary shell execution by agents (no `Bash` tool in MVP).
- `bypassPermissions` mode, ever.
- 24/7 autonomous operation. Agents wake only on explicit triggers (§TECH 5.1); there is no idle polling of the model.
- Supabase or any hosted backend.
- Accurate billing. `total_cost_usd` is a client-side estimate (ASSUMPTIONS.md §1); the UI labels it "estimated".

## 5. Success test (MVP acceptance)

Run as an automated e2e test with a fake `claude` binary (deterministic, TECH.md §11), and once manually with the real binary.

**Scenario S1 (happy path with one rework)**
1. Fresh DB, seeded agents `director`, `worker`, channel `#general`. Budgets: $5/day est., 25 jobs/5h, 60 jobs/day.
2. User posts in `#general`: `@director Write docs/INSTALL.md for a Node CLI called foo: prerequisites, install, verify.`
3. Director proposes a top-level task assigned to `worker`.
4. User approves it in Needs you.
5. Worker writes the file and submits for review.
6. Director requests changes once (fake script forces this); worker revises; director approves.
7. Director posts a summary to the user in the task thread; the task appears in Needs you as "Ready".

**Pass criteria (all must hold):**

| ID | Criterion | How measured |
|---|---|---|
| P1 | Board shows the task in order Proposed → To do → In progress → In review → To do → In progress → In review → Done | `events` rows of type `task.status_changed` for that task, in order |
| P2 | No worker job starts before the approval is `approved` | `jobs.started_at` (worker) > `approvals.decided_at` |
| P3 | Exactly 1 user decision needed before delivery (the approval), plus 1 "Ready" item after | Needs-you items created = 2 |
| P4 | Total jobs ≤ 6 (director respond, worker work ×2, director review ×2, + ≤1 slack) | `SELECT count(*) FROM jobs` |
| P5 | No duplicate side effects after one injected retry (fake binary exits 1 once mid-run after a `post_message`) | messages with same body in thread = 1; `tool_calls` dedupe hit = 1 |
| P6 | Zero `claude` processes remain after the scenario | process scan for the run session ids |
| P7 | Every agent message is visible in the thread; no agent message addressed to the user before review approval | `messages` where `author_kind='agent'` and mentions user and created before task done = 0 (except the approval request) |
| P8 | Wall clock ≤ 60 s with fake binary; ≤ 15 min, ≤ $3.00 est., zero unexpected `permission_denials` with real binary | timers, `jobs.cost_usd`, `jobs.permission_denials` |

**Scenario S2 (rejection):** user rejects the proposal → task Cancelled, zero worker jobs. Pass: `count(jobs where agent='worker') = 0`.

**Scenario S3 (kill switch):** press kill during worker job → within 5 s no `claude` process for any running job, job `killed`, task `blocked` with reason `killed`, no job claimed while kill is on. Pass: all four.

**Scenario S4 (budget hit):** daily limit set below one job's cap → job stays queued, UI shows budget banner, no spawn. Pass: zero `running` transitions after the hit event.

**Scenario S5 (crash recovery):** `kill -9` the orchestrator mid-worker-job, restart → orphaned `claude` process group killed, job retried, task returns to In progress, no duplicate messages. Pass: P5 and P6 hold.

## 6. Approval policy

**Needs the user's explicit yes (server-enforced):**

| Action | Approval kind | MVP behaviour |
|---|---|---|
| Agent creates a top-level task (no parent) | `create_top_level_task` | Task inserted as `proposed`; no job can run for it until approved |
| Anything that sends (email, DM, message outside Slackboard) | `send` | No tool can do it. Agent may `request_approval`; on approve the user gets the exact payload to act on manually |
| Anything that spends money or allowance beyond limits (extra usage credits, raising a budget, overriding a cap) | `spend` / `budget_increase` | Budget changes only via the user's Settings UI; agent requests are records only |
| Anything that posts externally (GitHub, Slack, web forms) | `post_external` | Same as `send` |

**Does not need approval:** user-created tasks (the user is acting), director-created subtasks under an approved/user-created task, messages inside Slackboard, file edits inside the task's own workspace.

**Enforcement (defence in depth; prompts are not a control):**
1. **No capability:** agent tool allowlists contain no network, exec, email or external tools (`--allowedTools` explicit list, `--disallowedTools Bash,WebFetch,WebSearch`, `--strict-mcp-config` with only the Slackboard server, `--permission-prompts none`).
2. **Tool server:** identity comes from the per-run token, never from tool input. `create_task` with `parent_id = null` from an agent always produces `status='proposed'` plus a pending approval. Workers cannot call `create_task` at all.
3. **Database triggers** (TECH.md §2): an agent-created top-level task cannot be inserted unless `proposed`; a `proposed` task cannot leave `proposed` (except to `cancelled`) without an `approved` approval row; an approval can only move `pending → approved|rejected|expired` and `approved → consumed`, and `decided_by` must be `'user'`.
4. **Decision path:** approvals change only through Next.js route `POST /api/approvals/:id/decide`, which requires the UI session cookie (SameSite=Strict, issued on page load) and a matching `Origin`/`Host` of `127.0.0.1:<port>`. The tool server has no code path that updates approvals.
5. **Single use:** Phase 2 executors must consume an approved approval (`approved → consumed`) in the same transaction as executing its exact `payload_hash`.

## 7. Risks and mitigations

| Risk | Source | Mitigation |
|---|---|---|
| Agents exhaust the shared 5-hour / weekly allowance, blocking the user's own Claude use | ASSUMPTIONS.md §1 (shared allowance) | Event-driven wakes only; default caps 25 jobs per rolling 5 h, 60 jobs/day, per-job `--max-turns` and `--max-budget-usd`; `sonnet` default model; usage meter on screen; caps editable only by the user |
| How limits apply to headless runs is unknown | ASSUMPTIONS.md §1, UNVERIFIED | Do not rely on any headless allowance; treat job caps as the primary control. Fallback: detect limit errors heuristically (TECH.md §5.6, UNVERIFIED signal) and pause the scheduler for 30 min instead of retrying |
| `total_cost_usd` is an estimate, not billing | ASSUMPTIONS.md §1 | Label "estimated"; enforce job-count caps independently of USD |
| `--max-budget-usd` overshoots by one response | research.md §2 | Daily budget check reserves the job's full cap before claim |
| Stray `ANTHROPIC_API_KEY` silently switches to API billing | ASSUMPTIONS.md §1 | Strip from child env; `doctor` and a UI banner warn if set in the parent env |
| "Ordinary, individual usage" is vague; enforcement possible without notice | ASSUMPTIONS.md §2 | Single user only, unmodified binary, no always-on loop, conservative caps; document in README; never share login |
| Agent-to-agent acknowledgment loops | research.md §3 | Server-owned thread caps and `closed` state; agent messages never wake other agents unless they explicitly @mention with a request; one queued job per (agent, thread) |
| Reviewer rubber-stamps (reward hacking) | research.md §3: unmitigated | Reviewer sees server-captured diff, not the worker's summary; max 2 rounds then the user; the user sees the same diff. Residual risk accepted and shown in UI ("Reviewed by director" is not a guarantee) |
| Prompt injection via files or agent messages | general | Content wrapped as untrusted data; authority derives from token and server rules; no exec/network tools; approvals server-gated |
| Orphaned `claude` processes after crash | research.md §2 | Process groups, pid + session-id verification, recovery on boot, kill switch kills groups |
| CLI behaviour drift (`--permission-prompts none` needs v2.1.259+, Manual default since v2.1.302) | ASSUMPTIONS.md §4 | `npm run doctor` probes the binary before first run and on version change; refuses to start agents if probes fail |
| MCP tool name form `mcp__slackboard__<tool>` UNVERIFIED | research.md §2 | `doctor` reads real names from the init `tools` list and stores them; spawn fails if expected tools are missing |
