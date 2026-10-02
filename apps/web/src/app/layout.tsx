import type { Viewport } from 'next';
import type { ReactNode } from 'react';
// Self-hosted variable fonts (no next/font/google, no CDN: the build works offline and the CSP
// allows only font-src 'self'). Each file is split by unicode-range, so a browser downloads
// only the Cyrillic and Latin subsets it actually renders.
import '@fontsource-variable/unbounded/index.css';
import '@fontsource-variable/onest/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './globals.css';

// Brand-dependent metadata (title, robots) is set at request time in (site)/layout.tsx:
// this root layout must not read env, it is also used by build-time pages (404).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#111315',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
