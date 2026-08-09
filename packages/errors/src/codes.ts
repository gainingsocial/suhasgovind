/**
 * Stable public error codes (plan §16 "code is stable and documented").
 *
 * Adding a code is a minor, backward-compatible change.
 * Changing or removing a code is a BREAKING change requiring an API version bump (plan §69),
 * because customers and agents branch on these strings.
 *
 * Every code must have an entry in `ERROR_CODE_METADATA` below, and a page under
 * `docs/errors/{CODE}.md`.
 */
export const ERROR_CODES = [
  // ---- authentication / authorization ---------------------------------------
  'AUTHENTICATION_REQUIRED',
  'API_KEY_INVALID',
  'API_KEY_REVOKED',
  'API_KEY_EXPIRED',
  'API_KEY_MALFORMED',
  'INSUFFICIENT_SCOPE',
  'ENVIRONMENT_MISMATCH',
  'TENANT_FORBIDDEN',

  // ---- request shape --------------------------------------------------------
  'INVALID_REQUEST',
  'MISSING_REQUIRED_FIELD',
  'UNSUPPORTED_CONTENT_TYPE',
  'REQUEST_TOO_LARGE',
  'UNSUPPORTED_API_VERSION',

  // ---- resources ------------------------------------------------------------
  'PROFILE_NOT_FOUND',
  'CONNECTION_NOT_FOUND',
  'DESTINATION_NOT_FOUND',
  'MEDIA_NOT_FOUND',
  'POST_NOT_FOUND',
  'TARGET_NOT_FOUND',
  'WEBHOOK_NOT_FOUND',
  'DELIVERY_NOT_FOUND',
  'RESOURCE_NOT_FOUND',

  // ---- idempotency & conflict ----------------------------------------------
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  'DUPLICATE_CONTENT_BLOCKED',
  'POST_NOT_CANCELLABLE',
  'POST_NOT_RETRYABLE',
  'TARGET_NOT_RETRYABLE',
  'CONFLICTING_STATE',
  /**
   * A uniqueness constraint the caller controls was violated — most often an
   * `external_id` already claimed within the environment. Distinct from
   * `CONFLICTING_STATE`, which is about a resource being in the wrong state for an
   * operation rather than a value already being taken.
   */
  'RESOURCE_ALREADY_EXISTS',

  // ---- connection health (plan §12.3, §42) ---------------------------------
  'CONNECTION_REAUTH_REQUIRED',
  'CONNECTION_DISCONNECTED',
  'CONNECTION_REVOKED',
  'CONNECTION_PERMISSION_MISSING',
  'CONNECTION_INCOMPLETE_SETUP',
  'CONNECTION_RATE_LIMITED',

  // ---- capability / preflight (plan §17, §18) ------------------------------
  'CAPABILITY_NOT_SUPPORTED',
  'POST_TYPE_NOT_SUPPORTED',
  'TEXT_TOO_LONG',
  'TEXT_REQUIRED',
  'MEDIA_REQUIRED',
  'MEDIA_COUNT_EXCEEDED',
  'MEDIA_TYPE_UNSUPPORTED',
  'MEDIA_RATIO_UNSUPPORTED',
  'MEDIA_TOO_LARGE',
  'MEDIA_DURATION_UNSUPPORTED',
  'MEDIA_RESOLUTION_UNSUPPORTED',
  'MEDIA_NOT_READY',
  'MEDIA_MIXED_TYPES_UNSUPPORTED',
  'LINK_NOT_SUPPORTED',
  'PROVIDER_OPTION_INVALID',
  'PROVIDER_OPTION_REQUIRED',
  'PRIVACY_SELECTION_REQUIRED',
  'COMPLIANCE_DECLARATION_REQUIRED',
  'SCHEDULE_IN_PAST',
  'SCHEDULE_TOO_FAR_AHEAD',
  'SCHEDULE_NOT_SUPPORTED',
  'TARGETS_REQUIRED',
  'DUPLICATE_DESTINATION',

  // ---- rate limiting (plan §28) --------------------------------------------
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'PLAN_LIMIT_REACHED',

  // ---- provider-side (plan §79) --------------------------------------------
  /**
   * No adapter is registered for the named provider. Distinct from a caller naming a
   * provider that does not exist: both surface here, because telling an unauthenticated
   * caller which providers are merely unbuilt leaks the roadmap.
   */
  'PROVIDER_NOT_SUPPORTED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_REJECTED_CONTENT',
  'PROVIDER_CONFLICT',
  'PROVIDER_ACCOUNT_NOT_ELIGIBLE',
  'POSSIBLE_DUPLICATE',
  'RECONCILIATION_REQUIRED',
  'UNKNOWN_PROVIDER_ERROR',

  // ---- media pipeline -------------------------------------------------------
  'MEDIA_UPLOAD_INCOMPLETE',
  'MEDIA_PROBE_FAILED',
  'MEDIA_PROCESSING_FAILED',
  'MEDIA_URL_NOT_ALLOWED',

  // ---- internal -------------------------------------------------------------
  'INTERNAL_ERROR',
  'NOT_IMPLEMENTED',
  'FEATURE_DISABLED',
  'SIMULATION_ONLY',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export function isKnownErrorCode(code: string): code is ErrorCode {
  return CODE_SET.has(code);
}
