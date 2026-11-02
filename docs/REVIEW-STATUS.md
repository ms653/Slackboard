# Review status (stopped at 4-round cap — NOT signed off)

| Round | PM | UX | Eng | Blockers (distinct) |
|---|---|---|---|---|
| 1 | REVISE (4) | REVISE (8) | REVISE (8, sonnet) | 18 |
| 2 | REVISE (1) | REVISE (3) | REVISE (5, sonnet) | 9 |
| 3 | REVISE (1) | REVISE (3) | REVISE (3, opus) | 6 |
| 4 | **APPROVE** | REVISE (2) | REVISE (3, opus) | 4 |

## Unresolved blockers after Round 4
1. **Terminal failure of a director `help` job** (UX R4-2 = Eng R4-1; TECH §3.2 J12, UX §3/§8). J12 treats `help` jobs as task-less, but every `help` job belongs to a `blocked/help` task. On failure the task stays "waiting on director" with no Needs-you item, and the "send again" hint wakes the worker, not the director. Proposed fix: split J12 so a failed `help` job sets `blocked_reason='job_failed'` (a Needs-you failure item that Retry re-enqueues). Keep "no task" only for `respond`. Add a §11 test.
2. **Inbox actions for a capped thread with `cap_raises=1`** (UX R4-1; UX §3 vs §5/§5.1/§8). §3 offers only "Close thread", but Cancel task is the only real exit. Fix: §3 lists Cancel task / Close thread, plus a line saying Close leaves the task waiting.
3. **T18 reopen into a `capped` thread** (Eng R4-2; TECH §3.3 vs §3.1 T18). One section says nothing is enqueued; the other enqueues `work`. Fix: state once that T18's `work` job is enqueued but unclaimable until Raise cap (or skip the enqueue), and add a §11 case.
4. **"Last head" in the T8 guard** (Eng R4-3; TECH §3.1 T8, §8.3). It's undefined, so a redo that reverts drift is rejected and the task loops back to blocked. Fix: last head = `head_commit` of the newest non-`superseded` artifact, else `tasks.base_commit`. Add a §11 case.

None of these is a disagreement between reviewers. All four are narrow consistency gaps that the Round 3 fixes introduced or exposed. The non-blocking notes from every round were not applied.
