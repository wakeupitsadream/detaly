import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'web',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.ts'],
    exclude: ['e2e/**', '.next/**', 'node_modules/**'],
    environment: 'node',
  },
});
