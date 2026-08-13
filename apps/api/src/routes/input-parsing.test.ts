import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Request input must go through the parse helpers, never through a bare `.parse()`.
 *
 * A lint rule expressed as a test, because this defect keeps coming back and is invisible
 * in review: `Schema.parse(await c.req.json())` reads perfectly well, typechecks, and
 * works for every valid request. Only a *malformed* one reveals it, and then a Zod error
 * escapes as an unhandled exception and the caller gets:
 *
 *   500 INTERNAL_ERROR   "An unexpected error occurred."   retryable: true
 *
 * for a mistake in their own payload. They are told to retry a request that can only ever
 * fail, and the field at fault is never named. It shipped in three routes at once —
 * `/v1/memory/*`, `/v1/content-sources` and `/v1/draft-sets` — which is what makes it
 * worth a mechanical guard rather than another round of review.
 *
 * `parseBody` and `parseQuery` raise `INVALID_REQUEST`, a 400 carrying the field issues.
 *
 * Response schemas are deliberately not covered: `ResponseSchema.parse(...)` on the way
 * out asserts an internal invariant, and a 500 is the correct answer when we are about to
 * emit something that does not match our own contract.
 */

const routesDir = fileURLToPath(new URL('./', import.meta.url));

const routeFiles = readdirSync(routesDir)
  .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
  .sort();

/** `Schema.parse(await c.req.json())` and `Schema.parse(c.req.query())`. */
const BARE_INPUT_PARSE = /\w+\.parse\(\s*(await\s+)?c\.req\.(json|query|param)\(/g;

describe('route input parsing', () => {
  it('finds route files to check', () => {
    // Guards the guard: a rename that empties this list would make every assertion below
    // pass vacuously.
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it.each(routeFiles)('%s parses request input through the helpers', (file) => {
    const source = readFileSync(`${routesDir}${file}`, 'utf8');
    const offenders = source.match(BARE_INPUT_PARSE) ?? [];

    expect(
      offenders,
      `${file} parses request input with a bare .parse(), which answers 400-class ` +
        'mistakes with a 500. Use parseBody / parseQuery from ../lib/request.js.',
    ).toEqual([]);
  });
});
