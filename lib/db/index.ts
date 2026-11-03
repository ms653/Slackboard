import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';
import { paths, ensureDir, dataDir } from '../paths';
import { now } from '../util';

export type DB = Database.Database;

/** TECH §2: pragmas run on every connection, outside any transaction, before anything else. */
export function openDb(file: string = paths.db()): DB {
  if (file !== ':memory:') ensureDir(dataDir());
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

const DIRECTOR_TOOLS = ['Read', 'Glob', 'Grep', 'post_message', 'create_task', 'update_task', 'add_note', 'request_help', 'request_approval'];
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'post_message', 'update_task', 'add_note', 'request_help'];

/** DDL, seeds and user_version in one transaction (TECH §2). Idempotent. */
export function migrate(db: DB): void {
  const v = db.pragma('user_version', { simple: true }) as number;
  if (v >= 1) return;
  const t = now();
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(`INSERT INTO channels(name, created_at) VALUES ('general', ?)`).run(t);
    const ins = db.prepare(`INSERT INTO agents(id, display_name, role, model, max_turns, max_budget_usd, allowed_tools, created_at)
                            VALUES (?,?,?,?,?,?,?,?)`);
    ins.run('director', 'Director', 'director', 'sonnet', 8, 0.40, JSON.stringify(DIRECTOR_TOOLS), t);
    ins.run('worker', 'Worker', 'worker', 'sonnet', 15, 1.00, JSON.stringify(WORKER_TOOLS), t);
    db.prepare(`INSERT INTO budgets(scope, period, limit_usd, limit_jobs, updated_at) VALUES ('global','day',5.00,60,?)`).run(t);
    db.prepare(`INSERT INTO budgets(scope, period, limit_usd, limit_jobs, updated_at) VALUES ('global','rolling_5h',NULL,25,?)`).run(t);
    db.pragma('user_version = 1');
  })();
}

let shared: DB | null = null;
/** Process-wide connection (Next.js route handlers, orchestrator). */
export function db(): DB {
  if (!shared) shared = openDb();
  return shared;
}
export function setDbForTests(d: DB | null): void { shared = d; }

/** BEGIN IMMEDIATE transaction helper (TECH §3: all guards inside one IMMEDIATE txn). */
export function tx<T>(d: DB, fn: () => T): T {
  return d.transaction(fn).immediate();
}
