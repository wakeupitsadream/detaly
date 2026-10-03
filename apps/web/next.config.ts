import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Monorepo root: standalone output traces workspace packages from here.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const isDev = process.env.NODE_ENV === 'development';

/**
 * Static security headers. Next inlines bootstrap scripts, so script-src needs 'unsafe-inline'
 * until nonces are introduced (no third-party scripts are loaded at all). The dev server also
 * needs 'unsafe-eval' for React refresh.
 */
/**
 * Where «Оплатить N ₽» on /o/<token> sends the browser: the form posts to
 * /api/orders/<token>/pay, which answers 303 to YooKassa's confirmation_url. Browsers apply
 * form-action to the redirects of a form submission too (Chromium blocks the 303 with
 * «Refused to send form data … violates form-action»), so the payment page's origin must be
 * listed here. VERIFY: Ю11 — confirmation_url of a redirect payment is on yoomoney.ru
 * (reference examples: https://yoomoney.ru/checkout/payments/v2/contract?orderId=…).
 */
export const PAYMENT_FORM_ACTION_ORIGINS = ['https://yoomoney.ru', 'https://*.yoomoney.ru'];

/**
 * «Статусы в Telegram» on /o/<token> posts to /api/orders/<token>/link, which answers 303 to the
 * client bot's deep link https://t.me/<bot>?start=<payload>; without t.me here the no-script form
 * path is refused by form-action (the button navigates by script otherwise).
 */
export const MESSENGER_FORM_ACTION_ORIGINS = ['https://t.me'];

export const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? ' ws:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  `form-action 'self' ${[...PAYMENT_FORM_ACTION_ORIGINS, ...MESSENGER_FORM_ACTION_ORIGINS].join(' ')}`,
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  // Workspace packages ship TypeScript sources (exports -> ./src/index.ts).
  transpilePackages: [
    '@detaly/config',
    '@detaly/db',
    '@detaly/domain',
    '@detaly/files',
    '@detaly/notify',
    '@detaly/orders',
    '@detaly/payments',
    '@detaly/rossko',
    '@detaly/vin',
  ],
  // Node-only libraries loaded at runtime instead of being bundled (must be direct deps of web).
  // sharp (photo re-encoding in @detaly/files, phase 1C) is a native module, imported lazily.
  serverExternalPackages: ['soap', 'pino', 'ioredis', 'sharp'],
  poweredByHeader: false,
  // Lets src/proxy.ts see `rsc` and `next-router-prefetch` (stripped from the proxy request by
  // default), so genuine router prefetches are not counted against the search limit. The proxy never rewrites or
  // redirects, which is what this flag would otherwise affect.
  skipProxyUrlNormalize: true,
  experimental: {
    // Next buffers a request body for the proxy (10 MB by default) before any route handler
    // runs; past this size it keeps only the first part, which the handlers then reject as
    // malformed. Phase 1C forms carry up to 3 photos (decision С19): 12 MB in total, read by
    // server/uploads.ts with its own per-file and total limits. Every other handler still reads
    // its body as a bounded stream with its own small limit (cart 8 KB, checkout 16 KB, cancel
    // 256 B), and Caddy refuses bodies over 12 MB on /api/* before they reach Next.
    proxyClientMaxBodySize: '12mb',
  },
  // `next build` must not need a database or env: pages are dynamic (see (site)/layout.tsx).
  // NOINDEX_ALL is a runtime switch (one image for prod and stage), so it is applied in
  // src/proxy.ts, not here: headers() below is evaluated at build time.
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Referrer-Policy is split by path instead of being global: the order page /o/<token>,
      // the VIN proposal /p/<token> and the VIN confirmation /vin/sent/<link token> carry a
      // token in the URL and must never leak it through Referer. When two rules set the same
      // key the later one wins, and the proxy sets no-referrer on these paths and their APIs as
      // well (its headers are applied after these), so none can be overridden by a global value.
      {
        source: '/((?!o/|p/|vin/sent).*)',
        headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }],
      },
      { source: '/o/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      { source: '/p/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      { source: '/vin/sent', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      {
        source: '/vin/sent/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/api/orders/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/api/proposals/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/api/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default nextConfig;
