# Slackboard UX

Status: Round 0 draft. Scope tags: **[MVP]** or **[P2]** (Phase 2). Everything untagged is MVP.

## 1. Principles

1. The user reads decisions, not chatter: "Needs you" is the home screen; channels are for audit.
2. Every status is text + icon shape + colour. Never colour alone.
3. Agent state is always visible: presence in the sidebar, live card badges, and a global status bar.
4. Destructive or spending actions need one explicit confirmation; the kill switch needs one and is always visible.
5. Estimated cost is always labelled "est." (TECH.md §5.5).

## 2. Layout (three panes)

Desktop ≥ 1200 px. Left 240 px fixed; centre flexible; right 420 px, closable. Below 1200 px the right pane overlays the centre. Below 800 px: one pane at a time with a top tab bar (Inbox / Chat / Board / Detail).

```
+--------------------------------------------------------------------------------------------+
| Slackboard   Today: 14/60 jobs · 5h: 6/25 · $1.82/$5.00 est.   [orchestrator: up]  [■ KILL] |
+-------------------+--------------------------------------------+---------------------------+
| ▸ Needs you   (2) | #general            [ Chat | Board ]        | Thread: T-7 INSTALL docs  |
|                   |--------------------------------------------|  ✕                        |
| CHANNELS          | You  10:02                                 |---------------------------|
|  # general        |   @director Write docs/INSTALL.md for ...  | Task T-7 · In review ◐    |
|                   |   └ 4 replies · T-7                        | Assignee: worker          |
| AGENTS            | director  10:02                            | Round 1 of 2              |
|  ● director       |   Proposed T-7 "Write INSTALL.md".         |---------------------------|
|    Working · 0:42 |   Waiting for your approval.               | director 10:02            |
|  ○ worker         |                                            |  Proposed this task...    |
|    Idle           |                                            | worker 10:05              |
|                   |                                            |  Submitted for review.    |
| BOARD SUMMARY     |                                            |  [View diff]              |
|  Proposed 0       |                                            | director 10:06 · working… |
|  In progress 1    |                                            |---------------------------|
|  Blocked 0        |--------------------------------------------| Reply…           [Send]  |
|                   | Message #general… (@ to mention)   [Send]  |                           |
+-------------------+--------------------------------------------+---------------------------+
```

- **Header (global status bar):** job counters (day and rolling 5 h), estimated spend vs budget, orchestrator heartbeat (`up` / `stale` / `down`), kill switch button. The header turns into a banner for kill, budget-hit, limit-pause and orchestrator-down states (§8).
- **Left:** Needs you (with count), channels, agents with presence, board summary counts (each is a link that filters the board).
- **Centre:** `#general` in Chat or Board view (toggle; `g c` / `g b`).
- **Right:** contextual detail: thread, task detail, review/diff, or approval detail. One at a time, with a back stack.

## 3. "Needs you" inbox

Items are created only by server rules (the MVP chief of staff, TECH.md §5.8). Agents reach it only through the director's `request_approval` and `request_help`.

| Item type | Created when | Primary action | Secondary |
|---|---|---|---|
| Approval: new task | agent proposes top-level task | Approve | Reject (with note) |
| Approval: send / spend / post external | agent calls `request_approval` | Approve (shows exact payload; MVP: "I'll do it myself" + copy) | Reject |
| Help request | director calls `request_help` (workers ask the director, never the user) | Reply (opens thread; replying unblocks the task) | Cancel task |
| Ready | task reached Done after review | Accept | Reopen (with note) |
| Failure | job failed terminally, task Blocked | Retry | Cancel task / Open log |
| Thread capped | thread hit message or job cap | Raise cap by +10 once / Close thread | |

```
+-- Needs you (2) ---------------------------------------------------------+
| Filter: [All] Approvals  Help  Ready  Failures              Sort: Oldest  |
|---------------------------------------------------------------------------|
| ⚑ APPROVAL · New task                         from director · 2 min ago   |
|   T-7 "Write docs/INSTALL.md"  → assign: worker                           |
|   Why: user asked in #general.  Est. cap: $1.00, 15 turns                 |
|   [Approve  a]  [Reject  r]  [Open thread  ↵]                             |
|---------------------------------------------------------------------------|
| ✓ READY · Reviewed by director (round 2)                    just now      |
|   T-7 "Write docs/INSTALL.md" · 1 file changed (+42)                      |
|   [Accept  a]  [Reopen  r]  [View diff  d]                                |
+---------------------------------------------------------------------------+
```

Rules: oldest first; items resolved elsewhere disappear with an "Already handled" toast; the count in the left pane and the document title (`(2) Slackboard`) update live. Approving a `spend` / `send` / `post_external` item opens a confirm dialog that repeats the payload; approving a new task does not.

## 4. Agent presence

| State | Icon | Label (always shown) | Meaning |
|---|---|---|---|
| idle | ○ hollow circle | Idle | no queued or running job |
| queued | ◔ quarter circle | Queued (n) | jobs waiting (reason shown on hover/focus: cap, budget, run-after) |
| working | ● filled circle + elapsed | Working · 0:42 | `work`/`respond`/`help` job running; sub-line shows last tool, e.g. "Edit INSTALL.md" |
| reviewing | ◐ half circle | Reviewing T-7 | `review` job running |
| blocked | ⏸ pause bars | Waiting on you | its task needs an approval/help answer |
| failed | ✕ cross | Failed · Retry 2/3 or Failed | last attempt failed; retry pending or terminal |
| paused | ⊘ slashed circle | Paused: budget / limit / kill | scheduler not claiming jobs |
| disabled | – dash, greyed text | Disabled | agent switched off in Settings |

## 5. Task card anatomy

```
+-----------------------------------------+
| T-7  ◐ In review          round 1 of 2  |   id · status icon + text · review round
| Write docs/INSTALL.md                   |   title (2 lines max, ellipsis)
| ↳ subtask of T-3                        |   parent link (only if parent)
| @worker   ● Working · 0:42             |   assignee + live presence of claimant
| 6 replies · 1 file · $0.31 est.          |   thread replies · artifacts · spend on task
| ⚑ Needs approval                        |   flag row only when Needs-you item exists
+-----------------------------------------+
```

- The icons are decorative (`aria-hidden`); every icon has adjacent text.
- Claim expired badge: "Claim expired, requeued" (amber, ⟲ icon) for 10 s after recovery.
- Card click opens task detail in the right pane; `Enter` on focused card does the same.
- User may move a card only along transitions TECH.md §3.1 allows for `actor=user` (Cancel, Reopen, Unblock). Illegal drops snap back with an inline message ("Only the reviewer can move In review → Done").

**Board columns:** Proposed · To do · In progress · In review · Blocked · Done. Cancelled behind "Show cancelled". Column header shows count. Done shows the last 20, then "Show all".

```
| PROPOSED (1)   | TO DO (0)     | IN PROGRESS (1) | IN REVIEW (0) | BLOCKED (0) | DONE (3) |
| [T-9 card]     | No tasks.     | [T-7 card]      | No tasks.     | No tasks.   | [T-6]... |
| ⚑ approve      |               |                 |               |             |          |
```

## 6. Thread view

- Root message first, then replies chronological. Author line: name, role chip (`director` / `worker` / `you` / `system`), time.
- System messages (status changes, job start/finish, retries, caps) are compact grey lines with icon + text, collapsible as "5 system events".
- Agent messages that were dropped (thread closed/capped) are not shown; a system line says "1 message dropped: thread closed".
- Thread footer shows cap usage: "Agent messages 12/30 · Agent runs 4/12". At ≥ 80 % the text gets a "Near limit" label.
- Composer: `@` autocompletes agents. Sending a message that mentions an agent shows "Will wake director" under the composer before send.
- Closed thread: composer replaced by "Thread closed. [Reopen]" (user only).

```
| Thread: T-7 Write docs/INSTALL.md                         [Close thread] ✕ |
|---------------------------------------------------------------------------|
| you · 10:02   @director Write docs/INSTALL.md for ...                     |
| ▸ system · task T-7 proposed · approved by you 10:03                      |
| worker · 10:05   Draft done. Submitted for review.  [View diff]           |
| director · 10:06 (review)   Changes requested:                            |
|   1. Add Windows prerequisites.                                           |
| worker · 10:09   Revised. Resubmitted.  [View diff]                       |
| director · 10:10 (review)   Approved. @you INSTALL.md is ready.           |
|---------------------------------------------------------------------------|
| Agent messages 5/30 · Agent runs 5/12                                     |
| Reply…                                                         [Send]    |
```

## 7. Review / diff view

MVP: read-only, server-captured unified diff of the task workspace for the submitted round, plus the reviewer's verdict. **[P2]** side-by-side, syntax highlighting, inline comments, compare across rounds.

```
| Review · T-7 · round 2 of 2                                    ✕          |
| Verdict: ✓ Approved by director 10:10        Captured by server 10:09     |
|---------------------------------------------------------------------------|
| Files (1):  docs/INSTALL.md  +42 −0                                       |
|---------------------------------------------------------------------------|
| --- /dev/null                                                             |
| +++ b/docs/INSTALL.md                                                     |
| @@ -0,0 +1,42 @@                                                          |
| +# Install                                                                |
| + ...                                                                     |
|---------------------------------------------------------------------------|
| Reviewer notes: "Covers prereqs, install, verify. Windows added."         |
| [Accept  a]   [Reopen with note  r]                                       |
```

Diff lines carry `+`/`−` prefixes and screen-reader text "added line" / "removed line", not colour only. Diff over 2,000 lines: show file list and first 500 lines per file with "Show full file".

## 8. System states

| State | Where | What the user sees | Actions |
|---|---|---|---|
| First run, empty | everywhere | Centre: "Say what you need. Mention @director to start." Board columns: "No tasks." Needs you: "Nothing needs you." | Composer focused |
| Doctor failed | full-page | "Agents are disabled: <failed check>, e.g. claude not on PATH / --permission-prompts unsupported / Slackboard tools not found." Chat and board stay readable | Re-run checks |
| API key detected | header banner (amber, ⚠) | "ANTHROPIC_API_KEY is set in your environment. Agents run without it, on your subscription." | Dismiss for session |
| Loading | panes | Skeleton rows (no spinner > 300 ms without text "Loading messages…") | — |
| SSE disconnected | header | "Live updates paused, reconnecting…" (⟲); after 10 s "Offline. [Retry]" | Retry |
| Orchestrator down | header banner (red, ✕) | "Agents are not running (no heartbeat for 15 s). Your messages are saved and will be handled when it restarts." | Copy restart command |
| Agent job running | card, sidebar, thread | presence Working + last tool; thread shows "director is working…" line | Cancel job (task detail) |
| Agent failure, retrying | card badge, thread system line | "✕ Run failed (exit 1). Retrying in 30 s (2/3)." | Retry now / Cancel |
| Agent failure, terminal | Needs you + card Blocked | "✕ worker failed 3 times on T-7: <short reason>. [Open log]" | Retry / Reassign [P2] / Cancel |
| Max turns hit | thread system line | "worker hit its turn limit; continuing once." then, if again, failure item | — |
| Budget hit | header banner (amber, ⊘) + sidebar Paused | "Daily budget reached ($5.00 est.). New agent runs are paused until 00:00 or you raise the budget. Running jobs finish." | Raise budget (confirm dialog, `spend`) / Dismiss |
| Job cap hit (day or 5 h) | same as budget | "Job cap reached (25 per 5 h). Next run allowed at 14:20." | Raise cap (confirm) |
| Subscription limit suspected | banner (amber, ⊘) | "Claude reported a usage limit. Agents paused for 30 min. This also affects your own Claude use." | Resume now / Keep paused |
| Kill switch engaged | full-width red banner, all presences Paused: kill | "■ All agents stopped at 10:14. 2 processes killed. No new runs until you resume." | Resume (confirm) |
| Thread capped | thread footer + Needs you | "Thread reached 30 agent messages. Agents can no longer post here." | Raise cap +10 once / Close |
| Approval expired | Needs you item greys out | "Expired after 24 h. Task cancelled." | Re-propose (opens thread) |

## 9. Kill switch

- Always-visible header button `■ KILL`, red, text label. Shortcut `Ctrl+Shift+K` (macOS `⌘⇧K`).
- Opens a dialog: "Stop all agents now? Running processes will be killed. Unsaved agent work may be lost." Buttons: `Stop all` (default focus) / `Cancel`. `Enter` confirms.
- After confirm the banner shows a live count "Stopping 2 processes…" → "Stopped". If any process survives 10 s: "1 process could not be stopped (pid 4312). [Copy kill command]".
- Resume requires a second confirm and resets nothing else (budgets, caps unchanged).

## 10. Keyboard

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Quick switcher (channels, tasks by id/title, agents) |
| `g i` / `g c` / `g b` | Go to Needs you / Chat / Board |
| `j` / `k` | Next / previous item in focused list (messages, inbox, cards in column) |
| `h` / `l` | Previous / next board column |
| `Enter` | Open focused item in right pane |
| `Esc` | Close right pane / dialog; return focus to invoking element |
| `a` / `r` | Approve-or-accept / Reject-or-reopen on focused inbox item (`r` always asks for a note) |
| `d` | Open diff for focused task |
| `m` | Move focused card: opens menu of legal target columns only |
| `/` | Focus composer |
| `Ctrl+Shift+K` | Kill switch dialog |
| `?` | Shortcut help |

Single-letter shortcuts are disabled while focus is in a text field.

## 11. Accessibility rules

- WCAG 2.1 AA contrast for text and icons; status colours are paired with icon shape and text (tables §4, §5, §8).
- Landmarks: `nav` (left), `main` (centre), `complementary` (right), `banner` (header). Each pane has a heading.
- Live regions: new messages in the open thread and inbox count changes `aria-live="polite"`; kill switch, budget-hit, orchestrator-down banners `role="alert"`. Agent "working…" ticks are not announced (no per-second noise).
- Board: each column is a `list` with `aria-label="In progress, 1 task"`; cards are `listitem` with an accessible name "T-7, Write docs/INSTALL.md, In review, round 1 of 2, assigned to worker". Drag-and-drop always has the `m` menu equivalent.
- Focus: visible 2 px focus ring; opening the right pane moves focus to its heading; closing returns focus.
- `prefers-reduced-motion`: no card slide animations; status changes flash a text label instead.
- Times have absolute value in `title` and accessible text ("10:02, 2 minutes ago").
- Diff: `+`/`−` prefixes kept in the DOM; lines have screen-reader prefixes.
