import type { Config } from 'tailwindcss';
const c = (v: string) => `rgb(var(--${v}) / <alpha-value>)`;
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: ['variant', ['@media (prefers-color-scheme: dark) { &:not(.light *) }', '&:is(.dark *)']],
  theme: {
    screens: { sm: '640px', md: '800px', lg: '1024px', xl: '1200px', '2xl': '1536px' },   // UX §2: one pane < 800 px, right pane overlays < 1200 px
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
