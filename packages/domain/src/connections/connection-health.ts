import type { ProviderErrorCode } from '@gs/errors';
import { PROVIDER_ERROR_METADATA } from '@gs/errors';

/** Connection health lifecycle (plan §12.3, §42). */
export const CONNECTION_HEALTH_STATES = [
  'healthy',
  'refresh_due',
  'refreshing',
  'reauth_required',
  'permission_missing',
  'rate_limited',
  'provider_degraded',
  'disconnected',
  'revoked',
] as const;

export type ConnectionHealth = (typeof CONNECTION_HEALTH_STATES)[number];

/**
 * States from which publishing cannot proceed and retrying cannot help — a human must
 * re-authorize. Preflight surfaces these as `CONNECTION_*` errors rather than letting a
 * publish attempt burn a queue slot to discover the same thing.
 */
const BLOCKING: ReadonlySet<ConnectionHealth> = new Set([
  'reauth_required',
  'permission_missing',
  'disconnected',
  'revoked',
]);

export function isBlockingHealth(health: ConnectionHealth): boolean {
  return BLOCKING.has(health);
}

/**
 * Whether a publish may be attempted.
 *
 * `rate_limited` and `provider_degraded` are NOT blocking: the target is queued with a
 * delay rather than rejected, because the condition is temporary and the customer's
 * intent is still valid. `refresh_due` is not blocking either — the publisher refreshes
 * the token under a lock as its first step.
 */
export function canPublishWithHealth(health: ConnectionHealth): boolean {
  return !isBlockingHealth(health);
}

/**
 * The health a connection should move to after a normalized provider error.
 *
 * Returns `null` when the error says nothing about the connection — a text-too-long
 * failure is a content problem and must not mark a perfectly good connection unhealthy.
 */
export function healthAfterProviderError(code: ProviderErrorCode): ConnectionHealth | null {
  const meta = PROVIDER_ERROR_METADATA[code];
  if (!meta.affectsConnectionHealth) return null;

  switch (code) {
    case 'AUTH_EXPIRED':
      // Expiry alone is recoverable by refresh; only a failed refresh escalates
      // to `reauth_required`.
      return 'refresh_due';
    case 'AUTH_REVOKED':
      return 'revoked';
    case 'AUTH_SCOPE_MISSING':
      return 'permission_missing';
    case 'RATE_LIMITED':
    case 'DAILY_QUOTA_EXCEEDED':
      return 'rate_limited';
    case 'ACCOUNT_NOT_ELIGIBLE':
    case 'DESTINATION_NOT_FOUND':
      // The credential is fine; the target is not. Health is unchanged and the target
      // fails permanently instead.
      return null;
    default:
      return null;
  }
}
