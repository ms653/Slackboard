# Build review changelog

Round 0: M1-M3 implementation (commits abf4d0c, 1f79190, 81ff2a8)
Round 1: ENG-1, PM-1, PM-2, PM-3, UX-1, UX-2 (+kill-dialog autofocus, decide validation) -> orchestrator/main.ts, scripts/launch.mjs, app/api/approvals/[id]/decide/route.ts, components/{App,ui,Header,NeedsYou,RightPane,Views}.tsx, package.json, README.md, test/e2e/{kill,s1,http}.test.ts, test/unit/ddl.test.ts
Round 2: PM-4, PM-5, UX-3, UX-4, UX-5, UX-6 -> README.md, test/e2e/s4.test.ts, components/App.tsx, components/store.ts, components/ui.tsx, components/Views.tsx, lib/server/read.ts, test/unit/badge.test.ts
Round 3: UX-7, UX-8, UX-9, badge text/countdown -> lib/server/read.ts, components/Header.tsx, components/RightPane.tsx, components/Views.tsx, test/unit/badge.test.ts
Follow-up F1: F1 budget estimate on result-less attempts, F2 killAll try/catch + early signal handlers + doctor probe pids, F3 tools_missing escalation/revoke, F4 kill-switch precedence, F5 doctor token bind, F6 claim-expired badge, F7 header kill-failed/stopping count/next-run/raise-cap focus, F8 Needs-you cancel confirm, F9 800/1200 breakpoints, F10 quick switcher/j k h l/board DnD -> lib/domain/finish.ts, orchestrator/{main,spawn,doctor,toolserver}.ts, lib/server/read.ts, tailwind.config.ts, components/{App,Header,NeedsYou,RightPane,Views,store}.tsx, components/{QuickSwitcher.tsx,dnd.ts}, README.md, test/unit/followup1.test.ts

## Status: SIGNED OFF (round 4)

| Round | PM | UX | Eng | Blockers |
|---|---|---|---|---|
| 1 | REVISE (3) | REVISE (2) | REVISE (1, Sonnet) | 6 |
| 2 | REVISE (2) | REVISE (4) | **APPROVE** (Sonnet) | 6 |
| 3 | **APPROVE** | REVISE (3) | **APPROVE** (Opus) | 3 |
| 4 | n/a | **APPROVE** | n/a | 0 |

"n/a" means the reviewer was not re-run because nothing in its area changed. Round 3 edits to `lib/server/read.ts` were display-only (banner and badge text), so the eng approval stands.

Final verification: tsc clean · next build clean · unit 31/31 · e2e 10/10 (S1 with P1–P8, S2, S3, S3b, S4, S5, SIGTERM shutdown, HTTP guards).

### Open non-blocking notes
- Release gate still open: the manual smoke test against the real `claude` binary (TECH §11).
- F1-F10 resolved in Follow-up F1 (above). Not separately tested: F2 signal ordering and the in-flight doctor-probe kill (covered only by the existing SIGTERM e2e).
Follow-up F1 review fixes: ENG-F1, UX-safety -> lib/domain/finish.ts, components/dnd.ts, components/Views.tsx, test/unit/followup1.test.ts
Round (ENG-F2, ENG-F3, kill guard): ENG-F2/ENG-F3/kill-guard -> lib/domain/finish.ts, orchestrator/spawn.ts, orchestrator/doctor.ts, orchestrator/main.ts, test/unit/followup1.test.ts
- F1 review fixes 3 (orchestrator): killAll no longer stops doctor probes (shutdown handler still does); null-safe doctor_report read; forced doctor errors caught. -> orchestrator/main.ts
- F1 review fixes 4 (orchestrator): runDoctor no longer clears the stop flag; doctor()/boot() bail out once shutting down; probes killed again right before exit; test added. -> orchestrator/doctor.ts, orchestrator/main.ts, test/unit/followup1.test.ts

## Follow-up F1: SIGNED OFF (eng approve after 5 review passes; UX approve)
Open non-blocking notes:
- Kill during a doctor run revokes doctor tokens (`revokeAll`), which fails D4. Revoke only job tokens on `kill`.
- Doctor tokens aren't revoked when a probe closes. Revoke them in the probe close handler.
- `next_run_at` uses the oldest start in the 5 h window. That's wrong if the cap was lowered below current usage.
- An orphaned resumed attempt can be charged the cap even if it crashed before init. Fix with a per-attempt init flag.
- Dropping a Blocked card unblocks to whatever `resumeTarget` picks, which may not be the column it was dropped on. Say so in the toast, or only allow the drop on that column.
- `dropHandlers` is registered during render. Move it into a `useEffect`.
- `--doctor-only` races the signal handler on exit.
- Release gate: the manual smoke test against the real `claude` binary (TECH §11).
Phase 2 increment 1: MIGRATION 2 + dynamic worker spawning, agent lifecycle (A1-A6, R1), per-agent budgets, claim/queueReason/presence, agents list, spawn approval card, Settings workers -> lib/db/{index,migrations}.ts, lib/domain/{agents,claim,jobs,tasks,tools,finish,rounds,wake}.ts, lib/server/{actions,read,route}.ts, lib/util.ts, app/api/agents/**, app/api/{budgets,tasks,approvals}/**, orchestrator/{main,prompt,spawn,toolserver}.ts, prompts/{worker,director}.md, components/{AgentsList,AgentsSettings,App,NeedsYou,RightPane,Views,Sidebar,Composer,QuickSwitcher,ui,store,api}.tsx, test/fake-claude/claude, test/unit/{phase2,ddl}.test.ts, test/e2e/{phase2,phase2_http}.test.ts
Phase 2 increment 1 review fixes: UX-1, UX-2, spawn_worker help-job publish, skill_note trim, user-task assignee validation -> lib/systemLines.ts, components/RightPane.tsx, lib/domain/{jobs,agents,tools,tasks}.ts, test/unit/phase2_review_fixes.test.ts
- Phase 2 increment 1: SIGNED OFF (PM approve R1, eng approve R1, UX approve R2). Tests: unit 94/94, e2e 15/15, migration validator green.
Phase 2 increment 2: peer help (request_help target_agent routing/guards/caps, T11/T11b/T11c reroute + sweep + reroute_help action, help-end naming the helper, peer wake exception, J4 peer predicate, peer help kindSettings/prompt/worker.md rule 6), UI B3 (chips, Peer help n/2, card/queue lines, Helping presence, Ask the director instead, system-line buttons) + increment 1 review UI fixes (agent-named Edit budget/Enable labels, spawn From: origin thread title, Raise cap/Reopen thread buttons on the Director-not-woken line) -> lib/domain/{tools,finish,tasks,claim,jobs}.ts, lib/server/{actions,read}.ts, lib/systemLines.ts, orchestrator/{prompt,main}.ts, prompts/worker.md, components/{RightPane,AgentsList,NeedsYou,ui}.tsx, test/fake-claude/claude, test/unit/peerhelp.test.ts, test/e2e/{peerhelp,phase2_http}.test.ts
Phase 2 increment 2 review fixes: ENG-1, SPEC, UX-1, UX-2, UX-3 -> lib/domain/tools.ts, lib/domain/tasks.ts, lib/server/read.ts, components/NeedsYou.tsx, components/RightPane.tsx, test/unit/phase2_inc2_review_fixes.test.ts
Phase 2 increment 2 review fixes 2: ENG-2, ENG-3, ENG-4 (+ main.ts comment, rerouteHelp updated_by) -> lib/domain/tools.ts, lib/domain/tasks.ts, lib/server/actions.ts, orchestrator/main.ts, test/unit/phase2_inc2_review_fixes.test.ts
- Phase 2 increment 2: SIGNED OFF (PM approve R1, UX approve R2, eng approve R3 on Opus). Tests: unit 129/129, e2e 21/21, migration validator green.
Phase 2 increment 3: richer diff view + inline comments (T8 parser/anchorInDiff/splitHighlightedLines/hljs lazy highlight, T6.4 anchored add_note + caps, T5.5 comments/compare routes + artifact comments/siblings/delivery, review_note_ids in claim + <review_comments> prompt with protected tail, B4/B5 DiffView unified/split/compare/Expand/keyboard/help) + inc2 review items (per-kind continuation tools, T11b on any terminal outcome, wrong_task "omit task_id") -> lib/domain/{diff,comments,claim,finish,git,tools}.ts, lib/{highlight,util}.ts, lib/server/{read,actions}.ts, app/api/artifacts/[id]/{comments,compare}/route.ts, orchestrator/prompt.ts, components/{RightPane,App,store}.tsx, components/diff/*, test/fake-claude/claude, test/unit/phase2_inc3.test.ts, test/e2e/diffcomments.test.ts, test/playwright/{seed.ts,diff-keyboard.mjs}, package.json (highlight.js, axe-core dev)
Phase 2 increment 3 review fixes: PM-1, PM-2, ENG (T11b not for killed/cancelled peer help), UX/ENG (placement from rendered hunks, "Not sent: over the per-run limit"), spec alignment (B4 Expand width, T5.5 line_not_in_diff 400, B4 delivery state, T9 release gate) -> test/playwright/diff-keyboard.mjs, package.json, lib/domain/finish.ts, components/diff/{DiffView,LineComments}.tsx, test/unit/phase2_inc3.test.ts, docs/PHASE2.md
- Phase 2 increment 3 SIGNED OFF (PM round 2 approve; eng/UX blockers fixed and verified: tsc, unit 147, e2e 22, test:a11y, validator).
Redesign (DESIGN.md applied): tokens/materials/typography/focus/motion in app/globals.css + tailwind.config.ts + app/layout.tsx; lucide-react@0.468.0 Icon wrapper and token restyle of every component (ui, App, Header, Sidebar, AgentsList, AgentsSettings, NeedsYou, Views, RightPane, Composer, QuickSwitcher, diff/*); test/unit/design.test.ts, test/playwright/screenshots.mjs + seed-shots.ts, npm script "screenshots"
Redesign designer r1 fixes: board columns flex 208-320 + overflow fade mask; quick-switcher solid-ish panel/scrim/rows; jobs table two-line actions; chat system roots as system lines, chip dedupe, time fallback; split-diff comments render in their own half; settings agent trailing grid; + Comment ghost w/ Plus (a11y test selector now aria-label), Ctrl K kbd, task title assignee muted, system-events toggle on task row, split header row bg, review toolbar bg, mobile agent strip -> components/{Views,ui,QuickSwitcher,RightPane,AgentsSettings,App,Header}.tsx, components/diff/{DiffView,SplitHunk}.tsx, test/playwright/diff-keyboard.mjs
