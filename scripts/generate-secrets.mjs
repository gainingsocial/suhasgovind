#!/usr/bin/env node
/**
 * Generates fresh random material for local development.
 *
 * Production secrets are NOT generated here — they are created once and stored in
 * Cloudflare Secrets Store / Worker Secrets (plan §6.6). Losing CREDENTIAL_KEK_V1 in
 * production means every social connection must be re-authorized (ADR-007).
 *
 *   node scripts/generate-secrets.mjs
 */
import { randomBytes } from 'node:crypto';

const b64 = (n = 32) => randomBytes(n).toString('base64');

const values = {
  CREDENTIAL_KEK_V1: b64(32),
  API_KEY_HASH_PEPPER: b64(32),
  WEBHOOK_SIGNING_ROOT: b64(32),
  CONNECT_SESSION_SIGNING_KEY: b64(32),
};

process.stdout.write('# Development secrets — paste into .env and apps/api/.dev.vars\n');
process.stdout.write('# Do NOT reuse these in production.\n\n');
for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}="${value}"\n`);
}
process.stdout.write('CREDENTIAL_KEK_ACTIVE_VERSION="1"\n');
