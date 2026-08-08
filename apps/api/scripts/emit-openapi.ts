#!/usr/bin/env node
/**
 * Emit the OpenAPI document as a committed artifact (plan §85 Rule 5).
 *
 *   pnpm openapi:emit    # write
 *   pnpm openapi:check   # verify, no write
 *
 * `--check` is what CI runs: it fails when the committed spec no longer matches the
 * schemas, which is the only thing stopping the published contract from silently drifting
 * away from what the Worker actually serves.
 *
 * Run through tsx rather than node's type stripping: this reaches into workspace packages
 * whose TS sources import each other with `.js` specifiers, and node resolves those
 * literally instead of remapping them to `.ts`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiDocument } from '../src/openapi.ts';

const DEFAULT_SERVER_URL = 'https://api.gainingsocial.com';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(here, '..', '..', '..', 'packages', 'contracts', 'openapi', 'openapi.json');

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const document = buildOpenApiDocument(process.env.API_PUBLIC_URL ?? DEFAULT_SERVER_URL);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;

  if (check) {
    const committed = await readFile(outputPath, 'utf8').catch(() => null);
    if (committed === null) {
      throw new Error(`No committed spec at ${outputPath}. Run \`pnpm openapi:emit\`.`);
    }
    if (committed !== serialized) {
      throw new Error(
        'The committed OpenAPI spec is stale. Run `pnpm openapi:emit` and commit the result.',
      );
    }
    console.log('OpenAPI spec is up to date.');
    return;
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
