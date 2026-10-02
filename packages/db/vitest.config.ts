import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Fresh schema, migrations and seed in DATABASE_URL_TEST (skipped when it is unset).
    globalSetup: ['test/global-setup.ts'],
    // Integration files share one database and assert on global state (seed snapshots,
    // the order number sequence), so they run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
