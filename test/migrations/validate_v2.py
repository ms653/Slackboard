# Phase 2 migration validator (referenced from docs/PHASE2.md §T1 and §T9; release gate).
# Copied verbatim from the Phase 2 authoring scratchpad; executed green: sqlite 3.53.1 / OK: migration 2 validated.
"""Validate docs/PHASE2.md MIGRATION 2 against lib/db/schema.ts SCHEMA_SQL.
Usage: python3 -I validate_v2.py /home/user/Slackboard
"""
import json, re, sqlite3, sys, pathlib

repo = pathlib.Path(sys.argv[1])
ts = (repo / 'lib/db/schema.ts').read_text()
m = re.search(r'export const SCHEMA_SQL = ("(?:[^"\\]|\\.)*");', ts, re.S)
schema = json.loads(m.group(1))
doc = (repo / 'docs/PHASE2.md').read_text()
mig = re.search(r'-- MIGRATION 2 BEGIN\n(.*?)-- MIGRATION 2 END', doc, re.S).group(1)

db = sqlite3.connect(':memory:', isolation_level=None)
db.execute('PRAGMA foreign_keys = ON')
print('sqlite', sqlite3.sqlite_version)

def tx(sql):
    db.execute('BEGIN IMMEDIATE')
    try:
        for stmt in split(sql): db.execute(stmt)
        db.execute('COMMIT')
    except Exception:
        db.execute('ROLLBACK'); raise

def split(sql):
    out, buf = [], ''
    for line in sql.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip() and not all(l.strip().startswith('--') or not l.strip() for l in buf.splitlines()):
                out.append(buf)
            buf = ''
    return out

# v1 schema + seeds + data
tx(schema)
T = 1
db.execute("INSERT INTO channels(name, created_at) VALUES ('general', 1)")
tools = json.dumps(['Read'])
db.execute("INSERT INTO agents(id, display_name, role, allowed_tools, created_at) VALUES ('director','D','director',?,1)", (tools,))
db.execute("INSERT INTO agents(id, display_name, role, allowed_tools, created_at) VALUES ('worker','W','worker',?,1)", (tools,))
db.execute("INSERT INTO threads(channel_id, title, created_by_kind, created_at) VALUES (1,'t','user',1)")
db.execute("INSERT INTO tasks(title,status,assignee_agent_id,thread_id,created_by_kind,created_at,updated_at) VALUES ('x','todo','worker',1,'user',1,1)")
db.execute("INSERT INTO jobs(agent_id, kind, thread_id, task_id, run_after, budget_cap_usd, created_at) VALUES ('worker','work',1,1,1,1.0,1)")
for i in range(3):
    db.execute("INSERT INTO tool_calls(job_id, agent_id, tool, input_hash, input, outcome, result, created_at) VALUES (1,'worker','add_note',?, '{}','ok','{}',1)", (f'h{i}',))
db.execute("INSERT INTO artifacts(task_id, review_cycle, review_round, base_commit, head_commit, diff_path, files, lines_added, lines_removed, created_at) VALUES (1,0,1,'a','b','/x', ?, 1, 0, 1)",
           (json.dumps([{'path': 'docs/A.md', 'added': 1, 'removed': 0}]),))
# v1 blocked tasks (explicit ids so later fixtures keep ids 1..n)
for tid, reason in ((10, 'help'), (11, 'job_failed'), (12, 'killed')):
    # tasks.thread_id is UNIQUE: each fixture task gets its own thread (explicit ids keep later thread ids unchanged)
    db.execute("INSERT INTO threads(id, channel_id, title, created_by_kind, created_at) VALUES (?,1,'b','user',1)", (tid,))
    db.execute("INSERT INTO tasks(id,title,status,blocked_reason,assignee_agent_id,thread_id,created_by_kind,created_at,updated_at) VALUES (?,'b','blocked',?,'worker',?,'user',1,1)", (tid, reason, tid))
db.execute('PRAGMA user_version = 1')

tx(mig)
assert db.execute('PRAGMA user_version').fetchone()[0] == 2
# help_agent_id backfill: v1 help always went to the director
assert db.execute('SELECT id, help_agent_id FROM tasks WHERE id IN (1,10,11,12) ORDER BY id').fetchall() == \
    [(1, None), (10, 'director'), (11, 'director'), (12, None)]
assert db.execute('SELECT count(*) FROM tool_calls').fetchone()[0] == 3
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'

def aborts(sql, args=(), code=None):
    try:
        db.execute(sql, args)
    except sqlite3.DatabaseError as e:
        assert code is None or code in str(e), (code, str(e)); return
    raise AssertionError('expected abort: ' + sql)

ins_agent = "INSERT INTO agents(id, display_name, role, allowed_tools, created_at, skill_note, spawn_approval_id) VALUES (?,?,'worker',?,1,?,?)"
# spawn gate
aborts(ins_agent, ('w2', 'w2', tools, 'docs', 999), 'approval_required')
p = json.dumps({'action': 'spawn_worker', 'name': 'w2', 'skill_note': 'docs', 'model': 'sonnet', 'daily_usd': 1, 'daily_jobs': 10})
db.execute("INSERT INTO approvals(kind, requested_by_agent_id, thread_id, summary, payload, payload_hash, created_at, expires_at) VALUES ('spend','director',1,'s',?,'h',1,2)", (p,))
aid = db.execute('SELECT max(id) FROM approvals').fetchone()[0]
aborts("INSERT INTO approvals(kind, requested_by_agent_id, thread_id, summary, payload, payload_hash, created_at, expires_at) VALUES ('spend','director',1,'s',?,'h',1,2)", (p,), 'UNIQUE')
aborts(ins_agent, ('w2', 'w2', tools, 'docs', aid), 'approval_required')  # still pending
db.execute('BEGIN')
db.execute("UPDATE approvals SET status='approved', decided_by='user', decided_at=2 WHERE id=?", (aid,))
aborts(ins_agent, ('w2', 'w2', tools, 'other', aid), 'approval_required')  # skill mismatch
db.execute(ins_agent, ('w2', 'w2', tools, 'docs', aid))
db.execute("INSERT INTO budgets(scope, agent_id, period, limit_usd, limit_jobs, updated_at) VALUES ('agent','w2','day',1.0,10,2)")
db.execute("UPDATE approvals SET status='consumed', consumed_at=2 WHERE id=?", (aid,))
db.execute('COMMIT')
db.execute(ins_agent, ('w3', 'w3', tools, None, None))
aborts(ins_agent, ('w4', 'w4', tools, None, None), 'worker_cap')

# assignee triggers
db.execute("INSERT INTO threads(id, channel_id, title, created_by_kind, created_at) VALUES (2,1,'t2','user',1)")
aborts("INSERT INTO tasks(title,status,assignee_agent_id,thread_id,created_by_kind,created_at,updated_at) VALUES ('y','todo','director',2,'user',1,1)", code='assignee_not_active_worker')
db.execute("INSERT INTO tasks(id,title,status,assignee_agent_id,thread_id,created_by_kind,created_at,updated_at) VALUES (2,'y','todo','w3',2,'user',1,1)")

# retire gate
aborts("UPDATE agents SET retired_at=5 WHERE id='w3'", code='retire_invalid')              # enabled still 1
aborts("UPDATE agents SET retired_at=5, enabled=0 WHERE id='w3'", code='agent_has_open_tasks')
aborts("UPDATE agents SET retired_at=5, enabled=0 WHERE id='director'", code='retire_invalid')
aborts("UPDATE agents SET retired_at=5, enabled=0 WHERE id='worker'", code='agent_has_open_tasks')
db.execute("UPDATE agents SET retired_at=5, enabled=0 WHERE id='w2'")
aborts("UPDATE agents SET enabled=1 WHERE id='w2'", code='agent_retired')
aborts("UPDATE agents SET retired_at=NULL WHERE id='w2'", code='agent_retired')
aborts("UPDATE tasks SET assignee_agent_id='w2' WHERE id=2", code='assignee_not_active_worker')
db.execute(ins_agent, ('w4', 'w4', tools, None, None))  # slot freed by retirement

# help_agent scope
aborts("UPDATE tasks SET help_agent_id='w3' WHERE id=1", code='help_agent_outside_help')
db.execute("UPDATE tasks SET status='blocked', blocked_reason='help', help_agent_id='w3' WHERE id=1")
db.execute("UPDATE tasks SET blocked_reason='job_failed' WHERE id=1")
aborts("UPDATE tasks SET status='todo', blocked_reason=NULL WHERE id=1", code='help_agent_outside_help')
db.execute("UPDATE tasks SET status='todo', blocked_reason=NULL, help_agent_id=NULL WHERE id=1")

# notes anchors
aborts("INSERT INTO notes(task_id, body, created_at, artifact_id) VALUES (1,'c',1,1)", code='anchor_incomplete')
aborts("INSERT INTO notes(task_id, body, created_at, artifact_id, path, line, side) VALUES (1,'c',1,1,'nope.md',1,'new')", code='anchor_not_in_artifact')
aborts("INSERT INTO notes(task_id, body, created_at, artifact_id, path, line, side) VALUES (2,'c',1,1,'docs/A.md',1,'new')", code='anchor_not_in_artifact')
aborts("INSERT INTO notes(task_id, body, created_at, artifact_id, path, line, side) VALUES (1,'c',1,1,'docs/A.md',0,'new')", code='CHECK')
db.execute("INSERT INTO notes(task_id, body, created_at, artifact_id, path, line, side) VALUES (1,'c',1,1,'docs/A.md',1,'new')")
db.execute("INSERT INTO notes(task_id, body, created_at) VALUES (1,'plain',1)")
aborts("UPDATE notes SET body='x' WHERE id=1", code='notes_immutable')

# tool_calls CHECK
db.execute("INSERT INTO tool_calls(job_id, agent_id, tool, input_hash, input, outcome, result, created_at) VALUES (1,'director','spawn_worker','z','{}','ok','{}',1)")
aborts("INSERT INTO tool_calls(job_id, agent_id, tool, input_hash, input, outcome, result, created_at) VALUES (1,'director','foo','y','{}','ok','{}',1)", code='CHECK')

# fresh-DB path: v1 + v2 back to back
db2 = sqlite3.connect(':memory:', isolation_level=None); db2.execute('PRAGMA foreign_keys = ON')
db2.executescript(schema); db2.executescript(mig)
assert db2.execute('PRAGMA user_version').fetchone()[0] == 2
print('OK: migration 2 validated')
