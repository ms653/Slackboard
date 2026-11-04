import { splitHighlightedLines, escapeHtml, type DiffHunk, type DiffLine } from './domain/diff';

/** Highlighting (PHASE2 §T8): highlight.js core + 9 grammars, imported only when the diff view opens. hljs escapes its input; this is the only raw-HTML source. */
const GRAMMARS: Record<string, () => Promise<any>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};
const EXT: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json',
  md: 'markdown', markdown: 'markdown', css: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', py: 'python', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml' };

/** Language by file extension; null = render plain. */
export function languageFor(path: string): string | null {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? EXT[m[1]] ?? null : null;
}

export interface Highlighter { highlight(lang: string, code: string): string }
let core: Promise<any> | null = null;
export function loadHighlighter(): Promise<Highlighter> {
  core ??= (async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    await Promise.all(Object.entries(GRAMMARS).map(async ([name, load]) => { const m = await load(); hljs.registerLanguage(name, m.default ?? m); }));
    return hljs;
  })();
  return core.then((hljs) => ({ highlight: (lang, code) => hljs.highlight(code, { language: lang, ignoreIllegals: true }).value }));
}

export interface HunkHtml { old: Map<DiffLine, string>; new: Map<DiffLine, string> }
/** Highlight each hunk side as one block (so multi-line comments/strings stay right), then split into per-line balanced HTML. */
export function highlightHunk(h: Highlighter, lang: string, hunk: DiffHunk): HunkHtml {
  const side = (keep: (l: DiffLine) => boolean) => {
    const ls = hunk.lines.filter(keep);
    const m = new Map<DiffLine, string>();
    let parts: string[] = [];
    try { parts = splitHighlightedLines(h.highlight(lang, ls.map((l) => l.text).join('\n'))); } catch { parts = []; }
    ls.forEach((l, i) => m.set(l, parts.length === ls.length ? parts[i] : escapeHtml(l.text)));
    return m;
  };
  return { old: side((l) => l.type === 'del' || l.type === 'ctx'), new: side((l) => l.type === 'add' || l.type === 'ctx') };
}
