/** Unified-diff parser, side-by-side pairing, the single anchor rule (PHASE2 §T8, §T6.4). Pure: shared by server and client. */

export interface DiffLine { type: 'add' | 'del' | 'ctx' | 'meta'; oldNo: number | null; newNo: number | null; text: string }
export interface DiffHunk { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; section: string; lines: DiffLine[] }
export interface DiffFile { path: string; oldPath: string; binary: boolean; renamed: boolean; hunks: DiffHunk[] }

const unq = (s: string) => (s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\(["\\])/g, '$1') : s);
const stripPrefix = (s: string) => unq(s).replace(/^[ab]\//, '');

/** Parse `git diff` output. Tolerates a diff cut off at any line (the server truncates at 2,000 lines). */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split('\n');
  let f: DiffFile | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      let a = rest, b = rest;
      const m = rest.match(/^(".*?"|\S+) (".*"|\S+)$/) ?? (() => { const k = rest.indexOf(' b/'); return k > 0 ? [rest, rest.slice(0, k), rest.slice(k + 1)] : null; })();
      if (m) { a = m[1]; b = m[2]; }
      f = { path: stripPrefix(b), oldPath: stripPrefix(a), binary: false, renamed: false, hunks: [] };
      files.push(f); i++; continue;
    }
    if (!f) { i++; continue; }
    if (l.startsWith('rename from ')) { f.oldPath = unq(l.slice(12)); f.renamed = true; i++; continue; }
    if (l.startsWith('rename to ')) { f.path = unq(l.slice(10)); f.renamed = true; i++; continue; }
    if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) { f.binary = true; i++; continue; }
    if (l.startsWith('--- ')) { const p = unq(l.slice(4)); if (p !== '/dev/null') f.oldPath = stripPrefix(p); i++; continue; }
    if (l.startsWith('+++ ')) { const p = unq(l.slice(4)); if (p !== '/dev/null') f.path = stripPrefix(p); else f.path = f.oldPath; i++; continue; }
    const hm = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hm) {
      const h: DiffHunk = { header: l, oldStart: +hm[1], oldCount: hm[2] === undefined ? 1 : +hm[2], newStart: +hm[3], newCount: hm[4] === undefined ? 1 : +hm[4], section: hm[5] ?? '', lines: [] };
      f.hunks.push(h); i++;
      let o = h.oldStart, n = h.newStart, ro = h.oldCount, rn = h.newCount;
      while (i < lines.length && (ro > 0 || rn > 0)) {
        const t = lines[i];
        if (t.startsWith('\\')) { h.lines.push({ type: 'meta', oldNo: null, newNo: null, text: t }); i++; continue; }
        const c = t[0];
        if (c === '+' && rn > 0) { h.lines.push({ type: 'add', oldNo: null, newNo: n++, text: t.slice(1) }); rn--; }
        else if (c === '-' && ro > 0) { h.lines.push({ type: 'del', oldNo: o++, newNo: null, text: t.slice(1) }); ro--; }
        else if ((c === ' ' || t === '') && ro > 0 && rn > 0) { h.lines.push({ type: 'ctx', oldNo: o++, newNo: n++, text: t.slice(1) }); ro--; rn--; }
        else break;
        i++;
      }
      while (i < lines.length && lines[i].startsWith('\\')) { h.lines.push({ type: 'meta', oldNo: null, newNo: null, text: lines[i] }); i++; }
      continue;
    }
    i++;
  }
  return files;
}

export interface SplitRow { old: DiffLine | null; new: DiffLine | null; meta?: DiffLine }
/** Pair each run of `del` with the following run of `add` row by row and pad the shorter side. Context lines occupy both sides. */
export function sideBySide(h: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const ls = h.lines;
  for (let i = 0; i < ls.length;) {
    const l = ls[i];
    if (l.type === 'ctx') { rows.push({ old: l, new: l }); i++; continue; }
    if (l.type === 'meta') {
      const prev = rows[rows.length - 1];
      if (prev) prev.meta = l; else rows.push({ old: null, new: null, meta: l });
      i++; continue;
    }
    const dels: DiffLine[] = [], adds: DiffLine[] = [];
    while (i < ls.length && ls[i].type === 'del') dels.push(ls[i++]);
    while (i < ls.length && ls[i].type === 'add') adds.push(ls[i++]);
    if (!dels.length && !adds.length) { i++; continue; }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ old: dels[k] ?? null, new: adds[k] ?? null });
  }
  return rows;
}

/** THE anchor rule (PHASE2 §T6.4): `new` = an add/ctx line by newNo; `old` = a del line by oldNo only (never a context line). */
export function anchorInDiff(files: DiffFile[], path: string, side: 'old' | 'new', line: number): boolean {
  if (!Number.isInteger(line) || line < 1) return false;
  const f = files.find((x) => x.path === path);
  if (!f) return false;
  return f.hunks.some((h) => h.lines.some((l) => side === 'new' ? (l.type === 'add' || l.type === 'ctx') && l.newNo === line : l.type === 'del' && l.oldNo === line));
}

/** The side a user comment on `line` anchors to: `old` only on a `del` line, otherwise `new` (context lines are never `old`). */
export const anchorSideFor = (line: DiffLine): 'old' | 'new' => line.type === 'del' ? 'old' : 'new';
export const lineNoFor = (line: DiffLine, side: 'old' | 'new'): number | null => side === 'old' ? line.oldNo : line.newNo;

/**
 * Split hljs HTML (only `<span class=…>` / `</span>` and escaped text) into one balanced fragment per line:
 * open spans are closed at each `\n` and reopened on the next line. Only copies of existing tags are inserted.
 */
export function splitHighlightedLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = '';
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (tok === '') continue;
    if (tok === '\n') { cur += '</span>'.repeat(open.length); out.push(cur); cur = open.join(''); }
    else if (tok === '</span>') { open.pop(); cur += tok; }
    else if (tok.startsWith('<span')) { open.push(tok); cur += tok; }
    else cur += tok;
  }
  out.push(cur + '</span>'.repeat(open.length));
  return out;
}

/** Plain-text escape for the (never used with raw diff text) fallback path. */
export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
