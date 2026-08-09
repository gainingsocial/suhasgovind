#!/usr/bin/env node
/**
 * Push the values GitHub Actions needs, straight from `.env`.
 *
 *   node scripts/setup-github-actions.mjs
 *
 * Splits them correctly, which matters:
 *
 *   secrets    credentials. Encrypted, never printed in a log, never readable back.
 *   variables  public configuration. The Supabase URL and anon key are inlined into the
 *              browser bundle at build time, so treating them as secrets would be theatre
 *              — the anon key is RLS-constrained and designed to be public.
 *
 * Requires a GitHub token with repository **Secrets: Read and write** and **Variables:
 * Read and write**. A token without them fails with 403 on write while still returning
 * 200 on read, which is a confusing combination — this script says so explicitly.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const REPO = process.env.GITHUB_REPOSITORY ?? 'gainingsocial/suhasgovind';
const API = 'https://api.github.com';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);

const token = process.env.GITHUB_TOKEN ?? env.GITHUB_PAT;
if (!token) {
  console.error('No GitHub token. Set GITHUB_TOKEN, or put GITHUB_PAT in .env.');
  process.exit(1);
}

const SECRETS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'DATABASE_URL'];
const VARIABLES = {
  SUPABASE_URL: 'NEXT_PUBLIC_SUPABASE_URL',
  SUPABASE_ANON_KEY: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
};

const gh = async (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });

async function main() {
  const keyResponse = await gh(`/repos/${REPO}/actions/secrets/public-key`);
  if (!keyResponse.ok) {
    console.error(`Cannot read the repository public key (HTTP ${keyResponse.status}).`);
    console.error('The token needs repository access to Actions secrets.');
    process.exit(1);
  }
  const { key, key_id: keyId } = await keyResponse.json();

  // GitHub encrypts secrets with libsodium sealed boxes. `libsodium-wrappers` ships with
  // the tooling already; requiring it lazily keeps this script usable for variables even
  // if it is missing.
  const require = createRequire(import.meta.url);
  let sodium;
  try {
    sodium = require('libsodium-wrappers');
    await sodium.ready;
  } catch {
    console.error('libsodium-wrappers is not installed. Run: pnpm add -Dw libsodium-wrappers');
    process.exit(1);
  }

  let failures = 0;

  for (const name of SECRETS) {
    const value = env[name];
    if (!value) {
      console.log(`  SKIP    ${name} — not present in .env`);
      continue;
    }

    const encrypted = sodium.to_base64(
      sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL)),
      sodium.base64_variants.ORIGINAL,
    );

    const response = await gh(`/repos/${REPO}/actions/secrets/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId }),
    });

    if (response.ok) {
      console.log(`  secret  ${name}`);
    } else {
      failures += 1;
      console.log(`  FAILED  ${name} — HTTP ${response.status}`);
    }
  }

  for (const [name, source] of Object.entries(VARIABLES)) {
    const value = env[source];
    if (!value) {
      console.log(`  SKIP    ${name} — ${source} not present in .env`);
      continue;
    }

    // Create, and fall back to update when it already exists. GitHub uses different
    // verbs and paths for the two.
    let response = await gh(`/repos/${REPO}/actions/variables`, {
      method: 'POST',
      body: JSON.stringify({ name, value }),
    });

    if (response.status === 409) {
      response = await gh(`/repos/${REPO}/actions/variables/${name}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, value }),
      });
    }

    if (response.ok) {
      console.log(`  var     ${name}`);
    } else {
      failures += 1;
      console.log(`  FAILED  ${name} — HTTP ${response.status}`);
    }
  }

  if (failures > 0) {
    console.error(
      `\n${failures} value(s) could not be set. A 403 here means the token is missing\n` +
        'repository permissions "Secrets: Read and write" and "Variables: Read and write".\n' +
        'Reading works without them, which is why the failure only appears on write.',
    );
    process.exit(1);
  }

  console.log('\nDone. Push to main and the deploy workflow will run.');
}

await main();
