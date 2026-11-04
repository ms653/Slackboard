// Visual review shots (docs/DESIGN.md). Usage: npm run build && npm run screenshots   (env SHOTS_DIR overrides the output directory)
// Seeds a temp SLACKBOARD_HOME like diff-keyboard.mjs (seed.ts + seed-shots.ts), serves `next start`, and writes <screen>-<light|dark>.png at 1440x900, deviceScaleFactor 1.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import Database from 'better-sqlite3';

// Playwright module: PLAYWRIGHT_PATH (dir or index file), else `playwright` resolved from the repo / NODE_PATH, else the sandbox's global install.
const req = createRequire(import.meta.url);
const pwCandidates = [process.env.PLAYWRIGHT_PATH, 'playwright', ...(process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'playwright')), '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
let pw; for (const c of pwCandidates) { try { pw = req(c); break; } catch {} }
if (!pw) { console.error('Playwright not found. Set PLAYWRIGHT_PATH to its install directory (tried: ' + pwCandidates.join(', ') + ')'); process.exit(2); }
const { chromium } = pw;
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = process.env.SHOTS_DIR || '/tmp/claude-0/-home-user-Slackboard/7ae489c7-af42-50b9-946e-72df14e867bf/scratchpad/shots';
fs.mkdirSync(OUT, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shots-'));
const env = { ...process.env, SLACKBOARD_HOME: home, SB_SESSION_TOKEN: 'pw-token' };
const seedOut = {};
for (const name of ['seed', 'seed-shots']) {
  const bundle = path.join(REPO, `dist/pw-${name}.cjs`);
  execFileSync(path.join(REPO, 'node_modules/.bin/esbuild'), [path.join(REPO, `test/playwright/${name}.ts`), '--bundle', '--platform=node', '--external:better-sqlite3', `--outfile=${bundle}`, '--log-level=error'], { cwd: REPO });
  seedOut[name] = JSON.parse(execFileSync(process.execPath, [bundle], { cwd: REPO, env, encoding: 'utf8' }).trim().split('\n').pop());
}
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const srv = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
let browser, beat;
// A live-looking orchestrator: fresh heartbeat owned by this (running) process, same identity check as lib/proc (Linux /proc, macOS ps).
const procStart = (pid) => { try { if (process.platform === 'linux') { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' ')[19] ?? null; }
  return execFileSync('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim() || null; } catch { return null; } };
const keepAlive = () => { const d = new Database(path.join(home, 'slackboard.db')); try { d.prepare(`UPDATE system_state SET orchestrator_heartbeat_at=?, orchestrator_pid=?, orchestrator_proc_start=?, doctor_ok_at=? WHERE id=1`).run(Date.now(), process.pid, procStart(process.pid), Date.now()); } finally { d.close(); } };
const cleanup = async () => { clearInterval(beat); try { await browser?.close(); } catch {} try { process.kill(srv.pid, 'SIGTERM'); } catch {} };
const written = [];
try {
  for (let i = 0; i < 200 && !/Ready|started server/i.test(log); i++) await new Promise((r) => setTimeout(r, 300));
  keepAlive(); beat = setInterval(() => { try { keepAlive(); } catch {} }, 2000);       // the orchestrator pill and banner read 'up', like a live system
  const bundled = (() => { try { const p = chromium.executablePath(); return p && fs.existsSync(p) ? p : null; } catch { return null; } })();
  const chrome = process.env.CHROME_PATH || (bundled ? undefined : '/usr/bin/google-chrome');
  browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ['--no-sandbox'] });

  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.removeItem('sb.diffView'); } catch {} });
    const shot = async (name) => { const f = path.join(OUT, `${name}-${scheme}.png`); await page.mouse.move(1, 1); await page.waitForTimeout(350); await page.screenshot({ path: f }); written.push(f); };
    const fresh = async (view, size = { width: 1440, height: 900 }) => {
      await page.setViewportSize(size);
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.locator('#main').waitFor();
      await page.waitForTimeout(700);
      if (view) { await page.keyboard.press('g'); await page.keyboard.press(view); await page.waitForTimeout(250); }
    };
    const openCard = async (title) => { await page.locator(`[data-task-card]:has-text("${title}")`).first().click(); await page.locator('aside[aria-label="Detail"] h2').waitFor(); await page.waitForTimeout(450); };

    await fresh('c'); await page.locator('#chat-h').waitFor(); await shot('chat');
    await fresh('b'); await openCard('Add retry with backoff'); await page.getByRole('button', { name: 'Open thread', exact: true }).click();
    await page.locator('aside h2:has-text("Thread")').waitFor(); await page.waitForTimeout(500); await shot('thread');
    await fresh('b'); await page.locator('[data-board-col]').first().waitFor(); await shot('board');
    await fresh('i'); await shot('inbox');
    await fresh('b'); await openCard('Add retry with backoff'); await shot('task-detail');
    if (scheme === 'light') for (const c of [{ path: 'docs/INSTALL.md', line: 11, side: 'new', body: 'Please also mention the minimum npm version here.' }, { path: 'docs/INSTALL.md', line: 11, side: 'old', body: 'Node 16 is EOL, so dropping it is right.' }])
      await page.evaluate(async ({ id, c }) => { await fetch(`/api/artifacts/${id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }); }, { id: seedOut.seed.artifact_id, c });
    await fresh('b'); await openCard('Write docs'); await page.getByRole('button', { name: /View diff/ }).click();
    await page.locator('table[aria-label^="Unified"]').first().waitFor(); await page.waitForTimeout(700); await shot('diff-unified');
    await page.locator('aside button[aria-expanded]').click(); await page.waitForTimeout(500);
    await page.locator('label:has-text("Side by side")').click();
    await page.locator('table[aria-label^="Side by side"]').first().waitFor(); await page.waitForTimeout(500); await shot('diff-side-by-side');
    await fresh('s'); await page.locator('#set-h').waitFor();
    await page.locator('h3:has-text("Agents (")').scrollIntoViewIfNeeded(); await page.evaluate(() => document.querySelector('#set-h')?.closest('section')?.scrollBy(0, 220)); await shot('settings-agents');
    await fresh('c'); await page.getByRole('button', { name: 'Kill', exact: true }).click(); await page.locator('[role="dialog"]').waitFor(); await shot('dialog');
    await fresh('c'); await page.keyboard.press('Control+k'); await page.locator('[role="dialog"]').waitFor(); await page.keyboard.type('retry'); await shot('quick-switcher');
    await fresh('c', { width: 900, height: 900 }); await shot('chat-narrow');
    await fresh('b', { width: 900, height: 900 }); await openCard('Add retry with backoff'); await shot('task-narrow');
    await fresh('c', { width: 390, height: 844 }); await shot('chat-mobile');
    await ctx.close();
  }
  console.log(written.join('\n'));
} catch (e) { console.error('SHOTS FAIL', e); console.error(log.slice(-1500)); process.exitCode = 1; }
finally { await cleanup(); }
