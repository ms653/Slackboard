// Seeds a temp SLACKBOARD_HOME with one task in review whose artifact has a synthetic 2-file diff (bundled with esbuild by diff-keyboard.mjs).
import fs from 'node:fs';
import { openDb, tx } from '../../lib/db';
import { claimNext } from '../../lib/domain/claim';
import { createTask } from '../../lib/domain/tasks';
import { callTool } from '../../lib/domain/tools';
import { finishAttempt } from '../../lib/domain/finish';
import { paths } from '../../lib/paths';

const db = openDb();
db.prepare(`UPDATE system_state SET doctor_ok_at=?, orchestrator_heartbeat_at=? WHERE id=1`).run(Date.now(), Date.now());
const { task_id } = tx(db, () => createTask(db, { title: 'Write docs', description: 'd', acceptance: '1. ok', by: { kind: 'user' } }));
const w = tx(db, () => claimNext(db, 'seed', 'tok'))!;
for (const [f, c] of [['docs/INSTALL.md', 'ten\nNode 16\ntwelve\n'], ['evil.html', '<img src=x onerror="window.__xss=1">\n</span><script>window.__xss=2</script>\n']]) {
  const p = `${paths.workspace(task_id)}/${f}`; fs.mkdirSync(p.replace(/\/[^/]*$/, ''), { recursive: true }); fs.writeFileSync(p, c);
}
const caller = { jobId: w.id, agent: 'worker', role: 'worker', kind: 'work' as const, threadId: w.thread_id, taskId: task_id };
const r = callTool(db, caller, 'update_task', { task_id, action: 'submit_for_review' });
if (!r.ok) throw new Error(JSON.stringify(r));
tx(db, () => finishAttempt(db, w.id, { exitCode: 0, result: { subtype: 'success', total_cost_usd: 0.01, num_turns: 2 } }, 'seed'));
const art = db.prepare(`SELECT * FROM artifacts WHERE task_id=?`).get(task_id) as any;
fs.writeFileSync(art.diff_path, `diff --git a/docs/INSTALL.md b/docs/INSTALL.md
--- a/docs/INSTALL.md
+++ b/docs/INSTALL.md
@@ -10,4 +10,4 @@ ## Prerequisites
 ten
-Node 16
+Node 20 or later
 twelve
 thirteen
@@ -30,2 +30,3 @@
 thirty
+thirty-one
 thirty-two
diff --git a/evil.html b/evil.html
--- /dev/null
+++ b/evil.html
@@ -0,0 +1,2 @@
+<img src=x onerror="window.__xss=1">
+</span><script>window.__xss=2</script>
`);
console.log(JSON.stringify({ task_id, artifact_id: art.id }));
