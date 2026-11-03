import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir } from '../paths';

/** All git calls: GIT_DIR outside the tree, hooks off, fixed args via execFile (TECH §4). */
function git(taskId: number, args: string[], opts: { allowFail?: boolean } = {}): { code: number; out: string } {
  const full = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Slackboard', '-c', 'user.email=slackboard@localhost',
    '-c', 'commit.gpgsign=false', '-c', 'core.excludesFile=/dev/null',
    `--git-dir=${paths.gitDir(taskId)}`, `--work-tree=${paths.workspace(taskId)}`, ...args];
  try {
    const out = execFileSync('git', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out };
  } catch (e: any) {
    if (opts.allowFail) return { code: e.status ?? 1, out: String(e.stdout ?? '') };
    throw new Error(`git ${args[0]} failed: ${e.stderr || e.message}`);
  }
}

/** Idempotent workspace init (git init + empty initial commit). Returns base commit. */
export function ensureWorkspace(taskId: number): string {
  ensureDir(paths.workspace(taskId));
  ensureDir(path.dirname(paths.gitDir(taskId)));
  if (!fs.existsSync(path.join(paths.gitDir(taskId), 'HEAD'))) git(taskId, ['init', '-q', '-b', 'main']);
  const h = git(taskId, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  if (h.code === 0) return h.out.trim();
  git(taskId, ['commit', '-q', '--allow-empty', '-m', `T-${taskId} base`]);
  return git(taskId, ['rev-parse', 'HEAD']).out.trim();
}

export interface WorkspaceFacts { clean: boolean; head: string | null }
/** Read-only facts used by resumeTarget / J2 / T13 (computed outside the write txn). */
export function workspaceFacts(taskId: number): WorkspaceFacts {
  if (!fs.existsSync(path.join(paths.gitDir(taskId), 'HEAD'))) return { clean: true, head: null };
  const st = git(taskId, ['status', '--porcelain', '--untracked-files=all'], { allowFail: true });
  const h = git(taskId, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return { clean: st.code === 0 && st.out.trim() === '', head: h.code === 0 ? h.out.trim() : null };
}

/** workspaceChanged(task): git add -A, then diff --cached --quiet <lastHead> exits 1 (TECH §3.1 round terms). */
export function workspaceChanged(taskId: number, lastHead: string): boolean {
  ensureWorkspace(taskId);
  git(taskId, ['add', '-A', '--force']);
  return git(taskId, ['diff', '--cached', '--quiet', lastHead], { allowFail: true }).code === 1;
}

export interface Capture { head: string; diff: string; files: { path: string; added: number; removed: number }[]; added: number; removed: number }
/** Artifact capture (TECH §5.11): commit, numstat and full diff vs base. Repeatable (commit --allow-empty). */
export function captureRound(taskId: number, base: string, round: number): Capture {
  git(taskId, ['add', '-A', '--force']);
  git(taskId, ['commit', '-q', '--allow-empty', '-m', `T-${taskId} round ${round}`]);
  const head = git(taskId, ['rev-parse', 'HEAD']).out.trim();
  const num = git(taskId, ['diff', '--numstat', base, head]).out.trim();
  const files = num ? num.split('\n').map((l) => {
    const [a, r, ...p] = l.split('\t');
    return { path: p.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 };
  }) : [];
  const diff = git(taskId, ['diff', base, head]).out;
  return { head, diff, files, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) };
}
