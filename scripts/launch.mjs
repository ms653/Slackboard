#!/usr/bin/env node
// npm start: orchestrator + Next.js on 127.0.0.1 (TECH §1). Both share ~/.slackboard/slackboard.db.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || '3000';
if (!existsSync(path.join(repo, 'dist/orchestrator/main.js')) || !existsSync(path.join(repo, '.next/BUILD_ID'))) {
  console.error('Build first: npm run build'); process.exit(1);
}
const env = { ...process.env, SLACKBOARD_REPO: repo, SB_SESSION_TOKEN: randomBytes(24).toString('hex') };
const procs = [
  spawn(process.execPath, [path.join(repo, 'dist/orchestrator/main.js')], { cwd: repo, env, stdio: 'inherit' }),
  spawn(process.execPath, [path.join(repo, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', port], { cwd: repo, env, stdio: 'inherit' }),
];
console.log(`Slackboard: http://127.0.0.1:${port}`);
let stopping = false;
const stop = (code = 0) => { if (stopping) return; stopping = true; for (const p of procs) p.kill('SIGTERM'); setTimeout(() => process.exit(code), 4000).unref(); };
for (const p of procs) p.on('exit', (c) => { if (!stopping) { console.error(`${p === procs[0] ? 'orchestrator' : 'next'} exited (${c}); stopping`); stop(c ?? 1); } });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
