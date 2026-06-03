import { defineConfig } from 'drizzle-kit';

// Для прод-сверки схемы: `npm run db:pull` против клона боевой БД,
// затем diff сгенерированного со committed lib/db/schema.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://karman:karman@localhost:5432/karman_db',
  },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
