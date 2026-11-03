# Build review changelog

Round 0: M1-M3 implementation (commits abf4d0c, 1f79190, 81ff2a8)
Round 1: ENG-1, PM-1, PM-2, PM-3, UX-1, UX-2 (+kill-dialog autofocus, decide validation) -> orchestrator/main.ts, scripts/launch.mjs, app/api/approvals/[id]/decide/route.ts, components/{App,ui,Header,NeedsYou,RightPane,Views}.tsx, package.json, README.md, test/e2e/{kill,s1,http}.test.ts, test/unit/ddl.test.ts
Round 2: PM-4, PM-5, UX-3, UX-4, UX-5, UX-6 -> README.md, test/e2e/s4.test.ts, components/App.tsx, components/store.ts, components/ui.tsx, components/Views.tsx, lib/server/read.ts, test/unit/badge.test.ts
Round 3: UX-7, UX-8, UX-9, badge text/countdown -> lib/server/read.ts, components/Header.tsx, components/RightPane.tsx, components/Views.tsx, test/unit/badge.test.ts

## Status: SIGNED OFF (round 4)

| Round | PM | UX | Eng | Blockers |
|---|---|---|---|---|
| 1 | REVISE (3) | REVISE (2) | REVISE (1, Sonnet) | 6 |
| 2 | REVISE (2) | REVISE (4) | **APPROVE** (Sonnet) | 6 |
| 3 | **APPROVE** | REVISE (3) | **APPROVE** (Opus) | 3 |
| 4 | n/a | **APPROVE** | n/a | 0 |

"n/a" means the reviewer was not re-run because nothing in its area changed. Round 3 edits to `lib/server/read.ts` were display-only (banner and badge text), so the eng approval stands.

Final verification: tsc clean · next build clean · unit 31/31 · e2e 10/10 (S1 with P1–P8, S2, S3, S3b, S4, S5, SIGTERM shutdown, HTTP guards).

### Open non-blocking notes (fix opportunistically)
- Charge `budget_reserved_usd` when an attempt ends with no `result` (killed or timed out), so the daily estimate isn't undercounted.
- `killAll` in the SIGTERM handler and `/control/kill` has no try/catch. Register signal handlers before the doctor probes run.
- On `tools_missing`, escalate SIGTERM to SIGKILL and revoke the token.
- After crash recovery the card shows "Run failed (orphaned)", where UX §5 asks for "Claim expired, requeued".
- Header gaps from UX §8–§9:
  - no "Kill failed" state
  - no live "Stopping N processes…" count
  - no "Next run allowed at HH:MM" on the job-cap banner
  - "Raise cap" always focuses the 5 h field, even when the day cap was hit
- The inline "Cancel task" buttons in Needs you skip the confirm dialog that the task pane uses.
- Tailwind breakpoints are 768/1280 px; UX specifies 800/1200 px.
- Release gate still open: the manual smoke test against the real `claude` binary (TECH §11).
