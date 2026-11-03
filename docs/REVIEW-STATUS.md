# Review status: SIGNED OFF (Round 12)

Every reviewer's approval covers the current version of the docs it reviews:
- **PM** approved in Round 4. PRD.md has not changed since Round 3.
- **UX** approved in Round 8. UX.md has not changed since Round 7.
- **Eng** (Opus) approved in Round 12, on the current TECH.md.

The original cap was 4 rounds. The user extended it to "until signed off".

| Round | PM | UX | Eng | Distinct blockers |
|---|---|---|---|---|
| 1 | REVISE (4) | REVISE (8) | REVISE (8, Sonnet) | 18 |
| 2 | REVISE (1) | REVISE (3) | REVISE (5, Sonnet) | 9 |
| 3 | REVISE (1) | REVISE (3) | REVISE (3, Opus) | 6 |
| 4 | **APPROVE** | REVISE (2) | REVISE (3, Opus) | 4 |
| 5 | n/a | REVISE (2) | REVISE (1, Opus) | 3 |
| 6 | n/a | **APPROVE** | REVISE (1, Opus) | 1 |
| 7 | n/a | REVISE (1) | REVISE (2, Opus) | 2 |
| 8 | n/a | **APPROVE** | REVISE (2, Opus) | 2 |
| 9 | n/a | n/a | REVISE (1, Opus) | 1 |
| 10 | n/a | n/a | REVISE (2, Opus) | 2 |
| 11 | n/a | n/a | REVISE (2, Opus) | 2 |
| 12 | n/a | n/a | **APPROVE** (Opus) | 0 |

"n/a" means the reviewer was not re-run because the docs in its area did not change. From Round 6 on, every blocker was in process control: kill, crash recovery and Resume. Round 11 replaced argv-based process identity with process group plus start time, and that change closed the class.

## Last eng non-blocking notes (fix during build; none blocks the design)
1. `procStart` must return a string. `proc_start` is a STRICT TEXT column, and comparing a number to it fails every time, so nothing would ever be killed. On macOS, run `ps -o lstart=` with `LC_ALL=C TZ=UTC`. **Fix this first.**
2. If a row has `pid` NULL and the argv fallback is off, report `survivors: 'unknown'`, not `[]`. Don't show "Stopped".
3. D7 should require the argv match after the init event, not just once at startup.
4. esbuild bundle: pass the repo root from `launch.mjs` so `mcp-shim.js` and `prompts/` resolve. D7 uses the standard spawn builder.
5. PRD §5 P6 and the risk mitigation line still describe argv-based process checks. Align them with TECH's process-group check (`kill(-pgid,0)` → ESRCH, plus `sweepByMarker`).

Unapplied non-blocking notes from earlier rounds are mostly UX polish:
- a threshold and badge for the `stale` heartbeat state
- a precedence order for stacked banners
- filter chips for stuck items
- loading and error states for the log and diff views
- focus details for the Resume dialog
