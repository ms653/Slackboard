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
