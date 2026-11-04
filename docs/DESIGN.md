# Slackboard visual design system

Status: v1. Scope: visual layer only. Behaviour, copy, keyboard paths and ARIA from `docs/UX.md` and `docs/PHASE2.md` Part B are unchanged; where this file names a label it repeats UX, never replaces it. Stack: Next.js 14, Tailwind 3.4, `lucide-react`.

## 1. Direction

**Principles**

1. **Content first, chrome quiet.** Neutral greys, one blue accent, colour only for status. No coloured buttons except primary (blue) and destructive (red).
2. **Hierarchy from type, not boxes.** A 13 px macOS-style base with clear weight and size steps. Hairline separators and soft layered shadows replace hard 1 px slate borders.
3. **Light and dark are equal.** Every colour is a token pair, chosen by `prefers-color-scheme`, with optional `.light` / `.dark` overrides on `<html>`.
4. **Status = icon shape + text + colour.** One line-icon set (lucide) replaces the unicode glyphs. Text labels stay.
5. **Calm density.** A 4/8 pt grid, 28 px controls, 120–240 ms ease-out motion, and nothing moves under `prefers-reduced-motion`.

**What changes, per screen**

| Screen | Today | After |
|---|---|---|
| Shell / header | Slate-950 bar, emoji gear, loose counters, red "KILL" block | 48 px translucent title bar. Counters and orchestrator state sit in neutral status pills; ⌘K search, icon Settings and a compact red `Kill` button on the right |
| Sidebar | Flat list, ▸ and unicode presence glyphs, emoji gear | Tinted sidebar with sentence-case section labels and 28 px rows with lucide icons. The selected row is a white (dark: raised) pill. The Needs-you count is a blue badge |
| Needs you | Full-width rows, tiny grey buttons | Decision cards (max 720 px) on the window background. Filter is a segmented control. Buttons show kbd hints |
| Chat / thread | Plain text lines | Avatar + author line. Grouped consecutive messages. Collapsible compact system lines. Floating rounded composer with the wake hint inside its footer |
| Board | Columns on black, flat cards | Cards (radius 10, shadow-sm) on the window background. Column headers with icon + count. Dashed empty slots |
| Task detail | Dense text, underlined links | Pane header with a status pill. Sections with caption headings. Jobs in a hairline table. Sticky action footer |
| Review / diff | Raw `diff --git` text, green block | Sticky toolbar (segmented Show/View), file chips, sticky file headers, gutters, AA add/del tints, comment bubbles |
| Settings | Loose label/input grid, blue checkboxes | macOS System Settings–style inset grouped lists, right-aligned numeric fields, usage hints |
| Banners / kill | Dark red strip | Tinted banners with icon + inline actions. The kill banner has a 3 px red left rule and a primary `Resume` |
| Toasts | Big grey blocks stacked mid-bottom | Small material toasts, bottom-right (bottom-centre on mobile), at most 3 visible |
| Mobile | Wrapped header, cramped rows | Two-row header with scrollable pills, a segmented tab bar, bottom sheets for dialogs, 36 px touch controls |

## 2. Tokens

### 2.1 CSS variables (`app/globals.css`, top of file)

Colours are RGB channel triplets so Tailwind alpha modifiers work (`bg-accent/10`).

```css
:root {
  color-scheme: light;
  /* backgrounds */
  --bg-window: 245 245 247;     /* #F5F5F7 app background, board/inbox/settings canvas */
  --bg-sidebar: 235 235 237;    /* #EBEBED */
  --bg-content: 255 255 255;    /* #FFFFFF chat, panes */
  --bg-elevated: 255 255 255;   /* cards, popovers, dialogs, composer */
  --bg-sunken: 242 242 244;     /* #F2F2F4 file headers, code blocks */
  --bg-selected: 255 255 255;   /* sidebar selected row (+ shadow-xs) */
  /* text */
  --fg-primary: 29 29 31;       /* #1D1D1F */
  --fg-secondary: 79 79 85;     /* #4F4F55 */
  --fg-tertiary: 99 99 104;     /* #636368 */
  --fg-on-accent: 255 255 255;
  /* lines and fills (alpha baked into the Tailwind colour) */
  --sep: 0 0 0;                 /* separators 10 % / 16 %, fills 5 % / 8 % */
  --control-border: 134 134 139;/* #86868B input/checkbox outline */
  /* accent and actions */
  --accent: 0 98 204;           /* #0062CC text, links, focus ring */
  --accent-fill: 0 98 204;      /* primary button background */
  --danger-fill: 200 16 46;     /* #C8102E destructive button, kill */
  /* status (text and icons) */
  --status-proposed: 116 56 194;/* #7438C2 */
  --status-todo: 79 79 85;      /* = secondary */
  --status-progress: 0 98 204;  /* #0062CC */
  --status-review: 148 84 0;    /* #945400 */
  --status-blocked: 194 38 31;  /* #C2261F also failed, danger text */
  --status-done: 24 112 47;     /* #18702F */
  --status-cancelled: 99 99 104;/* = tertiary */
  --status-warn: 138 80 0;      /* #8A5000 paused, near-limit, amber banners */
  /* banner tints (solid) */
  --tint-danger: 250 231 234;   /* #FAE7EA */
  --tint-warn: 243 238 230;     /* #F3EEE6 */
  --tint-info: 235 242 251;     /* #EBF2FB */
  /* diff */
  --diff-add: 231 245 234;      /* #E7F5EA */
  --diff-del: 252 235 235;      /* #FCEBEB */
  --diff-add-fg: 24 112 47;     /* #18702F  "+" glyph, +n counts */
  --diff-del-fg: 176 34 27;     /* #B0221B  "−" glyph, −n counts */
  --syn-kw: 155 35 147;  --syn-str: 180 38 26;  --syn-num: 28 0 207;
  --syn-com: 93 108 121; --syn-fn: 62 109 116;
  /* elevation */
  --shadow-xs: 0 1px 1px rgb(0 0 0 / .04), 0 0 0 .5px rgb(0 0 0 / .06);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / .06), 0 0 0 .5px rgb(0 0 0 / .08);
  --shadow-md: 0 4px 12px rgb(0 0 0 / .08), 0 1px 3px rgb(0 0 0 / .06), 0 0 0 .5px rgb(0 0 0 / .08);
  --shadow-lg: 0 16px 40px rgb(0 0 0 / .14), 0 4px 12px rgb(0 0 0 / .08), 0 0 0 .5px rgb(0 0 0 / .08);
}

:root.dark { /* DARK TOKENS */
  color-scheme: dark;
  --bg-window: 17 17 19;        /* #111113 */
  --bg-sidebar: 26 26 29;       /* #1A1A1D */
  --bg-content: 28 28 31;       /* #1C1C1F */
  --bg-elevated: 42 42 46;      /* #2A2A2E */
  --bg-sunken: 21 21 23;        /* #151517 */
  --bg-selected: 44 44 49;      /* #2C2C31 */
  --fg-primary: 245 245 247;    /* #F5F5F7 */
  --fg-secondary: 180 180 186;  /* #B4B4BA */
  --fg-tertiary: 154 154 161;   /* #9A9AA1 */
  --fg-on-accent: 255 255 255;
  --sep: 255 255 255;
  --control-border: 118 118 125;/* #76767D */
  --accent: 90 172 255;         /* #5AACFF */
  --accent-fill: 10 108 214;    /* #0A6CD6 */
  --danger-fill: 200 16 46;     /* #C8102E */
  --status-proposed: 196 155 255;/* #C49BFF */
  --status-todo: 180 180 186;
  --status-progress: 90 172 255;
  --status-review: 255 181 71;  /* #FFB547 */
  --status-blocked: 255 133 124;/* #FF857C */
  --status-done: 78 208 122;    /* #4ED07A */
  --status-cancelled: 154 154 161;
  --status-warn: 255 181 71;
  --tint-danger: 66 25 34;      /* #421922 */
  --tint-warn: 60 49 37;        /* #3C3125 */
  --tint-info: 38 51 67;        /* #263343 */
  --diff-add: 20 41 28;         /* #14291C */
  --diff-del: 51 23 26;         /* #33171A */
  --diff-add-fg: 110 220 143;   /* #6EDC8F */
  --diff-del-fg: 255 138 128;   /* #FF8A80 */
  --syn-kw: 255 122 178; --syn-str: 255 129 112; --syn-num: 217 201 124;
  --syn-com: 140 154 166; --syn-fn: 103 216 201;
  --shadow-xs: 0 1px 1px rgb(0 0 0 / .3), 0 0 0 .5px rgb(255 255 255 / .06);
  --shadow-sm: 0 1px 3px rgb(0 0 0 / .4), 0 0 0 .5px rgb(255 255 255 / .08), inset 0 .5px 0 rgb(255 255 255 / .05);
  --shadow-md: 0 6px 16px rgb(0 0 0 / .45), 0 0 0 .5px rgb(255 255 255 / .1), inset 0 .5px 0 rgb(255 255 255 / .06);
  --shadow-lg: 0 20px 48px rgb(0 0 0 / .55), 0 0 0 .5px rgb(255 255 255 / .1), inset 0 .5px 0 rgb(255 255 255 / .06);
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) { /* paste the DARK TOKENS block verbatim */ }
}
```

CSS has no mixins, so the dark block appears twice: once under `:root.dark` and once inside the media query. Keep the two blocks identical (a unit test can compare them).

**Theme wiring.** In `app/layout.tsx`, remove the hard-coded `className="dark"`. Set `<html lang="en" suppressHydrationWarning>` and `<body className="bg-window text-fg-primary font-sans text-body antialiased">`. Optional Settings → Appearance (System / Light / Dark) stores `sb.theme` in `localStorage`. A 3-line inline `<script>` in `<head>` adds `.light` or `.dark` to `<html>` before paint. System mode adds no class.

### 2.2 Tailwind (`tailwind.config.ts`)

```ts
import type { Config } from 'tailwindcss';
const c = (v: string) => `rgb(var(--${v}) / <alpha-value>)`;
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: ['variant', ['@media (prefers-color-scheme: dark) { &:not(.light *) }', '&:is(.dark *)']], // Tailwind >= 3.4.1
  theme: {
    screens: { sm: '640px', md: '800px', lg: '1024px', xl: '1200px', '2xl': '1536px' }, // UX §2
    extend: {
      colors: {
        window: c('bg-window'), sidebar: c('bg-sidebar'), content: c('bg-content'),
        elevated: c('bg-elevated'), sunken: c('bg-sunken'), selected: c('bg-selected'),
        fg: { primary: c('fg-primary'), secondary: c('fg-secondary'), tertiary: c('fg-tertiary'), 'on-accent': c('fg-on-accent') },
        separator: { DEFAULT: 'rgb(var(--sep) / .10)', strong: 'rgb(var(--sep) / .16)' },
        fill: { DEFAULT: 'rgb(var(--sep) / .05)', strong: 'rgb(var(--sep) / .08)' },
        control: c('control-border'),
        accent: { DEFAULT: c('accent'), fill: c('accent-fill') },
        danger: { DEFAULT: c('status-blocked'), fill: c('danger-fill') },
        status: {
          proposed: c('status-proposed'), todo: c('status-todo'), progress: c('status-progress'),
          review: c('status-review'), blocked: c('status-blocked'), done: c('status-done'),
          cancelled: c('status-cancelled'), warn: c('status-warn'),
        },
        tint: { danger: c('tint-danger'), warn: c('tint-warn'), info: c('tint-info') },
        diff: { add: c('diff-add'), del: c('diff-del'), 'add-fg': c('diff-add-fg'), 'del-fg': c('diff-del-fg') },
        syn: { kw: c('syn-kw'), str: c('syn-str'), num: c('syn-num'), com: c('syn-com'), fn: c('syn-fn') },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', 'system-ui', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', '"SF Mono"', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        title:    ['20px', { lineHeight: '26px', letterSpacing: '-0.012em', fontWeight: '600' }],
        headline: ['15px', { lineHeight: '20px', letterSpacing: '-0.006em', fontWeight: '600' }],
        'body-lg':['14px', { lineHeight: '20px' }],
        body:     ['13px', { lineHeight: '18px' }],
        callout:  ['12px', { lineHeight: '16px' }],
        caption:  ['11px', { lineHeight: '14px', letterSpacing: '0.006em' }],
        mono:     ['12px', { lineHeight: '20px' }],
      },
      borderRadius: { sm: '6px', DEFAULT: '8px', md: '8px', lg: '10px', xl: '14px', '2xl': '18px' },
      boxShadow: { xs: 'var(--shadow-xs)', sm: 'var(--shadow-sm)', md: 'var(--shadow-md)', lg: 'var(--shadow-lg)' },
      transitionDuration: { fast: '120ms', DEFAULT: '180ms', slow: '240ms' },
      transitionTimingFunction: { out: 'cubic-bezier(0.22, 1, 0.36, 1)', 'in-out': 'cubic-bezier(0.65, 0, 0.35, 1)' },
    },
  },
  plugins: [],
} satisfies Config;
```

Tokens should rarely need `dark:`; it exists for the few alpha differences (scrim).

### 2.3 Typography

| Role | Class | Size / line / weight | Use |
|---|---|---|---|
| Title | `text-title` | 20/26 semibold | View titles (Needs you, Board, Settings) |
| Headline | `text-headline` | 15/20 semibold | Pane headers, dialog titles, settings group titles, empty-state titles |
| Body large | `text-body-lg` | 14/20 regular | Message bodies, task description, composer text |
| Body | `text-body` | 13/18 regular / `font-medium` / `font-semibold` | Default UI text, buttons, rows, card titles (semibold) |
| Callout | `text-callout` | 12/16 regular/medium | Secondary lines, hints, segmented items, meta |
| Caption | `text-caption` | 11/14 medium/semibold | Section labels, timestamps, pills, kbd, gutters |
| Mono | `font-mono text-mono` | 12/20 | Diff, logs, ids (`T-7` uses `font-mono text-caption`) |

Rules: sentence case everywhere (no ALL-CAPS section labels). Numbers that change use `tabular-nums`. Use at most two weights per component. Truncate with `truncate` or `line-clamp-2` and put the full text in `title`.

### 2.4 Spacing, radii, elevation

- **Spacing:** use only Tailwind steps `0.5 1 1.5 2 3 4 5 6 8 10 12 16` (2–64 px). Inside a component: 4/6/8. Between components: 12/16. Pane padding: 16 (`px-4`) for side panes, 20 (`px-5`) for centre.
- **Control heights:** 24 (`h-6`, small), 28 (`h-7`, default), 32 (`h-8`, large), 36 on `pointer: coarse`.
- **Radii:** `rounded-sm` 6 (pills, kbd, small buttons, segmented items), `rounded-md` 8 (buttons, inputs, rows), `rounded-lg` 10 (cards), `rounded-xl` 14 (dialogs, popovers, grouped lists, composer, toasts), `rounded-2xl` 18 (mobile sheets), `rounded-full` (avatars, count badges).
- **Elevation:** `shadow-xs` selected rows, inputs; `shadow-sm` cards, segmented thumb, composer; `shadow-md` hover cards, popovers, menus, toasts; `shadow-lg` dialogs, overlay pane, expanded review. Each shadow already contains a 0.5 px hairline, so don't add `border` to shadowed surfaces.

### 2.5 Materials

```css
@layer components {
  .material     { background: rgb(var(--bg-elevated) / .72); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); }
  .material-bar { background: rgb(var(--bg-window) / .80);   -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .material { background: rgb(var(--bg-elevated)); }  .material-bar { background: rgb(var(--bg-window)); }
  }
  @media (prefers-reduced-transparency: reduce) {
    .material { background: rgb(var(--bg-elevated)); backdrop-filter: none; } .material-bar { background: rgb(var(--bg-window)); backdrop-filter: none; }
  }
}
```

Use `.material-bar` for the header, the mobile tab bar and sticky pane/diff toolbars. Use `.material` for the overlay right pane (< 1200 px), popovers, the quick switcher and toasts. The sidebar is **solid** `bg-sidebar`: nothing scrolls behind it on the web, so blur would add cost and no effect. Text on materials is `fg-primary` or `fg-secondary` only. The ratios in §6 are computed against the solid fallback.

### 2.6 Focus ring and motion

```css
:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 2px; border-radius: inherit; }
.focus-inset:focus-visible { outline-offset: -2px; }           /* diff lines, list rows inside scroll areas */
@media (prefers-reduced-motion: reduce) {                       /* keep the existing global rule */
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
```

Replace the current `#38bdf8` outline with the rule above. Text fields swap the outline for `focus:ring-2 focus:ring-accent` (§4.3).

| Motion | Duration / easing | Where |
|---|---|---|
| Hover / press colour | `duration-fast ease-out` | buttons, rows |
| Popover, toast, menu in | 180 ms `ease-out`, opacity 0→1 + `translate-y-1`→0 | |
| Dialog in | 180 ms `ease-out`, opacity + `scale-[.98]`→1. Out: 120 ms | |
| Right pane overlay / sheet | 240 ms `ease-out`, `translate-x-full`→0 (sheet: `translate-y-full`) | |
| Working indicator | `animate-pulse` on the presence icon only (2 s) | none under reduced motion |
| Status change on a card | 600 ms `bg-accent/10` flash | under reduced motion the text label alone changes (UX §11) |

## 3. Iconography

**Set:** `lucide-react@0.468.0`, pinned exactly (`"lucide-react": "0.468.0"`). No other icon sources, no emoji, no unicode glyphs for UI icons.

**Usage:** sizes are 16 by default; 14 in pills, captions and system lines; 18 for header/toolbar icon buttons; 24 in empty states. `strokeWidth={1.75}` at 14, `1.5` at 16 and above. Icons inherit `currentColor`. Use one wrapper in `components/ui.tsx`:

```tsx
export function Icon({ as: I, size = 16, className = '' }: { as: LucideIcon; size?: 14 | 16 | 18 | 24; className?: string }) {
  return <I aria-hidden focusable={false} size={size} strokeWidth={size <= 14 ? 1.75 : 1.5} className={`shrink-0 ${className}`} />;
}
```

Icons are always `aria-hidden`. Every icon has adjacent text, or its button has `aria-label` + `title` (icon-only buttons: close, back, expand, settings in the header).

| Today | Meaning | Lucide icon | Colour token | Text kept |
|---|---|---|---|---|
| ◇ | Proposed | `CircleDashed` | `status-proposed` | "Proposed" |
| ○ | To do / Idle | `Circle` | `status-todo` / `fg-tertiary` | "To do" / "Idle" |
| ● | In progress / Working | `CircleDot` (pulse when working) | `status-progress` | "In progress" / "Working · 0:42" |
| ◐ | In review / Reviewing / Awaiting review | `Eye` | `status-review` | "In review" / "Reviewing T-7" |
| ⏸ | Blocked / Waiting on you / waiting lines | `CirclePause` | `status-blocked` | "Blocked: …" / "Waiting on you" |
| ✓ | Done / Approved / checks passed | `CircleCheck` (inline verdict: `Check`) | `status-done` | "Done", "Accepted", "Approved by director" |
| – | Cancelled / Disabled | `CircleMinus` | `status-cancelled` | "Cancelled" / "Disabled" |
| ✕ | Failed / Changes requested / error | `CircleX` | `status-blocked` | "Failed · Retry 2/3", "Changes requested" |
| ✕ (button) | Close | `X` | `fg-secondary` | `aria-label="Close"` |
| ⊘ | Paused | `CircleSlash` | `status-warn` | "Paused: kill" |
| ◔ | Queued | `Clock` | `fg-secondary` | "Queued (2)" |
| ■ | Kill switch / Stop all | `OctagonX` | on `danger-fill` | "Kill", "Stop all" |
| ⚑ | Needs-you flag / approval | `Flag` (help: `MessageCircleQuestion`, ready: `CircleCheck`, failure: `CircleX`) | `accent` | "Needs approval" … |
| ⚙ | Settings | `Settings` | `fg-secondary` | "Settings" |
| ⚠ | Warning banner | `TriangleAlert` | `status-warn` | banner text |
| ⟲ | Requeued / set aside / reconnecting | `RotateCcw` (reconnecting: `RefreshCw`) | `status-warn` | "Claim expired, requeued" |
| ▸ | Disclosure | `ChevronRight`, `rotate-90` when `aria-expanded="true"` | `fg-tertiary` | "Retired (1)" |
| ← | Back | `ChevronLeft` | `fg-secondary` | `aria-label="Back"` |
| ↳ | Subtask of | `CornerDownRight` | `fg-tertiary` | "subtask of T-3" |
| # | Channel | `Hash` | `fg-tertiary` | "general" |
| ⤢ / ⤡ | Expand / collapse review | `Maximize2` / `Minimize2` | `fg-secondary` | "Expand" / "Collapse" |
| + | New task / add worker / comment | `Plus` | inherit | "New task" |
| (new) | Needs you nav, comments, log, search, copy | `Inbox`, `MessageSquare`, `ScrollText`, `Search`, `Copy` | `fg-secondary` | labels as UX |
| (new) | Pending action | `LoaderCircle` + `animate-spin` | inherit | "Approving…" |

The icon names are as published in lucide 0.468. If a name fails to import, use its documented alias (for example `PauseCircle` for `CirclePause`). Don't pick a different shape.

## 4. Components

All reusable classes go in `@layer components` in `app/globals.css`. Components compose them with Tailwind utilities.

### 4.1 App shell

```
<header role="banner">  h-12 material-bar border-b border-separator px-4 flex items-center gap-3 sticky top-0 z-30
  App name:             text-headline text-fg-primary mr-2
  Status pills:         hidden md:flex items-center gap-1.5 min-w-0 overflow-x-auto
  Spacer:               flex-1
  ⌘K button:            btn btn-ghost btn-sm  [Search 16] "Search" <kbd>⌘K</kbd>   (hidden < 1024)
  Settings:             btn btn-ghost btn-icon  [Settings 18] aria-label="Settings"
  Kill:                 btn btn-destructive btn-sm  [OctagonX 14] "Kill"  title="Stop all agents (⌘⇧K)"
                        (kill engaged: btn btn-primary btn-sm [Play 14] "Resume")
<div class="flex h-[calc(100dvh-48px)]">
  <nav>     w-60 shrink-0 bg-sidebar border-r border-separator overflow-y-auto px-2 py-3
  <main>    flex-1 min-w-[480px] bg-content flex flex-col   (Board, Needs you, Settings views: bg-window)
  <aside>   w-[420px] shrink-0 bg-content border-l border-separator flex flex-col
```

**Header status pills:** `.pill bg-fill text-fg-secondary` showing "Today 3/60 jobs", "5 h 3/25", "$0.06 / $5.00 est.", and the orchestrator pill, whose icon carries the colour: up `CircleCheck text-status-done`, stale `TriangleAlert text-status-warn`, down `CircleX text-status-blocked`; the text stays `fg-secondary`. A counter at ≥ 80 % switches to `bg-tint-warn text-fg-primary` plus a `status-warn` icon.

**Pane header** (centre view bar, right pane): `h-12 shrink-0 flex items-center gap-2 px-4 border-b border-separator material-bar sticky top-0 z-10`. Title `text-headline truncate` (it receives focus on open: `tabIndex={-1}`). Back/close are `btn btn-ghost btn-icon`. Centre view bar: `# general` (`Hash` 16 + `text-headline`), then the segmented control.

**Pane footer** (action bar): `shrink-0 border-t border-separator px-4 py-3 flex items-center gap-2 bg-content`.

### 4.2 Buttons

```css
.btn { @apply inline-flex items-center justify-center gap-1.5 h-7 px-3 rounded-md text-body font-medium whitespace-nowrap select-none
       transition-colors duration-fast ease-out disabled:opacity-40 disabled:cursor-not-allowed
       aria-disabled:opacity-40 aria-disabled:cursor-not-allowed; }
.btn-primary     { @apply bg-accent-fill text-fg-on-accent shadow-xs hover:bg-accent-fill/90 active:bg-accent-fill/80; }
.btn-secondary   { @apply bg-fill-strong text-fg-primary hover:bg-separator active:bg-separator-strong; }
.btn-destructive { @apply bg-danger-fill text-fg-on-accent shadow-xs hover:bg-danger-fill/90 active:bg-danger-fill/80; }
.btn-ghost       { @apply bg-transparent text-fg-secondary hover:bg-fill hover:text-fg-primary active:bg-fill-strong; }
.btn-link        { @apply h-auto px-0 bg-transparent text-accent hover:underline underline-offset-2; }
.btn-sm   { @apply h-6 px-2 text-callout rounded-sm gap-1; }
.btn-lg   { @apply h-8 px-4; }
.btn-icon { @apply w-7 px-0; }  .btn-sm.btn-icon { @apply w-6; }
@media (pointer: coarse) { .btn { min-height: 36px; } .btn-icon { min-width: 36px; } }
```

- Ghost destructive (Retire, Cancel task in footers): `btn btn-ghost text-danger hover:bg-tint-danger hover:text-danger`.
- **Pending:** label switches to UX text ("Approving…"), a leading `LoaderCircle` 14 `animate-spin` appears, `disabled` + `aria-busy="true"`. Width is held with `min-w-[var(--w)]`, measured on first render, so the row doesn't jump.
- **Inline error** (UX §8): next to the button, `text-callout text-danger flex items-center gap-1` + `CircleX` 14, `role="alert"`.
- Buttons with shortcuts end with a `<kbd>` (§4.13).
- Rule: at most one primary button per card, dialog or footer.

### 4.3 Inputs

```css
.input, .select, .textarea { @apply w-full rounded-md bg-content text-body text-fg-primary placeholder:text-fg-tertiary
       border border-control shadow-xs transition-shadow duration-fast
       focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
       aria-[invalid=true]:border-danger aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger
       disabled:bg-fill disabled:text-fg-tertiary; }
.input    { @apply h-7 px-2.5; }
.input-num{ @apply w-24 text-right tabular-nums; }
.textarea { @apply px-2.5 py-2 min-h-[72px] resize-y leading-[18px]; }
.select   { @apply h-7 pl-2.5 pr-7 appearance-none bg-no-repeat; } /* wrap in relative span + ChevronDown 14 absolute right-2 text-fg-tertiary pointer-events-none */
.checkbox { @apply h-4 w-4 rounded-[4px] border-control accent-accent-fill align-[-3px]; }
.field-label { @apply text-body text-fg-primary; }   .field-hint { @apply text-caption text-fg-tertiary mt-1; }
.field-error { @apply text-callout text-danger mt-1 flex items-center gap-1; } /* CircleX 14, id referenced by aria-describedby */
```

The full-strength `border-control` is required: it is the only thing that identifies the field (3.62:1 light, 3.77:1 dark). Don't lighten it. Checkbox labels: `inline-flex items-center gap-2 text-body`.

### 4.4 Segmented control

Used for `Needs you | Chat | Board`, the inbox filter, and diff Show/View. Keep the existing semantics: buttons with `aria-pressed`, or tabs for the view switcher. Diff Show/View stay radio groups, with the radio visually hidden (`sr-only peer`) and the label styled.

```
container: inline-flex h-7 items-center gap-0.5 rounded-md bg-fill-strong p-0.5
item:      h-6 px-3 rounded-sm text-callout font-medium text-fg-secondary transition-colors duration-fast hover:text-fg-primary
selected:  bg-elevated text-fg-primary shadow-sm            (aria-pressed / aria-selected / peer-checked)
disabled:  opacity-40 cursor-not-allowed  + visible reason after the control: text-caption text-fg-tertiary
count:     ml-1 tabular-nums text-fg-tertiary   ("Needs you 2")
```

On mobile, the tab bar is the same control at `w-full grid grid-cols-4 h-9`, with `h-8` items.

### 4.5 Pills, chips, badges

```css
.pill { @apply inline-flex items-center gap-1 h-5 px-1.5 rounded-sm text-caption font-medium whitespace-nowrap; }
```

| Pill | Classes |
|---|---|
| Task status | `.pill bg-status-{s}/[.12] text-status-{s}` + icon 14 (s = proposed, progress, review, blocked, done) |
| To do / Cancelled | `.pill bg-fill-strong text-fg-secondary` |
| Warn (Near limit, Claim expired) | `.pill bg-tint-warn text-status-warn` |
| Role chip (`director`, `worker`, `system`, `help → writer2`, `peer help`) | `.pill bg-fill-strong text-fg-secondary font-normal` |
| Role chip `you` | `.pill bg-accent/[.12] text-accent` |
| Count badge (Needs you > 0) | `ml-auto min-w-5 h-5 px-1.5 rounded-full bg-accent-fill text-fg-on-accent text-caption font-semibold tabular-nums grid place-items-center`; 0 → `ml-auto text-caption text-fg-tertiary` |

Status pills sit only on `content` or `elevated` (ratios in §6). In the sidebar, use the icon colour with `fg-secondary` text. Tailwind only generates classes it can see as full strings, so write each one out in a lookup map in `ui.tsx` (`done: 'bg-status-done/[.12] text-status-done'`, …) and never build class names like `bg-status-${s}`.

### 4.6 Task card

```
<li> card: group relative rounded-lg bg-elevated p-3 shadow-sm hover:shadow-md transition-shadow duration-fast cursor-pointer
           focus-visible:outline-2 (global ring)  aria-label per UX §11
  row 1:   flex items-center gap-2
           id  font-mono text-caption text-fg-tertiary
           status pill
           round  ml-auto text-caption text-fg-tertiary tabular-nums   ("round 1 of 2", "round 2 of 2, redo")
  title:   mt-1.5 text-body font-semibold text-fg-primary line-clamp-2
  parent:  mt-1 text-callout text-fg-secondary flex items-center gap-1  [CornerDownRight 14] subtask of T-3 (btn-link)
  assignee:mt-2 flex items-center gap-2 text-callout text-fg-secondary   @worker · presence (icon 14 + text)
  meta:    mt-1 text-caption text-fg-tertiary tabular-nums               6 replies · 1 file · $0.31 est.
  reason:  mt-2 flex items-start gap-1.5 text-callout text-danger        [CirclePause 14] Blocked: waiting on writer2 (help)
  waiting: mt-2 flex items-start gap-1.5 text-callout text-status-warn   [CirclePause 14] Waiting: thread closed + btn-link
  queued:  mt-1 text-callout text-fg-secondary flex gap-1.5             [Clock 14] Queued: agent budget
  done:    mt-2 text-callout text-status-done flex gap-1.5              [CircleCheck 14] Accepted
  flag:    mt-3 -mx-3 -mb-3 px-3 py-2 border-t border-separator rounded-b-lg flex items-center gap-1.5 text-callout font-medium text-accent  [Flag 14] Needs approval
  move:    absolute top-2 right-2 btn btn-ghost btn-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100   "Move" <kbd>m</kbd>
```

When the move button shows, it covers the round label; that's fine because the label is in the card's accessible name. Dragging: `shadow-lg rotate-[1deg] scale-[1.02]` (no rotation under reduced motion). The drop target column gets `bg-accent/[.06] ring-2 ring-accent/40 rounded-xl`.

**Board:** canvas `bg-window flex gap-4 overflow-x-auto px-5 py-4`. Column `w-[272px] shrink-0 flex flex-col gap-2`. Column header `h-8 flex items-center gap-1.5 px-1 text-callout font-semibold text-fg-secondary` (status icon 14 in status colour, "In progress", count `font-normal text-fg-tertiary tabular-nums`). Empty slot: `rounded-lg border border-dashed border-separator-strong px-3 py-6 text-center text-callout text-fg-tertiary` "No tasks." Board bar: `text-title` "Board", `btn btn-primary btn-sm` [Plus] "New task", and at the far right a checkbox "Show cancelled".

### 4.7 List rows

**Sidebar items:**

```
section label: px-2 pt-4 pb-1 text-caption font-semibold text-fg-tertiary   ("Channels", "Agents" + "1 director · 2/3 workers" font-normal)
item:          flex h-7 w-full items-center gap-2 rounded-md px-2 text-body text-fg-primary hover:bg-fill transition-colors duration-fast
               aria-[current=page]:bg-selected aria-[current=page]:shadow-xs aria-[current=page]:font-medium
icon:          16, text-fg-secondary (Inbox, Hash, Settings)
board summary: same item; leading status icon 14 in its colour; count ml-auto text-callout text-fg-tertiary tabular-nums
```

**Agent row** (PHASE2 §B1; `AgentsList.tsx`):

```
<li> flex flex-col
  row button: flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill focus-inset
     icon:    presence icon 16 mt-px, in its colour (idle fg-tertiary; working status-progress + pulse; reviewing status-review;
              blocked/failed status-blocked; paused status-warn; queued fg-secondary; disabled fg-tertiary)
     text:    min-w-0 flex-1
       line 1: flex items-baseline gap-1.5  name text-body font-medium text-fg-primary · label text-callout text-fg-secondary truncate
               (Waiting on you / Failed: label text-danger)
       line 2+: text-caption text-fg-tertiary truncate   (last tool, queue reason, "$1.20/$2.00 est. today", "until 00:00")
  actions:    pl-8 pb-1 flex gap-1   btn btn-link text-callout  "Edit budget" / "Enable"
retired:      item with ChevronRight disclosure; retired rows text-fg-tertiary, line 2 "retired 09:40"
empty hint:   px-2 pt-2 text-caption text-fg-tertiary + btn btn-secondary btn-sm mt-2 [Plus] "Add worker"
loading:      2 skeleton rows (§4.11)
```

**Inbox (Needs you) cards:** view canvas `bg-window px-5 py-4`. List `mx-auto max-w-[720px] flex flex-col gap-3`.

```
card:     rounded-xl bg-elevated shadow-sm p-4 focus-visible:(global ring); j/k focused: ring-2 ring-accent
  head:   flex items-center gap-2 text-callout
          type  font-semibold text-fg-primary flex items-center gap-1.5  [Flag 14 text-accent] Approval · New task
          meta  ml-auto text-caption text-fg-tertiary   from director · 2 min ago
  title:  mt-1.5 text-body-lg font-semibold text-fg-primary   T-7 "Write docs/INSTALL.md" → assign: worker
  body:   mt-1 text-body text-fg-secondary                     Why: …
  facts:  mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-callout
          dt text-fg-tertiary / dd text-fg-primary tabular-nums  (Est. cap, Skill, From, Allowance, Shares, Workers…)
  check:  mt-3 flex items-center gap-2 text-body  (checkbox, spawn card)
  actions:mt-4 flex flex-wrap items-center gap-2   primary Approve <kbd>a</kbd> · secondary Reject <kbd>r</kbd> · ghost Open thread <kbd>↵</kbd>
  disabled reason: text-callout text-fg-secondary  ("Worker limit reached (3/3). Retire a worker first.")
```

Type icon by item: approval `Flag`, help `MessageCircleQuestion`, ready `CircleCheck text-status-done`, review limit `CirclePause text-danger`, kill `OctagonX text-danger`, failure `CircleX text-danger`, capped `TriangleAlert text-status-warn`. The grouped kill item's per-task rows (Review individually) use `divide-y divide-separator`, with rows `py-2 flex items-center gap-2`. **Recently expired:** heading `mt-6 mb-2 text-callout font-semibold text-fg-tertiary`; rows are the same card at `bg-content shadow-none ring-1 ring-separator`, with text `fg-secondary` (not opacity, to keep AA).

**Task detail jobs table:** `w-full text-callout`, rows `h-8 border-b border-separator`, cells `pr-3`, attempt/cost `tabular-nums text-fg-secondary`, status `icon 14 + text`, "Open log" `btn-link`.

### 4.8 Toasts

Region `fixed z-50 bottom-4 right-4 flex flex-col items-end gap-2 w-[min(360px,calc(100vw-32px))]`; mobile `left-1/2 -translate-x-1/2 bottom-[calc(16px+env(safe-area-inset-bottom))]`.
Toast `material rounded-xl shadow-md px-3.5 py-2.5 flex items-center gap-2.5 text-body text-fg-primary` + leading icon 16 (success `CircleCheck text-status-done`, info `Info text-accent`, error `CircleX text-danger`) + optional `btn-link` action + close `btn btn-ghost btn-sm btn-icon` [X 14]. Enter animation per §2.6. Show at most 3; older ones wait. Keep the existing live-region semantics.

### 4.9 Banners

```
banner: flex items-start gap-3 px-4 py-2.5 border-b border-separator text-body text-fg-primary
  icon 16 mt-px  ·  message flex-1 (secondary clause text-fg-secondary)  ·  actions flex gap-2 shrink-0 (btn-sm secondary/primary/btn-link)
kill / orchestrator down / failure (role="alert"):  bg-tint-danger shadow-[inset_3px_0_0_rgb(var(--danger-fill))]  icon OctagonX / CircleX text-danger
budget / limit / paused / API key / session (amber):  bg-tint-warn  icon CircleSlash / TriangleAlert text-status-warn
info (SSE reconnecting, kill-stopped tasks after resume):  bg-tint-info  icon RefreshCw / Info text-accent
```

Banners stack under the header in the order kill → orchestrator → budget/limit → others. The **Resume** action in the kill banner is `btn btn-primary btn-sm`. Its disabled reason ("Restart the orchestrator first…") is `text-callout text-fg-secondary` beside it. Dismiss is `btn btn-ghost btn-sm btn-icon` [X].

### 4.10 Dialogs and sheets

```
scrim:  fixed inset-0 z-40 bg-black/25 dark:bg-black/50
panel:  fixed z-50 left-1/2 top-[18vh] -translate-x-1/2 w-[min(440px,calc(100vw-32px))] rounded-xl bg-elevated shadow-lg p-5
        role="dialog" aria-modal="true" aria-labelledby
title:  text-headline  ·  body mt-2 text-body text-fg-secondary  ·  payload block mt-3 rounded-md bg-sunken p-3 font-mono text-mono
change list (Settings save): mt-3 divide-y divide-separator text-body; old value text-fg-tertiary line-through, "→", new value font-medium
footer: mt-5 flex justify-end gap-2   Cancel (secondary) · confirm (primary, or destructive for Stop all / Retire / Disable)
```

UX default focus stays (Stop all is focused by default). **Mobile (< 800 px):** the panel becomes a sheet, `inset-x-0 bottom-0 top-auto translate-x-0 w-full rounded-t-2xl rounded-b-none p-5 pb-[calc(20px+env(safe-area-inset-bottom))]`. It has a 36×4 grab bar (`mx-auto mb-3 h-1 w-9 rounded-full bg-separator-strong`, decorative), and its footer buttons are `flex-1 btn-lg`.

**Quick switcher:** panel `top-[14vh] w-[min(560px,…)] p-0 overflow-hidden material`. Input `h-11 px-4 text-body-lg bg-transparent border-b border-separator focus:outline-none`. Rows `h-9 px-4 flex items-center gap-2.5 text-body`; the active option is `bg-accent-fill text-fg-on-accent`, with its secondary text `text-fg-on-accent/90`.

### 4.11 Empty, loading, error

- **Empty:** `mx-auto max-w-[320px] py-16 flex flex-col items-center text-center gap-2`. Icon disc `h-12 w-12 rounded-full bg-fill-strong grid place-items-center text-fg-tertiary` (icon 24), title `text-headline`, body `text-body text-fg-secondary`, optional action `mt-2 btn btn-secondary`. Copy is UX §8, split at the sentence: "Say what you need." / "Mention @director to start." (`MessageSquare`); "Nothing needs you." (`Inbox`, no body).
- **Skeleton:** bars `h-3 rounded-sm bg-fill-strong animate-pulse` at widths 40/70/55 %; a message skeleton is a 28 px circle + 2 bars. After 300 ms add the UX text ("Loading messages…") as `text-callout text-fg-tertiary`. `aria-busy="true"` on the region.
- **Full error:** an empty-state layout with `CircleX text-danger` disc, title "Couldn't load Slackboard.", the code in `font-mono text-callout text-fg-tertiary`, and a primary Retry.

### 4.12 Thread messages and composer

```
message:   group flex gap-3 px-5 py-1.5 hover:bg-fill/60 focus-inset   (max text width: max-w-[72ch])
avatar:    h-7 w-7 rounded-full grid place-items-center text-callout font-semibold mt-0.5
           agents bg-fill-strong text-fg-secondary (first letter); you bg-accent-fill text-fg-on-accent
author:    flex items-baseline gap-2   name text-body font-semibold · role chip · time text-caption text-fg-tertiary tabular-nums (title = absolute time)
body:      text-body-lg text-fg-primary whitespace-pre-wrap break-words; links text-accent; inline code font-mono text-[12px] bg-fill-strong rounded-sm px-1
grouped:   same author within 5 min: no avatar/author line (pl-10 on body), sr-only author+time kept
attachments/actions: mt-1.5 flex gap-2  btn btn-secondary btn-sm "View diff"
system:    flex items-center gap-2 px-5 py-1 text-callout text-fg-tertiary  icon 14 (same mapping as §3)
system group: btn btn-ghost btn-sm text-fg-tertiary [ChevronRight] "5 system events"
working:   px-5 py-1 text-callout text-fg-secondary flex items-center gap-2  [LoaderCircle 14 animate-spin text-accent] director is working…
footer:    px-5 py-1.5 text-caption text-fg-tertiary tabular-nums border-t border-separator  ("Agent messages 5/30 · Agent runs 5/12 · Peer help 1/2", Near limit pill)
```

**Composer:**

```
wrap:     mx-4 mb-4 mt-2 rounded-xl bg-elevated shadow-sm ring-1 ring-separator-strong focus-within:ring-2 focus-within:ring-accent transition-shadow
textarea: block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-body-lg text-fg-primary placeholder:text-fg-tertiary focus:outline-none min-h-[44px] max-h-[200px]
bar:      flex items-center gap-2 px-2.5 pb-2
  hint:   flex-1 min-w-0 text-caption text-fg-secondary truncate (id → aria-describedby)  "Will wake worker and unblock T-7"
  hint 2: block text-caption text-status-warn [CircleSlash 14]  "Saved; agents are paused (kill switch), will run after resume"
  send:   btn btn-primary btn-sm  [ArrowUp 14] "Send"   (disabled when empty)
error:    px-3.5 pb-2 text-callout text-danger role="alert"  "Not sent." + btn-link "Retry"
closed:   replaces wrap: mx-4 mb-4 rounded-xl bg-fill px-4 py-3 text-body text-fg-secondary "Thread closed." + btn-link "Reopen"
```

### 4.13 Kbd hints

```css
.kbd { @apply inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-[5px] font-sans text-caption font-medium
       text-fg-secondary bg-fill-strong shadow-[inset_0_-1px_0_rgb(var(--sep)/.12)]; }
.btn-primary .kbd, .btn-destructive .kbd { @apply bg-transparent text-fg-on-accent ring-1 ring-white/40 shadow-none; }
```

Use real glyphs: ⌘ ⇧ ↵ Esc. On non-Mac (`navigator.platform`) show "Ctrl" instead of ⌘. Kbd elements inside buttons are `aria-hidden`. The shortcut is exposed with `aria-keyshortcuts`. Kbd hints are hidden below 800 px and on `pointer: coarse`.

### 4.14 Diff view (`components/diff/*`)

```
toolbar (sticky top-0 z-10): material-bar border-b border-separator px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2
  verdict line:  w-full flex items-center gap-2 text-body   pill (Approved: done / Changes requested: blocked / Awaiting: review / Set aside: warn [RotateCcw])
                 "by director 10:10" text-fg-secondary · ml-auto text-caption text-fg-tertiary "Captured by server 10:09"
  Show:          segmented radiogroup (Round 1 | Round 2 | r1 → r2)
  View:          segmented radiogroup (Unified | Side by side) + reason caption when disabled
  expand:        ml-auto btn btn-ghost btn-sm [Maximize2 14] "Expand" <kbd>x</kbd>
  comments closed: w-full text-caption text-fg-tertiary [MessageSquare 14] "Comments closed for this round"
files:      px-4 py-2 flex gap-1 overflow-x-auto border-b border-separator
  chip:     btn btn-ghost btn-sm font-mono  name · <span text-diff-add-fg>+12</span> <span text-diff-del-fg>−3</span> · [MessageSquare 14] 2
file h3:    sticky top-[var(--toolbar-h)] z-[5] h-9 px-4 flex items-center gap-2 bg-sunken border-y border-separator font-mono text-callout font-medium text-fg-primary  [FileText 14]
hunk h4:    px-4 h-7 flex items-center bg-fill text-caption font-mono text-fg-secondary   "Hunk 1 of 3 · lines 10–24" · ml-auto kbd n / p
table:      w-full border-collapse font-mono text-mono   (role/aria per PHASE2 §B5)
  row:      group focus-inset (roving tabindex)   context: bg-content · added: bg-diff-add · removed: bg-diff-del
  gutter:   w-11 pr-2 text-right align-top select-none tabular-nums text-caption leading-5 text-fg-tertiary   (old, new)
  prefix:   w-5 text-center select-none font-semibold   "+" text-diff-add-fg / "−" text-diff-del-fg / " " (kept in DOM)
  code:     pr-4 whitespace-pre-wrap break-words text-fg-primary   (expanded view: whitespace-pre; per-file overflow-x-auto)
  sr text:  sr-only prefix "added line 12:" etc.
  syntax:   keyword text-syn-kw · string text-syn-str · number text-syn-num · comment text-syn-com italic · function/type text-syn-fn
side by side: two half tables in one grid grid-cols-2; divider border-l border-separator-strong;
  column heads "old"/"new": sticky h-7 px-4 text-caption font-semibold text-fg-tertiary bg-sunken
  empty cell: bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(var(--sep)/.05)_6px_7px)]
+ Comment:  unified/pane: absolute left-1 btn btn-primary btn-sm btn-icon rounded-full h-5 w-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100
            aria-label="Comment on new line 12" · expanded side by side: btn btn-ghost btn-sm text-accent [Plus 14] "Comment" <kbd>c</kbd>
            disabled while worker runs: aria-disabled + caption "Worker is running; comment after it submits"
comment row: <tr><td colSpan=all class="py-2 pr-4 pl-[calc(2*2.75rem+1.25rem)] bg-content">
  bubble:   max-w-[560px] rounded-lg bg-elevated shadow-sm p-3 font-sans  role="note"
            head flex items-center gap-2: role chip (director / you) · time text-caption text-fg-tertiary
            body mt-1 text-body text-fg-primary whitespace-pre-wrap
            delivery mt-2 text-caption flex items-center gap-1.5:
              pending  [Clock 14] text-fg-secondary "Will be sent with the worker's next run"
              sent     [CircleCheck 14 text-status-done] text-fg-tertiary "Sent to worker run #41"
              closed   [CircleMinus 14] text-fg-tertiary "Not sent: round closed"
  thread:   consecutive bubbles gap-2, joined by border-l-2 border-separator-strong ml-3 pl-3
  editor:   textarea .textarea (label sr-only per §B5) · mt-2 flex justify-end gap-2  ghost Cancel <kbd>Esc</kbd> · primary sm Save <kbd>⌘↵</kbd>
compare checklist: mx-4 my-3 rounded-lg bg-sunken p-3; heading text-callout font-semibold; rows flex gap-2 text-callout; path font-mono
truncated:  row px-4 py-2 text-callout text-fg-secondary + btn-link "Show full file"
expanded:   fixed to the area right of the sidebar (top-12 bottom-0 left-60 right-0, below 800: inset-x-0) bg-content shadow-lg z-30
```

### 4.15 Settings forms (`Views.tsx` Settings, `AgentsSettings.tsx`)

```
page:     bg-window min-h-full  ·  inner mx-auto max-w-[680px] px-6 py-8 flex flex-col gap-8
title:    text-title
section:  heading text-headline px-1 mb-2 (+ count "1 director · 2/3 workers" text-callout text-fg-tertiary font-normal)
group:    rounded-xl bg-elevated shadow-xs divide-y divide-separator
row:      flex items-center gap-4 min-h-11 px-4 py-2.5
  label:  flex-1 min-w-0  text-body text-fg-primary  (+ hint text-caption text-fg-tertiary)
  usage:  w-36 text-right text-callout text-fg-tertiary tabular-nums   "used today $0.06 est."
  control:.input .input-num  (range note "(1–4)" in usage column)
save bar: mt-3 flex justify-end gap-2   btn-primary "Save" (disabled when invalid/unchanged)
agent row (AgentsSettings):
  line 1: flex items-center gap-3   name text-body font-semibold · model pill · budget text-callout text-fg-secondary tabular-nums ("$0.42/$2.00 est. · 3/10 runs" / "no own budget (global only)")
          ml-auto: checkbox "Enabled" · btn-secondary btn-sm "Edit budget"/"Set budget" · ghost-destructive btn-sm "Retire"
  line 2: mt-1 text-caption text-fg-tertiary truncate  "Skill: … · added 10:03 via approval #12"
  budget editor (inline, expands under row): grid grid-cols-2 gap-3 pt-3  ($/day, runs/day inputs) + field-error + Save/Cancel
  retire errors: field-error list; task links btn-link
add worker: last row of group: btn btn-ghost text-accent [Plus 16] "Add worker"; expands into form rows (Name, Skill note textarea, $/day, runs/day) + "No approval: you are acting" caption; disabled at 3/3 with caption
retired:  disclosure row text-fg-secondary
doctor:   row: status icon + "all required checks passed" (text-status-done or text-danger) · caption "Last run 10:28 · claude 0.0.0" · btn-secondary btn-sm "Re-run" · btn-ghost btn-sm "Show report"; report: font-mono text-mono bg-sunken rounded-md p-3 inside group
appearance (optional): row with segmented System | Light | Dark
```

Below 640 px a settings row becomes `flex-col items-stretch gap-1.5`: the label, then the control row (`input` + usage). Deep links (Edit budget / Enable) scroll with `scroll-mt-16`, and the target row flashes `bg-accent/[.08]` for 600 ms.

## 5. Layout

| Region | Width | Padding | Density |
|---|---|---|---|
| Header | full, `h-12` (mobile `h-11` + a 36 px pill row) | `px-4` | — |
| Sidebar | `w-60` (240) | `px-2 py-3`, items `px-2` (text at 16 px from the edge) | 28 px rows, sections `pt-4` |
| Centre | flex, `min-w-[480px]` at ≥ 1200 | bar `px-5 h-12`; content `px-5 py-4` | messages `py-1.5`; cards `gap-3`; inbox max 720, settings max 680, message text max 72ch |
| Right pane | `w-[420px]` | header `px-4 h-12`; body `px-4 py-4`, sections `gap-5`; footer `px-4 py-3` | detail sections: caption heading `text-caption font-semibold text-fg-tertiary mb-1` |
| Expanded review | centre + right | toolbar `px-4` | side by side when the diff area ≥ 900 px (PHASE2 §B4) |

**Breakpoints** (UX §2, PHASE2 §B4):

- **≥ 1200 (`xl`)**: three panes side by side. Closing the right pane gives the centre the space.
- **800–1199 (`md`–`xl`)**: sidebar + centre. The right pane overlays: `fixed right-0 top-12 bottom-0 z-30 w-[420px] max-w-[calc(100vw-240px)] material shadow-lg border-l border-separator`, sliding in over 240 ms with no scrim (the centre stays readable, per UX). Expanded review covers everything right of the sidebar.
- **< 800**: one pane at a time. The header is two rows (row 2: `flex gap-1.5 overflow-x-auto px-4 pb-2` of status pills). Below it, a sticky `material-bar` holds the full-width segmented tab bar (Inbox / Chat / Board / Detail, as today). Panes use `px-4`. Board columns become `w-[85vw] snap-start` in a `snap-x snap-mandatory` scroller. Dialogs become sheets, toasts go bottom-centre, kbd hints are hidden, controls are 36 px (`pointer: coarse`). The kill button keeps its text label.
- Scroll containers: each pane scrolls on its own (`overflow-y-auto overscroll-contain`). Body never scrolls on desktop.

## 6. Accessibility constraints

- **Contrast:** every text/background pair below is ≥ 4.5:1 (WCAG 2.1 AA, normal text). Icons, input borders and the focus ring are ≥ 3:1 (1.4.11). The ratios were computed with the WCAG relative-luminance formula; alpha tints were computed as their composite over the stated background.
- **Status is never colour-only:** every status shows a distinct lucide shape plus a text label (§3), and diff lines keep the `+`/`−` glyphs and sr-only prefixes. Disabled states show a text reason, not just opacity.
- **Focus:** global 2 px accent outline, 2 px offset (inset on diff lines and list rows). Text fields use a 2 px accent ring. Pane open/close focus rules from UX §11 are unchanged, and pane titles take `tabIndex={-1}`.
- **Motion and transparency:** `prefers-reduced-motion` disables all animation (global rule kept; status flashes become label-only). `prefers-reduced-transparency` and missing `backdrop-filter` give solid materials.
- Landmarks, live regions, accessible names and keyboard maps are unchanged (UX §10–11, PHASE2 §B1, §B5). A visual refactor must not drop an `aria-*` attribute.
- **Disallowed pairs:** `fg-tertiary` on `fill-strong` in dark (4.24:1, so it's for skeletons/decoration only); status-coloured text on `bg-window` in light for `accent`/`blocked` pills (use pills only on content/elevated); any text at `opacity` < 1, except disabled controls (exempt).

| Pair | Light | Dark |
|---|---|---|
| fg-primary / content | 16.83 | 15.61 |
| fg-primary / elevated | 16.83 | 13.13 |
| fg-primary / window | 15.46 | 17.32 |
| fg-primary / sidebar | 14.14 | 15.95 |
| fg-secondary / content | 8.13 | 8.24 |
| fg-secondary / elevated | 8.13 | 6.93 |
| fg-secondary / sidebar | 6.83 | 8.42 |
| fg-tertiary / content | 5.97 | 6.08 |
| fg-tertiary / elevated | 5.97 | 5.11 |
| fg-tertiary / sidebar | 5.02 | 6.21 |
| fg-tertiary / window | 5.49 | 6.75 |
| fg-tertiary / selected row | 5.97 (white) | 4.97 |
| fg-tertiary / fill (hover) | 5.34 | 5.33 |
| accent text / content | 5.80 | 7.11 |
| accent text / elevated | 5.80 | 5.98 |
| accent text / sidebar | 4.87 | 7.26 |
| white / accent-fill (primary) | 5.80 | 5.09 |
| white / danger-fill (destructive, Kill) | 5.88 | 5.88 |
| status-done / its 12 % pill on content | 5.19 | 6.82 |
| status-progress / pill | 4.85 | 6.01 |
| status-review / pill | 5.00 | 7.57 |
| status-blocked / pill | 4.82 | 5.88 |
| status-proposed / pill | 5.64 | 6.19 |
| status-progress / pill on elevated (dark cards) | 4.85 | 5.02 |
| status-blocked / pill on elevated (dark cards) | 4.82 | 4.92 |
| status-warn / tint-warn | 5.63 | 7.21 |
| fg-primary / tint-danger (kill banner) | 14.17 | 13.84 |
| fg-secondary / tint-danger | 6.85 | 7.30 |
| danger text / tint-danger | 4.92 | 6.38 |
| fg-primary / tint-info | 14.93 | 11.78 |
| fg-primary / diff-add · diff-del | 14.94 · 14.60 | 14.14 · 15.09 |
| fg-tertiary (gutter) / diff-add · diff-del | 5.30 · 5.18 | 5.51 · 5.88 |
| diff-add-fg / diff-add | 5.49 | 9.02 |
| diff-del-fg / diff-del | 5.90 | 7.20 |
| syntax tokens / diff-add (min: syn-com) | 4.80 | 5.34 |
| syntax tokens / diff-del (min: syn-com) | 4.69 | 5.70 |
| Non-text: input border (control) / content | 3.62 | 3.77 |
| Non-text: focus ring (accent) / window | 5.33 | 7.89 |
| Non-text: status icons / sidebar (min) | 4.87 | 6.61 |
