import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []);

/** Body of the block opened by the first `{` after `start` (balanced). */
function block(css: string, start: string): string {
  const i = css.indexOf(start); expect(i).toBeGreaterThan(-1);
  let depth = 0, j = css.indexOf('{', i);
  const open = j;
  for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) break; }
  return css.slice(open + 1, j);
}
const decls = (b: string) => b.replace(/\/\*.*?\*\//g, '').split(';').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);

describe('DESIGN.md tokens', () => {
  const css = read('app/globals.css');
  it('dark token blocks (:root.dark and the media query) are identical', () => {
    const a = decls(block(css, ':root.dark'));
    const m = decls(block(block(css, '@media (prefers-color-scheme: dark)'), ':root:not(.light)'));
    expect(a.length).toBeGreaterThan(30);
    expect(m).toEqual(a);
  });
  it('light and dark define the same variables', () => {
    const names = (b: string) => decls(b).flatMap((d) => d.match(/--[a-z-]+(?=:)/g) ?? []).sort();
    expect(names(block(css, ':root.dark'))).toEqual(names(block(css, ':root {')));
  });
  it('focus ring uses the accent token and reduced motion is honoured', () => {
    expect(css).toContain('outline: 2px solid rgb(var(--accent))');
    expect(css).not.toContain('#38bdf8');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
  it('lucide-react is pinned exactly', () => {
    expect(JSON.parse(read('package.json')).dependencies['lucide-react']).toBe('0.468.0');
  });
  it('layout has no hard-coded dark class and sets the token body', () => {
    const l = read('app/layout.tsx');
    expect(l).not.toMatch(/className="dark"/);
    expect(l).toContain('bg-window text-fg-primary');
  });
});

describe('components use tokens and line icons', () => {
  const files = [...walk('components'), 'app/layout.tsx'];
  it('no hard-coded palette classes', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/\b(?:bg|text|border|ring|outline|divide)-(?:slate|sky|rose|amber|emerald|violet|zinc|gray)-\d/);
  });
  it('no unicode glyph icons in UI markup', () => {
    for (const f of files) {
      const src = read(f).split('\n').filter((l) => !l.trim().startsWith('//') && !l.includes('/**') && !l.trim().startsWith('*') && !l.includes("'⟲': [")).join('\n');
      expect(src, f).not.toMatch(/[▸▾⚙■✕✓⏸⊘◔◐◇⟲↳└⚑⤢⤡↺●○]/);
    }
  });
  it('Icon wrapper is aria-hidden', () => {
    const ui = read('components/ui.tsx');
    expect(ui).toMatch(/export function Icon[\s\S]*aria-hidden[\s\S]*strokeWidth=\{size <= 14 \? 1\.75 : 1\.5\}/);
  });
});
