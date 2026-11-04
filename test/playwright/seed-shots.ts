// Extra realistic data for test/playwright/screenshots.mjs: runs after seed.ts in the same SLACKBOARD_HOME (bundled with esbuild).
// Several agents, tasks in every board column, an inbox with each card type, chat threads with code. Temp DB only.
import { openDb, tx } from '../../lib/db';
import { createTask } from '../../lib/domain/tasks';
import { createWorkerByUser } from '../../lib/domain/agents';
import { createThread } from '../../lib/domain/threads';
import { insertMessage, systemMessage } from '../../lib/domain/messages';

const db = openDb();
db.exec('DROP TRIGGER IF EXISTS tasks_legal_transition');            // temp DB only: place tasks in any column
const MIN = 60_000, now = Date.now();
const ago = (m: number) => now - m * MIN;

tx(db, () => createWorkerByUser(db, { name: 'writer2', skill_note: 'Documentation, READMEs and release notes.', daily_usd: 2, daily_jobs: 10 }));
db.prepare(`UPDATE agents SET display_name='Writer2' WHERE id='writer2'`).run();

const mk = (title: string, assignee: string, description = '', acceptance = '') =>
  tx(db, () => createTask(db, { title, description, acceptance, assignee, by: { kind: 'user' } }));
const status = (id: number, st: string, extra = '') => db.prepare(`UPDATE tasks SET status=?, updated_at=? ${extra} WHERE id=?`).run(st, ago(5), id);

const retry = mk('Add retry with backoff to the API client', 'worker',
  'Requests to /v1/jobs fail intermittently with 429. Wrap the client calls in a retry helper with exponential backoff and jitter.',
  '1. 429 and 503 are retried up to 3 times\n2. Backoff doubles from 200 ms with jitter\n3. Unit tests cover the retry budget');
db.prepare(`UPDATE tasks SET status='in_progress', claimed_by='worker', claim_expires_at=?, updated_at=? WHERE id=?`).run(now + 3_600_000, ago(2), retry.task_id);
const parser = mk('Refactor settings parser', 'writer2', 'Split parseSettings() into validate + normalise.', '1. No behaviour change');
const toggle = mk('Add dark mode toggle to Settings', 'worker');
const flaky = mk('Fix flaky date test in CI', 'worker', 'test/date.spec.ts fails around midnight UTC.', '1. Test is deterministic');
status(flaky.task_id, 'blocked', `, blocked_reason='agent_blocked'`);
const changelog = mk('Update CHANGELOG for v0.4', 'writer2');
status(changelog.task_id, 'done', `, accepted_at=${ago(30)}`);
const onboarding = mk('Ship onboarding checklist', 'worker');
status(onboarding.task_id, 'done');
const killsw = mk('Document the kill switch', 'writer2', 'Add a short section to the README.', '1. Mentions Ctrl+Shift+K');
status(killsw.task_id, 'in_review');
const sub = tx(db, () => createTask(db, { title: 'Write backoff unit tests', assignee: 'worker', parentId: retry.task_id, by: { kind: 'user' } }));
void sub;
tx(db, () => createTask(db, { title: 'Migrate logs to structured JSON', description: 'Switch the orchestrator logger to newline-delimited JSON.', acceptance: '1. One JSON object per line', assignee: 'writer2',
  why: 'Log lines are hard to grep; structured output also feeds the usage page.', by: { kind: 'agent', agent: 'director' } }));
tx(db, () => createTask(db, { title: 'Prune stale workspaces', assignee: 'worker', by: { kind: 'user' } }));
const old = mk('Rename #general topic', 'writer2'); status(old.task_id, 'cancelled');

// spawn_worker approval (Approve enabled: only 2 of 3 worker slots used)
const spawnThread = createThread(db, 'Need a tester', { kind: 'agent', agent: 'director' });
insertMessage(db, { thread: spawnThread, authorKind: 'user', body: 'The retry work needs someone to write the tests.' });
const payload = { action: 'spawn_worker', name: 'tester', model: 'sonnet', skill_note: 'Writes and runs unit tests; reports flaky cases.', daily_usd: 2, daily_jobs: 10 };
db.prepare(`INSERT INTO approvals(kind, requested_by_agent_id, thread_id, summary, payload, payload_hash, created_at, expires_at)
            VALUES ('spend','director',?,?,?,?,?,?)`).run(spawnThread, 'Retry work needs dedicated test coverage', JSON.stringify(payload), 'h-spawn', ago(12), now + 86_400_000);
// help request to the user
const helpT = db.prepare(`SELECT thread_id FROM tasks WHERE id=?`).get(flaky.task_id) as { thread_id: number };
db.prepare(`UPDATE tasks SET status='blocked', blocked_reason='help' WHERE id=?`).run(flaky.task_id);
insertMessage(db, { thread: helpT.thread_id, authorKind: 'agent', agent: 'director', kind: 'help', mentions: ['user'],
  body: 'worker is blocked on T-' + flaky.task_id + ': the date test needs a fixed clock. Should I freeze time with a fake timer, or change the CI timezone?' });

// chat: realistic threads with code
const t1 = createThread(db, 'Retry on 429', { kind: 'user' });
insertMessage(db, { thread: t1, authorKind: 'user', body: '@director the API client keeps hitting 429s. Can we retry with backoff? Something like `withRetry(fn, { attempts: 3 })`.', mentions: ['director'], wakes: true });
insertMessage(db, { thread: t1, authorKind: 'agent', agent: 'director', body: 'On it. I opened T-' + retry.task_id + ' for worker. The helper will look like this:\n\n```ts\nexport async function withRetry<T>(fn: () => Promise<T>, o = { attempts: 3, base: 200 }) {\n  for (let i = 0; ; i++) {\n    try { return await fn(); }\n    catch (e: any) {\n      if (i + 1 >= o.attempts || ![429, 503].includes(e.status)) throw e;\n      await sleep(o.base * 2 ** i * (0.5 + Math.random()));\n    }\n  }\n}\n```\nI will ask worker to cover it with fake timers.' });
const t0 = createThread(db, 'Daily summary', { kind: 'agent', agent: 'director' });
insertMessage(db, { thread: t0, authorKind: 'agent', agent: 'director', body: 'Morning. Three tasks are moving: T-' + retry.task_id + ' is in progress, T-' + killsw.task_id + ' waits for review, and one proposal needs you. Config snippet I plan to use:\n\n```json\n{ "retry": { "attempts": 3, "baseMs": 200 } }\n```' });
const t2 = createThread(db, 'Release notes', { kind: 'user' });
insertMessage(db, { thread: t2, authorKind: 'user', body: 'Can writer2 draft the v0.4 notes? Keep it to `Added` / `Fixed` sections.', mentions: ['writer2'], wakes: true });
insertMessage(db, { thread: t2, authorKind: 'agent', agent: 'writer2', body: 'Draft is in CHANGELOG.md. Two entries need a link to the PR, I left TODO markers.' });
const t3 = createThread(db, 'Why is the board empty?', { kind: 'user' });
insertMessage(db, { thread: t3, authorKind: 'user', body: 'Run `npm run doctor` and paste the output when it fails.' });
insertMessage(db, { thread: t3, authorKind: 'agent', agent: 'director', body: 'All required checks passed. The board had no tasks until you created T-' + retry.task_id + '.' });

// the in-progress task thread: a short conversation + system lines + a code message (opened in the thread pane)
const th = (db.prepare(`SELECT thread_id FROM tasks WHERE id=?`).get(retry.task_id) as { thread_id: number }).thread_id;
insertMessage(db, { thread: th, authorKind: 'agent', agent: 'director', body: 'Assigned to worker. Scope: client only, no server changes.' });
insertMessage(db, { thread: th, authorKind: 'agent', agent: 'worker', kind: 'status', body: 'Reading src/api/client.ts. `request()` is the single entry point, so one wrapper is enough.' });
systemMessage(db, th, 'worker started a work run (attempt 1/3).');
insertMessage(db, { thread: th, authorKind: 'agent', agent: 'worker', body: 'Draft wrapper:\n\n```ts\nconst res = await withRetry(() => http.get(url), { attempts: 3, base: 200 });\n```\nI am adding tests with fake timers now.' });
insertMessage(db, { thread: th, authorKind: 'user', body: 'Please keep the jitter between 0.5x and 1.5x.' });

// presence + realistic timestamps
db.prepare(`UPDATE agents SET presence='working', presence_detail='Edit src/api/client.ts' WHERE id='worker'`).run();
db.prepare(`UPDATE agents SET presence='idle', presence_detail=NULL WHERE id='writer2'`).run();
let off = 60;
for (const r of db.prepare(`SELECT id FROM messages ORDER BY id`).all() as { id: number }[]) { db.prepare(`UPDATE messages SET created_at=? WHERE id=?`).run(ago(off), r.id); off = Math.max(1, off - 2); }
db.prepare(`UPDATE threads SET created_at=(SELECT min(m.created_at) FROM messages m WHERE m.thread_id=threads.id) WHERE EXISTS (SELECT 1 FROM messages m WHERE m.thread_id=threads.id)`).run();
db.prepare(`UPDATE threads SET created_at=created_at-10800000 WHERE id IN (SELECT thread_id FROM tasks)`).run();      // task threads older than the chat threads
console.log(JSON.stringify({ retry: retry.task_id, thread: th, chat: t1 }));
