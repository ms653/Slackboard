import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { screens: { sm: '640px', md: '800px', lg: '1024px', xl: '1200px', '2xl': '1536px' },   // UX §2: one pane < 800 px, right pane overlays < 1200 px
    extend: { fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'] } } },
  plugins: [],
} satisfies Config;
