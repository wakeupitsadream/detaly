import type { Viewport } from 'next';
import type { ReactNode } from 'react';
// Self-hosted variable fonts (no next/font/google, no CDN: the build works offline and the CSP
// allows only font-src 'self'). Each file is split by unicode-range, so a browser downloads
// only the Cyrillic and Latin subsets it actually renders. Manrope is the storefront's only
// face; JetBrains Mono stays for the admin (VINs, event types) and is fetched only there.
import '@fontsource-variable/manrope/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './globals.css';

/** The brand red (--color-brand in globals.css): the phone's browser bar matches the header. */
const BRAND_THEME_COLOR = '#b3291e';

// Brand-dependent metadata (title, robots) is set at request time in (site)/layout.tsx:
// this root layout must not read env, it is also used by build-time pages (404).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: BRAND_THEME_COLOR,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
