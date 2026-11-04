'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, MessageSquare } from 'lucide-react';
import { api } from '../api';
import { Icon } from '../ui';
import { useStore } from '../store';
import { parseUnifiedDiff, anchorInDiff, anchorSideFor, type DiffFile, type DiffHunk, type DiffLine } from '../../lib/domain/diff';
import { languageFor, loadHighlighter, highlightHunk, type Highlighter, type HunkHtml } from '../../lib/highlight';
import { UnifiedHunk, type HunkCtx } from './UnifiedHunk';
import { SplitHunk } from './SplitHunk';
import { CommentItem, CommentComposer, authorOf, type Comment, type ComposerState } from './LineComments';

export type Show = { kind: 'round'; id: number } | { kind: 'compare'; from: number; to: number };
const LIMIT_LINES = 500, PLAIN_OVER = 1000;
const label = (s: any, all: any[]) => all.every((x) => x.cycle === s.cycle) ? `r${s.round}` : `c${s.cycle}r${s.round}`;
const hunkRange = (h: DiffHunk) => h.newCount > 0 ? [h.newStart, h.newStart + h.newCount - 1] : [h.oldStart, h.oldStart + Math.max(h.oldCount, 1) - 1];
const stat = (f: DiffFile) => ({ a: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0), r: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0) });

export function DiffView({ data, show, setShow, reload, expanded, toggleExpand }: { data: any; show: Show; setShow: (s: Show) => void; reload: () => void; expanded: boolean; toggleExpand: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pref, setPref] = useState<'unified' | 'split'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('sb.diffView') === 'split' ? 'split' : 'unified'));
  const [live, setLive] = useState('');
  const [hl, setHl] = useState<Highlighter | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [activeKey, setActive] = useState('');
  const [full, setFull] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [cmp, setCmp] = useState<{ loading: boolean; err?: string; hint?: string; data?: any }>({ loading: false });
  const [pendingFocus, setPendingFocus] = useState<{ path: string; side: 'old' | 'new'; line: number } | null>(null);
  const compare = show.kind === 'compare';

  const [, setWinW] = useState(0);
  useEffect(() => { loadHighlighter().then(setHl, () => {}); const f = () => setWinW(window.innerWidth); f(); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const modeRefocus = useRef(false);
  useEffect(() => {
    const el = root.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth)); ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const loadCmp = useCallback(async () => {
    if (show.kind !== 'compare') return;
    setCmp((c) => ({ ...c, loading: true, err: undefined }));
    try { const r = await api(`/api/artifacts/${show.to}/compare?from=${show.from}`); setCmp({ loading: false, data: r }); }
    catch (e: any) { setCmp({ loading: false, err: e.code, hint: e.hint }); }
  }, [show]);
  useEffect(() => { setComposer(null); if (show.kind === 'compare') loadCmp(); else setCmp({ loading: false }); }, [show.kind === 'compare' ? `${show.from}-${show.to}` : show.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const diffText: string = compare ? cmp.data?.diff ?? '' : data.diff;
  const truncated: boolean = compare ? !!cmp.data?.truncated : data.truncated;
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const ids = useMemo(() => { const m = new Map<DiffLine, number>(); let n = 0; files.forEach((f) => f.hunks.forEach((h) => h.lines.forEach((l) => m.set(l, n++)))); return m; }, [files]);
  const comments: Comment[] = compare ? [] : data.comments;
  const gate = compare ? { reason: 'compare', hint: '' } : data.comment_gate;
  const canSplit = width >= 900;
  const mode: 'unified' | 'split' = pref === 'split' && canSplit ? 'split' : 'unified';
  const reach = typeof window !== 'undefined' ? (window.innerWidth >= 1200 ? window.innerWidth - 240 : window.innerWidth) : 0;
  const splitReason = canSplit ? '' : reach >= 900 && !expanded ? 'needs Expand' : 'needs a window at least 900 px wide';

  // per-file view model: first 500 lines per file when the diff is large, highlight only small known files
  const total = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const large = truncated || total > 2000;
  const view = useMemo(() => files.map((f) => {
    const n = f.hunks.reduce((m, h) => m + h.lines.length, 0);
    const cut = large && n > LIMIT_LINES && !full.has(f.path);
    let left = LIMIT_LINES;
    const hunks = cut ? f.hunks.flatMap((h) => { if (left <= 0) return []; const hh = { ...h, lines: h.lines.slice(0, left) }; left -= hh.lines.length; return [hh]; }) : f.hunks;
    const lang = n > PLAIN_OVER || (compare && f.renamed) ? null : languageFor(f.path);
    return { f, hunks, cut, lang };
  }), [files, large, full, compare]);
  const html = useMemo(() => { const m = new Map<DiffHunk, HunkHtml>(); if (hl) view.forEach((v) => { if (v.lang) v.hunks.forEach((h) => m.set(h, highlightHunk(hl, v.lang!, h))); }); return m; }, [hl, view]);
  const flatHunks = useMemo(() => view.flatMap((v) => v.hunks.map((h) => ({ f: v.f, h }))), [view]);
  const hunkNo = (h: DiffHunk) => flatHunks.findIndex((x) => x.h === h) + 1;
  const placed = new Set<number>();
  const byKey = new Map<string, Comment[]>();
  const shownFiles = useMemo(() => view.map((v) => ({ ...v.f, hunks: v.hunks })), [view]);   // only what is rendered (the 500-line cut hides the rest)
  comments.forEach((c) => { if (anchorInDiff(shownFiles, c.path, c.side, c.line)) { placed.add(c.id); const k = `${c.path}|${c.side}|${c.line}`; byKey.set(k, [...(byKey.get(k) ?? []), c]); } });
  const unplaced = comments.filter((c) => !placed.has(c.id));

  const firstKey = useMemo(() => {
    for (const { h } of flatHunks) { const l = h.lines.find((x) => x.type !== 'meta'); if (l) return mode === 'unified' ? `${ids.get(l)}:u` : `${ids.get(l)}:${l.type === 'del' ? 'old' : 'new'}`; }
    return '';
  }, [flatHunks, ids, mode]);
  const effActive = activeKey && (mode === 'unified') === activeKey.endsWith(':u') ? activeKey : firstKey;
  const cellEl = (k: string) => root.current?.querySelector<HTMLElement>(`[data-cell="${k}"]`) ?? null;
  const focusCell = (k: string) => { const el = cellEl(k); if (el) { setActive(k); el.focus(); el.scrollIntoView?.({ block: 'nearest' }); } };

  // comment availability
  const canComment = !compare && !gate;
  const commentNote = compare ? null : !gate ? null : gate.reason === 'worker_running' ? 'Worker is running; comment after it submits' : 'Comments closed for this round';

  const startComment = (line: DiffLine, cellSide: 'old' | 'new' | 'u', path: string, invoker: HTMLElement | null) => {
    if (!canComment) { setLive(commentNote ?? 'Comments are not available in compare view'); return; }
    const side = anchorSideFor(line), no = side === 'old' ? line.oldNo! : line.newNo!;
    const note = line.type === 'ctx' && cellSide === 'old' ? ' (unchanged line; comments on unchanged lines attach to the new side)' : '';
    setComposer({ line, path, side, label: `Comment on ${side} line ${no} of ${path}${note}`, invoker });
  };
  const refocus = useRef<HTMLElement | null>(null);
  const closeComposer = (focusBack = true) => {
    const c = composer; setComposer(null);
    if (focusBack && c) refocus.current = c.invoker ?? null;
  };
  useEffect(() => {                                   // after the textarea is gone, focus returns to the invoking element (the line)
    if (composer || !refocus.current) return;
    const el = refocus.current; refocus.current = null;
    if (document.contains(el)) el.focus(); else cellEl(effActive)?.focus();
  });
  const save = async (body: string) => {
    if (!composer) return;
    const side = composer.side, line = side === 'old' ? composer.line.oldNo : composer.line.newNo;
    await api(`/api/artifacts/${data.id}/comments`, { body: { path: composer.path, line, side, body } });
    closeComposer(); reload();
  };

  const ctxFor = (f: DiffFile, h: DiffHunk): HunkCtx => ({
    path: f.path, hunkNo: hunkNo(h), lineId: (l) => ids.get(l)!, html: html.get(h), activeKey: effActive, setActive,
    commentBtn: (l) => canComment || gate?.reason === 'worker_running'
      ? <button type="button" tabIndex={-1} disabled={!canComment} aria-label={`Comment on ${anchorSideFor(l)} line ${anchorSideFor(l) === 'old' ? l.oldNo : l.newNo}`} title={commentNote ?? 'Comment (c)'}
          className="btn btn-secondary btn-sm absolute right-1 top-0.5 z-[1] h-5 font-sans opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 disabled:opacity-40"
          onClick={(e) => startComment(l, 'u', f.path, e.currentTarget)}>+ Comment</button> : null,
    extra: (l, colSpan) => {
      const list = [...(l.type === 'del' ? byKey.get(`${f.path}|old|${l.oldNo}`) ?? [] : []), ...(l.type !== 'del' ? byKey.get(`${f.path}|new|${l.newNo}`) ?? [] : [])];
      const comp = composer && composer.line === l && composer.path === f.path ? composer : null;
      if (!list.length && !comp) return null;
      return <tr key={`x${ids.get(l)}`}><td colSpan={colSpan} className={`py-2 pr-4 bg-content ${colSpan === 3 ? 'pl-[calc(2*2.75rem+1.25rem)]' : 'pl-4'}`}>
        {list.map((c) => <CommentItem key={c.id} c={c} />)}
        {comp && <CommentComposer id={`cc-${ids.get(l)}`} label={comp.label} onSave={save} onCancel={() => closeComposer()} />}
      </td></tr>;
    },
  });

  // pending focus (from "Round 1 requests" links)
  useEffect(() => {
    if (!pendingFocus || !files.length) return;
    const f = files.find((x) => x.path === pendingFocus.path);
    const l = f?.hunks.flatMap((h) => h.lines).find((x) => pendingFocus.side === 'old' ? x.type === 'del' && x.oldNo === pendingFocus.line : x.type !== 'del' && x.type !== 'meta' && x.newNo === pendingFocus.line);
    if (l) { setTimeout(() => focusCell(mode === 'unified' ? `${ids.get(l)}:u` : `${ids.get(l)}:${l.type === 'del' ? 'old' : 'new'}`), 0); setPendingFocus(null); }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const setView = (v: 'unified' | 'split') => {
    setPref(v); try { localStorage.setItem('sb.diffView', v); } catch {}
    const m = effActive.match(/^(\d+):/); const lineId = m ? m[1] : null;
    if (lineId) { const l = [...ids.entries()].find(([, i]) => String(i) === lineId)?.[0]; if (l) setActive(v === 'unified' ? `${lineId}:u` : `${lineId}:${l.type === 'del' ? 'old' : 'new'}`); }
    modeRefocus.current = true;
  };

  useEffect(() => {                                   // keep keyboard focus on the same line when the layout switches
    if (!modeRefocus.current) return; modeRefocus.current = false;
    if (document.activeElement === document.body || !document.activeElement?.isConnected) root.current?.querySelector<HTMLElement>('[data-cell][tabindex="0"]')?.focus();
  }, [mode, effActive]);

  // keyboard (PHASE2 §B5): active while focus is inside the Detail pane and not in a text field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!t || !t.closest('aside[aria-label="Detail"]')) return;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      const r = root.current; if (!r) return;
      const cur = t.closest<HTMLElement>('[data-cell]');
      const heads = Array.from(r.querySelectorAll<HTMLElement>('[data-hunk-heading]'));
      const announceHunk = (i: number) => { const h = heads[i]; if (!h) return; h.focus(); h.scrollIntoView?.({ block: 'nearest' }); setLive(h.dataset.announce ?? ''); };
      const hunkIdx = () => { const n = Number((cur ?? t.closest('[data-hunk-heading]'))?.getAttribute('data-hunk') ?? t.closest<HTMLElement>('[data-hunk-wrap]')?.dataset.hunkWrap ?? 0); return n - 1; };
      const k = e.key;
      if (k === 'x') { e.preventDefault(); toggleExpand(); return; }
      if (k === 'v') { e.preventDefault(); if (pref === 'unified') { if (!canSplit) setLive(`Side by side unavailable: ${splitReason}`); else setView('split'); } else setView('unified'); return; }
      if (!r.contains(t) && t.closest('aside') == null) return;
      if (k === 'n' || k === 'p') { e.preventDefault(); if (!heads.length) return; const i = hunkIdx(); announceHunk(k === 'n' ? Math.min(heads.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)); return; }
      if (k === 'Home' && (cur || t.closest('[data-hunk-heading]'))) { e.preventDefault(); announceHunk(0); return; }
      if (k === 'End' && (cur || t.closest('[data-hunk-heading]'))) { e.preventDefault(); announceHunk(heads.length - 1); return; }
      if (k === ']' || k === '[') {
        const fh = Array.from(r.querySelectorAll<HTMLElement>('[data-file-heading]')); if (!fh.length) return; e.preventDefault();
        const sec = t.closest<HTMLElement>('[data-file]'); const i = sec ? fh.indexOf(sec.querySelector('[data-file-heading]')!) : -1;
        const nx = fh[k === ']' ? Math.min(fh.length - 1, i + 1) : Math.max(0, i - 1)]; nx.focus(); setLive(nx.textContent ?? ''); return;
      }
      if (k === 'c') {
        e.preventDefault();
        let c = cur;
        if (!c) { const hw = t.closest<HTMLElement>('[data-hunk-wrap]'); c = hw?.querySelector<HTMLElement>('[data-cell]') ?? null; }
        if (!c) return;
        const lineId = Number(c.dataset.line); const line = [...ids.entries()].find(([, i]) => i === lineId)?.[0]; const path = c.closest<HTMLElement>('[data-file]')?.dataset.file;
        if (line && path) startComment(line, (c.dataset.side as any) ?? 'u', path, cur ?? t);
        return;
      }
      if (cur && (k === 'ArrowDown' || k === 'ArrowUp')) {
        e.preventDefault();
        const list = Array.from(r.querySelectorAll<HTMLElement>(`[data-cell][data-hunk="${cur.dataset.hunk}"][data-side="${cur.dataset.side}"]`));
        const n = list[list.indexOf(cur) + (k === 'ArrowDown' ? 1 : -1)]; if (n) focusCell(n.dataset.cell!); return;
      }
      if (cur && mode === 'split' && (k === 'ArrowLeft' || k === 'ArrowRight')) {
        e.preventDefault();
        const want = k === 'ArrowLeft' ? 'old' : 'new';
        if (cur.dataset.side === want) return;
        const n = r.querySelector<HTMLElement>(`[data-cell][data-hunk="${cur.dataset.hunk}"][data-row="${cur.dataset.row}"][data-side="${want}"]`);
        if (n) focusCell(n.dataset.cell!); else setLive('no line on this side');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const fileRows = view.map((v) => { const s = compare || !data.files.find((x: any) => x.path === v.f.path) ? stat(v.f) : { a: data.files.find((x: any) => x.path === v.f.path).added, r: data.files.find((x: any) => x.path === v.f.path).removed };
    return { path: v.f.path, ...s, n: comments.filter((c) => c.path === v.f.path).length }; });

  const sibs: any[] = data.siblings.some((s: any) => s.id === data.id) ? data.siblings : [...data.siblings, { id: data.id, cycle: data.review_cycle, round: data.review_round }].sort((a, b) => a.id - b.id);
  const pairs = sibs.slice(1).map((s, i) => ({ from: sibs[i], to: s }));
  const cmpFrom = compare ? sibs.find((s) => s.id === (show as any).from) : null;
  const requests: any[] = compare ? cmp.data?.from_comments ?? [] : [];

  let body: React.ReactNode;
  if (compare && cmp.loading && !cmp.data) body = <p className="p-4 text-callout text-fg-tertiary">Loading diff…</p>;
  else if (compare && cmp.err) body = <p role="alert" className="p-4 text-body text-danger">{cmp.err === 'compare_unavailable' || cmp.err === 'wrong_task' ? `Can't compare these rounds: ${cmp.hint || cmp.err}.` : `Couldn't load diff (${cmp.err}).`} <button className="btn btn-link inline" onClick={loadCmp}>Retry</button></p>;
  else if (!files.length) body = <p className="p-4 text-body text-fg-secondary">{compare ? `No changes between round ${cmpFrom?.round ?? ''} and round ${data.review_round}.` : 'No file changes in this round.'}</p>;
  else body = <div>
    <nav aria-label="Files" className="px-4 py-2 flex items-center gap-1 overflow-x-auto border-b border-separator">
      <span className="shrink-0 text-caption font-semibold text-fg-tertiary mr-1">Files ({fileRows.length})</span>
      {fileRows.map((f) => <button key={f.path} className="btn btn-ghost btn-sm font-mono shrink-0" onClick={() => { const h = r_(f.path); h?.focus(); h?.scrollIntoView?.({ block: 'start' }); }}>{f.path} <span className="text-diff-add-fg">+{f.a}</span> <span className="text-diff-del-fg">−{f.r}</span>{!compare ? ` · ${f.n} comment${f.n === 1 ? '' : 's'}` : ''}</button>)}
    </nav>
    {truncated && <p className="px-4 py-2 text-callout text-fg-secondary">Diff truncated at 2,000 lines.</p>}
    {view.map(({ f, hunks, cut, lang }, fi) => (
      <section key={f.path} data-file={f.path} aria-labelledby={`fh-${fi}`} role="region" className="mb-4">
        <h3 id={`fh-${fi}`} tabIndex={-1} data-file-heading className="focus-inset sticky top-[var(--toolbar-h,0px)] z-[5] h-9 px-4 flex items-center gap-2 bg-sunken border-y border-separator font-mono text-callout font-medium text-fg-primary"><Icon as={FileText} size={14} className="text-fg-tertiary" />{f.path}{f.renamed ? ` (renamed from ${f.oldPath})` : ''}{!lang && !f.binary ? <span className="font-normal text-fg-tertiary text-caption"> · plain</span> : null}</h3>
        {f.binary && <p className="px-4 py-2 text-callout text-fg-secondary">Binary file not shown.</p>}
        {hunks.map((h) => { const n = hunkNo(h), [a, b] = hunkRange(h); return (
          <div key={h.header} role="group" aria-labelledby={`hh-${n}`} data-hunk-wrap={n} className="mb-2">
            <h4 id={`hh-${n}`} tabIndex={-1} data-hunk-heading data-hunk={n} data-announce={`Hunk ${n} of ${flatHunks.length}, ${f.path}, lines ${a} to ${b}`} aria-label={`Hunk ${n} of ${flatHunks.length}, lines ${a} to ${b}`}
              className="focus-inset px-4 h-7 flex items-center bg-fill text-caption font-mono text-fg-secondary">Hunk {n} of {flatHunks.length} · lines {a}–{b}{h.section ? ` · ${h.section}` : ''}</h4>
            <div className="overflow-x-auto">{mode === 'unified' ? <UnifiedHunk hunk={h} ctx={ctxFor(f, h)} /> : <SplitHunk hunk={h} ctx={ctxFor(f, h)} />}</div>
          </div>); })}
        {cut && <p className="px-4 py-2 text-callout text-fg-secondary">Showing the first {LIMIT_LINES} lines{(() => { const n = comments.filter((c) => c.path === f.path && !placed.has(c.id)).length; return n ? ` · ${n} comment${n === 1 ? '' : 's'} in hidden lines` : ''; })()}. <button className="btn btn-link inline" onClick={() => setFull(new Set([...full, f.path]))}>Show full file</button></p>}
      </section>))}
    {unplaced.length > 0 && <div className="px-4"><h4 className="text-callout font-semibold">Comments on lines not shown</h4>{unplaced.map((c) => <div key={c.id}><p className="text-callout text-fg-secondary">{c.path}</p><CommentItem c={c} /></div>)}</div>}
  </div>;
  function r_(path: string) { return root.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(path)}"] [data-file-heading]`) ?? null; }

  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {                                   // sticky file headers sit under the sticky toolbar
    const el = toolbar.current, r = root.current; if (!el || !r) return;
    const set = () => r.style.setProperty('--toolbar-h', `${el.offsetHeight}px`);
    set(); const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
  }, []);
  const seg = 'seg-item';
  return (
    <div ref={root} className="text-body">
      <div role="status" aria-live="polite" className="sr-only">{live}</div>
      <div ref={toolbar} className="sticky top-0 z-10 material-bar border-b border-separator px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex flex-wrap items-center gap-2"><legend className="sr-only">Show</legend><span className="text-callout text-fg-tertiary">Show:</span>
          <div className="seg flex-wrap h-auto">
          {sibs.map((s) => <label key={s.id} className={seg}><input type="radio" className="sr-only" name="dv-show" checked={show.kind === 'round' && show.id === s.id} onChange={() => setShow({ kind: 'round', id: s.id })} /> Round {s.round}{sibs.some((x) => x.cycle !== s.cycle) ? ` (cycle ${s.cycle})` : ''}</label>)}
          {pairs.map((p) => <label key={p.to.id} className={seg}><input type="radio" className="sr-only" name="dv-show" checked={show.kind === 'compare' && show.to === p.to.id && show.from === p.from.id} onChange={() => setShow({ kind: 'compare', from: p.from.id, to: p.to.id })} /> Changes since round {p.from.round} ({label(p.from, sibs)} → {label(p.to, sibs)})</label>)}
          </div>
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-2"><legend className="sr-only">View</legend><span className="text-callout text-fg-tertiary">View:</span>
          <div className="seg">
          <label className={seg}><input type="radio" className="sr-only" name="dv-view" checked={mode === 'unified'} onChange={() => setView('unified')} /> Unified</label>
          <label className={seg}><input type="radio" className="sr-only" name="dv-view" checked={mode === 'split'} disabled={!canSplit} aria-describedby="dv-split-reason" onChange={() => setView('split')} /> Side by side</label>
          </div>
          {!canSplit && <span id="dv-split-reason" className="text-caption text-fg-tertiary">— {splitReason}</span>}
        </fieldset>
        {commentNote && !compare && <p className="w-full flex items-center gap-1.5 text-caption text-fg-tertiary"><Icon as={MessageSquare} size={14} />{commentNote}</p>}
      </div>
      {compare && cmp.data && <div className="px-4 py-2 border-b border-separator">
        <h4 className="text-callout font-semibold">Round {cmpFrom?.round} requests ({requests.length}, read-only)</h4>
        {requests.length === 0 ? <p className="text-callout text-fg-secondary">None.</p> : <ul className="mt-1 text-callout space-y-1">{requests.map((c: any) => (
          <li key={c.id}><label className="flex gap-2"><input type="checkbox" className="checkbox shrink-0" checked={checked.has(c.id)} onChange={() => setChecked((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
            <span><span className="font-mono">{c.path} {c.side} {c.line}</span> · {authorOf(c)}: &ldquo;{c.body}&rdquo;</span></label>
            <button className="btn btn-link text-callout ml-6" onClick={() => { setPendingFocus({ path: c.path, side: c.side, line: c.line }); setShow({ kind: 'round', id: (show as any).from }); }}>Open in round {cmpFrom?.round}</button></li>))}</ul>}
      </div>}
      {body}
    </div>
  );
}
