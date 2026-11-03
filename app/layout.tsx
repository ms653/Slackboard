import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Slackboard', description: 'Local agent workspace' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
