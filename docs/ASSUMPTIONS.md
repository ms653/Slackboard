# Assumptions check (official Anthropic sources, 2026-11-02)

## 1. Billing / limits for `claude -p` on Pro/Max
- Pro and Max have a five-hour session limit and a weekly limit; Max/Ultra also have a separate weekly Fable limit. https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- Claude and Claude Code share one allowance. Same URL.
- Extra usage: usage credits (Pro/Max/Ultra), API credits, or wait for reset. Same URL.
- If `ANTHROPIC_API_KEY` is set, Claude Code uses it instead of the subscription (API billing). Same URL.
- `--bare` mode never reads OAuth/keychain, so it needs an API key; do NOT use `--bare` with subscription auth. https://code.claude.com/docs/en/headless
- Advertised Pro/Max/Ultra limits "assume ordinary, individual usage of Claude Code and the Agent SDK". https://code.claude.com/docs/en/legal-and-compliance
- How limits apply specifically to headless/scripted runs: UNVERIFIED (the support article is silent). Output JSON gives `total_cost_usd`, but it is a client-side estimate, not billing. https://code.claude.com/docs/en/headless

## 2. Is personal always-on local orchestration permitted?
- Pro/Max use is under the Consumer Terms; Claude Code use is subject to the Usage Policy. https://code.claude.com/docs/en/legal-and-compliance
- OAuth is "intended exclusively for purchasers ... designed to support ordinary use of Claude Code". Same URL.
- Developers building products/services (incl. Agent SDK) should use API keys. Third parties may not offer Claude.ai login or route requests via Pro/Max credentials on behalf of users, nor collect/store Claude.ai credentials. Same URL.
- Customers may not resell or intermediate usage for end users; each user must use their own credentials. Same URL.
- An end user signing in to the unmodified Claude Code binary with their own subscription is explicitly allowed. Same URL.
- Not an explicit statement on 24/7 loops: the docs set no hours cap, but "ordinary, individual usage" is the stated assumption. Consumer Terms text itself not fetched: UNVERIFIED.

## 3. Subagent frontmatter (`.claude/agents/*.md`)
Required: `name`, `description`. Optional: `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `effort`, `isolation`, `color`, `initialPrompt`, `experimental`. Unknown fields silently ignored. https://code.claude.com/docs/en/sub-agents
- `model`: `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit`. Same URL.
- `tools`: comma string or YAML list; omitted = inherits all. Same URL.
- Subagents CAN spawn subagents, default up to three layers; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` disables. Same URL.

## 4. Headless flags (all confirmed) https://code.claude.com/docs/en/cli-reference
- `-p/--print`; `--output-format text|json|stream-json`; `--max-turns` (print only, errors on limit); `--allowedTools`; `--disallowedTools`; `--model`; `--resume/-r`; `--session-id` (valid UUID); `--permission-mode` (default, acceptEdits, plan, auto, dontAsk, bypassPermissions); `--append-system-prompt`; `--mcp-config`; `--verbose`.
- stream-json used with `--verbose` in official examples (https://code.claude.com/docs/en/headless); that it is strictly required: UNVERIFIED, so always pass both.
- Extras: `--json-schema`, `--max-budget-usd`, `--permission-prompts none` (v2.1.259+), `--input-format stream-json`.
- Since v2.1.302 `-p` defaults to Manual mode; unapproved calls are denied, so set a mode or allowedTools. https://code.claude.com/docs/en/headless

## Verdict
VIABLE: personal, single-user, local `claude -p` on your own logged-in Pro/Max subscription fits the documented "ordinary, individual usage" and unmodified-binary rules, subject to shared 5-hour/weekly limits.

Open risks
- Always-on loops may burn the 5-hour/weekly allowance fast; headless-specific treatment is UNVERIFIED, and the docs give no sanctioned hours cap or automation carve-out.
- "Ordinary, individual usage" is vague; Anthropic may enforce without notice, and Consumer Terms were not read directly.
- Never offer this to others or share the login; any multi-user use requires API keys.
- Stray `ANTHROPIC_API_KEY` silently switches to API billing; `--bare` ignores the subscription.
