import { defineConfig } from 'vitest/config';

/**
 * Unit suite. Fast, hermetic, no network, no database.
 *
 * Integration tests live in `*.integration.test.ts` and run under
 * `vitest.integration.config.ts` (plan §84 lists them as a separate command). They are
 * excluded here rather than skipped so the inner development loop stays in single-digit
 * seconds — a suite that takes two minutes stops being run.
 */
export default defineConfig({
  test: {
    globals: false,
    include: [
      'packages/**/src/**/*.{test,spec}.ts',
      'apps/**/src/**/*.{test,spec}.ts',
      // The browser extension is plain JavaScript — it ships to Chrome unbundled, so
      // there is no build step to compile TypeScript away. Its extraction logic still
      // needs covering, hence the `js` here.
      'integrations/**/src/**/*.{test,spec}.js',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/*.integration.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.ts',
        '**/*.test.ts',
        '**/migrations/**',
        '**/test-support/**',
      ],
    },
  },
});
