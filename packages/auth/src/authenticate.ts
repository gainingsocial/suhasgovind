import { hashApiKey, isWellFormedApiKey, parseApiKeyEnvironment, verifyApiKey } from '@gs/crypto';
import { ApiError } from '@gs/errors';

import type { AuthenticatedPrincipal } from './principal.js';
import type { ApiKeyRecord, ApiKeyRepository } from './ports.js';

/**
 * API key authentication (plan §38).
 *
 * The raw key never leaves this module: it is hashed, compared and discarded. It is never
 * logged, never attached to the principal and never placed on an error (P9).
 */

const BEARER = /^Bearer\s+(.+)$/i;

export interface AuthenticateOptions {
  repository: ApiKeyRepository;
  /** Keyed-hash pepper, so a database dump alone cannot verify keys offline (plan §38). */
  pepper: string | Uint8Array;
  /** Injectable clock, so expiry is testable without waiting. */
  now?: () => Date;
  /**
   * Fire-and-forget sink for the `last_used_at` write. In a Worker this is
   * `ctx.waitUntil`; in tests it runs inline. Omitted means the write is skipped.
   */
  defer?: (work: Promise<void>) => void;
}

/**
 * Pull the key out of an Authorization header.
 *
 * Only `Bearer` is accepted. Silently tolerating a bare key or `Basic` would mean the
 * same credential travels in several shapes, and every shape is another place to get the
 * handling subtly wrong.
 */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = BEARER.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function assertUsable(record: ApiKeyRecord, now: Date): void {
  // Order matters for the message the caller sees: a revoked key that has also expired is
  // reported as revoked, because that is the fact that requires a human decision.
  if (record.status === 'revoked' || record.revokedAt !== null) {
    throw new ApiError('API_KEY_REVOKED');
  }
  if (record.status === 'expired' || (record.expiresAt !== null && record.expiresAt <= now)) {
    throw new ApiError('API_KEY_EXPIRED');
  }
}

export async function authenticateApiKey(
  authorizationHeader: string | null | undefined,
  options: AuthenticateOptions,
): Promise<AuthenticatedPrincipal> {
  const now = options.now?.() ?? new Date();

  const raw = extractBearerToken(authorizationHeader);
  if (raw === null) {
    throw new ApiError('AUTHENTICATION_REQUIRED');
  }

  // Structural check before any database work, so garbage costs us nothing.
  if (!isWellFormedApiKey(raw)) {
    throw new ApiError('API_KEY_MALFORMED');
  }

  const keyHash = await hashApiKey(raw, options.pepper);
  const record = await options.repository.findByHash(keyHash);

  // A key that does not exist and a key whose hash does not verify are the same answer to
  // the caller. Distinguishing them would confirm which keys exist.
  if (record === null) {
    throw new ApiError('API_KEY_INVALID');
  }

  // The lookup already matched on hash; this re-verifies in constant time so the decision
  // never rests on the database's own comparison semantics.
  if (!(await verifyApiKey(raw, record.keyHash, options.pepper))) {
    throw new ApiError('API_KEY_INVALID');
  }

  assertUsable(record, now);

  // The prefix says `sk_live_` but the row says `test` (or vice versa) — the two disagree
  // about which side of the test/live split this key belongs to, so refuse rather than
  // pick one and risk touching live data with a test key.
  if (parseApiKeyEnvironment(raw) !== record.environment) {
    throw new ApiError('API_KEY_INVALID');
  }

  if (options.defer) {
    // Never awaited: `last_used_at` is telemetry, and a database write per authenticated
    // request would put the hot path behind the database (plan §90).
    options.defer(options.repository.touchLastUsed(record.id, now).catch(() => {}));
  }

  return {
    apiKeyId: record.id,
    organizationId: record.organizationId,
    projectId: record.projectId,
    projectEnvironmentId: record.projectEnvironmentId,
    environment: record.environment,
    scopes: record.scopes,
    restrictedToProfileId: record.restrictedToProfileId,
  };
}
