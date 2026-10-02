import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'rossko',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
