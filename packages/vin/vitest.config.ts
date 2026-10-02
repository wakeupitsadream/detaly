import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'vin',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
