import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, ERROR_CODE_METADATA } from '@gs/errors';

/**
 * Emit the error catalog into the web app as plain data.
 *
 * The marketing site generates one documentation page per error code, which is where the
 * `docs_url` in every error response now points. Those pages have to come from the same
 * catalog the API answers with, or the reference will eventually describe a status or a
 * retryability that is no longer true.
 *
 * Importing `@gs/errors` directly from a page would be the obvious way to guarantee that,
 * and it does not work: the workspace packages are published as TypeScript source whose
 * internal imports carry the `./thing.js` specifier that `moduleResolution: bundler`
 * resolves, and Next does not apply that mapping to a package it treats as a dependency.
 * `transpilePackages` does not help — the failure is in resolution, before transpilation.
 *
 * So the catalog is emitted instead, exactly like the OpenAPI document: `--check` fails
 * when the committed file has drifted from the source, which is what stops the two from
 * silently disagreeing.
 */

const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'lib',
  'error-catalog.generated.ts',
);

function emit(): string {
  const entries = ERROR_CODES.map((code) => {
    const metadata = ERROR_CODE_METADATA[code];
    const fields = [
      `code: ${JSON.stringify(code)}`,
      `type: ${JSON.stringify(metadata.type)}`,
      `status: ${metadata.status}`,
      `retryable: ${metadata.retryable}`,
      `message: ${JSON.stringify(metadata.message)}`,
      ...(metadata.agentAction ? [`agentAction: ${JSON.stringify(metadata.agentAction)}`] : []),
    ];
    return `  { ${fields.join(', ')} },`;
  });

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Emitted from \`@gs/errors\` by \`pnpm --filter @gs/web errors:emit\`. \`errors:check\` runs in
 * CI and fails if this file has drifted from the catalog, so the published error reference
 * cannot describe an error the API does not return.
 */

export interface GeneratedErrorCode {
  code: string;
  type: string;
  status: number;
  retryable: boolean;
  message: string;
  agentAction?: string;
}

export const ERROR_CATALOG: readonly GeneratedErrorCode[] = [
${entries.join('\n')}
];
`;
}

const generated = emit();
const check = process.argv.includes('--check');

if (check) {
  let current: string;
  try {
    current = readFileSync(OUTPUT, 'utf8');
  } catch {
    console.error(
      `${OUTPUT} does not exist. Run \`pnpm --filter @gs/web errors:emit\` and commit the result.`,
    );
    process.exit(1);
  }

  if (current !== generated) {
    console.error(
      'The generated error catalog is out of date with @gs/errors.\n' +
        'Run `pnpm --filter @gs/web errors:emit` and commit the result.',
    );
    process.exit(1);
  }

  console.log(`Error catalog is up to date (${ERROR_CODES.length} codes).`);
} else {
  writeFileSync(OUTPUT, generated, 'utf8');
  console.log(`Wrote ${OUTPUT} (${ERROR_CODES.length} codes).`);
}
