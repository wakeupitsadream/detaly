import { defineConfig } from 'vitest/config';

// Each workspace has its own vitest.config.ts (defineProject) with a unique `test.name`.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
  },
});
