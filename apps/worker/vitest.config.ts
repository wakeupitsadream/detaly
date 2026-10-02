import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Own database `${DATABASE_URL_TEST}_worker` (skipped when DATABASE_URL_TEST is unset).
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
