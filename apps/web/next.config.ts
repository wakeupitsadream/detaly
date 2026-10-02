import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Monorepo root: standalone output traces workspace packages from here.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
    '@detaly/payments',
    '@detaly/rossko',
    '@detaly/vin',
  ],
  // Node-only libraries loaded at runtime instead of being bundled (must be direct deps of web).
  serverExternalPackages: ['soap', 'pino', 'ioredis'],
  poweredByHeader: false,
};

export default nextConfig;
