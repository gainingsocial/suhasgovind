import type { ErrorCode } from './codes.js';

/**
 * Normalized provider error taxonomy (plan §79).
 *
 * Every provider adapter's `normalizeError` maps an arbitrary upstream failure onto exactly
 * one of these codes plus an optional provider-specific subcode. The publishing engine
 * branches on this taxonomy and never on a provider's own error strings — that is what
 * keeps retry policy provider-agnostic (plan P1).
 */
export const PROVIDER_ERROR_CODES = [
  'AUTH_EXPIRED',
  'AUTH_REVOKED',
  'AUTH_SCOPE_MISSING',
  'ACCOUNT_NOT_ELIGIBLE',
  'DESTINATION_NOT_FOUND',
  'VALIDATION_FAILED',
  'TEXT_TOO_LONG',
  'MEDIA_UNSUPPORTED',
  'MEDIA_TOO_LARGE',
  'MEDIA_PROCESSING_FAILED',
  'PRIVACY_SELECTION_REQUIRED',
  'CONTENT_REJECTED',
  'RATE_LIMITED',
  'DAILY_QUOTA_EXCEEDED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_CONFLICT',
  'POSSIBLE_DUPLICATE',
  'UNKNOWN_PROVIDER_ERROR',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** How the publisher should treat a target after this failure (plan §24.3). */
export type PublishDisposition =
  | 'retryable_failed'
  | 'permanent_failed'
  /**
   * The request may or may not have produced a post. Never retried blindly —
   * reconciliation runs first (ADR-006 Layer 4).
   */
  | 'unknown_reconciliation_required'
  /** Connection is unusable until a human re-authorizes. Retrying cannot help. */
  | 'blocked_on_connection';

export type RetryStrategy =
  /** Do not retry. A retry cannot change the outcome. */
  | 'none'
  /** Exponential backoff with jitter, bounded by max attempts. */
  | 'exponential_backoff'
  /** Honour the provider's `Retry-After` / reset metadata before trying again. */
  | 'respect_provider_retry_after'
  /** Wait for the daily/period quota window to roll over. */
  | 'after_quota_reset'
  /** Run reconciliation; retry only if it proves nothing was published. */
  | 'reconcile_first';

export type ErrorSeverity =
  /** Content or request problem. The customer can fix it. */
  | 'user_actionable'
  /** Connection problem. An end user must re-authorize. */
  | 'reauthorization_required'
  /** Transient provider condition. Time fixes it. */
  | 'transient'
  /** We do not understand this failure. Investigate. */
  | 'investigate';

export interface ProviderErrorMetadata {
  retryable: boolean;
  disposition: PublishDisposition;
  retryStrategy: RetryStrategy;
  severity: ErrorSeverity;
  /** What a human should do, in plain terms. */
  userAction: string;
  /** What an agent should do, machine-readable (plan §16). */
  agentAction: string;
  /** The public error code surfaced to API callers for this class of failure. */
  publicCode: ErrorCode;
  /** Whether this failure means the connection's health should be re-evaluated (plan §42). */
  affectsConnectionHealth: boolean;
}

const t = (meta: ProviderErrorMetadata): ProviderErrorMetadata => meta;

export const PROVIDER_ERROR_METADATA: Record<ProviderErrorCode, ProviderErrorMetadata> = {
  AUTH_EXPIRED: t({
    retryable: true,
    // Refresh is attempted first; only if refresh fails does this reach the customer.
    disposition: 'blocked_on_connection',
    retryStrategy: 'exponential_backoff',
    severity: 'reauthorization_required',
    userAction: 'Reconnect the social account.',
    agentAction: 'create_connect_session_for_reauthorization',
    publicCode: 'CONNECTION_REAUTH_REQUIRED',
    affectsConnectionHealth: true,
  }),
  AUTH_REVOKED: t({
    retryable: false,
    disposition: 'blocked_on_connection',
    retryStrategy: 'none',
    severity: 'reauthorization_required',
    userAction: 'The user revoked access at the provider. Reconnect the account.',
    agentAction: 'create_connect_session_for_reauthorization',
    publicCode: 'CONNECTION_REVOKED',
    affectsConnectionHealth: true,
  }),
  AUTH_SCOPE_MISSING: t({
    retryable: false,
    disposition: 'blocked_on_connection',
    retryStrategy: 'none',
    severity: 'reauthorization_required',
    userAction: 'Reconnect the account and grant the missing permission.',
    agentAction: 'reauthorize_with_required_scopes',
    publicCode: 'CONNECTION_PERMISSION_MISSING',
    affectsConnectionHealth: true,
  }),
  ACCOUNT_NOT_ELIGIBLE: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction:
      'The connected account type cannot perform this action — for example a personal account where the provider requires a business or creator account.',
    agentAction: 'check_destination_capabilities',
    publicCode: 'PROVIDER_ACCOUNT_NOT_ELIGIBLE',
    affectsConnectionHealth: true,
  }),
  DESTINATION_NOT_FOUND: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction: 'The page, organization, board or channel no longer exists or is no longer accessible.',
    agentAction: 'refresh_destinations_for_connection',
    publicCode: 'DESTINATION_NOT_FOUND',
    affectsConnectionHealth: true,
  }),
  VALIDATION_FAILED: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction: 'The provider rejected the request shape. Correct the content and publish again.',
    agentAction: 'run_preflight_and_fix_reported_issues',
    publicCode: 'PROVIDER_REJECTED_CONTENT',
    affectsConnectionHealth: false,
  }),
  TEXT_TOO_LONG: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction: 'Shorten the text for this destination.',
    agentAction: 'shorten_text',
    publicCode: 'TEXT_TOO_LONG',
    affectsConnectionHealth: false,
  }),
  MEDIA_UNSUPPORTED: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction: 'Supply media in a format this destination accepts.',
    agentAction: 'create_or_select_a_compliant_media_variant',
    publicCode: 'MEDIA_TYPE_UNSUPPORTED',
    affectsConnectionHealth: false,
  }),
  MEDIA_TOO_LARGE: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction: 'Reduce the media file size for this destination.',
    agentAction: 'create_media_variant',
    publicCode: 'MEDIA_TOO_LARGE',
    affectsConnectionHealth: false,
  }),
  MEDIA_PROCESSING_FAILED: t({
    // The provider accepted the upload then failed to process it. Worth one more attempt:
    // provider-side transcoding is genuinely flaky, but the content itself may be at fault.
    retryable: true,
    disposition: 'retryable_failed',
    retryStrategy: 'exponential_backoff',
    severity: 'transient',
    userAction: 'The provider failed to process the media. It will be retried.',
    agentAction: 'wait_for_retry',
    publicCode: 'MEDIA_PROCESSING_FAILED',
    affectsConnectionHealth: false,
  }),
  PRIVACY_SELECTION_REQUIRED: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction: 'Choose a privacy level this destination allows.',
    agentAction: 'choose_allowed_privacy_level',
    publicCode: 'PRIVACY_SELECTION_REQUIRED',
    affectsConnectionHealth: false,
  }),
  CONTENT_REJECTED: t({
    retryable: false,
    disposition: 'permanent_failed',
    retryStrategy: 'none',
    severity: 'user_actionable',
    userAction: 'The provider rejected this content on policy grounds. Revise it.',
    agentAction: 'revise_content',
    publicCode: 'PROVIDER_REJECTED_CONTENT',
    affectsConnectionHealth: false,
  }),
  RATE_LIMITED: t({
    retryable: true,
    disposition: 'retryable_failed',
    retryStrategy: 'respect_provider_retry_after',
    severity: 'transient',
    userAction: 'The provider is rate limiting this account. Publishing will resume automatically.',
    agentAction: 'wait_for_retry',
    publicCode: 'CONNECTION_RATE_LIMITED',
    affectsConnectionHealth: true,
  }),
  DAILY_QUOTA_EXCEEDED: t({
    retryable: true,
    disposition: 'retryable_failed',
    retryStrategy: 'after_quota_reset',
    severity: 'transient',
    userAction: 'This account has used its posting quota for the period.',
    agentAction: 'retry_after_quota_reset',
    publicCode: 'QUOTA_EXCEEDED',
    affectsConnectionHealth: true,
  }),
  PROVIDER_UNAVAILABLE: t({
    retryable: true,
    disposition: 'retryable_failed',
    retryStrategy: 'exponential_backoff',
    severity: 'transient',
    userAction: 'The provider is temporarily unavailable. Publishing will be retried.',
    agentAction: 'wait_for_retry',
    publicCode: 'PROVIDER_UNAVAILABLE',
    affectsConnectionHealth: false,
  }),
  PROVIDER_TIMEOUT: t({
    // Critical: a timeout cannot distinguish "never arrived" from "published, response lost".
    // Ayrshare documents exactly this hazard (plan §2.2). Reconcile before retrying.
    retryable: true,
    disposition: 'unknown_reconciliation_required',
    retryStrategy: 'reconcile_first',
    severity: 'transient',
    userAction: 'The provider did not respond in time. We are checking whether the post was created.',
    agentAction: 'wait_for_reconciliation',
    publicCode: 'RECONCILIATION_REQUIRED',
    affectsConnectionHealth: false,
  }),
  PROVIDER_CONFLICT: t({
    retryable: false,
    disposition: 'unknown_reconciliation_required',
    retryStrategy: 'reconcile_first',
    severity: 'investigate',
    userAction: 'The provider reported a conflicting state. We are verifying before doing anything else.',
    agentAction: 'wait_for_reconciliation',
    publicCode: 'PROVIDER_CONFLICT',
    affectsConnectionHealth: false,
  }),
  POSSIBLE_DUPLICATE: t({
    retryable: false,
    disposition: 'unknown_reconciliation_required',
    retryStrategy: 'reconcile_first',
    severity: 'investigate',
    userAction: 'The provider indicates equivalent content may already exist. We will not retry blindly.',
    agentAction: 'inspect_destination_before_retrying',
    publicCode: 'POSSIBLE_DUPLICATE',
    affectsConnectionHealth: false,
  }),
  UNKNOWN_PROVIDER_ERROR: t({
    // Rule 14: when uncertain, fail safely. An unclassified error is NOT auto-retried,
    // because a retry could duplicate a post we cannot prove did not publish.
    retryable: false,
    disposition: 'unknown_reconciliation_required',
    retryStrategy: 'reconcile_first',
    severity: 'investigate',
    userAction: 'An unrecognized provider error occurred. It has been recorded for investigation.',
    agentAction: 'inspect_post_timeline',
    publicCode: 'UNKNOWN_PROVIDER_ERROR',
    affectsConnectionHealth: false,
  }),
};

/** A provider failure after normalization. This is what crosses the adapter boundary. */
export interface NormalizedProviderError {
  code: ProviderErrorCode;
  /** Provider's own stable subcode, when it publishes one (e.g. Meta's `error_subcode`). */
  subcode?: string;
  /** Sanitized, human-readable summary. Must not contain credentials or full payloads. */
  message: string;
  /** Upstream HTTP status, when applicable. */
  status?: number;
  /** Explicit retry time supplied by the provider (UTC ISO-8601), parsed from Retry-After/reset. */
  retryAfter?: string;
  /** Overrides the taxonomy default when the adapter knows better for this occurrence. */
  retryable?: boolean;
  /** Overrides the taxonomy default disposition. */
  disposition?: PublishDisposition;
}

export function providerErrorMetadata(code: ProviderErrorCode): ProviderErrorMetadata {
  return PROVIDER_ERROR_METADATA[code];
}

/** Resolve the effective disposition, honouring an adapter-supplied override. */
export function dispositionFor(error: NormalizedProviderError): PublishDisposition {
  return error.disposition ?? PROVIDER_ERROR_METADATA[error.code].disposition;
}

/** Resolve effective retryability, honouring an adapter-supplied override. */
export function isRetryable(error: NormalizedProviderError): boolean {
  return error.retryable ?? PROVIDER_ERROR_METADATA[error.code].retryable;
}

for (const code of PROVIDER_ERROR_CODES) {
  if (!PROVIDER_ERROR_METADATA[code]) {
    throw new Error(`Missing PROVIDER_ERROR_METADATA entry for "${code}"`);
  }
}
