import type { Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// Brand-dependent metadata (title, robots) is set at request time in (site)/layout.tsx:
// this root layout must not read env, it is also used by build-time pages (404).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#fafaf9',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
