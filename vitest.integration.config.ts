import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

/**
 * Integration suite (plan §84, §66.4).
 *
 * Runs against a real Postgres, because the properties under test — tenant isolation,
 * unique constraints, cascade behaviour, the target lease — live in SQL and simply do not
 * exist in a fake repository. An ownership test without a database is not an ownership
 * test (plan P5, Rule 5).
 *
 * Skips itself when DATABASE_URL is absent, so a fresh clone still passes `pnpm test`.
 */
config({ path: '.env', quiet: true });

export default defineConfig({
  test: {
    globals: false,
    include: ['{apps,packages}/**/src/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**'],
    // One shared database. Parallel files would let one suite's cleanup cascade away
    // another's fixtures mid-assertion.
    fileParallelism: false,
    // Each request opens its own connection, and the database is a region away.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
