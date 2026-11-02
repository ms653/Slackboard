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
| Slackboard   Today: 14/60 jobs · 5h: 6/25 · $1.82/$5.00 est. [orchestrator: up] [⚙] [■ KILL]|
+-------------------+--------------------------------------------+---------------------------+
| ▸ Needs you   (2) | #general     [ Needs you | Chat | Board ]  | Thread: T-7 INSTALL docs  |
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

- **Header (global status bar):** job counters (day and rolling 5 h), estimated spend vs budget, orchestrator heartbeat (`up` / `stale` / `down`), `⚙ Settings` button (opens §12 in the centre, `g s`), kill switch button. The header turns into a banner for kill, budget-hit, limit-pause and orchestrator-down states (§8).
- **Left:** Needs you (with count; selecting it opens the Needs you view), channels, agents with presence, board summary counts (each is a link that filters the board), and `⚙ Settings` at the bottom.
- **Centre:** three views, segmented control `Needs you | Chat | Board` (`g i` / `g c` / `g b`), plus Settings (`g s`, not in the control). Default on load: Needs you if its count > 0, else Chat. Below 800 px the `Inbox` tab is the Needs you view.
- **Right:** contextual detail: thread, task detail, review/diff, or approval detail. One at a time, with a back stack.

## 3. "Needs you" inbox

Items are created only by server rules (the MVP chief of staff, TECH.md §5.8). Agents reach it only through the director's `request_approval` and `request_help`.

| Item type | Created when | Primary action | Secondary |
|---|---|---|---|
| Approval: new task | agent proposes top-level task | Approve | Reject (with note) |
| Approval: send / spend / post external | agent calls `request_approval` | Approve (shows exact payload; MVP: "I'll do it myself" + copy) | Reject |
| Approval: budget increase | agent calls `request_approval` kind `budget_increase` | Approve → opens Settings (§12) prefilled with the requested values; the change happens only on Save there | Reject |
| Help request | director calls `request_help` (workers ask the director, never the user) | Reply (opens thread; replying unblocks the task; composer shows the wake hint, §6) | Cancel task |
| Ready | task reached Done after review | Accept | Reopen (with note) |
| Review limit reached | director requested changes in round 2 (task Blocked, `review_cap`) | View diff + verdict (opens §7 with the round-2 reviewer notes) | Send back with note (required; task → To do, label "Review rounds reset to 0 of 2") / Cancel task. No "Accept anyway" (PRD §6 decision) |
| Stopped by kill switch | tasks Blocked `killed`; shown as **one** grouped item (counts 1 in the badge) as soon as they are stopped, during the kill and after Resume | "N tasks were stopped by the kill switch." [Retry all] (`POST /api/tasks/unblock-killed`). While the kill switch is engaged both buttons are disabled with the label "Resume agents first" | [Review individually] (expands to one row per task: Retry = Unblock / Cancel task) |
| Failure | job failed terminally, or agent blocked the task | Retry | Cancel task / Open log |
| Thread capped | thread hit message or job cap | `cap_raises = 0`: Raise cap (+10 messages, +4 runs). `cap_raises = 1`: text "Cap already raised once"; task threads: Cancel task. Non-task threads: Close thread only | `cap_raises = 0`: Close thread / Cancel task (task threads). `cap_raises = 1`: Close thread. Close on a task thread leaves the task waiting (card waiting line, §5) |

**Where Retry goes** (Retry, Retry all, Unblock; TECH.md §3.1 `resumeTarget`): a task stopped during review (submitted diff not yet judged, workspace unchanged) returns to **In review** and the director re-reviews; a task stopped during review whose workspace changed returns to **To do** and that round is redone (the unjudged diff is set aside; card "round 2 of 2, redo"); every other task returns to **To do** and the worker runs, except a task whose director help run failed (card "director could not answer"): Retry asks the director again (task stays Blocked, "waiting on director (help)"; toast "T-7: asking the director again"), while replying in its thread answers in the director's place and sends it to **To do**. The Retry button's toast says which: "T-7 back to In review" / "T-7 back to To do" / "T-7 back to To do (round 2 redone)". The grouped kill item lists the split: "2 back to review, 1 back to To do".

**Not an inbox item:** a director `respond` run that fails terminally (no task to block) creates no Needs-you item; it shows only in its thread and in presence (§8 "Agent failure, terminal (respond job)"). A director `help` run that ends without an answer for a Blocked task (failed, limit hit, no answer, killed, or cancelled) **is** a Failure item (§8 "Director help run ended without an answer" row).

**Recently expired** (group below the list, last 24 h, from `GET /api/bootstrap`; not counted in the badge): greyed row "Expired after 24 h." New-task approval → [Re-propose]; send/spend/post/budget approval → [Ask the director again]. Both prefill the `#general` composer with `@director Please re-propose T-7 "<title>"` (or `…ask again: <summary>`) for the user to edit and send; nothing is sent automatically. The row leaves the group after 24 h.

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

Rules: oldest first; pending items resolved elsewhere disappear with an "Already handled" toast (expired approvals move to Recently expired instead); the count in the left pane and the document title (`(2) Slackboard`) update live. Approving a `spend` / `send` / `post_external` item opens a confirm dialog that repeats the payload; approving a new task does not.

## 4. Agent presence

| State | Icon | Label (always shown) | Meaning |
|---|---|---|---|
| idle | ○ hollow circle | Idle | no queued or running job |
| queued | ◔ quarter circle | Queued (n) | jobs waiting (reason shown on hover/focus: cap, budget, run-after) |
| working | ● filled circle + elapsed | Working · 0:42 | `work`/`respond`/`help` job running; sub-line shows last tool, e.g. "Edit INSTALL.md" |
| reviewing | ◐ half circle | Reviewing T-7 | `review` job running |
| blocked | ⏸ pause bars | Waiting on you | its task needs an approval/help answer |
| failed | ✕ cross | Failed · Retry 2/3 or Failed | last attempt failed; retry pending or terminal. Terminal stays Failed until that agent's next successful run |
| paused | ⊘ slashed circle | Paused: budget / limit / kill / you | scheduler not claiming jobs |
| disabled | – dash, greyed text | Disabled | agent switched off in Settings |

## 5. Task card anatomy

```
+-----------------------------------------+
| T-7  ◐ In review          round 1 of 2  |   id · status icon + text · review round
| Write docs/INSTALL.md                   |   title (2 lines max, ellipsis)
| ↳ subtask of T-3                        |   parent link (only if parent)
| @worker   ● Working · 0:42             |   assignee + live presence of claimant
| 6 replies · 1 file · $0.31 est.          |   thread replies · artifacts · spend on task
| ⏸ Blocked: waiting on director (help)    |   reason line: mandatory on every Blocked card
| ⚑ Needs reply                           |   flag row only when a Needs-you item exists
+-----------------------------------------+
```

- **Reason line (Blocked cards, always shown, from `blocked_reason`):** `help` → "Blocked: waiting on director (help)", or "Blocked: waiting on you (help)" if the director escalated to the user; `review_cap` → "Blocked: you need to decide (review limit)"; `job_failed` → "Blocked: failed 3 times" (or "Blocked: workspace changed after review" for `workspace_drift`, or "Blocked: director could not answer (help failed)" when TECH.md `helpFailed`); `killed` → "Blocked: stopped by kill switch"; `agent_blocked` → "Blocked by worker: <first line of note>"; `user` → "Blocked: you cancelled the run".
- **Waiting line (non-Blocked cards in To do / In progress / In review whose thread is not open; from `threads.status`):** closed → "⏸ Waiting: thread closed [Reopen thread]"; capped with `cap_raises = 0` → "⏸ Waiting: thread capped [Raise cap]"; capped with `cap_raises = 1` → "⏸ Waiting: thread capped, cap already raised [Cancel task]" (the only exit). No card in those columns is idle without a line. Reopen / Raise cap re-queue the run matching the column (To do → worker, In review → director review; TECH.md §3.3 resume rule). The toast is driven by the API response `{status, resumed}` (TECH.md §1.1), never assumed: `resumed` set → "Cap raised. T-7 will resume." / "Thread reopened. T-7 will resume."; `resumed: null` and `status: 'capped'` (reopen of a thread at its cap) → "Thread reopened but still capped. T-7 will not resume." + [Raise cap] when `cap_raises = 0`; `resumed: null` otherwise (task Blocked or Done) → "Cap raised." / "Thread reopened." with no resume text.
- **Round label:** "round N of 2" with N = `review_round` (TECH.md §3.1 round terms); after a redo (`resumeTarget` set the unjudged diff aside) the card shows "round N+1 of 2, redo" until the worker resubmits (shown while the task is To do / In progress and a `superseded` artifact exists for its `review_cycle` at round N+1).
- **Flag row** mirrors the Needs-you item type and appears only while that item exists: "⚑ Needs approval" / "⚑ Needs reply" / "⚑ Ready to accept" / "⚑ Review limit" / "⚑ Stopped by kill" / "⚑ Failed" / "⚑ Thread capped".
- **Done cards** show "✓ Ready, not accepted" (top-level, `accepted_at` null) or "✓ Accepted"; subtasks show "✓ Done".
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
Board header has `+ New task` (also in the quick switcher, `⌘K` → "New task").

### 5.1 Task detail (right pane)

```
| T-7 · ⏸ Blocked · assignee: worker · round 2 of 2              ✕          |
| Blocked: you need to decide (review limit)                                 |
|---------------------------------------------------------------------------|
| Description …            Acceptance 1. … 2. …                              |
| Notes (latest 10) …                                                        |
| Jobs                                                                       |
|  work    attempt 1/3  ✓ succeeded   $0.42 est.   [Open log]                |
|  review  attempt 1/3  ✓ succeeded   $0.18 est.   [Open log]                |
|  work    attempt 2/3  ● running     cap $1.00    [Cancel job]              |
|---------------------------------------------------------------------------|
| [Send back with note] [View diff d] [Cancel task]                          |
```
- **Header:** id, status text + icon, assignee, review round, and the §5 reason line when Blocked.
- **Body:** description, acceptance, notes, jobs list (kind, attempt n/max, status text + icon, est. cost or reserved cap while running).
- **Actions by state** (only legal ones render; each maps to TECH.md §3.1/§3.2):

| Task state | Actions |
|---|---|
| Proposed | Approve / Reject (same as inbox) |
| To do, In progress, In review | Cancel task; Cancel job on a queued/running job (confirm; running job → task Blocked "you cancelled the run") |
| Blocked | Unblock with note (`review_cap`: labelled "Send back with note"; destination per "Where Retry goes", §3); Cancel task |
| Done | Accept (top-level, not accepted); Reopen with note (reopens the closed thread too) |
| thread closed / capped, task not Blocked/terminal | the §5 waiting line with Reopen thread / Raise cap (`cap_raises = 0`); Cancel task (always, the only exit when capped with `cap_raises = 1`) |
| any with an artifact | View diff (§7) |
| any job row | Open log |

- **Log view** (read-only, replaces the body; Back returns): last 200 transcript lines (`GET /api/jobs/:id/log`), then failure kind and error text, e.g. "Failed: timeout_idle — no output for 3 min".
- **New task form** (`+ New task`): title (required), description, assignee (default worker). Create → task lands in To do with no approval (the user is acting) and a "Will wake worker" hint under the Create button.

## 6. Thread view

- Root message first, then replies chronological. Author line: name, role chip (`director` / `worker` / `you` / `system`), time.
- System messages (status changes, job start/finish, retries, caps) are compact grey lines with icon + text, collapsible as "5 system events".
- Agent messages that were dropped (thread closed/capped) are not shown; a system line says "1 message dropped: thread closed".
- Thread footer shows cap usage: "Agent messages 12/30 · Agent runs 4/12". At ≥ 80 % the text gets a "Near limit" label.
- Composer: `@` autocompletes agents. **Every** composer (channel, thread, Needs-you Reply) shows a live hint under it, computed from the same wake rules the server uses (TECH.md §5.1 `wakePreview`): "Will wake director" / "Will wake worker and unblock T-7" / "Will unblock T-7 and wake director to re-review" (the unblock target comes from TECH.md §3.1 `resumeTarget`, the same call the server makes) / "No agent will run (thread capped)" / "No agent will run (thread closed)". When the thread's agent runs are ≥ 80 % of its cap, the hint adds "Uses 1 of N remaining agent runs". While agents cannot run (kill switch, paused by you, usage limit, budget or job cap hit, orchestrator down; `wakePreview.blocked_by`) and the hint names an agent, every composer adds a second line: "Saved; agents are paused (<reason>), will run after resume", reason = "kill switch" / "paused by you" / "usage limit until 14:52" / "budget reached" / "job cap reached" / "orchestrator not running".
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
| [Accept  a]   [Reopen with note  r]          (footer for "Done, not accepted") |
```

**Verdict line:** `approved` → "✓ Approved by director <time>"; `changes_requested` → "✕ Changes requested by director <time>" (always so for `review_cap`, with "Round 2 of 2 · review limit reached"); no verdict yet → "◐ Awaiting director review"; `superseded` (TECH.md §3.1 `resumeTarget` redo) → "⟲ Set aside: workspace changed before review; round redone".

**Footer by task state** (only these render; each maps to TECH.md §3.1):

| Task state | Footer actions |
|---|---|
| Done, top-level, not accepted | [Accept a] (T19) · [Reopen with note r] (T18) |
| Blocked `review_cap` | [Send back with note r] (note required, T16 → To do, "Review rounds reset to 0 of 2") · [Cancel task] (T17). **No Accept** (PRD §6) |
| anything else (In review, Done accepted, subtask Done, other Blocked, older rounds) | no action footer; only ✕ Close |

`a` does nothing in the review view unless Accept is rendered.

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
| Agent failure, retrying | card badge, thread system line | "✕ Run failed (exit 1). Retrying in 30 s (2/3)." | Retry now (`POST /api/jobs/:id {retry_now}`: runs at the next claim, still subject to caps/budget) / Cancel (`{cancel}`, J4) |
| Agent failure, terminal | Needs you + card Blocked | "✕ worker failed 3 times on T-7: <short reason>. [Open log]" | Retry / Reassign [P2] / Cancel |
| Director help run ended without an answer (task Blocked/help; failed, turn/budget limit, no answer given, stopped by kill, or run cancelled) | Needs you (Failure) + card "Blocked: director could not answer (help failed)" + presence Failed when the run failed | "✕ director could not answer T-7's help request: <reason, e.g. failed 3 times / budget limit / gave no answer / stopped by kill switch / you cancelled the run>. [Open log]" | Retry (asks the director again; task stays Blocked) / reply in the thread (answers it yourself; task → To do) / Cancel task (TECH.md §3.2 help-end rule, `resumeTarget` case 0) |
| Agent failure, terminal (respond job) | thread system line + presence Failed (no task, **no Needs-you item**, §3) | "✕ director failed 3 times: <reason>. [Open log]" with hint "Send your message again to retry." Presence stays Failed until that agent's next successful run (TECH.md J12) | Open log; resend the message (normal wake rules) |
| Max turns hit | thread system line | "worker hit its turn limit; continuing once." then, if again, failure item | — |
| Budget hit | header banner (amber, ⊘) + sidebar Paused | "Daily budget reached ($5.00 est.). New agent runs are paused until 00:00 or you raise the budget. Running jobs finish." | Raise budget (opens Settings §12 with the field focused) / Dismiss |
| Job cap hit (day or 5 h) | same as budget | "Job cap reached (25 per 5 h). Next run allowed at 14:20." | Raise cap (opens Settings §12 with the field focused) |
| Subscription limit suspected | banner (amber, ⊘) | "Claude reported a usage limit. Agents paused until 14:52 (30 min). This also affects your own Claude use." | Resume now (`POST /api/pause {resume}`) / Keep paused (`{hold}`: no expiry; becomes the next row) |
| Paused by you | banner (amber, ⊘) + presences "Paused: you" | "Agents paused until you resume. Queued work waits." | Resume now (`POST /api/pause {resume}`) |
| Kill switch engaged | full-width red banner, all presences Paused: kill | "■ All agents stopped at 10:14. 2 processes killed. No new runs until you resume." | Resume (confirm) |
| Thread capped | thread footer + Needs you + task card waiting line (§5) | "Thread reached 30 agent messages. Agents can no longer post here." | `cap_raises = 0`: Raise cap (+10 messages, +4 runs; toast from the API `resumed`, §5) / Close / Cancel task (task threads). `cap_raises = 1`: "Cap already raised once": Close / Cancel task (task threads; the only way to end the task's wait) |
| Task thread closed, task still open | thread composer + task card waiting line (§5) | "Thread closed. T-7 is waiting." | Reopen thread (toast from the API `{status, resumed}`, §5: "Thread reopened. T-7 will resume." or, if the thread is at its cap, "Thread reopened but still capped. T-7 will not resume." + [Raise cap] when `cap_raises = 0`) / Cancel task |
| Approval expired | Needs you → Recently expired group (§3), 24 h | "Expired after 24 h. Task cancelled." | Re-propose / Ask the director again (prefills `#general` composer) |
| Initial load / API failure | centre pane, full | "Couldn't load Slackboard. [Retry]" plus the error code (e.g. `HTTP 500 db_locked`) | Retry |
| Message send failed | under composer | Text stays in the composer: "Not sent. [Retry]" | Retry |
| Card move rejected | board | Card snaps back; toast "Couldn't move T-7: <server hint>" | — |
| Session expired (`401 session_invalid`) | header banner (amber) | "Session expired. [Reload page]" | Reload page |
| Any mutating action pending | the button | Button shows "Approving…"/"Stopping…" etc. and is disabled until the response; other actions on the same item disabled too (no double Approve/Reject/Kill) | — |
| Action failed (Approve, Reject, Accept, Reopen, Retry, Retry all, Raise cap, Settings Save, Resume; any 4xx/5xx or network error) | next to the button | Button re-enables; inline error `role="alert"`: "Couldn't <action>: <server hint>" (e.g. "Couldn't approve: db_locked, try again"); the item stays. A `409` on an approval decision shows the "Already handled" toast (§3) instead. Stop all: §9 | Retry the same button |
| Agents can't run (kill, paused, usage limit, budget/job cap, orchestrator down) | composers, Needs you | Composer second hint line (§6). Approve stays allowed; toast "Approved. T-7 will start when agents resume." Kill-stopped tasks: §3 grouped item, actions disabled until Resume | — |

## 9. Kill switch

- Always-visible header button `■ KILL`, red, text label. Shortcut `Ctrl+Shift+K` (macOS `⌘⇧K`).
- Opens a dialog: "Stop all agents now? Running processes will be killed. Unsaved agent work may be lost." Buttons: `Stop all` (default focus) / `Cancel`. `Enter` confirms.
- After confirm the banner shows a live count "Stopping 2 processes…" → "Stopped". "Stopped" appears only when the kill reports no survivors (TECH.md §5.9: follow-up event, or the `/api/kill` response on the direct path); otherwise "N processes may still be running (pid 4312). [Copy kill command]".
- If `POST /api/kill` itself fails (4xx/5xx, network): the dialog stays open with "Couldn't stop agents: <hint>. [Retry] [Copy kill command]" (`role="alert"`) and the header shows "Kill failed". An unreachable or stale orchestrator is **not** a failure: Next.js writes `system_state.kill_switch = 1` and itself kills the running agent processes (TECH.md §5.9 step 1), so no claim happens and a restarted orchestrator marks those runs stopped by kill (tasks Blocked `killed`, not re-run after Resume). The banner follows the survivor rule above ("Stopped" or "N processes may still be running"), alongside the Orchestrator down banner (§8).
- Resume requires a second confirm and resets nothing else (budgets, caps unchanged). Tasks stopped by the kill stay Blocked and show at once as one grouped Needs-you item with its actions disabled ("Resume agents first", §3); after Resume a banner and that item say "N tasks were stopped by the kill switch. [Retry all] [Review individually]" (§3). Retry = Unblock (TECH.md T16): stopped reviews go back to In review, the rest to To do (§3 "Where Retry goes").

## 10. Keyboard

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Quick switcher (channels, tasks by id/title, agents) |
| `g i` / `g c` / `g b` / `g s` | Go to Needs you / Chat / Board / Settings |
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

## 12. Settings

Opened by `⚙` in the header or left pane, `g s`, a budget/cap banner ("Raise budget" / "Raise cap" focus the matching field), or approving a `budget_increase` item (fields prefilled with the requested values, unsaved). Centre view; user only.

```
| Settings                                                                  |
|-- Budgets & caps ---------------------------------------------------------|
| Daily budget (est. USD)   [ 5.00 ]   used today $1.82 est.                |
| Jobs per day              [  60  ]   used 14                              |
| Jobs per rolling 5 h      [  25  ]   used 6                               |
| Max concurrent agents     [   2  ]   (1–4)                                |
|                                                  [Save]                   |
|-- Agents -----------------------------------------------------------------|
| director  model: sonnet (read-only)   [✓ Enabled]                         |
| worker    model: sonnet (read-only)   [✓ Enabled]                         |
|-- Doctor -----------------------------------------------------------------|
| Last run 09:58 · ✓ all checks passed      [Re-run]   [Show report]        |
```
- **Save** opens a confirm dialog listing each change as old → new ("Daily budget $5.00 → $8.00 est."); confirm → `PUT /api/budgets`. Invalid values (≤ 0, concurrency outside 1–4) are shown inline and Save is disabled.
- **Agents:** toggle → `PUT /api/agents/:id` (disabling shows "Queued jobs wait until re-enabled"); presence becomes Disabled (§4).
- **Doctor:** last run time, pass/fail per check D1–D6, Re-run → `POST /api/doctor` (button shows "Running…"; result replaces the report).
