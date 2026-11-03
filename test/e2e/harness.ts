import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { openDb, tx, type DB } from '@/lib/db';

export const REPO = path.resolve(__dirname, '../..');
export const FAKE = path.join(REPO, 'test/fake-claude/claude');

export class Env {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  orch: ChildProcess | null = null; logs = '';
  db!: DB;
  constructor(public script?: Record<string, unknown>) {
    process.env.SLACKBOARD_HOME = this.home;
    if (script) fs.writeFileSync(path.join(this.home, 'script.json'), JSON.stringify(script));
    this.db = openDb();
  }
  env() {
    return { ...process.env, SLACKBOARD_HOME: this.home, SLACKBOARD_CLAUDE_BIN: FAKE, SLACKBOARD_REPO: REPO, SB_BACKOFF_SCALE: '0.01',
      ...(this.script ? { SB_FAKE_SCRIPT: path.join(this.home, 'script.json') } : {}) };
  }
  start() {
    this.orch = spawn(process.execPath, [path.join(REPO, 'dist/orchestrator/main.js')], { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.orch.stdout!.on('data', (d) => (this.logs += d)); this.orch.stderr!.on('data', (d) => (this.logs += d));
    return this.orch;
  }
  async stop(sig: NodeJS.Signals = 'SIGTERM') {
    if (!this.orch) return;
    const o = this.orch; this.orch = null;
    await new Promise<void>((r) => { o.on('exit', () => r()); o.kill(sig); });
  }
  tx<T>(fn: () => T) { return tx(this.db, fn); }
  async until(fn: () => any, ms = 30000, what = 'condition'): Promise<any> {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`timeout waiting for ${what}\n--- orchestrator log ---\n${this.logs.slice(-3000)}`);
  }
  q<T = any>(sql: string, ...p: unknown[]) { return this.db.prepare(sql).all(...p) as T[]; }
  one<T = any>(sql: string, ...p: unknown[]): T { return this.db.prepare(sql).get(...p) as T; }
}
