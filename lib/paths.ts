import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Runtime data dir (TECH §4). Overridable for tests/e2e via SLACKBOARD_HOME. Outside the repo on purpose. */
export function dataDir(): string {
  return process.env.SLACKBOARD_HOME || path.join(os.homedir(), '.slackboard');
}
export const paths = {
  db: () => path.join(dataDir(), 'slackboard.db'),
  controlToken: () => path.join(dataDir(), 'control.token'),
  agentDir: (agentId: string) => path.join(dataDir(), 'agents', agentId),
  workspace: (taskId: number) => path.join(dataDir(), 'workspaces', `T-${taskId}`),
  gitDir: (taskId: number) => path.join(dataDir(), 'git', `T-${taskId}.git`),
  runDir: (jobId: number) => path.join(dataDir(), 'runs', String(jobId)),
  doctorDir: () => path.join(dataDir(), 'doctor'),
};
export function ensureDir(p: string, mode = 0o700): string {
  fs.mkdirSync(p, { recursive: true, mode });
  return p;
}
/** Repo root: the orchestrator bundle lives in dist/orchestrator, Next in .next; launch passes SLACKBOARD_REPO. */
export function repoRoot(): string {
  return process.env.SLACKBOARD_REPO || process.cwd();
}
