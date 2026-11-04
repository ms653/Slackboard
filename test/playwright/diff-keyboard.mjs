// Keyboard-only check of the diff view (PHASE2 §T9). Usage: node test/playwright/diff-keyboard.mjs  (needs a prior `npm run build`)
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pw-'));
const env = { ...process.env, SLACKBOARD_HOME: home, SB_SESSION_TOKEN: 'pw-token' };
const bundle = path.join(REPO, 'dist/pw-seed.cjs');
execFileSync(path.join(REPO, 'node_modules/.bin/esbuild'), [path.join(REPO, 'test/playwright/seed.ts'), '--bundle', '--platform=node', '--external:better-sqlite3', `--outfile=${bundle}`, '--log-level=error'], { cwd: REPO });
const seeded = JSON.parse(execFileSync(process.execPath, [bundle], { cwd: REPO, env, encoding: 'utf8' }).trim().split('\n').pop());
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const srv = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
console.log('next pid', srv.pid);
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
let browser;
const cleanup = async () => { try { await browser?.close(); } catch {} try { process.kill(srv.pid, 'SIGTERM'); } catch {} };
try {
  for (let i = 0; i < 200 && !/Ready|started server/i.test(log); i++) await new Promise((r) => setTimeout(r, 300));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(() => { try { localStorage.removeItem('sb.diffView'); } catch {} });
  await page.goto(`http://127.0.0.1:${port}/`);
  const dbq = (sql, ...p) => { const d = new Database(path.join(home, 'slackboard.db'), { readonly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
  const dbfile = fs.readdirSync(home).find((f) => f.endsWith('.db')); assert.ok(dbfile, 'db file'); 
  const q = (sql, ...p) => { const d = new Database(path.join(home, dbfile), { readonly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
  void dbq;
  await page.locator('nav[aria-label="Workspace"]').waitFor(); await page.waitForTimeout(500);
  await page.keyboard.press('g'); await page.keyboard.press('b');
  const card = page.locator('[data-task-card]').first(); await card.waitFor();
  await card.focus();
  const same = async (what) => assert.ok(await page.evaluate(() => document.activeElement?.closest('aside[aria-label="Detail"]') !== null), `focus inside pane: ${what}`);
  const live = () => page.locator('aside [role="status"].sr-only').first().innerText();
  const active = (sel) => page.evaluate((s) => !!document.activeElement?.matches(s), sel);

  await card.evaluate((e) => { e.__tag = 1; });
  await page.keyboard.press('d');
  await page.locator('aside h2:has-text("Review · T-")').waitFor();
  assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('aside[aria-label="Detail"] h2')), 'focus on the review heading after d');
  // n x2 -> Hunk 2 of 3
  await page.keyboard.press('n'); await page.keyboard.press('n');
  assert.match(await live(), /^Hunk 2 of 3, docs\/INSTALL\.md, lines 30 to 32$/);
  assert.ok(await active('[data-hunk-heading][data-hunk="2"]'));
  // c on the heading comments on the hunk's first line (context -> new side)
  await page.keyboard.press('c');
  const ta = page.locator('textarea'); await ta.waitFor();
  assert.equal(await page.locator('label[for^="cc-"]').innerText(), 'Comment on new line 30 of docs/INSTALL.md');
  assert.ok(await ta.evaluate((e) => document.activeElement === e));
  await page.keyboard.type('kb comment one'); await page.keyboard.press('Control+Enter');
  await page.locator('[role="note"]:has-text("kb comment one")').waitFor();
  assert.ok(await active('[data-hunk-heading][data-hunk="2"]'), 'focus returned to the invoking heading');
  assert.deepEqual(q(`SELECT side, line, author_agent_id FROM notes WHERE body='kb comment one'`), [{ side: 'new', line: 30, author_agent_id: null }]);
  assert.match(await page.locator('[role="note"]:has-text("kb comment one")').innerText(), /Will be sent with the worker's next run/);
  // unified: c on a removed line anchors old; on a context line anchors new
  await page.keyboard.press('p'); await page.keyboard.press('Tab');          // first cell of hunk 1 (context line 10)
  assert.ok(await active('[data-cell]'));
  await page.keyboard.press('ArrowDown');                                   // removed line 11
  assert.match(await page.evaluate(() => document.activeElement.innerText), /removed line 11/);
  await page.keyboard.press('c');
  assert.equal(await page.locator('label[for^="cc-"]').innerText(), 'Comment on old line 11 of docs/INSTALL.md');
  await page.keyboard.type('old side'); await page.keyboard.press('Control+Enter');
  await page.locator('[role="note"][aria-label="Comment by you on old line 11"]').waitFor();
  assert.ok(await active('[data-cell]'), 'focus back on the line');
  assert.deepEqual(q(`SELECT side, line FROM notes WHERE body='old side'`), [{ side: 'old', line: 11 }]);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('c');
  assert.equal(await page.locator('label[for^="cc-"]').innerText(), 'Comment on new line 10 of docs/INSTALL.md');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('textarea').count(), 0); assert.ok(await active('[data-cell]'), 'Esc returns focus to the line');
  assert.ok(await page.locator('aside h2').isVisible(), 'Esc in the textarea did not close the pane');
  // side by side needs Expand at this width
  assert.ok(await page.locator('input[name="dv-view"]').nth(1).isDisabled());
  assert.match(await page.locator('#dv-split-reason').innerText(), /needs Expand|needs a window at least 900 px wide/);
  await page.keyboard.press('x');
  assert.equal(await page.locator('button[aria-expanded="true"]').count(), 1);
  await page.waitForFunction(() => document.activeElement === document.querySelector('aside[aria-label="Detail"] h2'), null, { timeout: 3000 });   // expand moves focus to the heading
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await page.waitForFunction(() => !document.querySelectorAll('input[name="dv-view"]')[1].disabled);
  await page.locator('[data-cell]').first().focus();
  await page.keyboard.press('v');
  await page.locator('table[aria-label^="Side by side"]').first().waitFor();
  assert.ok(await active('[data-cell]'), 'focus kept across v');
  assert.equal(await page.evaluate(() => localStorage.getItem('sb.diffView')), 'split');
  // side by side: focus the new cell of the context row, <- to the old cell, c -> label explains the new-side anchoring
  const ctxNew = page.locator('[data-hunk="1"][data-row="0"][data-side="new"]'); await ctxNew.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.side), 'old');
  await page.keyboard.press('c');
  assert.match(await page.locator('label[for^="cc-"]').innerText(), /^Comment on new line 10 of docs\/INSTALL\.md \(unchanged line; comments on unchanged lines attach to the new side\)$/);
  await page.keyboard.press('Escape');
  // removed row: old cell -> side old
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.dataset.side), 'old');
  assert.match(await page.evaluate(() => document.activeElement.innerText), /old line 11, removed/);
  await page.keyboard.press('c'); assert.equal(await page.locator('label[for^="cc-"]').innerText(), 'Comment on old line 11 of docs/INSTALL.md');
  await page.keyboard.type('split old'); await page.keyboard.press('Control+Enter');
  await page.locator('[role="note"]:has-text("split old")').waitFor();
  assert.deepEqual(q(`SELECT side, line FROM notes WHERE body='split old'`), [{ side: 'old', line: 11 }]);
  // padded cell is skipped: hunk 2's added line has no old cell
  await page.locator('[data-hunk="2"][data-row="1"][data-side="new"]').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await live(), 'no line on this side'); assert.equal(await page.evaluate(() => document.activeElement.dataset.side), 'new');
  // XSS fixture rendered as text in both modes
  assert.equal(await page.evaluate(() => !!document.querySelector('img[src="x"]') || !!document.querySelector('aside script') || window.__xss !== undefined), false);
  assert.ok((await page.locator('[data-file="evil.html"]').innerText()).includes('<img src=x'));
  // axe (split with comments, then unified)
  const axeSrc = fs.readFileSync(path.join(REPO, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.evaluate(axeSrc);
  const runAxe = async (what) => { const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('aside[aria-label="Detail"]'))).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.length}`)); assert.deepEqual(r, [], `axe ${what}`); };
  await runAxe('side by side');
  await page.locator('[data-cell]').first().focus(); await page.keyboard.press('v');
  await page.locator('table[aria-label^="Unified"]').first().waitFor(); await runAxe('unified');
  // Esc collapses (focus -> Expand button), second Esc closes the pane (focus -> opener)
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('button[aria-expanded="true"]').count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Expand'), null, { timeout: 3000 });   // collapse returns focus to Expand
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('aside[aria-label="Detail"]').count(), 0);
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-task-card'), null, { timeout: 3000 });   // pane close returns focus to the card
  // help lists the diff keys
  await page.keyboard.press('?'); assert.ok((await page.locator('[role="dialog"]').innerText()).includes('Diff: n / p'));
  await page.keyboard.press('Escape');
  // narrow window reason
  await page.locator('[data-task-card]').first().focus();
  await page.keyboard.press('d'); await page.locator('aside h2').waitFor();
  await page.setViewportSize({ width: 1000, height: 800 }); await page.waitForTimeout(200);
  assert.match(await page.locator('#dv-split-reason').innerText(), /needs Expand/);
  await page.setViewportSize({ width: 800, height: 800 }); await page.waitForTimeout(300);
  assert.match(await page.locator('#dv-split-reason').innerText(), /needs a window at least 900 px wide/);
  void same;
  console.log('PLAYWRIGHT OK');
} catch (e) { console.error('PLAYWRIGHT FAIL', e); console.error(log.slice(-1500)); process.exitCode = 1; }
finally { await cleanup(); console.log('stopped next pid', srv.pid); }
