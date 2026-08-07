import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  },
  verbose: true,
  strict: true,
  // Supabase manages these schemas; migrations must never touch them.
  schemaFilter: ['public'],
});
