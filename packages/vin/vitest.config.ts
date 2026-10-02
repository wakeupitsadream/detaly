import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'vin',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Own database `${DATABASE_URL_TEST}_vin` (skipped when DATABASE_URL_TEST is unset).
    globalSetup: ['test/global-setup.ts'],
    // Integration files share one database.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
