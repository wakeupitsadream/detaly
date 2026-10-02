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
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? ' ws:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
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
    '@detaly/notify',
    '@detaly/orders',
    '@detaly/payments',
    '@detaly/rossko',
    '@detaly/vin',
  ],
  // Node-only libraries loaded at runtime instead of being bundled (must be direct deps of web).
  serverExternalPackages: ['soap', 'pino', 'ioredis'],
  poweredByHeader: false,
  // Lets src/proxy.ts see `rsc` and `next-router-prefetch` (stripped from the proxy request by
  // default), so genuine router prefetches are not counted against the search limit. The proxy never rewrites or
  // redirects, which is what this flag would otherwise affect.
  skipProxyUrlNormalize: true,
  experimental: {
    // Next buffers a request body for the proxy (10 MB by default) before any route handler
    // runs. The forms here are tiny (cart 8 KB, checkout 16 KB, cancel 256 B, each also read as
    // a bounded stream in its handler): past this size Next keeps only the first 64 KB, which
    // the handlers then reject as malformed.
    proxyClientMaxBodySize: '64kb',
  },
  // `next build` must not need a database or env: pages are dynamic (see (site)/layout.tsx).
  // NOINDEX_ALL is a runtime switch (one image for prod and stage), so it is applied in
  // src/proxy.ts, not here: headers() below is evaluated at build time.
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Referrer-Policy is split by path instead of being global: the order page /o/<token>
      // carries its access token in the URL and must never leak it through Referer. When two
      // rules set the same key the later one wins, and the proxy sets no-referrer on /o/* and
      // /api/orders/* as well (its headers are applied after these), so neither can be
      // overridden by a global value.
      {
        source: '/((?!o/).*)',
        headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }],
      },
      { source: '/o/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      {
        source: '/api/orders/:path*',
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
