# Research notes (2026-11-02)

## 1. Existing multi-agent / kanban tools and what they get wrong

Evidence is thin: my search returned mostly blogs and aggregators, not primary docs or issue trackers. Treat as leads.

- Vibe Kanban: a Japanese write-up says its developer Bloop ended operations in April 2026 and a later release (v0.1.44) replaced the board with an export-only screen. It also says the npm package fetches its binary from the vendor CDN. https://www.issoh.co.jp/md/tech/10075 (single source, unconfirmed elsewhere).
- Parallel agents on interdependent code cause merge conflicts needing human oversight; the tool cannot fix faults inside the underlying CLI. https://videohighlight.com/v/kWlvet8fBS0
- Anthropic says multi-agent suits parallelizable, low-dependency work. Most coding tasks have fewer parallel parts than research, and agents are not yet good at real-time coordination and delegation. https://www.anthropic.com/engineering/multi-agent-research-system
- MAST (Berkeley) found the main multi-agent failures are design-level (specification, inter-agent misalignment, task verification), not just model weakness. It lists "fail to ask for clarification" (6.8%) as a mode and says final-stage-only checks are inadequate. https://arxiv.org/abs/2503.13657

## 2. Claude Code headless patterns

- Run with `claude -p ... --output-format stream-json --verbose`. Each line is a JSON event; the last line is a `result` message. https://code.claude.com/docs/en/headless
- Event order: `system`/`init` (model, tools, `mcp_servers` with `status`, `session_id`), then one `assistant` message per content block, `user` messages carrying tool results, then `result`. https://code.claude.com/docs/en/agent-sdk/agent-loop
- Init lists `mcp_servers` and `mcp_server_errors`. Entries failing validation (e.g. `url` with no `type`) are skipped and the run still exits cleanly, so check these fields. https://code.claude.com/docs/en/headless
- `result` subtypes: `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`. `result` text exists only on `success`. All subtypes carry `total_cost_usd`, `usage`, `num_turns`, `session_id`. https://code.claude.com/docs/en/agent-sdk/agent-loop
- `is_error` field: the pages I read did not show it. UNVERIFIED; key off `subtype` and the process exit code (non-zero on failure). https://code.claude.com/docs/en/headless
- Max turns: counts tool-using turns plus one final text-only turn. Hitting the cap yields `error_max_turns` with no final text. The docs say to resume the session with a higher limit. https://code.claude.com/docs/en/agent-sdk/agent-loop
- `--max-budget-usd` can overshoot by one response plus still-running subagents. Subagent spend counts toward the cap. https://code.claude.com/docs/en/agent-sdk/agent-loop
- Resume: `claude -p "..." --resume "$session_id"`, id from the JSON result. https://code.claude.com/docs/en/headless
- Permissions: `--allowedTools` auto-approves; since v2.1.302 `-p` starts in Manual mode and unapproved calls are denied. Rule syntax: `Bash(git diff *)` (the space before `*` matters). https://code.claude.com/docs/en/headless
- `--permission-prompts none` denies anything that would prompt and tells the model not to retry. Denials show as `permission_denied` system messages and in `permission_denials` on the result. https://code.claude.com/docs/en/headless
- `AskUserQuestion` is removed under `--permission-prompts none`, so "ask for help" must be a custom tool, not the built-in. https://code.claude.com/docs/en/headless
- MCP: `--mcp-config <file-or-json>` takes the `.mcp.json` format. Stdio entries use `command`/`args`/`env`; HTTP entries need `type: "http"` plus `url`. `--strict-mcp-config` loads only those servers. https://code.claude.com/docs/en/mcp
- Without `--bare`, `-p` loads the project's `.mcp.json`, hooks and CLAUDE.md with no trust prompt. `--bare` needs an API key, so do not use it (see ASSUMPTIONS.md). https://code.claude.com/docs/en/headless
- Tool names are `mcp__<server>__<tool>`. I verified only the plugin form `mcp__plugin_<plugin>_<server>__<tool>`; the plain form and server-level `mcp__server` allow syntax are UNVERIFIED here. Test them against the init `tools` list. https://code.claude.com/docs/en/mcp
- Context auto-compacts; persistent rules belong in CLAUDE.md, not the first message. https://code.claude.com/docs/en/agent-sdk/agent-loop

## 3. Agent-to-agent loop failure modes and mitigations

- Acknowledgment loops: politeness-trained agents keep exchanging closing messages until a human, a timeout or a full context window stops them. Proposed fixes are explicit terminal states for a conversation and discarding messages that arrive after closure. https://zylos.ai/research/2026-06-29-agent-acknowledgment-loops-behavioral-idempotency
- Infinite Agentic Loops study: 68 confirmed failures in 47 of 6,549 agent repos. The largest category (~20.6%) is multi-agent chat without a turn bound. The authors say trusting the model to eventually stop is insufficient. https://huggingface.co/papers/2607.01641.md
- Guardrails recommended: per-task action caps, token/cost thresholds, and an external monitor that does not depend on the agent noticing it is looping. https://www.dell.com/en-us/infohub/articles/execution-guardrails-for-agentic-implementation
- Cost: agents use ~4x chat tokens and multi-agent ~15x. Token use explained ~80% of performance variance, so cost buys quality and also hides runaway. https://www.anthropic.com/engineering/multi-agent-research-system
- Observed agent failures: 50 subagents for simple queries, endless searching, excessive inter-agent updates that distract, duplicated work from vague delegation. Mitigations: effort-scaling rules in prompts, delegation with objective, output format, tool guidance and boundaries, plans saved to memory, artifacts on disk passed by reference. https://www.anthropic.com/engineering/multi-agent-research-system
- Echo chambers and reviewer reward hacking: no source found in budget. Treat as unmitigated risk; do not claim otherwise.

## Design implications

1. Make the server, not the agents, own conversation lifecycle: every thread gets a message cap and an explicit `closed` state; post-close messages are dropped, never delivered. (Zylos, IAL paper)
2. Treat each `claude -p` call as one bounded turn: set `--max-turns` and `--max-budget-usd` on every spawn, handle `error_max_turns` by resuming with an explicit continue or escalating.
3. Track spend in the server from `total_cost_usd` and `num_turns` per agent and per day. Hard-stop the scheduler at a daily ceiling and surface it in the UI. Expect ~15x chat token burn.
4. Detect failure from `result.subtype` and the exit code, not `is_error` (unverified). Log `permission_denials`, and fail a spawn if init `mcp_servers` shows the workspace tool server not connected.
5. Run workers with `--permission-prompts none`, a narrow `--allowedTools` and `--strict-mcp-config --mcp-config` pointing at the local tool server. Implement "ask for help" and "review" as custom MCP tools, since `AskUserQuestion` is removed. Verify actual `mcp__...` names from the init event first.
6. Route agent messages by rule, not broadcast: an agent runs only when mentioned or assigned, with at most one nesting level of director-to-worker. Don't wake agents for acknowledgments (e.g. no-reply flag on messages). Delegation payloads need objective, output format, boundaries (Anthropic).
7. Make review non-gameable by design: the reviewer sees the diff and test output captured by the server, not the worker's summary. Cap review rounds (e.g. 2) then escalate to the human.
8. Run each worker in its own git worktree/dir and persist state in the DB (task, plan, session_id). Resume by session_id, and put standing rules in `--append-system-prompt` so compaction cannot drop them.
