# Slackboard

A local, single-user agent workspace: a Slack-style chat plus a live kanban board. A **director** agent and a **worker** agent talk to you and to each other in visible threads, propose and track tasks, and review each other's work before it reaches you.

- Runs only on your machine (`127.0.0.1`). Nothing is hosted.
- Agents run through the `claude` CLI in headless mode (`claude -p`) on your logged-in Claude subscription. The app holds no API keys.
- Design docs: [`docs/PRD.md`](docs/PRD.md), [`docs/UX.md`](docs/UX.md), [`docs/TECH.md`](docs/TECH.md). Review history: [`docs/REVIEW-STATUS.md`](docs/REVIEW-STATUS.md).

## Requirements

- macOS or Linux, Node 20+, `git`
- Claude Code CLI v2.1.259 or later, logged in with your Pro/Max account (`claude` on your PATH)
- `ANTHROPIC_API_KEY` should **not** be set. Agent processes never receive it, but the app warns you if it is set.

## Run

```bash
npm install
npm run build        # Next.js + bundled orchestrator
npm start            # http://127.0.0.1:3000
```

`npm start` launches two processes that share `~/.slackboard/slackboard.db` (SQLite, WAL mode):

- the Next.js UI and API on 127.0.0.1
- the orchestrator, which claims jobs, spawns `claude -p`, and runs the local MCP tool server

On first start the orchestrator runs **doctor** probes (D1–D7). Each probe is a short `claude -p` run that checks the binary, that the MCP tools are visible, the allowlist format, that writes outside the working folder are refused, and that process identity can be read. Until doctor passes, nothing is claimed. Re-run it from Settings or with `npm run doctor`.

### Try it without spending anything

A fake `claude` binary scripts the agents' behaviour and talks real MCP to the real tool server:

```bash
SLACKBOARD_HOME=/tmp/sb-demo SLACKBOARD_CLAUDE_BIN=$PWD/test/fake-claude/claude npm start
```

Send "Please write INSTALL.md" in #general, approve the proposal in **Needs you**, and watch the task move through the board to Done.

## How it works (short)

- **Approval policy:** an agent can create a top-level task only as *Proposed*. It starts only after you approve it, and DB triggers enforce this as a backstop. Agents have no send, spend or post tools. They can only file a `request_approval` record, and you carry out the action yourself.
- **Review before it reaches you:** the worker's diff is captured by the server (git outside the work tree, hooks off). The director reviews that diff, not the worker's summary. If the workspace changed after capture, the task can't reach Done. After 2 review rounds the decision escalates to you.
- **Guardrails:**
  - message and run caps per thread
  - a daily estimated-$ budget plus job caps (60/day, 25 per 5 h)
  - per-role tool allowlists, enforced twice: in the CLI flags and again in the tool server
  - `--permission-prompts none`, and never bypass mode
  - untrusted content escaped and fenced in prompts
- **Kill switch** (■ KILL, `Ctrl+Shift+K`): kills each agent's whole process group (verified by start time) and revokes run tokens. It still works if the orchestrator has crashed: the UI kills the processes itself, and Resume stays disabled until recovery has marked the runs.
- **Crash safety:**
  - Jobs are claimed with a single atomic `UPDATE … RETURNING`.
  - A restart recovers orphaned runs.
  - Tool side effects are recorded exactly once per (job, tool, input).

## Tests

```bash
npm test             # unit: DDL/triggers, claim gates, task + job state machines, review loop with real git
npm run test:e2e     # end-to-end with the real orchestrator + fake claude: PRD S1 (P1–P8), S2, S3, S3b, S5
```

## Data

Everything lives in `~/.slackboard/` (override with `SLACKBOARD_HOME`):
- the database
- per-task git workspaces
- per-run transcripts under `runs/<job>/`

Nothing is written into this repo at runtime.

## Not in this MVP

See TECH.md §12:
- dynamic worker spawning, agent-to-agent help, and a side-by-side diff view
- the LLM chief of staff, executors for approved external actions, and more channels

UI items deferred from UX.md: the `⌘K` quick switcher, drag-and-drop on the board (use the **Move…** menu or the `m` key; the spec already requires it as the accessible equivalent), and `j`/`k`/`h`/`l` list navigation.
