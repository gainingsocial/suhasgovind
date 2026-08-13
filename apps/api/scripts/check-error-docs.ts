#!/usr/bin/env node
/**
 * Verify the error dictionary covers every code the API can return.
 *
 *   pnpm docs:check
 *
 * This is a drift guard of the same kind as `openapi:check`, and it exists for the same
 * reason: the published contract must not disagree with what the Worker serves. Here the
 * promise is concrete — every error envelope advertises
 * `docs_url: https://gainingsocial.com/docs/errors/{CODE}`, so an undocumented code is a
 * link the API hands out and the docs break. Nobody notices until a customer follows it.
 *
 * It lives here rather than as a unit test in `@gs/errors` because that package is typed
 * against the Workers runtime and has no business importing `node:fs`.
 *
 * Run through tsx for the same reason `emit-openapi.ts` is: this reaches into workspace
 * packages whose TS sources import each other with `.js` specifiers.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODE_METADATA, ERROR_CODES, PROVIDER_ERROR_CODES, PROVIDER_ERROR_METADATA } from '@gs/errors';

const here = path.dirname(fileURLToPath(import.meta.url));
const dictionaryPath = path.join(here, '..', '..', '..', 'docs', 'errors', 'README.md');

/** A code is documented when it appears as inline code, e.g. `` `TEXT_TOO_LONG` ``. */
function documents(text: string, code: string): boolean {
  return text.includes(`\`${code}\``);
}

async function main(): Promise<void> {
  const text = await readFile(dictionaryPath, 'utf8');
  const problems: string[] = [];

  // ---- every public code is documented --------------------------------------
  const undocumented = ERROR_CODES.filter((code) => !documents(text, code));
  if (undocumented.length > 0) {
    problems.push(
      `${undocumented.length} error code(s) are returned by the API but absent from docs/errors/README.md,\n` +
        `so their docs_url 404s:\n  ${undocumented.join('\n  ')}`,
    );
  }

  // ---- every provider failure's public code is documented --------------------
  // The provider taxonomy is internal — a caller never sees `AUTH_SCOPE_MISSING` — but
  // each entry declares the public code it becomes, and that is what lands in the
  // envelope.
  const providerPublic = [
    ...new Set(PROVIDER_ERROR_CODES.map((code) => PROVIDER_ERROR_METADATA[code].publicCode)),
  ].filter((code) => !documents(text, code));
  if (providerPublic.length > 0) {
    problems.push(
      `a provider failure translates to these public codes, which the dictionary does not cover:\n  ${providerPublic.join('\n  ')}`,
    );
  }

  // ---- documented statuses match the catalog ---------------------------------
  // A dictionary that says 404 where the API returns 409 is worse than none: it is
  // confidently wrong, and a caller writes their branching against it.
  const rows = [...text.matchAll(/^\| `([A-Z0-9_]+)` \| (\d{3}) \|/gm)];
  if (rows.length < 50) {
    problems.push(
      `only ${rows.length} documented codes were parsed from the tables — has the table format changed?`,
    );
  }

  const wrongStatus: string[] = [];
  const phantom: string[] = [];
  const known = new Set<string>(ERROR_CODES);

  for (const [, code, status] of rows) {
    if (code === undefined || status === undefined) continue;
    if (!known.has(code)) {
      // The reverse drift: a code removed from the catalog but left in the docs sends
      // people looking for a branch they can never hit.
      phantom.push(code);
      continue;
    }
    const actual = ERROR_CODE_METADATA[code as keyof typeof ERROR_CODE_METADATA].status;
    if (String(actual) !== status) {
      wrongStatus.push(`${code}: documented ${status}, catalog says ${actual}`);
    }
  }

  if (wrongStatus.length > 0) {
    problems.push(`documented status codes disagree with the catalog:\n  ${wrongStatus.join('\n  ')}`);
  }
  if (phantom.length > 0) {
    problems.push(
      `documented but not in the catalog, so the API can never return them:\n  ${[...new Set(phantom)].join('\n  ')}`,
    );
  }

  if (problems.length > 0) {
    console.error(`\ndocs/errors/README.md is out of date:\n\n${problems.join('\n\n')}\n`);
    process.exit(1);
  }

  console.log(`docs/errors/README.md documents all ${ERROR_CODES.length} error codes.`);
}

await main();
