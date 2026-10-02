import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', '.next/**', 'node_modules/**'],
    environment: 'node',
    // Own database `${DATABASE_URL_TEST}_web`: prepareTestDb drops schemas, so sharing the
    // db package's database would break its tests under the root `pnpm test`.
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
