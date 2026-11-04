import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Slackboard', description: 'Local agent workspace' };

// Optional theme override (DESIGN §2.1): sb.theme = 'light' | 'dark' adds a class before paint; System adds none.
const THEME = `try{var t=localStorage.getItem('sb.theme');if(t==='light'||t==='dark')document.documentElement.classList.add(t)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME }} /></head>
      <body className="bg-window text-fg-primary font-sans text-body antialiased">{children}</body>
    </html>
  );
}
