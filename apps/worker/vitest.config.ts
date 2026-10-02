import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
