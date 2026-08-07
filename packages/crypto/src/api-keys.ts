import { bytesToBase64Url, randomBytes, timingSafeEqualHex } from './encoding.js';
import { hmacSha256Hex } from './hmac.js';

/**
 * API key generation and verification (plan §38).
 *
 * Keys are HASHED, not encrypted (ADR-007): we never need to recover a key, only to
 * verify one. The raw key is returned exactly once at creation and is unrecoverable
 * afterwards.
 *
 * The hash is keyed (HMAC with a pepper held in Secrets Store) rather than a bare
 * SHA-256, so an attacker holding only a database dump cannot verify guesses offline.
 */

export type ApiKeyEnvironment = 'test' | 'live';

/** 32 bytes ≈ 256 bits of entropy. Brute force is not a threat model at this size. */
const SECRET_BYTES = 32;

/**
 * Characters of the random part kept in the stored, searchable prefix.
 * Long enough to identify a key in the dashboard and to narrow a lookup, short enough
 * that the prefix alone is useless to an attacker.
 */
const PREFIX_RANDOM_CHARS = 8;

export interface GeneratedApiKey {
  /** Full key. Shown to the user once, then discarded. Never logged, never stored. */
  raw: string;
  /** Stored for display and lookup narrowing, e.g. `sk_live_a1B2c3D4`. */
  prefix: string;
  /** Stored. Hex HMAC-SHA256 of the raw key under the pepper. */
  hash: string;
  environment: ApiKeyEnvironment;
}

export function apiKeyPrefixFor(environment: ApiKeyEnvironment): string {
  return environment === 'live' ? 'sk_live_' : 'sk_test_';
}

/** Parse the environment out of a raw key without touching the secret material. */
export function parseApiKeyEnvironment(raw: string): ApiKeyEnvironment | null {
  if (raw.startsWith('sk_live_')) return 'live';
  if (raw.startsWith('sk_test_')) return 'test';
  return null;
}

/** Cheap structural check before any database work. Rejects obvious garbage early. */
export function isWellFormedApiKey(raw: string): boolean {
  const environment = parseApiKeyEnvironment(raw);
  if (!environment) return false;

  const secret = raw.slice(apiKeyPrefixFor(environment).length);
  return secret.length >= 32 && /^[A-Za-z0-9_-]+$/.test(secret);
}

/** The searchable prefix for a raw key: `sk_live_` plus the first characters of the secret. */
export function apiKeyLookupPrefix(raw: string): string | null {
  const environment = parseApiKeyEnvironment(raw);
  if (!environment) return null;

  const marker = apiKeyPrefixFor(environment);
  return marker + raw.slice(marker.length, marker.length + PREFIX_RANDOM_CHARS);
}

export async function generateApiKey(
  environment: ApiKeyEnvironment,
  pepper: string | Uint8Array,
): Promise<GeneratedApiKey> {
  const secret = bytesToBase64Url(randomBytes(SECRET_BYTES));
  const raw = `${apiKeyPrefixFor(environment)}${secret}`;

  return {
    raw,
    prefix: apiKeyLookupPrefix(raw)!,
    hash: await hashApiKey(raw, pepper),
    environment,
  };
}

export function hashApiKey(raw: string, pepper: string | Uint8Array): Promise<string> {
  return hmacSha256Hex(pepper, raw);
}

/**
 * Verify a presented key against a stored hash in constant time.
 *
 * Note the ordering discipline at call sites: look the key row up by hash (a single
 * indexed equality lookup), then compare. Never iterate candidate rows comparing hashes,
 * which reintroduces a timing side channel at the database layer.
 */
export async function verifyApiKey(
  raw: string,
  storedHash: string,
  pepper: string | Uint8Array,
): Promise<boolean> {
  const computed = await hashApiKey(raw, pepper);
  return timingSafeEqualHex(computed, storedHash);
}

/**
 * Redact a key for logs. Even truncated, keys should not normally be logged at all —
 * this exists for the audit trail, which records which key acted, not the key itself.
 */
export function redactApiKey(raw: string): string {
  const prefix = apiKeyLookupPrefix(raw);
  return prefix ? `${prefix}…` : 'sk_…';
}
