import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` needs no database; migrations are applied by src/migrate.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost/detaly' },
});
