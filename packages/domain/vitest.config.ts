import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'domain',
    // transitions.spec.ts is the state machine specification (docs/phase0-implementation.md §4).
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.spec.ts'],
    environment: 'node',
  },
});
